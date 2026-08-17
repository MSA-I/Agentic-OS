import { denyFrozenExecutionMutation } from "@/lib/control-plane/executionFreeze";
import { NextResponse } from "next/server";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { config, hermesHome } from "@/lib/config";
import { assertProviderLaunch, ExecutableIdentityError } from "@/lib/control-plane/executableIdentity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const pexec = promisify(execFile);

// Hermes native wake word ("hey hermes") — the OS manages a headless TUI session
// as the listener host (bare `hermes serve` never arms the detector; a real
// surface session does, per the Hermes wake-word docs).

function activeProfile(): string {
  // Hermes records the active profile name in <home>/active_profile (plain text).
  try { return readFileSync(path.join(hermesHome(), "active_profile"), "utf8").trim(); } catch { return ""; }
}

function readWakeConfig(): { enabled: boolean; phrase: string; provider: string } {
  // active profile config wins; fall back to global
  const prof = activeProfile();
  const candidates = [
    ...(prof ? [path.join(hermesHome(), "profiles", prof, "config.yaml")] : []),
    path.join(hermesHome(), "config.yaml"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const t = readFileSync(p, "utf8");
    const block = t.match(/^wake_word:\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? "";
    if (!block) continue;
    return {
      enabled: /enabled:\s*true/i.test(block),
      phrase: block.match(/phrase:\s*["']?([^"'\n]+)/)?.[1]?.trim() ?? "hey hermes",
      provider: block.match(/provider:\s*["']?([^"'\n]+)/)?.[1]?.trim() ?? "openwakeword",
    };
  }
  return { enabled: false, phrase: "hey hermes", provider: "openwakeword" };
}

async function listenerPids(): Promise<number[]> {
  try {
    const { stdout } = await pexec("/usr/bin/pgrep", ["-f", "hermes desktop|tui_gateway|Hermes Agent.app|hermes --tui"]);
    return stdout.trim().split("\n").filter(Boolean).map(Number);
  } catch { return []; }
}

async function audioLive(): Promise<boolean> {
  // any hermes-descended python process holding a CoreAudio stream = detector armed
  try {
    const { stdout } = await pexec("bash", ["-c",
      `for p in $(/usr/bin/pgrep -f "hermes-agent|tui_gateway|hermes --tui|Hermes"); do /usr/sbin/lsof -p $p 2>/dev/null | grep -qi coreaudio && { echo yes; break; }; done`],
      { timeout: 8000 });
    return stdout.includes("yes");
  } catch { return false; }
}

export async function GET() {
  const cfg = readWakeConfig();
  const pids = await listenerPids();
  const live = pids.length > 0 ? await audioLive() : false;
  return NextResponse.json({
    enabled: cfg.enabled,
    phrase: cfg.phrase,
    provider: cfg.provider,
    hostRunning: pids.length > 0,
    listening: cfg.enabled && pids.length > 0 && live,
  });
}

export async function POST(req: Request) {
  const frozen = await denyFrozenExecutionMutation(req, "POST /api/hermes/wake");
  if (frozen) return frozen;
  const { action } = await req.json().catch(() => ({}));
  if (action !== "on" && action !== "off") {
    return NextResponse.json({ error: "action must be 'on' | 'off'" }, { status: 400 });
  }
  const enabled = action === "on" ? "true" : "false";
  const configArgs = ["config", "set", "wake_word.enabled", enabled];
  const launchEnv = { ...process.env, HOME: os.homedir() };
  let hermesBin: string;
  try {
    hermesBin = (await assertProviderLaunch("hermes", config.hermes, configArgs, launchEnv)).absolutePath;
  } catch (error) {
    const code = error instanceof ExecutableIdentityError ? error.code : "executable_identity_unavailable";
    return NextResponse.json({ code, error: "Hermes executable identity or launch policy could not be verified." }, { status: 503 });
  }
  if (action === "on") {
    await pexec(hermesBin, configArgs, { timeout: 30000, env: launchEnv });
    // retire any dev-server-hosted listener (its process context has no macOS mic
    // grant, so its stream delivers only silence — the documented TCC trap)
    try { await pexec("/usr/bin/pkill", ["-f", "hermes --tui"]); } catch { /* none */ }
    if ((await listenerPids()).length === 0) {
      // current-source desktop owns the listener (the /Applications build predates
      // the wake feature): real app bundle = real mic permission
      const desktopArgs = ["desktop", "--skip-build"];
      await assertProviderLaunch("hermes", hermesBin, desktopArgs, launchEnv);
      const child = spawn(hermesBin, desktopArgs, {
        detached: true, stdio: "ignore", env: launchEnv,
      });
      child.unref();
      await new Promise((r) => setTimeout(r, 30000));
    }
  } else {
    await pexec(hermesBin, configArgs, { timeout: 30000, env: launchEnv });
    try { await pexec("/usr/bin/pkill", ["-f", "hermes --tui"]); } catch { /* not running */ }
    // desktop app stays open if the user runs it; config-off disarms its listener
  }
  return GET();
}
