import "server-only";

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access, chmod, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config, hermesHome } from "@/lib/config";
import { getState as getFreeClaudeState } from "@/lib/fcc";
import { getGlmCodeState } from "@/lib/glmcode";
import { addCustomServer } from "@/lib/hermesMcp";
import { hermesCliArgs, resolveHermesProfile, hermesProfileEnvPath } from "@/lib/hermesProfile";
import { resolveHiggsfieldProfile } from "@/lib/higgsfieldProfile";
import { FALLBACK_MODEL, LOCAL_OPENAI_BASE, LOCAL_OPENAI_MODEL, MAPLE_BASE } from "@/lib/localModel";
import { OMNIROUTE_BASE, OMNIROUTE_KEY, omnirouteRequestHeaders } from "@/lib/omniroute";
import { getOpenCodeState, OMNIROUTE_OPENCODE_PROVIDER, OPENCODE_CONFIG, omniRouteProviderConfigured } from "@/lib/opencode";
import { getPaperclipConfig, probePaperclipCompany } from "@/lib/paperclipConfig";
import { run } from "@/lib/runner";
import { workspacePath } from "@/lib/workspaceRoot";
import {
  SETUP_CATALOG,
  getSetupAction,
  getSetupEntry,
  type SetupActionRequest,
  type SetupActionResponse,
  type SetupCatalogEntry,
  type SetupDiagnostic,
  type SetupEntryState,
  type SetupGetResponse,
  type SetupReadiness,
  type SetupRoute,
} from "@/lib/setupCatalog";

const HOME = os.homedir();
const AGENTIC_DIR = path.join(HOME, ".agentic-os");
const AGENTIC_CONFIG = path.join(AGENTIC_DIR, "config.json");
const FCC_ENV = path.join(HOME, ".fcc", ".env");
const fileWriteTails = new Map<string, Promise<void>>();
let setupStateInFlight: Promise<SetupGetResponse> | null = null;

interface FixedCommandSpec {
  executable: "winget" | "npx" | "npm" | "uv" | "py" | "ollama" | "omniroute" | "openclaw";
  args: readonly string[];
  mode: "foreground" | "service";
  timeoutMs?: number;
}

type ResolvedFixedCommandSpec = Omit<FixedCommandSpec, "executable"> & { executable: string };

const WINGET_CONFIRM = [
  "--exact",
  "--accept-package-agreements",
  "--accept-source-agreements",
  "--disable-interactivity",
] as const;

const FIXED_COMMANDS: Readonly<Record<string, FixedCommandSpec>> = {
  "/openclaw:start-gateway": { executable: "openclaw", args: ["gateway", "start"], mode: "foreground", timeoutMs: 45_000 },
  "/freeclaude:install-omniroute": { executable: "npm", args: ["install", "-g", "omniroute@3.8.49"], mode: "foreground", timeoutMs: 15 * 60_000 },
  "/freeclaude:start-omniroute": { executable: "omniroute", args: [], mode: "service" },
  "/glm-code:install-ollama": { executable: "winget", args: ["install", "--id", "Ollama.Ollama", ...WINGET_CONFIRM], mode: "foreground" },
  "/glm-code:start-ollama": { executable: "ollama", args: ["serve"], mode: "service" },
  "/local:install-ollama": { executable: "winget", args: ["install", "--id", "Ollama.Ollama", ...WINGET_CONFIRM], mode: "foreground" },
  "/local:start-ollama": { executable: "ollama", args: ["serve"], mode: "service" },
  "/engine:install-ollama": { executable: "winget", args: ["install", "--id", "Ollama.Ollama", ...WINGET_CONFIRM], mode: "foreground" },
  "/engine:start-ollama": { executable: "ollama", args: ["serve"], mode: "service" },
  "/loop:install-ollama": { executable: "winget", args: ["install", "--id", "Ollama.Ollama", ...WINGET_CONFIRM], mode: "foreground" },
  "/loop:start-ollama": { executable: "ollama", args: ["serve"], mode: "service" },
  "/loop:install-browser": { executable: "npx", args: ["--yes", "playwright@1.51.1", "install", "chromium"], mode: "foreground", timeoutMs: 15 * 60_000 },
  "/opencode:install-opencode": { executable: "npm", args: ["install", "-g", "opencode-ai@1.18.16"], mode: "foreground", timeoutMs: 15 * 60_000 },
  "/video:install-ffmpeg": { executable: "winget", args: ["install", "--id", "Gyan.FFmpeg", ...WINGET_CONFIRM], mode: "foreground" },
  "/openmontage:install-python": { executable: "winget", args: ["install", "--id", "Python.Python.3.12", ...WINGET_CONFIRM], mode: "foreground" },
  "/openmontage:install-ffmpeg": { executable: "winget", args: ["install", "--id", "Gyan.FFmpeg", ...WINGET_CONFIRM], mode: "foreground" },
  "/video-use:install-ffmpeg": { executable: "winget", args: ["install", "--id", "Gyan.FFmpeg", ...WINGET_CONFIRM], mode: "foreground" },
  "/apps:install-python": { executable: "winget", args: ["install", "--id", "Python.Python.3.12", ...WINGET_CONFIRM], mode: "foreground" },
  "/thumbnails:install-python": { executable: "winget", args: ["install", "--id", "Python.Python.3.12", ...WINGET_CONFIRM], mode: "foreground" },
  "/thumbnails:install-pillow": { executable: "py", args: ["-m", "pip", "install", "--user", "Pillow==12.3.0"], mode: "foreground" },
  "/notebook:install-notebooklm": { executable: "uv", args: ["tool", "install", "notebooklm-mcp-cli==0.9.8"], mode: "foreground" },
  "/omniroute:install-omniroute": { executable: "npm", args: ["install", "-g", "omniroute@3.8.49"], mode: "foreground", timeoutMs: 15 * 60_000 },
  "/omniroute:start-omniroute": { executable: "omniroute", args: [], mode: "service" },
};

export class SetupRuntimeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SetupRuntimeError";
  }
}

function diagnostic(
  id: string,
  label: string,
  ok: boolean,
  readyMessage: string,
  missingMessage: string,
  options: {
    impact?: SetupDiagnostic["impact"];
    alternativeGroup?: string;
    evidence?: SetupDiagnostic["evidence"];
  } = {},
): SetupDiagnostic {
  const message = ok ? readyMessage : missingMessage;
  return {
    id,
    label,
    status: ok ? "ready" : "missing",
    message,
    detail: message,
    impact: options.impact ?? "required",
    ...(options.alternativeGroup ? { alternativeGroup: options.alternativeGroup } : {}),
    evidence: options.evidence ?? "verified",
  };
}

function warning(
  id: string,
  label: string,
  message: string,
  options: { impact?: SetupDiagnostic["impact"]; evidence?: SetupDiagnostic["evidence"] } = {},
): SetupDiagnostic {
  return {
    id,
    label,
    status: "warning",
    message,
    detail: message,
    impact: options.impact ?? "required",
    evidence: options.evidence ?? "configured",
  };
}

function computeReadiness(diagnostics: SetupDiagnostic[]): SetupReadiness {
  const missingRequired = diagnostics.filter((item) => item.impact === "required" && item.status !== "ready");
  const alternativeGroups = new Map<string, SetupDiagnostic[]>();
  for (const item of diagnostics) {
    if (item.impact !== "alternative") continue;
    const group = item.alternativeGroup || "default";
    alternativeGroups.set(group, [...(alternativeGroups.get(group) ?? []), item]);
  }
  const missingAlternatives = [...alternativeGroups.values()]
    .filter((items) => !items.some((item) => item.status === "ready"))
    .flat();
  const blockers = [...missingRequired, ...missingAlternatives];
  if (blockers.length > 0) {
    return {
      ready: false,
      level: "missing",
      reason: [...new Set(blockers.map((item) => item.message).filter(Boolean))].slice(0, 2).join(" "),
    };
  }

  const optionalMissing = diagnostics.filter((item) => item.impact === "optional" && item.status !== "ready");
  if (optionalMissing.length > 0) {
    return {
      ready: true,
      level: "partial",
      reason: `יכולת הליבה זמינה; ${optionalMissing.length} חיבורים אופציונליים עדיין חסרים.`,
    };
  }

  const satisfied = diagnostics.filter((item) => item.status === "ready" && item.impact !== "optional");
  const verified = satisfied.length > 0 && satisfied.every((item) => item.evidence === "verified");
  return {
    ready: true,
    level: verified ? "verified" : "configured",
    reason: verified ? "כל דרישות הליבה אומתו בבדיקה מקומית." : "כל דרישות הליבה מוגדרות; חיבורי חשבון לא הפעילו בקשת תוכן.",
  };
}

async function isFile(candidate: string | null | undefined): Promise<boolean> {
  if (!candidate) return false;
  try { return (await stat(candidate)).isFile(); } catch { return false; }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try { return (await stat(candidate)).isDirectory(); } catch { return false; }
}

async function readText(file: string): Promise<string> {
  try { return await readFile(file, "utf8"); } catch { return ""; }
}

