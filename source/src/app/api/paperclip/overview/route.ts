import { NextResponse } from "next/server";
import { getPaperclipConfig, probePaperclipCompany } from "@/lib/paperclipConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live snapshot of the Paperclip company for the command-center UI. Fetches
// server-side (no CORS) from the local Paperclip API and aggregates everything
// the dashboard needs in one call.

async function j<T>(apiBase: string, routePath: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(`${apiBase}${routePath}`, { cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (!r.ok) return fallback;
    return (await r.json()) as T;
  } catch {
    return fallback;
  }
}

type Agent = {
  id: string; name: string; role?: string; title?: string; icon?: string;
  status?: string; reportsTo?: string | null; adapterType?: string;
  adapterConfig?: { model?: string; provider?: string };
  budgetMonthlyCents?: number; spentMonthlyCents?: number;
  lastHeartbeatAt?: string; urlKey?: string;
};
type Run = {
  id: string; agentId?: string; status?: string; startedAt?: string;
  finishedAt?: string; createdAt?: string; resultJson?: { text?: string; summary?: string } | null;
  stdoutExcerpt?: string; error?: string;
};
type Issue = { id: string; title?: string; status?: string; projectId?: string; assigneeAgentId?: string | null; identifier?: string };
type Project = { id: string; name?: string };

export async function GET() {
  const paperclip = await getPaperclipConfig();
  if (!paperclip.companyId) {
    return NextResponse.json({ reachable: false, error: "Paperclip company is not configured." }, { status: 409 });
  }
  const companyRoute = `/companies/${encodeURIComponent(paperclip.companyId)}`;
  const [company, agents, runs, issues, projects, probe] = await Promise.all([
    j<Record<string, unknown>>(paperclip.apiBase, companyRoute, {}),
    j<Agent[]>(paperclip.apiBase, `${companyRoute}/agents`, []),
    j<Run[]>(paperclip.apiBase, `${companyRoute}/heartbeat-runs?limit=40`, []),
    j<Issue[]>(paperclip.apiBase, `${companyRoute}/issues`, []),
    j<Project[]>(paperclip.apiBase, `${companyRoute}/projects`, []),
    probePaperclipCompany(),
  ]);

  const reachable = probe.companyReachable;

  // ── Agent cards (sorted by org rank) ──
  const rank: Record<string, number> = { ceo: 0, cto: 1, cmo: 1, coo: 1, "head of operations": 1, ops: 1, cfo: 1 };
  const cleanAgents = (agents || []).map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role || "",
    title: a.title || a.role || "",
    icon: a.icon || "",
    status: a.status || "idle",
    reportsTo: a.reportsTo ?? null,
    model: a.adapterConfig?.model || "",
    provider: a.adapterConfig?.provider || a.adapterType || "",
    budgetCents: a.budgetMonthlyCents ?? 0,
    spentCents: a.spentMonthlyCents ?? 0,
    lastHeartbeatAt: a.lastHeartbeatAt || null,
    urlKey: a.urlKey || "",
  }));

  const agentName = (id?: string) => cleanAgents.find((a) => a.id === id)?.name || "—";

  // ── Activity feed (recent runs) ──
  const activity = (runs || [])
    .slice(0, 16)
    .map((r) => {
      const res = r.resultJson;
      const summary =
        (res && (res.summary || res.text)) ||
        (r.stdoutExcerpt || "").replace(/^\[hermes\][^\n]*\n?/, "").replace(/\n+/g, " ").slice(0, 140) ||
        (r.error || "");
      return {
        id: r.id,
        agent: agentName(r.agentId),
        status: r.status || "?",
        when: r.finishedAt || r.startedAt || r.createdAt || "",
        summary: String(summary).slice(0, 140),
      };
    });

  // ── Stats ──
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;
  const recent = (runs || []).filter((r) => {
    const t = Date.parse(r.finishedAt || r.startedAt || r.createdAt || "");
    return !isNaN(t) && t >= dayAgo;
  });
  const succeeded = recent.filter((r) => r.status === "succeeded" || r.status === "completed").length;
  const failed = recent.filter((r) => r.status === "failed" || r.status === "error").length;
  const successRate = succeeded + failed > 0 ? Math.round((succeeded / (succeeded + failed)) * 100) : 100;
  const onlineAgents = cleanAgents.filter((a) => a.status !== "paused" && a.status !== "terminated").length;

  const issueByStatus: Record<string, number> = {};
  for (const i of issues || []) issueByStatus[i.status || "?"] = (issueByStatus[i.status || "?"] || 0) + 1;
  const doneIssues = (issues || []).filter((i) => i.status === "done").length;

  const projStats = (projects || []).map((p) => {
    const list = (issues || []).filter((i) => i.projectId === p.id);
    const done = list.filter((i) => i.status === "done").length;
    return { name: p.name || "Project", total: list.length, done };
  });

  const spentCents = Number(company.spentMonthlyCents ?? cleanAgents.reduce((s, a) => s + a.spentCents, 0)) || 0;
  const budgetCents = Number(company.budgetMonthlyCents ?? cleanAgents.reduce((s, a) => s + a.budgetCents, 0)) || 0;

  return NextResponse.json({
    reachable,
    company: {
      name: (company.name as string) || "Your Company",
      mission: (company.description as string) || "",
      prefix: (company.issuePrefix as string) || "",
      brandColor: (company.brandColor as string) || "#d4a574",
      status: (company.status as string) || "active",
    },
    stats: {
      agents: cleanAgents.length,
      onlineAgents,
      runs24h: recent.length,
      succeeded,
      failed,
      successRate,
      issues: (issues || []).length,
      doneIssues,
      spentCents,
      budgetCents,
    },
    agents: cleanAgents,
    activity,
    projects: projStats,
    issueByStatus,
  });
}
