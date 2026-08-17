import { NextResponse } from "next/server";
import { readUsage } from "@/lib/tokenLog";
import { readMeasuredUsage } from "@/lib/usageLedger";
import { readProviderBalances } from "@/lib/providerBalances";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Aggregated token usage for the dashboard, from three clearly separated sources:
// what the control plane measured per run, what the legacy JSONL logged, and what
// each provider reports about its own balance. Cached briefly because one source
// makes a network call.
let cache: { at: number; data: unknown } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < 10_000) return NextResponse.json(cache.data);

  const [logged, balances] = await Promise.all([readUsage(), readProviderBalances()]);
  const measured = readMeasuredUsage();

  const grand = measured.agents.reduce(
    (total, agent) => ({
      calls: total.calls + agent.runs,
      promptTokens: total.promptTokens + agent.promptTokens,
      completionTokens: total.completionTokens + agent.completionTokens,
      totalTokens: total.totalTokens + agent.totalTokens,
      costUsd: total.costUsd + agent.costUsd,
      todayTokens: total.todayTokens + agent.todayTokens,
    }),
    { ...logged.grand },
  );

  const data = {
    // `agents` stays the dashboard's primary shape. Measured rows come first; a
    // legacy logged row only appears for an agent the control plane never ran.
    agents: [
      ...measured.agents.map((agent) => ({
        agent: agent.agent,
        calls: agent.runs,
        promptTokens: agent.promptTokens,
        completionTokens: agent.completionTokens,
        totalTokens: agent.totalTokens,
        costUsd: agent.costUsd,
        todayTokens: agent.todayTokens,
        models: [] as string[],
        lastTs: agent.lastTs,
        source: "measured (control plane)" as const,
      })),
      ...logged.agents
        .filter((agent) => !measured.agents.some((row) => row.agent === agent.agent))
        .map((agent) => ({ ...agent, source: "logged (legacy jsonl)" as const })),
    ],
    grand,
    measured: {
      runsScanned: measured.runsScanned,
      note: measured.note,
    },
    balances,
    generatedAt: Date.now(),
  };

  cache = { at: Date.now(), data };
  return NextResponse.json(data);
}
