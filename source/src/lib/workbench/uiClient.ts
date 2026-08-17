import type {
  Run,
  RunEvent,
  RunStatus,
  WorkEnvironment,
  WorkbenchPanel,
} from "./types";

export type WorkbenchPilotProvider = "codex" | "claude";
export type WorkbenchErrorCategory =
  | "quota"
  | "auth"
  | "timeout"
  | "identity"
  | "containment"
  | "policy"
  | "unsupported"
  | "unavailable"
  | "validation"
  | "unknown";

export type WorkbenchStopState =
  | "not_requested"
  | "stopping"
  | "stopped_and_verified"
  | "failed_to_stop";

export interface WorkbenchRunSnapshot {
  run: Run;
  stop: {
    state: WorkbenchStopState;
    verified: boolean;
  };
}

export interface WorkbenchStartInput {
  agentId: WorkbenchPilotProvider;
  prompt: string;
  projectId?: string | null;
  sessionId?: string | null;
  environment?: WorkEnvironment;
  panel?: WorkbenchPanel;
  idempotencyKey?: string;
}

export interface WorkbenchStartPayload {
  agentId: WorkbenchPilotProvider;
  prompt: string;
  idempotencyKey: string;
  context: {
    agentId: WorkbenchPilotProvider;
    actorId: WorkbenchPilotProvider;
    projectId: string;
    sessionId: string | null;
    environment: WorkEnvironment;
    panel: WorkbenchPanel;
  };
  identity: {
    actorId: WorkbenchPilotProvider;
    projectId: string;
    worktreeId: WorkEnvironment;
    provider: WorkbenchPilotProvider;
    profileId: null;
    nativeSessionId: string | null;
    runId: string;
  };
}

export interface WorkbenchStartResponse {
  run: Run;
  commandId: string;
  created: boolean;
  operation: "start" | "resume";
}

export interface WorkbenchErrorPayload {
  error: string;
  code: string;
  category: WorkbenchErrorCategory;
  runCreated: boolean;
  retrySafe: boolean;
  nextAction: string;
}

export interface WorkbenchRunHandlers {
  onStarted?: (response: WorkbenchStartResponse) => void;
  onEvent?: (event: RunEvent) => void;
  onOutput?: (text: string, event: RunEvent) => void;
  onStatus?: (status: RunStatus, event: RunEvent) => void;
}

interface EventSourceLike {
  close(): void;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  onerror: ((event: Event) => void) | null;
}

export interface WorkbenchClientDependencies {
  fetch?: typeof fetch;
  eventSource?: (url: string) => EventSourceLike;
  randomUUID?: () => string;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

const TERMINAL_STATUSES = new Set<RunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "orphaned",
  "blocked",
]);

const STREAM_EVENT_TYPES = [
  "message",
  "reasoning",
  "tool",
  "terminal",
  "diff",
  "artifact",
  "status",
  "error",
  "snapshot",
] as const;

export class WorkbenchClientError extends Error implements WorkbenchErrorPayload {
  readonly error: string;
  readonly code: string;
  readonly category: WorkbenchErrorCategory;
  readonly runCreated: boolean;
  readonly retrySafe: boolean;
  readonly nextAction: string;

  constructor(payload: WorkbenchErrorPayload) {
    super(payload.error);
    this.name = "WorkbenchClientError";
    this.error = payload.error;
    this.code = payload.code;
    this.category = payload.category;
    this.runCreated = payload.runCreated;
    this.retrySafe = payload.retrySafe;
    this.nextAction = payload.nextAction;
  }
}

function defaultEventSource(url: string): EventSourceLike {
  return new EventSource(url, { withCredentials: true }) as EventSourceLike;
}

function randomId(dependencies: WorkbenchClientDependencies): string {
  if (dependencies.randomUUID) return dependencies.randomUUID();
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createWorkbenchIdempotencyKey(
  agentId: WorkbenchPilotProvider,
  dependencies: WorkbenchClientDependencies = {},
): string {
  return `${agentId}-${randomId(dependencies)}`;
}

export function workbenchProjectId(
  agentId: WorkbenchPilotProvider,
  projectId?: string | null,
): string {
  return projectId?.trim() || `${agentId}-default`;
}

export function buildWorkbenchStartPayload(
  input: WorkbenchStartInput,
  dependencies: WorkbenchClientDependencies = {},
): WorkbenchStartPayload {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Workbench prompt is required.");
  const projectId = workbenchProjectId(input.agentId, input.projectId);
  const environment = input.environment ?? "local";
  const sessionId = input.sessionId?.trim() || null;
  const idempotencyKey = input.idempotencyKey
    ?? createWorkbenchIdempotencyKey(input.agentId, dependencies);
  const context: WorkbenchStartPayload["context"] = {
    agentId: input.agentId,
    actorId: input.agentId,
    projectId,
    sessionId,
    environment,
    panel: input.panel ?? "transcript",
  };
  const payload: WorkbenchStartPayload = {
    agentId: input.agentId,
    prompt,
    idempotencyKey,
    context,
    identity: {
      actorId: input.agentId,
      projectId,
      worktreeId: environment,
      provider: input.agentId,
      profileId: null,
      nativeSessionId: sessionId,
      runId: idempotencyKey,
    },
  };
  return payload;
}

function fallbackCategory(status: number): WorkbenchErrorCategory {
  if (status === 401) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status === 400 || status === 413 || status === 415 || status === 422) return "validation";
  if (status === 403) return "policy";
  if (status === 501) return "unsupported";
  if (status === 503) return "unavailable";
  return "unknown";
}

