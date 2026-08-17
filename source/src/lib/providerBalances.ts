import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { hermesHome } from "@/lib/config";

/**
 * Provider-side accounting, kept separate from what AGENT-OS measured itself.
 *
 * A subscription's remaining allowance is the provider's number, not ours, so it is
 * only shown when the provider exposes it. Where no API exists, the row says so
 * instead of implying zero.
 */
export interface ProviderBalance {
  provider: string;
  source: string;
  status: "live" | "not-configured" | "not-exposed" | "error";
  label: string;
  detail?: string;
}

const OPENROUTER_TIMEOUT_MS = 5_000;

function keyFromEnvFile(file: string): string {
  try {
    const match = readFileSync(file, "utf8").match(/^\s*OPENROUTER_API_KEY\s*=\s*(.+)$/mu);
    return match ? match[1].trim().replace(/^["']|["']$/gu, "") : "";
  } catch {
    return "";
  }
}

/**
 * The key is read where it already lives — the process environment, the Hermes home
 * env, or any Hermes profile env. It is never copied anywhere and never returned to
 * a client; only the resulting balance is.
 */
function openRouterKey(): string {
  const fromEnvironment = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;

  const home = hermesHome();
  const direct = keyFromEnvFile(path.join(home, ".env"));
  if (direct) return direct;

  const profileRoot = path.join(home, "profiles");
  let profiles: string[] = [];
  try {
    profiles = readdirSync(profileRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch { /* no profile directory */ }
  for (const profile of profiles) {
    const key = keyFromEnvFile(path.join(profileRoot, profile, ".env"));
    if (key) return key;
  }
  return "";
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

async function openRouterBalance(): Promise<ProviderBalance> {
  const key = openRouterKey();
  if (!key) {
    return {
      provider: "openrouter",
      source: "provider balance",
      status: "not-configured",
      label: "No OpenRouter key configured",
      detail: "Set OPENROUTER_API_KEY, or add it to a Hermes profile .env.",
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}`, accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        provider: "openrouter",
        source: "provider balance",
        status: "error",
        label: `OpenRouter returned ${response.status}`,
      };
    }
    const body = await response.json() as { data?: { total_credits?: number; total_usage?: number } };
    const granted = Number(body.data?.total_credits ?? 0);
    const used = Number(body.data?.total_usage ?? 0);
    return {
      provider: "openrouter",
      source: "provider balance",
      status: "live",
      label: `${money(Math.max(0, granted - used))} left`,
      detail: `${money(used)} used of ${money(granted)}`,
    };
  } catch (error) {
    return {
      provider: "openrouter",
      source: "provider balance",
      status: "error",
      label: controller.signal.aborted ? "OpenRouter timed out" : "OpenRouter is unreachable",
      detail: error instanceof Error ? error.message : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function readProviderBalances(): Promise<ProviderBalance[]> {
  return [
    await openRouterBalance(),
    {
      provider: "claude",
      source: "subscription",
      status: "not-exposed",
      label: "Not exposed by provider",
      detail: "Claude subscription usage has no API. Run /usage inside the Claude CLI.",
    },
    {
      provider: "codex",
      source: "subscription",
      status: "not-exposed",
      label: "Not exposed by provider",
      detail: "Codex prints its remaining allowance and reset time only when a run hits the limit.",
    },
  ];
}