async function envFileHas(file: string, names: readonly string[]): Promise<boolean> {
  const text = await readText(file);
  return names.some((name) => new RegExp(`^${name}=.+$`, "m").test(text));
}

async function activeProfile(): Promise<string> {
  return resolveHermesProfile();
}

async function activeProfileEnv(): Promise<string> {
  return legacyActiveProfileEnv();
}

async function legacyActiveProfile(): Promise<string> {
  const marker = (await readText(path.join(hermesHome(), "active_profile"))).trim();
  return marker || process.env.HERMES_PROFILE?.trim() || "main";
}

async function legacyActiveProfileEnv(): Promise<string> {
  return path.join(hermesHome(), "profiles", await legacyActiveProfile(), ".env");
}

async function hasOpenRouterKey(profile?: "active" | "fusion" | "north-mini"): Promise<boolean> {
  if (process.env.OPENROUTER_API_KEY?.trim()) return true;
  const active = await activeProfile();
  const profiles = profile === "fusion"
    ? ["fusion"]
    : profile === "north-mini"
      ? ["north-mini"]
      : [active, "julian", "fusion"];
  const files = [
    ...profiles.map((name) => hermesProfileEnvPath(name)),
    await legacyActiveProfileEnv(),
    path.join(hermesHome(), ".env"),
    FCC_ENV,
  ];
  for (const file of files) if (await envFileHas(file, ["OPENROUTER_API_KEY"])) return true;
  return false;
}

async function hasJsonCredential(files: string[], fragments: string[]): Promise<boolean> {
  for (const file of files) {
    const text = await readText(file);
    if (!text) continue;
    try {
      const json = JSON.parse(text);
      const flat = JSON.stringify(json).toLowerCase();
      if (fragments.some((fragment) => flat.includes(fragment.toLowerCase()))) return true;
    } catch { /* invalid auth file is treated as absent */ }
  }
  return false;
}

function executableNames(base: string): string[] {
  return process.platform === "win32"
    ? [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base]
    : [base];
}

async function findExecutable(base: string, extra: string[] = []): Promise<string | null> {
  const candidates = [...extra];
  if (path.isAbsolute(base)) {
    candidates.push(...executableNames(base));
  } else {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      for (const name of executableNames(base)) candidates.push(path.join(dir.replace(/^"|"$/g, ""), name));
    }
  }
  for (const candidate of candidates) {
    if (!(await isFile(candidate))) continue;
    try { await access(candidate, fsConstants.R_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        env: process.env,
        windowsHide: true,
        stdio: "ignore",
        shell: false,
      });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  try { child.kill("SIGKILL"); } catch { /* already stopped */ }
}

