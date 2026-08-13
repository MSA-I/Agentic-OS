import { NextResponse } from "next/server";
import { createWriteStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { codexApprovalArgs } from "@/lib/codexWorkspace";
import {
  nativeCodexArgs,
  nativeCodexEnv,
  omnirouteCodexArgs,
  omnirouteCodexEnv,
  openrouterApiKey,
  openrouterCodexArgs,
  openrouterCodexEnv,
  OPENROUTER_HY3_MODEL,
  probeOmniRoute,
  withSteer,
} from "@/lib/omniroute";
import { spawnDetached } from "@/lib/runner";
import {
  listGoals, createGoal, updateGoal, deleteGoal, stopGoal, getGoal, readGoalLog,
} from "@/lib/codexGoals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/codex/goals          — list all goals
// GET /api/codex/goals?id=<id>  — get a single goal + log
// POST /api/codex/goals         — create + start a new goal { title, prompt, cwd? }
// DELETE /api/codex/goals?id=<id> — stop + delete a goal
// PATCH /api/codex/goals?id=<id>&action=stop — stop a goal without deleting

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const goal = await getGoal(id);
    if (!goal) return NextResponse.json({ error: "not found" }, { status: 404 });
    const log = await readGoalLog(id);
    return NextResponse.json({ goal, log });
  }
  const goals = await listGoals();
  return NextResponse.json({ goals });
}

export async function POST(req: Request) {
  if (!config.codex) {
    return NextResponse.json({ error: "codex CLI not installed" }, { status: 503 });
  }
  const body = await req.json().catch(() => ({}));
  const title = String(body.title ?? "");
  const prompt = String(body.prompt ?? "");
  if (!prompt.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 });
  if (prompt.length > 16_000) return NextResponse.json({ error: "prompt too long" }, { status: 413 });

  let cwd: string | undefined;
  if (typeof body.cwd === "string" && body.cwd.trim()) {
    const candidate = body.cwd.trim();
    try {
      if (!path.isAbsolute(candidate) || !existsSync(candidate) || !statSync(candidate).isDirectory()) {
        return NextResponse.json({ error: "cwd must be an existing absolute directory" }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "cwd is not accessible" }, { status: 400 });
    }
    cwd = candidate;
  }

  const requestedEngine = body.engine;
  if (requestedEngine !== undefined && requestedEngine !== "omniroute" && requestedEngine !== "hy3" && requestedEngine !== "gpt56") {
    return NextResponse.json({ error: "unknown Codex engine" }, { status: 400 });
  }
  const engine: "omniroute" | "hy3" | "gpt56" = requestedEngine ?? "omniroute";
  if (engine === "omniroute" && !(await probeOmniRoute())) {
    return NextResponse.json({ error: "OmniRoute is not running on :20128. Start it in Setup Center, then retry." }, { status: 503 });
  }
  if (engine === "hy3" && !openrouterApiKey()) {
    return NextResponse.json({ error: "OPENROUTER_API_KEY is missing. Connect OpenRouter in Setup Center, then retry." }, { status: 503 });
  }

  const engineArgs = engine === "hy3"
    ? openrouterCodexArgs(OPENROUTER_HY3_MODEL)
    : engine === "gpt56"
      ? nativeCodexArgs()
      : omnirouteCodexArgs();
  const engineEnv = engine === "hy3"
    ? openrouterCodexEnv()
    : engine === "gpt56"
      ? nativeCodexEnv()
      : omnirouteCodexEnv();

  const goal = await createGoal(title, prompt, cwd);

  // Launch Codex in the background, non-interactively. The old `--full-auto` alias
  // is unreliable on newer codex-cli (it can still wait on an approval prompt that
  // the browser can't answer), so set the approval policy explicitly. Default is
  // "auto" (never prompt, sandboxed to the goal's cwd); the UI can pass "yolo".
  const log = createWriteStream(goal.logFile, { flags: "a" });
  const child = spawnDetached("codex", [
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...codexApprovalArgs(body.approvalMode),
    ...engineArgs,   // OmniRoute free pool, or native gpt-5.6 on the ChatGPT OAuth login
    withSteer(goal.prompt),
  ], {
    cwd: goal.cwd,
    extraEnv: engineEnv,
  });

  child.stdout.on("data", (b: Buffer) => {
    log.write(b);
    const line = b.toString().split("\n").pop()?.trim();
    if (line) updateGoal(goal.id, { lastOutput: line.slice(0, 200) }).catch(() => {});
  });
  child.stderr.on("data", (b: Buffer) => {
    log.write(`[stderr] ${b}`);
  });
  child.on("error", (error) => {
    log.write(`[spawn error] ${String(error)}\n`);
    log.end();
    updateGoal(goal.id, {
      status: "failed",
      finishedAt: Date.now(),
      pid: undefined,
      lastOutput: String(error).slice(0, 200),
    }).catch(() => {});
  });
  child.on("close", (code) => {
    log.end();
    updateGoal(goal.id, {
      status: code === 0 ? "completed" : "failed",
      finishedAt: Date.now(),
      pid: undefined,
      exitCode: code,
    }).catch(() => {});
  });
  child.unref();

  await updateGoal(goal.id, {
    status: "running",
    startedAt: Date.now(),
    pid: child.pid,
  });

  return NextResponse.json({ goal: { ...goal, status: "running", pid: child.pid } });
}

export async function PATCH(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const action = url.searchParams.get("action");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (action === "stop") {
    const g = await stopGoal(id);
    if (!g) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ goal: g });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  // Stop first if running, then delete
  await stopGoal(id);
  const ok = await deleteGoal(id);
  return NextResponse.json({ ok });
}
