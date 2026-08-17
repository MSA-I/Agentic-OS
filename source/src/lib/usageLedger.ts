import { getDurableWorkbenchControlPlane } from "@/lib/workbench/durableControlPlane";

/**
 * Token usage measured by the control plane itself.
 *
 * Since the Wave 3 cutover every real provider run is executed by the durable
 * control plane, which records the provider's own usage report in the run's
 * terminal metadata event. The legacy `token-usage.jsonl` is written by one route
 * that is frozen, so reading only that file reports zeros while real spend is
 * happening. This reads the ledger instead: measured numbers, no estimation.
 */
export interface MeasuredAgentUsage {
  agent: string;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  todayTokens: number;
  lastTs: number;
}

export interface MeasuredUsage {
  agents: MeasuredAgentUsage[];
  runsScanned: number;
  note?: string;
}

function numberAt(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function readMeasuredUsage(runLimit = 100): MeasuredUsage {
  let plane: ReturnType<typeof getDurableWorkbenchControlPlane>;
  try {
    plane = getDurableWorkbenchControlPlane();
  } catch (error) {
    return { agents: [], runsScanned: 0, note: `control plane unavailable: ${error instanceof Error ? error.message : "unknown"}` };
  }

  const dayStart = startOfToday();
  const byAgent = new Map<string, MeasuredAgentUsage>();
  let runsScanned = 0;

  for (const { run } of plane.list({ limit: runLimit })) {
    runsScanned += 1;
    let page;
    try {
      page = plane.eventPage(run.id, 0, 500);
    } catch {
      continue; // a compacted or unreadable run contributes nothing
    }
    const finishedAt = Date.parse(run.updatedAt ?? run.createdAt) || 0;

    for (const event of page.events) {
      if (event.type !== "terminal") continue;
      const payload = event.payload as Record<string, unknown>;
      if (payload.channel !== "metadata" || payload.providerResult !== true) continue;
      const metadata = payload.metadata;
      if (!metadata || typeof metadata !== "object") continue;
      const usage = metadata as Record<string, unknown>;

      const promptTokens = numberAt(usage, "inputTokens");
      const completionTokens = numberAt(usage, "outputTokens");
      const cacheReadTokens = numberAt(usage, "cacheReadInputTokens");
      const cacheCreationTokens = numberAt(usage, "cacheCreationInputTokens");
      const costUsd = numberAt(usage, "totalCostUsd");
      const totalTokens = promptTokens + completionTokens + cacheReadTokens + cacheCreationTokens;
      if (totalTokens === 0 && costUsd === 0) continue;

      const current = byAgent.get(run.provider) ?? {
        agent: run.provider,
        runs: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        todayTokens: 0,
        lastTs: 0,
      };
      current.runs += 1;
      current.promptTokens += promptTokens;
      current.completionTokens += completionTokens;
      current.cacheReadTokens += cacheReadTokens;
      current.cacheCreationTokens += cacheCreationTokens;
      current.totalTokens += totalTokens;
      current.costUsd += costUsd;
      if (finishedAt >= dayStart) current.todayTokens += totalTokens;
      current.lastTs = Math.max(current.lastTs, finishedAt);
      byAgent.set(run.provider, current);
    }
  }

  return {
    agents: [...byAgent.values()].sort((left, right) => right.totalTokens - left.totalTokens),
    runsScanned,
  };
}