async function commandSucceeds(base: string, args: readonly string[], timeoutMs = 4000): Promise<boolean> {
  const executable = await findExecutable(base);
  if (!executable) return false;
  let invocation: { command: string; args: string[] };
  try { invocation = spawnInvocation(executable, args); } catch { return false; }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(invocation.command, invocation.args, {
      env: setupChildEnv(),
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    const timer = setTimeout(() => {
      void terminateProcessTree(child).finally(() => finish(false));
    }, timeoutMs);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

async function hasPlaywrightBrowser(): Promise<boolean> {
  const root = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "ms-playwright")
    : path.join(HOME, "Library", "Caches", "ms-playwright");
  try {
    const builds = await readdir(root, { withFileTypes: true });
    for (const build of builds) {
      if (!build.isDirectory() || !/^(chromium|chrome-headless-shell)-/i.test(build.name)) continue;
      const base = path.join(root, build.name);
      const candidates = process.platform === "win32"
        ? [path.join(base, "chrome-win", "chrome.exe"), path.join(base, "chrome-headless-shell-win64", "chrome-headless-shell.exe")]
        : [path.join(base, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"), path.join(base, "chrome-headless-shell-mac", "chrome-headless-shell")];
      if ((await Promise.all(candidates.map(isFile))).some(Boolean)) return true;
    }
  } catch { /* no Playwright cache */ }
  if (process.platform === "win32") {
    return isFile(path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"));
  }
  return false;
}

async function readAgenticConfig(): Promise<Record<string, unknown>> {
  const text = await readText(AGENTIC_CONFIG);
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

async function readAgenticConfigForWrite(): Promise<Record<string, unknown>> {
  const text = await readText(AGENTIC_CONFIG);
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SetupRuntimeError("Agent OS config is not a JSON object; fix it before saving a CLI path.", 409);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SetupRuntimeError) throw error;
    throw new SetupRuntimeError("Agent OS config is invalid JSON; fix it before saving a CLI path.", 409);
  }
}

type SetupCliConfigKey = "claude" | "openclaw" | "hermes" | "antigravity" | "codex" | "kimi" | "grok" | "ruflo" | "opencode" | "nlmBin";

async function cliAvailability(
  key: SetupCliConfigKey,
  command: string,
  runtimeValue: string | null,
  extras: string[] = [],
): Promise<{ usable: boolean; savedForRestart: boolean }> {
  const runtimeConfigured = await isFile(runtimeValue);
  const discovered = Boolean(await findExecutable(command, extras));
  const persisted = await readAgenticConfig();
  const persistedPath = typeof persisted[key] === "string" ? persisted[key] as string : null;
  const persistedConfigured = await isFile(persistedPath);
  return {
    usable: runtimeConfigured || discovered,
    savedForRestart: persistedConfigured && !runtimeConfigured && !discovered,
  };
}

async function localFetch(url: string, headers?: Record<string, string>, timeoutMs = 1800): Promise<Response | null> {
  try {
    return await fetch(url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { return null; }
}

async function cliDiagnostics(
  key: SetupCliConfigKey,
  command: string,
  label: string,
  runtimeValue: string | null,
  extras: string[] = [],
): Promise<SetupDiagnostic[]> {
  const state = await cliAvailability(key, command, runtimeValue, extras);
  if (state.savedForRestart) {
    return [warning("cli", label, "נתיב CLI נשמר, אך Agent OS חייב restart לפני שניתן להשתמש בו.")];
  }
  return [diagnostic(
    "cli", label, state.usable,
    "קובץ CLI קיים ונגיש לתהליך הנוכחי.",
    "CLI לא נמצא. ניתן לבחור קובץ קיים או לפעול לפי המדריך.",
  )];
}

async function credentialDiagnostic(
  id: string,
  label: string,
  present: Promise<boolean> | boolean,
): Promise<SetupDiagnostic[]> {
  return [diagnostic(id, label, await present, "Credential מוגדר מקומית.", "Credential עדיין לא מוגדר.", { evidence: "configured" })];
}

async function jsonFileHasContent(file: string): Promise<boolean> {
  const text = await readText(file);
  if (!text) return false;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object") return false;
    return Array.isArray(value) ? value.length > 0 : Object.keys(value as Record<string, unknown>).length > 0;
  } catch {
    return false;
  }
}

async function openClawConfiguration(): Promise<{ configured: boolean; gatewayReachable: boolean }> {
  const root = path.join(HOME, ".openclaw");
  const configFile = path.join(root, "openclaw.json");
  const text = await readText(configFile);
  let configured = false;
  let port = 18789;
  try {
    const value = JSON.parse(text) as {
      gateway?: { port?: unknown };
      agents?: { defaults?: unknown };
    };
    configured = Boolean(value && typeof value === "object" && value.agents?.defaults);
    if (Number.isInteger(value.gateway?.port) && Number(value.gateway?.port) > 0 && Number(value.gateway?.port) < 65536) {
      port = Number(value.gateway?.port);
    }
  } catch { /* malformed configuration is not ready */ }
  const gatewayReachable = Boolean(await localFetch(`http://127.0.0.1:${port}/`, undefined, 1200));
  return { configured, gatewayReachable };
}

async function ollamaModelState(): Promise<{ up: boolean; modelCount: number; localRouteReady: boolean }> {
  const [tagsResponse, psResponse] = await Promise.all([
    localFetch("http://127.0.0.1:11434/api/tags", undefined, 1500),
    localFetch("http://127.0.0.1:11434/api/ps", undefined, 1500),
  ]);
  if (!tagsResponse?.ok) return { up: false, modelCount: 0, localRouteReady: false };
  let names: string[] = [];
  let warm = false;
  try {
    const payload = await tagsResponse.json() as { models?: Array<{ name?: string; model?: string }> };
    names = (payload.models ?? []).map((item) => item.name || item.model || "").filter(Boolean);
  } catch { /* malformed model list remains empty */ }
  if (psResponse?.ok) {
    try {
      const payload = await psResponse.json() as { models?: unknown[] };
      warm = Array.isArray(payload.models) && payload.models.length > 0;
    } catch { /* malformed process list */ }
  }
  const fallbackPresent = names.some((name) => name === FALLBACK_MODEL || name.startsWith(`${FALLBACK_MODEL}:`));
  return { up: true, modelCount: names.length, localRouteReady: warm || fallbackPresent };
}

async function hermesProviderConfigured(): Promise<boolean> {
  const profile = await activeProfile();
  const authFiles = [
    path.join(hermesHome(), "profiles", profile, "auth.json"),
    path.join(hermesHome(), "auth.json"),
  ];
  const envFiles = [hermesProfileEnvPath(profile), path.join(hermesHome(), ".env")];
  const auth = await hasJsonCredential(authFiles, ["codex", "nous", "oauth", "api_key", "access_token", "token"]);
  if (auth) return true;
  const providerKeys = [
    "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GLM_API_KEY",
    "KIMI_API_KEY", "MINIMAX_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY",
  ];
  for (const file of envFiles) if (await envFileHas(file, providerKeys)) return true;
  return false;
}

async function higgsfieldLiveState(profile: string): Promise<{ authenticated: boolean; tools: number }> {
  const result = await run("hermes", hermesCliArgs(profile, ["mcp", "test", "higgsfield"]), { timeoutMs: 15_000 });
  const output = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const unauthorized = /401|unauthor|not authenticated|no cached tokens|login/i.test(output);
  const names = (output.match(/^\s{2,}[a-z][a-z0-9_]{2,}\s{2,}\S/gm) ?? [])
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => !["Testing", "Transport", "Auth"].includes(name));
  const tools = new Set(names).size;
  return { authenticated: result.ok && !unauthorized && tools > 0, tools };
}

async function diagnosticsFor(route: SetupRoute): Promise<SetupDiagnostic[]> {
  switch (route) {
    case "/claude": {
      const [cli, auth] = await Promise.all([
        cliDiagnostics("claude", "claude", "Claude Code CLI", config.claude),
        Boolean(process.env.ANTHROPIC_API_KEY)
          || jsonFileHasContent(path.join(HOME, ".claude", ".credentials.json")),
      ]);
      return [
        ...cli,
        diagnostic("auth", "Claude authentication", auth, "נמצא login מקומי של Claude.", "Claude מותקן אך לא נמצא login. הרץ claude login.", { evidence: "configured" }),
      ];
    }
    case "/openclaw": {
      const [cli, state, provider] = await Promise.all([
        cliDiagnostics("openclaw", "openclaw", "OpenClaw CLI", config.openclaw),
        openClawConfiguration(),
        jsonFileHasContent(path.join(HOME, ".openclaw", "agents", config.openclawAgent, "agent", "models.json")),
      ]);
      return [
        ...cli,
        diagnostic("config", "OpenClaw onboarding", state.configured, "קובץ onboarding תקין קיים.", "OpenClaw טרם השלים onboarding או שה-config פגום.", { evidence: "configured" }),
        diagnostic("provider", "OpenClaw provider", provider, "נמצאה הגדרת provider עבור הסוכן הפעיל.", "לא נמצאה הגדרת provider עבור הסוכן הפעיל.", { evidence: "configured" }),
        diagnostic("gateway", "Gateway service", state.gatewayReachable, "ה-Gateway המקומי מגיב.", "ה-Gateway אינו פעיל; local chat עדיין יכול לעבוד.", { impact: "optional" }),
      ];
    }
    case "/hermes": {
      const [cli, provider] = await Promise.all([
        cliDiagnostics("hermes", "hermes", "Hermes CLI", config.hermes),
        hermesProviderConfigured(),
      ]);
      return [
        ...cli,
        diagnostic("provider", "Active Hermes provider", provider, "לפרופיל הפעיל יש provider או credential מקומי.", "Hermes מותקן אך אין provider מחובר בפרופיל הפעיל.", { evidence: "configured" }),
      ];
    }
    case "/codex": {
      const [cli, auth] = await Promise.all([
        cliDiagnostics("codex", "codex", "Codex CLI", config.codex),
        jsonFileHasContent(path.join(HOME, ".codex", "auth.json")),
      ]);
      return [
        ...cli,
        diagnostic("auth", "OpenAI login", auth, "נמצא Codex login מקומי.", "Codex מותקן אך לא נמצא login. הרץ codex login.", { evidence: "configured" }),
      ];
    }
    case "/freeclaude": {
      const [cli, state] = await Promise.all([
        cliDiagnostics("claude", "claude", "Claude Code CLI", config.claude),
        getFreeClaudeState(),
      ]);
      return [
        ...cli,
        diagnostic("enabled", "Free router selection", state.enabled, "Free Claude מופעל ב-Agent OS.", "Free Claude כבוי בהגדרות המקומיות.", { evidence: "configured" }),
        diagnostic("gateway", state.router === "9router" ? "9Router gateway" : "OmniRoute gateway", state.reachable, "ה-gateway הפעיל מחזיר רשימת מודלים.", "ה-gateway הפעיל אינו מחזיר רשימת מודלים תקינה."),
      ];
    }
    case "/glm-code": {
      const [codexCli, claudeCli, codexAuth, kimiAuth, qoder, glmState] = await Promise.all([
        cliAvailability("codex", "codex", config.codex),
        cliAvailability("claude", "claude", config.claude),
        jsonFileHasContent(path.join(HOME, ".codex", "auth.json")),
        jsonFileHasContent(path.join(HOME, ".kimi-code", "credentials", "kimi-code.json")),
        findExecutable("qoder-qwen"),
        getGlmCodeState(),
      ]);
      return [
        diagnostic("gpt-engine", "GPT 5.6 engine", codexCli.usable && codexAuth, "Codex CLI ו-ChatGPT login זמינים.", "מנוע GPT דורש Codex CLI ו-codex login.", { impact: "alternative", alternativeGroup: "coding-engine", evidence: "configured" }),
        diagnostic("glm-engine", "GLM 5.2 engine", claudeCli.usable && glmState.ollamaUp, "Claude CLI ו-Ollama bridge זמינים.", "מנוע GLM דורש Claude CLI ושירות Ollama פעיל.", { impact: "alternative", alternativeGroup: "coding-engine", evidence: "configured" }),
        diagnostic("kimi-engine", "Kimi K3 engine", claudeCli.usable && kimiAuth, "Claude CLI ו-Kimi coding login זמינים.", "מנוע Kimi K3 דורש Claude CLI ו-Kimi login.", { impact: "alternative", alternativeGroup: "coding-engine", evidence: "configured" }),
        diagnostic("qoder-engine", "Qoder engine", Boolean(qoder), "Qoder wrapper נמצא.", "Qoder wrapper אינו מותקן.", { impact: "alternative", alternativeGroup: "coding-engine", evidence: "configured" }),
      ];
    }
    case "/local": {
      const ollama = await ollamaModelState();
      const [maple, openAiLocal] = await Promise.all([
        localFetch(`${MAPLE_BASE.replace(/\/+$/, "")}/models`, undefined, 1500),
        LOCAL_OPENAI_BASE && LOCAL_OPENAI_MODEL
          ? localFetch(`${LOCAL_OPENAI_BASE.replace(/\/+$/, "")}/models`, undefined, 1500)
          : Promise.resolve(null),
      ]);
      return [
        diagnostic("ollama-engine", "Ollama local engine", ollama.localRouteReady, "Ollama פעיל והמודל שבו Local משתמש זמין.", ollama.up ? "Ollama פעיל, אך אין מודל warm או fallback מותקן." : "Ollama אינו פעיל.", { impact: "alternative", alternativeGroup: "local-engine" }),
        diagnostic("maple-engine", "Maple local engine", Boolean(maple?.ok), "Maple MLX מגיב מקומית.", "Maple MLX אינו פעיל.", { impact: "alternative", alternativeGroup: "local-engine" }),
        diagnostic("openai-local", "OpenAI-compatible local engine", Boolean(openAiLocal?.ok), "השרת המקומי המוגדר מגיב.", "לא מוגדר שרת local OpenAI-compatible פעיל.", { impact: "alternative", alternativeGroup: "local-engine" }),
      ];
    }
    case "/engine": {
      const [cli, profile, ollama] = await Promise.all([
        cliDiagnostics("hermes", "hermes", "Hermes CLI", config.hermes),
        isFile(path.join(hermesHome(), "profiles", "local", "config.yaml")),
        ollamaModelState(),
      ]);
      return [
        ...cli,
        diagnostic("profile", "Hermes local profile", profile, "הפרופיל local קיים.", "Hermes profile בשם local חסר.", { evidence: "configured" }),
        diagnostic("ollama", "Local model service", ollama.up && ollama.modelCount > 0, "Ollama מגיב ולפחות מודל אחד מותקן.", ollama.up ? "Ollama פעיל, אך אין מודל מותקן." : "Ollama אינו פעיל."),
      ];
    }
    case "/ruflo": {
      const [cli, state] = await Promise.all([
        cliDiagnostics("ruflo", "ruflo", "Ruflo CLI", config.ruflo),
        isDirectory(process.env.AGENTIC_OS_CLAUDEFLOW || path.join(HOME, ".claude-flow")),
      ]);
      return [
        ...cli,
        diagnostic("state", "Ruflo state", state, "Ruflo state directory קיים.", "Ruflo CLI טרם אותחל; הרץ ruflo init בפרויקט המתאים.", { evidence: "configured" }),
      ];
    }
    case "/higgsfield": {
      const [cli, resolution] = await Promise.all([
        cliDiagnostics("hermes", "hermes", "Hermes CLI", config.hermes),
        resolveHiggsfieldProfile(),
      ]);
      const live = resolution.registered
        ? await higgsfieldLiveState(resolution.profile)
        : { authenticated: false, tools: 0 };
      return [
        ...cli,
        diagnostic("registration", "Higgsfield MCP registration", resolution.registered, `Higgsfield רשום בפרופיל ${resolution.profile}.`, "Higgsfield MCP אינו רשום בפרופיל Hermes."),
        diagnostic("oauth", "Higgsfield OAuth and tools", live.authenticated, `OAuth פעיל ו-${live.tools} כלים זמינים.`, "Higgsfield רשום אך OAuth או רשימת הכלים אינם זמינים."),
      ];
    }
    case "/antigravity":
      return cliDiagnostics("antigravity", "agy", "Antigravity CLI", config.antigravity);
    case "/kimi": {
      const [cli, auth] = await Promise.all([
        cliDiagnostics("kimi", "kimi", "Kimi CLI", config.kimi, [
          path.join(HOME, ".kimi-code", "bin", process.platform === "win32" ? "kimi.exe" : "kimi"),
        ]),
        jsonFileHasContent(path.join(HOME, ".kimi-code", "credentials", "kimi-code.json")),
      ]);
      return [...cli, diagnostic("auth", "Kimi login", auth, "נמצא Kimi login מקומי.", "Kimi CLI טרם התחבר. הרץ kimi login.", { evidence: "configured" })];
    }
    case "/grok": {
      const [cli, authJson, credentialsJson] = await Promise.all([
        cliDiagnostics("grok", "grok", "Grok CLI", config.grok, [
          path.join(HOME, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok"),
        ]),
        jsonFileHasContent(path.join(HOME, ".grok", "auth.json")),
        jsonFileHasContent(path.join(HOME, ".grok", "credentials.json")),
      ]);
      return [...cli, diagnostic("auth", "Grok device login", authJson || credentialsJson, "נמצא Grok device login מקומי.", "Grok CLI טרם התחבר. הרץ grok login --device-auth.", { evidence: "configured" })];
    }
    case "/notebook": {
      const [cli, cookies, metadata] = await Promise.all([
        cliDiagnostics("nlmBin", "notebooklm-mcp", "NotebookLM MCP", config.nlmBin),
        jsonFileHasContent(path.join(HOME, ".notebooklm-mcp-cli", "profiles", "default", "cookies.json")),
        jsonFileHasContent(path.join(HOME, ".notebooklm-mcp-cli", "profiles", "default", "metadata.json")),
      ]);
      return [...cli, diagnostic("auth", "NotebookLM login", cookies && metadata, "נמצא NotebookLM browser login מקומי.", "NotebookLM מותקן אך לא נמצא login. הרץ nlm login.", { evidence: "configured" })];
    }
    case "/jcode": {
      const integrationFile = path.join(HOME, ".local", "bin", "jcode");
      const expected = await isFile(integrationFile);
      const elsewhere = Boolean(await findExecutable("jcode"));
      const out = [diagnostic("cli", "jcode integration", expected, "jcode נמצא במיקום שה-integration קורא.", "jcode אינו נמצא במיקום שה-integration קורא.")];
      if (!expected && elsewhere) out.push(warning("path-mismatch", "CLI path", "jcode נמצא ב-PATH, אך ה-integration הנוכחי מצפה למיקום אחר."));
      return out;
    }
    case "/opencode": {
      const executable = process.platform === "win32" ? "opencode.exe" : "opencode";
      let cli = await cliDiagnostics("opencode", "opencode", "OpenCode CLI", config.opencode, [
        path.join(HOME, ".opencode", "bin", executable),
        path.join(HOME, ".local", "bin", executable),
        ...(process.platform === "win32"
          ? [
              path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "npm", "opencode.cmd"),
              path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "Microsoft", "WinGet", "Links", "opencode.exe"),
            ]
          : ["/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"]),
      ]);
      const runtimeState = getOpenCodeState();
      const discoveredReady = cli.some((item) => item.id === "cli" && item.status === "ready");
      if (!runtimeState.ready && discoveredReady) {
        cli = [diagnostic(
          "cli",
          "OpenCode CLI",
          false,
          "OpenCode CLI קיים וניתן להרצה.",
          "נמצא OpenCode CLI במסלול חלופי, אך ה-runtime אינו יכול להריץ את config.opencode הנוכחי. חבר את הקובץ הנכון או בצע restart לאחר שמירת הנתיב.",
        )];
      }
      return [...cli, diagnostic(
        "omniroute-provider",
        "OmniRoute provider",
        omniRouteProviderConfigured(),
        "OmniRoute מוגדר כ-provider אמיתי ב-OpenCode.",
        "OmniRoute עדיין לא נוסף ל-config של OpenCode; המודלים שלו לא יוצגו.",
        { impact: "optional", evidence: "configured" },
      )];
    }
    case "/glm":
      return credentialDiagnostic("credential", "GLM key", Boolean(process.env.GLM_API_KEY || process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY)
        || envFileHas(hermesProfileEnvPath("glm-5-2"), ["GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"]));
    case "/hy3-coder":
      return credentialDiagnostic("credential", "OpenRouter key", hasOpenRouterKey());
    case "/muse-code":
      return credentialDiagnostic("credential", "OpenRouter key", Boolean(process.env.OPENROUTER_API_KEY) || envFileHas(path.join(hermesHome(), ".env"), ["OPENROUTER_API_KEY"]));
    case "/room":
      return credentialDiagnostic("credential", "OpenRouter key", Boolean(process.env.OPENROUTER_API_KEY) || envFileHas(await legacyActiveProfileEnv(), ["OPENROUTER_API_KEY"]));
    case "/fusion":
      return credentialDiagnostic("credential", "OpenRouter key", hasOpenRouterKey("fusion"));
    case "/deepseek-coder":
      return credentialDiagnostic("credential", "DeepSeek key", Boolean(process.env.DEEPSEEK_API_KEY)
        || envFileHas(FCC_ENV, ["DEEPSEEK_API_KEY"])
        || envFileHas(path.join(hermesHome(), ".env"), ["DEEPSEEK_API_KEY"]));
    case "/sakana":
      return credentialDiagnostic("credential", "Sakana key", Boolean(process.env.SAKANA_API_KEY)
        || envFileHas(hermesProfileEnvPath("sakana-fugu"), ["SAKANA_API_KEY"])
        || envFileHas(path.join(hermesHome(), ".env"), ["SAKANA_API_KEY"]));
    case "/paperclip": {
      const [paperclip, probe] = await Promise.all([getPaperclipConfig(), probePaperclipCompany()]);
      return [
        diagnostic("company", "Company configuration", Boolean(paperclip.companyId), "Company id מוגדר ונקרא דינמית.", "Company id אינו מוגדר.", { evidence: "configured" }),
        diagnostic("server", "Paperclip server", probe.serverReachable, "שרת Paperclip מגיב.", "שרת Paperclip אינו מגיב בכתובת המוגדרת."),
        diagnostic("company-endpoint", "Selected company", probe.companyReachable, "ה-company המוגדר אומת מול Paperclip.", "ה-company המוגדר אינו קיים או אינו נגיש בשרת."),
      ];
    }
    case "/loop": {
      const profile = await activeProfile();
      const authFiles = [path.join(hermesHome(), "profiles", profile, "auth.json"), path.join(hermesHome(), "auth.json")];
      const [openrouter, nous, minimax, ollama] = await Promise.all([
        hasOpenRouterKey(),
        hasJsonCredential(authFiles, ["nous"]),
        hasJsonCredential(authFiles, ["minimax"]),
        localFetch("http://127.0.0.1:11434/api/tags"),
      ]);
      const browser = await hasPlaywrightBrowser();
      return [
        diagnostic("builder", "Builder credentials", openrouter || nous || minimax, "לפחות builder אחד מוגדר.", "לא נמצא builder מחובר.", { evidence: "configured" }),
        diagnostic("judge", "Local judge", Boolean(ollama?.ok), "Ollama המקומי מגיב.", "Ollama המקומי אינו מגיב."),
        diagnostic("browser", "Browser runtime", browser, "נמצא browser runtime מקומי.", "לא נמצא browser runtime נתמך."),
      ];
    }
    case "/opendesign": {
      const repo = await isFile(path.join(HOME, "open-design", "package.json"));
      const [daemon, web] = await Promise.all([
        localFetch("http://127.0.0.1:7455/api/health"),
        localFetch("http://127.0.0.1:7456/"),
      ]);
      return [
        diagnostic("repo", "Open Design repository", repo, "ה-repository המקומי קיים.", "ה-repository המקומי חסר."),
        diagnostic("daemon", "Open Design daemon", Boolean(daemon?.ok), "ה-daemon מגיב.", "ה-daemon אינו מגיב."),
        diagnostic("web", "Open Design web", Boolean(web), "שירות ה-web מגיב.", "שירות ה-web אינו מגיב."),
      ];
    }
    case "/video": {
      const [hyperframes, ffmpeg, heygen, elevenlabs] = await Promise.all([
        findExecutable("hyperframes", [path.join(HOME, "local", "node", "bin", "hyperframes")]),
        findExecutable("ffmpeg"),
        envFileHas(path.join(AGENTIC_DIR, "heygen.env"), ["HEYGEN_API_KEY"]),
        Boolean(process.env.ELEVENLABS_API_KEY) || envFileHas(await activeProfileEnv(), ["ELEVENLABS_API_KEY"]),
      ]);
      return [
        diagnostic("hyperframes", "HyperFrames CLI", Boolean(hyperframes), "HyperFrames נמצא.", "HyperFrames חסר."),
        diagnostic("ffmpeg", "ffmpeg", Boolean(ffmpeg), "ffmpeg נמצא.", "ffmpeg חסר."),
        diagnostic("heygen", "HeyGen key", heygen, "HeyGen מחובר מקומית.", "HeyGen key חסר; זהו provider אופציונלי.", { impact: "optional", evidence: "configured" }),
        diagnostic("elevenlabs", "ElevenLabs key", elevenlabs, "ElevenLabs מחובר מקומית.", "ElevenLabs key חסר; זהו provider אופציונלי.", { impact: "optional", evidence: "configured" }),
      ];
    }
    case "/studio": {
      const profile = await activeProfile();
      const authFiles = [path.join(hermesHome(), "profiles", profile, "auth.json"), path.join(hermesHome(), "auth.json")];
      const [minimax, grok, elevenlabs, python] = await Promise.all([
        hasJsonCredential(authFiles, ["minimax"]),
        hasJsonCredential(authFiles, ["xai", "grok"]),
        envFileHas(await activeProfileEnv(), ["ELEVENLABS_API_KEY"]),
        isFile(path.join(hermesHome(), "hermes-agent", ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python")),
      ]);
      const grokReady = grok && python;
      return [
        diagnostic("minimax", "MiniMax OAuth", minimax, "MiniMax credential קיים.", "MiniMax אינו מחובר.", { impact: "alternative", alternativeGroup: "media-provider", evidence: "configured" }),
        diagnostic("grok", "Grok/xAI provider", grokReady, "Grok credential and Hermes Python runtime are available.", grok ? "Grok is connected, but the Hermes Python runtime is missing." : "Grok is not connected.", { impact: "alternative", alternativeGroup: "media-provider", evidence: "configured" }),
        diagnostic("elevenlabs", "ElevenLabs key", elevenlabs, "ElevenLabs מחובר.", "ElevenLabs key חסר.", { impact: "alternative", alternativeGroup: "media-provider", evidence: "configured" }),
        diagnostic("python", "Hermes Python runtime", python, "Python runtime קיים עבור Grok.", "Python runtime חסר; רק מסלול Grok אינו זמין.", { impact: "optional" }),
      ];
    }
    case "/openmontage": {
      const scripts = path.join(hermesHome(), "profiles", "openmontage", "workspace", "scripts");
      const [cinematic, movie, python, ffmpeg, openrouter] = await Promise.all([
        isFile(path.join(scripts, "cinematic_om.py")),
        isFile(path.join(scripts, "movie_om.py")),
        findExecutable(process.platform === "win32" ? "python" : "python3"),
        findExecutable("ffmpeg"),
        hasOpenRouterKey(),
      ]);
      return [
        diagnostic("scripts", "Generation scripts", cinematic && movie, "שני scripts קיימים.", "אחד או יותר מ-scripts ה-generation חסרים."),
        diagnostic("python", "Python", Boolean(python), "Python נמצא.", "Python חסר."),
        diagnostic("ffmpeg", "ffmpeg", Boolean(ffmpeg), "ffmpeg נמצא.", "ffmpeg חסר."),
        diagnostic("credential", "OpenRouter key", openrouter, "OpenRouter מוגדר.", "OpenRouter key חסר.", { evidence: "configured" }),
      ];
    }
    case "/video-use": {
      const [skill, claude, ffmpeg, ffprobe] = await Promise.all([
        isFile(path.join(HOME, ".claude", "skills", "video-use", "SKILL.md")),
        findExecutable("claude"), findExecutable("ffmpeg"), findExecutable("ffprobe"),
      ]);
      return [
        diagnostic("skill", "video-use skill", skill, "ה-skill קיים.", "ה-skill חסר."),
        diagnostic("claude", "Claude CLI", Boolean(claude), "Claude CLI נמצא.", "Claude CLI חסר."),
        diagnostic("ffmpeg", "ffmpeg tools", Boolean(ffmpeg && ffprobe), "ffmpeg ו-ffprobe נמצאו.", "ffmpeg או ffprobe חסרים."),
      ];
    }
    case "/music":
      return credentialDiagnostic("credential", "Suno key", Boolean(process.env.SUNO_API_KEY) || envFileHas(path.join(AGENTIC_DIR, "suno.env"), ["SUNO_API_KEY"]));
    case "/games": {
      const [hermes, db, profile, workspace] = await Promise.all([
        findExecutable("hermes"),
        isFile(path.join(hermesHome(), "kanban.db")),
        isDirectory(path.join(hermesHome(), "profiles", "game-dev")),
        isDirectory(workspacePath("games")),
      ]);
      return [
        diagnostic("hermes", "Hermes CLI", Boolean(hermes), "Hermes CLI נמצא.", "Hermes CLI חסר."),
        diagnostic("database", "Kanban database", db, "Kanban database קיים.", "Kanban database חסר."),
        diagnostic("profile", "game-dev profile", profile, "פרופיל game-dev קיים.", "פרופיל game-dev חסר."),
        diagnostic("workspace", "Games workspace", workspace, "Games workspace קיים.", "Games workspace חסר."),
      ];
    }
    case "/apps": {
      const repo = workspacePath("app-lab", "awesome-llm-apps");
      const adaptations = [
        path.join(repo, "starter_ai_agents", "mixture_of_agents", "free_mixture_of_agents.py"),
        path.join(repo, "rag_tutorials", "llama3.1_local_rag", "free_web_chat.py"),
        path.join(repo, "starter_ai_agents", "ai_travel_agent", "free_travel_agent.py"),
      ];
      const appDirs = adaptations.map((file) => path.dirname(file));
      const [repository, files, venvs, openrouter] = await Promise.all([
        isDirectory(path.join(repo, ".git")),
        Promise.all(adaptations.map(isFile)).then((checks) => checks.every(Boolean)),
        Promise.all(appDirs.map((dir) => isFile(path.join(dir, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python")))).then((checks) => checks.every(Boolean)),
        hasOpenRouterKey("north-mini"),
      ]);
      return [
        diagnostic("repo", "App Lab repository", repository, "ה-repository קיים.", "ה-repository חסר."),
        diagnostic("adaptations", "Allowlisted app files", files, "קובצי ה-app הנדרשים קיימים.", "קובץ app אחד או יותר חסר."),
        diagnostic("venvs", "App virtual environments", venvs, "לכל app קיים Python venv.", "אחד או יותר מה-venvs חסרים."),
        diagnostic("credential", "OpenRouter key", openrouter, "OpenRouter מוגדר לפרופיל App Lab.", "OpenRouter key חסר לפרופיל App Lab.", { evidence: "configured" }),
      ];
    }
    case "/thumbnails": {
      const skill = path.join(HOME, ".claude", "skills", "youtube-thumbnails");
      const [generate, overlay, python, pillow, key] = await Promise.all([
        isFile(path.join(skill, "scripts", "generate.py")),
        isFile(path.join(skill, "scripts", "text_overlay.py")),
        findExecutable(process.platform === "win32" ? "py" : "python3"),
        commandSucceeds(process.platform === "win32" ? "py" : "python3", ["-c", "import PIL"]),
        Boolean(process.env.OPENAI_API_KEY) || envFileHas(path.join(skill, ".env"), ["OPENAI_API_KEY"]),
      ]);
      return [
        diagnostic("scripts", "Thumbnail scripts", generate && overlay, "שני scripts קיימים.", "אחד או יותר מה-scripts חסרים."),
        diagnostic("python", "Python launcher", Boolean(python), "Python נמצא.", "Python חסר."),
        diagnostic("pillow", "Pillow", pillow, "Pillow זמין ל-Python launcher.", "Pillow חסר; התקן אותו מהפעולה המוצגת."),
        diagnostic("credential", "OpenAI key", key, "OpenAI key מוגדר ל-skill.", "OpenAI key חסר.", { evidence: "configured" }),
      ];
    }
    case "/leads": {
      const env = await activeProfileEnv();
      const [hunter, apollo, openrouter] = await Promise.all([
        Boolean(process.env.HUNTER_API_KEY) || envFileHas(env, ["HUNTER_API_KEY"]) || envFileHas(FCC_ENV, ["HUNTER_API_KEY"]),
        Boolean(process.env.APOLLO_API_KEY) || envFileHas(env, ["APOLLO_API_KEY"]) || envFileHas(FCC_ENV, ["APOLLO_API_KEY"]),
        hasOpenRouterKey(),
      ]);
      return [
        diagnostic("csv", "CSV workflow", true, "ייבוא CSV והכנת candidates זמינים מקומית.", "מסלול CSV אינו זמין."),
        diagnostic("hunter", "Hunter key", hunter, "Hunter מוגדר.", "Hunter key חסר; enrichment אופציונלי.", { impact: "optional", evidence: "configured" }),
        diagnostic("apollo", "Apollo key", apollo, "Apollo מוגדר.", "Apollo key חסר; enrichment אופציונלי.", { impact: "optional", evidence: "configured" }),
        diagnostic("model", "OpenRouter scoring", openrouter, "Scoring model מחובר.", "OpenRouter key חסר; AI scoring אופציונלי.", { impact: "optional", evidence: "configured" }),
      ];
    }
    case "/omniroute": {
      const response = await localFetch(`${OMNIROUTE_BASE}/v1/models`, omnirouteRequestHeaders(), 3000);
      let models = 0;
      if (response?.ok) {
        try {
          const payload = await response.json() as { data?: unknown[]; models?: unknown[] };
          models = Array.isArray(payload.data) ? payload.data.length : Array.isArray(payload.models) ? payload.models.length : 0;
        } catch { /* malformed response */ }
      }
      return [diagnostic("gateway", "OmniRoute gateway", Boolean(response?.ok && models > 0), "ה-gateway מגיב ומחזיר מודלים.", "ה-gateway אינו מגיב עם רשימת מודלים תקינה.")];
    }
  }
}

function installRootCandidates(): string[] {
  return [path.resolve(process.cwd(), "install"), path.resolve(process.cwd(), "..", "install")];
}

async function readGuide(entry: SetupCatalogEntry): Promise<string | null> {
  if (!/^[0-9]+-[A-Z0-9-]+\.md$/.test(entry.guide.docId)) return null;
  for (const root of installRootCandidates()) {
    const file = path.join(root, entry.guide.docId);
    try {
      const value = await readFile(file, "utf8");
      if (Buffer.byteLength(value, "utf8") <= 128_000) return value.replace(/\r\n/g, "\n");
    } catch { /* try the next fixed install root */ }
  }
  return null;
}

async function buildSetupState(): Promise<SetupGetResponse> {
  const entries: SetupEntryState[] = await Promise.all(SETUP_CATALOG.map(async (entry) => {
    let diagnostics: SetupDiagnostic[];
    try {
      diagnostics = await diagnosticsFor(entry.route);
    } catch (error) {
      console.error(`[setup] readiness check failed for ${entry.route}`, error);
      diagnostics = [{
        id: "diagnostic-error",
        label: "Readiness check",
        status: "error",
        message: "בדיקת הזמינות של השירות נכשלה. נסה שוב או פתח את המדריך.",
        detail: "שאר השירותים ממשיכים להיבדק; הכשל מבודד לרכיב זה בלבד.",
        impact: "required",
        evidence: "verified",
      }];
    }
    return {
      ...entry,
      diagnostics,
      readiness: computeReadiness(diagnostics),
      guideMarkdown: await readGuide(entry),
    };
  }));
  return { version: 1, checkedAt: new Date().toISOString(), entries };
}

export async function getSetupState(): Promise<SetupGetResponse> {
  if (setupStateInFlight) return setupStateInFlight;

  const current = buildSetupState();
  setupStateInFlight = current;
  try {
    return await current;
  } finally {
    if (setupStateInFlight === current) setupStateInFlight = null;
  }
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeFile(temp, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { await chmod(temp, 0o600); } catch { /* best effort on Windows */ }
  try {
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch { /* best-effort temp cleanup */ }
    throw error;
  }
}

async function withFileWriteLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const prior = fileWriteTails.get(file) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.catch(() => undefined).then(() => gate);
  fileWriteTails.set(file, tail);
  await prior.catch(() => undefined);
  try {
    return await task();
  } finally {
    release?.();
    if (fileWriteTails.get(file) === tail) fileWriteTails.delete(file);
  }
}

async function updateEnvAtomic(file: string, updates: Record<string, string>): Promise<void> {
  await withFileWriteLock(file, async () => {
    const lines = (await readText(file)).split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ""));
    for (const [name, value] of Object.entries(updates)) {
      const index = lines.findIndex((line) => line.startsWith(`${name}=`));
      if (index >= 0) lines[index] = `${name}=${value}`;
      else lines.push(`${name}=${value}`);
    }
    await atomicWrite(file, `${lines.join("\n").replace(/\n+$/, "")}\n`);
  });
}

async function updateAgenticConfig(key: string, value: string): Promise<void> {
  await withFileWriteLock(AGENTIC_CONFIG, async () => {
    const current = await readAgenticConfigForWrite();
    current[key] = value;
    await atomicWrite(AGENTIC_CONFIG, `${JSON.stringify(current, null, 2)}\n`);
  });
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function connectOpenCodeOmniRoute(): Promise<boolean> {
  let changed = false;
  await withFileWriteLock(OPENCODE_CONFIG, async () => {
    const text = await readText(OPENCODE_CONFIG);
    let root: Record<string, unknown> = {};
    if (text.trim()) {
      try {
        const parsed = plainRecord(JSON.parse(text));
        if (!parsed) throw new SetupRuntimeError("OpenCode config must be a JSON object.", 409);
        root = parsed;
      } catch (error) {
        if (error instanceof SetupRuntimeError) throw error;
        throw new SetupRuntimeError("OpenCode config is invalid JSON; Setup did not overwrite it.", 409);
      }
    }

    if (!("$schema" in root)) {
      root.$schema = "https://opencode.ai/config.json";
      changed = true;
    }

    let providers = plainRecord(root.provider);
    if (root.provider !== undefined && !providers) {
      throw new SetupRuntimeError("OpenCode config.provider is not an object; Setup did not overwrite it.", 409);
    }
    if (!providers) {
      providers = {};
      root.provider = providers;
      changed = true;
    }

    let provider = plainRecord(providers.omniroute);
    if (providers.omniroute !== undefined && !provider) {
      throw new SetupRuntimeError("OpenCode provider.omniroute is not an object; Setup did not overwrite it.", 409);
    }
    if (!provider) {
      provider = {};
      providers.omniroute = provider;
      changed = true;
    }

    if (provider.npm !== undefined && provider.npm !== OMNIROUTE_OPENCODE_PROVIDER.npm) {
      throw new SetupRuntimeError("OpenCode already has a conflicting omniroute provider package; Setup did not overwrite it.", 409);
    }
    if (provider.npm === undefined) { provider.npm = OMNIROUTE_OPENCODE_PROVIDER.npm; changed = true; }
    if (provider.name === undefined) { provider.name = OMNIROUTE_OPENCODE_PROVIDER.name; changed = true; }

    let options = plainRecord(provider.options);
    if (provider.options !== undefined && !options) {
      throw new SetupRuntimeError("OpenCode provider.omniroute.options is not an object; Setup did not overwrite it.", 409);
    }
    if (!options) {
      options = {};
      provider.options = options;
      changed = true;
    }
    const expectedBase = OMNIROUTE_OPENCODE_PROVIDER.options.baseURL.replace(/\/+$/, "");
    const existingBase = typeof options.baseURL === "string" ? options.baseURL.replace(/\/+$/, "") : options.baseURL;
    if (existingBase !== undefined && existingBase !== expectedBase) {
      throw new SetupRuntimeError("OpenCode already has a conflicting OmniRoute baseURL; Setup did not overwrite it.", 409);
    }
    if (options.baseURL === undefined) { options.baseURL = OMNIROUTE_OPENCODE_PROVIDER.options.baseURL; changed = true; }
    if (options.apiKey !== undefined
      && options.apiKey !== OMNIROUTE_OPENCODE_PROVIDER.options.apiKey
      && options.apiKey !== OMNIROUTE_KEY) {
      throw new SetupRuntimeError("OpenCode already has a conflicting OmniRoute apiKey; Setup did not overwrite it.", 409);
    }
    if (options.apiKey === undefined) { options.apiKey = OMNIROUTE_OPENCODE_PROVIDER.options.apiKey; changed = true; }

    let models = plainRecord(provider.models);
    if (provider.models !== undefined && !models) {
      throw new SetupRuntimeError("OpenCode provider.omniroute.models is not an object; Setup did not overwrite it.", 409);
    }
    if (!models) {
      models = {};
      provider.models = models;
      changed = true;
    }
    for (const [id, definition] of Object.entries(OMNIROUTE_OPENCODE_PROVIDER.models)) {
      if (models[id] !== undefined) {
        if (!plainRecord(models[id])) {
          throw new SetupRuntimeError(`OpenCode already has a conflicting omniroute model definition for ${id}; Setup did not overwrite it.`, 409);
        }
        continue;
      }
      models[id] = { ...definition };
      changed = true;
    }

    if (changed) await atomicWrite(OPENCODE_CONFIG, `${JSON.stringify(root, null, 2)}\n`);
  });
  return changed;
}

function requirePlainObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SetupRuntimeError(message, 400);
  return value as Record<string, unknown>;
}

async function validateValues(
  route: string,
  actionId: string,
  rawValues: unknown,
): Promise<Record<string, string>> {
  const action = getSetupAction(route, actionId);
  if (!action) throw new SetupRuntimeError("Unknown setup action.", 404);
  const fields = action.fields ?? [];
  const raw = rawValues === undefined ? {} : requirePlainObject(rawValues, "values must be an object.");
  const allowed = new Set(fields.map((field) => field.id));
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new SetupRuntimeError("Unknown setup field.", 400);
  const out: Record<string, string> = {};
  for (const field of fields) {
    const input = raw[field.id];
    if (input === undefined || input === "") {
      if (field.required) throw new SetupRuntimeError(`Missing field: ${field.id}.`, 400);
      continue;
    }
    if (typeof input !== "string") throw new SetupRuntimeError(`Invalid field: ${field.id}.`, 400);
    const value = input.trim();
    if (!value || value.length > (field.type === "path" ? 2048 : 4096) || /[\r\n\0]/.test(value)) {
      throw new SetupRuntimeError(`Invalid field: ${field.id}.`, 400);
    }
    if (field.type === "secret") {
      if (value.length < 8) throw new SetupRuntimeError(`Invalid field: ${field.id}.`, 400);
      out[field.id] = value;
    } else if (field.type === "text") {
      if (value.length > 256) throw new SetupRuntimeError(`Invalid field: ${field.id}.`, 400);
      out[field.id] = value;
    } else {
      if (!path.isAbsolute(value)) throw new SetupRuntimeError(`Path must be absolute: ${field.id}.`, 400);
      let resolved: string;
      try { resolved = await realpath(value); } catch { throw new SetupRuntimeError(`Path does not exist: ${field.id}.`, 400); }
      if (!(await isFile(resolved))) throw new SetupRuntimeError(`Path is not a file: ${field.id}.`, 400);
      if (process.platform === "win32" && ![".exe", ".cmd", ".bat", ".com"].includes(path.extname(resolved).toLowerCase())) {
        throw new SetupRuntimeError(`Path is not a supported Windows executable: ${field.id}.`, 400);
      }
      if (process.platform !== "win32") {
        try { await access(resolved, fsConstants.X_OK); }
        catch { throw new SetupRuntimeError(`Path is not executable: ${field.id}.`, 400); }
      }
      out[field.id] = resolved;
    }
  }
  return out;
}

function spawnInvocation(executable: string, args: readonly string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { command: executable, args: [...args] };
  }
  if (/[\r\n"%!]/.test(executable) || args.some((value) => !/^[A-Za-z0-9@._:/=+-]+$/.test(value))) {
    throw new SetupRuntimeError("The fixed command could not be represented safely.", 500);
  }
  const command = process.env.ComSpec || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  return { command, args: ["/d", "/s", "/c", `call "${executable}" ${args.join(" ")}`.trim()] };
}

function safeCommandOutput(output: string): string {
  const cleaned = output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split(HOME).join("~")
    .trim();
  return cleaned.split(/\r?\n/).slice(-8).join("\n").slice(-1600);
}

function setupChildEnv(): NodeJS.ProcessEnv {
  const names = [
    "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "OS",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME",
    "LOCALAPPDATA", "APPDATA", "TEMP", "TMP",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  ] as const;
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const name of names) if (process.env[name]) env[name] = process.env[name];
  const pathValue = process.env.Path ?? process.env.PATH;
  if (pathValue) env.Path = pathValue;
  env.NO_COLOR = "1";
  env.NPM_CONFIG_AUDIT = "false";
  env.NPM_CONFIG_FUND = "false";
  env.PIP_DISABLE_PIP_VERSION_CHECK = "1";
  env.UV_NO_PROGRESS = "1";
  return env;
}

async function runForegroundCommand(spec: ResolvedFixedCommandSpec): Promise<string> {
  const executable = await findExecutable(spec.executable);
  if (!executable) throw new SetupRuntimeError(`${spec.executable} is not installed or not available on PATH.`, 409);
  const invocation = spawnInvocation(executable, spec.args);

  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      env: setupChildEnv(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (current: string, chunk: Buffer | string) => `${current}${chunk.toString()}`.slice(-32_000);
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child);
    }, spec.timeoutMs ?? 10 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new SetupRuntimeError(`The allowlisted command could not start: ${error.message}`, 500));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = safeCommandOutput(`${stdout}\n${stderr}`);
      if (timedOut) {
        reject(new SetupRuntimeError("The allowlisted command timed out. Check the guide before retrying.", 504));
      } else if (code !== 0) {
        reject(new SetupRuntimeError(output ? `The allowlisted command failed.\n${output}` : `The allowlisted command exited with code ${code}.`, 500));
      } else {
        resolve(output ? `הפקודה המאושרת הסתיימה בהצלחה.\n${output}` : "הפקודה המאושרת הסתיימה בהצלחה.");
      }
    });
  });
}

