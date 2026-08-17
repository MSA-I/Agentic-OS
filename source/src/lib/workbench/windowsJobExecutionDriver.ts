import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { finished as streamFinished } from "node:stream/promises";
import {
  assertExecutableIdentityBindingSync,
  assertProviderExecutionArguments,
  type ExecutableIdentity,
  type GuardedProvider,
} from "../control-plane/executableIdentity";
import {
  prepareWindowsJobRecoveryDescriptor,
  arbitrateWindowsJobRecoveryDescriptor,
  resolveWindowsJobRecoveryDescriptorPath,
  spawnWindowsJobProcess,
  WindowsJobContainmentError,
  type RecoveredWindowsJobProcess,
  type WindowsJobAuthenticatedStatusAcceptor,
  type WindowsJobAuthenticatedStatusEvidence,
  type WindowsJobProcess,
  type WindowsJobProcessIdentity,
  type WindowsJobRecoveryDescriptor,
  type WindowsJobRecoveryArbitrationResult,
  type WindowsJobTerminalResult,
} from "../control-plane/windowsJobProcess";
import {
  assertLaunchDirectoryBindingSync,
  type ApprovedLaunchDirectory,
} from "../control-plane/runtimeContainment";
import { buildProviderChildEnvironment } from "../control-plane/childEnvironment";
import {
  DurableExecutionError,
  durableOutcomeDigestSha256,
  type AuthorizeNewProviderSpawn,
  type DurableCommand,
  type DurableExecutionDriver,
  type DurableExecutionIdentity,
  type DurableExecutionOutcome,
  type DurableExecutionRecoveryRecord,
  type DurableExecutionRecoveryRepository,
  type DurableLaunchAuthorization,
  type DurableExternalStatusHighWater,
  type DurableProcessIdentity,
  type SpawnResolution,
} from "./durableWorker";
import { redactText, StreamingRedactor } from "./redaction";
import type { ExecutionFailure } from "./retryPolicy";

const GUARDED_PROVIDERS = new Set<GuardedProvider>([
  "codex",
  "claude",
  "hermes",
  "openclaw",
  "antigravity",
]);
const OUTPUT_PREVIEW_BYTES = 64 * 1024;

export interface WindowsJobExecutionSpec {
  provider: GuardedProvider;
  executableIdentity: ExecutableIdentity;
  args: readonly string[];
  cwd: ApprovedLaunchDirectory;
  env: NodeJS.ProcessEnv;
  input?: string;
}

/**
 * Wave 3 provider adapters supply this resolver after identity, project,
 * policy, containment, secret and approval gates have accepted the command.
 * Wave 2 deliberately does not interpret untrusted route payloads here.
 */
export type WindowsJobExecutionSpecResolver = (
  command: DurableCommand,
  signal: AbortSignal,
) => Promise<WindowsJobExecutionSpec>;

export interface WindowsJobExecutionDriverOptions {
  resolveExecutionSpec: WindowsJobExecutionSpecResolver;
  recoveryRepository: DurableExecutionRecoveryRepository;
  recoveryRoot: string;
  /** Private controller/helper authentication secret; never inherited by providers. */
  recoverySecret: string;
  /** Retained machine-local secrets accepted only for pre-keyring recovery. */
  recoverySecrets?: readonly string[];
  now?: () => number;
  spawnProcess?: typeof spawnWindowsJobProcess;
  prepareRecoveryDescriptor?: typeof prepareWindowsJobRecoveryDescriptor;
  resolveRecoveryDescriptorPath?: typeof resolveWindowsJobRecoveryDescriptorPath;
  arbitrateRecoveryDescriptor?: typeof arbitrateWindowsJobRecoveryDescriptor;
  pathExists?: (path: string) => boolean;
  /** Synchronous durable sink. A failed sink terminates execution fail-closed. */
  onOutput?: (event: WindowsJobOutputEvent) => void;
  /** Called after both decoded output streams are flushed. Failure is terminal. */
  onOutputEnd?: (event: WindowsJobOutputEndEvent) => void;
  /** Bound after verified native termination; open wrapper streams fail closed. */
  outputDrainTimeoutMs?: number;
  /** Test/evidence hook. Production callers omit it. */
  onLaunchBoundary?: (
    boundary: "after_descriptor_prepared" | "after_launch_authorized",
    descriptor: WindowsJobRecoveryDescriptor,
  ) => void | Promise<void>;
}

export interface WindowsJobOutputEvent {
  runId: string;
  executionId: string;
  channel: "stdout" | "stderr";
  text: string;
}

export interface WindowsJobOutputEndEvent {
  runId: string;
  executionId: string;
}

type RecoverableWindowsJobProcess = WindowsJobProcess | RecoveredWindowsJobProcess;

interface TrackedExecution {
  identity: DurableExecutionIdentity;
  provider: string;
  runGeneration: number;
  payloadHash: string;
  process: RecoverableWindowsJobProcess;
  processIdentity: DurableProcessIdentity;
  output: BoundedProcessOutput;
  terminalOutcome: Promise<DurableExecutionOutcome>;
  completed?: DurableExecutionOutcome;
}

interface ReconcileFlight {
  identity: DurableExecutionIdentity;
  payloadHash: string;
  promise: Promise<SpawnResolution>;
}

interface AbortWaiter {
  promise: Promise<{ kind: "aborted" }>;
  dispose(): void;
}

function guardedProvider(value: string): GuardedProvider {
  if (!GUARDED_PROVIDERS.has(value as GuardedProvider)) {
    throw new DurableExecutionError({
      failureClass: "unsupported",
      message: `Provider ${value || "unknown"} has no guarded Windows Job execution contract.`,
    });
  }
  return value as GuardedProvider;
}

function positiveResource(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DurableExecutionError({
      failureClass: "invalid_request",
      message: `${name} must be a positive safe integer.`,
    });
  }
  return value;
}

function launchedExecutable(identity: ExecutableIdentity): { path: string; sha256: string } {
  const launchPath = identity.launchPath;
  const file = identity.files.find((candidate) =>
    candidate.absolutePath.localeCompare(launchPath, undefined, { sensitivity: "accent" }) === 0);
  if (!file) {
    throw new DurableExecutionError({
      failureClass: "identity",
      message: "Pinned executable identity does not include the launch executable.",
    });
  }
  return { path: launchPath, sha256: file.sha256 };
}

