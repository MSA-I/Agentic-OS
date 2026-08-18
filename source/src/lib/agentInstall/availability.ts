import "server-only";

import { isAgentInstalled } from "@/lib/config";
import { probeProvider } from "@/lib/runner";
import { diagnosticsFor } from "@/lib/setupRuntime";
import { getDurableWorkbenchControlPlane } from "@/lib/workbench/durableControlPlane";
import { TERMINAL_RUN_STATUSES } from "@/lib/workbench/stateMachine";
import { stripTerminalControls } from "@/lib/workbench/providers/hermesStream";
import type {
  InstallAgentAvailability,
  InstallAgentBlockReason,
  InstallAgentFix,
  InstallAgentId,
  InstallAgentStatus,
} from "./agentTypes";

/**
 * Answers one question for the Setup Center: which agent can plan an install
 * right now, and if none can, exactly why and what fixes it.
 *
 * No provider exposes a quota API (providerBalances.ts hardcodes claude and
 * codex as "not-exposed"), and the durable control plane counts active runs
 * globally rather than per provider. So this composes the signals that do
 * exist, cheapest first, and stops at the first one that blocks.
 */

export type {
  InstallAgentId,
  InstallAgentBlockReason,
  InstallAgentFix,
  InstallAgentStatus,
  InstallAgentAvailability,
} from "./agentTypes";


/**
 * Preference order. All three now run through the same durable Workbench
 * pilot, so the ordering is about cost and proof rather than capability:
 * Claude and Codex have live lifecycle evidence behind them, while Hermes
 * spends OpenRouter credit per turn and joined the pilot last.
 */
const AGENT_ORDER: readonly InstallAgentId[] = ["claude", "codex", "hermes"];

const AGENT_LABEL: Record<InstallAgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  hermes: "Hermes",
};

const SETUP_ROUTE: Record<InstallAgentId, "/claude" | "/codex" | "/hermes"> = {
  claude: "/claude",
  codex: "/codex",
  hermes: "/hermes",
};

const LOGIN_COMMAND: Record<InstallAgentId, string> = {
  claude: "claude login",
  codex: "codex login",
  hermes: "hermes model",
};

const PROBE_ARGS: Record<InstallAgentId, readonly string[]> = {
  claude: ["--version"],
  codex: ["--version"],
  hermes: ["status"],
};

const PROBE_TIMEOUT_MS: Record<InstallAgentId, number> = {
  claude: 6_000,
  codex: 6_000,
  hermes: 8_000,
};

// Mirrors DEFAULT_ADMISSION_POLICY.maxActiveRuns in resourceAdmission.ts. Kept
// as a local constant rather than an import because that module is worker-side
// and pulling it in here would drag the whole execution graph into a read path.
const MAX_ACTIVE_RUNS = 5;

const CACHE_TTL_MS = 5_000;

let cached: { at: number; value: InstallAgentAvailability } | null = null;
let inflight: Promise<InstallAgentAvailability> | null = null;

function blocked(
  id: InstallAgentId,
  blockedBy: InstallAgentBlockReason,
  reason: string,
  fix: InstallAgentFix | null,
  latencyMs: number | null = null,
): InstallAgentStatus {
  return {
    id,
    label: AGENT_LABEL[id],
    transport: "workbench",
    available: false,
    blockedBy,
    reason,
    fix,
    latencyMs,
  };
}

/**
 * Turns a probe refusal into the one sentence and the one fix that actually
 * clears it. The identity codes matter most in practice: the pin lives in a
 * module-scope Map in executableIdentity.ts, so a server restart genuinely
 * resolves them and nothing in the repository needs changing.
 */
export function classifyProbeFailure(
  id: InstallAgentId,
  stderr: string,
  durationMs: number,
  timeoutMs: number,
): { blockedBy: InstallAgentBlockReason; reason: string; fix: InstallAgentFix } {
  const label = AGENT_LABEL[id];
  if (stderr.includes("executable_identity_invalidated")) {
    return {
      blockedBy: "identity_invalidated",
      reason: `זהות קובץ ההרצה של ${label} בוטלה בתהליך השרת הנוכחי.`,
      fix: { kind: "restart", label: "הפעל מחדש את Agent OS כדי לנעוץ אותה מחדש" },
    };
  }
  if (stderr.includes("executable_identity_changed")) {
    return {
      blockedBy: "identity_changed",
      reason: `ה-CLI של ${label} התעדכן מאז שזהותו ננעצה.`,
      fix: { kind: "restart", label: "הפעל מחדש את Agent OS כדי לנעוץ את הגרסה החדשה" },
    };
  }
  if (durationMs >= timeoutMs - 250) {
    return {
      blockedBy: "probe_timeout",
      reason: `${label} לא ענה תוך ${Math.round(timeoutMs / 1000)} שניות.`,
      fix: { kind: "wait", label: "נסה שוב בעוד רגע" },
    };
  }
  const detail = stderr.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 160) ?? "";
  return {
    blockedBy: "probe_failed",
    reason: detail ? `בדיקת ${label} נכשלה: ${detail}` : `בדיקת ${label} נכשלה.`,
    fix: { kind: "setup", label: `פתח את ${label} ב-Setup Center`, route: SETUP_ROUTE[id] },
  };
}

/**
 * One short line for a healthy agent. Claude and Codex answer `--version` with
 * exactly that, but `hermes status` prints a boxed report whose first line is a
 * border. Pull its model out instead — that is the fact worth showing.
 */
