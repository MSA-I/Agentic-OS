import { denyFrozenExecutionMutation } from "@/lib/control-plane/executionFreeze";
import { NextResponse } from "next/server";
import { run } from "@/lib/runner";
import { config } from "@/lib/config";
import { resolveRegisteredProjectLaunchDirectory, ProjectRegistryError } from "@/lib/control-plane/projectRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatMsg { role: "user" | "assistant" | "system"; text: string; }

// `openclaw agent -m` is single-shot per call (no memory between messages), so a
// back-and-forth would have amnesia like the Claude/Hermes tabs did. Pack the recent
// turns into the prompt — same buildPromptWithHistory pattern as the other chat tabs.
function buildPromptWithHistory(history: ChatMsg[], current: string): string {
  if (!Array.isArray(history) || !history.length) return current;
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
    if (!m || typeof m.text !== "string") continue;
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
  const frozen = await denyFrozenExecutionMutation(req, "POST /api/openclaw/chat");
  if (frozen) return frozen;
  const { prompt, agent, history, sessionId, sessionKey, cwd, projectId } = await req.json();
  if (typeof prompt !== "string" || prompt.length === 0) {
    return NextResponse.json({ error: "missing prompt" }, { status: 400 });
  }
  if (prompt.length > 16_000) {
    return NextResponse.json({ error: "prompt too long" }, { status: 413 });
  }
  if (cwd !== undefined) return NextResponse.json({ error: "client-supplied cwd is not accepted; select a project" }, { status: 400 });
  const agentId = typeof agent === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(agent) ? agent : config.openclawAgent;
  if (sessionId !== undefined && (typeof sessionId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(sessionId))) {
    return NextResponse.json({ error: "bad session id" }, { status: 400 });
  }
  if (sessionKey !== undefined && (typeof sessionKey !== "string" || !/^agent:[A-Za-z0-9_-]+:[A-Za-z0-9_.:-]+$/.test(sessionKey))) {
    return NextResponse.json({ error: "bad session key" }, { status: 400 });
  }
  const fullPrompt = sessionId || sessionKey ? prompt : buildPromptWithHistory(history, prompt);

  // openclaw agent --local --agent <id> -m <prompt+history> --json --timeout 120
  const args = ["agent", "--local", "--agent", agentId];
  if (sessionKey) args.push("--session-key", sessionKey);
  else if (sessionId) args.push("--session-id", sessionId);
  args.push("-m", fullPrompt, "--json", "--timeout", "120");
  let runCwd;
  try { runCwd = await resolveRegisteredProjectLaunchDirectory("openclaw", typeof projectId === "string" ? projectId : undefined); }
  catch (error) {
    const code = error instanceof ProjectRegistryError ? error.code : "project_directory_invalid";
    return NextResponse.json({ code, error: "OpenClaw project is not an approved launch target." }, { status: 400 });
  }
  const out = await run("openclaw", args, { timeoutMs: 150_000, cwd: runCwd, signal: req.signal });
  if (out.code === -1 && /^Provider launch denied:/.test(out.stderr)) {
    return NextResponse.json({ code: out.stderr.split(": ").at(-1), error: "OpenClaw start is disabled by runtime containment." }, { status: 503 });
  }

  // Try to parse JSON payload from stdout (may include leading non-JSON log lines)
  let text = "";
  let json: unknown = null;
  const firstBrace = out.stdout.indexOf("{");
  if (firstBrace !== -1) {
    try {
      json = JSON.parse(out.stdout.slice(firstBrace));
      const j = json as { payloads?: { text?: string }[]; meta?: { finalAssistantVisibleText?: string; sessionId?: string; sessionKey?: string }; sessionId?: string; sessionKey?: string };
      text = j.meta?.finalAssistantVisibleText
        ?? j.payloads?.[0]?.text
        ?? "";
    } catch {
      text = out.stdout.slice(firstBrace, firstBrace + 800);
    }
  }
  if (!text) text = out.stdout.trim().slice(0, 800) || "(no response)";

  // OpenClaw on Windows can exit non-zero after a fully successful reply —
  // a parsed JSON payload IS success, regardless of the exit code.
  return NextResponse.json({
    ok: out.ok || Boolean(json),
    text,
    durationMs: out.durationMs,
    agent: agentId,
    sessionId: (json as { sessionId?: string; meta?: { sessionId?: string } } | null)?.sessionId
      ?? (json as { meta?: { sessionId?: string } } | null)?.meta?.sessionId
      ?? sessionId
      ?? null,
    sessionKey: (json as { sessionKey?: string; meta?: { sessionKey?: string } } | null)?.sessionKey
      ?? (json as { meta?: { sessionKey?: string } } | null)?.meta?.sessionKey
      ?? sessionKey
      ?? null,
    stderr: out.stderr.slice(0, 2000),
  });
}