function abortWaiter(signal: AbortSignal): AbortWaiter {
  if (signal.aborted) return { promise: Promise.resolve({ kind: "aborted" }), dispose() {} };
  let listener: (() => void) | undefined;
  const promise = new Promise<{ kind: "aborted" }>((resolve) => {
    listener = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    dispose() {
      if (listener) signal.removeEventListener("abort", listener);
      listener = undefined;
    },
  };
}

function throwAbortReason(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DurableExecutionError({
    failureClass: "cancelled",
    message: "Provider execution was aborted.",
  });
}

function mapTerminalResult(
  result: WindowsJobTerminalResult,
  output: BoundedProcessOutput,
): DurableExecutionOutcome {
  const terminalContract = result as { terminationVerified: boolean; cleanup: string };
  if (!terminalContract.terminationVerified || terminalContract.cleanup === "pending") {
    throw new DurableExecutionError({
      failureClass: "containment",
      message: "Windows Job durable outcome requires verified terminal cleanup.",
    });
  }
  const metadata = {
    ...output.metadata(),
    cleanup: result.cleanup,
    terminationVerified: result.terminationVerified,
  };
  if (result.status === "exited") {
    const failure = output.terminalFailure();
    return result.exitCode === 0
      ? { status: "succeeded", exitCode: 0, metadata }
      : {
          status: "failed",
          exitCode: result.exitCode,
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage,
          metadata,
        };
  }
  if (result.status === "cancelled") {
    return { status: "cancelled", exitCode: null, metadata };
  }
  if (/output exceeded the configured byte limit/iu.test(result.reason)) {
    return {
      status: "failed",
      exitCode: null,
      errorCode: "resource_exhausted",
      errorMessage: redactText(result.reason, 2_000),
      metadata: { ...metadata, outputLimitExceeded: true },
    };
  }
  return {
    status: "blocked",
    exitCode: null,
    errorCode: "windows_job_blocked",
    errorMessage: redactText(result.reason, 2_000),
    metadata,
  };
}

function durableStatusForNativeTerminal(
  result: WindowsJobTerminalResult,
): DurableExecutionOutcome["status"] {
  if (result.status === "exited") return result.exitCode === 0 ? "succeeded" : "failed";
  if (result.status === "cancelled") return "cancelled";
  return /output exceeded the configured byte limit/iu.test(result.reason) ? "failed" : "blocked";
}

function assertTerminalEvidenceMatchesResult(
  evidence: WindowsJobAuthenticatedStatusEvidence,
  result: WindowsJobTerminalResult,
  outcome: DurableExecutionOutcome,
): void {
  const expectedStatus = durableStatusForNativeTerminal(result);
  if (
    !evidence.terminal
    || !evidence.terminationVerified
    || evidence.nativeTerminalDigestSha256 === null
    || evidence.nativeTerminalState !== result.status
    || evidence.nativeTerminalExitCode !== result.exitCode
    || outcome.status !== expectedStatus
  ) {
    throw new DurableExecutionError({
      failureClass: "containment",
      message: "Authenticated native terminal evidence does not match deterministic controller outcome mapping.",
    });
  }
}

function sameAuthenticatedEvidence(
  left: WindowsJobAuthenticatedStatusEvidence,
  right: WindowsJobAuthenticatedStatusEvidence,
): boolean {
  return left.journalGeneration === right.journalGeneration
    && left.sequence === right.sequence
    && left.previousSequence === right.previousSequence
    && left.previousSnapshotDigestSha256 === right.previousSnapshotDigestSha256
    && left.previousJournalDigestSha256 === right.previousJournalDigestSha256
    && left.terminal === right.terminal
    && left.snapshotDigestSha256 === right.snapshotDigestSha256
    && left.journalDigestSha256 === right.journalDigestSha256
    && left.authenticatedPayloadDigestSha256 === right.authenticatedPayloadDigestSha256
    && left.nativeTerminalDigestSha256 === right.nativeTerminalDigestSha256
    && left.nativeTerminalState === right.nativeTerminalState
    && left.nativeTerminalExitCode === right.nativeTerminalExitCode
    && left.terminationVerified === right.terminationVerified;
}

function asDurableSpawnError(error: unknown): DurableExecutionError {
  if (error instanceof DurableExecutionError) return error;
  if (error instanceof WindowsJobContainmentError) {
    const stableIdentityBusy = error.code === "windows_job_handshake_failed"
      && /identity already exists/iu.test(error.message);
    return new DurableExecutionError({
      failureClass: stableIdentityBusy ? "transient" : "containment",
      message: stableIdentityBusy
        ? "Stable Windows Job identity is still active; retry after verified cleanup."
        : error.message,
    }, { cause: error });
  }
  return new DurableExecutionError({
    failureClass: "containment",
    message: error instanceof Error ? error.message : "Windows Job spawn failed.",
  }, { cause: error });
}

function controlTarget(command: DurableCommand): { executionId: string; jobObjectId: string } {
  const payload = command.payload && typeof command.payload === "object" && !Array.isArray(command.payload)
    ? command.payload as Record<string, unknown>
    : {};
  const executionId = typeof payload.targetExecutionId === "string" ? payload.targetExecutionId : "";
  const jobObjectId = typeof payload.targetJobObjectId === "string" ? payload.targetJobObjectId : "";
  if (!executionId || !jobObjectId) {
    throw new DurableExecutionError({
      failureClass: "invalid_request",
      message: "Control command requires targetExecutionId and targetJobObjectId.",
    });
  }
  return { executionId, jobObjectId };
}

class BoundedProcessOutput {
  readonly overflow: Promise<{ kind: "overflow" }>;
  readonly deliveryFailure: Promise<{ kind: "delivery_failure"; error: DurableExecutionError }>;
  readonly finished: Promise<void>;
  readonly limitBytes: number;
  private totalBytes = 0;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private stdoutPreview: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private stderrPreview: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private overflowed = false;
  private outputDeliveryFailed = false;
  private deliveryError: DurableExecutionError | null = null;
  private resolveOverflow!: (value: { kind: "overflow" }) => void;
  private resolveDeliveryFailure!: (
    value: { kind: "delivery_failure"; error: DurableExecutionError },
  ) => void;
  private readonly redactors = {
    stdout: new StreamingRedactor(),
    stderr: new StreamingRedactor(),
  };
  private readonly decoders = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
  };
  private readonly onOutput: ((channel: "stdout" | "stderr", text: string) => void) | undefined;
  private readonly onOutputEnd: (() => void) | undefined;
  private readonly streams: readonly Readable[];

  constructor(
    stdout: NodeJS.ReadableStream,
    stderr: NodeJS.ReadableStream,
    limitBytes: number,
    onOutput?: (channel: "stdout" | "stderr", text: string) => void,
    onOutputEnd?: () => void,
  ) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
      throw new DurableExecutionError({
        failureClass: "invalid_request",
        message: "Output byte limit must be a non-negative safe integer.",
      });
    }
    this.limitBytes = limitBytes;
    this.onOutput = onOutput;
    this.onOutputEnd = onOutputEnd;
    this.overflow = new Promise((resolve) => { this.resolveOverflow = resolve; });
    this.deliveryFailure = new Promise((resolve) => { this.resolveDeliveryFailure = resolve; });
    const stdoutReadable = stdout as Readable;
    const stderrReadable = stderr as Readable;
    this.streams = [stdoutReadable, stderrReadable];
    const stdoutFinished = this.streamFinished(stdoutReadable, "stdout");
    const stderrFinished = this.streamFinished(stderrReadable, "stderr");
    this.attach(stdoutReadable, "stdout");
    this.attach(stderrReadable, "stderr");
    this.finished = Promise.all([
      stdoutFinished.then(() => this.flush("stdout")),
      stderrFinished.then(() => this.flush("stderr")),
    ]).then(() => {
      try {
        this.onOutputEnd?.();
      } catch (error) {
        this.recordDeliveryFailure(error);
      }
    });
  }

  metadata(): Record<string, unknown> {
    return {
      outputBytes: this.totalBytes,
      outputLimitBytes: this.limitBytes,
      outputLimitExceeded: this.overflowed,
      outputDeliveryFailed: this.outputDeliveryFailed,
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes,
      stdoutPreview: redactText(this.stdoutPreview.toString("utf8"), OUTPUT_PREVIEW_BYTES),
      stderrPreview: redactText(this.stderrPreview.toString("utf8"), OUTPUT_PREVIEW_BYTES),
    };
  }

  terminalFailure(): { errorCode: string; errorMessage: string } {
    const diagnostic = redactText(
      `${this.stderrPreview.toString("utf8")}\n${this.stdoutPreview.toString("utf8")}`,
      OUTPUT_PREVIEW_BYTES,
    );
    if (/\b(?:quota|usage limit|weekly limit|credit balance|billing limit)\b/iu.test(diagnostic)) {
      return {
        errorCode: "provider_quota",
        errorMessage: "The provider quota or usage allowance is exhausted.",
      };
    }
    if (/\b(?:unauthorized|authentication|login required|not logged in|invalid api key|token expired|oauth)\b/iu.test(diagnostic)) {
      return {
        errorCode: "provider_auth",
        errorMessage: "The provider rejected the current authentication.",
      };
    }
    if (/\b(?:rate limit|too many requests|http 429|status 429)\b/iu.test(diagnostic)) {
      return {
        errorCode: "provider_rate_limit",
        errorMessage: "The provider rate limit was reached.",
      };
    }
    if (/\b(?:timed out|timeout)\b/iu.test(diagnostic)) {
      return {
        errorCode: "provider_timeout",
        errorMessage: "The provider timed out before completing the run.",
      };
    }
    return {
      errorCode: "provider_exit_nonzero",
      errorMessage: "The provider process exited without completing successfully.",
    };
  }

  assertDeliverySucceeded(): void {
    if (this.deliveryError) throw this.deliveryError;
  }

  async settleAfterTerminal(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const outcome = await Promise.race([
      this.finished.then(() => "finished" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === "finished") return;
    this.recordDeliveryFailure(new DurableExecutionError({
      failureClass: "permanent",
      message: "Provider output streams did not close after verified process termination.",
    }));
    for (const stream of this.streams) stream.destroy();
  }

  private attach(stream: Readable, channel: "stdout" | "stderr"): void {
    stream.on("data", (raw: Buffer<ArrayBufferLike> | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
      this.totalBytes += chunk.byteLength;
      if (channel === "stdout") {
        this.stdoutBytes += chunk.byteLength;
        this.stdoutPreview = this.appendPreview(this.stdoutPreview, chunk);
      } else {
        this.stderrBytes += chunk.byteLength;
        this.stderrPreview = this.appendPreview(this.stderrPreview, chunk);
      }
      if (!this.overflowed && this.totalBytes > this.limitBytes) {
        this.overflowed = true;
        this.resolveOverflow({ kind: "overflow" });
      }
      this.emit(
        channel,
        this.redactors[channel].push(this.decoders[channel].decode(chunk, { stream: true })),
      );
    });
  }

  private flush(channel: "stdout" | "stderr"): void {
    const decoderTail = this.decoders[channel].decode();
    this.emit(
      channel,
      `${decoderTail ? this.redactors[channel].push(decoderTail) : ""}${this.redactors[channel].flush()}`,
    );
  }

  private emit(channel: "stdout" | "stderr", text: string): void {
    if (!text || !this.onOutput || this.outputDeliveryFailed) return;
    try {
      for (let offset = 0; offset < text.length; offset += 32 * 1024) {
        this.onOutput(channel, text.slice(offset, offset + (32 * 1024)));
      }
    } catch (error) {
      this.recordDeliveryFailure(error);
    }
  }

  private recordDeliveryFailure(error: unknown): void {
    if (this.deliveryError) return;
    this.outputDeliveryFailed = true;
    this.deliveryError = error instanceof DurableExecutionError
      ? error
      : new DurableExecutionError(
          {
            failureClass: "permanent",
            message: "Provider output could not be persisted or validated safely.",
          },
          { cause: error },
        );
    this.resolveDeliveryFailure({ kind: "delivery_failure", error: this.deliveryError });
  }

  private async streamFinished(stream: Readable, channel: "stdout" | "stderr"): Promise<void> {
    try {
      await streamFinished(stream, { cleanup: true });
    } catch (error) {
      this.recordDeliveryFailure(new DurableExecutionError(
        {
          failureClass: "permanent",
          message: `Provider ${channel} stream closed before its output was durably delivered.`,
        },
        { cause: error },
      ));
    }
  }

  private appendPreview(
    current: Buffer<ArrayBufferLike>,
    chunk: Buffer<ArrayBufferLike>,
  ): Buffer<ArrayBufferLike> {
    if (current.byteLength >= OUTPUT_PREVIEW_BYTES) return current;
    return Buffer.concat([current, chunk.subarray(0, OUTPUT_PREVIEW_BYTES - current.byteLength)]);
  }
}

/** Concrete fail-closed Windows execution driver for DurableWorkbenchWorker. */
export class WindowsJobExecutionDriver implements DurableExecutionDriver {
  private readonly resolveExecutionSpec: WindowsJobExecutionSpecResolver;
  private readonly recoveryRepository: DurableExecutionRecoveryRepository;
  private readonly recoveryRoot: string;
  private readonly recoverySecret: string;
  private readonly recoverySecrets: readonly string[];
  private readonly now: () => number;
  private readonly spawnProcess: typeof spawnWindowsJobProcess;
  private readonly prepareRecoveryDescriptor: typeof prepareWindowsJobRecoveryDescriptor;
  private readonly resolveRecoveryDescriptorPath: typeof resolveWindowsJobRecoveryDescriptorPath;
  private readonly arbitrateRecoveryDescriptor: typeof arbitrateWindowsJobRecoveryDescriptor;
  private readonly pathExists: (path: string) => boolean;
  private readonly onOutput: ((event: WindowsJobOutputEvent) => void) | undefined;
  private readonly onOutputEnd: ((event: WindowsJobOutputEndEvent) => void) | undefined;
  private readonly outputDrainTimeoutMs: number;
  private readonly onLaunchBoundary: WindowsJobExecutionDriverOptions["onLaunchBoundary"];
  /** Object-identity capability granted only to a descriptor prepared by this live invocation. */
  private readonly freshlyPreparedDescriptors = new WeakSet<WindowsJobRecoveryDescriptor>();
  private readonly executions = new Map<string, TrackedExecution>();
  private readonly jobOwners = new Map<string, string>();
  private readonly reconcileFlights = new Map<string, ReconcileFlight>();
  private readonly authenticatedHighWater = new Map<string, WindowsJobAuthenticatedStatusEvidence>();

  constructor(options: WindowsJobExecutionDriverOptions) {
    this.resolveExecutionSpec = options.resolveExecutionSpec;
    this.recoveryRepository = options.recoveryRepository;
    this.recoveryRoot = options.recoveryRoot;
    this.recoverySecret = options.recoverySecret;
    this.recoverySecrets = Object.freeze([
      ...new Set([options.recoverySecret, ...(options.recoverySecrets ?? [])]),
    ]);
    if (this.recoverySecrets.some((secret) => secret.length < 32)) {
      throw new TypeError("Windows Job recovery secrets must contain at least 32 characters.");
    }
    this.now = options.now ?? Date.now;
    this.spawnProcess = options.spawnProcess ?? spawnWindowsJobProcess;
    this.prepareRecoveryDescriptor = options.prepareRecoveryDescriptor ?? prepareWindowsJobRecoveryDescriptor;
    this.resolveRecoveryDescriptorPath = options.resolveRecoveryDescriptorPath
      ?? resolveWindowsJobRecoveryDescriptorPath;
    this.arbitrateRecoveryDescriptor = options.arbitrateRecoveryDescriptor
      ?? arbitrateWindowsJobRecoveryDescriptor;
    this.pathExists = options.pathExists ?? existsSync;
    this.onOutput = options.onOutput;
    this.onOutputEnd = options.onOutputEnd;
    this.outputDrainTimeoutMs = options.outputDrainTimeoutMs ?? 5_000;
    this.onLaunchBoundary = options.onLaunchBoundary;
    if (!Number.isSafeInteger(this.outputDrainTimeoutMs) || this.outputDrainTimeoutMs <= 0) {
      throw new TypeError("outputDrainTimeoutMs must be a positive safe integer.");
    }
  }

  async reconcileOrSpawn(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
    signal: AbortSignal,
    authorizeNewSpawn: AuthorizeNewProviderSpawn,
  ): Promise<SpawnResolution> {
    this.assertCommandIdentity(command, identity);
    if (signal.aborted) throwAbortReason(signal);
    const activeFlight = this.reconcileFlights.get(identity.jobObjectId);
    if (activeFlight) {
      if (
        activeFlight.identity.executionId !== identity.executionId
        || activeFlight.identity.commandId !== identity.commandId
        || activeFlight.identity.runId !== identity.runId
        || activeFlight.payloadHash !== command.payloadHash
      ) {
        throw new DurableExecutionError({
          failureClass: "identity",
          message: "Windows Job identity is already reconciling a different execution.",
        });
      }
      return activeFlight.promise;
    }

    const promise = this.resolveAndSpawn(command, identity, signal, authorizeNewSpawn);
    const flight = { identity: { ...identity }, payloadHash: command.payloadHash, promise };
    this.reconcileFlights.set(identity.jobObjectId, flight);
    try {
      return await promise;
    } finally {
      if (this.reconcileFlights.get(identity.jobObjectId) === flight) {
        this.reconcileFlights.delete(identity.jobObjectId);
      }
    }
  }

  private async resolveAndSpawn(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
    signal: AbortSignal,
    authorizeNewSpawn: AuthorizeNewProviderSpawn,
  ): Promise<SpawnResolution> {
    const recovery = await this.loadRecovery(command, identity);

    const existing = this.executions.get(identity.executionId);
    if (existing) {
      this.assertTrackedIdentity(existing, command, identity);
      return existing.completed
        ? { state: "completed", process: existing.processIdentity, outcome: existing.completed }
        : { state: "running", process: existing.processIdentity };
    }

    if (recovery.terminal) {
      if (!recovery.process) {
        if (recovery.terminal.source !== "windows_job_controller") {
          throw this.recoveryFailure(
            "Verified durable terminal checkpoint is missing its immutable process identity.",
          );
        }
        return { state: "completed_without_process", outcome: recovery.terminal.outcome };
      }
      return {
        state: "completed",
        process: recovery.process,
        outcome: recovery.terminal.outcome,
      };
    }

    this.seedAuthenticatedHighWater(identity, recovery.externalStatusHighWater);
    const acceptAuthenticatedStatus = this.authenticatedStatusAcceptor(command, identity);

    const owner = this.jobOwners.get(identity.jobObjectId);
    if (owner && owner !== identity.executionId) {
      throw new DurableExecutionError({
        failureClass: "identity",
        message: "Windows Job identity became bound to a different execution during reconciliation.",
      });
    }


    const descriptorPath = await this.resolveDescriptorPath(identity);
    let descriptor: WindowsJobRecoveryDescriptor;
    if (this.pathExists(descriptorPath)) {
      descriptor = await this.prepareDescriptor(command, identity);
      this.assertDescriptorAssociation(descriptor, descriptorPath, command, identity);
      this.assertDescriptorLaunchReceipt(descriptor, recovery.launchAuthorization);
      let arbitration: WindowsJobRecoveryArbitrationResult;
      try {
        arbitration = await this.arbitrateWithKeyring(
          descriptorPath,
          acceptAuthenticatedStatus,
          recovery.externalStatusHighWater?.sequence ?? 0,
        );
      } catch (error) {
        throw this.recoveryFailure(
          "Windows Job descriptor claim arbitration failed; duplicate spawn denied.",
          error,
        );
      }
      if (arbitration.state === "controller_revoked") {
        if (recovery.process) {
          throw this.recoveryFailure(
            "Controller-revoked descriptor conflicts with durable process evidence; cleanup remains fail-closed.",
          );
        }
        if (recovery.launchAuthorization) {
          await this.verifyLaunchAuthorization(
            authorizeNewSpawn,
            descriptor,
            recovery.launchAuthorization,
          );
        }
        return this.completeControllerRevocation(command, identity, arbitration.process);
      }
      if (!recovery.launchAuthorization) {
        await arbitration.process.cancel().catch(() => undefined);
        await arbitration.process.cleanupVerified().catch(() => undefined);
        throw this.recoveryFailure(
          "Helper claimed a descriptor without a matching durable launch authorization receipt.",
        );
      }
      await this.verifyLaunchAuthorization(authorizeNewSpawn, descriptor, recovery.launchAuthorization);
      const recovered = arbitration.process;
      await this.acceptProcessStatus(recovered, acceptAuthenticatedStatus, false);
      const spec = await this.resolveVerifiedExecutionSpec(command, signal);
      const processIdentity = this.recoveredProcessIdentity(
        recovered,
        descriptor,
        recovery.process,
        spec.executableIdentity,
        identity,
      );
      const tracked = this.trackExecution(command, identity, recovered, processIdentity);
      if (
        recovered.status
        && ["exited", "cancelled", "blocked"].includes(recovered.status.status)
        && recovered.status.terminationVerified
      ) {
        const outcome = await tracked.terminalOutcome;
        return { state: "completed", process: tracked.processIdentity, outcome };
      }
      return tracked.completed
        ? { state: "completed", process: tracked.processIdentity, outcome: tracked.completed }
        : { state: "running", process: tracked.processIdentity };
    } else {
      if (recovery.launchAuthorization) {
        throw this.recoveryFailure(
          "Durable launch authorization has no matching Windows Job descriptor; duplicate spawn denied.",
        );
      }
      if (command.checkpoint !== "dequeued" && command.checkpoint !== "spawn_intent") {
        throw this.recoveryFailure(
          "Durable spawn intent has no valid Windows Job recovery descriptor; duplicate spawn denied.",
        );
      }
      descriptor = await this.prepareDescriptor(command, identity, {
        authorizationId: randomUUID(),
        launchGeneration: 1,
        launchAttempt: command.attempt,
      });
      this.assertDescriptorAssociation(descriptor, descriptorPath, command, identity);
      if (descriptor.supervisorProcessId !== globalThis.process.pid) {
        throw this.recoveryFailure(
          "New Windows Job descriptor was prepared by a different process; concurrent spawn denied.",
        );
      }
      this.freshlyPreparedDescriptors.add(descriptor);
      await this.onLaunchBoundary?.("after_descriptor_prepared", descriptor);
    }

    const spec = await this.resolveVerifiedExecutionSpec(command, signal);
    await this.assertRecoveryAssociationStillCurrent(command, identity);
    if (!this.freshlyPreparedDescriptors.delete(descriptor)) {
      throw this.recoveryFailure(
        "Windows Job descriptor lacks this invocation's non-persistent spawn capability.",
      );
    }

    const safeEnvironment = buildProviderChildEnvironment(spec.provider, {}, spec.env);
    const launched = launchedExecutable(spec.executableIdentity);
    const spawnArguments = [...spec.executableIdentity.launchArgsPrefix, ...spec.args];
    const spawnOptions = {
      runId: identity.runId,
      jobId: identity.jobObjectId,
      cwd: spec.cwd.absolutePath,
      expectedWorkingDirectory: spec.cwd,
      env: safeEnvironment,
      input: spec.input,
      expectedExecutableFiles: spec.executableIdentity.files.map((file) => ({
        role: file.role,
        absolutePath: file.absolutePath,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      })),
      limits: {
        activeProcessLimit: positiveResource(command.resources.processCount, "processCount"),
        jobMemoryLimitBytes: positiveResource(command.resources.residentMemoryBytes, "residentMemoryBytes"),
        cpuTimeLimitMs: positiveResource(command.resources.cpuTimeMs, "cpuTimeMs"),
        outputLimitBytes: command.resources.outputBytes,
      },
      recoveryDescriptor: descriptor,
      recoverySecret: this.recoverySecret,
      acceptAuthenticatedStatus,
    } as const;
    let process: WindowsJobProcess;
    try {
      // The durable provider-attempt CAS is intentionally the final awaited
      // boundary after recovery proved no process/outcome exists.
      const authorization = await authorizeNewSpawn(
        this.descriptorLaunchAuthorizationInput(descriptor, identity),
      );
      this.assertLaunchAuthorizationMatchesDescriptor(authorization, descriptor, identity);
      await this.onLaunchBoundary?.("after_launch_authorized", descriptor);
      process = await this.spawnProcess(
        launched.path,
        spawnArguments,
        spawnOptions,
      );
    } catch (error) {
      throw asDurableSpawnError(error);
    }
    await this.acceptProcessStatus(process, acceptAuthenticatedStatus, false);

    const processIdentity: DurableProcessIdentity = {
      pid: process.identity.rootProcessId,
      jobObjectId: identity.jobObjectId,
      jobName: process.identity.jobName,
      rootProcessStartedAtFileTime: process.identity.rootProcessStartedAtFileTime,
      helperPid: process.identity.helperProcessId,
      helperProcessStartedAtFileTime: process.identity.helperProcessStartedAtFileTime,
      executablePath: launched.path,
      executableHash: launched.sha256,
      startedAt: new Date(this.now()).toISOString(),
    };
    this.trackExecution(command, identity, process, processIdentity);
    return { state: "running", process: processIdentity };
  }

  private trackExecution(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
    process: RecoverableWindowsJobProcess,
    processIdentity: DurableProcessIdentity,
  ): TrackedExecution {
    const output = new BoundedProcessOutput(
      process.stdout,
      process.stderr,
      command.resources.outputBytes,
      this.onOutput
        ? (channel, text) => this.onOutput?.({
            runId: identity.runId,
            executionId: identity.executionId,
            channel,
            text,
          })
        : undefined,
      this.onOutputEnd
        ? () => this.onOutputEnd?.({
            runId: identity.runId,
            executionId: identity.executionId,
          })
        : undefined,
    );
    const acceptAuthenticatedStatus = this.authenticatedStatusAcceptor(command, identity);
    const tracked: TrackedExecution = {
      identity: { ...identity },
      provider: command.provider,
      runGeneration: command.runGeneration,
      payloadHash: command.payloadHash,
      process,
      processIdentity,
      output,
      terminalOutcome: Promise.resolve({ status: "blocked", exitCode: null } as DurableExecutionOutcome),
    };
    tracked.terminalOutcome = process.wait()
      .then(async (result) => {
        const terminalEvidence = await this.acceptProcessStatus(process, acceptAuthenticatedStatus, true);
        await output.settleAfterTerminal(this.outputDrainTimeoutMs);
        const outcome = mapTerminalResult(result, output);
        assertTerminalEvidenceMatchesResult(terminalEvidence, result, outcome);
        const observedAt = terminalEvidence.observedAt;
        const nativeTerminalStatus = durableStatusForNativeTerminal(result);
        const mutation = await this.recoveryRepository.recordVerifiedTerminalCheckpoint({
          ...identity,
          statusEvidence: {
            ...identity,
            journalGeneration: terminalEvidence.journalGeneration,
            sequence: terminalEvidence.sequence,
            previousSequence: terminalEvidence.previousSequence,
            previousSnapshotDigestSha256: terminalEvidence.previousSnapshotDigestSha256,
            previousJournalDigestSha256: terminalEvidence.previousJournalDigestSha256,
            terminal: true,
            snapshotDigestSha256: terminalEvidence.snapshotDigestSha256,
            journalDigestSha256: terminalEvidence.journalDigestSha256,
            authenticatedPayloadDigestSha256: terminalEvidence.authenticatedPayloadDigestSha256,
            nativeTerminalDigestSha256: terminalEvidence.nativeTerminalDigestSha256!,
            nativeTerminalStatus,
            nativeExitCode: result.exitCode,
            terminationVerified: true,
            observedAt: terminalEvidence.observedAt,
          },
          outcome,
          controllerOutcomeDigestSha256: durableOutcomeDigestSha256(outcome),
          observedAt,
          terminationVerified: true,
          source: "windows_job_helper",
        });
        if (mutation.status === "missing" || mutation.status === "conflict") {
          throw this.recoveryFailure(
            `Verified Windows Job terminal checkpoint was rejected as ${mutation.status}.`,
          );
        }
        return outcome;
      })
      .then((outcome) => {
        tracked.completed = outcome;
        return outcome;
      });
    // The process can terminate between registration and waitForCompletion().
    // Attach an immediate rejection observer so a fail-closed stream parser
    // cannot surface as an unhandled rejection during that hand-off window.
    void tracked.terminalOutcome.catch(() => undefined);
    this.executions.set(identity.executionId, tracked);
    this.jobOwners.set(identity.jobObjectId, identity.executionId);
    return tracked;
  }

  async waitForCompletion(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
    process: DurableProcessIdentity,
    signal: AbortSignal,
  ): Promise<DurableExecutionOutcome> {
    const tracked = this.requireTracked(command, identity);
    if (
      !this.sameProcessIdentity(process, tracked.processIdentity)
    ) {
      throw new DurableExecutionError({
        failureClass: "identity",
        message: "Durable process identity does not match the tracked Windows Job execution.",
      });
    }
    const aborted = abortWaiter(signal);
    try {
      const result = await Promise.race([
        tracked.terminalOutcome.then((outcome) => ({ kind: "terminal" as const, outcome })),
        tracked.output.overflow,
        tracked.output.deliveryFailure,
        aborted.promise,
      ]);
      if (result.kind === "terminal") {
        tracked.output.assertDeliverySucceeded();
        return result.outcome;
      }
      const terminated = await this.cancelAndVerify(tracked);
      if (!terminated) {
        throw new DurableExecutionError({
          failureClass: "containment",
          message: "Windows Job process tree could not be verified as terminated.",
        });
      }
      if (result.kind === "overflow") {
        throw new DurableExecutionError({
          failureClass: "resource_exhausted",
          message: `Provider output exceeded ${tracked.output.limitBytes} bytes and was terminated.`,
        });
      }
      if (result.kind === "delivery_failure") throw result.error;
      throwAbortReason(signal);
    } finally {
      aborted.dispose();
    }
  }

  async executeControl(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
    signal: AbortSignal,
  ): Promise<DurableExecutionOutcome> {
    this.assertCommandIdentity(command, identity);
    if (signal.aborted) throwAbortReason(signal);
    if (command.operation !== "cancel") {
      throw new DurableExecutionError({
        failureClass: "unsupported",
        message: `${command.operation} requires a provider-specific control adapter.`,
      });
    }
    const resolved = await this.resolveControlTarget(command, signal);
    if (resolved.completed) return this.asCancelOutcome(resolved.completed);
    const tracked = resolved.tracked;
    if (tracked.completed) {
      return this.asCancelOutcome(tracked.completed);
    }
    const acceptAuthenticatedStatus = this.authenticatedStatusAcceptorForIdentity(tracked.identity);
    await this.acceptProcessStatus(tracked.process, acceptAuthenticatedStatus, false);
    const result = await tracked.process.cancel();
    await this.acceptProcessStatus(tracked.process, acceptAuthenticatedStatus, true);
    if (!result.terminationVerified) {
      throw new DurableExecutionError({
        failureClass: "containment",
        message: "Cancel did not prove ACTIVE_PROCESS_ZERO.",
      });
    }
    const terminal = await tracked.terminalOutcome;
    return this.asCancelOutcome(terminal);
  }

  releaseCompletedExecution(executionId: string, jobObjectId: string): boolean {
    const tracked = this.executions.get(executionId);
    if (tracked && !tracked.completed) return false;
    if (tracked) this.executions.delete(executionId);
    if (this.jobOwners.get(jobObjectId) === executionId) this.jobOwners.delete(jobObjectId);
    this.authenticatedHighWater.delete(executionId);
    return true;
  }

  trackedExecutionIds(): readonly string[] {
    return [...this.executions.keys()];
  }

  async abortAndVerify(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
    _reason: ExecutionFailure,
  ): Promise<boolean> {
    if (command.operation === "cancel") {
      try {
        this.assertCommandIdentity(command, identity);
        const resolved = await this.resolveControlTarget(command, new AbortController().signal);
        if (resolved.completed) return true;
        return this.cancelAndVerify(resolved.tracked);
      } catch {
        return false;
      }
    }
    const tracked = this.executions.get(identity.executionId);
    if (!tracked) return false;
    this.assertTrackedIdentity(tracked, command, identity);
    return this.cancelAndVerify(tracked);
  }

  private async cancelAndVerify(tracked: TrackedExecution): Promise<boolean> {
    try {
      const acceptAuthenticatedStatus = this.authenticatedStatusAcceptorForIdentity(tracked.identity);
      await this.acceptProcessStatus(tracked.process, acceptAuthenticatedStatus, false);
      const result = await tracked.process.cancel();
      await this.acceptProcessStatus(tracked.process, acceptAuthenticatedStatus, true);
      if (!result.terminationVerified) return false;
      await tracked.terminalOutcome;
      return true;
    } catch {
      return false;
    }
  }

  private async resolveControlTarget(
    command: DurableCommand,
    signal: AbortSignal,
  ): Promise<{ tracked: TrackedExecution; completed: null } | { tracked: null; completed: DurableExecutionOutcome }> {
    const target = controlTarget(command);
    let tracked = this.executions.get(target.executionId);
    if (!tracked) {
      const targetCommand = await this.recoveryRepository.loadExecutionCommand(target.executionId);
      if (!targetCommand) {
        throw new DurableExecutionError({
          failureClass: "transient",
          message: "Target execution command is not yet durably available for control recovery.",
          retryAfterMs: 1_000,
        });
      }
      if (
        (targetCommand.operation !== "start" && targetCommand.operation !== "resume")
        || targetCommand.runId !== command.runId
        || targetCommand.provider !== command.provider
        || targetCommand.runGeneration !== command.runGeneration
      ) {
        throw new DurableExecutionError({
          failureClass: "identity",
          message: "Control target does not match the cancel command run and provider identity.",
        });
      }
      const targetIdentity: DurableExecutionIdentity = {
        executionId: target.executionId,
        commandId: targetCommand.id,
        runId: targetCommand.runId,
        jobObjectId: target.jobObjectId,
      };
      const targetRecovery = await this.loadRecovery(targetCommand, targetIdentity);
      if (targetRecovery.terminal) {
        if (!targetRecovery.process) {
          if (targetRecovery.terminal.source !== "windows_job_controller") {
            throw this.recoveryFailure(
              "Verified durable terminal checkpoint is missing its immutable process identity.",
            );
          }
          return {
            tracked: null,
            completed: targetRecovery.terminal.outcome,
          };
        }
        return {
          tracked: null,
          completed: targetRecovery.terminal.outcome,
        };
      }
      if (targetRecovery.checkpoint === "dequeued") {
        throw new DurableExecutionError({
          failureClass: "transient",
          message: "Target execution has not reached durable spawn intent; control recovery will retry.",
          retryAfterMs: 1_000,
        });
      }
      if (
        targetRecovery.checkpoint !== "spawn_intent"
        && targetRecovery.checkpoint !== "spawned"
        && targetRecovery.checkpoint !== "registered"
      ) {
        throw this.recoveryFailure(
          "Target execution recovery checkpoint is not eligible for native recovery.",
        );
      }
      const resolution = await this.reconcileOrSpawn(
        targetCommand,
        targetIdentity,
        signal,
        async () => {
          if (targetRecovery.launchAuthorization) {
            return targetRecovery.launchAuthorization;
          }
          throw new DurableExecutionError({
            failureClass: "transient",
            message: "Cancel recovery cannot authorize a replacement provider spawn.",
            retryAfterMs: 1_000,
          });
        },
      );
      if (resolution.state === "completed" || resolution.state === "completed_without_process") {
        return { tracked: null, completed: resolution.outcome };
      }
      tracked = this.executions.get(target.executionId);
    }
    if (
      !tracked
      || tracked.identity.jobObjectId !== target.jobObjectId
      || tracked.identity.runId !== command.runId
      || tracked.provider !== command.provider
      || tracked.runGeneration !== command.runGeneration
    ) {
      throw new DurableExecutionError({
        failureClass: "identity",
        message: "Recovered control target does not match the cancel command identity.",
      });
    }
    return { tracked, completed: null };
  }

  private asCancelOutcome(outcome: DurableExecutionOutcome): DurableExecutionOutcome {
    return {
      ...outcome,
      metadata: {
        ...(outcome.metadata ?? {}),
        cancelRequested: true,
        cancelledBeforeCompletion: outcome.status === "cancelled",
        terminationVerified: true,
      },
    };
  }

  private requireTracked(command: DurableCommand, identity: DurableExecutionIdentity): TrackedExecution {
    const tracked = this.executions.get(identity.executionId);
    if (!tracked) {
      throw new DurableExecutionError({
        failureClass: "identity",
        message: "Durable execution is not tracked by this Windows Job driver.",
      });
    }
    this.assertTrackedIdentity(tracked, command, identity);
    return tracked;
  }

  private assertCommandIdentity(command: DurableCommand, identity: DurableExecutionIdentity): void {
    if (
      identity.executionId !== command.executionId
      || identity.commandId !== command.id
      || identity.runId !== command.runId
    ) {
      throw new DurableExecutionError({
        failureClass: "identity",
        message: "Durable execution identity does not match the claimed command.",
      });
    }
  }

  private assertTrackedIdentity(
    tracked: TrackedExecution,
    command: DurableCommand,
    identity: DurableExecutionIdentity,
  ): void {
    this.assertCommandIdentity(command, identity);
    if (
      tracked.payloadHash !== command.payloadHash
      || tracked.identity.commandId !== identity.commandId
      || tracked.identity.runId !== identity.runId
      || tracked.identity.jobObjectId !== identity.jobObjectId
    ) {
      throw new DurableExecutionError({
        failureClass: "identity",
        message: "Redelivered command does not match the tracked durable execution.",
      });
    }
  }

  private authenticatedStatusAcceptor(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
  ): (evidence: WindowsJobAuthenticatedStatusEvidence) => Promise<void> {
    this.assertCommandIdentity(command, identity);
    return this.authenticatedStatusAcceptorForIdentity(identity);
  }

  private authenticatedStatusAcceptorForIdentity(
    identity: DurableExecutionIdentity,
  ): (evidence: WindowsJobAuthenticatedStatusEvidence) => Promise<void> {
    return async (evidence) => {
      const current = this.authenticatedHighWater.get(identity.executionId);
      if (current) {
        if (evidence.journalGeneration !== current.journalGeneration) {
          throw this.recoveryFailure("Authenticated Windows Job status changed journal generation.");
        }
        if (evidence.sequence < current.sequence) return;
        if (evidence.sequence === current.sequence) {
          if (!sameAuthenticatedEvidence(evidence, current)) {
            throw this.recoveryFailure("Authenticated Windows Job status conflicts with durable high-water evidence.");
          }
          return;
        }
        if (
          evidence.sequence !== current.sequence + 1
          || evidence.previousSequence !== current.sequence
          || evidence.previousSnapshotDigestSha256 !== current.snapshotDigestSha256
          || evidence.previousJournalDigestSha256 !== current.journalDigestSha256
        ) {
          throw this.recoveryFailure("Authenticated Windows Job status predecessor does not match durable high-water evidence.");
        }
      }
      // Terminal evidence is accepted only together with the redacted
      // controller outcome and immutable checkpoint in one repository txn.
      if (evidence.terminal) return;
      let mutation: Awaited<ReturnType<DurableExecutionRecoveryRepository["acceptExternalStatusHighWater"]>>;
      try {
        mutation = await this.recoveryRepository.acceptExternalStatusHighWater({
          ...identity,
          journalGeneration: evidence.journalGeneration,
          sequence: evidence.sequence,
          previousSequence: evidence.previousSequence,
          previousSnapshotDigestSha256: evidence.previousSnapshotDigestSha256,
          previousJournalDigestSha256: evidence.previousJournalDigestSha256,
          terminal: evidence.terminal,
          snapshotDigestSha256: evidence.snapshotDigestSha256,
          journalDigestSha256: evidence.journalDigestSha256,
          authenticatedPayloadDigestSha256: evidence.authenticatedPayloadDigestSha256,
          nativeTerminalDigestSha256: null,
          nativeTerminalStatus: null,
          nativeExitCode: null,
          terminationVerified: evidence.terminationVerified,
          observedAt: evidence.observedAt,
        });
      } catch (error) {
        throw this.recoveryFailure("Authenticated Windows Job status high-water could not be persisted.", error);
      }
      if (mutation.status === "missing" || mutation.status === "conflict") {
        throw this.recoveryFailure(
          `Authenticated Windows Job status high-water was rejected as ${mutation.status}.`,
        );
      }
      this.authenticatedHighWater.set(identity.executionId, Object.freeze({ ...evidence }));
    };
  }

  private seedAuthenticatedHighWater(
    identity: DurableExecutionIdentity,
    highWater: DurableExternalStatusHighWater | null,
  ): void {
    if (!highWater) return;
    if (highWater.chainVersion !== 2) {
      throw this.recoveryFailure("Legacy Windows Job status high-water cannot authorize native recovery.");
    }
    if (highWater.terminal) {
      throw this.recoveryFailure("Terminal Windows Job high-water is missing its immutable terminal checkpoint.");
    }
    const evidence: WindowsJobAuthenticatedStatusEvidence = Object.freeze({
      journalGeneration: highWater.journalGeneration,
      sequence: highWater.sequence,
      previousSequence: highWater.previousSequence,
      previousSnapshotDigestSha256: highWater.previousSnapshotDigestSha256,
      previousJournalDigestSha256: highWater.previousJournalDigestSha256,
      terminal: false,
      snapshotDigestSha256: highWater.snapshotDigestSha256,
      journalDigestSha256: highWater.journalDigestSha256,
      authenticatedPayloadDigestSha256: highWater.authenticatedPayloadDigestSha256,
      nativeTerminalDigestSha256: null,
      nativeTerminalState: null,
      nativeTerminalExitCode: null,
      terminationVerified: highWater.terminationVerified,
      observedAt: highWater.observedAt,
    });
    const current = this.authenticatedHighWater.get(identity.executionId);
    if (current && !sameAuthenticatedEvidence(current, evidence)) {
      throw this.recoveryFailure("Durable Windows Job high-water changed during live reconciliation.");
    }
    this.authenticatedHighWater.set(identity.executionId, evidence);
  }

  private async acceptProcessStatus(
    process: RecoverableWindowsJobProcess,
    acceptor: (evidence: WindowsJobAuthenticatedStatusEvidence) => Promise<void>,
    requireTerminal: boolean,
  ): Promise<WindowsJobAuthenticatedStatusEvidence> {
    const evidence = await process.authenticatedStatusEvidence();
    await acceptor(evidence);
    if (requireTerminal && !evidence.terminal) {
      throw this.recoveryFailure(
        "Windows Job process reported completion without authenticated terminal high-water evidence.",
      );
    }
    return evidence;
  }

  private assertExecutionSpec(command: DurableCommand, spec: WindowsJobExecutionSpec): void {
    const provider = guardedProvider(command.provider);
    if (
      spec.provider !== provider
      || spec.executableIdentity.provider !== provider
      || spec.cwd.provider !== provider
    ) {
      throw new DurableExecutionError({
        failureClass: "identity",
        message: "Execution specification provider does not match the durable command.",
      });
    }
    assertProviderExecutionArguments(provider, [
      ...spec.executableIdentity.launchArgsPrefix,
      ...spec.args,
    ], spec.env);
    assertLaunchDirectoryBindingSync(spec.cwd);
  }

  private async loadRecovery(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
  ): Promise<DurableExecutionRecoveryRecord> {
    let recovery: DurableExecutionRecoveryRecord | null;
    try {
      recovery = await this.recoveryRepository.loadExecutionRecovery(identity.executionId);
    } catch (error) {
      throw this.recoveryFailure("Durable execution recovery record could not be loaded.", error);
    }
    if (!recovery) {
      throw this.recoveryFailure(
        "Durable spawn intent is missing; Windows Job spawn denied before provider resolution.",
      );
    }
    this.assertRecoveryAssociation(recovery, command, identity);
    return recovery;
  }

  private assertRecoveryAssociation(
    recovery: DurableExecutionRecoveryRecord,
    command: DurableCommand,
    identity: DurableExecutionIdentity,
  ): void {
    if (
      recovery.executionId !== identity.executionId
      || recovery.commandId !== command.id
      || recovery.commandId !== identity.commandId
      || recovery.runId !== command.runId
      || recovery.runId !== identity.runId
      || recovery.jobObjectId !== identity.jobObjectId
    ) {
      throw new DurableExecutionError({
        failureClass: "identity",
        message: "Durable recovery association does not match the claimed execution identity.",
      });
    }
  }

  private async assertRecoveryAssociationStillCurrent(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
  ): Promise<void> {
    const recovery = await this.loadRecovery(command, identity);
    if (recovery.terminal) {
      throw this.recoveryFailure(
        "Execution became terminal while preparing its Windows Job descriptor; spawn denied.",
      );
    }
  }

  private async resolveDescriptorPath(identity: DurableExecutionIdentity): Promise<string> {
    try {
      return await this.resolveRecoveryDescriptorPath(
        this.recoveryRoot,
        identity.runId,
        identity.jobObjectId,
      );
    } catch (error) {
      throw this.recoveryFailure("Windows Job recovery descriptor path could not be resolved.", error);
    }
  }

  private descriptorLaunchAuthorizationInput(
    descriptor: WindowsJobRecoveryDescriptor,
    identity: DurableExecutionIdentity,
  ): Parameters<AuthorizeNewProviderSpawn>[0] {
    return {
      identity: { ...identity },
      authorizationId: descriptor.launchAuthorizationId,
      launchGeneration: descriptor.launchGeneration,
      expectedAttempt: descriptor.launchAttempt,
      journalGeneration: descriptor.journalGeneration,
      descriptorHmacSha256: descriptor.descriptorHmacSha256,
    };
  }

  private assertLaunchAuthorizationMatchesDescriptor(
    authorization: DurableLaunchAuthorization,
    descriptor: WindowsJobRecoveryDescriptor,
    identity?: DurableExecutionIdentity,
  ): void {
    if (
      authorization.runId !== descriptor.runId
      || authorization.jobObjectId !== descriptor.jobId
      || authorization.authorizationId !== descriptor.launchAuthorizationId
      || authorization.launchGeneration !== descriptor.launchGeneration
      || authorization.attempt !== descriptor.launchAttempt
      || authorization.journalGeneration !== descriptor.journalGeneration
      || authorization.descriptorHmacSha256 !== descriptor.descriptorHmacSha256
      || (identity !== undefined && (
        authorization.executionId !== identity.executionId
        || authorization.commandId !== identity.commandId
        || authorization.runId !== identity.runId
        || authorization.jobObjectId !== identity.jobObjectId
      ))
    ) {
      throw this.recoveryFailure(
        "Durable launch authorization receipt does not match the authenticated Windows Job descriptor.",
      );
    }
  }

  private assertDescriptorLaunchReceipt(
    descriptor: WindowsJobRecoveryDescriptor,
    authorization: DurableLaunchAuthorization | null,
  ): void {
    if (!authorization) return;
    this.assertLaunchAuthorizationMatchesDescriptor(authorization, descriptor);
  }

  private async verifyLaunchAuthorization(
    authorizeNewSpawn: AuthorizeNewProviderSpawn,
    descriptor: WindowsJobRecoveryDescriptor,
    persisted: DurableLaunchAuthorization,
  ): Promise<void> {
    this.assertLaunchAuthorizationMatchesDescriptor(persisted, descriptor);
    const verified = await authorizeNewSpawn({
      identity: {
        executionId: persisted.executionId,
        commandId: persisted.commandId,
        runId: persisted.runId,
        jobObjectId: persisted.jobObjectId,
      },
      authorizationId: descriptor.launchAuthorizationId,
      launchGeneration: descriptor.launchGeneration,
      expectedAttempt: descriptor.launchAttempt,
      journalGeneration: descriptor.journalGeneration,
      descriptorHmacSha256: descriptor.descriptorHmacSha256,
    });
    this.assertLaunchAuthorizationMatchesDescriptor(verified, descriptor);
    if (
      verified.executionId !== persisted.executionId
      || verified.commandId !== persisted.commandId
      || verified.runId !== persisted.runId
      || verified.jobObjectId !== persisted.jobObjectId
      || verified.authorizationId !== persisted.authorizationId
      || verified.launchGeneration !== persisted.launchGeneration
      || verified.attempt !== persisted.attempt
      || verified.journalGeneration !== persisted.journalGeneration
      || verified.descriptorHmacSha256 !== persisted.descriptorHmacSha256
      || verified.authorizedAt !== persisted.authorizedAt
    ) {
      throw this.recoveryFailure(
        "Durable launch authorization replay returned a conflicting receipt.",
      );
    }
  }

  private async completeControllerRevocation(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
    process: RecoveredWindowsJobProcess,
  ): Promise<SpawnResolution> {
    if (process.identity || process.status?.assignmentVerified) {
      throw this.recoveryFailure(
        "Controller-revoked Windows Job descriptor unexpectedly contains assigned process identity.",
      );
    }
    const output = new BoundedProcessOutput(
      process.stdout,
      process.stderr,
      command.resources.outputBytes,
      this.onOutput
        ? (channel, text) => this.onOutput?.({
            runId: identity.runId,
            executionId: identity.executionId,
            channel,
            text,
          })
        : undefined,
      this.onOutputEnd
        ? () => this.onOutputEnd?.({
            runId: identity.runId,
            executionId: identity.executionId,
          })
        : undefined,
    );
    const acceptAuthenticatedStatus = this.authenticatedStatusAcceptor(command, identity);
    const result = await process.wait();
    const terminalEvidence = await this.acceptProcessStatus(
      process,
      acceptAuthenticatedStatus,
      true,
    );
    await output.settleAfterTerminal(this.outputDrainTimeoutMs);
    const outcome = mapTerminalResult(result, output);
    assertTerminalEvidenceMatchesResult(terminalEvidence, result, outcome);
    if (
      result.status !== "blocked"
      || result.cleanup !== "no_process_created"
      || !result.terminationVerified
    ) {
      throw this.recoveryFailure(
        "Controller revocation did not produce verified blocked/no_process_created terminal evidence.",
      );
    }
    const mutation = await this.recoveryRepository.recordVerifiedTerminalCheckpoint({
      ...identity,
      statusEvidence: {
        ...identity,
        journalGeneration: terminalEvidence.journalGeneration,
        sequence: terminalEvidence.sequence,
        previousSequence: terminalEvidence.previousSequence,
        previousSnapshotDigestSha256: terminalEvidence.previousSnapshotDigestSha256,
        previousJournalDigestSha256: terminalEvidence.previousJournalDigestSha256,
        terminal: true,
        snapshotDigestSha256: terminalEvidence.snapshotDigestSha256,
        journalDigestSha256: terminalEvidence.journalDigestSha256,
        authenticatedPayloadDigestSha256: terminalEvidence.authenticatedPayloadDigestSha256,
        nativeTerminalDigestSha256: terminalEvidence.nativeTerminalDigestSha256!,
        nativeTerminalStatus: "blocked",
        nativeExitCode: result.exitCode,
        terminationVerified: true,
        observedAt: terminalEvidence.observedAt,
      },
      outcome,
      controllerOutcomeDigestSha256: durableOutcomeDigestSha256(outcome),
      observedAt: terminalEvidence.observedAt,
      terminationVerified: true,
      source: "windows_job_controller",
    });
    if (mutation.status === "missing" || mutation.status === "conflict") {
      throw this.recoveryFailure(
        `Controller-revoked Windows Job terminal checkpoint was rejected as ${mutation.status}.`,
      );
    }
    await process.cleanupVerified();
    return { state: "completed_without_process", outcome };
  }

  private async prepareDescriptor(
    command: DurableCommand,
    identity: DurableExecutionIdentity,
    launch?: {
      authorizationId: string;
      launchGeneration: number;
      launchAttempt: number;
    },
  ): Promise<WindowsJobRecoveryDescriptor> {
    try {
      return await this.prepareRecoveryDescriptor({
        runId: identity.runId,
        jobId: identity.jobObjectId,
        recoveryRoot: this.recoveryRoot,
        outputLimitBytes: command.resources.outputBytes,
        recoverySecret: this.recoverySecret,
        ...(launch ? {
          launchAuthorizationId: launch.authorizationId,
          launchGeneration: launch.launchGeneration,
          launchAttempt: launch.launchAttempt,
        } : {}),
      });
    } catch (error) {
      throw this.recoveryFailure("Windows Job recovery descriptor could not be prepared or verified.", error);
    }
  }

  private async arbitrateWithKeyring(
    descriptorPath: string,
    acceptAuthenticatedStatus: WindowsJobAuthenticatedStatusAcceptor,
    minimumAuthenticatedSequence: number,
  ): Promise<WindowsJobRecoveryArbitrationResult> {
    let lastError: unknown;
    for (const secret of this.recoverySecrets) {
      try {
        return await this.arbitrateRecoveryDescriptor(
          descriptorPath,
          secret,
          acceptAuthenticatedStatus,
          minimumAuthenticatedSequence,
        );
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
      "Windows Job recovery keyring contains no usable key.",
    );
  }

  private assertDescriptorAssociation(
    descriptor: WindowsJobRecoveryDescriptor,
    descriptorPath: string,
    command: DurableCommand,
    identity: DurableExecutionIdentity,
  ): void {
    if (
      descriptor.runId !== identity.runId
      || descriptor.jobId !== identity.jobObjectId
      || descriptor.outputLimitBytes !== command.resources.outputBytes
      || descriptor.descriptorPath.localeCompare(descriptorPath, undefined, { sensitivity: "accent" }) !== 0
    ) {
      throw this.recoveryFailure(
        "Windows Job recovery descriptor does not match the durable run, Job Object, or output budget.",
      );
    }
  }

  private async resolveVerifiedExecutionSpec(
    command: DurableCommand,
    signal: AbortSignal,
  ): Promise<WindowsJobExecutionSpec> {
    const spec = await this.resolveExecutionSpec(command, signal);
    if (signal.aborted) throwAbortReason(signal);
    this.assertExecutionSpec(command, spec);
    assertExecutableIdentityBindingSync(spec.executableIdentity);
    return spec;
  }

  private assertRecoveredExecutable(
    executableIdentity: ExecutableIdentity,
    processIdentity: DurableProcessIdentity,
  ): void {
    const launched = launchedExecutable(executableIdentity);
    if (
      launched.path.localeCompare(processIdentity.executablePath, undefined, { sensitivity: "accent" }) !== 0
      || launched.sha256.toLowerCase() !== processIdentity.executableHash.toLowerCase()
    ) {
      throw new DurableExecutionError({
        failureClass: "identity",
        message: "Recovered Windows Job executable identity no longer matches the pinned provider executable.",
      });
    }
  }

  private recoveredProcessIdentity(
    recovered: RecoveredWindowsJobProcess,
    descriptor: WindowsJobRecoveryDescriptor,
    persisted: DurableProcessIdentity | null,
    executableIdentity: ExecutableIdentity,
    identity: DurableExecutionIdentity,
  ): DurableProcessIdentity {
    const native = this.recoveredNativeIdentity(recovered);
    if (!native) {
      throw this.recoveryFailure(
        "Claimed Windows Job descriptor has no verified assigned process identity; duplicate spawn denied.",
      );
    }
    if (native.runId !== identity.runId || native.jobId !== identity.jobObjectId) {
      throw new DurableExecutionError({
        failureClass: "identity",
        message: "Recovered native Windows Job identity does not match the durable run or Job Object.",
      });
    }
    const launched = launchedExecutable(executableIdentity);
    const observed: DurableProcessIdentity = {
      pid: native.rootProcessId,
      jobObjectId: identity.jobObjectId,
      jobName: native.jobName,
      rootProcessStartedAtFileTime: native.rootProcessStartedAtFileTime,
      helperPid: native.helperProcessId,
      helperProcessStartedAtFileTime: native.helperProcessStartedAtFileTime,
      executablePath: launched.path,
      executableHash: launched.sha256,
      startedAt: persisted?.startedAt ?? descriptor.createdAt,
    };
    if (!persisted) return observed;
    this.assertRecoveredExecutable(executableIdentity, persisted);
    if (!this.sameNativeProcessIdentity(observed, persisted)) {
      throw new DurableExecutionError({
        failureClass: "identity",
        message: "Recovered native Windows Job identity conflicts with persisted process evidence.",
      });
    }
    return persisted;
  }

  private recoveredNativeIdentity(recovered: RecoveredWindowsJobProcess): WindowsJobProcessIdentity | null {
    if (recovered.identity) return recovered.identity;
    const status = recovered.status;
    if (
      !status
      || status.assignmentVerified !== true
      || typeof status.jobName !== "string"
      || !Number.isSafeInteger(status.helperProcessId)
      || Number(status.helperProcessId) <= 0
      || typeof status.helperProcessStartedAtFileTime !== "string"
      || !/^\d+$/u.test(status.helperProcessStartedAtFileTime)
      || !Number.isSafeInteger(status.rootProcessId)
      || Number(status.rootProcessId) <= 0
      || typeof status.rootProcessStartedAtFileTime !== "string"
      || !/^\d+$/u.test(status.rootProcessStartedAtFileTime)
    ) return null;
    return {
      schemaVersion: 1,
      runId: status.runId,
      jobId: status.jobId,
      jobName: status.jobName,
      helperProcessId: Number(status.helperProcessId),
      helperProcessStartedAtFileTime: status.helperProcessStartedAtFileTime,
      rootProcessId: Number(status.rootProcessId),
      rootProcessStartedAtFileTime: status.rootProcessStartedAtFileTime,
      assignmentVerified: true,
    };
  }

  private sameNativeProcessIdentity(left: DurableProcessIdentity, right: DurableProcessIdentity): boolean {
    return left.pid === right.pid
      && left.jobObjectId === right.jobObjectId
      && left.jobName === right.jobName
      && left.rootProcessStartedAtFileTime === right.rootProcessStartedAtFileTime
      && left.helperPid === right.helperPid
      && left.helperProcessStartedAtFileTime === right.helperProcessStartedAtFileTime;
  }

  private sameProcessIdentity(left: DurableProcessIdentity, right: DurableProcessIdentity): boolean {
    return left.pid === right.pid
      && left.jobObjectId === right.jobObjectId
      && left.jobName === right.jobName
      && left.rootProcessStartedAtFileTime === right.rootProcessStartedAtFileTime
      && left.helperPid === right.helperPid
      && left.helperProcessStartedAtFileTime === right.helperProcessStartedAtFileTime
      && left.executablePath.localeCompare(right.executablePath, undefined, { sensitivity: "accent" }) === 0
      && left.executableHash.toLowerCase() === right.executableHash.toLowerCase()
      && left.startedAt === right.startedAt;
  }

  private recoveryFailure(message: string, cause?: unknown): DurableExecutionError {
    return new DurableExecutionError({
      failureClass: "containment",
      message,
    }, cause === undefined ? undefined : { cause });
  }
}