async function fixedServiceReady(key: string): Promise<boolean> {
  if (key.endsWith(":start-ollama")) {
    return Boolean((await localFetch("http://127.0.0.1:11434/api/tags", undefined, 1200))?.ok);
  }
  if (key.endsWith(":start-omniroute")) {
    const response = await localFetch(`${OMNIROUTE_BASE}/v1/models`, omnirouteRequestHeaders(), 1500);
    if (!response?.ok) return false;
    try {
      const payload = await response.json() as { data?: unknown[]; models?: unknown[] };
      const models = payload.data ?? payload.models;
      return Array.isArray(models) && models.length > 0;
    } catch { return false; }
  }
  return false;
}

async function startFixedService(key: string, spec: ResolvedFixedCommandSpec): Promise<string> {
  if (await fixedServiceReady(key)) return "השירות כבר פעיל ומגיב לבדיקת readiness.";
  const executable = await findExecutable(spec.executable);
  if (!executable) throw new SetupRuntimeError(`${spec.executable} is not installed or not available on PATH.`, 409);
  const invocation = spawnInvocation(executable, spec.args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(),
    env: setupChildEnv(),
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error) => reject(new SetupRuntimeError(`The allowlisted service could not start: ${error.message}`, 500)));
  });
  child.unref();

  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await fixedServiceReady(key)) return "השירות הופעל ומגיב לבדיקת readiness.";
  }
  if (child.pid && process.platform === "win32") {
    await terminateProcessTree(child);
  } else {
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill(); } catch { /* already stopped */ }
  }
  throw new SetupRuntimeError("The service process started but did not become ready in time. Review its guide and local logs.", 504);
}

