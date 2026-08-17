import { createHash } from "node:crypto";
import {
  DEFAULT_ADMISSION_POLICY,
  type AdmissionPolicy,
  type ResourceBudget,
} from "./resourceAdmission";
import {
  classifyExecutionFailure,
  DEFAULT_PROVIDER_RETRY_POLICIES,
  DurableExecutionError,
  failureCountsTowardCircuit,
  retryDecision,
  retryPolicyForProvider,
  runWithAttemptTimeout,
  type ExecutionFailure,
  type ProviderRetryPolicy,
} from "./retryPolicy";
import { redactRecord } from "./redaction";

export { DurableExecutionError } from "./retryPolicy";

export type DurableCommandOperation =
  | "start"
  | "resume"
  | "steer"
  | "queue"
  | "cancel"
  | "reconcile_orphan";

export type ExecutionCheckpoint =
  | "dequeued"
  | "spawn_intent"
  | "spawned"
  | "registered"
  | "completed";

export interface DurableCommand<Payload = unknown> {
  id: string;
  runId: string;
  provider: string;
  operation: DurableCommandOperation;
  payload: Payload;
  payloadHash: string;
  idempotencyKey: string;
  /** Run lifecycle generation captured by the durable command. */
  runGeneration: number;
  /** Run state version observed when the command was enqueued. */
  runStateVersion: number;
  /** Stable across every redelivery of this command. */
  executionId: string;
  /** One-based provider attempt; delivery-only retries do not consume it. */
  attempt: number;
  /** Number of queue deliveries, including lease recovery and circuit deferral. */
  deliveryAttempts: number;
  maxAttempts: number;
  checkpoint: ExecutionCheckpoint;
  availableAt: string;
  resources: ResourceBudget;
}

export interface CommandLease {
  workerId: string;
  fencingToken: number;
  expiresAt: string;
}

export interface ClaimedCommand<Payload = unknown> {
  command: DurableCommand<Payload>;
  lease: CommandLease;
}

export interface ClaimNextCommandInput {
  workerId: string;
  now: string;
  leaseDurationMs: number;
  admissionPolicy: Readonly<AdmissionPolicy>;
  /** Dedicated control workers claim only cancel commands; provider workers never consume that reserve. */
  lane?: "provider" | "control" | "any";
  /** Open circuits must be filtered in the same transaction as selection. */
  excludedProviders: readonly string[];
}

export interface LeaseGuard {
  commandId: string;
  workerId: string;
  fencingToken: number;
  now: string;
}

export type FencedMutationStatus = "applied" | "already_applied" | "stale_fence" | "missing";

export interface FencedMutationResult {
  status: FencedMutationStatus;
}

export interface DurableExecutionIdentity {
  executionId: string;
  commandId: string;
  runId: string;
  /** Stable OS containment identity used to rediscover a process after crash. */
  jobObjectId: string;
}

export interface DurableProcessIdentity {
  pid: number;
  jobObjectId: string;
  /** Native named Job Object identity returned by the containment helper. */
  jobName?: string;
  /** Windows process creation time; paired with pid to prevent PID-reuse confusion. */
  rootProcessStartedAtFileTime?: string;
  /** Containment-helper identity is optional until the launcher exposes both values. */
  helperPid?: number;
  helperProcessStartedAtFileTime?: string;
  executablePath: string;
  executableHash: string;
  startedAt: string;
}

