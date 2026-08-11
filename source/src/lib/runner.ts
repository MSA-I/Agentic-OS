import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { config } from "./config";

// "fcc" is the Free Claude Code agent — it runs the same `claude` CLI but with
// the local fcc-server proxy env vars injected, routing requests to OpenRouter
// / NVIDIA NIM / Kimi / etc instead of api.anthropic.com.
// "codex" is OpenAI's Codex CLI (≥ 0.125 — supports `codex exec --json` for streaming).
export type AgentName = "claude" | "openclaw" | "hermes" | "antigravity" | "fcc" | "codex" | "kimi" | "grok" | "ruflo" | "ant";

function binFor(agent: AgentName): string {
  // fcc is a virtual agent — it spawns the regular claude binary, just with
  // different env vars (see fccSpawnEnv in lib/fcc.ts).
  const key = agent === "fcc" ? "claude" : agent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bin = (config as any)[key];
  if (!bin) throw new Error(`${agent} is not installed or not configured. Set AGENTIC_OS_${key.toUpperCase()}_BIN or install the CLI.`);
  return bin;
}

// Build an env that agents can actually run subprocesses inside. The Next.js dev server's
// own process.env can be missing SHELL or have a stripped PATH, which causes Antigravity to
// crash mid-task with `fork/exec /bin/zsh: no such file or directory` and similar.
// We force SHELL + a baseline PATH covering all the standard macOS bin dirs + Homebrew + the
// user's local Node, so any tool the agent shells out to can be resolved.
function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = process.env;
  const ensurePath = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    `${process.env.HOME ?? "/Users/juliangoldie"}/.local/bin`,
    `${process.env.HOME ?? "/Users/juliangoldie"}/local/node/bin`,
    `${process.env.HOME ?? "/Users/juliangoldie"}/.kimi-code/bin`,
  ];
  // path.delimiter: ";" on Windows, ":" elsewhere — splitting a Windows PATH on
  // ":" shreds it at every drive letter and breaks child processes' tool lookup.
  const existing = (base.PATH ?? "").split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...existing, ...ensurePath])].join(path.delimiter);
  return {
    ...base,
    PATH: merged,
    SHELL: base.SHELL || "/bin/zsh",
    HOME: base.HOME || `/Users/${process.env.USER || "juliangoldie"}`,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...extra,
  };
}

// Windows: npm-installed CLIs (openclaw, ruflo…) ship as .cmd shims, which
// Node's spawn refuses to execute without a shell (CVE-2024-27980 hardening).
// Preferred path: resolve the shim to its underlying JS entry and spawn it with
// node directly — cmd.exe MUST NOT be used for args that may contain newlines
// (chat prompts/history), because cmd truncates the command line at the first
// newline. cmd.exe remains only as a last-resort fallback for single-line args.
const shimEntryCache = new Map<string, string | null>();
function npmShimEntry(bin: string): string | null {
  if (shimEntryCache.has(bin)) return shimEntryCache.get(bin)!;
  let entry: string | null = null;
  try {
    const dir = path.dirname(bin);
    const name = path.basename(bin).replace(/\.(cmd|bat|ps1)$/i, "");
    const pkgDir = path.join(dir, "node_modules", name);
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const binField = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[name];
    if (binField) {
      const p = path.join(pkgDir, binField);
      if (existsSync(p)) entry = p;
    }
  } catch { /* not an npm shim layout — fall through */ }
  shimEntryCache.set(bin, entry);
  return entry;
}

function resolveWinScript(bin: string, args: readonly string[]): { bin: string; args: string[] } {
  if (process.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(bin)) {
    const entry = npmShimEntry(bin);
    if (entry) return { bin: process.execPath, args: [entry, ...args] };
    return { bin: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", bin.replace(/\.ps1$/i, ".cmd"), ...args] };
  }
  return { bin, args: [...args] };
}

const FLAG_PATTERN = /^[A-Za-z0-9_\-./:=,@+%]+$/;
const MAX_ARG_LEN = 32_000;

export function validateFlagArgs(args: readonly string[]): string[] {
  return args.filter((a) => typeof a === "string" && a.length < MAX_ARG_LEN && FLAG_PATTERN.test(a));
}

function safeArg(a: unknown): string | null {
  if (typeof a !== "string") return null;
  if (a.length === 0 || a.length > MAX_ARG_LEN) return null;
  if (a.includes("\0")) return null;
  return a;
}

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function run(
  agent: AgentName,
  args: readonly string[],
  opts: { timeoutMs?: number; cwd?: string; input?: string; extraEnv?: Record<string, string> } = {}
): Promise<RunResult> {
  const cleanArgs = args.map(safeArg).filter((a): a is string => a !== null);
  const started = Date.now();

  let bin: string;
  try { bin = binFor(agent); }
  catch (e) {
    return { ok: false, code: -1, stdout: "", stderr: String(e), durationMs: 0 };
  }

  return new Promise<RunResult>((resolve) => {
    const resolved = resolveWinScript(bin, cleanArgs);
    const child = spawn(resolved.bin, resolved.args, {
      cwd: opts.cwd ?? process.env.HOME,
      env: agentEnv(opts.extraEnv ?? {}),
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, opts.timeoutMs ?? 15_000);

    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ ok: code === 0, code, stdout, stderr, durationMs: Date.now() - started });
    });
    child.on("error", (e) => {
      clearTimeout(timeout);
      resolve({ ok: false, code: -1, stdout, stderr: String(e), durationMs: Date.now() - started });
    });

    if (opts.input) child.stdin.write(opts.input);
    try { child.stdin.end(); } catch {}
  });
}

export function spawnStream(
  agent: AgentName,
  args: readonly string[],
  opts: { cwd?: string; input?: string; extraEnv?: Record<string, string> } = {}
): ChildProcessWithoutNullStreams {
  const bin = binFor(agent);
  const cleanArgs = args.map(safeArg).filter((a): a is string => a !== null);
  const resolved = resolveWinScript(bin, cleanArgs);
  const child = spawn(resolved.bin, resolved.args, {
    cwd: opts.cwd ?? process.env.HOME,
    env: agentEnv(opts.extraEnv ?? {}),
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  if (typeof opts.input === "string" && opts.input.length > 0) {
    // Write the prompt to stdin (no OS arg-length limit, no per-arg cap).
    child.stdin.write(opts.input);
  }
  try { child.stdin.end(); } catch {}
  return child;
}
