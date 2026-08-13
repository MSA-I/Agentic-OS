import "server-only";

import { getWorkbenchAdapter } from "./adapters";
import { redactRecord, redactText } from "./redaction";
import {
  WorkbenchConflictError,
  WorkbenchNotFoundError,
  WorkbenchUnsupportedError,
} from "./supervisor";
import {
  RUN_STATUSES,
  WORKBENCH_PROVIDERS,
  type ApprovalDecision,
  type MessageMode,
  type RunStatus,
  type WorkbenchPanel,
  type WorkbenchProvider,
  type WorkContext,
} from "./types";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const SAFE_ID = /^[A-Za-z0-9_.:@/-]{1,240}$/;
const PANELS = new Set<WorkbenchPanel>([
  "transcript", "activity", "review", "diff", "terminal", "browser",
  "files", "artifacts", "settings", "tasks",
]);

export class WorkbenchValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeId(value: unknown, name: string, nullable = false): string | null {
  if (nullable && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new WorkbenchValidationError(`${name} is invalid.`);
  }
  return value;
}

function requestOrigin(request: Request): URL | null {
  try {
    const requestUrl = new URL(request.url);
    const host = request.headers.get("host")?.trim();
    if (!host || !LOOPBACK_HOSTS.has(requestUrl.hostname.toLowerCase())) return null;
    const origin = new URL(`${requestUrl.protocol}//${host}`);
    if (!LOOPBACK_HOSTS.has(origin.hostname.toLowerCase())) return null;
    if (origin.protocol !== "http:" && origin.protocol !== "https:") return null;
    return origin;
  } catch {
    return null;
  }
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

export function authorizeWorkbenchRead(request: Request): void {
  if (!requestOrigin(request)) {
    throw new WorkbenchValidationError("Workbench APIs are available only through this app on localhost.", 403);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    throw new WorkbenchValidationError("Cross-site Workbench requests are not allowed.", 403);
  }
}

export function authorizeWorkbenchMutation(request: Request): void {
  const expected = requestOrigin(request);
  if (!expected) {
    throw new WorkbenchValidationError("Workbench actions are available only through this app on localhost.", 403);
  }
  const origin = request.headers.get("origin");
  if (!origin) throw new WorkbenchValidationError("Workbench actions require a browser Origin header.", 403);
  let caller: URL;
  try { caller = new URL(origin); }
  catch { throw new WorkbenchValidationError("Workbench action Origin is invalid.", 403); }
  if (!LOOPBACK_HOSTS.has(caller.hostname.toLowerCase())
    || caller.protocol !== expected.protocol
    || effectivePort(caller) !== effectivePort(expected)) {
    throw new WorkbenchValidationError("Workbench action Origin must match this local app.", 403);
  }
}

export async function readWorkbenchJson(request: Request, maximumBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new WorkbenchValidationError("Content-Type must be application/json.", 415);
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new WorkbenchValidationError("Request body is too large.", 413);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new WorkbenchValidationError("Request body is too large.", 413);
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new WorkbenchValidationError("Request body must be valid JSON."); }
  if (!isRecord(value)) throw new WorkbenchValidationError("Request body must be a JSON object.");
  return value;
}

export interface ValidatedCreateRun {
  adapterId: string;
  provider: WorkbenchProvider;
  context: WorkContext;
  title: string | null;
  metadata: Record<string, unknown>;
}

