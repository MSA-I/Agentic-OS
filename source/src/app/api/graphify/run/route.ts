import { NextResponse } from "next/server";
import { execFile, execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Resolve the graphify binary: prefer global uv tool install, fall back to project venv
function resolveGraphifyBin(): string {
  try {
    const which = process.platform === "win32" ? "where.exe" : "command -v";
    const out = execSync(`${which} graphify`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const match = out.split(/\r?\n/).map((l) => l.trim()).find((l) => /\bgraphify(\.exe)?$/.test(l));
    if (match && fs.existsSync(match)) return match;
  } catch { /* fall through */ }
  const fallback = "D:\\משה פרוייקטים\\פיתוח אתרים\\AI\\graphify\\.venv\\Scripts\\graphify.exe";
  return fs.existsSync(fallback) ? fallback : "graphify";
}

const GRAPHIFY_BIN = resolveGraphifyBin();
const TIMEOUT_MS = 120_000;
const ANSI_STRIP = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\]\d+;[^\x07\x1b]*(\x07|\x1b\\)/g;

export async function POST(req: Request) {
  const { command, cwd } = await req.json();
  if (typeof command !== "string" || command.length === 0) {
    return NextResponse.json({ error: "missing command" }, { status: 400 });
  }
  if (command.length > 8000) {
    return NextResponse.json({ error: "command too long" }, { status: 413 });
  }

  const args = command.split(/\s+/);
  const workDir = typeof cwd === "string" && cwd.length > 0
    ? cwd
    : path.dirname(path.dirname(path.dirname(GRAPHIFY_BIN))); // strip 3 dirs up from bin

  return new Promise<NextResponse>((resolve) => {
    const started = Date.now();
    const child = execFile(GRAPHIFY_BIN, args, {
      cwd: workDir,
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONPATH: "" },
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - started;
      const clean = (s: string) => s.replace(ANSI_STRIP, "").trim();
      const out = clean(stdout);
      const err = clean(stderr);

      resolve(NextResponse.json({
        ok: !error || error.code === 0,
        stdout: out,
        stderr: err,
        durationMs,
        exitCode: error?.code ?? 0,
        signal: error?.signal ?? null,
      }));
    });
  });
}