"use client";

import { useEffect, useState } from "react";
import { Box } from "lucide-react";
import AgentRoom from "@/components/AgentRoom";
import UnifiedChat from "@/components/UnifiedChat";
import OpenClawWorkspace from "@/components/OpenClawWorkspace";
import OpenClawStudio from "@/components/OpenClawStudio";
import AgentHistory from "@/components/AgentHistory";
import AgentWorkspaceShell, { type WorkspaceSection } from "@/components/AgentWorkspaceShell";

type OcTab = "chat" | "sessions" | "studio" | "workspace" | "control";
interface OcVitals { ok: boolean; gateway: string; degraded: boolean; busy?: boolean; agents: string[]; sessions: number; }

export default function OpenClawRoute() {
  const [tab, setTab] = useState<OcTab>("chat");
  const [v, setV] = useState<OcVitals | null>(null);
  useEffect(() => {
    const onNav = (event: Event) => {
      const d = (event as CustomEvent<{ agent?: string; section?: WorkspaceSection; target?: string }>).detail;
      if (d?.agent !== "openclaw") return;
      const target = d.target;
      if (target === "chat" || target === "sessions" || target === "studio" || target === "workspace" || target === "control") {
        setTab(target);
        return;
      }
      const next: Partial<Record<WorkspaceSection, OcTab>> = { new: "chat", messages: "chat", tools: "control", artifacts: "studio", projects: "workspace", history: "sessions" };
      if (d.section && next[d.section]) setTab(next[d.section]!);
    };
    window.addEventListener("agent-workspace-nav", onNav);
    return () => window.removeEventListener("agent-workspace-nav", onNav);
  }, []);

  useEffect(() => {
    let stop = false;
    const fetchIt = async () => {
      try {
        const r = await fetch("/api/vitals", { cache: "no-store" });
        const j = await r.json();
        if (!stop) setV(j.openclaw);
      } catch { /* ignore */ }
    };
    fetchIt();
    const t = setInterval(fetchIt, 8000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  const section: WorkspaceSection = tab === "chat" ? "messages" : tab === "sessions" ? "history" : tab === "workspace" ? "projects" : tab === "studio" ? "artifacts" : "tools";
  return (
    <AgentWorkspaceShell agent="openclaw" active={section} activeTarget={tab}><div data-agent-page="openclaw" data-active-tab={tab} className={`h-full min-h-0 ${tab === "chat" ? "overflow-hidden" : "overflow-y-auto p-4 md:p-5"}`}>
      {tab === "chat" ? (
        <UnifiedChat defaultAgent="openclaw" showAgentSwitcher={false} />
      ) : tab === "sessions" ? (
        <AgentHistory agent="openclaw" />
      ) : tab === "studio" ? (
        <OpenClawStudio />
      ) : tab === "workspace" ? (
        <OpenClawWorkspace />
      ) : (
        <AgentRoom
          agent="openclaw"
          accent="#F5654A"
          accentDim="rgba(245,101,74,0.12)"
          defaultTab="health"
          tabs={[
            { key: "health",  label: "Health",   action: "health",  hint: "gateway" },
            { key: "agents",  label: "Agents",   action: "agents",  hint: "list" },
            { key: "doctor",  label: "Doctor",   action: "doctor",  hint: "diag" },
            { key: "logs",    label: "Logs",     action: "logs",    hint: "tail" },
            { key: "cron",    label: "Cron",     action: "cron",    hint: "scheduler" },
            { key: "memory",  label: "Memory",   action: "memory",  hint: "store" },
          ]}
          vitals={
            v ? (
              <div className="panel p-4 space-y-3">
                <div className="flex items-center gap-2.5">
                  <div className="grid place-items-center w-10 h-10 rounded-xl"
                    style={{ background: "rgba(245,101,74,0.18)", color: "#F5654A" }}>
                    <Box size={18} />
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-[var(--fg-dimmer)]">Gateway</div>
                    <div className="text-sm font-medium" style={{ color: "#F6F5F3" }}>
                      {v.degraded ? "Degraded" : v.busy ? "Busy" : v.ok ? "Nominal" : "Down"}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-[var(--panel-border)] px-2.5 py-1.5">
                    <div className="text-[10px] uppercase tracking-widest text-[var(--fg-dimmer)]">Agents</div>
                    <div className="metric text-base">{v.agents.length}</div>
                  </div>
                  <div className="rounded-lg border border-[var(--panel-border)] px-2.5 py-1.5">
                    <div className="text-[10px] uppercase tracking-widest text-[var(--fg-dimmer)]">Sessions</div>
                    <div className="metric text-base">{v.sessions}</div>
                  </div>
                </div>
                <div className="text-[11px] text-[var(--fg-dim)] leading-relaxed">
                  {v.agents.map((a) => (
                    <span key={a} className="inline-block mr-1 mb-1 px-2 py-0.5 rounded-md bg-[rgba(245,101,74,0.08)] border border-[rgba(245,101,74,0.18)]">
                      {a}
                    </span>
                  ))}
                </div>
              </div>
            ) : null
          }
        />
      )}
    </div></AgentWorkspaceShell>
  );
}
