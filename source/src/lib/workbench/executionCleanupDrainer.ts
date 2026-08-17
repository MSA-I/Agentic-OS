import "server-only";

import {
  cleanupWindowsJobRecoveryArtifactsVerified,
  WindowsJobContainmentError,
  type WindowsJobRecoveryCleanupOptions,
  type WindowsJobRecoveryCleanupResult,
} from "../control-plane/windowsJobProcess";
import type {
  DurableExecutionCleanupIntent,
  DurableExecutionCleanupRepository,
} from "./durableWorker";

const RETRYABLE_FILESYSTEM_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
  "EPERM",
]);

export type ExecutionCleanupCrashBoundary =
  | "after_claim"
  | "after_filesystem_cleanup"
  | "after_ledger_ack";

export class ExecutionCleanupInjectedCrash extends Error {
  readonly boundary: ExecutionCleanupCrashBoundary;

  constructor(boundary: ExecutionCleanupCrashBoundary) {
    super(`Injected execution cleanup crash at ${boundary}.`);
    this.name = "ExecutionCleanupInjectedCrash";
    this.boundary = boundary;
  }
}

export type ExecutionCleanupDrainResult =
  | { status: "idle" }
  | { status: "completed"; executionId: string; result: WindowsJobRecoveryCleanupResult["result"] }
  | { status: "retry_scheduled"; executionId: string; availableAt: string; code: string }
  | { status: "quarantined"; executionId: string; code: string }
  | { status: "lease_lost"; executionId: string };

export interface ExecutionCleanupDrainerOptions {
  workerId: string;
  recoveryRoot: string;
  recoverySecret: string;
  recoverySecrets?: readonly string[];
  leaseDurationMs?: number;
  maxAttempts?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  now?: () => number;
  random?: () => number;
  cleanup?: (options: WindowsJobRecoveryCleanupOptions) => Promise<WindowsJobRecoveryCleanupResult>;
  crashInjector?: (
    boundary: ExecutionCleanupCrashBoundary,
    intent: DurableExecutionCleanupIntent,
  ) => void | Promise<void>;
  onCleanupCommitted?: (intent: DurableExecutionCleanupIntent) => boolean | void;
  cleanupObservationTargets?: () => readonly string[];
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function errorCode(error: unknown): string {
  if (error instanceof WindowsJobContainmentError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code) return code;
  }
  return "execution_cleanup_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Execution cleanup failed without an Error object.";
}

function integrityFailure(error: unknown): boolean {
  return error instanceof WindowsJobContainmentError
    && (error.code === "windows_job_invalid_specification" || error.code === "windows_job_protocol_invalid");
}

function retryableFailure(error: unknown): boolean {
  if (error instanceof WindowsJobContainmentError) {
    return error.code === "windows_job_termination_unverified";
  }
  const code = errorCode(error);
  return RETRYABLE_FILESYSTEM_CODES.has(code) || code === "execution_cleanup_failed";
}

function cleanupOptions(
  intent: DurableExecutionCleanupIntent,
  recoveryRoot: string,
  recoverySecret: string,
): WindowsJobRecoveryCleanupOptions {
  return {
    recoveryRoot,
    recoverySecret,
    expected: {
      runId: intent.runId,
      jobId: intent.jobObjectId,
      journalGeneration: intent.journalGeneration,
      statusSequence: intent.statusSequence,
      previousStatusSequence: intent.previousStatusSequence,
      previousSnapshotDigestSha256: intent.previousSnapshotDigestSha256,
      previousJournalDigestSha256: intent.previousJournalDigestSha256,
      snapshotDigestSha256: intent.snapshotDigestSha256,
      journalDigestSha256: intent.journalDigestSha256,
      authenticatedPayloadDigestSha256: intent.authenticatedPayloadDigestSha256,
      nativeTerminalDigestSha256: intent.nativeTerminalDigestSha256,
      nativeTerminalStatus: intent.nativeTerminalStatus,
      nativeExitCode: intent.nativeExitCode,
      terminationVerified: true,
      rootProcessId: intent.rootProcessId,
      rootProcessStartedAtFileTime: intent.rootProcessStartedAtFileTime,
      jobName: intent.jobName,
      helperProcessId: intent.helperProcessId,
      helperProcessStartedAtFileTime: intent.helperProcessStartedAtFileTime,
    },
  };
}

class CleanupLeaseHeartbeat {
  private readonly repository: DurableExecutionCleanupRepository;
  private readonly intent: DurableExecutionCleanupIntent;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<boolean> | null = null;
  private lost = false;
  private stopped = false;