async function installBundledThumbnailScripts(): Promise<string> {
  const filenames = ["generate.py", "text_overlay.py"] as const;
  const sourceRoots = [
    path.resolve(process.cwd(), "extras", "thumbnail-generator"),
    path.resolve(process.cwd(), "..", "extras", "thumbnail-generator"),
  ];
  let sourceRoot: string | null = null;
  for (const candidate of sourceRoots) {
    const complete = await Promise.all(filenames.map((name) => isFile(path.join(candidate, name))));
    if (complete.every(Boolean)) {
      sourceRoot = candidate;
      break;
    }
  }
  if (!sourceRoot) {
    throw new SetupRuntimeError("The bundled Thumbnail Studio scripts are missing from extras/thumbnail-generator.", 409);
  }

  const destinationRoot = path.join(HOME, ".claude", "skills", "youtube-thumbnails", "scripts");
  const files = await Promise.all(filenames.map(async (name) => {
    const source = await readFile(path.join(sourceRoot!, name), "utf8");
    const destination = path.join(destinationRoot, name);
    if (await isFile(destination)) {
      const existing = await readFile(destination, "utf8");
      if (existing !== source) {
        throw new SetupRuntimeError(`${name} already exists with different content. Back it up or reconcile it manually; Setup Center did not overwrite it.`, 409);
      }
      return { destination, source, alreadyPresent: true };
    }
    return { destination, source, alreadyPresent: false };
  }));

  const pending = files.filter((file) => !file.alreadyPresent);
  for (const file of pending) await atomicWrite(file.destination, file.source);
  if (pending.length === 0) return "שני ה-scripts מה-pack כבר מותקנים וזהים למקור.";
  return `${pending.length} scripts הותקנו מה-pack ללא דריסת קבצים שונים.`;
}

