import type { ReactNode } from "react";
import Sidebar, { MobileNav } from "./Sidebar";
import TopBar from "./TopBar";
import OwnerBanner from "./OwnerBanner";
import ScrollArea from "./ScrollArea";
import SetupCenterHost from "./SetupCenterHost";

export default function Shell({ children }: { children: ReactNode }) {
  return (
    <div data-agent-os-shell className="h-screen flex overflow-hidden">
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
            {children}
          </div>
        </main>
      </ScrollArea>
      <MobileNav />
      <SetupCenterHost />
    </div>
  );
}
