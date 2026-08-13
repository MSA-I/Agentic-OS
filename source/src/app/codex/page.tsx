import { Suspense } from "react";
import CodexDesktop from "@/components/CodexDesktop";

export default function CodexRoute() {
  return (
    <Suspense fallback={<div className="workbench-route-loading" role="status">Loading Codex workspace</div>}>
      <CodexDesktop />
    </Suspense>
  );
}