async function verifiedOpenClawCommandOverride(): Promise<string | null> {
  let persisted: Record<string, unknown> | null = null;
  try { persisted = plainRecord(JSON.parse(await readText(AGENTIC_CONFIG))); }
  catch { /* fall back to the config loaded at server start */ }
  const configured = (typeof persisted?.openclaw === "string" ? persisted.openclaw : config.openclaw)?.trim();
  if (!configured) return null;
  if (!path.isAbsolute(configured)) {
    throw new SetupRuntimeError("The configured OpenClaw CLI path must be absolute.", 409);
  }
  let resolved: string;
  try { resolved = await realpath(configured); }
  catch { throw new SetupRuntimeError("The configured OpenClaw CLI path no longer exists.", 409); }
  if (!(await isFile(resolved))) {
    throw new SetupRuntimeError("The configured OpenClaw CLI path is not a file.", 409);
  }
  if (process.platform === "win32") {
    if (![".exe", ".cmd", ".bat", ".com"].includes(path.extname(resolved).toLowerCase())) {
      throw new SetupRuntimeError("The configured OpenClaw CLI path is not a supported Windows executable.", 409);
    }
  } else {
    try { await access(resolved, fsConstants.X_OK); }
    catch { throw new SetupRuntimeError("The configured OpenClaw CLI path is not executable.", 409); }
  }
  return resolved;
}