export interface DurableExecutionOutcome {
  status: "succeeded" | "failed" | "cancelled" | "blocked";
  exitCode: number | null;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

function canonicalDigestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalDigestValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalDigestValue(item)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Durable outcome digest cannot contain non-finite numbers.");
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** Digest shared by the controller and durable repository after redaction. */
export function durableOutcomeDigestSha256(outcome: DurableExecutionOutcome): string {
  const redacted = redactRecord(outcome);
  return createHash("sha256")
    .update(JSON.stringify(canonicalDigestValue(redacted)), "utf8")
    .digest("hex");
}

export type SpawnResolution =
  | { state: "running"; process: DurableProcessIdentity }
  | { state: "completed"; process: DurableProcessIdentity; outcome: DurableExecutionOutcome }
  | { state: "completed_without_process"; outcome: DurableExecutionOutcome };

export interface SpawnIntentInput extends LeaseGuard {
  attempt: number;
  identity: DurableExecutionIdentity;
}

export interface SpawnObservationInput extends LeaseGuard {
  attempt: number;
  identity: DurableExecutionIdentity;
  process: DurableProcessIdentity;
}

export interface CompletionInput extends LeaseGuard {
  attempt: number;
  identity: DurableExecutionIdentity;
  outcome: DurableExecutionOutcome;
  completedAt: string;
  circuit: DurableProviderCircuitLease;
}

export type DurableTerminalCheckpointSource =
  | "worker"
  | "windows_job_helper"
  | "windows_job_controller";

export interface VerifiedDurableTerminalCheckpointInput {
  executionId: string;
  commandId: string;
  runId: string;
  jobObjectId: string;
  statusEvidence: DurableExternalStatusHighWaterInput & {
    terminal: true;
    terminationVerified: true;
    nativeTerminalStatus: DurableExecutionOutcome["status"];
    nativeExitCode: number | null;
    nativeTerminalDigestSha256: string;
  };
  outcome: DurableExecutionOutcome;
  controllerOutcomeDigestSha256: string;
  observedAt: string;
  terminationVerified: true;
  source: DurableTerminalCheckpointSource;
}

export type DurableRecoveryMutationStatus = "applied" | "already_applied" | "conflict" | "missing";

export interface DurableRecoveryMutationResult {
  status: DurableRecoveryMutationStatus;
}

/**
 * Authenticated high-water evidence for the native helper's external status
 * journal. The digest pair binds both the current snapshot and the complete
 * journal prefix through `sequence`; the repository pins one journal
 * generation per durable execution and advances it monotonically.
 */
export interface DurableExternalStatusHighWaterInput {
  executionId: string;
  commandId: string;
  runId: string;
  jobObjectId: string;
  journalGeneration: string;
  sequence: number;
  previousSequence: number;
  previousSnapshotDigestSha256: string;
  previousJournalDigestSha256: string;
  terminal: boolean;
  snapshotDigestSha256: string;
  journalDigestSha256: string;
  /** SHA-256 of the exact decoded payload bytes already authenticated by HMAC. */
  authenticatedPayloadDigestSha256: string;
  /** Present only for a helper-authenticated terminal native status. */
  nativeTerminalDigestSha256: string | null;
  nativeTerminalStatus: DurableExecutionOutcome["status"] | null;
  nativeExitCode: number | null;
  terminationVerified: boolean;
  observedAt: string;
}

export interface DurableExternalStatusHighWater extends DurableExternalStatusHighWaterInput {
  /** Version 1 is legacy/unverifiable and must fail closed in native recovery. */
  chainVersion: 1 | 2;
  controllerOutcomeDigestSha256: string | null;
  updatedAt: string;
}

export interface DurableTerminalCheckpoint {
  outcome: DurableExecutionOutcome;
  nativeTerminalDigestSha256: string | null;
  controllerOutcomeDigestSha256: string | null;
  observedAt: string;
  terminationVerified: true;
  source: DurableTerminalCheckpointSource;
}

export type DurableRecoveryAction =
  | "terminal_replay"
  | "durable_terminal_probe_required"
  | "completed";

export interface DurableExecutionRecoveryRecord {
  executionId: string;
  commandId: string;
  runId: string;
  jobObjectId: string;
  checkpoint: ExecutionCheckpoint;
  process: DurableProcessIdentity | null;
  terminal: DurableTerminalCheckpoint | null;
  /** Last authenticated external status accepted by the durable CAS gate. */
  externalStatusHighWater: DurableExternalStatusHighWater | null;
  /**
   * Immutable DB authority for one native provider launch generation. A
   * descriptor, encrypted specification, or helper claim is never sufficient
   * spawn authority unless it is bound to this exact receipt.
   */
  launchAuthorization: DurableLaunchAuthorization | null;
  /**
   * Current Windows helper owns the Job handle and terminates it when its
   * control-plane parent exits. A fresh Node driver therefore must not claim
   * native Job reconnection from this record.
   */
  reconnectable: false;
  recoveryAction: DurableRecoveryAction;
  updatedAt: string;
}

export type DurableExecutionCleanupState = "pending" | "claimed" | "completed" | "quarantined";
export type DurableExecutionCleanupResult = "removed" | "already_absent";

export interface DurableExecutionCleanupIntent {
  executionId: string;
  commandId: string;
  runId: string;
  jobObjectId: string;
  runGeneration: number;
  chainVersion: 2;
  journalGeneration: string;
  statusSequence: number;
  previousStatusSequence: number;
  previousSnapshotDigestSha256: string;
  previousJournalDigestSha256: string;
  snapshotDigestSha256: string;
  journalDigestSha256: string;
  authenticatedPayloadDigestSha256: string;
  nativeTerminalDigestSha256: string;
  controllerOutcomeDigestSha256: string;
  nativeTerminalStatus: DurableExecutionOutcome["status"];
  nativeExitCode: number | null;
  terminal: true;
  terminationVerified: true;
  terminalStatus: DurableExecutionOutcome["status"];
  terminalObservedAt: string;
  rootProcessId: number | null;
  rootProcessStartedAtFileTime: string | null;
  jobName: string | null;
  helperProcessId: number | null;
  helperProcessStartedAtFileTime: string | null;
  state: DurableExecutionCleanupState;
  availableAt: string;
  attemptCount: number;
  claimedAt: string | null;
  claimedBy: string | null;
  fencingToken: number;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  cleanupResult: DurableExecutionCleanupResult | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ClaimExecutionCleanupInput {
  workerId: string;
  now: string;
  leaseDurationMs: number;
}

export interface ExecutionCleanupLeaseGuard {
  executionId: string;
  workerId: string;
  fencingToken: number;
  now: string;
}

export interface DurableExecutionCleanupRepository {
  claimNextExecutionCleanup(
    input: ClaimExecutionCleanupInput,
  ): Promise<DurableExecutionCleanupIntent | null>;
  heartbeatExecutionCleanup(
    input: ExecutionCleanupLeaseGuard & { expiresAt: string },
  ): Promise<FencedMutationResult>;
  completeExecutionCleanup(
    input: ExecutionCleanupLeaseGuard & {
      completedAt: string;
      result: DurableExecutionCleanupResult;
    },
  ): Promise<FencedMutationResult>;
  retryExecutionCleanup(
    input: ExecutionCleanupLeaseGuard & {
      availableAt: string;
      error: { code: string; message: string };
    },
  ): Promise<FencedMutationResult>;
  quarantineExecutionCleanup(
    input: ExecutionCleanupLeaseGuard & {
      quarantinedAt: string;
      error: { code: string; message: string };
    },
  ): Promise<FencedMutationResult>;
  listExecutionCleanupIntents(limit?: number): Promise<DurableExecutionCleanupIntent[]>;
  findCompletedExecutionCleanupIntents(
    executionIds: readonly string[],
  ): Promise<DurableExecutionCleanupIntent[]>;
}

export interface FailureDispositionInput extends LeaseGuard {
  attempt: number;
  failure: ExecutionFailure;
  circuit: DurableProviderCircuitLease;
  countsTowardCircuit: boolean;
  circuitFailureThreshold: number;
  circuitResetMs: number;
}

export type DurableProviderCircuitState = "closed" | "open" | "half_open";

export interface DurableProviderCircuitSnapshot {
  provider: string;
  state: DurableProviderCircuitState;
  fencingToken: number;
  consecutiveFailures: number;
  openUntil: string | null;
  halfOpenOwner: string | null;
  halfOpenLeaseExpiresAt: string | null;
  updatedAt: string;
}

export interface DurableProviderCircuitLease {
  provider: string;
  fencingToken: number;
  probe: boolean;
}

export type DurableProviderCircuitPermit =
  | {
      allowed: true;
      lease: DurableProviderCircuitLease;
      snapshot: DurableProviderCircuitSnapshot;
    }
  | {
      allowed: false;
      reason: "circuit_open";
      retryAt: string;
      snapshot: DurableProviderCircuitSnapshot;
    }
  | {
      allowed: false;
      reason: "stale_fence";
      snapshot: DurableProviderCircuitSnapshot;
    };

export interface AcquireProviderCircuitInput extends LeaseGuard {
  provider: string;
  halfOpenLeaseDurationMs: number;
}

export type ProviderAttemptAuthorizationStatus =
  | FencedMutationStatus
  | "attempt_cap_exhausted"
  | "conflict";

export interface DurableLaunchAuthorization {
  executionId: string;
  commandId: string;
  runId: string;
  jobObjectId: string;
  authorizationId: string;
  launchGeneration: number;
  attempt: number;
  journalGeneration: string;
  descriptorHmacSha256: string;
  authorizedAt: string;
}

export interface ProviderLaunchAuthorizationInput extends LeaseGuard {
  identity: DurableExecutionIdentity;
  authorizationId: string;
  launchGeneration: number;
  expectedAttempt: number;
  journalGeneration: string;
  descriptorHmacSha256: string;
}

export interface ProviderAttemptAuthorizationResult {
  status: ProviderAttemptAuthorizationStatus;
  attempt: number | null;
  authorization: DurableLaunchAuthorization | null;
}

export type AuthorizeNewProviderSpawn = (
  input: Omit<ProviderLaunchAuthorizationInput, keyof LeaseGuard>,
) => Promise<DurableLaunchAuthorization>;

/**
 * Narrow store integration contract.
 *
 * claimNext must perform selection, due-time check, control-operation attempt-cap check,
 * recovery-first admission, resource reservation, lease assignment, delivery increment,
 * monotonically increasing fencing-token assignment and `dequeued` checkpoint
 * plus recovery intent in one transaction. Expired leases are eligible for
 * redelivery. Terminal runs and stale run generations are never eligible.
 * Every other write must reject a stale command or run-generation fence.
 */
export interface DurableWorkerRepository {
  claimNext(input: ClaimNextCommandInput): Promise<ClaimedCommand | null>;
  acquireProviderCircuit(input: AcquireProviderCircuitInput): Promise<DurableProviderCircuitPermit>;
  loadProviderCircuit(provider: string): Promise<DurableProviderCircuitSnapshot>;
  heartbeatLease(input: LeaseGuard & { expiresAt: string }): Promise<FencedMutationResult>;
  recordSpawnIntent(input: SpawnIntentInput): Promise<FencedMutationResult>;
  /**
   * CAS gate called only after recovery probing proved that a new provider
   * process is required and immediately before the driver spawns it.
   */
  authorizeProviderAttempt(input: ProviderLaunchAuthorizationInput): Promise<ProviderAttemptAuthorizationResult>;
  recordSpawnObservation(input: SpawnObservationInput): Promise<FencedMutationResult>;
  registerProcess(input: SpawnObservationInput): Promise<FencedMutationResult>;
  completeCommand(input: CompletionInput): Promise<FencedMutationResult>;
  rescheduleCommand(input: FailureDispositionInput & { availableAt: string }): Promise<FencedMutationResult>;
  /** Retry local cancel delivery without changing run state or provider circuit health. */
  rescheduleControlCommand(
    input: LeaseGuard & { availableAt: string; failure: ExecutionFailure },
  ): Promise<FencedMutationResult>;
  deadLetterCommand(input: FailureDispositionInput & { completedAt: string }): Promise<FencedMutationResult>;
  /**
   * Releases a claim without treating an open provider circuit as execution
   * failure. Delivery remains counted, provider attempts remain unchanged,
   * and resource reservations must be released.
   */
  deferCommand(input: LeaseGuard & { availableAt: string; reason: "circuit_open" }): Promise<FencedMutationResult>;
}

/** Persistence API supplied to a restart-aware execution driver. */
export interface DurableExecutionRecoveryRepository {
  /** Load the immutable provider command bound to an execution for restart-safe control recovery. */
  loadExecutionCommand(executionId: string): Promise<DurableCommand | null>;
  loadExecutionRecovery(executionId: string): Promise<DurableExecutionRecoveryRecord | null>;
  listExecutionRecovery(limit?: number): Promise<DurableExecutionRecoveryRecord[]>;
  /**
   * Atomically accepts an authenticated non-terminal external status only when it advances
   * the pinned journal generation. Lower sequences, same-sequence digest
   * changes, generation changes and any update after an accepted terminal
   * status are conflicts. Drivers must require applied/already_applied before
   * using the external status for a process action or durable outcome.
   */
  acceptExternalStatusHighWater(
    input: DurableExternalStatusHighWaterInput,
  ): Promise<DurableRecoveryMutationResult>;
  /**
   * In one transaction accepts the terminal authenticated HWM tuple, verifies
   * its native terminal mapping and controller outcome digest, then persists
   * the immutable terminal checkpoint.
   * This records evidence only; run/outbox completion still requires the
   * current worker lease and fencing token through completeCommand().
   */
  recordVerifiedTerminalCheckpoint(
    input: VerifiedDurableTerminalCheckpointInput,
  ): Promise<DurableRecoveryMutationResult>;
}

/**
 * Runtime integration contract. reconcileOrSpawn must use executionId and
 * jobObjectId as an idempotency handshake: return an existing live/completed
 * process when one exists; spawn only when neither exists.
 */
export interface DurableExecutionDriver {
 reconcileOrSpawn(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
    signal: AbortSignal,
    authorizeNewSpawn: AuthorizeNewProviderSpawn,
  ): Promise<SpawnResolution>;
  waitForCompletion(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
    process: DurableProcessIdentity,
    signal: AbortSignal,
  ): Promise<DurableExecutionOutcome>;
  /**
   * Idempotent delivery for steer, queue and cancel; these operations never
   * spawn. A cancel outcome may be `cancelled` only after the driver has killed
   * the process tree and verified that it exited.
   */
  executeControl(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
    signal: AbortSignal,
  ): Promise<DurableExecutionOutcome>;
  /** Kill the identified process tree and return true only after termination is verified. */
  abortAndVerify(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
    reason: ExecutionFailure,
  ): Promise<boolean>;
}

export type CrashBoundary =
  | "after_dequeue"
  | "after_spawn"
  | "after_register"
  | "before_complete"
  | "after_complete";

export class WorkerProcessCrash extends Error {
  readonly boundary: CrashBoundary;

