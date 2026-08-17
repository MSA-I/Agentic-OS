import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { ensureWorkspaceRootSync, workspacePath } from "@/lib/workspaceRoot";
import {
  applyWorkbenchMigrations,
  migrationChecksum,
  WORKBENCH_MIGRATIONS,
  WorkbenchMigrationError,
  type AppliedWorkbenchMigration,
} from "./migrations";
import {
  canonicalIdempotencyJson as canonicalJson,
  createRunIdempotencyBinding,
  idempotencyPayloadHash as payloadHash,
  sha256Text,
} from "./idempotency";
import { redactRecord, redactText } from "./redaction";
import {
  DEFAULT_ADMISSION_POLICY,
  DEFAULT_RESOURCE_REQUEST,
  evaluateQueueAdmission,
  type AdmissionDecision,
  type AdmissionPolicy,
  type AdmissionSnapshot,
  type ResourceBudget,
} from "./resourceAdmission";
import { assertLegalRunTransition, IllegalRunTransitionError } from "./stateMachine";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRisk,
  MessageMode,
  QueuedMessage,
  Run,
  RunError,
  RunEvent,
  RunEventType,
  RunStatus,
  WorkbenchDraft,
  WorkbenchProvider,
  WorkContext,
} from "./types";

type Row = Record<string, unknown>;

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_WAL_NEGOTIATION_TIMEOUT_MS = 10_000;
const SQLITE_WAL_WAIT_STATE = new Int32Array(new SharedArrayBuffer(4));

export interface CreateRunInput {
  adapterId: string;
  provider: WorkbenchProvider;
  context: WorkContext;
  title?: string | null;
  metadata?: Record<string, unknown>;
  operation?: string;
  idempotencyKey?: string;
  payload?: unknown;
  initialStatus?: "requested" | "queued";
}

export interface ListRunsInput {
  agentId?: string | null;
  status?: RunStatus | null;
  before?: string | null;
  limit?: number;
}

export interface OutboxCommandInput {
  type: string;
  payload?: Record<string, unknown>;
  /** Canonical replay hash input when the execution payload contains ephemeral admission state. */
  idempotencyPayload?: Record<string, unknown>;
  idempotencyKey: string;
  availableAt?: string;
}

export interface OutboxCommand {
  id: string;
  runId: string;
  eventId: string | null;
  type: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  idempotencyKey: string;
  operation: "start" | "resume" | "steer" | "queue" | "cancel" | "reconcile_orphan" | "unknown";
  runGeneration: number;
  runStateVersion: number;
  targetStatus: RunStatus | null;
  state: "pending" | "claimed" | "completed" | "dead";
  availableAt: string;
  createdAt: string;
  claimedAt: string | null;
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  attemptCount: number;
  deliveryAttemptCount: number;
  providerAttemptCount: number;
  executionId: string | null;
  checkpoint: "pending" | "dequeued" | "spawn_intent" | "spawned" | "registered" | "completed";
  outcome: Record<string, unknown> | null;
  completedAt: string | null;
  lastError: string | null;
}

export interface CreateRunCommandInput extends CreateRunInput {
  command?: Omit<OutboxCommandInput, "idempotencyKey">;
}

export interface CreateRunCommandResult {
  run: Run;
  event: RunEvent;
  command: OutboxCommand;
  created: boolean;
}

export interface TransitionRunInput {
  runId: string;
  to: RunStatus;
  expectedFrom?: RunStatus | readonly RunStatus[];
  command: OutboxCommandInput;
  event?: {
    type?: RunEventType;
    payload?: Record<string, unknown>;
  };
  patch?: Partial<Pick<Run, "startedAt" | "finishedAt" | "pid">> & {
    error?: RunError | null;
  };
}

export interface TransitionRunResult {
  run: Run;
  event: RunEvent | null;
  command: OutboxCommand | null;
  replayed: boolean;
}

export interface EventGap {
  requestedAfter: number;
  availableAfter: number;
  compactedThroughSequence: number;
  snapshotSequence: number;
  snapshot: Record<string, unknown>;
}

export interface EventBounds {
  firstSequence: number | null;
  lastSequence: number | null;
  compactedThroughSequence: number;
  snapshotSequence: number;
  snapshot: Record<string, unknown>;
  retainedCount: number;
}

export interface EventPage {
  events: RunEvent[];
  nextCursor: number;
  hasMore: boolean;
  gap: EventGap | null;
  bounds: EventBounds;
}

export interface WorkbenchBackupManifest {
  path: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  schemaVersion: number;
  runCount: number;
  eventCount: number;
  maxEventSequence: number;
}

export interface WorkbenchBackupVerification extends WorkbenchBackupManifest {
  integrity: "ok";
  migrations: AppliedWorkbenchMigration[];
}

export interface WorkbenchEventQuotaPolicy {
  /** UTF-8 bytes in one redacted event payload JSON value. */
  maxPayloadBytesPerEvent: number;
  /** Maximum retained events for any one run after automatic compaction. */
  maxRetainedEventsPerRun: number;
  /** UTF-8 bytes in all retained event payload JSON values. */
  maxStoreBytes: number;
  /** UTF-8 bytes in one retained compaction snapshot JSON value. */
  maxSnapshotBytes: number;
}

export interface WorkbenchStoreOptions {
  admissionPolicy?: Readonly<AdmissionPolicy>;
  eventQuotaPolicy?: Partial<WorkbenchEventQuotaPolicy>;
  /** Test-only barrier used to prove event-page reads share one SQLite snapshot. */
  eventPageSnapshotHook?: () => void;
}

const DEFAULT_EVENT_QUOTA_POLICY: Readonly<WorkbenchEventQuotaPolicy> = Object.freeze({
  maxPayloadBytesPerEvent: 256 * 1024,
  maxRetainedEventsPerRun: 5_000,
  maxStoreBytes: 64 * 1024 * 1024,
  maxSnapshotBytes: 256 * 1024,
});

export class WorkbenchIdempotencyConflictError extends Error {
  constructor(message = "Idempotency key was already used with a different identity or payload.") {
    super(message);
    this.name = "WorkbenchIdempotencyConflictError";
  }
}