async function runFixedSystemAction(route: SetupRoute, actionId: string): Promise<string> {
  const key = `${route}:${actionId}`;
  if (key === "/thumbnails:install-local-scripts") return installBundledThumbnailScripts();
  const spec = FIXED_COMMANDS[key];
  if (!spec) throw new SetupRuntimeError("This system action is not allowlisted.", 501);
  const configuredOpenClaw = key === "/openclaw:start-gateway"
    ? await verifiedOpenClawCommandOverride()
    : null;
  const resolvedSpec: ResolvedFixedCommandSpec = configuredOpenClaw
    ? { ...spec, executable: configuredOpenClaw }
    : spec;
  return resolvedSpec.mode === "service" ? startFixedService(key, resolvedSpec) : runForegroundCommand(resolvedSpec);
}

async function connect(route: SetupRoute, actionId: string, values: Record<string, string>): Promise<string> {
  if (actionId === "connect-cli-path") {
    const keys: Partial<Record<SetupRoute, SetupCliConfigKey>> = {
      "/claude": "claude",
      "/openclaw": "openclaw",
      "/hermes": "hermes",
      "/codex": "codex",
      "/freeclaude": "claude",
      "/engine": "hermes",
      "/ruflo": "ruflo",
      "/antigravity": "antigravity",
      "/kimi": "kimi",
      "/grok": "grok",
      "/opencode": "opencode",
      "/notebook": "nlmBin",
    };
    const key = keys[route];
    if (!key) throw new SetupRuntimeError("CLI path is not supported for this route.", 400);
    await updateAgenticConfig(key, values.cliPath);
    return "נתיב ה-CLI נשמר. יש להפעיל מחדש את Agent OS כדי לטעון אותו.";
  }

  if (route === "/opencode" && actionId === "connect-omniroute-provider") {
    const changed = await connectOpenCodeOmniRoute();
    return changed
      ? "OmniRoute נוסף ל-config הגלובלי של OpenCode בלי לדרוס הגדרות קיימות."
      : "OmniRoute כבר מוגדר ב-config הגלובלי של OpenCode; לא נדרש שינוי.";
  }

  if (actionId.startsWith("connect-openrouter-")) {
    const target = actionId.endsWith("-fusion") ? hermesProfileEnvPath("fusion")
      : actionId.endsWith("-north-mini") ? hermesProfileEnvPath("north-mini")
        : route === "/muse-code" ? path.join(hermesHome(), ".env")
          : ["/room", "/loop", "/openmontage", "/leads"].includes(route) ? await legacyActiveProfileEnv()
            : hermesProfileEnvPath(await activeProfile());
    await updateEnvAtomic(target, { OPENROUTER_API_KEY: values.apiKey });
    return "OpenRouter key נשמר מקומית. ייתכן שנדרש restart לרכיבים שכבר נטענו.";
  }

  switch (`${route}:${actionId}`) {
    case "/glm-code:connect-ollama-cloud":
      await updateEnvAtomic(path.join(process.cwd(), ".env.local"), { OLLAMA_API_KEY: values.apiKey });
      return "Ollama Cloud key נשמר ב-.env.local. יש להפעיל מחדש את Agent OS כדי שה-build backend יטען אותו.";
    case "/higgsfield:connect-higgsfield": {
      const profile = await activeProfile();
      const result = await addCustomServer({
        name: "higgsfield",
        transport: "http",
        url: "https://mcp.higgsfield.ai/mcp",
        auth: "oauth",
      }, profile);
      if (!result.ok) throw new SetupRuntimeError(result.error || "Higgsfield MCP registration failed.", 502);
      return `Higgsfield MCP נרשם בפרופיל ${profile}. כעת השלם OAuth דרך פעולת הכניסה הידנית.`;
    }
    case "/glm:connect-glm":
      await updateEnvAtomic(hermesProfileEnvPath("glm-5-2"), { GLM_API_KEY: values.apiKey });
      break;
    case "/deepseek-coder:connect-deepseek":
      await updateEnvAtomic(FCC_ENV, { DEEPSEEK_API_KEY: values.apiKey });
      break;
    case "/sakana:connect-sakana":
      await updateEnvAtomic(hermesProfileEnvPath("sakana-fugu"), { SAKANA_API_KEY: values.apiKey });
      break;
    case "/paperclip:connect-company":
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(values.companyId)) throw new SetupRuntimeError("Invalid Paperclip company id.", 400);
      await updateEnvAtomic(path.join(process.cwd(), ".env.local"), { PAPERCLIP_COMPANY: values.companyId });
      return "Company id נשמר ונקרא דינמית. בדיקת readiness תאמת כעת את החברה מול השרת.";
    case "/video:connect-heygen":
      await updateEnvAtomic(path.join(AGENTIC_DIR, "heygen.env"), { HEYGEN_API_KEY: values.apiKey });
      break;
    case "/video:connect-elevenlabs":
    case "/studio:connect-elevenlabs":
      await updateEnvAtomic(await activeProfileEnv(), { ELEVENLABS_API_KEY: values.apiKey });
      break;
    case "/music:connect-suno":
      await updateEnvAtomic(path.join(AGENTIC_DIR, "suno.env"), { SUNO_API_KEY: values.apiKey });
      break;
    case "/thumbnails:connect-openai":
      await updateEnvAtomic(path.join(HOME, ".claude", "skills", "youtube-thumbnails", ".env"), { OPENAI_API_KEY: values.apiKey });
      break;
    case "/leads:connect-hunter":
      await updateEnvAtomic(await activeProfileEnv(), { HUNTER_API_KEY: values.apiKey });
      break;
    case "/leads:connect-apollo":
      await updateEnvAtomic(await activeProfileEnv(), { APOLLO_API_KEY: values.apiKey });
      break;
    default:
      throw new SetupRuntimeError("This connect action has no automatic implementation.", 501);
  }
  return "Credential נשמר מקומית ולא הוחזר בתגובה. ייתכן שנדרש restart.";
}