  constructor(
    repository: DurableExecutionCleanupRepository,
    intent: DurableExecutionCleanupIntent,
    workerId: string,
    leaseDurationMs: number,
    now: () => number,
  ) {
    this.repository = repository;
    this.intent = intent;
    this.workerId = workerId;
    this.leaseDurationMs = leaseDurationMs;
    this.intervalMs = Math.max(1, Math.floor(leaseDurationMs / 3));
    this.now = now;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.inFlight || this.lost || this.stopped) return;
      this.inFlight = this.pulse()
        .catch(() => {
          this.lost = true;
          return false;
        })
        .finally(() => { this.inFlight = null; });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stopAndConfirm(): Promise<boolean> {
    this.clearTimer();
    if (this.inFlight) await this.inFlight;
    if (this.lost) {
      this.stopped = true;
      return false;
    }
    try {
      const retained = await this.pulse();
      this.stopped = true;
      return retained;
    } catch {
      this.lost = true;
      this.stopped = true;
      return false;
    }
  }

  async stop(): Promise<void> {
    this.clearTimer();
    this.stopped = true;
    if (this.inFlight) await this.inFlight;
  }

  private async pulse(): Promise<boolean> {
    const now = this.now();
    const mutation = await this.repository.heartbeatExecutionCleanup({
      executionId: this.intent.executionId,
      workerId: this.workerId,
      fencingToken: this.intent.fencingToken,
      now: iso(now),
      expiresAt: iso(now + this.leaseDurationMs),
    });
    if (mutation.status !== "applied") this.lost = true;
    return !this.lost;
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export class DurableExecutionCleanupDrainer {
  private readonly repository: DurableExecutionCleanupRepository;
  private readonly workerId: string;
  private readonly recoveryRoot: string;
  private readonly recoverySecrets: readonly string[];
  private readonly leaseDurationMs: number;
  private readonly maxAttempts: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly cleanup: (
    options: WindowsJobRecoveryCleanupOptions,
  ) => Promise<WindowsJobRecoveryCleanupResult>;
  private readonly crashInjector: ExecutionCleanupDrainerOptions["crashInjector"];
  private readonly onCleanupCommitted: ExecutionCleanupDrainerOptions["onCleanupCommitted"];
  private readonly cleanupObservationTargets: ExecutionCleanupDrainerOptions["cleanupObservationTargets"];

  constructor(
    repository: DurableExecutionCleanupRepository,
    options: ExecutionCleanupDrainerOptions,
  ) {
    this.repository = repository;
    this.workerId = options.workerId.trim();
    if (!this.workerId) throw new TypeError("cleanup workerId must be non-empty.");
    this.recoveryRoot = options.recoveryRoot;
    this.recoverySecrets = Object.freeze([
      ...new Set([options.recoverySecret, ...(options.recoverySecrets ?? [])]),
    ]);
    if (this.recoverySecrets.some((secret) => secret.length < 32)) {
      throw new TypeError("cleanup recovery secrets must contain at least 32 characters.");
    }
    this.leaseDurationMs = positiveInteger(options.leaseDurationMs ?? 30_000, "cleanup leaseDurationMs");
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 8, "cleanup maxAttempts");
    this.baseRetryMs = positiveInteger(options.baseRetryMs ?? 1_000, "cleanup baseRetryMs");
    this.maxRetryMs = positiveInteger(options.maxRetryMs ?? 5 * 60_000, "cleanup maxRetryMs");
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.cleanup = options.cleanup ?? cleanupWindowsJobRecoveryArtifactsVerified;
    this.crashInjector = options.crashInjector;
    this.onCleanupCommitted = options.onCleanupCommitted;
    this.cleanupObservationTargets = options.cleanupObservationTargets;
  }

  async drainOnce(): Promise<ExecutionCleanupDrainResult> {
    const startedAt = this.now();
    const intent = await this.repository.claimNextExecutionCleanup({
      workerId: this.workerId,
      now: iso(startedAt),
      leaseDurationMs: this.leaseDurationMs,
    });
    if (!intent) return { status: "idle" };
    const heartbeat = new CleanupLeaseHeartbeat(
      this.repository,
      intent,
      this.workerId,
      this.leaseDurationMs,
      this.now,
    );
    heartbeat.start();

    try {
      await this.crashInjector?.("after_claim", intent);
      const result = await this.cleanupWithKeyring(intent);
      await this.crashInjector?.("after_filesystem_cleanup", intent);
      if (!await heartbeat.stopAndConfirm()) {
        return { status: "lease_lost", executionId: intent.executionId };
      }
      const acknowledgedAt = iso(this.now());
      const acknowledged = await this.repository.completeExecutionCleanup({
        executionId: intent.executionId,
        workerId: this.workerId,
        fencingToken: intent.fencingToken,
        now: acknowledgedAt,
        completedAt: acknowledgedAt,
        result: result.result,
      });
      if (acknowledged.status !== "applied" && acknowledged.status !== "already_applied") {
        return { status: "lease_lost", executionId: intent.executionId };
      }
      this.notifyCleanupCommitted(intent);
      await this.crashInjector?.("after_ledger_ack", intent);
      return { status: "completed", executionId: intent.executionId, result: result.result };
    } catch (error) {
      if (error instanceof ExecutionCleanupInjectedCrash) throw error;
      if (!await heartbeat.stopAndConfirm()) {
        return { status: "lease_lost", executionId: intent.executionId };
      }
      const now = this.now();
      const nowIso = iso(now);
      const code = errorCode(error);
      const message = errorMessage(error);
      const quarantine = integrityFailure(error)
        || !retryableFailure(error)
        || intent.attemptCount >= this.maxAttempts;
      if (quarantine) {
        const mutation = await this.repository.quarantineExecutionCleanup({
          executionId: intent.executionId,
          workerId: this.workerId,
          fencingToken: intent.fencingToken,
          now: nowIso,
          quarantinedAt: nowIso,
          error: {
            code: intent.attemptCount >= this.maxAttempts ? "execution_cleanup_attempt_cap" : code,
            message,
          },
        });
        return mutation.status === "applied"
          ? {
              status: "quarantined",
              executionId: intent.executionId,
              code: intent.attemptCount >= this.maxAttempts ? "execution_cleanup_attempt_cap" : code,
            }
          : { status: "lease_lost", executionId: intent.executionId };
      }
      const exponential = Math.min(
        this.maxRetryMs,
        this.baseRetryMs * (2 ** Math.max(0, intent.attemptCount - 1)),
      );
      const jitter = 0.75 + (Math.max(0, Math.min(1, this.random())) * 0.5);
      const availableAt = iso(now + Math.max(1, Math.floor(exponential * jitter)));
      const mutation = await this.repository.retryExecutionCleanup({
        executionId: intent.executionId,
        workerId: this.workerId,
        fencingToken: intent.fencingToken,
        now: nowIso,
        availableAt,
        error: { code, message },
      });
      return mutation.status === "applied"
        ? { status: "retry_scheduled", executionId: intent.executionId, availableAt, code }
        : { status: "lease_lost", executionId: intent.executionId };
    } finally {
      await heartbeat.stop();
    }
  }

  async drainBounded(limit = 16): Promise<ExecutionCleanupDrainResult[]> {
    positiveInteger(limit, "cleanup drain limit");
    await this.observeCompletedCleanups();
    const results: ExecutionCleanupDrainResult[] = [];
    for (let index = 0; index < limit; index += 1) {
      const result = await this.drainOnce();
      results.push(result);
      if (result.status === "idle") break;
    }
    return results;
  }

  private notifyCleanupCommitted(intent: DurableExecutionCleanupIntent): void {
    try {
      this.onCleanupCommitted?.(intent);
    } catch {
      // Durable ACK is authoritative. A later observation retries local cache release.
    }
  }

  private async cleanupWithKeyring(
    intent: DurableExecutionCleanupIntent,
  ): Promise<WindowsJobRecoveryCleanupResult> {
    let lastError: unknown;
    for (const secret of this.recoverySecrets) {
      try {
        return await this.cleanup(cleanupOptions(intent, this.recoveryRoot, secret));
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof WindowsJobContainmentError)
          || (error.code !== "windows_job_invalid_specification" && error.code !== "windows_job_protocol_invalid")
        ) throw error;
      }
    }
    throw lastError ?? new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      "Windows Job cleanup keyring contains no usable key.",
    );
  }

  private async observeCompletedCleanups(): Promise<void> {
    if (!this.onCleanupCommitted || !this.cleanupObservationTargets) return;
    const targets = [...new Set(this.cleanupObservationTargets().map((value) => value.trim()).filter(Boolean))];
    if (targets.length === 0) return;
    for (let offset = 0; offset < targets.length; offset += 100) {
      const completed = await this.repository.findCompletedExecutionCleanupIntents(
        targets.slice(offset, offset + 100),
      );
      for (const intent of completed) this.notifyCleanupCommitted(intent);
    }
  }
}