  constructor(boundary: CrashBoundary) {
    super(`Injected worker crash at ${boundary}.`);
    this.name = "WorkerProcessCrash";
    this.boundary = boundary;
  }
}

export class LostCommandLeaseError extends Error {
  readonly commandId: string;

  constructor(commandId: string) {
    super(`Lease or fencing token is no longer current for command ${commandId}.`);
    this.name = "LostCommandLeaseError";
    this.commandId = commandId;
  }
}

export interface WorkerCrashContext {
  command: DurableCommand;
  lease: CommandLease;
  identity: DurableExecutionIdentity;
}

export type WorkerCrashInjector = (
  boundary: CrashBoundary,
  context: WorkerCrashContext,
) => void | Promise<void>;

export interface DurableWorkerOptions {
  workerId: string;
  lane?: "provider" | "control" | "any";
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  admissionPolicy?: Readonly<AdmissionPolicy>;
  retryPolicies?: Readonly<Record<string, Readonly<ProviderRetryPolicy>>>;
  random?: () => number;
  now?: () => number;
  crashInjector?: WorkerCrashInjector;
}

export type WorkerRunResult =
  | { status: "idle" }
  | { status: "completed"; commandId: string; outcome: DurableExecutionOutcome }
  | { status: "retry_scheduled"; commandId: string; attempt: number; availableAt: string; failure: ExecutionFailure }
  | { status: "dead_lettered"; commandId: string; attempt: number; failure: ExecutionFailure }
  | { status: "deferred"; commandId: string; availableAt: string }
  | { status: "lease_lost"; commandId: string };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function fenceResultAccepted(result: FencedMutationResult): boolean {
  return result.status === "applied" || result.status === "already_applied";
}

function requireFence(result: FencedMutationResult, commandId: string): void {
  if (!fenceResultAccepted(result)) throw new LostCommandLeaseError(commandId);
}

function leaseGuard(claim: ClaimedCommand, nowMs: number): LeaseGuard {
  return {
    commandId: claim.command.id,
    workerId: claim.lease.workerId,
    fencingToken: claim.lease.fencingToken,
    now: iso(nowMs),
  };
}

function executionIdentity(command: DurableCommand): DurableExecutionIdentity {
  const safeExecutionId = command.executionId.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 120);
  return {
    executionId: command.executionId,
    commandId: command.id,
    runId: command.runId,
    jobObjectId: `agent-os-${safeExecutionId}`,
  };
}

function mergeAbortSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (!present.length) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

/** Lease heartbeat aborts the active attempt as soon as a fenced renewal fails. */
export class LeaseHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pulseInFlight = false;
  private lost = false;
  private readonly controller = new AbortController();
  private readonly repository: DurableWorkerRepository;
  private readonly claim: ClaimedCommand;
  private readonly leaseDurationMs: number;
  private readonly now: () => number;