async function responseError(response: Response, fallback: string): Promise<WorkbenchClientError> {
  const raw = await response.json().catch(() => null) as Partial<WorkbenchErrorPayload> | null;
  return new WorkbenchClientError({
    error: typeof raw?.error === "string" && raw.error.trim() ? raw.error : fallback,
    code: typeof raw?.code === "string" && raw.code.trim() ? raw.code : `http_${response.status}`,
    category: raw?.category ?? fallbackCategory(response.status),
    runCreated: raw?.runCreated === true,
    retrySafe: raw?.retrySafe === true,
    nextAction: typeof raw?.nextAction === "string" && raw.nextAction.trim()
      ? raw.nextAction
      : "Check the selected target and Workbench setup, then try again.",
  });
}

async function rotateWorkbenchSession(
  signal: AbortSignal | undefined,
  dependencies: WorkbenchClientDependencies,
): Promise<void> {
  const fetcher = dependencies.fetch ?? fetch;
  const response = await fetcher("/api/workbench/session", {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw await responseError(response, `Workbench session unavailable (${response.status}).`);
  }
  await response.json().catch(() => null);
}

export async function startWorkbenchRun(
  input: WorkbenchStartInput,
  signal?: AbortSignal,
  dependencies: WorkbenchClientDependencies = {},
): Promise<WorkbenchStartResponse> {
  const fetcher = dependencies.fetch ?? fetch;
  const payload = buildWorkbenchStartPayload(input, dependencies);
  await rotateWorkbenchSession(signal, dependencies);
  const response = await fetcher("/api/workbench/runs", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    throw await responseError(response, `Workbench could not start ${input.agentId} (${response.status}).`);
  }
  return await response.json() as WorkbenchStartResponse;
}

export async function getWorkbenchRun(
  runId: string,
  signal?: AbortSignal,
  dependencies: WorkbenchClientDependencies = {},
): Promise<WorkbenchRunSnapshot> {
  const fetcher = dependencies.fetch ?? fetch;
  const response = await fetcher(`/api/workbench/runs/${encodeURIComponent(runId)}`, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw await responseError(response, `Workbench run could not be loaded (${response.status}).`);
  }
  return await response.json() as WorkbenchRunSnapshot;
}

function eventOutput(event: RunEvent): string {
  if (event.type === "terminal" && event.payload.channel === "stdout") {
    return typeof event.payload.text === "string" ? event.payload.text : "";
  }
  if (event.type === "message") {
    for (const value of [event.payload.text, event.payload.content, event.payload.delta]) {
      if (typeof value === "string") return value;
    }
  }
  return "";
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isVerifiedCancellation(snapshot: WorkbenchRunSnapshot): boolean {
  return snapshot.run.status === "cancelled"
    && snapshot.stop.state === "stopped_and_verified"
    && snapshot.stop.verified;
}

export function watchWorkbenchRun(
  run: Run,
  handlers: WorkbenchRunHandlers = {},
  signal?: AbortSignal,
  dependencies: WorkbenchClientDependencies = {},
): Promise<WorkbenchRunSnapshot> {
  if (isTerminalRunStatus(run.status)) return getWorkbenchRun(run.id, signal, dependencies);
  const createSource = dependencies.eventSource ?? defaultEventSource;
  const source = createSource(`/api/workbench/runs/${encodeURIComponent(run.id)}/events?after=0`);
  let cursor = 0;
  let settled = false;
  let finalRefresh: Promise<void> | null = null;
  const listeners = new Map<string, (event: MessageEvent<string>) => void>();

  return new Promise<WorkbenchRunSnapshot>((resolve, reject) => {
    const cleanup = () => {
      source.close();
      source.onerror = null;
      for (const [type, listener] of listeners) source.removeEventListener(type, listener);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (result: WorkbenchRunSnapshot) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const refreshTerminal = () => {
      if (!finalRefresh) {
        finalRefresh = getWorkbenchRun(run.id, signal, dependencies)
          .then(finish)
          .catch(fail);
      }
    };
    const abort = () => fail(new DOMException("Workbench event stream closed.", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });

    const listener = (message: MessageEvent<string>) => {
      let event: RunEvent;
      try {
        event = JSON.parse(message.data) as RunEvent;
      } catch {
        return;
      }
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= cursor) return;
      cursor = event.sequence;
      handlers.onEvent?.(event);
      const output = eventOutput(event);
      if (output) handlers.onOutput?.(output, event);
      if (event.type === "status" && typeof event.payload.status === "string") {
        const status = event.payload.status as RunStatus;
        handlers.onStatus?.(status, event);
        if (isTerminalRunStatus(status)) refreshTerminal();
      }
    };
    for (const type of STREAM_EVENT_TYPES) {
      listeners.set(type, listener);
      source.addEventListener(type, listener);
    }
    source.onerror = () => {
      void getWorkbenchRun(run.id, signal, dependencies)
        .then((snapshot) => {
          if (isTerminalRunStatus(snapshot.run.status)) finish(snapshot);
        })
        .catch(() => {
          // EventSource reconnects automatically. A later status event or abort
          // will settle the lifecycle without pretending the run failed.
        });
    };
  });
}

export async function executeWorkbenchRun(
  input: WorkbenchStartInput,
  handlers: WorkbenchRunHandlers = {},
  signal?: AbortSignal,
  dependencies: WorkbenchClientDependencies = {},
): Promise<WorkbenchRunSnapshot> {
  const started = await startWorkbenchRun(input, signal, dependencies);
  handlers.onStarted?.(started);
  return watchWorkbenchRun(started.run, handlers, signal, dependencies);
}

export async function cancelWorkbenchRun(
  run: Run,
  onSnapshot?: (snapshot: WorkbenchRunSnapshot) => void,
  signal?: AbortSignal,
  dependencies: WorkbenchClientDependencies = {},
): Promise<WorkbenchRunSnapshot> {
  const fetcher = dependencies.fetch ?? fetch;
  const provider = run.provider as WorkbenchPilotProvider;
  const projectId = workbenchProjectId(provider, run.context.projectId);
  await rotateWorkbenchSession(signal, dependencies);
  const response = await fetcher(`/api/workbench/runs/${encodeURIComponent(run.id)}/cancel`, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      identity: {
        actorId: provider,
        projectId,
        worktreeId: run.context.environment,
        provider,
        profileId: null,
        nativeSessionId: run.context.sessionId,
        runId: run.id,
      },
    }),
    signal,
  });
  if (!response.ok) {
    throw await responseError(response, `Workbench could not stop run ${run.id} (${response.status}).`);
  }
  await response.json().catch(() => null);

  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const deadline = now() + 30_000;
  while (now() <= deadline) {
    const snapshot = await getWorkbenchRun(run.id, signal, dependencies);
    onSnapshot?.(snapshot);
    if (isVerifiedCancellation(snapshot)) return snapshot;
    if (snapshot.stop.state === "failed_to_stop") {
      throw new WorkbenchClientError({
        error: "Workbench could not verify process-tree termination.",
        code: "stop_verification_failed",
        category: "containment",
        runCreated: true,
        retrySafe: true,
        nextAction: "Inspect the run and retry Stop; do not treat it as cancelled.",
      });
    }
    if (isTerminalRunStatus(snapshot.run.status) && snapshot.run.status !== "cancelled") {
      return snapshot;
    }
    await wait(250);
  }
  throw new WorkbenchClientError({
    error: "Stop was requested, but termination was not verified in time.",
    code: "stop_verification_timeout",
    category: "timeout",
    runCreated: true,
    retrySafe: true,
    nextAction: "Keep the run visible and retry Stop; do not report it as cancelled.",
  });
}

export function describeWorkbenchError(error: unknown, draftSaved = true): string {
  if (error instanceof WorkbenchClientError) {
    const retry = error.retrySafe ? "Retry is safe." : "Do not retry until the target is corrected.";
    return [
      `[${error.category}] ${error.message}`,
      error.nextAction,
      retry,
      draftSaved ? "Your draft was kept." : "",
    ].filter(Boolean).join(" ");
  }
  const message = error instanceof Error ? error.message : String(error);
  return `${message}${draftSaved ? " Your draft was kept." : ""}`;
}

export function workbenchRunLabel(run: Run | null, stop: WorkbenchStopState): string {
  if (!run) return "No run";
  if (stop === "stopping") return "Stopping";
  if (stop === "stopped_and_verified") return "Stopped · verified";
  if (stop === "failed_to_stop") return "Stop failed";
  return `${run.status} · ${run.id.slice(0, 8)}`;
}