export class WorkbenchRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Workbench run ${runId} was not found.`);
    this.name = "WorkbenchRunNotFoundError";
  }
}

export class WorkbenchSessionBindingError extends Error {
  readonly code = "session_binding_conflict";

  constructor(message: string) {
    super(message);
    this.name = "WorkbenchSessionBindingError";
  }
}

export class WorkbenchEventGapError extends Error {
  readonly gap: EventGap;

  constructor(gap: EventGap) {
    super(`Event cursor ${gap.requestedAfter} predates retained events; snapshot recovery is required.`);
    this.name = "WorkbenchEventGapError";
    this.gap = gap;
  }
}

export class WorkbenchAdmissionError extends Error {
  readonly code: Exclude<AdmissionDecision, { accepted: true }>["code"];
  readonly detail: string;
  readonly resource: keyof ResourceBudget | null;

  constructor(decision: Exclude<AdmissionDecision, { accepted: true }>) {
    super(`Workbench queue admission rejected: ${decision.detail}`);
    this.name = "WorkbenchAdmissionError";
    this.code = decision.code;
    this.detail = decision.detail;
    this.resource = decision.resource ?? null;
  }
}

export class WorkbenchEventQuotaError extends Error {
  readonly code: "event_too_large" | "event_snapshot_too_large" | "event_store_full";
  readonly limitBytes: number;
  readonly requestedBytes: number;

  constructor(
    code: WorkbenchEventQuotaError["code"],
    message: string,
    limitBytes: number,
    requestedBytes: number,
  ) {
    super(message);
    this.name = "WorkbenchEventQuotaError";
    this.code = code;
    this.limitBytes = limitBytes;
    this.requestedBytes = requestedBytes;
  }
}

function now(): string {
  return new Date().toISOString();
}

function boundedToken(value: string, label: string, maxLength = 300): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new TypeError(`${label} must be a non-empty printable string no longer than ${maxLength} characters.`);
  }
  return trimmed;
}

const RESOURCE_FIELDS: readonly (keyof ResourceBudget)[] = [
  "cpuTimeMs",
  "residentMemoryBytes",
  "diskBytes",
  "processCount",
  "outputBytes",
];

function requestedResources(payload: Record<string, unknown>): ResourceBudget {
  const raw = payload.resources;
  if (raw === undefined) return { ...DEFAULT_RESOURCE_REQUEST };
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return Object.fromEntries(RESOURCE_FIELDS.map((field) => [
    field,
    typeof record[field] === "number" ? record[field] : Number.NaN,
  ])) as unknown as ResourceBudget;
}

function quotaLimit(value: number | undefined, fallback: number, label: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return candidate;
}

function eventQuotaPolicy(input: Partial<WorkbenchEventQuotaPolicy> = {}): Readonly<WorkbenchEventQuotaPolicy> {
  return Object.freeze({
    maxPayloadBytesPerEvent: quotaLimit(
      input.maxPayloadBytesPerEvent,
      DEFAULT_EVENT_QUOTA_POLICY.maxPayloadBytesPerEvent,
      "eventQuotaPolicy.maxPayloadBytesPerEvent",
    ),
    maxRetainedEventsPerRun: quotaLimit(
      input.maxRetainedEventsPerRun,
      DEFAULT_EVENT_QUOTA_POLICY.maxRetainedEventsPerRun,
      "eventQuotaPolicy.maxRetainedEventsPerRun",
    ),
    maxStoreBytes: quotaLimit(
      input.maxStoreBytes,
      DEFAULT_EVENT_QUOTA_POLICY.maxStoreBytes,
      "eventQuotaPolicy.maxStoreBytes",
    ),
    maxSnapshotBytes: quotaLimit(
      input.maxSnapshotBytes,
      DEFAULT_EVENT_QUOTA_POLICY.maxSnapshotBytes,
      "eventQuotaPolicy.maxSnapshotBytes",
    ),
  });
}

type OutboxOperation = OutboxCommand["operation"];
const OUTBOX_OPERATIONS = new Set<Exclude<OutboxOperation, "unknown">>([
  "start",
  "resume",
  "steer",
  "queue",
  "cancel",
  "reconcile_orphan",
]);

function outboxOperation(explicit: unknown, commandType: string): OutboxOperation {
  if (explicit !== undefined) {
    if (typeof explicit !== "string") return "unknown";
    const normalized = explicit.toLowerCase() as Exclude<OutboxOperation, "unknown">;
    if (OUTBOX_OPERATIONS.has(normalized)) return normalized;
    return "unknown";
  }
  const normalizedType = commandType.toLowerCase();
  for (const candidate of OUTBOX_OPERATIONS) {
    if (normalizedType === candidate || normalizedType.endsWith(`.${candidate}`)) return candidate;
  }
  return "unknown";
}

function idempotencyIdentity(input: CreateRunInput): {
  operation: string;
  scope: string;
  key: string;
  payloadHash: string;
} {
  const operation = boundedToken(input.operation ?? (input.context.sessionId ? "resume" : "start"), "operation", 100);
  const hash = payloadHash(input.payload ?? {
    adapterId: input.adapterId,
    provider: input.provider,
    context: input.context,
    title: input.title ?? null,
    metadata: input.metadata ?? {},
  });
  const callerKey = input.idempotencyKey
    ? boundedToken(input.idempotencyKey, "idempotencyKey")
    : hash;
  const binding = createRunIdempotencyBinding({
    actorId: input.context.actorId,
    projectId: input.context.projectId,
    operation,
    callerKey,
    payload: input.payload ?? {
      adapterId: input.adapterId,
      provider: input.provider,
      context: input.context,
      title: input.title ?? null,
      metadata: input.metadata ?? {},
    },
  });
  if (binding.payloadHash !== hash) throw new Error("Idempotency payload hash derivation diverged.");
  return { operation, ...binding };
}

function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function runFromRow(row: Row): Run {
  return {
    id: String(row.id),
    adapterId: String(row.adapter_id),
    provider: String(row.provider) as WorkbenchProvider,
    context: {
      agentId: String(row.agent_id),
      actorId: asNullableString(row.actor_id),
      projectId: asNullableString(row.project_id),
      sessionId: asNullableString(row.session_id),
      environment: row.environment === "worktree" ? "worktree" : "local",
      panel: String(row.panel) as WorkContext["panel"],
    },
    title: row.title === null || row.title === undefined ? null : redactText(String(row.title), 200),
    status: String(row.status) as RunStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: asNullableString(row.started_at),
    finishedAt: asNullableString(row.finished_at),
    pid: typeof row.pid === "number" ? row.pid : null,
    error: row.error_code
      ? {
          code: redactText(String(row.error_code), 100),
          message: redactText(String(row.error_message ?? ""), 2_000),
        }
      : null,
    metadata: redactRecord(parseObject(row.metadata_json)) as Record<string, unknown>,
  };
}

function eventFromRow(row: Row): RunEvent {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    runId: String(row.run_id),
    type: String(row.type) as RunEventType,
    createdAt: String(row.created_at),
    payload: redactRecord(parseObject(row.payload_json)) as Record<string, unknown>,
  };
}

function eventFromReceiptRow(row: Row): RunEvent {
  return {
    id: String(row.event_id),
    sequence: Number(row.event_sequence),
    runId: String(row.run_id),
    type: String(row.event_type) as RunEventType,
    createdAt: String(row.event_created_at),
    payload: redactRecord(parseObject(row.event_payload_json)) as Record<string, unknown>,
  };
}

function approvalFromRow(row: Row): ApprovalRequest {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    risk: String(row.risk) as ApprovalRisk,
    summary: redactText(String(row.summary), 500),
    redactedAction: redactText(String(row.redacted_action), 2_000),
    status: String(row.status) as ApprovalRequest["status"],
    createdAt: String(row.created_at),
    resolvedAt: asNullableString(row.resolved_at),
  };
}

function messageFromRow(row: Row): QueuedMessage {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    mode: String(row.mode) as MessageMode,
    content: redactText(String(row.content), 32_000),
    createdAt: String(row.created_at),
    deliveredAt: asNullableString(row.delivered_at),
  };
}

function outboxFromRow(row: Row): OutboxCommand {
  const persistedOperation = String(row.operation ?? "unknown") as OutboxOperation;
  const operation = persistedOperation === "unknown"
    && String(row.command_type).toLowerCase() === "run.reconcile_orphan"
    && !Object.hasOwn(parseObject(row.payload_json), "operation")
    ? "reconcile_orphan"
    : persistedOperation;
  return {
    id: String(row.id),
    runId: String(row.run_id),
    eventId: asNullableString(row.event_id),
    type: String(row.command_type),
    payload: redactRecord(parseObject(row.payload_json)) as Record<string, unknown>,
    payloadHash: String(row.payload_hash),
    idempotencyKey: String(row.idempotency_key),
    operation,
    runGeneration: Number(row.run_generation ?? 0),
    runStateVersion: Number(row.run_state_version ?? 0),
    targetStatus: asNullableString(row.target_status) as RunStatus | null,
    state: String(row.state) as OutboxCommand["state"],
    availableAt: String(row.available_at),
    createdAt: String(row.created_at),
    claimedAt: asNullableString(row.claimed_at),
    claimedBy: asNullableString(row.claimed_by),
    leaseExpiresAt: asNullableString(row.lease_expires_at),
    fencingToken: Number(row.fencing_token),
    attemptCount: Number(row.attempt_count),
    deliveryAttemptCount: Number(row.delivery_attempt_count ?? row.attempt_count ?? 0),
    providerAttemptCount: Number(row.provider_attempt_count ?? row.attempt_count ?? 0),
    executionId: asNullableString(row.execution_id),
    checkpoint: String(row.checkpoint ?? "pending") as OutboxCommand["checkpoint"],
    outcome: row.outcome_json === null || row.outcome_json === undefined
      ? null
      : redactRecord(parseObject(row.outcome_json)) as Record<string, unknown>,
    completedAt: asNullableString(row.completed_at),
    lastError: row.last_error === null || row.last_error === undefined
      ? null
      : redactText(String(row.last_error), 2_000),
  };
}

function withImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite may already have rolled back a failed write.
    }
    throw error;
  }
}

function withReadTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back. */ }
    throw error;
  }
}

function sqlitePrimaryErrorCode(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const record = error as Error & { errcode?: unknown; cause?: unknown };
  const errcode = Number(record.errcode);
  if (Number.isInteger(errcode)) return errcode & 0xff;
  return record.cause === undefined ? null : sqlitePrimaryErrorCode(record.cause);
}

function negotiateWalJournalMode(db: DatabaseSync): string {
  const deadline = Date.now() + SQLITE_WAL_NEGOTIATION_TIMEOUT_MS;
  let attempt = 0;
  let lastBusy: unknown = null;
  for (;;) {
    try {
      const current = db.prepare("PRAGMA journal_mode").get() as Row;
      const currentMode = String(current.journal_mode ?? "").toLowerCase();
      if (currentMode === "wal") return currentMode;
      const negotiated = db.prepare("PRAGMA journal_mode = WAL").get() as Row;
      return String(negotiated.journal_mode ?? "").toLowerCase();
    } catch (error) {
      // SQLite may bypass busy_timeout for a journal-mode lock upgrade. Retry
      // only SQLITE_BUSY; SQLITE_LOCKED and every integrity/I/O error remain
      // immediate fail-closed initialization failures.
      if (sqlitePrimaryErrorCode(error) !== 5) throw error;
      lastBusy = error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new WorkbenchMigrationError(
          "Workbench database remained busy while negotiating WAL mode.",
          { cause: lastBusy },
        );
      }
      const backoff = Math.min(25 * (2 ** Math.min(attempt, 4)), 400);
      const jitter = (process.pid + (attempt * 17)) % 23;
      Atomics.wait(SQLITE_WAL_WAIT_STATE, 0, 0, Math.min(backoff + jitter, remaining));
      attempt += 1;
    }
  }
}

function initializeEventQuotaPolicy(
  db: DatabaseSync,
  requested: Readonly<WorkbenchEventQuotaPolicy>,
  requireExactMatch: boolean,
): Readonly<WorkbenchEventQuotaPolicy> {
  return withImmediateTransaction(db, () => {
    db.prepare(`
      INSERT INTO workbench_event_quota_policy (
        singleton, max_payload_bytes_per_event, max_retained_events_per_run,
        max_store_bytes, max_snapshot_bytes, created_at
      ) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO NOTHING
    `).run(
      requested.maxPayloadBytesPerEvent,
      requested.maxRetainedEventsPerRun,
      requested.maxStoreBytes,
      requested.maxSnapshotBytes,
      now(),
    );
    const row = db.prepare(`
      SELECT * FROM workbench_event_quota_policy WHERE singleton = 1
    `).get() as Row | undefined;
    if (!row) throw new Error("Workbench event quota policy is missing; refusing to open.");
    const persisted = Object.freeze({
      maxPayloadBytesPerEvent: Number(row.max_payload_bytes_per_event),
      maxRetainedEventsPerRun: Number(row.max_retained_events_per_run),
      maxStoreBytes: Number(row.max_store_bytes),
      maxSnapshotBytes: Number(row.max_snapshot_bytes),
    });
    if (
      requireExactMatch
      && Object.entries(requested).some(([key, value]) => persisted[key as keyof WorkbenchEventQuotaPolicy] !== value)
    ) {
      throw new Error("Workbench event quota policy conflicts with the durable database policy.");
    }
    return persisted;
  });
}

export function workbenchDatabasePath(): string {
  ensureWorkspaceRootSync();
  const dataDirectory = workspacePath("AGENT_OS", "data");
  const relativeToRepository = path.relative(process.cwd(), dataDirectory);
  if (!relativeToRepository.startsWith("..") && !path.isAbsolute(relativeToRepository)) {
    throw new Error("Workbench data must resolve outside the source repository.");
  }
  mkdirSync(dataDirectory, { recursive: true });
  return path.join(dataDirectory, "workbench.sqlite3");
}

export class WorkbenchStore {
  private readonly db: DatabaseSync;
  private readonly admissionPolicy: Readonly<AdmissionPolicy>;
  private readonly eventQuotas: Readonly<WorkbenchEventQuotaPolicy>;
  private readonly eventPageSnapshotHook: (() => void) | undefined;
  readonly databasePath: string;

  constructor(databasePath = workbenchDatabasePath(), options: WorkbenchStoreOptions = {}) {
    this.databasePath = databasePath;
    this.admissionPolicy = options.admissionPolicy ?? DEFAULT_ADMISSION_POLICY;
    this.eventPageSnapshotHook = options.eventPageSnapshotHook;
    const requestedEventQuotas = eventQuotaPolicy(options.eventQuotaPolicy);
    const db = new DatabaseSync(databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
    try {
      // Set the busy handler before WAL negotiation so two first-open
      // processes wait for one another instead of racing PRAGMA journal_mode.
      db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      const journalMode = negotiateWalJournalMode(db);
      if (databasePath !== ":memory:" && journalMode !== "wal") {
        throw new Error(`Workbench database refused WAL mode (received ${journalMode || "unknown"}).`);
      }
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA synchronous = FULL");
      applyWorkbenchMigrations(db);
      this.eventQuotas = initializeEventQuotaPolicy(
        db,
        requestedEventQuotas,
        options.eventQuotaPolicy !== undefined,
      );
    } catch (error) {
      db.close();
      if (error instanceof WorkbenchMigrationError) throw error;
      throw new WorkbenchMigrationError("Workbench database initialization failed closed.", { cause: error });
    }
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  createRun(input: CreateRunInput): Run {
    return this.createRunCommand(input).run;
  }

  createRunCommand(input: CreateRunCommandInput): CreateRunCommandResult {
    const identity = idempotencyIdentity(input);
    const commandType = boundedToken(input.command?.type ?? "run.admit", "command.type", 150);
    const commandPayload = input.command?.payload ?? { operation: identity.operation };
    const commandPayloadHash = payloadHash(input.command?.idempotencyPayload ?? commandPayload);
    const safeCommandPayload = redactRecord(commandPayload) as Record<string, unknown>;
    const initialStatus = input.initialStatus ?? "queued";

    return withImmediateTransaction(this.db, () => {
      const existing = this.db.prepare(`
        SELECT * FROM workbench_runs WHERE idempotency_scope = ?
      `).get(identity.scope) as Row | undefined;
      if (existing) {
        if (
          String(existing.idempotency_key) !== identity.key
          || String(existing.payload_hash) !== identity.payloadHash
          || String(existing.operation) !== identity.operation
          || String(existing.adapter_id) !== input.adapterId
          || String(existing.provider) !== input.provider
          || asNullableString(existing.actor_id) !== input.context.actorId
          || asNullableString(existing.project_id) !== input.context.projectId
        ) {
          throw new WorkbenchIdempotencyConflictError();
        }
        const existingCommandRow = this.db.prepare(`
          SELECT * FROM workbench_outbox WHERE idempotency_key = ?
        `).get(identity.key) as Row | undefined;
        if (
          !existingCommandRow
          || String(existingCommandRow.command_type) !== commandType
          || String(existingCommandRow.payload_hash) !== commandPayloadHash
        ) {
          throw new WorkbenchIdempotencyConflictError("Idempotent run replay changed its outbox command.");
        }
        const receiptRow = this.db.prepare(`
          SELECT * FROM workbench_create_receipts WHERE idempotency_scope = ?
        `).get(identity.scope) as Row | undefined;
        if (!receiptRow || String(receiptRow.command_id) !== String(existingCommandRow.id)) {
          throw new Error("Idempotent run replay is missing its durable creation receipt.");
        }
        return {
          run: runFromRow(existing),
          event: eventFromReceiptRow(receiptRow),
          command: outboxFromRow(existingCommandRow),
          created: false,
        };
      }

      const admission = evaluateQueueAdmission(
        this.admissionSnapshot(),
        requestedResources(commandPayload),
        this.admissionPolicy,
      );
      if (!admission.accepted) throw new WorkbenchAdmissionError(admission);

      const id = randomUUID();
      const timestamp = now();
      const metadata = redactRecord(input.metadata ?? {}) as Record<string, unknown>;
      this.db.prepare(`
        INSERT INTO workbench_runs (
          id, adapter_id, provider, agent_id, actor_id, project_id, session_id,
          environment, panel, title, status, created_at, updated_at, metadata_json,
          operation, idempotency_scope, idempotency_key, payload_hash, state_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        id, input.adapterId, input.provider, input.context.agentId, input.context.actorId,
        input.context.projectId, input.context.sessionId, input.context.environment,
        input.context.panel, input.title ? redactText(input.title, 200) : null,
        initialStatus, timestamp, timestamp, JSON.stringify(metadata), identity.operation,
        identity.scope, identity.key, identity.payloadHash,
      );
      const event = this.insertEvent(id, "status", {
        status: initialStatus,
        operation: identity.operation,
        stateVersion: 0,
      }, timestamp);
      const command = this.insertOutbox({
        runId: id,
        eventId: event.id,
        type: commandType,
        payload: safeCommandPayload,
        payloadHash: commandPayloadHash,
        idempotencyKey: identity.key,
        operation: identity.operation,
        targetStatus: initialStatus,
        availableAt: input.command?.availableAt ?? timestamp,
        createdAt: timestamp,
      });
      this.insertCreateReceipt(identity.scope, id, command.id, event, timestamp);
      return { run: this.getRun(id)!, event, command, created: true };
    });
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM workbench_runs WHERE id = ?").get(id) as Row | undefined;
    return row ? runFromRow(row) : null;
  }

  listRuns(input: ListRunsInput = {}): Run[] {
    const clauses: string[] = [];
    const values: SQLInputValue[] = [];
    if (input.agentId) { clauses.push("agent_id = ?"); values.push(input.agentId); }
    if (input.status) { clauses.push("status = ?"); values.push(input.status); }
    if (input.before) { clauses.push("updated_at < ?"); values.push(input.before); }
    const limit = Math.max(1, Math.min(200, input.limit ?? 50));
    values.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT * FROM workbench_runs ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(...values) as Row[];
    return rows.map(runFromRow);
  }

  sessionActor(provider: WorkbenchProvider, sessionId: string): string | null | undefined {
    const row = this.db.prepare(`
      SELECT actor_id FROM workbench_runs
      WHERE provider = ? AND session_id = ? ORDER BY created_at ASC LIMIT 1
    `).get(provider, sessionId) as Row | undefined;
    return row ? asNullableString(row.actor_id) : undefined;
  }

  /**
   * One-way native session binding discovered from an authenticated provider
   * stream. This identity field is independent of run-state fencing, so the
   * active command generation/version remain unchanged.
   */
  bindNativeSessionId(runId: string, sessionId: string): Run {
    const safeRunId = boundedToken(runId, "runId");
    const safeSessionId = boundedToken(sessionId, "sessionId", 256);
    return withImmediateTransaction(this.db, () => {
      const current = this.db.prepare(`
        SELECT id, provider, actor_id, project_id, session_id
        FROM workbench_runs WHERE id = ?
      `).get(safeRunId) as Row | undefined;
      if (!current) throw new WorkbenchRunNotFoundError(safeRunId);
      const existing = asNullableString(current.session_id);
      if (existing && existing !== safeSessionId) {
        throw new WorkbenchSessionBindingError("Run is already bound to a different native session.");
      }
      const owner = this.db.prepare(`
        SELECT actor_id, project_id FROM workbench_runs
        WHERE provider = ? AND session_id = ? AND id <> ?
        ORDER BY created_at ASC LIMIT 1
      `).get(String(current.provider), safeSessionId, safeRunId) as Row | undefined;
      if (
        owner
        && (
          asNullableString(owner.actor_id) !== asNullableString(current.actor_id)
          || asNullableString(owner.project_id) !== asNullableString(current.project_id)
        )
      ) {
        throw new WorkbenchSessionBindingError("Native session is already bound to a different actor or project.");
      }
      if (!existing) {
        const result = this.db.prepare(`
          UPDATE workbench_runs SET session_id = ?, updated_at = ?
          WHERE id = ? AND session_id IS NULL
        `).run(safeSessionId, now(), safeRunId);
        if (result.changes !== 1) {
          const raced = this.getRun(safeRunId);
          if (raced?.context.sessionId !== safeSessionId) {
            throw new WorkbenchSessionBindingError("Native session binding lost a concurrent identity race.");
          }
        }
      }
      return this.getRun(safeRunId)!;
    });
  }

  updateRun(
    id: string,
    patch: Partial<Pick<Run, "status" | "startedAt" | "finishedAt" | "pid">> & { error?: RunError | null },
  ): Run | null {
    return withImmediateTransaction(this.db, () => {
      const row = this.db.prepare("SELECT * FROM workbench_runs WHERE id = ?").get(id) as Row | undefined;
      if (!row) return null;
      const current = runFromRow(row);
      const status = patch.status ?? current.status;
      assertLegalRunTransition(current.status, status);
      const timestamp = now();
      const error = patch.error === undefined ? current.error : patch.error;
      const statusChanged = status !== current.status;
      const cancelsGeneration = statusChanged && status === "cancelled";
      const result = this.db.prepare(`
        UPDATE workbench_runs SET status = ?, updated_at = ?, started_at = ?, finished_at = ?,
          pid = ?, error_code = ?, error_message = ?,
          state_version = state_version + ?, run_generation = run_generation + ?
        WHERE id = ? AND status = ? AND state_version = ? AND run_generation = ?
      `).run(
        status,
        timestamp,
        patch.startedAt === undefined ? current.startedAt : patch.startedAt,
        patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
        patch.pid === undefined ? current.pid : patch.pid,
        error ? redactText(error.code, 100) : null,
        error ? redactText(error.message, 2_000) : null,
        statusChanged ? 1 : 0,
        cancelsGeneration ? 1 : 0,
        id,
        current.status,
        Number(row.state_version ?? 0),
        Number(row.run_generation ?? 0),
      );
      if (Number(result.changes) !== 1) {
        throw new Error("Workbench run state changed during compare-and-swap update.");
      }
      if (cancelsGeneration) {
        this.invalidateRunCommandsWithinTransaction(id, Number(row.run_generation ?? 0) + 1, timestamp);
      }
      return this.getRun(id);
    });
  }

  transitionRunWithCommand(input: TransitionRunInput): TransitionRunResult {
    const commandType = boundedToken(input.command.type, "command.type", 150);
    const callerKey = boundedToken(input.command.idempotencyKey, "command.idempotencyKey");
    const commandPayload = input.command.payload ?? {};
    const commandPayloadHash = payloadHash(input.command.idempotencyPayload ?? commandPayload);
    const durableCommandKey = sha256Text(canonicalJson({
      runId: input.runId,
      commandType,
      callerKey,
    }));
    const safeCommandPayload = redactRecord(commandPayload) as Record<string, unknown>;

    return withImmediateTransaction(this.db, () => {
      const existingCommandRow = this.db.prepare(`
        SELECT * FROM workbench_outbox WHERE idempotency_key = ?
      `).get(durableCommandKey) as Row | undefined;
      if (existingCommandRow) {
        if (
          String(existingCommandRow.run_id) !== input.runId
          || String(existingCommandRow.command_type) !== commandType
          || String(existingCommandRow.payload_hash) !== commandPayloadHash
          || asNullableString(existingCommandRow.target_status) !== input.to
        ) {
          throw new WorkbenchIdempotencyConflictError("Transition command replay changed run, target, or payload.");
        }
        const run = this.getRun(input.runId);
        if (!run) throw new WorkbenchRunNotFoundError(input.runId);
        const eventRow = existingCommandRow.event_id
          ? this.db.prepare("SELECT * FROM workbench_events WHERE id = ?")
            .get(String(existingCommandRow.event_id)) as Row | undefined
          : undefined;
        return {
          run,
          event: eventRow ? eventFromRow(eventRow) : null,
          command: outboxFromRow(existingCommandRow),
          replayed: true,
        };
      }

      const runRow = this.db.prepare("SELECT * FROM workbench_runs WHERE id = ?").get(input.runId) as Row | undefined;
      if (!runRow) throw new WorkbenchRunNotFoundError(input.runId);
      const current = runFromRow(runRow);

      if (current.status === "cancelled" && input.to === "cancelled") {
        return { run: current, event: null, command: null, replayed: true };
      }

      const expected = input.expectedFrom === undefined
        ? null
        : Array.isArray(input.expectedFrom) ? input.expectedFrom : [input.expectedFrom];
      if (expected && !expected.includes(current.status)) {
        throw new IllegalRunTransitionError(current.status, input.to);
      }
      assertLegalRunTransition(current.status, input.to);

      const timestamp = now();
      const error = input.patch?.error === undefined ? current.error : input.patch.error;
      const nextVersion = Number(runRow.state_version ?? 0) + 1;
      const currentGeneration = Number(runRow.run_generation ?? 0);
      const invalidatesProviderSideEffects = input.to === "cancelled" || input.to === "orphaned";
      const nextGeneration = invalidatesProviderSideEffects ? currentGeneration + 1 : currentGeneration;
      const transition = this.db.prepare(`
        UPDATE workbench_runs SET
          status = ?, updated_at = ?, started_at = ?, finished_at = ?, pid = ?,
          error_code = ?, error_message = ?, state_version = ?, run_generation = ?
        WHERE id = ? AND status = ? AND state_version = ? AND run_generation = ?
      `).run(
        input.to,
        timestamp,
        input.patch?.startedAt === undefined ? current.startedAt : input.patch.startedAt,
        input.patch?.finishedAt === undefined ? current.finishedAt : input.patch.finishedAt,
        input.patch?.pid === undefined ? current.pid : input.patch.pid,
        error ? redactText(error.code, 100) : null,
        error ? redactText(error.message, 2_000) : null,
        nextVersion,
        nextGeneration,
        input.runId,
        current.status,
        Number(runRow.state_version ?? 0),
        currentGeneration,
      );
      if (Number(transition.changes) !== 1) {
        throw new Error("Workbench run transition lost its compare-and-swap race.");
      }
      if (invalidatesProviderSideEffects) {
        this.invalidateRunCommandsWithinTransaction(input.runId, nextGeneration, timestamp);
      }

      const event = this.insertEvent(
        input.runId,
        input.event?.type ?? "status",
        {
          ...(input.event?.payload ?? {}),
          from: current.status,
          status: input.to,
          stateVersion: nextVersion,
        },
        timestamp,
      );
      const command = this.insertOutbox({
        runId: input.runId,
        eventId: event.id,
        type: commandType,
        payload: safeCommandPayload,
        payloadHash: commandPayloadHash,
        idempotencyKey: durableCommandKey,
        operation: input.to === "cancelled"
          ? "cancel"
          : (commandPayload as Record<string, unknown>).operation,
        targetStatus: input.to,
        availableAt: input.command.availableAt ?? timestamp,
        createdAt: timestamp,
      });
      if (input.to === "cancelled") {
        this.db.prepare(`
          UPDATE workbench_outbox SET state = 'completed', checkpoint = 'completed',
            completed_at = ?, outcome_json = ?, reservation_active = 0
          WHERE id = ? AND operation = 'cancel' AND run_generation = ?
        `).run(timestamp, JSON.stringify({ status: "cancelled", exitCode: null }), command.id, nextGeneration);
      }
      return {
        run: this.getRun(input.runId)!,
        event,
        command: this.getOutboxCommand(command.id)!,
        replayed: false,
      };
    });
  }

  appendEvent(runId: string, type: RunEventType, payload: Record<string, unknown>): RunEvent {
    return withImmediateTransaction(this.db, () => this.insertEvent(runId, type, payload, now()));
  }

  eventsAfter(runId: string, after = 0, limit = 500): RunEvent[] {
    const page = this.eventPage(runId, after, limit);
    if (page.gap) throw new WorkbenchEventGapError(page.gap);
    return page.events;
  }

  eventBounds(runId: string): EventBounds {
    const eventRow = this.db.prepare(`
      SELECT MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence, COUNT(*) AS retained_count
      FROM workbench_events WHERE run_id = ?
    `).get(runId) as Row;
    const retention = this.db.prepare(`
      SELECT * FROM workbench_event_retention WHERE run_id = ?
    `).get(runId) as Row | undefined;
    return {
      firstSequence: eventRow.first_sequence === null || eventRow.first_sequence === undefined
        ? null
        : Number(eventRow.first_sequence),
      lastSequence: eventRow.last_sequence === null || eventRow.last_sequence === undefined
        ? null
        : Number(eventRow.last_sequence),
      compactedThroughSequence: Number(retention?.compacted_through_sequence ?? 0),
      snapshotSequence: Number(retention?.snapshot_sequence ?? 0),
      snapshot: redactRecord(parseObject(retention?.snapshot_json)) as Record<string, unknown>,
      retainedCount: Number(eventRow.retained_count ?? 0),
    };
  }

  eventPage(runId: string, after = 0, limit = 500): EventPage {
    const requestedAfter = Math.max(0, Math.floor(after));
    const pageLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    return withReadTransaction(this.db, () => {
      const bounds = this.eventBounds(runId);
      this.eventPageSnapshotHook?.();
      const effectiveAfter = Math.max(requestedAfter, bounds.compactedThroughSequence);
      const rows = this.db.prepare(`
        SELECT * FROM workbench_events WHERE run_id = ? AND sequence > ?
        ORDER BY sequence ASC LIMIT ?
      `).all(runId, effectiveAfter, pageLimit + 1) as Row[];
      const hasMore = rows.length > pageLimit;
      const events = rows.slice(0, pageLimit).map(eventFromRow);
      const nextCursor = events.length
        ? events[events.length - 1].sequence
        : effectiveAfter;
      const gap = requestedAfter < bounds.compactedThroughSequence
        ? {
            requestedAfter,
            availableAfter: bounds.compactedThroughSequence,
            compactedThroughSequence: bounds.compactedThroughSequence,
            snapshotSequence: bounds.snapshotSequence,
            snapshot: bounds.snapshot,
          }
        : null;
      return { events, nextCursor, hasMore, gap, bounds };
    });
  }

  compactEvents(
    runId: string,
    throughSequence: number,
    snapshot: Record<string, unknown>,
  ): EventBounds {
    const safeSnapshot = redactRecord(snapshot) as Record<string, unknown>;
    const target = Math.max(0, Math.floor(throughSequence));
    return withImmediateTransaction(this.db, () => {
      if (!this.getRun(runId)) throw new WorkbenchRunNotFoundError(runId);
      const current = this.eventBounds(runId);
      if (target < current.compactedThroughSequence) {
        throw new RangeError("Event compaction cannot move the retained cursor backwards.");
      }
      const latestKnown = Math.max(current.lastSequence ?? 0, current.compactedThroughSequence);
      if (target > latestKnown) throw new RangeError("Event compaction cannot pass the latest durable event.");
      this.compactEventsWithinTransaction(runId, target, safeSnapshot, now());
      return this.eventBounds(runId);
    });
  }

  getOutboxCommand(id: string): OutboxCommand | null {
    const row = this.db.prepare("SELECT * FROM workbench_outbox WHERE id = ?").get(id) as Row | undefined;
    return row ? outboxFromRow(row) : null;
  }

  outboxForRun(runId: string, limit = 100): OutboxCommand[] {
    const rows = this.db.prepare(`
      SELECT * FROM workbench_outbox WHERE run_id = ?
      ORDER BY created_at ASC, id ASC LIMIT ?
    `).all(runId, Math.max(1, Math.min(1_000, Math.floor(limit)))) as Row[];
    return rows.map(outboxFromRow);
  }

  claimOutbox(workerId: string, leaseMs: number, limit = 1): OutboxCommand[] {
    const owner = boundedToken(workerId, "workerId", 200);
    const leaseDuration = Math.max(1_000, Math.min(300_000, Math.floor(leaseMs)));
    const claimLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return withImmediateTransaction(this.db, () => {
      const claimed: OutboxCommand[] = [];
      for (let index = 0; index < claimLimit; index += 1) {
        const claimedAt = now();
        const leaseExpiresAt = new Date(Date.parse(claimedAt) + leaseDuration).toISOString();
        const candidate = this.db.prepare(`
          SELECT o.id FROM workbench_outbox o
          JOIN workbench_runs r ON r.id = o.run_id
          WHERE o.run_generation = r.run_generation
            AND r.status NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')
            AND (
              (o.state = 'pending' AND o.available_at <= ?)
              OR (o.state = 'claimed' AND o.lease_expires_at IS NOT NULL AND o.lease_expires_at <= ?)
            )
          ORDER BY o.available_at ASC, o.created_at ASC, o.id ASC LIMIT 1
        `).get(claimedAt, claimedAt) as Row | undefined;
        if (!candidate) break;
        const result = this.db.prepare(`
          UPDATE workbench_outbox SET
            state = 'claimed', claimed_at = ?, claimed_by = ?, lease_expires_at = ?,
            fencing_token = fencing_token + 1, attempt_count = attempt_count + 1,
            delivery_attempt_count = delivery_attempt_count + 1
          WHERE id = ? AND (
            (state = 'pending' AND available_at <= ?)
            OR (state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
          )
            AND run_generation = (SELECT run_generation FROM workbench_runs WHERE id = run_id)
            AND EXISTS (
              SELECT 1 FROM workbench_runs r
              WHERE r.id = workbench_outbox.run_id
                AND r.status NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')
            )
        `).run(claimedAt, owner, leaseExpiresAt, String(candidate.id), claimedAt, claimedAt);
        if (!Number(result.changes)) continue;
        const row = this.db.prepare("SELECT * FROM workbench_outbox WHERE id = ?")
          .get(String(candidate.id)) as Row;
        claimed.push(outboxFromRow(row));
      }
      return claimed;
    });
  }

  heartbeatOutbox(id: string, workerId: string, fencingToken: number, leaseMs: number): boolean {
    const timestamp = now();
    const leaseExpiresAt = new Date(
      Date.parse(timestamp) + Math.max(1_000, Math.min(300_000, Math.floor(leaseMs))),
    ).toISOString();
    const result = this.db.prepare(`
      UPDATE workbench_outbox SET lease_expires_at = ?
      WHERE id = ? AND state = 'claimed' AND claimed_by = ? AND fencing_token = ?
        AND lease_expires_at > ?
        AND run_generation = (SELECT run_generation FROM workbench_runs WHERE id = run_id)
    `).run(leaseExpiresAt, id, workerId, Math.floor(fencingToken), timestamp);
    return Number(result.changes) === 1;
  }

  completeOutbox(id: string, workerId: string, fencingToken: number): boolean {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE workbench_outbox SET
        state = 'completed', completed_at = ?, lease_expires_at = NULL, last_error = NULL
      WHERE id = ? AND state = 'claimed' AND claimed_by = ? AND fencing_token = ?
        AND lease_expires_at > ?
        AND run_generation = (SELECT run_generation FROM workbench_runs WHERE id = run_id)
    `).run(timestamp, id, workerId, Math.floor(fencingToken), timestamp);
    return Number(result.changes) === 1;
  }

  retryOutbox(
    id: string,
    workerId: string,
    fencingToken: number,
    availableAt: string,
    error: string,
    dead = false,
  ): boolean {
    const timestamp = now();
    const nextState = dead ? "dead" : "pending";
    const result = this.db.prepare(`
      UPDATE workbench_outbox SET
        state = ?, available_at = ?, claimed_at = NULL, claimed_by = NULL,
        lease_expires_at = NULL, completed_at = ?, last_error = ?
      WHERE id = ? AND state = 'claimed' AND claimed_by = ? AND fencing_token = ?
        AND lease_expires_at > ?
        AND run_generation = (SELECT run_generation FROM workbench_runs WHERE id = run_id)
    `).run(
      nextState,
      availableAt,
      dead ? timestamp : null,
      redactText(error, 2_000),
      id,
      workerId,
      Math.floor(fencingToken),
      timestamp,
    );
    return Number(result.changes) === 1;
  }

  createApproval(runId: string, risk: ApprovalRisk, summary: string, action: string): ApprovalRequest {
    const id = randomUUID();
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO workbench_approvals
        (id, run_id, risk, summary, redacted_action, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, runId, risk, redactText(summary, 500), redactText(action, 2_000), createdAt);
    return this.getApproval(id)!;
  }

  getApproval(id: string): ApprovalRequest | null {
    const row = this.db.prepare("SELECT * FROM workbench_approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? approvalFromRow(row) : null;
  }

  resolveApproval(id: string, decision: ApprovalDecision): ApprovalRequest | null {
    const resolvedAt = now();
    const result = this.db.prepare(`
      UPDATE workbench_approvals SET status = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(decision, resolvedAt, id);
    return Number(result.changes) ? this.getApproval(id) : null;
  }

  enqueueMessage(runId: string, mode: MessageMode, content: string): QueuedMessage {
    const id = randomUUID();
    const createdAt = now();
    const safeContent = redactText(content, 32_000);
    this.db.prepare(`
      INSERT INTO workbench_queued_messages (id, run_id, mode, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, runId, mode, safeContent, createdAt);
    return { id, runId, mode, content: safeContent, createdAt, deliveredAt: null };
  }

  pendingMessages(runId: string, limit = 100): QueuedMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM workbench_queued_messages WHERE run_id = ? AND delivered_at IS NULL
      ORDER BY created_at ASC LIMIT ?
    `).all(runId, Math.max(1, Math.min(500, limit))) as Row[];
    return rows.map(messageFromRow);
  }

  markMessageDelivered(id: string): QueuedMessage | null {
    this.db.prepare(`
      UPDATE workbench_queued_messages SET delivered_at = ?
      WHERE id = ? AND delivered_at IS NULL
    `).run(now(), id);
    const row = this.db.prepare("SELECT * FROM workbench_queued_messages WHERE id = ?").get(id) as Row | undefined;
    return row ? messageFromRow(row) : null;
  }

  saveDraft(id: string, context: WorkContext, content: string): WorkbenchDraft {
    const updatedAt = now();
    const safeContent = redactText(content, 32_000);
    const safeContext = redactRecord(context) as unknown as WorkContext;
    this.db.prepare(`
      INSERT INTO workbench_drafts (id, context_json, content, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET context_json = excluded.context_json,
        content = excluded.content, updated_at = excluded.updated_at
    `).run(id, JSON.stringify(safeContext), safeContent, updatedAt);
    return { id, context: safeContext, content: safeContent, updatedAt };
  }

  getDraft(id: string): WorkbenchDraft | null {
    const row = this.db.prepare("SELECT * FROM workbench_drafts WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      context: redactRecord(parseObject(row.context_json)) as unknown as WorkContext,
      content: redactText(String(row.content), 32_000),
      updatedAt: String(row.updated_at),
    };
  }

  deleteDraft(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM workbench_drafts WHERE id = ?").run(id).changes) > 0;
  }

  orphanActiveRuns(): Run[] {
    const active = this.db.prepare(`
      SELECT r.* FROM workbench_runs r
      WHERE r.status IN ('claimed', 'starting', 'running', 'awaiting_approval', 'stopping')
        AND NOT EXISTS (
          SELECT 1 FROM workbench_execution_recovery recovery
          WHERE recovery.run_id = r.id AND recovery.checkpoint <> 'completed'
        )
    `).all() as Row[];
    return active.map((row) => this.transitionRunWithCommand({
      runId: String(row.id),
      to: "orphaned",
      expectedFrom: String(row.status) as RunStatus,
      command: {
        type: "run.reconcile_orphan",
        idempotencyKey: `restart:${String(row.id)}:${String(row.status)}:${String(row.state_version ?? 0)}`,
        payload: { reason: "supervisor_restarted" },
      },
      event: {
        type: "error",
        payload: {
          code: "supervisor_restarted",
          message: "The server restarted while this run was active.",
        },
      },
      patch: {
        finishedAt: null,
        pid: null,
        error: {
          code: "supervisor_restarted",
          message: "The server restarted while this run was active.",
        },
      },
    }).run);
  }

  migrationLedger(): AppliedWorkbenchMigration[] {
    return this.db.prepare(`
      SELECT version, name, checksum_sha256 AS checksumSha256, applied_at AS appliedAt
      FROM workbench_schema_migrations ORDER BY version ASC
    `).all() as unknown as AppliedWorkbenchMigration[];
  }

  storageConfiguration(): {
    journalMode: string;
    foreignKeys: boolean;
    busyTimeoutMs: number;
    synchronous: number;
    schemaVersion: number;
  } {
    return {
      journalMode: String((this.db.prepare("PRAGMA journal_mode").get() as Row).journal_mode),
      foreignKeys: Boolean(Number((this.db.prepare("PRAGMA foreign_keys").get() as Row).foreign_keys)),
      busyTimeoutMs: Number((this.db.prepare("PRAGMA busy_timeout").get() as Row).timeout ?? 0),
      synchronous: Number((this.db.prepare("PRAGMA synchronous").get() as Row).synchronous ?? 0),
      schemaVersion: Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version ?? 0),
    };
  }

  async createBackup(backupPath: string): Promise<WorkbenchBackupManifest> {
    const resolved = path.resolve(backupPath);
    if (resolved === path.resolve(this.databasePath)) {
      throw new Error("Workbench backup path must differ from the live database path.");
    }
    if (existsSync(resolved)) {
      throw new Error("Workbench backup destination already exists; refusing to overwrite it.");
    }
    mkdirSync(path.dirname(resolved), { recursive: true });
    await backup(this.db, resolved);
    return verifyWorkbenchBackup(resolved);
  }

  private admissionSnapshot(): AdmissionSnapshot {
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('claimed','starting','running','awaiting_approval','stopping') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status IN ('requested','queued') THEN 1 ELSE 0 END) AS queued
      FROM workbench_runs
    `).get() as Row;
    const reserved: ResourceBudget = {
      cpuTimeMs: 0,
      residentMemoryBytes: 0,
      diskBytes: 0,
      processCount: 0,
      outputBytes: 0,
    };
    const reservations = this.db.prepare(`
      SELECT resources_json FROM workbench_outbox WHERE reservation_active = 1
    `).all() as Row[];
    for (const row of reservations) {
      const resource = requestedResources({ resources: parseObject(row.resources_json) });
      for (const field of RESOURCE_FIELDS) reserved[field] += resource[field];
    }
    return {
      activeRuns: Number(counts.active ?? 0),
      queuedRuns: Number(counts.queued ?? 0),
      reserved,
    };
  }

  private retainedEventStoreBytes(): number {
    const row = this.db.prepare(`
      SELECT
        COALESCE((SELECT SUM(length(CAST(payload_json AS BLOB))) FROM workbench_events), 0)
        + COALESCE((SELECT SUM(length(CAST(snapshot_json AS BLOB))) FROM workbench_event_retention), 0)
        AS bytes
    `).get() as Row;
    return Number(row.bytes ?? 0);
  }

  private automaticCompactionSnapshot(runId: string, throughSequence: number): Record<string, unknown> {
    const run = this.db.prepare(`
      SELECT status FROM workbench_runs WHERE id = ?
    `).get(runId) as Row | undefined;
    if (!run) throw new WorkbenchRunNotFoundError(runId);
    return {
      reason: "automatic_event_quota_compaction",
      runId,
      status: String(run.status),
      through: throughSequence,
    };
  }

  private compactEventsWithinTransaction(
    runId: string,
    throughSequence: number,
    snapshot: Record<string, unknown>,
    timestamp: string,
  ): void {
    const serializedSnapshot = JSON.stringify(snapshot);
    const snapshotBytes = Buffer.byteLength(serializedSnapshot, "utf8");
    if (snapshotBytes > this.eventQuotas.maxSnapshotBytes) {
      throw new WorkbenchEventQuotaError(
        "event_snapshot_too_large",
        "Workbench event snapshot exceeds the per-snapshot byte quota.",
        this.eventQuotas.maxSnapshotBytes,
        snapshotBytes,
      );
    }
    if (snapshotBytes > this.eventQuotas.maxStoreBytes) {
      throw new WorkbenchEventQuotaError(
        "event_store_full",
        "Workbench retained event store cannot accept the compaction snapshot.",
        this.eventQuotas.maxStoreBytes,
        snapshotBytes,
      );
    }
    const projectedBytes = this.projectedEventStoreBytesAfterCompaction(
      runId,
      throughSequence,
      snapshotBytes,
    );
    if (projectedBytes > this.eventQuotas.maxStoreBytes) {
      throw new WorkbenchEventQuotaError(
        "event_store_full",
        "Workbench retained event store cannot accept the compaction snapshot.",
        this.eventQuotas.maxStoreBytes,
        projectedBytes,
      );
    }
    // Delete first inside the same transaction so the DB quota trigger measures
    // the committed post-compaction footprint rather than a transient double copy.
    this.db.prepare(`
      DELETE FROM workbench_events WHERE run_id = ? AND sequence <= ?
    `).run(runId, throughSequence);
    const existingRetention = this.db.prepare(`
      SELECT 1 FROM workbench_event_retention WHERE run_id = ?
    `).get(runId) as Row | undefined;
    if (existingRetention) {
      this.db.prepare(`
        UPDATE workbench_event_retention SET
          compacted_through_sequence = ?, snapshot_sequence = ?,
          snapshot_json = ?, updated_at = ?
        WHERE run_id = ?
      `).run(throughSequence, throughSequence, serializedSnapshot, timestamp, runId);
    } else {
      this.db.prepare(`
        INSERT INTO workbench_event_retention (
          run_id, compacted_through_sequence, snapshot_sequence, snapshot_json, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(runId, throughSequence, throughSequence, serializedSnapshot, timestamp);
    }
  }

  private projectedEventStoreBytesAfterCompaction(
    runId: string,
    throughSequence: number,
    replacementSnapshotBytes: number,
    pendingEventBytes = 0,
  ): number {
    const row = this.db.prepare(`
      SELECT
        COALESCE((
          SELECT SUM(length(CAST(payload_json AS BLOB))) FROM workbench_events
          WHERE NOT (run_id = ? AND sequence <= ?)
        ), 0)
        + COALESCE((
          SELECT SUM(length(CAST(snapshot_json AS BLOB))) FROM workbench_event_retention
          WHERE run_id <> ?
        ), 0) AS bytes
    `).get(runId, throughSequence, runId) as Row;
    return Number(row.bytes ?? 0) + replacementSnapshotBytes + pendingEventBytes;
  }

  private automaticCompactionTarget(
    runId: string,
    minimumThroughSequence: number,
    pendingEventBytes: number,
  ): { throughSequence: number; snapshot: Record<string, unknown> } {
    let throughSequence = minimumThroughSequence;
    while (true) {
      const snapshot = this.automaticCompactionSnapshot(runId, throughSequence);
      const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
      const projected = this.projectedEventStoreBytesAfterCompaction(
        runId,
        throughSequence,
        snapshotBytes,
        pendingEventBytes,
      );
      if (projected <= this.eventQuotas.maxStoreBytes) return { throughSequence, snapshot };
      const next = this.db.prepare(`
        SELECT MIN(sequence) AS sequence FROM workbench_events
        WHERE run_id = ? AND sequence > ?
      `).get(runId, throughSequence) as Row;
      if (next.sequence === null || next.sequence === undefined) {
        throw new WorkbenchEventQuotaError(
          "event_store_full",
          "Workbench retained event store cannot create quota capacity by compaction.",
          this.eventQuotas.maxStoreBytes,
          projected,
        );
      }
      throughSequence = Number(next.sequence);
    }
  }

  private makeEventCapacity(runId: string, payloadBytes: number, timestamp: string): void {
    const countRow = this.db.prepare(`
      SELECT COUNT(*) AS count FROM workbench_events WHERE run_id = ?
    `).get(runId) as Row;
    const retainedCount = Number(countRow.count ?? 0);
    if (retainedCount >= this.eventQuotas.maxRetainedEventsPerRun) {
      const deleteCount = retainedCount - this.eventQuotas.maxRetainedEventsPerRun + 1;
      const target = this.db.prepare(`
        SELECT sequence FROM workbench_events
        WHERE run_id = ? ORDER BY sequence ASC LIMIT 1 OFFSET ?
      `).get(runId, deleteCount - 1) as Row | undefined;
      if (!target) {
        throw new WorkbenchEventQuotaError(
          "event_store_full",
          "Workbench event count quota could not create retained capacity.",
          this.eventQuotas.maxRetainedEventsPerRun,
          retainedCount + 1,
        );
      }
      const automatic = this.automaticCompactionTarget(
        runId,
        Number(target.sequence),
        payloadBytes,
      );
      this.compactEventsWithinTransaction(
        runId,
        automatic.throughSequence,
        automatic.snapshot,
        timestamp,
      );
    }

    let retainedBytes = this.retainedEventStoreBytes();
    while (retainedBytes + payloadBytes > this.eventQuotas.maxStoreBytes) {
      const oldest = this.db.prepare(`
        SELECT run_id, sequence FROM workbench_events
        ORDER BY created_at ASC, sequence ASC LIMIT 1
      `).get() as Row | undefined;
      if (!oldest) break;
      const oldestRunId = String(oldest.run_id);
      const automatic = this.automaticCompactionTarget(
        oldestRunId,
        Number(oldest.sequence),
        payloadBytes,
      );
      this.compactEventsWithinTransaction(
        oldestRunId,
        automatic.throughSequence,
        automatic.snapshot,
        timestamp,
      );
      retainedBytes = this.retainedEventStoreBytes();
    }
    if (retainedBytes + payloadBytes > this.eventQuotas.maxStoreBytes) {
      throw new WorkbenchEventQuotaError(
        "event_store_full",
        "Workbench retained event store cannot accept the event after automatic compaction.",
        this.eventQuotas.maxStoreBytes,
        retainedBytes + payloadBytes,
      );
    }
  }

  private insertEvent(
    runId: string,
    type: RunEventType,
    payload: Record<string, unknown>,
    createdAt: string,
  ): RunEvent {
    const id = randomUUID();
    const safePayload = redactRecord(payload) as Record<string, unknown>;
    const serializedPayload = JSON.stringify(safePayload);
    const payloadBytes = Buffer.byteLength(serializedPayload, "utf8");
    if (payloadBytes > this.eventQuotas.maxPayloadBytesPerEvent) {
      throw new WorkbenchEventQuotaError(
        "event_too_large",
        "Workbench event payload exceeds the per-event byte quota.",
        this.eventQuotas.maxPayloadBytesPerEvent,
        payloadBytes,
      );
    }
    this.makeEventCapacity(runId, payloadBytes, createdAt);
    const result = this.db.prepare(`
      INSERT INTO workbench_events (id, run_id, type, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, runId, type, createdAt, serializedPayload);
    return {
      id,
      sequence: Number(result.lastInsertRowid),
      runId,
      type,
      createdAt,
      payload: safePayload,
    };
  }

  private insertOutbox(input: {
    runId: string;
    eventId: string | null;
    type: string;
    payload: Record<string, unknown>;
    payloadHash: string;
    idempotencyKey: string;
    operation?: unknown;
    targetStatus: RunStatus | null;
    availableAt: string;
    createdAt: string;
  }): OutboxCommand {
    const id = randomUUID();
    const run = this.db.prepare(`
      SELECT run_generation, state_version FROM workbench_runs WHERE id = ?
    `).get(input.runId) as Row | undefined;
    if (!run) throw new WorkbenchRunNotFoundError(input.runId);
    const explicitOperation = input.operation !== undefined
      ? input.operation
      : Object.hasOwn(input.payload, "operation")
        ? input.payload.operation
        : undefined;
    const operation = outboxOperation(explicitOperation, input.type);
    const persistedOperation = operation === "reconcile_orphan" ? "unknown" : operation;
    this.db.prepare(`
      INSERT INTO workbench_outbox (
        id, run_id, event_id, command_type, payload_json, payload_hash,
        idempotency_key, operation, run_generation, run_state_version,
        target_status, available_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.runId,
      input.eventId,
      input.type,
      JSON.stringify(input.payload),
      input.payloadHash,
      input.idempotencyKey,
      persistedOperation,
      Number(run.run_generation ?? 0),
      Number(run.state_version ?? 0),
      input.targetStatus,
      input.availableAt,
      input.createdAt,
    );
    if (operation === "reconcile_orphan") {
      this.db.prepare(`
        INSERT INTO workbench_command_semantics (command_id, semantics, created_at)
        VALUES (?, 'orphan_reconciliation', ?)
      `).run(id, input.createdAt);
    }
    return this.getOutboxCommand(id)!;
  }

  private insertCreateReceipt(
    idempotencyScope: string,
    runId: string,
    commandId: string,
    event: RunEvent,
    createdAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO workbench_create_receipts (
        idempotency_scope, run_id, command_id, event_id, event_sequence,
        event_type, event_created_at, event_payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      idempotencyScope,
      runId,
      commandId,
      event.id,
      event.sequence,
      event.type,
      event.createdAt,
      JSON.stringify(event.payload),
      createdAt,
    );
  }

  private invalidateRunCommandsWithinTransaction(
    runId: string,
    currentGeneration: number,
    timestamp: string,
  ): void {
    this.db.prepare(`
      UPDATE workbench_outbox SET
        state = 'dead', completed_at = ?, claimed_at = NULL, claimed_by = NULL,
        lease_expires_at = NULL, reservation_active = 0,
        last_error = 'run_generation_invalidated'
      WHERE run_id = ? AND run_generation < ? AND state IN ('pending', 'claimed')
    `).run(timestamp, runId, currentGeneration);
  }
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function verifyWorkbenchBackup(
  backupPath: string,
  expectedSha256?: string,
): WorkbenchBackupVerification {
  const resolved = path.resolve(backupPath);
  const sha256 = fileSha256(resolved);
  if (expectedSha256 && sha256 !== expectedSha256.toLowerCase()) {
    throw new Error(`Workbench backup SHA-256 mismatch: expected ${expectedSha256}, received ${sha256}.`);
  }
  const db = new DatabaseSync(resolved, { readOnly: true });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const integrityRow = db.prepare("PRAGMA quick_check").get() as Row;
    if (String(integrityRow.quick_check) !== "ok") {
      throw new Error(`Workbench backup failed SQLite quick_check: ${String(integrityRow.quick_check)}.`);
    }
    const migrations = db.prepare(`
      SELECT version, name, checksum_sha256 AS checksumSha256, applied_at AS appliedAt
      FROM workbench_schema_migrations ORDER BY version ASC
    `).all() as unknown as AppliedWorkbenchMigration[];
    if (migrations.length !== WORKBENCH_MIGRATIONS.length) {
      throw new Error("Workbench backup migration ledger is incomplete.");
    }
    for (const migration of WORKBENCH_MIGRATIONS) {
      const applied = migrations.find((entry) => entry.version === migration.version);
      if (
        !applied
        || applied.name !== migration.name
        || applied.checksumSha256 !== migrationChecksum(migration)
      ) {
        throw new Error(`Workbench backup migration ${migration.version} failed checksum verification.`);
      }
    }
    const schemaVersion = Number((db.prepare("PRAGMA user_version").get() as Row).user_version ?? 0);
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM workbench_runs) AS run_count,
        (SELECT COUNT(*) FROM workbench_events) AS event_count,
        (SELECT COALESCE(MAX(sequence), 0) FROM workbench_events) AS max_event_sequence
    `).get() as Row;
    return {
      path: resolved,
      sha256,
      sizeBytes: statSync(resolved).size,
      createdAt: new Date().toISOString(),
      schemaVersion,
      runCount: Number(counts.run_count),
      eventCount: Number(counts.event_count),
      maxEventSequence: Number(counts.max_event_sequence),
      integrity: "ok",
      migrations,
    };
  } finally {
    db.close();
  }
}

export function verifyWorkbenchRestore(
  backupPath: string,
  restorePath: string,
  expectedSha256: string,
): WorkbenchBackupVerification {
  const backupVerification = verifyWorkbenchBackup(backupPath, expectedSha256);
  const resolvedRestore = path.resolve(restorePath);
  if (existsSync(resolvedRestore)) {
    throw new Error("Workbench restore destination already exists; refusing to overwrite it.");
  }
  mkdirSync(path.dirname(resolvedRestore), { recursive: true });
  copyFileSync(backupVerification.path, resolvedRestore);
  const restored = verifyWorkbenchBackup(resolvedRestore, backupVerification.sha256);
  const store = new WorkbenchStore(resolvedRestore);
  store.close();
  return restored;
}