  constructor(
    repository: DurableWorkerRepository,
    claim: ClaimedCommand,
    leaseDurationMs: number,
    now: () => number = Date.now,
  ) {
    this.repository = repository;
    this.claim = claim;
    this.leaseDurationMs = leaseDurationMs;
    this.now = now;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get leaseLost(): boolean {
    return this.lost;
  }

  async pulse(): Promise<boolean> {
    if (this.lost) return false;
    const nowMs = this.now();
    const result = await this.repository.heartbeatLease({
      ...leaseGuard(this.claim, nowMs),
      expiresAt: iso(nowMs + this.leaseDurationMs),
    });
    if (!fenceResultAccepted(result)) this.markLost();
    return !this.lost;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs >= this.leaseDurationMs) {
      throw new TypeError("heartbeatIntervalMs must be positive and shorter than leaseDurationMs.");
    }
    this.timer = setInterval(() => {
      if (this.pulseInFlight || this.lost) return;
      this.pulseInFlight = true;
      void this.pulse()
        .catch(() => this.markLost())
        .finally(() => { this.pulseInFlight = false; });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private markLost(): void {
    this.lost = true;
    this.controller.abort(new LostCommandLeaseError(this.claim.command.id));
  }
}

export class DurableWorkbenchWorker {
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly admissionPolicy: Readonly<AdmissionPolicy>;
  private readonly retryPolicies: Readonly<Record<string, Readonly<ProviderRetryPolicy>>>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly repository: DurableWorkerRepository;
  private readonly driver: DurableExecutionDriver;
  private readonly options: DurableWorkerOptions;

  constructor(
    repository: DurableWorkerRepository,
    driver: DurableExecutionDriver,
    options: DurableWorkerOptions,
  ) {
    this.repository = repository;
    this.driver = driver;
    this.options = options;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.leaseDurationMs)
      || this.leaseDurationMs <= 0
      || !Number.isSafeInteger(this.heartbeatIntervalMs)
      || this.heartbeatIntervalMs <= 0
      || this.heartbeatIntervalMs >= this.leaseDurationMs
    ) {
      throw new TypeError("Worker lease and heartbeat intervals are invalid.");
    }
    this.admissionPolicy = options.admissionPolicy ?? DEFAULT_ADMISSION_POLICY;
    this.retryPolicies = options.retryPolicies ?? DEFAULT_PROVIDER_RETRY_POLICIES;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  async runOnce(signal?: AbortSignal): Promise<WorkerRunResult> {
    const claimTime = this.now();
    const claim = await this.repository.claimNext({
      workerId: this.options.workerId,
      now: iso(claimTime),
      leaseDurationMs: this.leaseDurationMs,
      admissionPolicy: this.admissionPolicy,
      lane: this.options.lane ?? "any",
      excludedProviders: [],
    });
    if (!claim) return { status: "idle" };

    const command = claim.command;
    const policy = {
      ...retryPolicyForProvider(command.provider, this.retryPolicies),
      maxAttempts: Math.min(command.maxAttempts, retryPolicyForProvider(command.provider, this.retryPolicies).maxAttempts),
    };
    const localControl = command.operation === "cancel";
    const circuitTime = this.now();
    const circuit: DurableProviderCircuitPermit = localControl
      ? {
          allowed: true,
          lease: { provider: command.provider, fencingToken: -1, probe: false },
          snapshot: {
            provider: command.provider,
            state: "closed",
            fencingToken: -1,
            consecutiveFailures: 0,
            openUntil: null,
            halfOpenOwner: null,
            halfOpenLeaseExpiresAt: null,
            updatedAt: iso(circuitTime),
          },
        }
      : await this.repository.acquireProviderCircuit({
          provider: command.provider,
          ...leaseGuard(claim, circuitTime),
          halfOpenLeaseDurationMs: policy.attemptTimeoutMs + this.leaseDurationMs,
        });
    if (!circuit.allowed) {
      if (circuit.reason === "stale_fence") {
        return { status: "lease_lost", commandId: command.id };
      }
      const availableAt = circuit.retryAt;
      const result = await this.repository.deferCommand({
        ...leaseGuard(claim, circuitTime),
        availableAt,
        reason: "circuit_open",
      });
      if (!fenceResultAccepted(result)) return { status: "lease_lost", commandId: command.id };
      return { status: "deferred", commandId: command.id, availableAt };
    }

    const identity = executionIdentity(command);
    const providerAttemptState = {
      authorized: command.operation !== "start" && command.operation !== "resume",
      attempt: command.operation === "start" || command.operation === "resume"
        ? Math.max(1, command.attempt - 1)
        : command.attempt,
    };
    const heartbeat = new LeaseHeartbeat(this.repository, claim, this.leaseDurationMs, this.now);
    heartbeat.start(this.heartbeatIntervalMs);
    const combinedSignal = mergeAbortSignals([signal, heartbeat.signal]);
    let completedOutcome: DurableExecutionOutcome;

    try {
      completedOutcome = await runWithAttemptTimeout(
        (attemptSignal) => this.executeClaim(
          claim,
          identity,
          circuit.lease,
          providerAttemptState,
          attemptSignal,
        ),
        policy.attemptTimeoutMs,
        combinedSignal,
      );
    } catch (error) {
      if (error instanceof WorkerProcessCrash) throw error;
      if (error instanceof LostCommandLeaseError || heartbeat.leaseLost) {
        return { status: "lease_lost", commandId: command.id };
      }

      let failure = classifyExecutionFailure(error);
      if (failure.failureClass === "timeout") {
        let terminated = false;
        try {
          terminated = await this.driver.abortAndVerify(command, identity, failure);
        } catch {
          terminated = false;
        }
        if (!terminated && !localControl) {
          failure = {
            failureClass: "containment",
            message: "Timed-out provider process tree could not be verified as terminated.",
          };
        } else if (!terminated) {
          failure = {
            failureClass: "transient",
            message: "Cancel timed out before target termination could be verified.",
            retryAfterMs: 1_000,
          };
        }
      }

      if (localControl) {
        const dispositionTime = this.now();
        const retryAfterMs = failure.retryAfterMs ?? policy.baseDelayMs;
        const availableAt = iso(dispositionTime + Math.max(
          1_000,
          Math.min(policy.maxDelayMs, retryAfterMs),
        ));
        const result = await this.repository.rescheduleControlCommand({
          ...leaseGuard(claim, dispositionTime),
          failure,
          availableAt,
        });
        if (!fenceResultAccepted(result)) return { status: "lease_lost", commandId: command.id };
        return {
          status: "retry_scheduled",
          commandId: command.id,
          attempt: Math.max(1, command.deliveryAttempts),
          availableAt,
          failure,
        };
      }

      // Recovery probes and delivery-only failures are not provider attempts
      // and therefore cannot be exhausted by the provider spawn cap.
      const dispositionAttempt = providerAttemptState.authorized
        ? providerAttemptState.attempt
        : Math.max(1, command.deliveryAttempts);
      const dispositionPolicy = providerAttemptState.authorized
        ? policy
        : { ...policy, maxAttempts: Number.MAX_SAFE_INTEGER };
      const decision = retryDecision(dispositionPolicy, failure, dispositionAttempt, this.random);
      const dispositionTime = this.now();
      const circuitFailure = {
        circuit: circuit.lease,
        countsTowardCircuit: failureCountsTowardCircuit(failure),
        circuitFailureThreshold: policy.circuitFailureThreshold,
        circuitResetMs: policy.circuitResetMs,
      };
      if (decision.retry && decision.delayMs !== null) {
        const availableAt = iso(dispositionTime + decision.delayMs);
        const result = await this.repository.rescheduleCommand({
          ...leaseGuard(claim, dispositionTime),
          attempt: dispositionAttempt,
          failure,
          ...circuitFailure,
          availableAt,
        });
        if (!fenceResultAccepted(result)) return { status: "lease_lost", commandId: command.id };
        return {
          status: "retry_scheduled",
          commandId: command.id,
          attempt: dispositionAttempt,
          availableAt,
          failure,
        };
      }

      const result = await this.repository.deadLetterCommand({
        ...leaseGuard(claim, dispositionTime),
          attempt: dispositionAttempt,
        failure,
        ...circuitFailure,
        completedAt: iso(dispositionTime),
      });
      if (!fenceResultAccepted(result)) return { status: "lease_lost", commandId: command.id };
      return { status: "dead_lettered", commandId: command.id, attempt: dispositionAttempt, failure };
    } finally {
      heartbeat.stop();
    }
    return { status: "completed", commandId: command.id, outcome: completedOutcome };
  }

  private async executeClaim(
    claim: ClaimedCommand,
    identity: DurableExecutionIdentity,
    circuit: DurableProviderCircuitLease,
    providerAttemptState: { authorized: boolean; attempt: number },
    signal: AbortSignal,
  ): Promise<DurableExecutionOutcome> {
    const { command } = claim;
    const context: WorkerCrashContext = { command, lease: claim.lease, identity };
    await this.injectCrash("after_dequeue", context);

    let mutationTime = this.now();
    let outcome: DurableExecutionOutcome;
    if (command.operation === "start" || command.operation === "resume") {
      requireFence(await this.repository.recordSpawnIntent({
        ...leaseGuard(claim, mutationTime),
        attempt: command.attempt,
        identity,
      }), command.id);

      const resolution = await this.driver.reconcileOrSpawn(
        command,
        identity,
        signal,
        async (launch) => {
          const authorizationTime = this.now();
          const authorization = await this.repository.authorizeProviderAttempt(
            {
              ...leaseGuard(claim, authorizationTime),
              ...launch,
            },
          );
          if (authorization.status === "attempt_cap_exhausted") {
            throw new DurableExecutionError({
              failureClass: "invalid_request",
              message: "Provider spawn attempt cap exhausted after recovery probe.",
            });
          }
          if (
            authorization.status !== "applied"
            && authorization.status !== "already_applied"
          ) {
            throw new LostCommandLeaseError(command.id);
          }
          if (!authorization.attempt) {
            throw new Error("Provider attempt authorization omitted the attempt number.");
          }
          if (!authorization.authorization) {
            throw new Error("Provider attempt authorization omitted its durable launch receipt.");
          }
          providerAttemptState.authorized = true;
          providerAttemptState.attempt = authorization.attempt;
          return authorization.authorization;
        },
      );
      await this.injectCrash("after_spawn", context);

      if (resolution.state === "completed_without_process") {
        outcome = resolution.outcome;
      } else {
        mutationTime = this.now();
        const processInput: SpawnObservationInput = {
          ...leaseGuard(claim, mutationTime),
          attempt: providerAttemptState.attempt,
          identity,
          process: resolution.process,
        };
        requireFence(await this.repository.recordSpawnObservation(processInput), command.id);
        requireFence(await this.repository.registerProcess(processInput), command.id);
        await this.injectCrash("after_register", context);

        outcome = resolution.state === "completed"
          ? resolution.outcome
          : await this.driver.waitForCompletion(command, identity, resolution.process, signal);
      }
    } else {
      outcome = await this.driver.executeControl(command, identity, signal);
    }
    await this.injectCrash("before_complete", context);

    mutationTime = this.now();
    requireFence(await this.repository.completeCommand({
      ...leaseGuard(claim, mutationTime),
      attempt: providerAttemptState.attempt,
      identity,
      outcome,
      completedAt: iso(mutationTime),
      circuit,
    }), command.id);
    await this.injectCrash("after_complete", context);
    return outcome;
  }

  private async injectCrash(boundary: CrashBoundary, context: WorkerCrashContext): Promise<void> {
    await this.options.crashInjector?.(boundary, context);
  }
}

/** Helper for deterministic crash-injection tests and external conformance suites. */
export function crashAt(boundary: CrashBoundary): WorkerCrashInjector {
  return (current) => {
    if (current === boundary) throw new WorkerProcessCrash(boundary);
  };
}

export function transientFailure(message: string, retryAfterMs?: number): DurableExecutionError {
  return new DurableExecutionError({ failureClass: "transient", message, retryAfterMs });
}
