import {
  WORKBENCH_PROVIDERS,
  type WorkContext,
  type WorkbenchPanel,
  type WorkEnvironment,
} from "./types";

const PANELS = new Set<WorkbenchPanel>([
  "transcript", "activity", "review", "diff", "terminal", "browser",
  "files", "artifacts", "settings", "tasks",
]);

const SAFE_ID = /^[A-Za-z0-9_.:@/-]{1,240}$/;

function nullableId(value: string | null): string | null {
  return value && SAFE_ID.test(value) ? value : null;
}

/** Parse the URL-owned work context without consulting localStorage or an event bus. */
export function parseWorkContext(
  input: URL | URLSearchParams,
  defaults: Pick<WorkContext, "agentId"> & Partial<WorkContext>,
): WorkContext {
  const params = input instanceof URL ? input.searchParams : input;
  const requestedAgent = params.get("agent");
  const agentId = requestedAgent && WORKBENCH_PROVIDERS.includes(requestedAgent as never)
    ? requestedAgent
    : defaults.agentId;
  const environment = params.get("environment") === "worktree"
    ? "worktree"
    : (defaults.environment ?? "local") as WorkEnvironment;
  const requestedPanel = params.get("panel") as WorkbenchPanel | null;

  return {
    agentId,
    actorId: nullableId(params.get("actor")) ?? defaults.actorId ?? null,
    projectId: nullableId(params.get("project")) ?? defaults.projectId ?? null,
    sessionId: nullableId(params.get("session")) ?? defaults.sessionId ?? null,
    environment,
    panel: requestedPanel && PANELS.has(requestedPanel)
      ? requestedPanel
      : defaults.panel ?? "transcript",
  };
}

export function writeWorkContext(url: URL, context: WorkContext): URL {
  const next = new URL(url);
  next.searchParams.set("agent", context.agentId);
  next.searchParams.set("environment", context.environment);
  next.searchParams.set("panel", context.panel);
  for (const [key, value] of [
    ["actor", context.actorId],
    ["project", context.projectId],
    ["session", context.sessionId],
  ] as const) {
    if (value) next.searchParams.set(key, value);
    else next.searchParams.delete(key);
  }
  return next;
}
