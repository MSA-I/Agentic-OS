export const WORKBENCH_PROVIDERS = [
  "codex",
  "claude",
  "hermes",
  "openclaw",
  "antigravity",
] as const;

export type WorkbenchProvider = (typeof WORKBENCH_PROVIDERS)[number];

export const ADAPTER_CAPABILITIES = [
  "list",
  "load",
  "start",
  "resume",
  "queue",
  "cancel",
  "approval",
  "artifacts",
] as const;

export type AdapterCapabilityName = (typeof ADAPTER_CAPABILITIES)[number];

export type CapabilityAvailability =
  | { status: "supported"; detail?: string }
  | { status: "unsupported"; reason: string };

export type AgentCapabilities = Record<AdapterCapabilityName, CapabilityAvailability>;

export interface AgentDescriptor {
  id: string;
  provider: WorkbenchProvider;
  label: string;
  runtime: string;
  capabilities: AgentCapabilities;
}

export type WorkEnvironment = "local" | "worktree";

export type WorkbenchPanel =
  | "transcript"
  | "activity"
  | "review"
  | "diff"
  | "terminal"
  | "browser"
  | "files"
  | "artifacts"
  | "settings"
  | "tasks";

export interface WorkContext {
  agentId: string;
  actorId: string | null;
  projectId: string | null;
  sessionId: string | null;
  environment: WorkEnvironment;
  panel: WorkbenchPanel;
}

export const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "orphaned",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunError {
  code: string;
  message: string;
}

export interface Run {
  id: string;
  adapterId: string;
  provider: WorkbenchProvider;
  context: WorkContext;
  title: string | null;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  pid: number | null;
  error: RunError | null;
  metadata: Record<string, unknown>;
}

export const RUN_EVENT_TYPES = [
  "message",
  "reasoning",
  "tool",
  "terminal",
  "diff",
  "artifact",
  "status",
  "error",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export interface RunEvent {
  id: string;
  sequence: number;
  runId: string;
  type: RunEventType;
  createdAt: string;
  /** Operational payload only. Native transcript bodies are never mirrored here. */
  payload: Record<string, unknown>;
}

export type ApprovalRisk = "low" | "medium" | "high" | "critical";
export type ApprovalDecision = "allow_once" | "allow_session" | "deny";
export type ApprovalStatus = "pending" | ApprovalDecision;

export interface ApprovalRequest {
  id: string;
  runId: string;
  risk: ApprovalRisk;
  summary: string;
  redactedAction: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export type MessageMode = "steer" | "queue";

export interface QueuedMessage {
  id: string;
  runId: string;
  mode: MessageMode;
  content: string;
  createdAt: string;
  deliveredAt: string | null;
}

export interface WorkbenchDraft {
  id: string;
  context: WorkContext;
  content: string;
  updatedAt: string;
}

export interface NativeSessionSummary {
  id: string;
  actorId: string | null;
  projectId: string | null;
  title: string | null;
  updatedAt: string | null;
  metadata?: Record<string, unknown>;
}

export interface NativeArtifact {
  id: string;
  kind: string;
  label: string;
  uri: string;
  metadata?: Record<string, unknown>;
}

export type AdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "unsupported" | "not_found" | "conflict" | "failed"; message: string };

export interface AdapterRuntime {
  emit(type: RunEventType, payload: Record<string, unknown>): RunEvent;
  setStatus(status: RunStatus, error?: RunError | null): Run;
}

export interface WorkbenchAdapter {
  readonly descriptor: AgentDescriptor;
  list(context: WorkContext): Promise<AdapterResult<NativeSessionSummary[]>>;
  load(sessionId: string, context: WorkContext): Promise<AdapterResult<NativeSessionSummary>>;
  start(run: Run, runtime: AdapterRuntime): Promise<AdapterResult<void>>;
  resume(run: Run, runtime: AdapterRuntime): Promise<AdapterResult<void>>;
  queue(run: Run, message: QueuedMessage, runtime: AdapterRuntime): Promise<AdapterResult<{ delivered: boolean }>>;
  cancel(run: Run, runtime: AdapterRuntime): Promise<AdapterResult<void>>;
  approve(run: Run, request: ApprovalRequest, decision: ApprovalDecision, runtime: AdapterRuntime): Promise<AdapterResult<void>>;
  artifacts(run: Run): Promise<AdapterResult<NativeArtifact[]>>;
}
