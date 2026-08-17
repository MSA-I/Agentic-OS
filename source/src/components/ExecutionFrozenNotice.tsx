"use client";

import { AlertTriangle } from "lucide-react";
import { EXECUTION_FROZEN_COPY } from "@/lib/executionAvailability";
import { frozenPathsForRoute } from "@/lib/executionFrozenSurfaces";

/**
 * Says out loud that this page's actions are fail-closed. Rendered from the shell
 * for every route whose components mutate a frozen execution route, so the user
 * reads it before pressing a control instead of after a 503. Not dismissible: it
 * describes what the server will actually do.
 */
export default function ExecutionFrozenNotice({ pathname }: { pathname: string }) {
  const paths = frozenPathsForRoute(pathname);
  if (paths.length === 0) return null;

  return (
    <section
      role="status"
      data-execution-frozen={pathname}
      aria-label="Actions on this page are disabled"
      style={{
        display: "flex", gap: "12px", alignItems: "flex-start",
        padding: "12px 14px", marginBottom: "14px",
        background: "rgba(217,179,106,.08)",
        border: "1px solid rgba(217,179,106,.32)",
        borderRadius: "12px",
        fontSize: "13px", lineHeight: 1.5,
      }}
    >
      <AlertTriangle size={17} style={{ flexShrink: 0, marginTop: "2px", color: "#d9b36a" }} aria-hidden />
      <div style={{ minWidth: 0 }}>
        <strong style={{ display: "block", fontSize: "13.5px" }}>{EXECUTION_FROZEN_COPY.title}</strong>
        <p style={{ margin: "4px 0 0", opacity: 0.82 }}>{EXECUTION_FROZEN_COPY.body}</p>
        <p style={{ margin: "4px 0 0", opacity: 0.82 }}>{EXECUTION_FROZEN_COPY.nextAction}</p>
        <details style={{ marginTop: "6px" }}>
          <summary style={{ cursor: "pointer", opacity: 0.7 }}>
            {paths.length} disabled {paths.length === 1 ? "endpoint" : "endpoints"} on this page
          </summary>
          <ul style={{ margin: "6px 0 0", paddingInlineStart: "18px", opacity: 0.7 }}>
            {paths.map((path) => <li key={path}><code>{path}</code></li>)}
          </ul>
        </details>
      </div>
    </section>
  );
}
