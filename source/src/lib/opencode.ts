// OpenCode integration: resolves the local CLI and exposes only models whose
// providers are actually configured in OpenCode's global config.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "@/lib/config";
import { OMNIROUTE_BASE, OMNIROUTE_KEY } from "@/lib/omniroute";

const OPENCODE_EXECUTABLE = process.platform === "win32" ? "opencode.exe" : "opencode";
export const OPENCODE_BIN = config.opencode
  || path.join(os.homedir(), ".opencode", "bin", OPENCODE_EXECUTABLE);

export const OPENCODE_CONFIG = process.env.OPENCODE_CONFIG
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode", "opencode.json");

export const OPENCODE_ROOT = path.join(os.homedir(), ".agentic-os", "opencode", "builds");

const CORE_MODELS = [
  { id: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra", sub: "NVIDIA · free · verified" },
  { id: "opencode/big-pickle", label: "Big Pickle", sub: "OpenCode Zen · free flagship" },
  { id: "opencode/deepseek-v4-flash-free", label: "DeepSeek V4 Flash", sub: "Zen · free · undated build" },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash 0731", sub: "official API · agent-tuned · 1M ctx" },
  { id: "openrouter/deepseek/deepseek-v4-flash-0731", label: "DeepSeek V4 Flash 0731 (OR)", sub: "dated id via OpenRouter · 1M ctx" },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", sub: "official API · strong tier · 1M ctx" },
  { id: "opencode/north-mini-code-free", label: "North Mini Code", sub: "Cohere · free · coding" },
] as const;

export const OMNIROUTE_OPENCODE_MODELS = [
  { id: "omniroute/auto/coding", label: "OmniRoute Coding", sub: "free router · verified $0" },
  { id: "omniroute/auto/best-coding", label: "OmniRoute Best-Coding", sub: "free router · strongest" },
  { id: "omniroute/auto/best-fast", label: "OmniRoute Fast", sub: "free router · quick drafts" },
] as const;

const TAIL_MODELS = [
  { id: "tinker/thinkingmachines/Inkling", label: "Inkling", sub: "Tinker · 975B MoE · paid" },
] as const;

export const OMNIROUTE_OPENCODE_PROVIDER = {
  npm: "@ai-sdk/openai-compatible",
  name: "OmniRoute (local)",
  options: {
    baseURL: `${OMNIROUTE_BASE}/v1`,
    apiKey: "{env:OMNIROUTE_API_KEY}",
  },
  models: Object.fromEntries(OMNIROUTE_OPENCODE_MODELS.map((model) => [
    model.id.slice("omniroute/".length),
    { name: model.label },
  ])),
} as const;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

export function readOpenCodeConfig(): JsonRecord | null {
  if (!existsSync(OPENCODE_CONFIG)) return {};
  try {
    return asRecord(JSON.parse(readFileSync(OPENCODE_CONFIG, "utf8")));
  } catch { return null; }
}

export function configuredOmniRouteModelIds(): Set<string> {
  const root = readOpenCodeConfig();
  const providers = asRecord(root?.provider);
  const provider = asRecord(providers?.omniroute);
  const options = asRecord(provider?.options);
  const models = asRecord(provider?.models);
  const expectedBase = `${OMNIROUTE_BASE}/v1`.replace(/\/+$/, "");
  const actualBase = typeof options?.baseURL === "string" ? options.baseURL.replace(/\/+$/, "") : "";
  const apiKey = options?.apiKey;
  const validApiKey = apiKey === "{env:OMNIROUTE_API_KEY}" || apiKey === OMNIROUTE_KEY;
  if (provider?.npm !== "@ai-sdk/openai-compatible" || actualBase !== expectedBase || !validApiKey || !models) return new Set();
  return new Set(Object.entries(models)
    .filter(([, definition]) => asRecord(definition) !== null)
    .map(([id]) => `omniroute/${id}`));
}

export function omniRouteProviderConfigured(): boolean {
  const configured = configuredOmniRouteModelIds();
  return OMNIROUTE_OPENCODE_MODELS.every((model) => configured.has(model.id));
}

export function getOpenCodeModels() {
  const configured = configuredOmniRouteModelIds();
  return [
    ...CORE_MODELS,
    ...OMNIROUTE_OPENCODE_MODELS.filter((model) => configured.has(model.id)),
    ...TAIL_MODELS,
  ];
}

export function getOpenCodeDefaultModel(): string {
  // Preserve an explicitly configured default. The build route will return a
  // Setup-required error when that OmniRoute model is not wired, instead of
  // silently switching the request to OpenCode Zen.
  return process.env.OPENCODE_MODEL || "opencode/nemotron-3-ultra-free";
}

export interface OpenCodeState {
  installed: boolean;
  bin: string;
  ready: boolean;
}

export interface OpenCodeInvocation {
  command: string;
  args: string[];
}

export function resolveOpenCodeInvocation(args: string[]): OpenCodeInvocation | null {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(OPENCODE_BIN)) {
    return { command: OPENCODE_BIN, args };
  }
  // npm's Windows shim cannot be passed to spawn() directly (EINVAL). Invoke the
  // package's real executable instead, keeping the prompt out of cmd.exe entirely.
  const npmBinDir = path.dirname(OPENCODE_BIN);
  const candidates = [
    path.join(npmBinDir, "node_modules", "opencode-ai", "bin", "opencode.exe"),
    path.join(npmBinDir, "node_modules", "opencode-ai", "bin", "opencode"),
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  return executable ? { command: executable, args } : null;
}

// OpenCode is a local binary; there is no daemon to probe.
export function getOpenCodeState(): OpenCodeState {
  const installed = existsSync(OPENCODE_BIN);
  const ready = installed && resolveOpenCodeInvocation([]) !== null;
  return { installed, bin: OPENCODE_BIN, ready };
}
