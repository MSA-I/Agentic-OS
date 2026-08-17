import "server-only";

import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  DEFAULT_RESOURCE_REQUEST,
  evaluateClaimAdmission,
  type AdmissionSnapshot,
  type ResourceBudget,
} from "./resourceAdmission";
import { redactRecord, redactText } from "./redaction";
import { assertLegalRunTransition, TERMINAL_RUN_STATUSES } from "./stateMachine";
import type { RunStatus } from "./types";
import { durableOutcomeDigestSha256 } from "./durableWorker";
import type {
  AcquireProviderCircuitInput,
  ClaimedCommand,
  ClaimNextCommandInput,
  CompletionInput,
  DurableCommand,
  DurableCommandOperation,
  DurableExternalStatusHighWater,
  DurableExternalStatusHighWaterInput,
  DurableExecutionCleanupIntent,
  DurableExecutionCleanupRepository,
  DurableExecutionCleanupResult,
  DurableExecutionIdentity,
  DurableLaunchAuthorization,
  DurableExecutionOutcome,
  DurableExecutionRecoveryRecord,
  DurableProviderCircuitLease,
  DurableProviderCircuitPermit,
  DurableProviderCircuitSnapshot,
  DurableProcessIdentity,
  DurableRecoveryMutationResult,
  DurableWorkerRepository,
  FailureDispositionInput,
  FencedMutationResult,
  LeaseGuard,
  ProviderAttemptAuthorizationResult,
  ProviderLaunchAuthorizationInput,
  SpawnIntentInput,
  SpawnObservationInput,
  VerifiedDurableTerminalCheckpointInput,
} from "./durableWorker";

type Row = Record<string, unknown>;
const OPERATIONS = new Set<DurableCommandOperation>([
  "start", "resume", "steer", "queue", "cancel", "reconcile_orphan",
]);
const CHECKPOINT_ORDER = ["pending", "dequeued", "spawn_intent", "spawned", "registered", "completed"] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const JOURNAL_GENERATION_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;

function transaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* SQLite may auto-rollback */ }
    throw error;
  }
}

function object(raw: unknown): Record<string, unknown> {
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

function operation(row: Row): DurableCommandOperation | null {
  if (String(row.command_semantics ?? "") === "orphan_reconciliation") {
    return "reconcile_orphan";
  }
  const persisted = String(row.operation ?? "unknown").toLowerCase();
  return OPERATIONS.has(persisted as DurableCommandOperation)
    ? persisted as DurableCommandOperation
    : null;
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(maximum, Number(value))
    : fallback;
}

function resources(value: unknown): ResourceBudget {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    cpuTimeMs: positiveInteger(input.cpuTimeMs, DEFAULT_RESOURCE_REQUEST.cpuTimeMs, Number.MAX_SAFE_INTEGER),
    residentMemoryBytes: positiveInteger(input.residentMemoryBytes, DEFAULT_RESOURCE_REQUEST.residentMemoryBytes, Number.MAX_SAFE_INTEGER),
    diskBytes: positiveInteger(input.diskBytes, DEFAULT_RESOURCE_REQUEST.diskBytes, Number.MAX_SAFE_INTEGER),
    processCount: positiveInteger(input.processCount, DEFAULT_RESOURCE_REQUEST.processCount, Number.MAX_SAFE_INTEGER),
    outputBytes: positiveInteger(input.outputBytes, DEFAULT_RESOURCE_REQUEST.outputBytes, Number.MAX_SAFE_INTEGER),
  };
}

function addBudget(target: ResourceBudget, value: ResourceBudget): void {
  target.cpuTimeMs += value.cpuTimeMs;
  target.residentMemoryBytes += value.residentMemoryBytes;
  target.diskBytes += value.diskBytes;
  target.processCount += value.processCount;
  target.outputBytes += value.outputBytes;
}

function zeroBudget(): ResourceBudget {
  return { cpuTimeMs: 0, residentMemoryBytes: 0, diskBytes: 0, processCount: 0, outputBytes: 0 };
}

function commandFromRow(row: Row): DurableCommand {
  const payload = redactRecord(object(row.payload_json)) as Record<string, unknown>;
  const durableOperation = operation(row);
  if (!durableOperation) throw new Error("Durable command has an unknown operation and cannot execute.");
  const resourceBudget = durableOperation === "cancel"
    ? zeroBudget()
    : resources(object(row.resources_json));
  const providerAttempts = Number(row.provider_attempt_count ?? 0);
  const providerAttemptStarted = Number(row.provider_attempt_fencing_token ?? -1)
    === Number(row.fencing_token ?? 0);
  const hasVerifiedTerminalRecovery = row.recovery_terminal_status !== null
    && row.recovery_terminal_status !== undefined
    && Number(row.recovery_termination_verified ?? 0) === 1;
  return {
    id: String(row.id),
    runId: String(row.run_id),
    provider: String(row.provider),
    operation: durableOperation,
    payload,
    payloadHash: String(row.payload_hash),
    idempotencyKey: String(row.idempotency_key),
    runGeneration: Number(row.run_generation ?? 0),
    runStateVersion: Number(row.run_state_version ?? 0),
    executionId: String(row.execution_id),
    attempt: hasVerifiedTerminalRecovery
      ? Math.max(1, providerAttempts)
      : providerAttempts + (providerAttemptStarted ? 0 : 1),
    deliveryAttempts: Number(row.delivery_attempt_count ?? row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts),
    checkpoint: String(row.checkpoint) as DurableCommand["checkpoint"],
    availableAt: String(row.available_at),
    resources: resourceBudget,
  };
}

function durableJobObjectId(executionId: string): string {
  const safeExecutionId = executionId.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 120);
  return `agent-os-${safeExecutionId}`;
}

function failureText(input: FailureDispositionInput): string {
  return redactText(`${input.failure.failureClass}: ${input.failure.message}`, 2_000);
}

function hasVerifiedTerminalOutcome(outcome: DurableExecutionOutcome): boolean {
  const metadata = outcome.metadata && typeof outcome.metadata === "object" && !Array.isArray(outcome.metadata)
    ? outcome.metadata as Record<string, unknown>
    : {};
  return ["succeeded", "failed", "cancelled", "blocked"].includes(outcome.status)
    && metadata.terminationVerified === true;
}

function canonicalCancelOutcome(providerOutcome: DurableExecutionOutcome): DurableExecutionOutcome {
  return {
    ...providerOutcome,
    metadata: {
      ...(providerOutcome.metadata ?? {}),
      cancelRequested: true,
      cancelledBeforeCompletion: providerOutcome.status === "cancelled",
      terminationVerified: true,
    },
  };
}

interface VerifiedCancellationPair {
  providerCommand: Row;
  cancelCommand: Row;
  providerIdentity: DurableExecutionIdentity;
  providerOutcome: DurableExecutionOutcome;
}

const BLOCKED_FAILURE_CLASSES = new Set(["auth", "quota", "provider_unavailable", "unsupported"]);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function assertProcessIdentity(process: DurableProcessIdentity, identity: DurableExecutionIdentity): void {
  if (!Number.isSafeInteger(process.pid) || process.pid <= 0) {
    throw new TypeError("Durable process pid must be a positive safe integer.");
  }
  if (process.jobObjectId !== identity.jobObjectId) {
    throw new Error("Durable process Job Object identity does not match spawn intent.");
  }
  if (!pathLikeExecutable(process.executablePath) || !/^[a-f0-9]{64}$/iu.test(process.executableHash)) {
    throw new Error("Durable process executable path/hash identity is invalid.");
  }
  if (!Number.isFinite(Date.parse(process.startedAt))) {
    throw new Error("Durable process startedAt is invalid.");
  }
  if (
    process.rootProcessStartedAtFileTime !== undefined
    && !/^\d+$/u.test(process.rootProcessStartedAtFileTime)
  ) {
    throw new Error("Durable process Windows creation time is invalid.");
  }
  if (
    process.helperProcessStartedAtFileTime !== undefined
    && !/^\d+$/u.test(process.helperProcessStartedAtFileTime)
  ) {
    throw new Error("Durable helper Windows creation time is invalid.");
  }
  if (process.helperPid !== undefined && (!Number.isSafeInteger(process.helperPid) || process.helperPid <= 0)) {
    throw new Error("Durable helper pid is invalid.");
  }
}

