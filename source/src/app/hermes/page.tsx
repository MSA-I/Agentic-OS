"use client";

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import AgentRoom from "@/components/AgentRoom";
import HermesOutreach from "@/components/HermesOutreach";
import HermesMoA from "@/components/HermesMoA";
import RadarView from "@/components/RadarView";
import AstrosView from "@/components/AstrosView";
import UnifiedChat from "@/components/UnifiedChat";
import HermesWorkspace from "@/components/HermesWorkspace";
import HermesGoals from "@/components/HermesGoals";
import HermesMCPCatalog from "@/components/HermesMCPCatalog";
import HermesStudio from "@/components/HermesStudio";
import HermesManage from "@/components/HermesManage";
// Phone tab intentionally NOT mounted in the dashboard — the phone agent runs
// standalone (see ~/.agentic-os/phone-go-live.sh). Component kept on disk.
// import HermesPhone from "@/components/HermesPhone";
import ApolloView from "@/components/ApolloView";
import HermesMuse from "@/components/HermesMuse";
import HermesProfiles from "@/components/HermesProfiles";
import AgentHistory from "@/components/AgentHistory";
import AgentWorkspaceShell, { type WorkspaceSection } from "@/components/AgentWorkspaceShell";

type HermesTab = "chat" | "profiles" | "radar" | "muse" | "astros" | "apollo" | "studio" | "sessions" | "goals" | "workspace" | "mcps" | "manage" | "control" | "outreach" | "moa";
interface HmVitals { ok: boolean; model: string; provider: string; }


export default function HermesRoute() {
  const [tab, setTab] = useState<HermesTab>("chat");
  const [v, setV] = useState<HmVitals | null>(null);
  useEffect(() => {
    const onNav = (event: Event) => {
      const d = (event as CustomEvent<{ agent?: string; section?: WorkspaceSection; target?: string }>).detail;
      if (d?.agent !== "hermes") return;
      const target = d.target;
      if (target === "chat" || target === "profiles" || target === "radar" || target === "muse" || target === "astros" || target === "apollo" || target === "studio" || target === "sessions" || target === "goals" || target === "workspace" || target === "mcps" || target === "manage" || target === "control" || target === "outreach" || target === "moa") {
        setTab(target);
        return;
      }
      const next: Partial<Record<WorkspaceSection, HermesTab>> = { new: "chat", messages: "chat", tools: "mcps", artifacts: "workspace", projects: "workspace", history: "sessions" };
      if (d.section && next[d.section]) setTab(next[d.section]!);
    };
    window.addEventListener("agent-workspace-nav", onNav);
    return () => window.removeEventListener("agent-workspace-nav", onNav);
  }, []);

  // Deep-link: /hermes?tab=manage opens that sub-tab directly.
  useEffect(() => {
    let t = new URLSearchParams(window.location.search).get("tab") as HermesTab | null;
    if ((t as string) === "jarvis") t = "apollo"; // legacy links: ?tab=jarvis → Apollo
    if ((t as string) === "furnace") t = "muse"; // legacy links: ?tab=furnace → Hermes Muse
    const valid: HermesTab[] = ["chat", "profiles", "radar", "muse", "astros", "apollo", "studio", "sessions", "goals", "workspace", "mcps", "manage", "control", "outreach", "moa"];
    if (t && valid.includes(t)) setTab(t);
  }, []);

  useEffect(() => {
    let stop = false;
    const fetchIt = async () => {
      try {
        const r = await fetch("/api/vitals", { cache: "no-store" });
        const j = await r.json();
        if (!stop) setV(j.hermes);
      } catch { /* ignore */ }
    };
    fetchIt();
    const t = setInterval(fetchIt, 8000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  const section: WorkspaceSection = tab === "chat" ? "messages" : tab === "sessions" ? "history" : tab === "workspace" ? "projects" : tab === "studio" ? "artifacts" : "tools";
  return (
    <AgentWorkspaceShell agent="hermes" active={section} activeTarget={tab}><div className="space-y-5">
      {tab === "chat" ? (
        <UnifiedChat defaultAgent="hermes" showAgentSwitcher={false} />
      ) : tab === "profiles" ? (
        <HermesProfiles />
      ) : tab === "sessions" ? (
        <AgentHistory agent="hermes" />
      ) : tab === "radar" ? (
        <RadarView />
      ) : tab === "muse" ? (
        <HermesMuse />
      ) : tab === "astros" ? (
        <AstrosView />
      ) : tab === "apollo" ? (
        <ApolloView />
      ) : tab === "studio" ? (
        <HermesStudio />
      ) : tab === "goals" ? (
        <HermesGoals />
      ) : tab === "outreach" ? (
        <HermesOutreach />
      ) : tab === "moa" ? (
        <HermesMoA />
      ) : tab === "workspace" ? (
        <HermesWorkspace />
      ) : tab === "mcps" ? (
        <HermesMCPCatalog />
      ) : tab === "manage" ? (
        <HermesManage />
      ) : (
        <AgentRoom
          key={tab}
          agent="hermes"
          accent="#60a5fa"
          accentDim="rgba(96,165,250,0.12)"
          defaultTab="status"
          tabs={[
            { key: "status",   label: "Status",   action: "status",   hint: "env" },
            { key: "sessions", label: "Sessions", action: "sessions", hint: "history" },
            { key: "skills",   label: "Skills",   action: "skills",   hint: "installed" },
            { key: "plugins",  label: "Plugins",  action: "plugins",  hint: "marketplace" },
            { key: "kanban",   label: "Kanban",   action: "kanban",   hint: "tasks" },
            { key: "doctor",   label: "Doctor",   action: "doctor",   hint: "check" },
            { key: "insights", label: "Insights", action: "insights", hint: "analytics" },
          ]}
          vitals={
            v ? (
              <div className="panel p-4 space-y-3">
                <div className="flex items-center gap-2.5">
                  <div className="grid place-items-center w-10 h-10 rounded-xl"
                    style={{ background: "rgba(96,165,250,0.18)", color: "#60a5fa", boxShadow: "0 0 22px -8px #60a5fa" }}>
                    <Cpu size={18} />
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-[var(--fg-dimmer)]">State</div>
                    <div className="text-sm font-medium" style={{ color: "#60a5fa" }}>{v.ok ? "Online" : "Offline"}</div>
                  </div>
                </div>
                <div className="rounded-lg border border-[var(--panel-border)] px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-widest text-[var(--fg-dimmer)]">Model</div>
                  <div className="metric text-sm truncate">{v.model}</div>
                </div>
                <div className="rounded-lg border border-[var(--panel-border)] px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-widest text-[var(--fg-dimmer)]">Provider</div>
                  <div className="metric text-sm truncate">{v.provider}</div>
                </div>
              </div>
            ) : null
          }
        />
      )}
    </div></AgentWorkspaceShell>
  );
}
