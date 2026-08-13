"use client";

import { useEffect, useState } from "react";
import FreeClaudePanel from "@/components/FreeClaudePanel";
import SpeakBuild from "@/components/SpeakBuild";
import AgentWorkspaceShell, { type WorkspaceNavDetail, type WorkspaceSection } from "@/components/AgentWorkspaceShell";

export default function FreeClaudeRoute() {
  const [view, setView] = useState<"speak" | "panel">("panel");
  const [target, setTarget] = useState<"factory" | "chat" | "workspace">("chat");

  useEffect(() => {
    const onNav = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceNavDetail>).detail;
      if (detail?.agent !== "freeclaude") return;
      const next = detail.target === "factory" ? "factory" : detail.target === "workspace" || detail.section === "projects" ? "workspace" : "chat";
      setTarget(next);
      setView(next === "factory" ? "speak" : "panel");
    };
    window.addEventListener("agent-workspace-nav", onNav);
    return () => window.removeEventListener("agent-workspace-nav", onNav);
  }, []);

  const section: WorkspaceSection = target === "factory" ? "tools" : target === "workspace" ? "projects" : "messages";
  return (
    <AgentWorkspaceShell agent="freeclaude" active={section} activeTarget={target}><div data-agent-page="freeclaude" data-active-tab={target} className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Both stay MOUNTED — we only hide with CSS. Switching tabs no longer
          unmounts Speak & Build, so its history, gallery, and live preview all
          survive the switch. */}
      <div className={view === "speak" ? "h-full overflow-y-auto p-4 md:p-5" : "hidden"}>
        <SpeakBuild />
      </div>
      <div className={view === "panel" ? "flex h-full min-h-0 flex-col" : "hidden"}>
        <FreeClaudePanel activeTab={target === "workspace" ? "workspace" : "chat"} />
      </div>
    </div></AgentWorkspaceShell>
  );
}