function pathLikeExecutable(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function assertExecutionAssociation(row: Row, identity: DurableExecutionIdentity): void {
  if (
    String(row.id) !== identity.commandId
    || String(row.run_id) !== identity.runId
    || String(row.execution_id) !== identity.executionId
  ) {
    throw new Error("Durable execution identity does not match command/run association.");
  }
}

function assertProviderLaunchAuthorizationInput(input: ProviderLaunchAuthorizationInput): void {
  if (!/^[A-Za-z0-9_.-]{16,128}$/u.test(input.authorizationId)) {
    throw new TypeError("Provider launch authorization ID is invalid.");
  }
  if (!Number.isSafeInteger(input.launchGeneration) || input.launchGeneration <= 0) {
    throw new TypeError("Provider launch generation must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(input.expectedAttempt) || input.expectedAttempt <= 0) {
    throw new TypeError("Provider launch attempt must be a positive safe integer.");
  }
  if (!JOURNAL_GENERATION_PATTERN.test(input.journalGeneration)) {
    throw new TypeError("Provider launch journal generation is invalid.");
  }
  if (!SHA256_PATTERN.test(input.descriptorHmacSha256)) {
    throw new TypeError("Provider launch descriptor HMAC is invalid.");
  }
}

function launchAuthorizationFromReceiptRow(row: Row): DurableLaunchAuthorization {
  return {
    executionId: String(row.execution_id),
    commandId: String(row.command_id),
    runId: String(row.run_id),
    jobObjectId: String(row.job_object_id),
    authorizationId: String(row.authorization_id),
    launchGeneration: Number(row.launch_generation),
    attempt: Number(row.attempt),
    journalGeneration: String(row.journal_generation),
    descriptorHmacSha256: String(row.descriptor_hmac_sha256),
    authorizedAt: String(row.authorized_at),
  };
}

function processFromRecoveryRow(row: Row): DurableProcessIdentity | null {
  if (row.pid === null || row.pid === undefined) return null;
  return {
    pid: Number(row.pid),
    jobObjectId: String(row.job_object_id),
    ...(optionalString(row.job_name) ? { jobName: String(row.job_name) } : {}),
    ...(optionalString(row.root_process_started_at_file_time)
      ? { rootProcessStartedAtFileTime: String(row.root_process_started_at_file_time) }
      : {}),
    ...(optionalPositiveInteger(row.helper_pid) ? { helperPid: Number(row.helper_pid) } : {}),
    ...(optionalString(row.helper_process_started_at_file_time)
      ? { helperProcessStartedAtFileTime: String(row.helper_process_started_at_file_time) }
      : {}),
    executablePath: String(row.executable_path),
    executableHash: String(row.executable_hash),
    startedAt: String(row.process_started_at),
  };
}

function outcomeFromRecoveryRow(row: Row): DurableExecutionOutcome | null {
  if (row.terminal_status === null || row.terminal_status === undefined) return null;
  const metadata = redactRecord(object(row.terminal_metadata_json)) as Record<string, unknown>;
  return {
    status: String(row.terminal_status) as DurableExecutionOutcome["status"],
    exitCode: row.terminal_exit_code === null || row.terminal_exit_code === undefined
      ? null
      : Number(row.terminal_exit_code),
    ...(optionalString(row.terminal_error_code) ? { errorCode: String(row.terminal_error_code) } : {}),
    ...(optionalString(row.terminal_error_message) ? { errorMessage: String(row.terminal_error_message) } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}

function launchAuthorizationFromRecoveryRow(row: Row): DurableLaunchAuthorization | null {
  if (!optionalString(row.launch_authorization_id)) return null;
  return {
    executionId: String(row.execution_id),
    commandId: String(row.command_id),
    runId: String(row.run_id),
    jobObjectId: String(row.job_object_id),
    authorizationId: String(row.launch_authorization_id),
    launchGeneration: Number(row.launch_generation),
    attempt: Number(row.launch_attempt),
    journalGeneration: String(row.launch_journal_generation),
    descriptorHmacSha256: String(row.launch_descriptor_hmac_sha256),
    authorizedAt: String(row.launch_authorized_at),
  };
}

function recoveryFromRow(row: Row): DurableExecutionRecoveryRecord {
  const outcome = outcomeFromRecoveryRow(row);
  const checkpoint = String(row.checkpoint) as DurableExecutionRecoveryRecord["checkpoint"];
  return {
    executionId: String(row.execution_id),
    commandId: String(row.command_id),
    runId: String(row.run_id),
    jobObjectId: String(row.job_object_id),
    checkpoint,
    process: processFromRecoveryRow(row),
    terminal: outcome
      ? {
          outcome,
          nativeTerminalDigestSha256: optionalString(row.terminal_native_digest_sha256) ?? null,
          controllerOutcomeDigestSha256: optionalString(
            row.terminal_controller_outcome_digest_sha256,
          ) ?? null,
          observedAt: String(row.terminal_observed_at),
          terminationVerified: true,
          source: String(row.terminal_source) as
            | "worker"
            | "windows_job_helper"
            | "windows_job_controller",
        }
      : null,
    externalStatusHighWater: optionalString(row.external_journal_generation)
      ? {
          executionId: String(row.execution_id),
          commandId: String(row.command_id),
          runId: String(row.run_id),
          jobObjectId: String(row.job_object_id),
          journalGeneration: String(row.external_journal_generation),
          sequence: Number(row.external_status_sequence),
          previousSequence: Number(row.external_previous_status_sequence),
          previousSnapshotDigestSha256: String(row.external_previous_snapshot_digest_sha256),
          previousJournalDigestSha256: String(row.external_previous_journal_digest_sha256),
          terminal: Number(row.external_status_terminal) === 1,
          snapshotDigestSha256: String(row.external_snapshot_digest_sha256),
          journalDigestSha256: String(row.external_journal_digest_sha256),
          authenticatedPayloadDigestSha256: String(row.external_authenticated_payload_digest_sha256),
          nativeTerminalDigestSha256: optionalString(row.external_native_terminal_digest_sha256) ?? null,
          nativeTerminalStatus: (optionalString(row.external_native_terminal_status) ?? null) as
            DurableExecutionOutcome["status"] | null,
          nativeExitCode: row.external_native_exit_code === null
            || row.external_native_exit_code === undefined
            ? null
            : Number(row.external_native_exit_code),
          terminationVerified: Number(row.external_termination_verified) === 1,
          chainVersion: Number(row.external_chain_version) as 1 | 2,
          controllerOutcomeDigestSha256: optionalString(
            row.external_controller_outcome_digest_sha256,
          ) ?? null,
          observedAt: String(row.external_status_observed_at),
          updatedAt: String(row.external_status_updated_at),
        } satisfies DurableExternalStatusHighWater
      : null,
    launchAuthorization: launchAuthorizationFromRecoveryRow(row),
    reconnectable: false,
    recoveryAction: checkpoint === "completed"
      ? "completed"
      : outcome ? "terminal_replay" : "durable_terminal_probe_required",
    updatedAt: String(row.updated_at),
  };
}

function cleanupIntentFromRow(row: Row): DurableExecutionCleanupIntent {
  return {
    executionId: String(row.execution_id),
    commandId: String(row.command_id),
    runId: String(row.run_id),
    jobObjectId: String(row.job_object_id),
    runGeneration: Number(row.run_generation),
    chainVersion: Number(row.chain_version) as 2,
    journalGeneration: String(row.journal_generation),
    statusSequence: Number(row.status_sequence),
    previousStatusSequence: Number(row.previous_status_sequence),
    previousSnapshotDigestSha256: String(row.previous_snapshot_digest_sha256),
    previousJournalDigestSha256: String(row.previous_journal_digest_sha256),
    snapshotDigestSha256: String(row.snapshot_digest_sha256),
    journalDigestSha256: String(row.journal_digest_sha256),
    authenticatedPayloadDigestSha256: String(row.authenticated_payload_digest_sha256),
    nativeTerminalDigestSha256: String(row.native_terminal_digest_sha256),
    controllerOutcomeDigestSha256: String(row.controller_outcome_digest_sha256),
    nativeTerminalStatus: String(row.native_terminal_status) as DurableExecutionOutcome["status"],
    nativeExitCode: row.native_exit_code === null || row.native_exit_code === undefined
      ? null
      : Number(row.native_exit_code),
    terminal: true,
    terminationVerified: true,
    terminalStatus: String(row.terminal_status) as DurableExecutionOutcome["status"],
    terminalObservedAt: String(row.terminal_observed_at),
    rootProcessId: row.root_process_id === null || row.root_process_id === undefined
      ? null
      : Number(row.root_process_id),
    rootProcessStartedAtFileTime: row.root_process_started_at_file_time === null
      || row.root_process_started_at_file_time === undefined
      ? null
      : String(row.root_process_started_at_file_time),
    jobName: row.job_name === null || row.job_name === undefined ? null : String(row.job_name),
    helperProcessId: row.helper_process_id === null || row.helper_process_id === undefined
      ? null
      : Number(row.helper_process_id),
    helperProcessStartedAtFileTime: row.helper_process_started_at_file_time === null
      || row.helper_process_started_at_file_time === undefined
      ? null
      : String(row.helper_process_started_at_file_time),
    state: String(row.state) as DurableExecutionCleanupIntent["state"],
    availableAt: String(row.available_at),
    attemptCount: Number(row.attempt_count),
    claimedAt: row.claimed_at === null || row.claimed_at === undefined ? null : String(row.claimed_at),
    claimedBy: row.claimed_by === null || row.claimed_by === undefined ? null : String(row.claimed_by),
    fencingToken: Number(row.fencing_token),
    leaseExpiresAt: row.lease_expires_at === null || row.lease_expires_at === undefined
      ? null
      : String(row.lease_expires_at),
    lastErrorCode: row.last_error_code === null || row.last_error_code === undefined
      ? null
      : String(row.last_error_code),
    lastErrorMessage: row.last_error_message === null || row.last_error_message === undefined
      ? null
      : String(row.last_error_message),
    lastErrorAt: row.last_error_at === null || row.last_error_at === undefined
      ? null
      : String(row.last_error_at),
    cleanupResult: row.cleanup_result === null || row.cleanup_result === undefined
      ? null
      : String(row.cleanup_result) as DurableExecutionCleanupResult,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at === null || row.completed_at === undefined
      ? null
      : String(row.completed_at),
  };
}

function circuitFromRow(row: Row): DurableProviderCircuitSnapshot {
  return {
    provider: String(row.provider),
    state: String(row.state) as DurableProviderCircuitSnapshot["state"],
    fencingToken: Number(row.fencing_token ?? 0),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    openUntil: optionalString(row.open_until) ?? null,
    halfOpenOwner: optionalString(row.half_open_owner) ?? null,
    halfOpenLeaseExpiresAt: optionalString(row.half_open_lease_expires_at) ?? null,
    updatedAt: String(row.updated_at),
  };
}

function assertCircuitTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be a valid timestamp.`);
}

function assertCircuitDuration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
}

export class SqliteDurableWorkerRepository implements
  DurableWorkerRepository,
  DurableExecutionCleanupRepository {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
    const columns = this.db.prepare("PRAGMA table_info(workbench_outbox)").all() as Row[];
    const circuitColumns = this.db.prepare("PRAGMA table_info(workbench_provider_circuits)").all() as Row[];
    const externalHighWaterTable = this.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'workbench_external_status_high_water'
    `).get() as Row;
    const cleanupIntentTable = this.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'workbench_execution_cleanup_intents'
    `).get() as Row;
    const launchAuthorizationTable = this.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'workbench_launch_authorizations'
    `).get() as Row;
    if (
      !columns.some((column) => column.name === "execution_id")
      || !columns.some((column) => column.name === "run_generation")
      || !columns.some((column) => column.name === "provider_attempt_count")
      || !circuitColumns.some((column) => column.name === "half_open_lease_expires_at")
      || !circuitColumns.some((column) => column.name === "fencing_token")
      || Number(externalHighWaterTable.count ?? 0) !== 1
      || Number(cleanupIntentTable.count ?? 0) !== 1
      || Number(launchAuthorizationTable.count ?? 0) !== 1
    ) {
      this.db.close();
      throw new Error("Workbench durable-worker migration is not installed.");
    }
    const quotaPolicy = this.db.prepare(`
      SELECT COUNT(*) AS count FROM workbench_event_quota_policy WHERE singleton = 1
    `).get() as Row;
    if (Number(quotaPolicy.count ?? 0) !== 1) {
      this.db.close();
      throw new Error("Workbench durable event quota policy is not initialized.");
    }
  }

  close(): void {
    this.db.close();
  }

  async claimNextExecutionCleanup(input: {
    workerId: string;
    now: string;
    leaseDurationMs: number;
  }): Promise<DurableExecutionCleanupIntent | null> {
    assertCircuitTimestamp(input.now, "cleanup.now");
    assertCircuitDuration(input.leaseDurationMs, "cleanup.leaseDurationMs");
    if (!input.workerId.trim()) throw new TypeError("cleanup.workerId must be non-empty.");
    const leaseExpiresAt = new Date(Date.parse(input.now) + input.leaseDurationMs).toISOString();
    return transaction(this.db, () => {
      const candidate = this.db.prepare(`
        SELECT execution_id FROM workbench_execution_cleanup_intents
        WHERE (state = 'pending' AND available_at <= ?)
          OR (state = 'claimed' AND lease_expires_at <= ?)
        ORDER BY available_at ASC, created_at ASC, execution_id ASC
        LIMIT 1
      `).get(input.now, input.now) as Row | undefined;
      if (!candidate) return null;
      const updated = this.db.prepare(`
        UPDATE workbench_execution_cleanup_intents SET
          state = 'claimed', claimed_at = ?, claimed_by = ?, lease_expires_at = ?,
          fencing_token = fencing_token + 1, attempt_count = attempt_count + 1,
          updated_at = ?
        WHERE execution_id = ? AND (
          (state = 'pending' AND available_at <= ?)
          OR (state = 'claimed' AND lease_expires_at <= ?)
        )
      `).run(
        input.now,
        input.workerId,
        leaseExpiresAt,
        input.now,
        String(candidate.execution_id),
        input.now,
        input.now,
      );
      if (Number(updated.changes) !== 1) return null;
      const row = this.db.prepare(`
        SELECT * FROM workbench_execution_cleanup_intents WHERE execution_id = ?
      `).get(String(candidate.execution_id)) as Row;
      return cleanupIntentFromRow(row);
    });
  }

  async heartbeatExecutionCleanup(input: {
    executionId: string;
    workerId: string;
    fencingToken: number;
    now: string;
    expiresAt: string;
  }): Promise<FencedMutationResult> {
    assertCircuitTimestamp(input.now, "cleanup.now");
    assertCircuitTimestamp(input.expiresAt, "cleanup.expiresAt");
    if (Date.parse(input.expiresAt) <= Date.parse(input.now)) {
      throw new TypeError("cleanup.expiresAt must be after cleanup.now.");
    }
    const result = this.db.prepare(`
      UPDATE workbench_execution_cleanup_intents SET lease_expires_at = ?, updated_at = ?
      WHERE execution_id = ? AND state = 'claimed' AND claimed_by = ?
        AND fencing_token = ? AND lease_expires_at > ?
    `).run(
      input.expiresAt,
      input.now,
      input.executionId,
      input.workerId,
      input.fencingToken,
      input.now,
    );
    return Number(result.changes) === 1 ? { status: "applied" } : { status: "stale_fence" };
  }

  async completeExecutionCleanup(input: {
    executionId: string;
    workerId: string;
    fencingToken: number;
    now: string;
    completedAt: string;
    result: DurableExecutionCleanupResult;
  }): Promise<FencedMutationResult> {
    assertCircuitTimestamp(input.now, "cleanup.now");
    assertCircuitTimestamp(input.completedAt, "cleanup.completedAt");
    if (Date.parse(input.completedAt) < Date.parse(input.now)) {
      throw new TypeError("cleanup.completedAt must not precede cleanup.now.");
    }
    if (input.result !== "removed" && input.result !== "already_absent") {
      throw new TypeError("cleanup.result is invalid.");
    }
    return transaction(this.db, () => {
      const existing = this.db.prepare(`
        SELECT state, cleanup_result FROM workbench_execution_cleanup_intents WHERE execution_id = ?
      `).get(input.executionId) as Row | undefined;
      if (existing?.state === "completed") {
        return String(existing.cleanup_result) === input.result
          ? { status: "already_applied" }
          : { status: "stale_fence" };
      }
      const result = this.db.prepare(`
        UPDATE workbench_execution_cleanup_intents SET
          state = 'completed', claimed_at = NULL, claimed_by = NULL,
          lease_expires_at = NULL, last_error_code = NULL, last_error_message = NULL,
          last_error_at = NULL, cleanup_result = ?, completed_at = ?, updated_at = ?
        WHERE execution_id = ? AND state = 'claimed' AND claimed_by = ?
          AND fencing_token = ? AND lease_expires_at > ?
      `).run(
        input.result,
        input.completedAt,
        input.completedAt,
        input.executionId,
        input.workerId,
        input.fencingToken,
        input.now,
      );
      return Number(result.changes) === 1 ? { status: "applied" } : { status: "stale_fence" };
    });
  }

  async retryExecutionCleanup(input: {
    executionId: string;
    workerId: string;
    fencingToken: number;
    now: string;
    availableAt: string;
    error: { code: string; message: string };
  }): Promise<FencedMutationResult> {
    assertCircuitTimestamp(input.now, "cleanup.now");
    assertCircuitTimestamp(input.availableAt, "cleanup.availableAt");
    if (Date.parse(input.availableAt) <= Date.parse(input.now)) {
      throw new TypeError("cleanup.availableAt must be after cleanup.now.");
    }
    const result = this.db.prepare(`
      UPDATE workbench_execution_cleanup_intents SET
        state = 'pending', available_at = ?, claimed_at = NULL, claimed_by = NULL,
        lease_expires_at = NULL, last_error_code = ?, last_error_message = ?,
        last_error_at = ?, updated_at = ?
      WHERE execution_id = ? AND state = 'claimed' AND claimed_by = ?
        AND fencing_token = ? AND lease_expires_at > ?
    `).run(
      input.availableAt,
      redactText(input.error.code, 200),
      redactText(input.error.message, 2_000),
      input.now,
      input.now,
      input.executionId,
      input.workerId,
      input.fencingToken,
      input.now,
    );
    return Number(result.changes) === 1 ? { status: "applied" } : { status: "stale_fence" };
  }

  async quarantineExecutionCleanup(input: {
    executionId: string;
    workerId: string;
    fencingToken: number;
    now: string;
    quarantinedAt: string;
    error: { code: string; message: string };
  }): Promise<FencedMutationResult> {
    assertCircuitTimestamp(input.now, "cleanup.now");
    assertCircuitTimestamp(input.quarantinedAt, "cleanup.quarantinedAt");
    if (Date.parse(input.quarantinedAt) < Date.parse(input.now)) {
      throw new TypeError("cleanup.quarantinedAt must not precede cleanup.now.");
    }
    const result = this.db.prepare(`
      UPDATE workbench_execution_cleanup_intents SET
        state = 'quarantined', claimed_at = NULL, claimed_by = NULL,
        lease_expires_at = NULL, last_error_code = ?, last_error_message = ?,
        last_error_at = ?, updated_at = ?
      WHERE execution_id = ? AND state = 'claimed' AND claimed_by = ?
        AND fencing_token = ? AND lease_expires_at > ?
    `).run(
      redactText(input.error.code, 200),
      redactText(input.error.message, 2_000),
      input.quarantinedAt,
      input.quarantinedAt,
      input.executionId,
      input.workerId,
      input.fencingToken,
      input.now,
    );
    return Number(result.changes) === 1 ? { status: "applied" } : { status: "stale_fence" };
  }

  async listExecutionCleanupIntents(limit = 100): Promise<DurableExecutionCleanupIntent[]> {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(1_000, limit)) : 100;
    const rows = this.db.prepare(`
      SELECT * FROM workbench_execution_cleanup_intents
      ORDER BY created_at ASC, execution_id ASC LIMIT ?
    `).all(boundedLimit) as Row[];
    return rows.map(cleanupIntentFromRow);
  }

  async findCompletedExecutionCleanupIntents(
    executionIds: readonly string[],
  ): Promise<DurableExecutionCleanupIntent[]> {
    const unique = [...new Set(executionIds.map((value) => value.trim()).filter(Boolean))];
    if (unique.length === 0) return [];
    if (unique.length > 100) throw new TypeError("cleanup observation is limited to 100 executions.");
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT * FROM workbench_execution_cleanup_intents
      WHERE state = 'completed' AND execution_id IN (${placeholders})
      ORDER BY completed_at ASC, execution_id ASC
    `).all(...unique) as Row[];
    return rows.map(cleanupIntentFromRow);
  }

  async loadProviderCircuit(provider: string): Promise<DurableProviderCircuitSnapshot> {
    const row = this.db.prepare(`
      SELECT * FROM workbench_provider_circuits WHERE provider = ?
    `).get(provider) as Row | undefined;
    if (row) return circuitFromRow(row);
    return {
      provider,
      state: "closed",
      fencingToken: 0,
      consecutiveFailures: 0,
      openUntil: null,
      halfOpenOwner: null,
      halfOpenLeaseExpiresAt: null,
      updatedAt: new Date(0).toISOString(),
    };
  }

  async acquireProviderCircuit(
    input: AcquireProviderCircuitInput,
  ): Promise<DurableProviderCircuitPermit> {
    assertCircuitTimestamp(input.now, "circuit.now");
    assertCircuitDuration(input.halfOpenLeaseDurationMs, "circuit.halfOpenLeaseDurationMs");
    const leaseExpiresAt = new Date(
      Date.parse(input.now) + input.halfOpenLeaseDurationMs,
    ).toISOString();
    return transaction(this.db, () => {
      if (!this.fencedRow(input) || this.commandProvider(input.commandId) !== input.provider) {
        return {
          allowed: false,
          reason: "stale_fence",
          snapshot: this.loadProviderCircuitSync(input.provider),
        };
      }
      const row = this.ensureProviderCircuit(input.provider, input.now);
      if (String(row.state) === "closed") {
        this.recordProviderAttempt(input.commandId, false);
        const snapshot = circuitFromRow(row);
        return {
          allowed: true,
          lease: this.circuitLease(snapshot, false),
          snapshot,
        };
      }
      if (String(row.state) === "open" && String(row.open_until) > input.now) {
        const snapshot = circuitFromRow(row);
        return { allowed: false, reason: "circuit_open", retryAt: snapshot.openUntil!, snapshot };
      }
      if (
        String(row.state) === "half_open"
        && row.half_open_owner !== null
        && row.half_open_owner !== undefined
        && String(row.half_open_lease_expires_at) > input.now
      ) {
        const snapshot = circuitFromRow(row);
        return {
          allowed: false,
          reason: "circuit_open",
          retryAt: snapshot.halfOpenLeaseExpiresAt!,
          snapshot,
        };
      }

      this.db.prepare(`
        UPDATE workbench_provider_circuits SET
          fencing_token = fencing_token + 1,
          state = 'half_open', open_until = NULL, half_open_owner = ?,
          half_open_lease_expires_at = ?, updated_at = ?
        WHERE provider = ?
      `).run(input.workerId, leaseExpiresAt, input.now, input.provider);
      this.recordProviderAttempt(input.commandId, false);
      const snapshot = circuitFromRow(this.providerCircuitRow(input.provider));
      return {
        allowed: true,
        lease: this.circuitLease(snapshot, true),
        snapshot,
      };
    });
  }

  async loadExecutionRecovery(executionId: string): Promise<DurableExecutionRecoveryRecord | null> {
    const row = this.db.prepare(`
      SELECT recovery.*,
        high_water.journal_generation AS external_journal_generation,
        high_water.status_sequence AS external_status_sequence,
        high_water.chain_version AS external_chain_version,
        high_water.previous_status_sequence AS external_previous_status_sequence,
        high_water.previous_snapshot_digest_sha256 AS external_previous_snapshot_digest_sha256,
        high_water.previous_journal_digest_sha256 AS external_previous_journal_digest_sha256,
        high_water.terminal AS external_status_terminal,
        high_water.snapshot_digest_sha256 AS external_snapshot_digest_sha256,
        high_water.journal_digest_sha256 AS external_journal_digest_sha256,
        high_water.authenticated_payload_digest_sha256 AS external_authenticated_payload_digest_sha256,
        high_water.native_terminal_digest_sha256 AS external_native_terminal_digest_sha256,
        high_water.native_terminal_status AS external_native_terminal_status,
        high_water.native_exit_code AS external_native_exit_code,
        high_water.termination_verified AS external_termination_verified,
        high_water.controller_outcome_digest_sha256 AS external_controller_outcome_digest_sha256,
        high_water.observed_at AS external_status_observed_at,
        high_water.updated_at AS external_status_updated_at,
        launch.authorization_id AS launch_authorization_id,
        launch.launch_generation AS launch_generation,
        launch.attempt AS launch_attempt,
        launch.journal_generation AS launch_journal_generation,
        launch.descriptor_hmac_sha256 AS launch_descriptor_hmac_sha256,
        launch.authorized_at AS launch_authorized_at
      FROM workbench_execution_recovery recovery
      LEFT JOIN workbench_external_status_high_water high_water
        ON high_water.execution_id = recovery.execution_id
      LEFT JOIN workbench_launch_authorizations launch
        ON launch.execution_id = recovery.execution_id
        AND launch.launch_generation = (
          SELECT MAX(candidate.launch_generation)
          FROM workbench_launch_authorizations candidate
          WHERE candidate.execution_id = recovery.execution_id
        )
      WHERE recovery.execution_id = ?
    `).get(executionId) as Row | undefined;
    return row ? recoveryFromRow(row) : null;
  }

  async loadExecutionCommand(executionId: string): Promise<DurableCommand | null> {
    const row = this.db.prepare(`
      SELECT o.*, r.provider, r.status AS run_status,
        r.state_version AS current_run_state_version,
        r.run_generation AS current_run_generation,
        recovery.terminal_status AS recovery_terminal_status,
        recovery.termination_verified AS recovery_termination_verified
      FROM workbench_outbox o
      JOIN workbench_runs r ON r.id = o.run_id
      LEFT JOIN workbench_execution_recovery recovery ON recovery.command_id = o.id
      WHERE o.execution_id = ?
    `).get(executionId) as Row | undefined;
    return row ? commandFromRow(row) : null;
  }

  async listExecutionRecovery(limit = 100): Promise<DurableExecutionRecoveryRecord[]> {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(1_000, limit)) : 100;
    const rows = this.db.prepare(`
      SELECT recovery.*,
        high_water.journal_generation AS external_journal_generation,
        high_water.status_sequence AS external_status_sequence,
        high_water.chain_version AS external_chain_version,
        high_water.previous_status_sequence AS external_previous_status_sequence,
        high_water.previous_snapshot_digest_sha256 AS external_previous_snapshot_digest_sha256,
        high_water.previous_journal_digest_sha256 AS external_previous_journal_digest_sha256,
        high_water.terminal AS external_status_terminal,
        high_water.snapshot_digest_sha256 AS external_snapshot_digest_sha256,
        high_water.journal_digest_sha256 AS external_journal_digest_sha256,
        high_water.authenticated_payload_digest_sha256 AS external_authenticated_payload_digest_sha256,
        high_water.native_terminal_digest_sha256 AS external_native_terminal_digest_sha256,
        high_water.native_terminal_status AS external_native_terminal_status,
        high_water.native_exit_code AS external_native_exit_code,
        high_water.termination_verified AS external_termination_verified,
        high_water.controller_outcome_digest_sha256 AS external_controller_outcome_digest_sha256,
        high_water.observed_at AS external_status_observed_at,
        high_water.updated_at AS external_status_updated_at,
        launch.authorization_id AS launch_authorization_id,
        launch.launch_generation AS launch_generation,
        launch.attempt AS launch_attempt,
        launch.journal_generation AS launch_journal_generation,
        launch.descriptor_hmac_sha256 AS launch_descriptor_hmac_sha256,
        launch.authorized_at AS launch_authorized_at
      FROM workbench_execution_recovery recovery
      LEFT JOIN workbench_external_status_high_water high_water
        ON high_water.execution_id = recovery.execution_id
      LEFT JOIN workbench_launch_authorizations launch
        ON launch.execution_id = recovery.execution_id
        AND launch.launch_generation = (
          SELECT MAX(candidate.launch_generation)
          FROM workbench_launch_authorizations candidate
          WHERE candidate.execution_id = recovery.execution_id
        )
      WHERE recovery.checkpoint <> 'completed'
      ORDER BY recovery.updated_at ASC, recovery.execution_id ASC LIMIT ?
    `).all(boundedLimit) as Row[];
    return rows.map(recoveryFromRow);
  }

  async acceptExternalStatusHighWater(
    input: DurableExternalStatusHighWaterInput,
  ): Promise<DurableRecoveryMutationResult> {
    this.assertExternalStatusEvidence(input);
    if (input.terminal) {
      throw new TypeError(
        "Terminal external status must be committed atomically with its controller outcome.",
      );
    }
    return transaction(this.db, () => this.acceptExternalStatusHighWaterInTransaction(input, null));
  }

  async recordVerifiedTerminalCheckpoint(
    input: VerifiedDurableTerminalCheckpointInput,
  ): Promise<DurableRecoveryMutationResult> {
    if (
      input.terminationVerified !== true
      || input.statusEvidence.terminationVerified !== true
      || !input.statusEvidence.terminal
    ) {
      throw new Error("Durable terminal checkpoint requires verified native termination evidence.");
    }
    this.assertExternalStatusEvidence(input.statusEvidence);
    if (
      input.executionId !== input.statusEvidence.executionId
      || input.commandId !== input.statusEvidence.commandId
      || input.runId !== input.statusEvidence.runId
      || input.jobObjectId !== input.statusEvidence.jobObjectId
      || input.observedAt !== input.statusEvidence.observedAt
      || !["windows_job_helper", "windows_job_controller"].includes(input.source)
    ) {
      return { status: "conflict" };
    }
    const outcome = redactRecord(input.outcome) as unknown as DurableExecutionOutcome;
    const computedControllerDigest = durableOutcomeDigestSha256(outcome);
    if (
      !SHA256_PATTERN.test(input.controllerOutcomeDigestSha256)
      || input.controllerOutcomeDigestSha256 !== computedControllerDigest
      || input.statusEvidence.nativeTerminalStatus !== outcome.status
      || input.statusEvidence.nativeExitCode !== outcome.exitCode
    ) {
      return { status: "conflict" };
    }
    if (!Number.isFinite(Date.parse(input.observedAt))) {
      throw new TypeError("Durable terminal checkpoint observedAt is invalid.");
    }

    return transaction(this.db, () => {
      const row = this.db.prepare(`
        SELECT * FROM workbench_execution_recovery WHERE execution_id = ?
      `).get(input.executionId) as Row | undefined;
      if (!row) return { status: "missing" };
      if (
        String(row.command_id) !== input.commandId
        || String(row.run_id) !== input.runId
        || String(row.job_object_id) !== input.jobObjectId
      ) {
        return { status: "conflict" };
      }
      const existing = outcomeFromRecoveryRow(row);
      if (existing) {
        const highWater = this.db.prepare(`
          SELECT * FROM workbench_external_status_high_water WHERE execution_id = ?
        `).get(input.executionId) as Row | undefined;
        return highWater
          && this.externalStatusExact(
            highWater,
            input.statusEvidence,
            input.controllerOutcomeDigestSha256,
          )
          && durableOutcomeDigestSha256(existing) === input.controllerOutcomeDigestSha256
          && (optionalString(row.terminal_native_digest_sha256) ?? null)
            === input.statusEvidence.nativeTerminalDigestSha256
          && (optionalString(row.terminal_controller_outcome_digest_sha256) ?? null)
            === input.controllerOutcomeDigestSha256
          ? { status: "already_applied" }
          : { status: "conflict" };
      }
      const highWaterResult = this.acceptExternalStatusHighWaterInTransaction(
        input.statusEvidence,
        input.controllerOutcomeDigestSha256,
      );
      if (highWaterResult.status === "missing" || highWaterResult.status === "conflict") {
        return highWaterResult;
      }
      const result = this.db.prepare(`
        UPDATE workbench_execution_recovery SET
          terminal_status = ?, terminal_exit_code = ?, terminal_error_code = ?,
          terminal_error_message = ?, terminal_metadata_json = ?, terminal_observed_at = ?,
          termination_verified = 1, terminal_source = ?,
          terminal_native_digest_sha256 = ?,
          terminal_controller_outcome_digest_sha256 = ?, updated_at = ?
        WHERE execution_id = ? AND terminal_status IS NULL
      `).run(
        outcome.status,
        outcome.exitCode,
        outcome.errorCode ?? null,
        outcome.errorMessage ? redactText(outcome.errorMessage, 2_000) : null,
        JSON.stringify(redactRecord(outcome.metadata ?? {})),
        input.observedAt,
        input.source,
        input.statusEvidence.nativeTerminalDigestSha256,
        input.controllerOutcomeDigestSha256,
        input.observedAt,
        input.executionId,
      );
      if (!Number(result.changes)) {
        throw new Error("Terminal HWM was accepted but its durable checkpoint CAS failed.");
      }
      return { status: "applied" };
    });
  }

  private assertExternalStatusEvidence(input: DurableExternalStatusHighWaterInput): void {
    if (
      !input.executionId
      || !input.commandId
      || !input.runId
      || !input.jobObjectId
      || !JOURNAL_GENERATION_PATTERN.test(input.journalGeneration)
    ) {
      throw new TypeError("External status high-water identity is invalid.");
    }
    if (
      !Number.isSafeInteger(input.sequence)
      || input.sequence < 1
      || !Number.isSafeInteger(input.previousSequence)
      || input.previousSequence < 0
    ) {
      throw new TypeError("External status high-water sequence tuple is invalid.");
    }
    for (const digest of [
      input.previousSnapshotDigestSha256,
      input.previousJournalDigestSha256,
      input.snapshotDigestSha256,
      input.journalDigestSha256,
      input.authenticatedPayloadDigestSha256,
    ]) {
      if (!SHA256_PATTERN.test(digest)) {
        throw new TypeError("External status high-water digests must be lowercase SHA-256 values.");
      }
    }
    if (!Number.isFinite(Date.parse(input.observedAt))) {
      throw new TypeError("External status high-water observedAt is invalid.");
    }
    if (input.terminal) {
      if (
        !input.nativeTerminalDigestSha256
        || !SHA256_PATTERN.test(input.nativeTerminalDigestSha256)
        || !input.nativeTerminalStatus
        || !TERMINAL_RUN_STATUSES.has(input.nativeTerminalStatus as RunStatus)
        || input.nativeExitCode !== null && !Number.isSafeInteger(input.nativeExitCode)
        || input.terminationVerified !== true
      ) {
        throw new TypeError("Terminal external status native evidence is invalid.");
      }
    } else if (
      input.nativeTerminalDigestSha256 !== null
      || input.nativeTerminalStatus !== null
      || input.nativeExitCode !== null
      || input.terminationVerified
    ) {
      throw new TypeError("Non-terminal external status cannot contain terminal evidence.");
    }
  }

  private externalStatusExact(
    row: Row,
    input: DurableExternalStatusHighWaterInput,
    controllerOutcomeDigestSha256: string | null,
  ): boolean {
    return Number(row.chain_version) === 2
      && String(row.command_id) === input.commandId
      && String(row.run_id) === input.runId
      && String(row.job_object_id) === input.jobObjectId
      && String(row.journal_generation) === input.journalGeneration
      && Number(row.status_sequence) === input.sequence
      && Number(row.previous_status_sequence) === input.previousSequence
      && String(row.previous_snapshot_digest_sha256) === input.previousSnapshotDigestSha256
      && String(row.previous_journal_digest_sha256) === input.previousJournalDigestSha256
      && (Number(row.terminal) === 1) === input.terminal
      && String(row.snapshot_digest_sha256) === input.snapshotDigestSha256
      && String(row.journal_digest_sha256) === input.journalDigestSha256
      && String(row.authenticated_payload_digest_sha256) === input.authenticatedPayloadDigestSha256
      && (optionalString(row.native_terminal_digest_sha256) ?? null) === input.nativeTerminalDigestSha256
      && (optionalString(row.native_terminal_status) ?? null) === input.nativeTerminalStatus
      && (row.native_exit_code === null || row.native_exit_code === undefined
        ? null
        : Number(row.native_exit_code)) === input.nativeExitCode
      && (Number(row.termination_verified) === 1) === input.terminationVerified
      && (optionalString(row.controller_outcome_digest_sha256) ?? null) === controllerOutcomeDigestSha256
      && String(row.observed_at) === input.observedAt;
  }

  private acceptExternalStatusHighWaterInTransaction(
    input: DurableExternalStatusHighWaterInput,
    controllerOutcomeDigestSha256: string | null,
  ): DurableRecoveryMutationResult {
    const recovery = this.db.prepare(`
      SELECT command_id, run_id, job_object_id
      FROM workbench_execution_recovery WHERE execution_id = ?
    `).get(input.executionId) as Row | undefined;
    if (!recovery) return { status: "missing" };
    if (
      String(recovery.command_id) !== input.commandId
      || String(recovery.run_id) !== input.runId
      || String(recovery.job_object_id) !== input.jobObjectId
    ) {
      return { status: "conflict" };
    }

    const existing = this.db.prepare(`
      SELECT * FROM workbench_external_status_high_water WHERE execution_id = ?
    `).get(input.executionId) as Row | undefined;
    if (!existing) {
      if (
        input.sequence !== 1
        || input.previousSequence !== 0
        || input.previousSnapshotDigestSha256 !== "0".repeat(64)
        || input.previousJournalDigestSha256 !== "0".repeat(64)
      ) {
        return { status: "conflict" };
      }
      this.db.prepare(`
        INSERT INTO workbench_external_status_high_water (
          execution_id, command_id, run_id, job_object_id, journal_generation,
          status_sequence, terminal, snapshot_digest_sha256, journal_digest_sha256,
          observed_at, updated_at, chain_version, previous_status_sequence,
          previous_snapshot_digest_sha256, previous_journal_digest_sha256,
          authenticated_payload_digest_sha256, native_terminal_digest_sha256,
          native_terminal_status, native_exit_code, termination_verified,
          controller_outcome_digest_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.executionId, input.commandId, input.runId, input.jobObjectId,
        input.journalGeneration, input.sequence, input.terminal ? 1 : 0,
        input.snapshotDigestSha256, input.journalDigestSha256,
        input.observedAt, input.observedAt, input.previousSequence,
        input.previousSnapshotDigestSha256, input.previousJournalDigestSha256,
        input.authenticatedPayloadDigestSha256, input.nativeTerminalDigestSha256,
        input.nativeTerminalStatus, input.nativeExitCode,
        input.terminationVerified ? 1 : 0, controllerOutcomeDigestSha256,
      );
      return { status: "applied" };
    }
    if (Number(existing.chain_version) !== 2) return { status: "conflict" };
    if (input.sequence === Number(existing.status_sequence)) {
      return this.externalStatusExact(existing, input, controllerOutcomeDigestSha256)
        ? { status: "already_applied" }
        : { status: "conflict" };
    }
    if (
      String(existing.command_id) !== input.commandId
      || String(existing.run_id) !== input.runId
      || String(existing.job_object_id) !== input.jobObjectId
      || String(existing.journal_generation) !== input.journalGeneration
      || Number(existing.terminal) === 1
      || input.sequence !== Number(existing.status_sequence) + 1
      || input.previousSequence !== Number(existing.status_sequence)
      || input.previousSnapshotDigestSha256 !== String(existing.snapshot_digest_sha256)
      || input.previousJournalDigestSha256 !== String(existing.journal_digest_sha256)
    ) {
      return { status: "conflict" };
    }
    const result = this.db.prepare(`
      UPDATE workbench_external_status_high_water SET
        status_sequence = ?, previous_status_sequence = ?,
        previous_snapshot_digest_sha256 = ?, previous_journal_digest_sha256 = ?,
        terminal = ?, snapshot_digest_sha256 = ?, journal_digest_sha256 = ?,
        authenticated_payload_digest_sha256 = ?, native_terminal_digest_sha256 = ?,
        native_terminal_status = ?, native_exit_code = ?, termination_verified = ?,
        controller_outcome_digest_sha256 = ?, observed_at = ?, updated_at = ?
      WHERE execution_id = ? AND chain_version = 2 AND journal_generation = ?
        AND status_sequence = ? AND terminal = 0
    `).run(
      input.sequence, input.previousSequence, input.previousSnapshotDigestSha256,
      input.previousJournalDigestSha256, input.terminal ? 1 : 0,
      input.snapshotDigestSha256, input.journalDigestSha256,
      input.authenticatedPayloadDigestSha256, input.nativeTerminalDigestSha256,
      input.nativeTerminalStatus, input.nativeExitCode,
      input.terminationVerified ? 1 : 0, controllerOutcomeDigestSha256,
      input.observedAt, input.observedAt, input.executionId,
      input.journalGeneration, Number(existing.status_sequence),
    );
    return Number(result.changes) === 1 ? { status: "applied" } : { status: "conflict" };
  }

  async claimNext(input: ClaimNextCommandInput): Promise<ClaimedCommand | null> {
    return transaction(this.db, () => {
      const pageSize = 200;
      const excludedProviders = [...new Set(input.excludedProviders)];
      const excludedSql = excludedProviders.length
        ? `AND (o.operation = 'cancel' OR r.provider NOT IN (${excludedProviders.map(() => "?").join(", ")}))`
        : "";
      const laneSql = input.lane === "control"
        ? "AND o.operation = 'cancel'"
        : input.lane === "provider"
          ? "AND o.operation <> 'cancel'"
          : "";
      let cursor: { availableAt: string; createdAt: string; id: string } | null = null;

      // Each page is bounded and keyset-paginated. A legacy queue with more
      // than 200 inadmissible rows can no longer hide later eligible work,
      // and no full-queue materialization is required.
      while (true) {
        const cursorSql = cursor
          ? `AND (
              o.available_at > ?
              OR (o.available_at = ? AND o.created_at > ?)
              OR (o.available_at = ? AND o.created_at = ? AND o.id > ?)
            )`
          : "";
        const values: SQLInputValue[] = [
          input.now,
          input.now,
          input.now,
          input.now,
          ...excludedProviders,
        ];
        if (cursor) {
          values.push(
            cursor.availableAt,
            cursor.availableAt,
            cursor.createdAt,
            cursor.availableAt,
            cursor.createdAt,
            cursor.id,
          );
        }
        values.push(pageSize);
        const candidates = this.db.prepare(`
          SELECT o.*, r.provider, r.status AS run_status,
            r.state_version AS current_run_state_version,
            r.run_generation AS current_run_generation,
            recovery.terminal_status AS recovery_terminal_status,
            recovery.termination_verified AS recovery_termination_verified,
            semantics.semantics AS command_semantics
          FROM workbench_outbox o JOIN workbench_runs r ON r.id = o.run_id
          LEFT JOIN workbench_execution_recovery recovery ON recovery.command_id = o.id
          LEFT JOIN workbench_command_semantics semantics ON semantics.command_id = o.id
          WHERE ((o.state = 'pending' AND o.available_at <= ?)
            OR (o.state = 'claimed' AND o.lease_expires_at IS NOT NULL AND o.lease_expires_at <= ?))
            AND r.status NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')
            AND o.run_generation = r.run_generation
            AND (o.operation = 'cancel' OR semantics.semantics = 'orphan_reconciliation' OR NOT EXISTS (
              SELECT 1 FROM workbench_provider_circuits circuit
              WHERE circuit.provider = r.provider AND (
                (circuit.state = 'open' AND circuit.open_until > ?)
                OR (circuit.state = 'half_open'
                  AND circuit.half_open_owner IS NOT NULL
                  AND circuit.half_open_lease_expires_at > ?)
              )
            ))
            ${laneSql}
            ${excludedSql}
            ${cursorSql}
          ORDER BY o.available_at ASC, o.created_at ASC, o.id ASC LIMIT ?
        `).all(...values) as Row[];
        if (!candidates.length) return null;

        for (const candidate of candidates) {
          const durableOperation = operation(candidate);
          if (durableOperation === "reconcile_orphan") {
            this.db.prepare(`
              UPDATE workbench_outbox SET
                state = 'completed', checkpoint = 'completed', completed_at = ?,
                reservation_active = 0, claimed_at = NULL, claimed_by = NULL,
                lease_expires_at = NULL, last_error = NULL
              WHERE id = ? AND run_generation = ?
                AND state IN ('pending', 'claimed')
            `).run(
              input.now,
              String(candidate.id),
              Number(candidate.current_run_generation ?? 0),
            );
            continue;
          }
          if (!durableOperation) {
            this.db.prepare(`
              UPDATE workbench_outbox SET state = 'dead', completed_at = ?, reservation_active = 0,
                claimed_at = NULL, claimed_by = NULL, lease_expires_at = NULL,
                last_error = 'unknown_operation'
              WHERE id = ? AND run_generation = ? AND state IN ('pending', 'claimed')
            `).run(input.now, String(candidate.id), Number(candidate.current_run_generation ?? 0));
            this.transitionRun(String(candidate.run_id), "failed", input.now, {
              code: "unknown_operation",
              message: "The durable command operation is unknown and was not executed.",
            });
            continue;
          }

          const payload = object(candidate.payload_json);
          const localControl = durableOperation === "cancel";
          const resourceBudget = localControl ? zeroBudget() : resources(payload.resources);
          const maxAttempts = positiveInteger(payload.maxAttempts, Number(candidate.max_attempts ?? 3), 20);
          const providerAttempts = Number(candidate.provider_attempt_count ?? 0);
          const hasVerifiedTerminalRecovery = candidate.recovery_terminal_status !== null
            && candidate.recovery_terminal_status !== undefined
            && Number(candidate.recovery_termination_verified ?? 0) === 1;
          if (
            providerAttempts >= maxAttempts
            && !hasVerifiedTerminalRecovery
            && durableOperation !== "start"
            && durableOperation !== "resume"
          ) {
            this.db.prepare(`
              UPDATE workbench_outbox SET state = 'dead', completed_at = ?, reservation_active = 0,
                claimed_at = NULL, claimed_by = NULL, lease_expires_at = NULL,
                last_error = 'attempt_cap_exhausted'
              WHERE id = ? AND run_generation = ? AND state IN ('pending', 'claimed')
            `).run(input.now, String(candidate.id), Number(candidate.current_run_generation ?? 0));
            this.transitionRun(String(candidate.run_id), "failed", input.now, {
              code: "attempt_cap_exhausted",
              message: "The durable command exhausted its provider attempt cap.",
            });
            continue;
          }

          if (!localControl) {
            const snapshot = this.admissionSnapshot();
            const decision = evaluateClaimAdmission(snapshot, resourceBudget, input.admissionPolicy);
            if (!decision.accepted) continue;
          }
          const leaseExpiresAt = new Date(Date.parse(input.now) + input.leaseDurationMs).toISOString();
          const executionId = String(candidate.execution_id ?? candidate.idempotency_key);
          const result = this.db.prepare(`
            UPDATE workbench_outbox SET state = 'claimed', claimed_at = ?, claimed_by = ?,
              lease_expires_at = ?, fencing_token = fencing_token + 1,
              attempt_count = attempt_count + 1,
              delivery_attempt_count = delivery_attempt_count + 1,
              execution_id = ?,
              checkpoint = CASE WHEN checkpoint = 'pending' THEN 'dequeued' ELSE checkpoint END,
              max_attempts = ?, resources_json = ?, reservation_active = ?
            WHERE id = ? AND run_generation = ? AND ((state = 'pending' AND available_at <= ?)
              OR (state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
              AND EXISTS (
                SELECT 1 FROM workbench_runs r
                WHERE r.id = workbench_outbox.run_id
                  AND r.run_generation = workbench_outbox.run_generation
                  AND r.status NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')
              )
          `).run(
            input.now,
            input.workerId,
            leaseExpiresAt,
            executionId,
            maxAttempts,
            JSON.stringify(resourceBudget),
            localControl ? 0 : 1,
            String(candidate.id),
            Number(candidate.current_run_generation ?? 0),
            input.now,
            input.now,
          );
          if (!Number(result.changes)) continue;
          const row = this.commandRow(String(candidate.id));
          this.ensureDequeuedRecovery(row, durableOperation, input.now);
          const runStatus = String(candidate.run_status) as RunStatus;
          if (runStatus === "queued") this.transitionRun(String(candidate.run_id), "claimed", input.now);
          return {
            command: commandFromRow(this.commandRow(String(candidate.id))),
            lease: {
              workerId: input.workerId,
              fencingToken: Number(row.fencing_token),
              expiresAt: String(row.lease_expires_at),
            },
          };
        }
        const last = candidates[candidates.length - 1];
        cursor = {
          availableAt: String(last.available_at),
          createdAt: String(last.created_at),
          id: String(last.id),
        };
        if (candidates.length < pageSize) return null;
      }
    });
  }

  async heartbeatLease(input: LeaseGuard & { expiresAt: string }): Promise<FencedMutationResult> {
    const result = this.db.prepare(`
      UPDATE workbench_outbox SET lease_expires_at = ?
      WHERE id = ? AND state = 'claimed' AND claimed_by = ? AND fencing_token = ?
        AND lease_expires_at > ?
        AND run_generation = (SELECT run_generation FROM workbench_runs WHERE id = run_id)
        AND EXISTS (
          SELECT 1 FROM workbench_runs r
          WHERE r.id = workbench_outbox.run_id
            AND r.status NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')
        )
    `).run(input.expiresAt, input.commandId, input.workerId, input.fencingToken, input.now);
    return this.fenceResult(input, Number(result.changes));
  }

  async recordSpawnIntent(input: SpawnIntentInput): Promise<FencedMutationResult> {
    return this.advanceCheckpoint(input, "spawn_intent", {
      execution_identity_json: JSON.stringify(redactRecord(input.identity)),
    }, "starting", undefined, input.identity);
  }

  async authorizeProviderAttempt(
    input: ProviderLaunchAuthorizationInput,
  ): Promise<ProviderAttemptAuthorizationResult> {
    assertProviderLaunchAuthorizationInput(input);
    return transaction(this.db, () => {
      const row = this.fencedRow(input);
      if (!row) {
        const fenced = this.fenceResult(input, 0);
        return { status: fenced.status, attempt: null, authorization: null };
      }
      assertExecutionAssociation(row, input.identity);
      const durableOperation = operation(row);
      if (durableOperation !== "start" && durableOperation !== "resume") {
        return { status: "missing", attempt: null, authorization: null };
      }
      const providerAttempts = Number(row.provider_attempt_count ?? 0);
      const existing = this.db.prepare(`
        SELECT * FROM workbench_launch_authorizations
        WHERE execution_id = ? AND launch_generation = ?
      `).get(input.identity.executionId, input.launchGeneration) as Row | undefined;
      if (existing) {
        const authorization = launchAuthorizationFromReceiptRow(existing);
        const exact = authorization.commandId === input.identity.commandId
          && authorization.runId === input.identity.runId
          && authorization.jobObjectId === input.identity.jobObjectId
          && authorization.authorizationId === input.authorizationId
          && authorization.attempt === input.expectedAttempt
          && authorization.journalGeneration === input.journalGeneration
          && authorization.descriptorHmacSha256 === input.descriptorHmacSha256;
        if (!exact || providerAttempts !== authorization.attempt) {
          return { status: "conflict", attempt: null, authorization: null };
        }
        return { status: "already_applied", attempt: authorization.attempt, authorization };
      }
      const maxAttempts = Number(row.max_attempts ?? 3);
      if (providerAttempts >= maxAttempts) {
        return { status: "attempt_cap_exhausted", attempt: null, authorization: null };
      }
      const latest = this.db.prepare(`
        SELECT launch_generation, attempt FROM workbench_launch_authorizations
        WHERE execution_id = ?
        ORDER BY launch_generation DESC LIMIT 1
      `).get(input.identity.executionId) as Row | undefined;
      const expectedGeneration = latest ? Number(latest.launch_generation) + 1 : 1;
      const expectedAttempt = providerAttempts + 1;
      if (
        input.launchGeneration !== expectedGeneration
        || input.expectedAttempt !== expectedAttempt
      ) {
        return { status: "conflict", attempt: null, authorization: null };
      }
      const result = this.db.prepare(`
        UPDATE workbench_outbox SET
          provider_attempt_count = provider_attempt_count + 1,
          provider_attempt_fencing_token = fencing_token
        WHERE id = ? AND state = 'claimed'
          AND claimed_by = ? AND fencing_token = ? AND lease_expires_at > ?
          AND run_generation = (
            SELECT run_generation FROM workbench_runs WHERE id = workbench_outbox.run_id
          )
          AND provider_attempt_count < max_attempts
          AND (provider_attempt_fencing_token IS NULL OR provider_attempt_fencing_token <> fencing_token)
      `).run(input.commandId, input.workerId, input.fencingToken, input.now);
      if (!Number(result.changes)) {
        const current = this.fencedRow(input);
        if (!current) {
          const fenced = this.fenceResult(input, 0);
          return { status: fenced.status, attempt: null, authorization: null };
        }
        if (Number(current.provider_attempt_count ?? 0) >= Number(current.max_attempts ?? 3)) {
          return { status: "attempt_cap_exhausted", attempt: null, authorization: null };
        }
        return { status: "stale_fence", attempt: null, authorization: null };
      }
      this.db.prepare(`
        INSERT INTO workbench_launch_authorizations (
          execution_id, launch_generation, authorization_id,
          command_id, run_id, job_object_id, attempt,
          journal_generation, descriptor_hmac_sha256, authorized_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.identity.executionId,
        input.launchGeneration,
        input.authorizationId,
        input.identity.commandId,
        input.identity.runId,
        input.identity.jobObjectId,
        expectedAttempt,
        input.journalGeneration,
        input.descriptorHmacSha256,
        input.now,
      );
      const authorization: DurableLaunchAuthorization = {
        ...input.identity,
        authorizationId: input.authorizationId,
        launchGeneration: input.launchGeneration,
        attempt: expectedAttempt,
        journalGeneration: input.journalGeneration,
        descriptorHmacSha256: input.descriptorHmacSha256,
        authorizedAt: input.now,
      };
      return { status: "applied", attempt: expectedAttempt, authorization };
    });
  }

  async recordSpawnObservation(input: SpawnObservationInput): Promise<FencedMutationResult> {
    return this.advanceCheckpoint(input, "spawned", {
      process_identity_json: JSON.stringify(redactRecord(input.process)),
    }, undefined, undefined, input.identity, input.process);
  }

  async registerProcess(input: SpawnObservationInput): Promise<FencedMutationResult> {
    return this.advanceCheckpoint(input, "registered", {
      process_identity_json: JSON.stringify(redactRecord(input.process)),
    }, "running", input.process.pid, input.identity, input.process);
  }

  async completeCommand(input: CompletionInput): Promise<FencedMutationResult> {
    return transaction(this.db, () => {
      const row = this.fencedRow(input);
      if (!row) return this.fenceResult(input, 0);
      if (row.state === "completed" || row.checkpoint === "completed") return { status: "already_applied" };
      const currentOperation = operation(row);
      const cancellationPair = this.resolveVerifiedCancellationPair(row, input);
      if (currentOperation === "cancel" && !cancellationPair) {
        throw new Error("Cancel command cannot complete without authenticated target-terminal proof.");
      }
      if (cancellationPair) {
        this.completeVerifiedCancellationPair(cancellationPair, input);
      } else {
        const result = this.db.prepare(`
          UPDATE workbench_outbox SET state = 'completed', checkpoint = 'completed', completed_at = ?,
            claimed_at = NULL, claimed_by = NULL, lease_expires_at = NULL,
            reservation_active = 0, outcome_json = ?, last_error = NULL
          WHERE id = ? AND state = 'claimed' AND claimed_by = ? AND fencing_token = ?
            AND lease_expires_at > ?
        `).run(
          input.completedAt,
          JSON.stringify(redactRecord(input.outcome)),
          input.commandId,
          input.workerId,
          input.fencingToken,
          input.now,
        );
        if (!Number(result.changes)) return this.fenceResult(input, 0);
        this.persistCompletedRecovery(
          String(row.execution_id),
          input.identity,
          input.outcome,
          input.completedAt,
        );
        this.persistVerifiedCleanupIntent(String(row.execution_id), input.completedAt);
      }
      const runOutcome = cancellationPair?.providerOutcome ?? input.outcome;
      const terminal = runOutcome.status as RunStatus;
      const verifiedNativeTerminal = this.db.prepare(`
        SELECT terminal_status, termination_verified, terminal_source
        FROM workbench_execution_recovery WHERE execution_id = ?
      `).get(input.identity.executionId) as Row | undefined;
      if (
        currentOperation !== "cancel"
        && String(row.run_status) === "starting"
        && terminal === "succeeded"
        && String(verifiedNativeTerminal?.terminal_status ?? "") === terminal
        && Number(verifiedNativeTerminal?.termination_verified ?? 0) === 1
        && ["windows_job_helper", "windows_job_controller"].includes(
          String(verifiedNativeTerminal?.terminal_source ?? ""),
        )
      ) {
        this.transitionRun(String(row.run_id), "running", input.completedAt);
      }
      this.transitionRun(String(row.run_id), terminal, input.completedAt, runOutcome.errorCode
        ? { code: runOutcome.errorCode, message: runOutcome.errorMessage ?? runOutcome.errorCode }
        : null);
      // Command completion is authoritative. A newer circuit generation may
      // reject this optional health update, but cannot erase a valid outcome.
      if (currentOperation !== "cancel") {
        this.recordCircuitSuccess(input.circuit, input.workerId, input.completedAt);
      }
      return { status: "applied" };
    });
  }

  async rescheduleCommand(input: FailureDispositionInput & { availableAt: string }): Promise<FencedMutationResult> {
    return transaction(this.db, () => {
      const row = this.fencedRow(input);
      if (!row) return this.fenceResult(input, 0);
      if (!this.circuitLeaseIsCurrentForCommand(
        input.commandId,
        input.circuit,
        input.workerId,
        input.now,
      )) {
        return { status: "stale_fence" };
      }
      const result = this.db.prepare(`
        UPDATE workbench_outbox SET state = 'pending', available_at = ?, claimed_at = NULL,
          claimed_by = NULL, lease_expires_at = NULL, reservation_active = 0, last_error = ?
        WHERE id = ? AND state = 'claimed' AND claimed_by = ? AND fencing_token = ?
          AND lease_expires_at > ?
      `).run(input.availableAt, failureText(input), input.commandId, input.workerId, input.fencingToken, input.now);
      if (!Number(result.changes)) return this.fenceResult(input, 0);
      this.returnRunToQueue(String(row.run_id), input.now);
      this.recordCircuitFailure(input, input.now);
      return { status: "applied" };
    });
  }

  async rescheduleControlCommand(
    input: LeaseGuard & { availableAt: string; failure: FailureDispositionInput["failure"] },
  ): Promise<FencedMutationResult> {
    return transaction(this.db, () => {
      const row = this.fencedRow(input);
      if (!row) return this.fenceResult(input, 0);
      if (operation(row) !== "cancel") {
        throw new Error("Only cancel commands may use the local-control retry lane.");
      }
      const result = this.db.prepare(`
        UPDATE workbench_outbox SET state = 'pending', available_at = ?,
          claimed_at = NULL, claimed_by = NULL, lease_expires_at = NULL,
          reservation_active = 0, last_error = ?
        WHERE id = ? AND state = 'claimed' AND claimed_by = ? AND fencing_token = ?
          AND lease_expires_at > ?
      `).run(
        input.availableAt,
        redactText(`${input.failure.failureClass}: ${input.failure.message}`, 2_000),
        input.commandId,
        input.workerId,
        input.fencingToken,
        input.now,
      );
      return Number(result.changes) === 1 ? { status: "applied" } : this.fenceResult(input, 0);
    });
  }

  async deadLetterCommand(
    input: FailureDispositionInput & { completedAt: string },
  ): Promise<FencedMutationResult> {
    return transaction(this.db, () => {
      const row = this.fencedRow(input);
      if (!row) return this.fenceResult(input, 0);
      if (!this.circuitLeaseIsCurrentForCommand(
        input.commandId,
        input.circuit,
        input.workerId,
        input.now,
      )) {
        return { status: "stale_fence" };
      }
      const result = this.db.prepare(`
        UPDATE workbench_outbox SET state = 'dead', completed_at = ?, claimed_at = NULL,
          claimed_by = NULL, lease_expires_at = NULL, reservation_active = 0, last_error = ?
        WHERE id = ? AND state = 'claimed' AND claimed_by = ? AND fencing_token = ?
          AND lease_expires_at > ?
      `).run(input.completedAt, failureText(input), input.commandId, input.workerId, input.fencingToken, input.now);
      if (!Number(result.changes)) return this.fenceResult(input, 0);
      const terminalStatus = BLOCKED_FAILURE_CLASSES.has(input.failure.failureClass) ? "blocked" : "failed";
      this.transitionRun(String(row.run_id), terminalStatus, input.completedAt, {
        code: input.failure.failureClass,
        message: input.failure.message,
      });
      this.recordCircuitFailure(input, input.completedAt);
      return { status: "applied" };
    });
  }

  async deferCommand(
    input: LeaseGuard & { availableAt: string; reason: "circuit_open" },
  ): Promise<FencedMutationResult> {
    return transaction(this.db, () => {
      const row = this.fencedRow(input);
      if (!row) return this.fenceResult(input, 0);
      const result = this.db.prepare(`
        UPDATE workbench_outbox SET state = 'pending', available_at = ?, claimed_at = NULL,
          claimed_by = NULL, lease_expires_at = NULL, reservation_active = 0,
          last_error = ?
        WHERE id = ? AND state = 'claimed' AND claimed_by = ? AND fencing_token = ?
          AND lease_expires_at > ?
      `).run(input.availableAt, input.reason, input.commandId, input.workerId, input.fencingToken, input.now);
      if (!Number(result.changes)) return this.fenceResult(input, 0);
      this.returnRunToQueue(String(row.run_id), input.now);
      return { status: "applied" };
    });
  }

  private admissionSnapshot(): AdmissionSnapshot {
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('claimed','starting','running','awaiting_approval','stopping') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status IN ('requested','queued') THEN 1 ELSE 0 END) AS queued
      FROM workbench_runs
    `).get() as Row;
    const reserved = zeroBudget();
    const reservations = this.db.prepare(`
      SELECT resources_json FROM workbench_outbox WHERE reservation_active = 1
    `).all() as Row[];
    for (const row of reservations) addBudget(reserved, resources(object(row.resources_json)));
    return {
      activeRuns: Number(counts.active ?? 0),
      queuedRuns: Number(counts.queued ?? 0),
      reserved,
    };
  }

  private ensureProviderCircuit(provider: string, timestamp: string): Row {
    this.db.prepare(`
      INSERT INTO workbench_provider_circuits (
        provider, state, consecutive_failures, updated_at
      ) VALUES (?, 'closed', 0, ?)
      ON CONFLICT(provider) DO NOTHING
    `).run(provider, timestamp);
    return this.providerCircuitRow(provider);
  }

  private providerCircuitRow(provider: string): Row {
    const row = this.db.prepare(`
      SELECT * FROM workbench_provider_circuits WHERE provider = ?
    `).get(provider) as Row | undefined;
    if (!row) throw new Error(`Provider circuit ${provider} was not found.`);
    return row;
  }

  private commandRow(id: string): Row {
    const row = this.db.prepare(`
      SELECT o.*, r.provider, r.status AS run_status,
        r.state_version AS current_run_state_version,
        r.run_generation AS current_run_generation,
        recovery.terminal_status AS recovery_terminal_status,
        recovery.termination_verified AS recovery_termination_verified
      FROM workbench_outbox o
      JOIN workbench_runs r ON r.id = o.run_id
      LEFT JOIN workbench_execution_recovery recovery ON recovery.command_id = o.id
      WHERE o.id = ?
    `).get(id) as Row | undefined;
    if (!row) throw new Error(`Durable command ${id} was not found.`);
    return row;
  }

  private commandProvider(id: string): string {
    return String(this.commandRow(id).provider);
  }

  private recordProviderAttempt(commandId: string, includeSpawnCommands: boolean): void {
    this.db.prepare(`
      UPDATE workbench_outbox SET
        provider_attempt_count = provider_attempt_count + 1,
        provider_attempt_fencing_token = fencing_token
      WHERE id = ? AND state = 'claimed'
        AND (? = 1 OR operation NOT IN ('start', 'resume'))
        AND (provider_attempt_fencing_token IS NULL OR provider_attempt_fencing_token <> fencing_token)
        AND NOT EXISTS (
          SELECT 1 FROM workbench_execution_recovery recovery
          WHERE recovery.command_id = workbench_outbox.id
            AND recovery.terminal_status IS NOT NULL
            AND recovery.termination_verified = 1
        )
    `).run(commandId, includeSpawnCommands ? 1 : 0);
  }

  private ensureDequeuedRecovery(
    row: Row,
    durableOperation: DurableCommandOperation,
    timestamp: string,
  ): void {
    if (durableOperation !== "start" && durableOperation !== "resume") return;
    const executionId = String(row.execution_id ?? "");
    if (!executionId) throw new Error("Dequeued durable command is missing execution identity.");
    const jobObjectId = durableJobObjectId(executionId);
    const existing = this.db.prepare(`
      SELECT command_id, run_id, job_object_id
      FROM workbench_execution_recovery WHERE execution_id = ?
    `).get(executionId) as Row | undefined;
    if (existing) {
      if (
        String(existing.command_id) !== String(row.id)
        || String(existing.run_id) !== String(row.run_id)
        || String(existing.job_object_id) !== jobObjectId
      ) {
        throw new Error("Dequeued recovery intent conflicts with durable command identity.");
      }
      return;
    }
    this.db.prepare(`
      INSERT INTO workbench_execution_recovery (
        execution_id, command_id, run_id, job_object_id, checkpoint,
        process_identity_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'dequeued', '{}', ?, ?)
    `).run(
      executionId,
      String(row.id),
      String(row.run_id),
      jobObjectId,
      timestamp,
      timestamp,
    );
  }

  private fencedRow(input: LeaseGuard): Row | null {
    return this.db.prepare(`
      SELECT o.*, r.status AS run_status, r.state_version AS current_run_state_version,
        r.run_generation AS current_run_generation
      FROM workbench_outbox o JOIN workbench_runs r ON r.id = o.run_id
      WHERE o.id = ? AND o.state = 'claimed'
        AND o.claimed_by = ? AND o.fencing_token = ? AND o.lease_expires_at > ?
        AND o.run_generation = r.run_generation
        AND r.status NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')
    `).get(input.commandId, input.workerId, input.fencingToken, input.now) as Row | undefined ?? null;
  }

  private fenceResult(input: LeaseGuard, changes: number): FencedMutationResult {
    if (changes) return { status: "applied" };
    const row = this.db.prepare("SELECT state, claimed_by, fencing_token FROM workbench_outbox WHERE id = ?")
      .get(input.commandId) as Row | undefined;
    if (!row) return { status: "missing" };
    if (row.state === "completed") return { status: "already_applied" };
    return { status: "stale_fence" };
  }

  private loadProviderCircuitSync(provider: string): DurableProviderCircuitSnapshot {
    const row = this.db.prepare(`
      SELECT * FROM workbench_provider_circuits WHERE provider = ?
    `).get(provider) as Row | undefined;
    return row ? circuitFromRow(row) : {
      provider,
      state: "closed",
      fencingToken: 0,
      consecutiveFailures: 0,
      openUntil: null,
      halfOpenOwner: null,
      halfOpenLeaseExpiresAt: null,
      updatedAt: new Date(0).toISOString(),
    };
  }

  private circuitLease(
    snapshot: DurableProviderCircuitSnapshot,
    probe: boolean,
  ): DurableProviderCircuitLease {
    return {
      provider: snapshot.provider,
      fencingToken: snapshot.fencingToken,
      probe,
    };
  }

  private circuitLeaseIsCurrent(
    lease: DurableProviderCircuitLease,
    workerId: string,
    now: string,
  ): boolean {
    const row = this.providerCircuitRow(lease.provider);
    if (Number(row.fencing_token ?? 0) !== lease.fencingToken) return false;
    if (!lease.probe) return String(row.state) === "closed";
    return String(row.state) === "half_open"
      && optionalString(row.half_open_owner) === workerId
      && String(row.half_open_lease_expires_at) > now;
  }

  private circuitLeaseIsCurrentForCommand(
    commandId: string,
    lease: DurableProviderCircuitLease,
    workerId: string,
    now: string,
  ): boolean {
    return this.commandProvider(commandId) === lease.provider
      && this.circuitLeaseIsCurrent(lease, workerId, now);
  }

  private recordCircuitSuccess(
    lease: DurableProviderCircuitLease,
    workerId: string,
    now: string,
  ): boolean {
    if (!this.circuitLeaseIsCurrent(lease, workerId, now)) {
      return false;
    }
    const result = this.db.prepare(`
      UPDATE workbench_provider_circuits SET
        state = 'closed', consecutive_failures = 0, open_until = NULL,
        half_open_owner = NULL, half_open_lease_expires_at = NULL, updated_at = ?
      WHERE provider = ? AND fencing_token = ?
    `).run(now, lease.provider, lease.fencingToken);
    return Number(result.changes) === 1;
  }

  private recordCircuitFailure(input: FailureDispositionInput, now: string): void {
    const { circuit } = input;
    if (!this.circuitLeaseIsCurrent(circuit, input.workerId, now)) {
      throw new Error("Provider circuit failure requires the current fenced permit.");
    }
    if (!input.countsTowardCircuit) {
      if (circuit.probe) {
        this.db.prepare(`
          UPDATE workbench_provider_circuits SET
            state = 'open', open_until = ?, half_open_owner = NULL,
            half_open_lease_expires_at = NULL, updated_at = ?
          WHERE provider = ? AND fencing_token = ?
        `).run(now, now, circuit.provider, circuit.fencingToken);
      }
      return;
    }
    const row = this.providerCircuitRow(circuit.provider);
    const failures = Number(row.consecutive_failures ?? 0) + 1;
    if (circuit.probe || failures >= input.circuitFailureThreshold) {
      const openUntil = new Date(Date.parse(now) + input.circuitResetMs).toISOString();
      this.db.prepare(`
        UPDATE workbench_provider_circuits SET
          state = 'open', consecutive_failures = ?, open_until = ?,
          half_open_owner = NULL, half_open_lease_expires_at = NULL, updated_at = ?
        WHERE provider = ? AND fencing_token = ?
      `).run(
        Math.max(failures, input.circuitFailureThreshold),
        openUntil,
        now,
        circuit.provider,
        circuit.fencingToken,
      );
      return;
    }
    this.db.prepare(`
      UPDATE workbench_provider_circuits SET consecutive_failures = ?, updated_at = ?
      WHERE provider = ? AND fencing_token = ?
    `).run(failures, now, circuit.provider, circuit.fencingToken);
  }

  private advanceCheckpoint(
    input: LeaseGuard & { attempt?: number },
    checkpoint: Exclude<typeof CHECKPOINT_ORDER[number], "pending" | "dequeued">,
    columns: Record<string, string>,
    nextStatus?: RunStatus,
    pid?: number,
    identity?: DurableExecutionIdentity,
    process?: DurableProcessIdentity,
  ): FencedMutationResult {
    return transaction(this.db, () => {
      const row = this.fencedRow(input);
      if (!row) return this.fenceResult(input, 0);
      if (identity) assertExecutionAssociation(row, identity);
      if (process && identity) assertProcessIdentity(process, identity);
      if (process && identity && !this.spawnObservationHasLaunchAuthorization(row, identity, input.attempt)) {
        return { status: "missing" };
      }
      const currentIndex = CHECKPOINT_ORDER.indexOf(String(row.checkpoint) as typeof CHECKPOINT_ORDER[number]);
      const targetIndex = CHECKPOINT_ORDER.indexOf(checkpoint);
      if (currentIndex >= targetIndex) {
        if (identity) this.persistRecoveryIdentity(row, checkpoint, identity, process, input.now);
        return { status: "already_applied" };
      }
      const assignments = ["checkpoint = ?", ...Object.keys(columns).map((key) => `${key} = ?`)];
      const values = [checkpoint, ...Object.values(columns)];
      const result = this.db.prepare(`
        UPDATE workbench_outbox SET ${assignments.join(", ")}
        WHERE id = ? AND state = 'claimed' AND claimed_by = ? AND fencing_token = ?
          AND lease_expires_at > ?
      `).run(...values, input.commandId, input.workerId, input.fencingToken, input.now);
      if (!Number(result.changes)) return this.fenceResult(input, 0);
      if (identity) this.persistRecoveryIdentity(row, checkpoint, identity, process, input.now);
      if (nextStatus) this.transitionRun(String(row.run_id), nextStatus, input.now, null, pid);
      return { status: "applied" };
    });
  }

  private spawnObservationHasLaunchAuthorization(
    row: Row,
    identity: DurableExecutionIdentity,
    attempt: number | undefined,
  ): boolean {
    if (
      (operation(row) !== "start" && operation(row) !== "resume")
      || !Number.isSafeInteger(attempt)
      || Number(attempt) <= 0
      || Number(row.provider_attempt_count ?? 0) !== attempt
    ) {
      return false;
    }
    const receipt = this.db.prepare(`
      SELECT * FROM workbench_launch_authorizations
      WHERE execution_id = ?
      ORDER BY launch_generation DESC LIMIT 1
    `).get(identity.executionId) as Row | undefined;
    if (!receipt) return false;
    const authorization = launchAuthorizationFromReceiptRow(receipt);
    return authorization.executionId === identity.executionId
      && authorization.commandId === identity.commandId
      && authorization.runId === identity.runId
      && authorization.jobObjectId === identity.jobObjectId
      && authorization.attempt === attempt;
  }

  private persistRecoveryIdentity(
    row: Row,
    checkpoint: "spawn_intent" | "spawned" | "registered" | "completed",
    identity: DurableExecutionIdentity,
    process: DurableProcessIdentity | undefined,
    timestamp: string,
  ): void {
    const existing = this.db.prepare(`
      SELECT * FROM workbench_execution_recovery WHERE execution_id = ?
    `).get(identity.executionId) as Row | undefined;
    if (existing && (
      String(existing.command_id) !== identity.commandId
      || String(existing.run_id) !== identity.runId
      || String(existing.job_object_id) !== identity.jobObjectId
    )) {
      throw new Error("Persisted durable execution association conflicts with spawn identity.");
    }
    if (!existing) {
      this.db.prepare(`
        INSERT INTO workbench_execution_recovery (
          execution_id, command_id, run_id, job_object_id, checkpoint,
          process_identity_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?)
      `).run(
        identity.executionId,
        identity.commandId,
        identity.runId,
        identity.jobObjectId,
        checkpoint,
        timestamp,
        timestamp,
      );
    }
    if (process) {
      this.db.prepare(`
        UPDATE workbench_execution_recovery SET
          checkpoint = CASE
            WHEN checkpoint = 'completed' THEN checkpoint
            WHEN ? = 'registered' THEN 'registered'
            WHEN ? = 'spawned' AND checkpoint IN ('dequeued', 'spawn_intent') THEN 'spawned'
            ELSE checkpoint
          END,
          pid = ?, root_process_started_at_file_time = ?, job_name = ?, helper_pid = ?,
          helper_process_started_at_file_time = ?, executable_path = ?, executable_hash = ?,
          process_started_at = ?, process_identity_json = ?, updated_at = ?
        WHERE execution_id = ?
      `).run(
        checkpoint,
        checkpoint,
        process.pid,
        process.rootProcessStartedAtFileTime ?? null,
        process.jobName ?? null,
        process.helperPid ?? null,
        process.helperProcessStartedAtFileTime ?? null,
        process.executablePath,
        process.executableHash.toLowerCase(),
        process.startedAt,
        JSON.stringify(redactRecord(process)),
        timestamp,
        identity.executionId,
      );
    } else {
      this.db.prepare(`
        UPDATE workbench_execution_recovery SET
          checkpoint = CASE
            WHEN checkpoint = 'dequeued' AND ? = 'spawn_intent' THEN 'spawn_intent'
            ELSE checkpoint
          END,
          updated_at = ?
        WHERE execution_id = ?
      `).run(checkpoint, timestamp, identity.executionId);
    }
    const persisted = this.db.prepare(`
      SELECT command_id, run_id, job_object_id FROM workbench_execution_recovery WHERE execution_id = ?
    `).get(identity.executionId) as Row;
    if (
      String(persisted.command_id) !== String(row.id)
      || String(persisted.run_id) !== String(row.run_id)
      || String(persisted.job_object_id) !== identity.jobObjectId
    ) {
      throw new Error("Durable execution recovery association verification failed.");
    }
  }

  private persistCompletedRecovery(
    executionId: string,
    identity: DurableExecutionIdentity,
    outcomeInput: DurableExecutionOutcome,
    completedAt: string,
  ): void {
    if (!executionId) return;
    const row = this.db.prepare(`
      SELECT * FROM workbench_execution_recovery WHERE execution_id = ?
    `).get(executionId) as Row | undefined;
    if (!row) {
      // Control commands do not spawn and therefore have no process-recovery record.
      return;
    }
    if (
      String(row.command_id) !== identity.commandId
      || String(row.run_id) !== identity.runId
      || String(row.job_object_id) !== identity.jobObjectId
    ) {
      throw new Error("Completion identity conflicts with durable execution recovery record.");
    }
    const outcome = redactRecord(outcomeInput) as unknown as DurableExecutionOutcome;
    const existing = outcomeFromRecoveryRow(row);
    if (existing && JSON.stringify(existing) !== JSON.stringify(outcome)) {
      throw new Error("Durable terminal outcome is immutable and conflicts with completion.");
    }
    this.db.prepare(`
      UPDATE workbench_execution_recovery SET
        checkpoint = 'completed', terminal_status = ?, terminal_exit_code = ?,
        terminal_error_code = ?, terminal_error_message = ?, terminal_metadata_json = ?,
        terminal_observed_at = COALESCE(terminal_observed_at, ?), termination_verified = 1,
        terminal_source = COALESCE(terminal_source, 'worker'), updated_at = ?
      WHERE execution_id = ?
    `).run(
      outcome.status,
      outcome.exitCode,
      outcome.errorCode ?? null,
      outcome.errorMessage ? redactText(outcome.errorMessage, 2_000) : null,
      JSON.stringify(redactRecord(outcome.metadata ?? {})),
      completedAt,
      completedAt,
      executionId,
    );
  }

  private persistVerifiedCleanupIntent(executionId: string, timestamp: string): void {
    const recovery = this.db.prepare(`
      SELECT terminal_source FROM workbench_execution_recovery WHERE execution_id = ?
    `).get(executionId) as Row | undefined;
    if (!recovery || String(recovery.terminal_source ?? "") !== "windows_job_helper") return;

    const result = this.db.prepare(`
      INSERT INTO workbench_execution_cleanup_intents (
        execution_id, command_id, run_id, job_object_id, run_generation,
        chain_version, journal_generation, status_sequence, previous_status_sequence,
        previous_snapshot_digest_sha256, previous_journal_digest_sha256,
        snapshot_digest_sha256, journal_digest_sha256,
        authenticated_payload_digest_sha256, native_terminal_digest_sha256,
        controller_outcome_digest_sha256, native_terminal_status, native_exit_code,
        terminal, termination_verified, terminal_status, terminal_observed_at,
        root_process_id, root_process_started_at_file_time, job_name,
        helper_process_id, helper_process_started_at_file_time,
        state, available_at, attempt_count, fencing_token, created_at, updated_at
      )
      SELECT
        recovery.execution_id,
        recovery.command_id,
        recovery.run_id,
        recovery.job_object_id,
        command.run_generation,
        high_water.chain_version,
        high_water.journal_generation,
        high_water.status_sequence,
        high_water.previous_status_sequence,
        high_water.previous_snapshot_digest_sha256,
        high_water.previous_journal_digest_sha256,
        high_water.snapshot_digest_sha256,
        high_water.journal_digest_sha256,
        high_water.authenticated_payload_digest_sha256,
        high_water.native_terminal_digest_sha256,
        high_water.controller_outcome_digest_sha256,
        high_water.native_terminal_status,
        high_water.native_exit_code,
        high_water.terminal,
        high_water.termination_verified,
        recovery.terminal_status,
        recovery.terminal_observed_at,
        recovery.pid,
        recovery.root_process_started_at_file_time,
        recovery.job_name,
        recovery.helper_pid,
        recovery.helper_process_started_at_file_time,
        'pending', ?, 0, 0, ?, ?
      FROM workbench_execution_recovery recovery
      JOIN workbench_outbox command
        ON command.id = recovery.command_id
        AND command.execution_id = recovery.execution_id
        AND command.run_id = recovery.run_id
      JOIN workbench_external_status_high_water high_water
        ON high_water.execution_id = recovery.execution_id
        AND high_water.command_id = recovery.command_id
        AND high_water.run_id = recovery.run_id
        AND high_water.job_object_id = recovery.job_object_id
      WHERE recovery.execution_id = ?
        AND command.operation IN ('start', 'resume')
        AND command.state = 'completed'
        AND command.checkpoint = 'completed'
        AND command.reservation_active = 0
        AND recovery.checkpoint = 'completed'
        AND recovery.terminal_source = 'windows_job_helper'
        AND recovery.termination_verified = 1
        AND high_water.chain_version = 2
        AND high_water.terminal = 1
        AND high_water.termination_verified = 1
        AND high_water.native_terminal_status = recovery.terminal_status
        AND high_water.native_terminal_digest_sha256 = recovery.terminal_native_digest_sha256
        AND high_water.controller_outcome_digest_sha256
          = recovery.terminal_controller_outcome_digest_sha256
      ON CONFLICT(execution_id) DO NOTHING
    `).run(timestamp, timestamp, timestamp, executionId);
    if (Number(result.changes) === 1) return;
    const existing = this.db.prepare(`
      SELECT execution_id FROM workbench_execution_cleanup_intents WHERE execution_id = ?
    `).get(executionId) as Row | undefined;
    if (!existing) {
      throw new Error("Verified Windows terminal completion requires one durable cleanup intent.");
    }
  }

  private resolveVerifiedCancellationPair(
    current: Row,
    input: CompletionInput,
  ): VerifiedCancellationPair | null {
    const currentOperation = operation(current);
    if (currentOperation !== "start" && currentOperation !== "resume" && currentOperation !== "cancel") {
      return null;
    }

    let providerCommand: Row;
    let cancelCommand: Row;
    if (currentOperation === "cancel") {
      cancelCommand = current;
      const payload = object(current.payload_json);
      const targetExecutionId = typeof payload.targetExecutionId === "string" ? payload.targetExecutionId : "";
      const targetJobObjectId = typeof payload.targetJobObjectId === "string" ? payload.targetJobObjectId : "";
      const targets = this.db.prepare(`
        SELECT * FROM workbench_outbox
        WHERE run_id = ? AND run_generation = ? AND execution_id = ?
          AND operation IN ('start', 'resume')
        ORDER BY created_at ASC, id ASC
      `).all(
        String(current.run_id),
        Number(current.run_generation ?? 0),
        targetExecutionId,
      ) as Row[];
      if (targets.length !== 1 || targetJobObjectId !== durableJobObjectId(targetExecutionId)) {
        throw new Error("Verified cancel command does not resolve to one durable provider execution.");
      }
      providerCommand = targets[0];
    } else {
      providerCommand = current;
      const candidates = this.db.prepare(`
        SELECT * FROM workbench_outbox
        WHERE run_id = ? AND run_generation = ? AND operation = 'cancel'
        ORDER BY created_at ASC, id ASC
      `).all(String(current.run_id), Number(current.run_generation ?? 0)) as Row[];
      const matches = candidates.filter((candidate) => {
        const payload = object(candidate.payload_json);
        return payload.targetExecutionId === String(current.execution_id)
          && payload.targetJobObjectId === input.identity.jobObjectId;
      });
      if (matches.length === 0) return null;
      if (matches.length !== 1) {
        throw new Error("Verified cancellation matched more than one durable cancel command.");
      }
      cancelCommand = matches[0];
    }

    const cancelPayload = object(cancelCommand.payload_json);
    const providerExecutionId = String(providerCommand.execution_id ?? "");
    const providerIdentity: DurableExecutionIdentity = {
      executionId: providerExecutionId,
      commandId: String(providerCommand.id),
      runId: String(providerCommand.run_id),
      jobObjectId: durableJobObjectId(providerExecutionId),
    };
    if (
      cancelPayload.targetExecutionId !== providerIdentity.executionId
      || cancelPayload.targetJobObjectId !== providerIdentity.jobObjectId
      || String(cancelCommand.run_id) !== providerIdentity.runId
      || Number(cancelCommand.run_generation ?? -1) !== Number(providerCommand.run_generation ?? -2)
    ) {
      throw new Error("Cancel command target identity conflicts with its durable provider command.");
    }

    const recovery = this.db.prepare(`
      SELECT recovery.*,
        high_water.command_id AS hwm_command_id,
        high_water.run_id AS hwm_run_id,
        high_water.job_object_id AS hwm_job_object_id,
        high_water.chain_version AS hwm_chain_version,
        high_water.terminal AS hwm_terminal,
        high_water.termination_verified AS hwm_termination_verified,
        high_water.native_terminal_digest_sha256 AS hwm_native_digest_sha256,
        high_water.controller_outcome_digest_sha256 AS hwm_controller_digest_sha256
      FROM workbench_execution_recovery recovery
      JOIN workbench_external_status_high_water high_water
        ON high_water.execution_id = recovery.execution_id
      WHERE recovery.execution_id = ?
    `).get(providerIdentity.executionId) as Row | undefined;
    const providerOutcome = recovery ? outcomeFromRecoveryRow(recovery) : null;
    if (
      !recovery
      || String(recovery.command_id) !== providerIdentity.commandId
      || String(recovery.run_id) !== providerIdentity.runId
      || String(recovery.job_object_id) !== providerIdentity.jobObjectId
      || Number(recovery.termination_verified) !== 1
      || String(recovery.terminal_source) !== "windows_job_helper"
      || !SHA256_PATTERN.test(String(recovery.terminal_native_digest_sha256 ?? ""))
      || !SHA256_PATTERN.test(String(recovery.terminal_controller_outcome_digest_sha256 ?? ""))
      || String(recovery.hwm_command_id) !== providerIdentity.commandId
      || String(recovery.hwm_run_id) !== providerIdentity.runId
      || String(recovery.hwm_job_object_id) !== providerIdentity.jobObjectId
      || Number(recovery.hwm_chain_version) !== 2
      || Number(recovery.hwm_terminal) !== 1
      || Number(recovery.hwm_termination_verified) !== 1
      || String(recovery.hwm_native_digest_sha256) !== String(recovery.terminal_native_digest_sha256)
      || String(recovery.hwm_controller_digest_sha256)
        !== String(recovery.terminal_controller_outcome_digest_sha256)
      || !providerOutcome
      || !hasVerifiedTerminalOutcome(providerOutcome)
      || durableOutcomeDigestSha256(providerOutcome)
        !== String(recovery.terminal_controller_outcome_digest_sha256)
    ) {
      throw new Error("Cancellation pair requires an exact authenticated terminal recovery checkpoint.");
    }
    if (
      (currentOperation === "start" || currentOperation === "resume")
      && durableOutcomeDigestSha256(input.outcome) !== durableOutcomeDigestSha256(providerOutcome)
    ) {
      throw new Error("Provider completion conflicts with its authenticated terminal recovery outcome.");
    }
    if (
      currentOperation === "cancel"
      && durableOutcomeDigestSha256(input.outcome)
        !== durableOutcomeDigestSha256(canonicalCancelOutcome(providerOutcome))
    ) {
      throw new Error("Cancel completion conflicts with the canonical authenticated target outcome.");
    }
    return { providerCommand, cancelCommand, providerIdentity, providerOutcome };
  }

  private completeVerifiedCancellationPair(
    pair: VerifiedCancellationPair,
    input: CompletionInput,
  ): void {
    const complete = (command: Row, outcome: DurableExecutionOutcome): void => {
      if (String(command.state) === "completed") {
        const existing = object(command.outcome_json) as unknown as DurableExecutionOutcome;
        if (durableOutcomeDigestSha256(existing) !== durableOutcomeDigestSha256(outcome)) {
          throw new Error("Completed cancellation-pair command has an immutable outcome conflict.");
        }
        return;
      }
      if (String(command.state) === "dead") {
        throw new Error("Dead command conflicts with verified process-tree termination.");
      }
      const result = this.db.prepare(`
        UPDATE workbench_outbox SET
          state = 'completed', checkpoint = 'completed', completed_at = ?,
          claimed_at = NULL, claimed_by = NULL, lease_expires_at = NULL,
          reservation_active = 0, outcome_json = ?, last_error = NULL
        WHERE id = ? AND run_id = ? AND run_generation = ?
          AND state IN ('pending', 'claimed')
      `).run(
        input.completedAt,
        JSON.stringify(redactRecord(outcome)),
        String(command.id),
        String(command.run_id),
        Number(command.run_generation ?? 0),
      );
      if (Number(result.changes) !== 1) {
        throw new Error("Verified cancellation lost the paired command-completion race.");
      }
    };

    complete(pair.providerCommand, pair.providerOutcome);
    complete(pair.cancelCommand, canonicalCancelOutcome(pair.providerOutcome));
    this.persistCompletedRecovery(
      pair.providerIdentity.executionId,
      pair.providerIdentity,
      pair.providerOutcome,
      input.completedAt,
    );
    this.persistVerifiedCleanupIntent(pair.providerIdentity.executionId, input.completedAt);
  }

  private transitionRun(
    runId: string,
    to: RunStatus,
    timestamp: string,
    error: { code: string; message: string } | null = null,
    pid?: number,
  ): void {
    const row = this.db.prepare(`
      SELECT status, started_at, pid, state_version, run_generation
      FROM workbench_runs WHERE id = ?
    `)
      .get(runId) as Row | undefined;
    if (!row) throw new Error(`Run ${runId} was not found.`);
    const from = String(row.status) as RunStatus;
    if (from === to) return;
    if (TERMINAL_RUN_STATUSES.has(from)) {
      throw new Error(`Stale terminal run transition rejected: ${from} -> ${to}.`);
    }
    assertLegalRunTransition(from, to);
    const terminal = TERMINAL_RUN_STATUSES.has(to);
    const startedAt = typeof row.started_at === "string" ? row.started_at : null;
    const existingPid = typeof row.pid === "number" ? row.pid : null;
    const nextStateVersion = Number(row.state_version ?? 0) + 1;
    const invalidatesGeneration = to === "cancelled" || to === "orphaned";
    const nextRunGeneration = Number(row.run_generation ?? 0) + (invalidatesGeneration ? 1 : 0);
    const result = this.db.prepare(`
      UPDATE workbench_runs SET status = ?, updated_at = ?, started_at = ?, finished_at = ?,
        pid = ?, error_code = ?, error_message = ?, state_version = state_version + 1,
        run_generation = ?
      WHERE id = ? AND status = ? AND state_version = ? AND run_generation = ?
    `).run(
      to,
      timestamp,
      to === "running" ? (startedAt ?? timestamp) : startedAt,
      terminal ? timestamp : null,
      terminal ? null : (pid ?? existingPid),
      error ? redactText(error.code, 100) : null,
      error ? redactText(error.message, 2_000) : null,
      nextRunGeneration,
      runId,
      from,
      Number(row.state_version ?? 0),
      Number(row.run_generation ?? 0),
    );
    if (Number(result.changes) !== 1) {
      throw new Error("Stale run state compare-and-swap rejected.");
    }
    if (invalidatesGeneration) {
      this.db.prepare(`
        UPDATE workbench_outbox SET
          state = 'dead', completed_at = ?, claimed_at = NULL, claimed_by = NULL,
          lease_expires_at = NULL, reservation_active = 0,
          last_error = 'run_generation_invalidated'
        WHERE run_id = ? AND run_generation < ? AND state IN ('pending', 'claimed')
      `).run(timestamp, runId, nextRunGeneration);
    }
    this.db.prepare(`
      INSERT INTO workbench_events (id, run_id, type, created_at, payload_json)
      VALUES (?, ?, 'status', ?, ?)
    `).run(randomUUID(), runId, timestamp, JSON.stringify(redactRecord({
      from,
      status: to,
      stateVersion: nextStateVersion,
      source: "durable-worker",
    })));
  }

  private returnRunToQueue(runId: string, timestamp: string): void {
    const row = this.db.prepare("SELECT status FROM workbench_runs WHERE id = ?").get(runId) as Row | undefined;
    if (!row) return;
    const status = String(row.status) as RunStatus;
    if (status === "queued" || TERMINAL_RUN_STATUSES.has(status)) return;
    if (status === "claimed") {
      this.transitionRun(runId, "queued", timestamp);
      return;
    }
    this.transitionRun(runId, "orphaned", timestamp, {
      code: "delivery_retry",
      message: "Provider delivery will be retried after recovery.",
    });
    this.transitionRun(runId, "queued", timestamp);
  }
}
