"use client";

import { useEffect, useState } from "react";
import { Cpu, History, Layers, MessageSquare, Share2, Terminal, Zap } from "lucide-react";
import UnifiedChat from "@/components/UnifiedChat";
import ClaudeWorkspace from "@/components/ClaudeWorkspace";
import UltracodeView from "@/components/UltracodeView";
import ClaudeAnt from "@/components/ClaudeAnt";
import AntAgents from "@/components/AntAgents";
import ClaudeArtifacts from "@/components/ClaudeArtifacts";
import AgentHistory from "@/components/AgentHistory";
import AgentWorkspaceShell, { type WorkspaceSection } from "@/components/AgentWorkspaceShell";

type ClaudeTab = "chat" | "history" | "workspace" | "artifacts" | "ultracode" | "ant" | "agents";

export default function ClaudeRoute() {
  const [tab, setTab] = useState<ClaudeTab>("chat");
  useEffect(() => {
    const onNav = (event: Event) => {
      const d = (event as CustomEvent<{ agent?: string; section?: WorkspaceSection; target?: string }>).detail;
      if (d?.agent !== "claude") return;
      const target = d.target;
      if (target === "chat" || target === "history" || target === "workspace" || target === "artifacts" || target === "ultracode" || target === "ant" || target === "agents") {
        setTab(target);
        return;
      }
      const next: Partial<Record<WorkspaceSection, ClaudeTab>> = { new: "chat", messages: "chat", tools: "agents", artifacts: "artifacts", projects: "workspace", history: "history" };
      if (d.section && next[d.section]) setTab(next[d.section]!);
    };
    window.addEventListener("agent-workspace-nav", onNav);
    return () => window.removeEventListener("agent-workspace-nav", onNav);
  }, []);
  const section: WorkspaceSection = tab === "chat" ? "messages" : tab === "history" ? "history" : tab === "workspace" ? "projects" : tab === "artifacts" ? "artifacts" : "tools";

  return (
    <AgentWorkspaceShell agent="claude" active={section} activeTarget={tab}><div className="space-y-5">
      <div className="flex items-center gap-2 scroll-rail pb-1 -mx-1 px-1">
        {([
          { key: "chat",      label: "Chat",      icon: <MessageSquare size={14} /> },
          { key: "history",   label: "Sessions",  icon: <History size={14} /> },
          { key: "workspace", label: "Workspace", icon: <Layers size={14} /> },
          { key: "artifacts", label: "Artifacts", icon: <Share2 size={14} /> },
          { key: "ultracode", label: "Ultracode", icon: <Zap size={14} /> },
          { key: "ant",       label: "Ant CLI",   icon: <Terminal size={14} /> },
          { key: "agents",    label: "Agents",    icon: <Cpu size={14} /> },
        ] as { key: ClaudeTab; label: string; icon: React.ReactNode }[]).map((item) => {
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full border text-[12.5px] transition"
              style={{
                background: active ? "rgba(217,119,87,0.16)" : "transparent",
                borderColor: active ? "#D97757" : "var(--panel-border)",
                color: active ? "var(--fg)" : "var(--fg-dim)",
              }}
            >
              {item.icon}{item.label}
            </button>
          );
        })}
      </div>

      {tab === "chat" ? (
        <UnifiedChat defaultAgent="claude" showAgentSwitcher={false} />
      ) : tab === "history" ? (
        <AgentHistory agent="claude" />
      ) : tab === "workspace" ? (
        <ClaudeWorkspace />
      ) : tab === "artifacts" ? (
        <ClaudeArtifacts />
      ) : tab === "ultracode" ? (
        <UltracodeView />
      ) : tab === "ant" ? (
        <ClaudeAnt />
      ) : (
        <AntAgents />
      )}
    </div></AgentWorkspaceShell>
  );
}
