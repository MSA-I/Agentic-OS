import "server-only";

import {
  authorizeWorkbenchSession,
  consumeWorkbenchMutation,
  requireWorkbenchCallerSessionId,
  WorkbenchSessionError,
} from "@/lib/control-plane/session";
import { createControlPlaneIdentity, type ControlPlaneIdentity } from "@/lib/control-plane/identity";
import { ControlPlaneCommandDeniedError } from "@/lib/control-plane/executionFreeze";
import { getWorkbenchAdapter } from "./adapters";
import {
  WorkbenchConflictError,
  WorkbenchNotFoundError,
  WorkbenchPilotError,
  WorkbenchUnsupportedError,
} from "./errors";
import { redactLogMessage, redactRecord, redactText, serializeRedactedJson } from "./redaction";
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
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
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

function normalizedOrigin(url: URL): string {
  return `${url.protocol}//${url.hostname.toLowerCase()}:${effectivePort(url)}`;
}

function requestOrigin(request: Request): URL | null {
  try {
    const requestUrl = new URL(request.url);
    const host = request.headers.get("host")?.trim();
    if (!host || host.includes(",") || !LOOPBACK_HOSTS.has(requestUrl.hostname.toLowerCase())) return null;
    if (requestUrl.username || requestUrl.password) return null;
    if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") return null;
    const origin = new URL(`${requestUrl.protocol}//${host}`);
    if (!LOOPBACK_HOSTS.has(origin.hostname.toLowerCase())) return null;
    if (origin.protocol !== "http:" && origin.protocol !== "https:") return null;
    if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return null;
    if (effectivePort(origin) !== effectivePort(requestUrl)) return null;
    return origin;
  } catch {
    return null;
  }
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

export function authorizeWorkbenchRead(request: Request): URL {
  const expected = requestOrigin(request);
  if (!expected) {
    throw new WorkbenchValidationError("Workbench APIs are available only through this app on localhost.", 403);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    throw new WorkbenchValidationError("Cross-site Workbench requests are not allowed.", 403);
  }
  const origin = request.headers.get("origin");
  if (origin) assertMatchingOrigin(origin, expected, "Workbench request");
  return expected;
}

function assertMatchingOrigin(origin: string, expected: URL, label: string): void {
  let caller: URL;
  try { caller = new URL(origin); }
  catch { throw new WorkbenchValidationError(`${label} Origin is invalid.`, 403); }
  if (
    caller.origin !== origin
    || !LOOPBACK_HOSTS.has(caller.hostname.toLowerCase())
    || normalizedOrigin(caller) !== normalizedOrigin(expected)
  ) {
    throw new WorkbenchValidationError(`${label} Origin must match this local app.`, 403);
  }
}

function authorizeOriginBoundRequest(request: Request, label: string): URL {
  const expected = requestOrigin(request);
  if (!expected) {
    throw new WorkbenchValidationError(`${label}s are available only through this app on localhost.`, 403);
  }
  const origin = request.headers.get("origin");
  if (!origin) throw new WorkbenchValidationError(`${label}s require a browser Origin header.`, 403);
  assertMatchingOrigin(origin, expected, label);
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    throw new WorkbenchValidationError(`Cross-site ${label.toLowerCase()}s are not allowed.`, 403);
  }
  return expected;
}

function sessionError(error: unknown): never {
  if (error instanceof WorkbenchSessionError) {
    throw new WorkbenchValidationError(error.message, error.status);
  }
  throw error;
}

export function authorizeWorkbenchBootstrap(request: Request): URL {
  return authorizeOriginBoundRequest(request, "Workbench bootstrap");
}

export function authorizeWorkbenchMutation(request: Request): string {
  const expected = authorizeOriginBoundRequest(request, "Workbench action");
  try {
    const binding = normalizedOrigin(expected);
    const callerSessionId = requireWorkbenchCallerSessionId(request.headers.get("cookie"), binding);
    consumeWorkbenchMutation(request.headers.get("cookie"), binding);
    return callerSessionId;
  } catch (error) {
    sessionError(error);
  }
}

/**
 * The event stream cannot use authorizeOriginBoundRequest: EventSource does not
 * send an Origin header on a same-origin request, so requiring one made every
 * Workbench SSE stream unreachable from a browser. The run would start, finish,
 * and the page would sit on its spinner forever.
 *
 * Fetch metadata carries the same claim. One of the two must prove same-origin:
 * an exactly matching Origin, or `Sec-Fetch-Site: same-origin`. A hostile page
 * cannot produce either, because its EventSource sends `Sec-Fetch-Site:
 * cross-site` and both headers are forbidden to page script. The session cookie
 * is still required below, so this widens who may ask, never who is let in.
 */
function authorizeStreamOrigin(request: Request): URL {
  const expected = requestOrigin(request);
  if (!expected) {
    throw new WorkbenchValidationError("Workbench event streams are available only through this app on localhost.", 403);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    throw new WorkbenchValidationError("Cross-site Workbench event streams are not allowed.", 403);
  }
  const origin = request.headers.get("origin");
  if (origin) assertMatchingOrigin(origin, expected, "Workbench event stream");
  else if (fetchSite !== "same-origin") {
    throw new WorkbenchValidationError("Workbench event streams require a browser Origin or same-origin fetch metadata.", 403);
  }
  return expected;
}

export function authorizeWorkbenchStream(request: Request): void {
  const expected = authorizeStreamOrigin(request);
  try {
    authorizeWorkbenchSession(request.headers.get("cookie"), normalizedOrigin(expected));
  } catch (error) {
    sessionError(error);
  }
}

