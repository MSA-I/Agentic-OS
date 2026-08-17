import { WAVE1_FROZEN_EXECUTION_ROUTES } from "./control-plane/frozenExecutionRoutes";

/**
 * Client-safe view of the execution freeze. The manifest module is pure data, so
 * a browser component can ask the same question the server guard answers, and a
 * control can say it is disabled instead of firing a request that returns 503.
 */
export const FROZEN_EXECUTION_PATHS: ReadonlySet<string> = new Set(
  WAVE1_FROZEN_EXECUTION_ROUTES.map((route) => route.slice(route.indexOf(" ") + 1)),
);

export function isFrozenExecutionPath(apiPath: string): boolean {
  const path = apiPath.split("?", 1)[0].replace(/\/+$/u, "");
  return FROZEN_EXECUTION_PATHS.has(path || apiPath);
}

/** One wording for every disabled control, so the app explains this once. */
export const EXECUTION_FROZEN_COPY = {
  title: "Actions on this page are disabled",
  body: "The control-plane repair keeps every execution route fail-closed. Nothing is sent, nothing is queued, and no run is created. Reading history, sessions and files still works.",
  nextAction: "Codex and Claude run from their own pages through the Workbench. The other agents and app actions return once their wave of the repair is verified.",
  controlTitle: "Disabled while the control plane is repaired: this action would fail closed with no run created.",
} as const;