function describeProbe(id: InstallAgentId, stdout: string): string {
  const text = stripTerminalControls(stdout);
  if (id === "hermes") {
    const model = /Model:\s+(\S+)/u.exec(text)?.[1];
    const provider = /Provider:\s+([^\r\n]+)/u.exec(text)?.[1]?.trim();
    if (model) return provider ? `${model} · ${provider}` : model;
  }
  const firstMeaningful = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /[A-Za-z0-9]/u.test(line));
  return firstMeaningful?.slice(0, 80) || "פנוי";
}

/** A required diagnostic that is not ready means the agent cannot be trusted to run. */
function authBlocker(diagnostics: Awaited<ReturnType<typeof diagnosticsFor>>): string | null {
  const blocker = diagnostics.find(
    (entry) => (entry.impact ?? "required") === "required" && entry.status !== "ready",
  );
  if (!blocker) return null;
  return blocker.detail || blocker.message || blocker.label || "דרוש חיבור";
}

async function evaluate(
  id: InstallAgentId,
  activeRuns: number,
  blockedRun: { at: string } | null,
): Promise<InstallAgentStatus> {
  if (!isAgentInstalled(id)) {
    return blocked(id, "not_installed", `ה-CLI של ${AGENT_LABEL[id]} לא נמצא.`, {
      kind: "setup",
      label: "התקן או חבר נתיב קיים",
      route: SETUP_ROUTE[id],
    });
  }

  const authReason = authBlocker(await diagnosticsFor(SETUP_ROUTE[id]));
  if (authReason) {
    return blocked(id, "not_authenticated", authReason, {
      kind: "auth",
      label: `הרץ ${LOGIN_COMMAND[id]} בטרמינל`,
      command: LOGIN_COMMAND[id],
      route: SETUP_ROUTE[id],
    });
  }

  const circuit = await getDurableWorkbenchControlPlane().providerCircuit(id);
  if (circuit && circuit.state === "open") {
    return blocked(
      id,
      "circuit_open",
      `${AGENT_LABEL[id]} נכשל ${circuit.consecutiveFailures} פעמים ברצף, ולכן הוא מושהה זמנית.`,
      { kind: "wait", label: "ההשהיה תתפוגג לבד", at: circuit.openUntil ?? undefined },
    );
  }

  if (blockedRun) {
    return blocked(
      id,
      "quota_blocked",
      `${AGENT_LABEL[id]} החזיר חריגת מכסה בריצה האחרונה.`,
      { kind: "wait", label: "המתן לאיפוס המכסה אצל הספק", at: blockedRun.at },
    );
  }

  if (activeRuns >= MAX_ACTIVE_RUNS) {
    return blocked(
      id,
      "capacity",
      `כבר רצות ${activeRuns} משימות — זו התקרה.`,
      { kind: "wait", label: "המתן לסיום ריצה קיימת" },
    );
  }

  const probe = await probeProvider(id, PROBE_ARGS[id], { timeoutMs: PROBE_TIMEOUT_MS[id] });
  if (!probe.ok) {
    const classified = classifyProbeFailure(
      id,
      `${probe.stderr}\n${probe.stdout}`,
      probe.durationMs,
      PROBE_TIMEOUT_MS[id],
    );
    return blocked(id, classified.blockedBy, classified.reason, classified.fix, probe.durationMs);
  }

  return {
    id,
    label: AGENT_LABEL[id],
    transport: "workbench",
    available: true,
    blockedBy: null,
    reason: describeProbe(id, probe.stdout),
    fix: null,
    latencyMs: probe.durationMs,
  };
}

/**
 * Recent quota refusals, read from the durable run history rather than guessed.
 * A run that ended `blocked` on a quota failure is the only place the app ever
 * learns about a provider limit, so it is also the only honest source here.
 */
function recentQuotaBlocks(): { runs: number; byProvider: Map<string, { at: string }> } {
  const byProvider = new Map<string, { at: string }>();
  let active = 0;
  let presentations: ReturnType<ReturnType<typeof getDurableWorkbenchControlPlane>["list"]>;
  try {
    presentations = getDurableWorkbenchControlPlane().list({ limit: 200 });
  } catch {
    return { runs: 0, byProvider };
  }
  for (const { run, failure } of presentations) {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      active += 1;
      continue;
    }
    if (run.status !== "blocked") continue;
    if (byProvider.has(run.provider)) continue;
    // `quota` is the only category the classifier produces for a provider limit;
    // rate limiting arrives as a retryable failure and never ends a run `blocked`.
    if ((failure?.category ?? null) !== "quota") continue;
    byProvider.set(run.provider, { at: run.updatedAt ?? run.createdAt });
  }
  return { runs: active, byProvider };
}

async function compute(): Promise<InstallAgentAvailability> {
  const { runs: activeRuns, byProvider } = recentQuotaBlocks();
  const agents = await Promise.all(
    AGENT_ORDER.map((id) => evaluate(id, activeRuns, byProvider.get(id) ?? null)),
  );
  return {
    version: 1,
    checkedAt: new Date().toISOString(),
    agents,
    selected: agents.find((agent) => agent.available)?.id ?? null,
    capacity: {
      activeRuns,
      maxActiveRuns: MAX_ACTIVE_RUNS,
      saturated: activeRuns >= MAX_ACTIVE_RUNS,
    },
  };
}

/** Cached and de-duped like /api/vitals: probes spawn processes, so repeat calls must not. */
export async function getInstallAgentAvailability(): Promise<InstallAgentAvailability> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;
  if (inflight) return inflight;
  inflight = compute()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