export async function readWorkbenchJson(request: Request, maximumBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new WorkbenchValidationError("Content-Type must be application/json.", 415);
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    throw new WorkbenchValidationError("Content-Length is invalid.");
  }
  if (contentLength !== null && contentLength > maximumBytes) {
    throw new WorkbenchValidationError("Request body is too large.", 413);
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new WorkbenchValidationError("Request body is too large.", 413);
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString("utf8");
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
  prompt: string;
  idempotencyKey: string;
  operation: "start" | "resume";
  options: {
    model: string | null;
    engine: "gpt56" | "omniroute" | "hy3" | null;
    effort: "low" | "medium" | "high" | "xhigh" | null;
  };
}

export interface CommandIdentityInput {
  actorId: string;
  projectId: string;
  worktreeId: string;
  provider: WorkbenchProvider;
  profileId: string | null;
  nativeSessionId: string | null;
  runId: string;
}

export function validateCommandIdentity(
  body: Record<string, unknown>,
  callerSessionId: string,
): ControlPlaneIdentity {
  const input = body.identity;
  if (!isRecord(input)) throw new WorkbenchValidationError("identity is required.", 403);
  try {
    return createControlPlaneIdentity({ ...input, callerSessionId });
  } catch {
    throw new WorkbenchValidationError("identity is invalid.", 403);
  }
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
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    throw new WorkbenchValidationError("prompt is required.");
  }
  if (Buffer.byteLength(body.prompt, "utf8") > 16 * 1024) {
    throw new WorkbenchValidationError("prompt is too large.", 413);
  }
  const idempotencyKey = safeId(body.idempotencyKey, "idempotencyKey")!;
  const rawOptions = body.options === undefined ? {} : body.options;
  if (!isRecord(rawOptions)) throw new WorkbenchValidationError("options must be an object.");
  const allowedOptionKeys = new Set(["model", "engine", "effort"]);
  if (Object.keys(rawOptions).some((key) => !allowedOptionKeys.has(key))) {
    throw new WorkbenchValidationError("options contains an unsupported field.");
  }
  const model = rawOptions.model === undefined || rawOptions.model === null
    ? null
    : rawOptions.model;
  if (
    model !== null
    && (typeof model !== "string" || !/^[A-Za-z0-9._:/-]{1,160}$/u.test(model))
  ) {
    throw new WorkbenchValidationError("options.model is invalid.");
  }
  const engine = rawOptions.engine === undefined || rawOptions.engine === null
    ? null
    : rawOptions.engine;
  if (engine !== null && !["gpt56", "omniroute", "hy3"].includes(String(engine))) {
    throw new WorkbenchValidationError("options.engine is invalid.");
  }
  const effort = rawOptions.effort === undefined || rawOptions.effort === null
    ? null
    : rawOptions.effort;
  if (effort !== null && !["low", "medium", "high", "xhigh"].includes(String(effort))) {
    throw new WorkbenchValidationError("options.effort is invalid.");
  }
  if (
    (adapter.descriptor.provider === "codex" || adapter.descriptor.provider === "claude" || adapter.descriptor.provider === "hermes")
    && (model !== null || engine !== null || effort !== null)
  ) {
    throw new WorkbenchValidationError(
      "Codex and Claude pilot options are server-managed; model, engine, and effort must be null.",
    );
  }
  const context: WorkContext = {
    agentId: adapterId,
    actorId: safeId(input.actorId, "context.actorId", true),
    projectId: safeId(input.projectId, "context.projectId", true),
    sessionId: safeId(input.sessionId, "context.sessionId", true),
    environment,
    panel,
  };
  return {
    adapterId,
    provider: adapter.descriptor.provider,
    context,
    title: title ? redactText(title.trim(), 200) : null,
    metadata: redactRecord(body.metadata ?? {}) as Record<string, unknown>,
    prompt: redactText(body.prompt, 16 * 1024),
    idempotencyKey,
    operation: context.sessionId ? "resume" : "start",
    options: {
      model: model as string | null,
      engine: engine as ValidatedCreateRun["options"]["engine"],
      effort: effort as ValidatedCreateRun["options"]["effort"],
    },
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
  return new Response(serializeRedactedJson(body), { ...init, headers });
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
    return workbenchJson({
      error: error.message,
      code: (error as WorkbenchConflictError).code ?? "conflict",
      category: "identity",
      runCreated: false,
      retrySafe: false,
      nextAction: "Refresh the selected target and try again.",
    }, { status: 409 });
  }
  if (error instanceof Error && (error instanceof WorkbenchUnsupportedError || errorType === "WorkbenchUnsupportedError")) {
    return workbenchJson({ error: error.message, code: "unsupported" }, { status: 501 });
  }
  if (error instanceof Error && (error instanceof ControlPlaneCommandDeniedError || errorType === "ControlPlaneCommandDeniedError")) {
    const denied = error as ControlPlaneCommandDeniedError;
    return workbenchJson({ error: denied.message, code: denied.code, runCreated: false }, { status: denied.status });
  }
  if (error instanceof Error && (error instanceof WorkbenchPilotError || errorType === "WorkbenchPilotError")) {
    const pilot = error as WorkbenchPilotError;
    return workbenchJson({
      error: pilot.message,
      code: pilot.code,
      category: pilot.category,
      runCreated: pilot.runCreated,
      retrySafe: pilot.retrySafe,
      nextAction: pilot.nextAction,
    }, { status: pilot.status });
  }
  console.error("Workbench API error", redactLogMessage(error));
  return workbenchJson({ error: "Workbench request failed." }, { status: 500 });
}
