import type { RunStatus } from "./types";

export const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "blocked",
]);

const LEGAL_RUN_TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  requested: new Set(["queued", "blocked", "failed", "cancelled"]),
  queued: new Set(["claimed", "starting", "running", "stopping", "blocked", "failed", "cancelled", "orphaned"]),
  claimed: new Set(["queued", "starting", "stopping", "blocked", "failed", "cancelled", "orphaned"]),
  starting: new Set(["running", "stopping", "blocked", "failed", "cancelled", "orphaned"]),
  running: new Set(["awaiting_approval", "stopping", "succeeded", "blocked", "failed", "cancelled", "orphaned"]),
  awaiting_approval: new Set(["running", "stopping", "blocked", "failed", "cancelled", "orphaned"]),
  stopping: new Set(["succeeded", "blocked", "cancelled", "failed", "orphaned"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  orphaned: new Set(["queued", "blocked", "failed", "cancelled"]),
  blocked: new Set(),
};

export function isLegalRunTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true;
  return LEGAL_RUN_TRANSITIONS[from]?.has(to) ?? false;
}

export function legalRunTransitionsFrom(status: RunStatus): readonly RunStatus[] {
  return [...(LEGAL_RUN_TRANSITIONS[status] ?? [])];
}

export class IllegalRunTransitionError extends Error {
  readonly from: RunStatus;
  readonly to: RunStatus;

  constructor(from: RunStatus, to: RunStatus) {
    super(`Illegal Workbench run transition: ${from} -> ${to}.`);
    this.name = "IllegalRunTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertLegalRunTransition(from: RunStatus, to: RunStatus): void {
  if (!isLegalRunTransition(from, to)) throw new IllegalRunTransitionError(from, to);
}
