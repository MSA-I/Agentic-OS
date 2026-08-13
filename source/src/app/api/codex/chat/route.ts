import { spawnStream, terminateChildProcessTree } from "@/lib/runner";
import { CODEX_SCRATCH_ROOT, codexApprovalArgs, codexResumeApprovalArgs, ensureProject } from "@/lib/codexWorkspace";
import { omnirouteCodexArgs, openrouterApiKey, openrouterCodexArgs, openrouterCodexEnv, OPENROUTER_HY3_MODEL, omnirouteCodexEnv, nativeCodexArgs, nativeCodexEnv, NATIVE_CODEX_MODEL, withSteer, probeOmniRoute } from "@/lib/omniroute";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Codex streaming chat — `codex exec --json <prompt>` emits one JSON object per
// line on stdout for every event (assistant deltas, tool calls, results, etc).
// We just forward the NDJSON to the browser, same shape as our other agents.
//
// Codex behaves like `claude -p`: single-shot per invocation. For multi-turn
// memory we pack prior history into the prompt (same trick used by FreeClaude).
interface ChatMsg { role: "user" | "assistant" | "system"; text: string; }

function buildPromptWithHistory(history: ChatMsg[], current: string): string {
  if (!history.length) return current;
  const recent = history.slice(-24);
  const lines: string[] = [
    "The following is the prior conversation between you and the user.",
    "Read it, then answer the user's latest message at the bottom.",
    "",
    "--- prior conversation ---",
  ];
  let bytes = 0;
  const MAX_BYTES = 8000;
  for (const m of recent) {
    const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
    const line = `${role}: ${m.text}`;
    if (bytes + line.length > MAX_BYTES) { lines.push("…[earlier turns trimmed]"); break; }
    lines.push(line);
    bytes += line.length;
  }
  lines.push("--- end prior conversation ---", "", `User: ${current}`, "Assistant:");
  return lines.join("\n");
}

export async function POST(req: Request) {
  const body = await req.json();
  const prompt = body.prompt;
  const model = typeof body.model === "string" && /^[A-Za-z0-9._:/-]+$/.test(body.model) ? body.model : null;
  const history: ChatMsg[] = Array.isArray(body.history) ? body.history : [];
  const sessionId = typeof body.sessionId === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(body.sessionId) ? body.sessionId : null;
  if (typeof prompt !== "string" || prompt.length === 0) {
    return new Response("missing prompt", { status: 400 });
  }
  if (prompt.length > 16_000) {
    return new Response("prompt too long", { status: 413 });
  }
  const fullPrompt = sessionId ? prompt : buildPromptWithHistory(history, prompt);

  // Pin Codex's cwd to a scratch project so anything it writes (HTML, scripts,
  // generated assets) lands somewhere the Workspace tab can find. Same pattern
  // as the Free Claude Code chat endpoint.
  let cwd: string | undefined;
  if (typeof body.project === "string" && /^[A-Za-z0-9_.-]+$/.test(body.project)) {
    cwd = (await ensureProject(body.project)) ?? undefined;
  } else if (typeof body.cwd === "string") {
    cwd = body.cwd;
  } else {
    cwd = (await ensureProject("codex-default")) ?? path.join(CODEX_SCRATCH_ROOT, "codex-default");
  }

  // Engine selection:
  //  • "hy3"   → direct OpenRouter, tencent/hy3:free (Tencent's 295B, free window)
  //  • "gpt56" → native OpenAI Codex on the user's ChatGPT OAuth login (gpt-5.6)
  //  • default → local OmniRoute gateway (90+ free providers)
  const engine = body.engine === "hy3" ? "hy3" : body.engine === "gpt56" ? "gpt56" : "omniroute";

  if (engine === "omniroute" && !(await probeOmniRoute())) {
    return new Response(
      JSON.stringify({ type: "error", message: "OmniRoute isn't running on :20128. Open the OmniRoute tab (or run `omniroute`), then try again." }) + "\n",
      { status: 503, headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } },
    );
  }
  if (engine === "hy3" && !openrouterApiKey()) {
    return new Response(
      JSON.stringify({ type: "error", message: "OPENROUTER_API_KEY is missing — connect OpenRouter in Setup Center, then retry." }) + "\n",
      { status: 503, headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } },
    );
  }

  // Codex runs non-interactively here, so its terminal approval prompt can't be
  // answered from the browser — pass an explicit approval policy or it blocks.
  const providerArgs = engine === "hy3"
    ? openrouterCodexArgs(model || OPENROUTER_HY3_MODEL)
    : engine === "gpt56"
    ? nativeCodexArgs(model || NATIVE_CODEX_MODEL)
    : omnirouteCodexArgs(model);
  const args = sessionId
    ? ["exec", "resume", "--json", "--skip-git-repo-check", ...codexResumeApprovalArgs(body.approvalMode), ...providerArgs, sessionId, withSteer(fullPrompt)]
    : ["exec", "--json", "--skip-git-repo-check", ...codexApprovalArgs(body.approvalMode), ...providerArgs, withSteer(fullPrompt)];

  const extraEnv = engine === "hy3" ? openrouterCodexEnv() : engine === "gpt56" ? nativeCodexEnv() : omnirouteCodexEnv();
  const child = spawnStream("codex", args, { cwd, extraEnv });
  req.signal.addEventListener("abort", () => { void terminateChildProcessTree(child); }, { once: true });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); }
        catch { closed = true; }
      };
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch {}
      };
      child.stdout.on("data", (b: Buffer) => send(b.toString()));
      child.stderr.on("data", (b: Buffer) => {
        const text = b.toString();
        // Codex still pings its (unused) OpenAI OAuth refresh on startup even when
        // running on the OmniRoute provider — pure noise here, don't show the user.
        if (/codex_login|refresh token|auth::manager|log out and sign in/i.test(text)) return;
        // A malformed third-party SKILL.md elsewhere in the user's global skills
        // registry does not affect this chat turn. Codex reports those discovery
        // warnings on stderr even when the OmniRoute response succeeds, which made
        // a working integration look broken in the chat UI.
        if (/failed to load skill|skills context budget|skill descriptions were removed/i.test(text)) return;
        send(JSON.stringify({ type: "stderr", text }) + "\n");
      });
      child.on("close", (code) => {
        send(JSON.stringify({ type: "done", code }) + "\n");
        safeClose();
      });
      child.on("error", (e) => {
        send(JSON.stringify({ type: "error", message: String(e) }) + "\n");
        safeClose();
      });
    },
    cancel() { return terminateChildProcessTree(child); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
