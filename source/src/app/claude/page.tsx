"use client";

import { useEffect, useState } from "react";
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
    <AgentWorkspaceShell agent="claude" active={section} activeTarget={tab}><div data-agent-page="claude" className="h-full min-h-0 overflow-hidden">
      {tab === "chat" ? (
        <UnifiedChat defaultAgent="claude" showAgentSwitcher={false} height="100%" />
      ) : tab === "history" ? (
        <div data-agent-tool-panel className="h-full overflow-y-auto p-5"><AgentHistory agent="claude" /></div>
      ) : tab === "workspace" ? (
        <div data-agent-tool-panel className="h-full overflow-y-auto p-5"><ClaudeWorkspace /></div>
      ) : tab === "artifacts" ? (
        <div data-agent-tool-panel className="h-full overflow-y-auto p-5"><ClaudeArtifacts /></div>
      ) : tab === "ultracode" ? (
        <div data-agent-tool-panel className="h-full overflow-y-auto p-5"><UltracodeView /></div>
      ) : tab === "ant" ? (
        <div data-agent-tool-panel className="h-full overflow-y-auto p-5"><ClaudeAnt /></div>
      ) : (
        <div data-agent-tool-panel className="h-full overflow-y-auto p-5"><AntAgents /></div>
      )}
    </div></AgentWorkspaceShell>
  );
}
