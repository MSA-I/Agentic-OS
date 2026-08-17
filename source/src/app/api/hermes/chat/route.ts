import { denyFrozenExecutionMutation } from "@/lib/control-plane/executionFreeze";
import { NextResponse } from "next/server";
import { run } from "@/lib/runner";
import { hermesHome } from "@/lib/config";
import { resolveRegisteredProjectLaunchDirectory, ProjectRegistryError } from "@/lib/control-plane/projectRegistry";
import { existsSync } from "node:fs";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import HERMES_COMMANDS from "./hermes-commands.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function defaultProfile(): string {
  const root = hermesHome();
  try {
    const value = readFileSync(path.join(root, "active_profile"), "utf8").trim();
    if (/^[A-Za-z0-9_.-]+$/.test(value)) return value;
  } catch { /* detect below */ }
  try {
    const names = readdirSync(path.join(root, "profiles"), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
    return names.includes("main") ? "main" : names[0] || "main";
  } catch { return "main"; }
}

// Strip ALL common ANSI escape sequences (CSI, OSC, simple SGR) — not just `[...m`.
// Otherwise terminal control codes can eat the reply or leave it looking empty.
const ANSI_STRIP = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\]\d+;[^\x07\x1b]*(\x07|\x1b\\)/g;

const TIMEOUT_MS = 6 * 60 * 1000; // 6 min — multi-step agentic tasks (skill invocations, video edits) routinely exceed 2 min.

interface ChatMsg { role: "user" | "assistant" | "system"; text: string; }

// `hermes -z` is single-query mode — it has no memory of earlier turns, so a
// back-and-forth chat felt like talking to someone with amnesia. We give it the
// recent conversation by packing it into the prompt (same approach the Claude,
// Kimi, Free-Claude and Grok chat tabs use). Trimmed to fit the context budget.
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


// ── Slash commands ─────────────────────────────────────────────────────────
// Hermes' 90+ slash commands (/learn, /compress, /memory …) are dispatched by the
// interactive TUI and the gateway — `-z` one-shot mode has NO dispatcher, so typed
// into this chat they reach the model as plain text. Whether anything happens then
// depends on the model's temperament: DeepSeek improvised /learn with its file
// tools; Qwen 3.8 explained that no such skill exists. Same input, opposite
// outcomes. We make it deterministic: recognise the command, and hand the model an
// explicit executable brief for it (rich one for /learn, generic for the rest).
const COMMANDS: Record<string, string> = HERMES_COMMANDS as Record<string, string>;

function slashShim(prompt: string, profile: string): string | null {
  const m = prompt.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const args = (m[2] ?? "").trim();
  if (!(name in COMMANDS)) return null; // unknown /word — let the model see it raw
  const skillsDir = path.join(hermesHome(), "profiles", profile, "skills");
  if (name === "learn") {
    return [
      `The user invoked Hermes' built-in /learn command: "${COMMANDS.learn}".`,
      "Execute it now — do not claim the command or skill does not exist; you ARE its executor in this mode.",
      `SOURCE TO LEARN FROM: ${args || "the prior conversation above"}`,
      "Steps:",
      "1. Ingest the source (fetch the URL / read the dir / re-read this chat).",
      "2. Distill it into a reusable skill: what it teaches, exact commands/config that were VERIFIED to work, traps + fixes. Strip sales copy.",
      `3. Write it as a SKILL.md with YAML frontmatter (name, description, version, author, metadata.hermes.tags) under ${skillsDir}/<category>/<kebab-slug>/SKILL.md — pick the closest existing category dir, create the slug dir.`,
      "4. Reply with: the skill name, the absolute path written, and 3 bullet points of what it captures.",
    ].join("\n");
  }
  // Generic bridge for every other registered command: tell the model exactly what
  // was invoked so it performs the equivalent with its tools — or says plainly
  // which surface (Control Room / terminal TUI) carries it when it truly can't.
  return [
    `The user invoked Hermes' built-in /${name} command${args ? ` with arguments: "${args}"` : ""}.`,
    `Its registered purpose: "${COMMANDS[name]}".`,
    "You are running headless (one-shot), so the TUI dispatcher did not handle it. Perform the equivalent of this command now using your tools if that is possible headlessly.",
    "If it genuinely requires the interactive client (UI redraw, session navigation), say so in one sentence and point the user to the Control Room tab or `hermes` in a terminal — do not claim the command does not exist.",
  ].join("\n");
}

