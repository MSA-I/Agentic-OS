import { denyFrozenExecutionMutation } from "@/lib/control-plane/executionFreeze";
import { NextResponse } from "next/server";
import { OMNIROUTE_BASE, OMNIROUTE_KEY } from "@/lib/omniroute";
import { ROUTER9_BASE, ROUTER9_KEY } from "@/lib/router9";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64_000;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 16_000;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,160}$/;
const TOTAL_BUDGET_MS = 90_000;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

class RequestValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readLimitedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new RequestValidationError("Content-Type must be application/json.", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RequestValidationError("Request body is too large.", 413);
  }

  const reader = request.body?.getReader();
  if (!reader) throw new RequestValidationError("Request body must be valid JSON.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RequestValidationError("Request body is too large.", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestValidationError("Request body must be valid JSON.");
  }
}

function validateBody(value: unknown): { backend: "omniroute" | "ninerouter"; model?: string; messages: ChatMessage[] } {
  if (!isRecord(value)) throw new RequestValidationError("Request body must be an object.");
  const allowed = new Set(["backend", "model", "messages"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new RequestValidationError("Unknown request field.");
  if (value.backend !== undefined && value.backend !== "omniroute" && value.backend !== "ninerouter") {
    throw new RequestValidationError("Unknown backend.");
  }
  if (value.model !== undefined && (typeof value.model !== "string" || !MODEL_RE.test(value.model.trim()))) {
    throw new RequestValidationError("Invalid model.");
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new RequestValidationError("messages required");
  }
  if (value.messages.length > MAX_MESSAGES) throw new RequestValidationError("Too many messages.", 413);
  let totalChars = 0;
  const messages = value.messages.map((item) => {
    if (!isRecord(item) || !["system", "user", "assistant"].includes(String(item.role))) {
      throw new RequestValidationError("Invalid message role.");
    }
    if (typeof item.content !== "string" || !item.content.trim() || item.content.length > MAX_MESSAGE_CHARS) {
      throw new RequestValidationError("Invalid message content.");
    }
    totalChars += item.content.length;
    return { role: item.role as ChatMessage["role"], content: item.content };
  });
  if (totalChars > MAX_BODY_BYTES) throw new RequestValidationError("Conversation is too large.", 413);
  return {
    backend: value.backend === "ninerouter" ? "ninerouter" : "omniroute",
    ...(typeof value.model === "string" ? { model: value.model.trim() } : {}),
    messages,
  };
}

// POST /api/omniroute/chat  { messages: [{role,content}], model? }
// Proxies to the local OmniRoute gateway (OpenAI-compatible) using FREE models,
// with fallback: free providers are rate-limited, so we try a chain and return
// the first that answers. No API key needed for the free providers.

// Two free-coder backends, one section. OmniRoute ships anonymous free models;
// 9Router (573 models) routes the subscriptions/free tiers you connect once in
// its dashboard (http://127.0.0.1:20129).
const BACKENDS: Record<string, { base: string; key: string }> = {
  omniroute: { base: `${OMNIROUTE_BASE}/v1`, key: OMNIROUTE_KEY },
  ninerouter: { base: `${ROUTER9_BASE}/v1`, key: ROUTER9_KEY },
};

// Ordered free-model fallback chain. big-pickle is the proven worker; the free
// providers here are all *reasoning* models, so we (a) steer them to answer
// immediately (see STEER below) and (b) give a big token budget — otherwise they
// loop on hidden reasoning and return empty. All verified live on this gateway.
const CHAINS: Record<string, string[]> = {
  omniroute: [
    "opencode-zen/big-pickle",
    "oc/big-pickle",
    "auto/coding:free",
    "auto/best-free",
    "auto/cheap",
  ],
  // Post-connect defaults: your own Claude Code / Codex OAuth via 9Router, then
  // its free-tier providers. Errors surface per-model with a connect hint.
  ninerouter: [
    "cc/claude-fable-5",
    "cx/gpt-5.6-sol",
    "gh/goldeneye-free-auto",
    "kgw/nvidia/nemotron-3-ultra-550b-a55b:free",
    "bzl/auto:free",
  ],
};

// Without this, the free reasoning models deliberate until they exhaust the
// whole max_tokens budget and never emit content (finish:"length", 0 chars).
// This steer cuts reasoning from ~4000 tokens to ~100 and yields finish:"stop".
const STEER = "You are a fast, senior coding assistant. Do NOT overthink or deliberate at length. Answer immediately and concisely. When asked for code, output it right away in a single fenced code block, complete and self-contained. Keep any reasoning to an absolute minimum.";

async function tryModel(base: string, key: string, model: string, messages: ChatMessage[], signal: AbortSignal) {
  const withSteer = messages[0]?.role === "system" ? messages : [{ role: "system", content: STEER }, ...messages];
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "x-api-key": key,
    },
    body: JSON.stringify({ model, messages: withSteer, stream: false, max_tokens: 8000 }),
    signal,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) return { ok: false as const, error: j?.error?.message || `HTTP ${r.status}` };
  const content = j?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) return { ok: false as const, error: "empty response" };
  return { ok: true as const, content, model: j.model || model, usage: j.usage };
}

export async function POST(req: Request) {
  const frozen = await denyFrozenExecutionMutation(req, "POST /api/omniroute/chat");
  if (frozen) return frozen;
  let body: ReturnType<typeof validateBody>;
  try {
    body = validateBody(await readLimitedJson(req));
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const { messages } = body;

  const backend = body.backend;
  const { base, key } = BACKENDS[backend];
  const FREE_CHAIN = CHAINS[backend];
  // A pinned model is an explicit contract: never switch providers/models behind
  // the caller's back. Only unpinned requests walk the backend fallback chain.
  const chain = body.model ? [body.model] : [...new Set(FREE_CHAIN)];

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const tried: { model: string; error: string }[] = [];
  for (const [index, model] of chain.entries()) {
    if (req.signal.aborted) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const remainingAttempts = chain.length - index;
    const attemptMs = body.model ? remainingMs : Math.max(1, Math.floor(remainingMs / remainingAttempts));
    const timeoutSignal = AbortSignal.timeout(attemptMs);
    const signal = AbortSignal.any([req.signal, timeoutSignal]);
    try {
      const res = await tryModel(base, key, model, messages, signal);
      if (res.ok) {
        return NextResponse.json({ ok: true, content: res.content, model: res.model, usage: res.usage, triedCount: tried.length });
      }
      tried.push({ model, error: res.error });
    } catch (e) {
      const error = timeoutSignal.aborted
        ? `timeout after ${attemptMs}ms`
        : String((e as Error).message).slice(0, 120);
      tried.push({ model, error });
    }
  }
  return NextResponse.json(
    { error: body.model
        ? `The requested model (${body.model}) did not return a usable response.`
        : backend === "ninerouter"
        ? "9Router answered but no provider is connected yet — open its dashboard (button above) and connect Claude Code, Codex or a free tier once."
        : "All free providers are busy right now — try again in a moment.", tried },
    { status: 503 },
  );
}
