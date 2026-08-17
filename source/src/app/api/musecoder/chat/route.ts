import { denyFrozenExecutionMutation } from "@/lib/control-plane/executionFreeze";
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { hermesHome } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/musecoder/chat  { messages: [{role,content}], model? }
// Calls Meta's Muse Spark 1.2 via OpenRouter (meta/muse-spark-1.2). It's a reasoning
// model: reasoning tokens can stream BEFORE content, so the panel shows a thinking
// indicator and we fall back to reasoning text if content stays empty.

const DEFAULT_MODEL = "meta/muse-spark-1.2";
const ALLOWED = new Set(["meta/muse-spark-1.2", "meta/muse-spark-1.1"]);
const DS_URL = "https://openrouter.ai/api/v1/chat/completions";

function dsKey(): string | null {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  for (const file of [
    path.join(hermesHome(), ".env"),
    path.join(os.homedir(), ".fcc", ".env"),
  ]) {
    try {
      const m = fs.readFileSync(file, "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m);
      if (m && m[1].trim().length > 10) return m[1].trim();
    } catch { /* ignore */ }
  }
  return null;
}

// Steer Hy3 to ship a complete single-file build immediately (it can over-explain).
const STEER =
  "You are Muse Spark 1.2 (Meta) acting as a senior build engineer. When asked to build something visual, " +
  "output ONE complete, self-contained HTML document (inline CSS + JS) in a single ```html code block, " +
  "and nothing else. It must render immediately on load, be well-lit and colourful (never blank/black), " +
  "and if interactive, wire REAL keyboard/mouse controls. For 3D use three.js r128 UMD from " +
  "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js. End with </body></html>.";

export async function POST(req: Request) {
  const frozen = await denyFrozenExecutionMutation(req, "POST /api/musecoder/chat");
  if (frozen) return frozen;
  const key = dsKey();
  if (!key) return NextResponse.json({ error: "No OpenRouter key found. Add OPENROUTER_API_KEY to ~/.hermes/.env" }, { status: 503 });

  const body = await req.json().catch(() => ({}));
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) return NextResponse.json({ error: "messages required" }, { status: 400 });
  const withSteer = messages[0]?.role === "system" ? messages : [{ role: "system", content: STEER }, ...messages];
  const MODEL = ALLOWED.has(String(body.model)) ? String(body.model) : DEFAULT_MODEL;

  // V4 thinks hard before writing (reasoning tokens first), so a big build can be minutes of
  // silence otherwise. We STREAM and forward reasoning as {thinking} so the panel shows life,
  // then real {delta} content. Ends with {done, model}.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 600_000); // generous — big builds take minutes
  let upstream: Response;
  try {
    upstream = await fetch(DS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, messages: withSteer, max_tokens: 64000, stream: true }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(t);
    const msg = (e as Error).name === "AbortError" ? "Muse Spark timed out — try again." : String((e as Error).message).slice(0, 160);
    return NextResponse.json({ error: msg }, { status: 504 });
  }
  if (!upstream.ok || !upstream.body) {
    clearTimeout(t);
    let em = `HTTP ${upstream.status}`;
    try { const j = await upstream.json(); em = j?.error?.message || em; } catch { /* ignore */ }
    return NextResponse.json({ error: em }, { status: 502 });
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      let buf = "";
      let full = "";
      let reasoning = "";
      let model = MODEL;
      try {
        const reader = upstream.body!.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            const s = line.trim();
            if (!s.startsWith("data:")) continue;
            const data = s.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const j = JSON.parse(data);
              if (j.model) model = j.model;
              const d0 = j?.choices?.[0]?.delta;
              const think = d0?.reasoning_content;
              if (typeof think === "string" && think) { reasoning += think; send({ thinking: think }); }
              const delta = d0?.content;
              if (typeof delta === "string" && delta) { full += delta; send({ delta }); }
            } catch { /* skip keep-alive / partial */ }
          }
        }
        // reasoning models sometimes leave the build in reasoning_content
        if (!full.trim() && /<\/html>/i.test(reasoning)) { full = reasoning; send({ delta: reasoning }); }
        if (!full.trim()) send({ error: "Muse Spark came back empty — try again." });
        else send({ done: true, model });
      } catch (e) {
        send({ error: (e as Error).name === "AbortError" ? "Muse Spark timed out — try again." : String((e as Error).message).slice(0, 160) });
      } finally {
        clearTimeout(t);
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
