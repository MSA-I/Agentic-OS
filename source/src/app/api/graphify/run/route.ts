import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  authorizeLocalMutation,
  readLocalMutationJson,
} from "@/lib/control-plane/executionFreeze";
import { buildToolChildEnvironment } from "@/lib/control-plane/childEnvironment";
import { redactText } from "@/lib/workbench/redaction";
import { AGENT_OS_FOLDERS_ROOT } from "@/lib/workspaceRoot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 120_000;
const MAX_COMMAND_CHARS = 8_000;
const MAX_TOKENS = 40;
const MAX_TOKEN_CHARS = 500;
const ANSI_STRIP = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\]\d+;[^\x07\x1b]*(\x07|\x1b\\)/g;

// Read-only analysis surface only. Anything that starts a daemon, watches the
// filesystem, fetches a URL or pushes to a remote database stays out: those are
// Tool Gateway work, not something an unapproved browser request may trigger.
const ALLOWED_COMMANDS = new Set([
  "--version", "-V", "--help", "-h", "help",
  "query", "path", "explain", "god-nodes", "diagnose", "tree", "detect", "extract",
]);
const DENIED_ARGUMENTS = new Set([
  "--mcp", "--watch", "--neo4j", "--neo4j-push", "--falkordb", "--falkordb-push",
  "--obsidian", "--obsidian-dir", "--wiki",
]);
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/|\/)/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function graphifyBinary(): string {
  const configured = process.env.AGENT_OS_GRAPHIFY_BIN?.trim();
  if (configured && existsSync(configured)) return configured;
  // Windows only: a real executable. The extensionless bash shim and the .cmd
  // wrapper on PATH would need a shell to run, and a shell is exactly what this
  // route must never introduce.
  const extensions = process.platform === "win32" ? [".exe", ".com"] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `graphify${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

// ponytail: roots are a launch allowlist, not a sandbox. Set
// AGENT_OS_GRAPHIFY_ROOTS to narrow it; real containment arrives with the Tool
// Gateway, which is when this route should move behind an approval instead.
function allowedRoots(): string[] {
  const configured = (process.env.AGENT_OS_GRAPHIFY_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const roots = configured.length > 0
    ? configured
    : [AGENT_OS_FOLDERS_ROOT, path.resolve(process.cwd(), "..", "..")];
  return roots.map((root) => path.resolve(root));
}

function isInsideAllowedRoot(candidate: string): boolean {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const resolved = fold(path.resolve(candidate));
  return allowedRoots()
    .map(fold)
    .some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

/** Canonical, non-symlinked, existing directory inside an allowed root. */
function approvedWorkingDirectory(requested: unknown): string | null {
  if (typeof requested !== "string" || !requested.trim()) return null;
  const candidate = path.resolve(requested.trim());
  if (candidate.startsWith("\\\\") || candidate.startsWith("//")) return null;
  try {
    if (lstatSync(candidate).isSymbolicLink()) return null;
    const canonical = realpathSync.native(candidate);
    const same = process.platform === "win32"
      ? canonical.toLowerCase() === candidate.toLowerCase()
      : canonical === candidate;
    if (!same || !statSync(canonical).isDirectory()) return null;
    return isInsideAllowedRoot(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

function tokenize(command: string): string[] | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return null;
  for (const token of tokens) {
    if (token.length > MAX_TOKEN_CHARS || CONTROL_CHARACTERS.test(token)) return null;
  }
  return tokens;
}

function deniedReason(tokens: string[]): string | null {
  if (!ALLOWED_COMMANDS.has(tokens[0])) {
    return `Command "${tokens[0]}" is not on the graphify allowlist.`;
  }
  for (const token of tokens.slice(1)) {
    if (DENIED_ARGUMENTS.has(token.split("=", 1)[0].toLowerCase())) {
      return `Argument "${token}" is disabled here: it starts a server, watcher, fetch or remote push.`;
    }
    if (token.includes("://")) {
      return "Remote URLs are not accepted by this endpoint.";
    }
    if (ABSOLUTE_PATH.test(token) && !isInsideAllowedRoot(token)) {
      return "Absolute paths must stay inside an allowed project root.";
    }
  }
  return null;
}

export async function POST(req: Request) {
  const boundary = authorizeLocalMutation(req);
  if (boundary) return boundary;
  const parsed = await readLocalMutationJson(req);
  if ("error" in parsed) return parsed.error;

  const { command, cwd } = parsed.body;
  if (typeof command !== "string" || command.length === 0) {
    return NextResponse.json({ error: "missing command" }, { status: 400 });
  }
  if (command.length > MAX_COMMAND_CHARS) {
    return NextResponse.json({ error: "command too long" }, { status: 413 });
  }

  const args = tokenize(command);
  if (!args) {
    return NextResponse.json({ error: "command could not be parsed safely" }, { status: 400 });
  }
  const denied = deniedReason(args);
  if (denied) {
    return NextResponse.json({ code: "graphify_command_denied", error: denied }, { status: 403 });
  }

  // A directory that was asked for and refused must fail closed. Falling back to
  // the default would silently run the command somewhere else.
  const requested = typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
  const workDir = requested
    ? approvedWorkingDirectory(requested)
    : approvedWorkingDirectory(AGENT_OS_FOLDERS_ROOT);
  if (!workDir) {
    return NextResponse.json({
      code: "graphify_directory_denied",
      error: "The requested directory is outside every allowed project root.",
    }, { status: 403 });
  }

  const binary = graphifyBinary();
  if (!binary) {
    return NextResponse.json({
      code: "graphify_not_installed",
      error: "graphify was not found on PATH. Set AGENT_OS_GRAPHIFY_BIN to its full path.",
    }, { status: 503 });
  }

  return new Promise<NextResponse>((resolve) => {
    const started = Date.now();
    execFile(binary, args, {
      cwd: workDir,
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: buildToolChildEnvironment(
        [
          "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
          "GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY",
          "UV_CACHE_DIR", "VIRTUAL_ENV",
        ],
        { PYTHONPATH: "", PYTHONIOENCODING: "utf-8" },
      ),
    }, (error, stdout, stderr) => {
      const clean = (value: string) => redactText(value.replace(ANSI_STRIP, "").trim());
      resolve(NextResponse.json({
        ok: !error || error.code === 0,
        stdout: clean(stdout),
        stderr: clean(stderr),
        durationMs: Date.now() - started,
        exitCode: error?.code ?? 0,
        signal: error?.signal ?? null,
      }, { headers: { "Cache-Control": "no-store" } }));
    });
  });
}
