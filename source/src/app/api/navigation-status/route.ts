import { NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, hermesHome } from "@/lib/config";
import { getState as getFreeClaudeState } from "@/lib/fcc";
import { getGlmCodeState } from "@/lib/glmcode";
import { resolveHiggsfieldProfile } from "@/lib/higgsfieldProfile";
import { jcodeInstalled } from "@/lib/jcodeAgent";
import { getOpenCodeState } from "@/lib/opencode";
import { NAVIGATION_ITEMS, type NavigationStatus } from "@/lib/navigation";
import { getSetupState } from "@/lib/setupRuntime";
import { readSunoKey } from "@/lib/suno";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cliStatus(installed: boolean, dependency: string): NavigationStatus {
  return installed
    ? { status: "ready" }
    : { status: "not-installed", reason: `Requires ${dependency}` };
}

function ready(): NavigationStatus {
  return { status: "ready" };
}

function unavailable(reason: string): NavigationStatus {
  return { status: "not-installed", reason };
}

function setupStatus(entry: Awaited<ReturnType<typeof getSetupState>>["entries"][number]): NavigationStatus {
  if (entry.readiness.ready) return ready();
  return unavailable(entry.readiness.reason || entry.summary);
}

function assertCompleteStatusMatrix(statuses: Record<string, NavigationStatus>): void {
  const expected = new Set(NAVIGATION_ITEMS.map((item) => item.href));
  const missing = [...expected].filter((href) => !Object.hasOwn(statuses, href));
  const unexpected = Object.keys(statuses).filter((href) => !expected.has(href));
  const invalid = Object.values(statuses).filter((entry) => (
    (entry.status !== "ready" && entry.status !== "not-installed")
    || (entry.status === "not-installed" && !entry.reason?.trim())
  ));
  if (missing.length || unexpected.length || invalid.length) {
    throw new Error(`Navigation status matrix is invalid (${missing.length} missing, ${unexpected.length} unexpected, ${invalid.length} invalid)`);
  }
}

function envFileHas(file: string, names: string[]): boolean {
  try {
    const text = fs.readFileSync(file, "utf8");
    return names.some((name) => new RegExp(`^${name}=.+$`, "m").test(text));
  } catch {
    return false;
  }
}

function activeHermesProfile(): string {
  try {
    return fs.readFileSync(path.join(hermesHome(), "active_profile"), "utf8").trim() || "default";
  } catch {
    return "default";
  }
}

function hasOpenRouterKey(): boolean {
  if (process.env.OPENROUTER_API_KEY) return true;
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(hermesHome(), "auth.json"), "utf8"));
    const value = auth?.openrouter;
    if (typeof value === "string" ? value.trim() : value?.api_key) return true;
  } catch { /* fall through to profile files */ }
  const active = activeHermesProfile();
  return [
    path.join(hermesHome(), "profiles", active, ".env"),
    path.join(hermesHome(), "profiles", "julian", ".env"),
    path.join(hermesHome(), "profiles", "fusion", ".env"),
    path.join(hermesHome(), ".env"),
    path.join(os.homedir(), ".fcc", ".env"),
  ].some((file) => envFileHas(file, ["OPENROUTER_API_KEY"]));
}

function hasDeepSeekKey(): boolean {
  if (process.env.DEEPSEEK_API_KEY) return true;
  return [
    path.join(os.homedir(), ".fcc", ".env"),
    path.join(hermesHome(), ".env"),
  ].some((file) => envFileHas(file, ["DEEPSEEK_API_KEY"]));
}

function hasGlmKey(): boolean {
  if (process.env.GLM_API_KEY || process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY) return true;
  return envFileHas(
    path.join(hermesHome(), "profiles", "glm-5-2", ".env"),
    ["GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"],
  );
}

function hasSakanaKey(): boolean {
  if (process.env.SAKANA_API_KEY) return true;
  return [
    path.join(hermesHome(), "profiles", "sakana-fugu", ".env"),
    path.join(hermesHome(), "profiles", "sakana", ".env"),
    path.join(hermesHome(), ".env"),
  ].some((file) => envFileHas(file, ["SAKANA_API_KEY"]));
}

