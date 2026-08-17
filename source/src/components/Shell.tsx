"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import Sidebar, { MobileNav } from "./Sidebar";
import TopBar from "./TopBar";
import OwnerBanner from "./OwnerBanner";
import ScrollArea from "./ScrollArea";
import SetupCenterHost from "./SetupCenterHost";
import AgentSwitcher from "./AgentSwitcher";
import ExecutionFrozenNotice from "./ExecutionFrozenNotice";

export default function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const immersiveAgent = [
    "/claude",
    "/codex",
    "/hermes",
    "/openclaw",
    "/antigravity",
  ].includes(pathname);

  if (immersiveAgent) {
    return (
      <div data-agent-os-shell data-shell-mode="immersive-agent" className="h-screen overflow-hidden">
        <main
          data-agent-os-main
          data-immersive-agent={pathname.slice(1)}
          className="h-full min-h-0 min-w-0 overflow-hidden"
        >
          {children}
        </main>
        <div className="agent-system-dock" aria-label="Agent OS system navigation">
          <AgentSwitcher />
        </div>
        <SetupCenterHost />
      </div>
    );
  }

  return (
    <div data-agent-os-shell data-shell-mode="standard" className="h-screen flex overflow-hidden">
      <Sidebar />
      <ScrollArea
        ariaLabel="Main content"
        className="flex-1 min-w-0 min-h-0"
        viewportClassName="overflow-x-hidden"
        scrollbar="auto"
        fades
      >
        <main data-agent-os-main className="min-w-0">
          <div className="max-w-[1500px] mx-auto px-4 sm:px-5 md:px-7 py-4 md:py-5 pb-24 md:pb-6">
            <OwnerBanner />
            <TopBar />
            <ExecutionFrozenNotice pathname={pathname} />
            {children}
          </div>
        </main>
      </ScrollArea>
      <MobileNav />
      <SetupCenterHost />
    </div>
  );
}
