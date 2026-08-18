/**
 * The shapes the availability API returns, kept in a module with no imports so
 * the browser can use them without dragging in the server-only probe code.
 */

export type InstallAgentId = "claude" | "codex" | "hermes";

export type InstallAgentBlockReason =
  | "not_installed"
  | "not_authenticated"
  | "circuit_open"
  | "quota_blocked"
  | "identity_invalidated"
  | "identity_changed"
  | "probe_timeout"
  | "probe_failed"
  | "capacity"
  | "transport_unavailable";

export interface InstallAgentFix {
  kind: "restart" | "wait" | "setup" | "auth" | "none";
  label: string;
  /** Setup Center route to open, when the fix lives there. */
  route?: string;
  /** Command the user runs themselves. Never executed by Agent OS. */
  command?: string;
  /** ISO timestamp the block is expected to clear at, when one is known. */
  at?: string;
}

export interface InstallAgentStatus {
  id: InstallAgentId;
  label: string;
  transport: "workbench" | "unavailable";
  available: boolean;
  blockedBy: InstallAgentBlockReason | null;
  reason: string;
  fix: InstallAgentFix | null;
  latencyMs: number | null;
}

export interface InstallAgentAvailability {
  version: 1;
  checkedAt: string;
  agents: InstallAgentStatus[];
  selected: InstallAgentId | null;
  capacity: { activeRuns: number; maxActiveRuns: number; saturated: boolean };
}