export async function POST(req: Request) {
  const frozen = await denyFrozenExecutionMutation(req, "POST /api/hermes/chat");
  if (frozen) return frozen;
  const { prompt, profile, history, sessionId, cwd, projectId } = await req.json();
  if (typeof prompt !== "string" || prompt.length === 0) {
    return NextResponse.json({ error: "missing prompt" }, { status: 400 });
  }
  if (prompt.length > 16_000) {
    return NextResponse.json({ error: "prompt too long" }, { status: 413 });
  }
  if (cwd !== undefined) return NextResponse.json({ error: "client-supplied cwd is not accepted; select a project" }, { status: 400 });
  // Optional profile = chat as a specific Hermes employee (seo-writer, etc.).
  if (profile !== undefined && (typeof profile !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile))) {
    return NextResponse.json({ error: "bad profile" }, { status: 400 });
  }
  if (sessionId !== undefined && (typeof sessionId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(sessionId))) {
    return NextResponse.json({ error: "bad session id" }, { status: 400 });
  }
  if (/^\/yolo(?:\s|$)/i.test(prompt.trim())) {
    return NextResponse.json({ error: "Hermes YOLO mode is disabled by Agent OS execution policy." }, { status: 403 });
  }

  // hermes -z PROMPT  — single-query non-interactive mode.
  // Agent OS deliberately does not auto-approve tools or hooks. A headless run
  // that requires interactive approval must stop safely rather than bypass it.
  // A stale/deleted profile selection (e.g. a "kimi" pill left in localStorage from an
  // earlier setup) must NOT hard-fail every message with "Profile 'kimi' does not exist".
  // Only pass --profile when that profile actually exists; otherwise fall back to Hermes'
  // default active profile so the chat still works.
  // v0.19 REALITY CHECK (2026-07-31): the HERMES_PROFILE env var is IGNORED by Hermes —
  // `HERMES_PROFILE=x hermes status` silently reports the ACTIVE profile's model, so every
  // profile pill was cosmetic and answers came from `julian` (kimi-k3). Only the `-p` FLAG
  // selects a profile. -p scopes auth per-profile, so each profile's auth.json now carries
  // the Portal OAuth block (propagated from julian) — verified `hermes -p hermes-cloud status`
  // shows Nous Portal ✓ logged in.
  const profileArgs: string[] = profile && existsSync(path.join(hermesHome(), "profiles", profile))
    ? ["-p", profile]
    : [];
  // Pack the recent conversation in so follow-ups keep context (no more amnesia).
  const activeProfile = profileArgs.length ? profileArgs[1] : defaultProfile();
  const shimmed = slashShim(prompt.trim(), activeProfile);
  const fullPrompt = sessionId ? (shimmed ?? prompt) : buildPromptWithHistory(history, shimmed ?? prompt);
  const args = [...profileArgs, "chat", "-Q"];
  if (sessionId) args.push("--resume", sessionId);
  args.push("-q", fullPrompt, "--source", "agent-os");
  let runCwd;
  try { runCwd = await resolveRegisteredProjectLaunchDirectory("hermes", typeof projectId === "string" ? projectId : undefined); }
  catch (error) {
    const code = error instanceof ProjectRegistryError ? error.code : "project_directory_invalid";
    return NextResponse.json({ code, error: "Hermes project is not an approved launch target." }, { status: 400 });
  }
  const out = await run("hermes", args, { timeoutMs: TIMEOUT_MS, cwd: runCwd, signal: req.signal });
  if (out.code === -1 && /^Provider launch denied:/.test(out.stderr)) {
    return NextResponse.json({ code: out.stderr.split(": ").at(-1), error: "Hermes start is disabled by runtime containment." }, { status: 503 });
  }

  const text = out.stdout.replace(ANSI_STRIP, "").trim();
  const stderrClean = out.stderr.replace(ANSI_STRIP, "").trim();
  const returnedSessionId = /(?:^|\n)session_id:\s*([^\s]+)/i.exec(stderrClean)?.[1] ?? sessionId ?? null;

  // If Hermes produced no usable text, build a diagnostic reply instead of returning the opaque "(no response)".
  let diagnostic: string | null = null;
  if (!text) {
    const seconds = (out.durationMs / 1000).toFixed(1);
    const probableTimeout = out.durationMs >= TIMEOUT_MS - 2_000;
    const lines: string[] = [];
    lines.push(probableTimeout
      ? `⏱ Hermes was killed after ${seconds}s — the task likely needed longer than the ${Math.round(TIMEOUT_MS/60000)}-minute budget. Multi-step agentic tasks (skill invocations, video edits) often exceed this.`
      : `⚠ Hermes finished in ${seconds}s with exit ${out.code} but no stdout.`
    );
    if (stderrClean) {
      lines.push("");
      lines.push("─── stderr ───");
      lines.push(stderrClean.length > 4000 ? stderrClean.slice(-4000) : stderrClean);
    } else if (probableTimeout) {
      // A timeout with clean stderr is NOT an auth problem — sending the user to
      // `hermes status` here (as we used to) chases a config issue that doesn't exist.
      lines.push("");
      lines.push("Try a tighter ask, or run long jobs via Goal Mode / the Control Room — those have no 6-minute ceiling.");
    } else {
      lines.push("");
      lines.push("(no stderr either) — blank output with no error is almost always auth or provider config:");
      lines.push("  1. Run `hermes status` — does your provider show a ✓ next to its API key?");
      lines.push("  2. If ✗, run `hermes login` (or set the key in ~/.hermes/.env) for that provider.");
      lines.push("  3. Check the Model + Provider lines in `hermes status` are a real, supported combo.");
      lines.push("  4. Then `hermes doctor` for a full config check.");
    }
    diagnostic = lines.join("\n");
  }

  return NextResponse.json({
    ok: out.ok && !!text,
    text: text || diagnostic || "(no response)",
    empty: !text,
    durationMs: out.durationMs,
    exitCode: out.code,
    timedOut: !text && out.durationMs >= TIMEOUT_MS - 2_000,
    stderr: stderrClean, // full, no trunc — useful for diagnosing
    sessionId: returnedSessionId,
  });
}