// This endpoint deliberately exposes availability only. Binary paths,
// credentials, environment variables and other local configuration stay on
// the server.
export async function GET() {
  const [glmCodeState, freeClaudeState, higgsfield, setupState] = await Promise.all([
    getGlmCodeState(),
    getFreeClaudeState(),
    resolveHiggsfieldProfile(),
    getSetupState(),
  ]);
  const openRouterReady = hasOpenRouterKey();
  const openCodeState = getOpenCodeState();
  const higgsReady = Boolean(config.hermes) && higgsfield.registered;

  const statuses: Record<string, NavigationStatus> = {
    "/": ready(),

    "/claude": cliStatus(Boolean(config.claude), "Claude CLI"),
    "/openclaw": cliStatus(Boolean(config.openclaw), "OpenClaw CLI"),
    "/hermes": cliStatus(Boolean(config.hermes), "Hermes CLI"),
    "/antigravity": cliStatus(Boolean(config.antigravity), "Antigravity CLI"),
    "/codex": cliStatus(Boolean(config.codex), "Codex CLI"),
    "/kimi": cliStatus(Boolean(config.kimi), "Kimi Code CLI"),
    "/glm": cliStatus(hasGlmKey(), "GLM API credentials"),
    "/glm-code": cliStatus(
      Boolean(config.codex) || Boolean(config.kimi) || glmCodeState.ready,
      "Codex CLI, Kimi Code CLI, or a running Ollama GLM bridge",
    ),
    "/jcode": cliStatus(jcodeInstalled(), "jcode"),
    "/grok": cliStatus(Boolean(config.grok), "Grok Build CLI"),
    "/freeclaude": cliStatus(
      Boolean(config.claude) && freeClaudeState.enabled && freeClaudeState.reachable,
      "Claude CLI and an active free router",
    ),
    "/omniroute": cliStatus(freeClaudeState.routers.omniroute.reachable, "a running OmniRoute gateway"),
    "/hy3-coder": cliStatus(openRouterReady, "OpenRouter credentials"),
    "/deepseek-coder": cliStatus(hasDeepSeekKey(), "DeepSeek credentials"),
    "/muse-code": cliStatus(openRouterReady, "OpenRouter credentials"),
    "/opencode": cliStatus(openCodeState.ready, "OpenCode CLI"),
    "/fusion": cliStatus(openRouterReady, "OpenRouter credentials"),
    "/sakana": cliStatus(hasSakanaKey(), "Sakana credentials"),
    "/local": cliStatus(glmCodeState.ollamaUp, "a running local Ollama service"),
    "/engine": cliStatus(Boolean(config.hermes) && glmCodeState.ollamaUp, "Hermes CLI and local Ollama"),

    "/paperclip": unavailable("Paperclip company configuration is missing; API fallbacks currently return empty data"),
    "/room": cliStatus(openRouterReady, "OpenRouter credentials"),
    "/pipeline": ready(),
    "/agent-kanban": ready(),
    "/loop": unavailable("Setup required: Nous Portal is not connected"),
    "/ruflo": cliStatus(Boolean(config.ruflo), "Ruflo CLI"),

    "/higgsfield": cliStatus(higgsReady, "a locally registered Higgsfield MCP in Hermes"),
    "/opendesign": unavailable("Setup required: Open Design daemon is not running"),
    "/video": unavailable("Setup required: HyperFrames CLI and HeyGen/ElevenLabs credentials are not configured"),
    "/studio": unavailable("Setup required: no enabled media provider credentials for the selected Hermes profile"),
    "/openmontage": unavailable("OpenMontage generation scripts are missing; jobs cannot advance past starting"),
    "/video-use": unavailable("Setup required: Claude video-use skill is not installed"),
    "/music": cliStatus(Boolean(readSunoKey()), "Suno credentials"),
    "/games": unavailable("Setup required: Games workspace and Hermes game-studio board are not initialized"),
    "/apps": unavailable("App Lab repository and credentials are missing, and its launcher is not Windows-compatible"),
    "/thumbnails": unavailable("Setup required: YouTube thumbnails skill and OpenAI credentials are not configured"),

    "/leads": unavailable("Setup required: Hunter, Apollo, and model providers are not configured"),
    "/seo": ready(),
    "/notebook": cliStatus(Boolean(config.nlmBin), "NotebookLM MCP"),
    "/kanban": ready(),
    "/memory": ready(),
    "/goals": ready(),
    "/journal": ready(),
  };

  // Setup Center owns readiness for every service it can connect or repair.
  // Overlaying the shared diagnostics here prevents a successful connection
  // from remaining stranded under Not installed because of a stale hardcoded
  // navigation rule. The response still exposes only status + a safe reason.
  for (const entry of setupState.entries) {
    if (Object.hasOwn(statuses, entry.route)) statuses[entry.route] = setupStatus(entry);
  }

  assertCompleteStatusMatrix(statuses);

  return NextResponse.json(
    { settled: true, checkedAt: new Date().toISOString(), statuses },
    { headers: { "Cache-Control": "private, max-age=30" } },
  );
}
