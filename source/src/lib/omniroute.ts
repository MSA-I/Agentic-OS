// OmniRoute integration — routes the Codex and Free Claude Code agents through
// the local OmniRoute gateway (http://localhost:20128) so they build for FREE
// across 90+ free providers, instead of a paid API or the (uninstalled)
// fcc-server. OmniRoute speaks BOTH protocols the CLIs need:
//   • /v1/messages  (Anthropic)  ← the `claude` CLI  (Free Claude Code)
//   • /v1/responses (OpenAI)     ← the `codex` CLI
//
// All verified live: big-pickle drives both. The catch with the free reasoning
// models is they loop unless told to answer immediately — hence OMNIROUTE_STEER.

export const OMNIROUTE_BASE = (process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128").replace(/\/+$/, "");
// Proven-reliable free coding model on this gateway (deepseek-v4-flash loops).
export const OMNIROUTE_FREE_MODEL = process.env.OMNIROUTE_MODEL || "oc/big-pickle";
// Dummy key — the free providers are keyless, but the CLIs require *something*.
export const OMNIROUTE_KEY = process.env.OMNIROUTE_API_KEY || "free-local";

export function omnirouteRequestHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${OMNIROUTE_KEY}`,
    "x-api-key": OMNIROUTE_KEY,
  };
}

// Without this, the free reasoning models deliberate until they exhaust the
// token budget and never act. This cuts reasoning from ~4000 tokens to ~100 and
// makes them actually write files / run tools.
export const OMNIROUTE_STEER =
  "Answer immediately and act. Do NOT overthink or deliberate at length. When the task needs a file written or a command run, use your tools right away, then stop. Keep reasoning to an absolute minimum.";

const MODEL_RE = /^[A-Za-z0-9._:/-]+$/;
function safeModel(model?: string | null): string {
  return model && MODEL_RE.test(model) ? model : OMNIROUTE_FREE_MODEL;
}

// `codex exec` provider flags — defines an "omniroute" provider inline (no need
// to touch ~/.codex/config.toml, so your own Codex setup is untouched).
// wire_api MUST be "responses": codex-cli ≥0.142 dropped chat-completions.
export function omnirouteCodexArgs(model?: string | null): string[] {
  return [
    "-c", "model_provider=omniroute",
    "-c", "model_providers.omniroute.name=OmniRoute",
    "-c", `model_providers.omniroute.base_url=${OMNIROUTE_BASE}/v1`,
    "-c", "model_providers.omniroute.wire_api=responses",
    "-c", "model_providers.omniroute.env_key=OMNIROUTE_API_KEY",
    // codex 0.144's "apps" connector tools (mcp__codex_apps__*) translate to
    // duplicate tool names at OmniRoute's upstream → 400 "Tool names must be
    // unique". Free-router chats don't use OpenAI apps; keep them off here.
    "-c", "features.apps=false",
    "--model", safeModel(model),
  ];
}
export function omnirouteCodexEnv(): Record<string, string> {
  return { OMNIROUTE_API_KEY: OMNIROUTE_KEY };
}

// ── Direct OpenRouter path (HY3 free window) ────────────────────────────────
// Same inline-config trick as OmniRoute, but pointed at OpenRouter's /responses
// endpoint with the real key from the server env. Used for models OmniRoute
// doesn't carry — first user: tencent/hy3:free (Tencent's 295B, free ~2 weeks).
export const OPENROUTER_HY3_MODEL = "tencent/hy3:free";
export function openrouterCodexArgs(model?: string | null): string[] {
  const m = model && MODEL_RE.test(model) ? model : OPENROUTER_HY3_MODEL;
  return [
    "-c", "model_provider=openrouter",
    "-c", "model_providers.openrouter.name=OpenRouter",
    "-c", "model_providers.openrouter.base_url=https://openrouter.ai/api/v1",
    "-c", "model_providers.openrouter.wire_api=responses",
    "-c", "model_providers.openrouter.env_key=OPENROUTER_API_KEY",
    "--model", m,
  ];
}

function envValue(file: string, name: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, "utf8");
    const match = text.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.+?)\\s*$`, "m"));
    if (!match) return null;
    const value = match[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_whole, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted ?? "");
    return value || null;
  } catch {
    return null;
  }
}

export function openrouterApiKey(): string {
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim();
  const home = hermesHome();
  const candidates = [
    path.join(home, ".env"),
    path.join(os.homedir(), ".fcc", ".env"),
  ];
  try {
    const profilesRoot = path.join(home, "profiles");
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(profilesRoot, entry.name, ".env"));
    }
  } catch { /* no Hermes profiles directory */ }
  for (const file of candidates) {
    const key = envValue(file, "OPENROUTER_API_KEY");
    if (key) return key;
  }
  return "";
}

export function openrouterCodexEnv(): Record<string, string> {
  return { OPENROUTER_API_KEY: openrouterApiKey() };
}

// ── Native OpenAI path — the REAL Codex on the user's ChatGPT OAuth login ──────
// No OpenRouter / no OmniRoute, no API key. Auth comes from `codex login`
// (~/.codex/auth.json, auth_mode=chatgpt). We force model_provider=openai so the
// config.toml default provider (which may be ollama-launch) can't hijack it.
// Default model is gpt-5.6-sol (the frontier agentic-coding tier). The real
// ChatGPT-account ids are gpt-5.6-{sol|terra|luna} — plain "gpt-5.6" is NOT a
// valid id (400). sol=frontier, terra=balanced, luna=fast/cheap. Override via
// CODEX_NATIVE_MODEL.
export const NATIVE_CODEX_MODEL = process.env.CODEX_NATIVE_MODEL || "gpt-5.6-sol";
export function nativeCodexArgs(model?: string | null): string[] {
  const m = model && MODEL_RE.test(model) ? model : NATIVE_CODEX_MODEL;
  return ["-c", "model_provider=openai", "--model", m];
}
export function nativeCodexEnv(): Record<string, string> {
  // Nothing — Codex uses the OAuth tokens in ~/.codex/auth.json. Explicitly blank
  // any OpenRouter key so a stray env can't flip it onto a paid API path.
  return { OPENROUTER_API_KEY: "" };
}


// Env that points the `claude` CLI at OmniRoute's Anthropic endpoint. Setting
// ANTHROPIC_API_KEY is what makes the CLI use the gateway instead of the OAuth
// creds saved by `claude login`.
export function omnirouteClaudeEnv(model?: string | null): Record<string, string> {
  const m = safeModel(model);
  return {
    ANTHROPIC_BASE_URL: OMNIROUTE_BASE,
    ANTHROPIC_API_KEY: OMNIROUTE_KEY,
    ANTHROPIC_AUTH_TOKEN: OMNIROUTE_KEY,
    ANTHROPIC_MODEL: m,
    ANTHROPIC_SMALL_FAST_MODEL: m,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  };
}

// Prepend the steer to a prompt (used for both CLIs).
export function withSteer(prompt: string): string {
  return `${OMNIROUTE_STEER}\n\n${prompt}`;
}

// Is the gateway up? Probes the OpenAI model list (cheap, keyless).
export async function probeOmniRoute(): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(`${OMNIROUTE_BASE}/v1/models`, {
      signal: ctl.signal,
      cache: "no-store",
      headers: omnirouteRequestHeaders(),
    });
    if (!r.ok) return false;
    const payload = await r.json().catch(() => null) as { data?: unknown; models?: unknown } | null;
    const models = payload?.data ?? payload?.models;
    return Array.isArray(models) && models.length > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
import "server-only";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hermesHome } from "@/lib/config";