export function validateCreateRun(body: Record<string, unknown>): ValidatedCreateRun {
  const adapterId = safeId(body.agentId ?? body.adapterId, "agentId")!;
  const adapter = getWorkbenchAdapter(adapterId);
  if (!adapter || !WORKBENCH_PROVIDERS.includes(adapter.descriptor.provider)) {
    throw new WorkbenchValidationError("agentId is not a registered Workbench agent.");
  }
  const input = body.context === undefined ? {} : body.context;
  if (!isRecord(input)) throw new WorkbenchValidationError("context must be an object.");
  const environment = input.environment ?? "local";
  if (environment !== "local" && environment !== "worktree") {
    throw new WorkbenchValidationError("context.environment must be local or worktree.");
  }
  const panel = (input.panel ?? "transcript") as WorkbenchPanel;
  if (!PANELS.has(panel)) throw new WorkbenchValidationError("context.panel is invalid.");
  if (input.agentId !== undefined && input.agentId !== adapterId) {
    throw new WorkbenchValidationError("context.agentId must match agentId.");
  }
  const title = body.title === undefined || body.title === null ? null : body.title;
  if (title !== null && (typeof title !== "string" || !title.trim() || title.length > 200)) {
    throw new WorkbenchValidationError("title must contain 1 to 200 characters.");
  }
  if (body.metadata !== undefined && !isRecord(body.metadata)) {
    throw new WorkbenchValidationError("metadata must be an object.");
  }
  return {
    adapterId,
    provider: adapter.descriptor.provider,
    context: {
      agentId: adapterId,
      actorId: safeId(input.actorId, "context.actorId", true),
      projectId: safeId(input.projectId, "context.projectId", true),
      sessionId: safeId(input.sessionId, "context.sessionId", true),
      environment,
      panel,
    },
    title: title ? redactText(title.trim(), 200) : null,
    metadata: redactRecord(body.metadata ?? {}) as Record<string, unknown>,
  };
}

export function validateMessage(body: Record<string, unknown>): { mode: MessageMode; content: string } {
  const mode = body.mode;
  if (mode !== "steer" && mode !== "queue") throw new WorkbenchValidationError("mode must be steer or queue.");
  if (typeof body.content !== "string" || !body.content.trim()) {
    throw new WorkbenchValidationError("content is required.");
  }
  if (Buffer.byteLength(body.content, "utf8") > 32 * 1024) {
    throw new WorkbenchValidationError("content is too large.", 413);
  }
  return { mode, content: redactText(body.content) };
}

export function validateApprovalDecision(body: Record<string, unknown>): ApprovalDecision {
  const decision = body.decision;
  if (decision !== "allow_once" && decision !== "allow_session" && decision !== "deny") {
    throw new WorkbenchValidationError("decision must be allow_once, allow_session, or deny.");
  }
  return decision;
}

export function validateRunId(value: string): string {
  return safeId(value, "run id")!;
}

export function parseRunStatus(value: string | null): RunStatus | null {
  if (!value) return null;
  if (!RUN_STATUSES.includes(value as RunStatus)) throw new WorkbenchValidationError("status is invalid.");
  return value as RunStatus;
}

export function parseLimit(value: string | null, fallback = 50): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new WorkbenchValidationError("limit must be an integer from 1 to 200.");
  }
  return parsed;
}

export function workbenchJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(redactRecord(body)), { ...init, headers });
}

export function workbenchError(error: unknown): Response {
  // The dev server preserves RunSupervisor across HMR, so an error can come
  // from the previous module instance and fail `instanceof` against the new
  // constructor. Constructor-name matching keeps the HTTP contract stable
  // without discarding the preserved supervisor/process handles.
  const errorType = error && typeof error === "object"
    ? (error as { constructor?: { name?: string } }).constructor?.name
    : undefined;
  if (error instanceof WorkbenchValidationError) {
    return workbenchJson({ error: error.message }, { status: error.status });
  }
  if (error instanceof Error && (error instanceof WorkbenchNotFoundError || errorType === "WorkbenchNotFoundError")) {
    return workbenchJson({ error: error.message }, { status: 404 });
  }
  if (error instanceof Error && (error instanceof WorkbenchConflictError || errorType === "WorkbenchConflictError")) {
    return workbenchJson({ error: error.message }, { status: 409 });
  }
  if (error instanceof Error && (error instanceof WorkbenchUnsupportedError || errorType === "WorkbenchUnsupportedError")) {
    return workbenchJson({ error: error.message, code: "unsupported" }, { status: 501 });
  }
  console.error("Workbench API error", error instanceof Error ? error.message : String(error));
  return workbenchJson({ error: "Workbench request failed." }, { status: 500 });
}