export async function runSetupAction(input: unknown): Promise<SetupActionResponse> {
  const body = requirePlainObject(input, "Request body must be an object.");
  const route = body.route;
  const actionId = body.actionId;
  if (typeof route !== "string" || typeof actionId !== "string") throw new SetupRuntimeError("route and actionId are required.", 400);
  const entry = getSetupEntry(route);
  const action = getSetupAction(route, actionId);
  if (!entry || !action) throw new SetupRuntimeError("Unknown setup action.", 404);

  const allowedTopLevel = new Set(["route", "actionId", "confirm", "values"]);
  if (Object.keys(body).some((key) => !allowedTopLevel.has(key))) throw new SetupRuntimeError("Unknown request field.", 400);
  if (body.confirm !== undefined && body.confirm !== true) throw new SetupRuntimeError("confirm may only be true.", 400);
  if (action.requiresConfirm && body.confirm !== true) throw new SetupRuntimeError("This action requires confirm=true.", 409);

  const values = await validateValues(route, actionId, body.values);
  if (action.availability === "manual") {
    return {
      ok: true, route, actionId, mode: "manual",
      message: action.description,
      ...(action.copyCommand ? { copyCommand: action.copyCommand } : {}),
    };
  }
  if (action.kind === "test") {
    return {
      ok: true, route, actionId, mode: "executed",
      message: "הבדיקה המקומית הסתיימה ללא יצירת תוכן או חיוב ספק.",
      diagnostics: await diagnosticsFor(entry.route),
    };
  }
  if (action.kind === "connect") {
    const message = await connect(entry.route, actionId, values);
    return {
      ok: true, route, actionId, mode: "executed", message,
      diagnostics: await diagnosticsFor(entry.route),
    };
  }
  if (action.kind === "install" || action.kind === "start") {
    const message = await runFixedSystemAction(entry.route, actionId);
    return {
      ok: true, route, actionId, mode: "executed", message,
      diagnostics: await diagnosticsFor(entry.route),
    };
  }
  throw new SetupRuntimeError("Automatic start/install is not enabled for this action.", 501);
}
