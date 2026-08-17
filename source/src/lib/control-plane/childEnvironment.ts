import os from "node:os";
import path from "node:path";
import type { GuardedProvider } from "./executableIdentity";

export class ChildEnvironmentError extends Error {
  readonly code = "forbidden_provider_environment" as const;
  constructor(message: string) {
    super(message);
    this.name = "ChildEnvironmentError";
  }
}

const COMMON_KEYS = [
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NUMBER_OF_PROCESSORS",
  "NO_COLOR",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "FORCE_COLOR",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

const PROVIDER_KEYS: Record<GuardedProvider, readonly string[]> = {
  claude: [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "CLAUDE_CONFIG_DIR",
    "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_REGION",
  ],
  codex: [
    "CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENROUTER_API_KEY",
    "OMNIROUTE_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT",
  ],
  hermes: [
    "HERMES_HOME", "HERMES_PROFILE", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "GOOGLE_API_KEY", "GEMINI_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS", "XAI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY", "TOGETHER_API_KEY", "FIREWORKS_API_KEY", "CEREBRAS_API_KEY",
  ],
  openclaw: [
    "OPENCLAW_CONFIG_PATH", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_HOME",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
    "OPENROUTER_API_KEY", "XAI_API_KEY",
  ],
  antigravity: [
    "ANTIGRAVITY_HOME", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_REGION",
  ],
};

const FORBIDDEN_KEY = /(?:AGENT_OS_WORKBENCH|BOOTSTRAP|SESSION_TOKEN|COOKIE|CSRF|NEXTAUTH|PASSWORD|PRIVATE_KEY|CLIENT_SECRET)/i;

function canonicalKey(key: string): string {
  return key.toUpperCase();
}

function copyAllowed(
  target: Record<string, string | undefined>,
  source: Readonly<Record<string, string | undefined>>,
  allowed: ReadonlySet<string>,
): void {
  for (const [rawKey, value] of Object.entries(source)) {
    const key = canonicalKey(rawKey);
    if (!allowed.has(key) || value === undefined || FORBIDDEN_KEY.test(key)) continue;
    target[key] = value;
  }
}

export function providerEnvironmentKeys(provider: GuardedProvider): readonly string[] {
  return PROVIDER_KEYS[provider];
}

/**
 * Minimal environment for a local tool that is not one of the guarded providers.
 * Only the common OS keys plus an explicit per-tool allowlist survive, so the
 * Workbench bootstrap secret, cookies and unrelated provider credentials never
 * reach the child. `overrides` is server-owned; forbidden keys are still dropped.
 */
export function buildToolChildEnvironment(
  extraAllowedKeys: readonly string[] = [],
  overrides: Readonly<Record<string, string>> = {},
  base: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const allowed = new Set([...COMMON_KEYS, ...extraAllowedKeys].map(canonicalKey));
  const result: Record<string, string | undefined> = {};
  copyAllowed(result, base, allowed);
  for (const [rawKey, value] of Object.entries(overrides)) {
    const key = canonicalKey(rawKey);
    if (FORBIDDEN_KEY.test(key)) {
      throw new ChildEnvironmentError("Tool launch requested a forbidden child environment key.");
    }
    result[key] = value;
  }
  result.HOME = result.HOME || result.USERPROFILE || os.homedir();
  result.NO_COLOR = "1";
  result.FORCE_COLOR = "0";
  return result as NodeJS.ProcessEnv;
}

export function buildProviderChildEnvironment(
  provider: GuardedProvider,
  base: Readonly<Record<string, string | undefined>> = process.env,
  extra: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  const allowed = new Set([...COMMON_KEYS, ...PROVIDER_KEYS[provider]].map(canonicalKey));
  for (const key of Object.keys(extra)) {
    const normalized = canonicalKey(key);
    if (!allowed.has(normalized) || FORBIDDEN_KEY.test(normalized)) {
      throw new ChildEnvironmentError(
        `${provider} launch requested a non-allowlisted child environment key.`,
      );
    }
  }

  const result: Record<string, string | undefined> = {};
  copyAllowed(result, base, allowed);
  copyAllowed(result, extra, allowed);

  const home = result.HOME || result.USERPROFILE || os.homedir();
  result.HOME = home;
  if (process.platform === "win32") result.USERPROFILE = result.USERPROFILE || home;
  const standardPaths = process.platform === "win32"
    ? []
    : [
        "/usr/local/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
        path.join(home, ".local", "bin"), path.join(home, "local", "node", "bin"), path.join(home, ".kimi-code", "bin"),
      ];
  const existingPaths = (result.PATH ?? "").split(path.delimiter).filter(Boolean);
  result.PATH = [...new Set([...existingPaths, ...standardPaths])].join(path.delimiter);
  if (process.platform !== "win32") result.SHELL = result.SHELL || "/bin/zsh";
  result.NO_COLOR = "1";
  result.FORCE_COLOR = "0";
  return result as NodeJS.ProcessEnv;
}
