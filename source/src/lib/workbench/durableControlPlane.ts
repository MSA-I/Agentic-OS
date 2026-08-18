import "server-only";

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  assertIdentityMatch,
  createControlPlaneIdentity,
  type ControlPlaneIdentity,
} from "@/lib/control-plane/identity";
import {
  FailClosedPolicyEngine,
  type ExecutionGuardState,
} from "@/lib/control-plane/policy";
import { loadOrCreateMachineRecoveryKeyring } from "@/lib/control-plane/machineRecoveryKeyring";
import { ensureWorkspaceRootSync, workspacePath } from "@/lib/workspaceRoot";
import { listWorkbenchAgents } from "./adapters";
import {
  DurableExecutionError,
  DurableWorkbenchWorker,
  type DurableCommand,
  type DurableProviderCircuitSnapshot,
  type WorkerRunResult,
} from "./durableWorker";
import { DurableExecutionCleanupDrainer } from "./executionCleanupDrainer";
import {
  WorkbenchConflictError,
  WorkbenchNotFoundError,
  WorkbenchPilotError,
  WorkbenchUnsupportedError,
  type WorkbenchErrorCategory,
} from "./errors";
import type { ValidatedCreateRun } from "./http";
import { createRunIdempotencyBinding } from "./idempotency";
import {
  resolveRestrictedPilotPreflight,
  resolveRestrictedPilotExecutionSpec,
  type RestrictedPilotAdmissionAttestation,
  type RestrictedPilotPreflightResolver,
} from "./providers";
import { ClaudeStreamJsonParser, type ClaudeNormalizedStreamEvent } from "./providers/claudeStream";
import {
  CodexNdjsonStreamNormalizer,
  type CodexNormalizedStreamEvent,
} from "./providers/codexStream";
import { redactLogMessage, redactRecord, redactText } from "./redaction";
import { DEFAULT_RESOURCE_REQUEST, type ResourceBudget } from "./resourceAdmission";
import { SqliteDurableWorkerRepository } from "./sqliteWorkerRepository";
import {
  WorkbenchAdmissionError,
  WorkbenchIdempotencyConflictError,
  WorkbenchRunNotFoundError,
  WorkbenchStore,
  type ListRunsInput,
  type OutboxCommand,
} from "./store";
import { TERMINAL_RUN_STATUSES } from "./stateMachine";
import type {
  AgentDescriptor,
  MessageMode,
  Run,
  RunEvent,
  WorkbenchProvider,
} from "./types";
import {
  WindowsJobExecutionDriver,
  type WindowsJobOutputEvent,
  type WindowsJobOutputEndEvent,
} from "./windowsJobExecutionDriver";

const RESTRICTED_PROVIDERS = new Set<WorkbenchProvider>(["codex", "claude"]);
const PROVIDER_WORKER_POOL_SIZE = 5;
const WORKER_WAKE_INTERVAL_MS = 1_000;
const PILOT_OUTPUT_BYTES = 4 * 1024 * 1024;
const PILOT_RESOURCE_REQUEST: Readonly<ResourceBudget> = Object.freeze({
  ...DEFAULT_RESOURCE_REQUEST,
  cpuTimeMs: 10 * 60 * 1_000,
  processCount: Math.min(DEFAULT_RESOURCE_REQUEST.processCount, 8),
  outputBytes: Math.min(DEFAULT_RESOURCE_REQUEST.outputBytes, PILOT_OUTPUT_BYTES),
});

export interface RestrictedPilotCommandPayload {
  schemaVersion: 1;
  operation: "start" | "resume";
  prompt: string;
  context: ValidatedCreateRun["context"];
  options: ValidatedCreateRun["options"];
  commandIdentity: ControlPlaneIdentity;
  toolPolicy: "disabled" | "provider-native-restricted";
  resources: ResourceBudget;
  maxAttempts: number;
}

export interface StopPresentation {
  state: "not_requested" | "stopping" | "stopped_and_verified" | "failed_to_stop";
  verified: boolean;
}

export interface FailurePresentation {
  code: string;
  category: WorkbenchErrorCategory;
  retrySafe: boolean;
  nextAction: string;
}

export interface RunPresentation {
  run: Run;
  stop: StopPresentation;
  failure: FailurePresentation | null;
}

interface WorkerRuntime {
  repository: SqliteDurableWorkerRepository;
  driver: WindowsJobExecutionDriver;
  cleanupDrainer: DurableExecutionCleanupDrainer;
  workers: DurableWorkbenchWorker[];
  running: boolean[];
  cleanupRunning: boolean;
  wakeTimer: ReturnType<typeof setInterval>;
}

export interface RestrictedPilotRuntimeController {
  ensureReady(): void;
  kick(): void;
}

export interface DurableWorkbenchControlPlaneOptions {
  preflight?: RestrictedPilotPreflightResolver;
  runtimeController?: RestrictedPilotRuntimeController;
}

const pilotPolicy = new FailClosedPolicyEngine([{
  id: "wave3.restricted-codex-claude",
  effect: "allow",
  operations: ["start", "resume", "cancel"],
  matches: (context) => RESTRICTED_PROVIDERS.has(context.identity.provider as WorkbenchProvider)
    && ["disabled", "provider-native-restricted"].includes(String(context.metadata?.toolPolicy)),
}]);

function toolPolicyFor(provider: WorkbenchProvider): RestrictedPilotCommandPayload["toolPolicy"] {
  return provider === "claude" ? "disabled" : "provider-native-restricted";
}

function canonicalJson(value: unknown): string {
  const walk = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(walk);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, walk(child)]),
      );
    }
    return entry;
  };
  return JSON.stringify(walk(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function stableNativeSessionId(provider: "claude", idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`agent-os:wave3:${provider}:native-session\0`, "utf8")
    .update(idempotencyKey, "utf8")
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableJobObjectId(executionId: string): string {
  return `agent-os-${executionId.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 120)}`;
}

function recoveryKeyring(): ReturnType<typeof loadOrCreateMachineRecoveryKeyring> {
  try {
    return loadOrCreateMachineRecoveryKeyring();
  } catch {
    throw new WorkbenchPilotError({
      message: "Workbench execution is unavailable because its machine recovery keyring could not be verified.",
      code: "controller_recovery_keyring_unavailable",
      category: "policy",
      status: 503,
      nextAction: "Repair the current-user AGENT-OS keyring permissions and restart the desktop app.",
    });
  }
}

function requiredIdentityText(value: string | null, field: string): string {
  if (!value) {
    throw new WorkbenchPilotError({
      message: `${field} is required for a provider run.`,
      code: "identity_target_incomplete",
      category: "identity",
      status: 403,
      nextAction: "Select a provider project and retry without changing the target.",
    });
  }
  return value;
}

function expectedCreateIdentity(
  input: ValidatedCreateRun,
  actual: ControlPlaneIdentity,
): ControlPlaneIdentity {
  return createControlPlaneIdentity({
    callerSessionId: actual.callerSessionId,
    actorId: requiredIdentityText(input.context.actorId, "context.actorId"),
    projectId: requiredIdentityText(input.context.projectId, "context.projectId"),
    worktreeId: input.context.environment,
    provider: input.provider,
    profileId: null,
    nativeSessionId: input.context.sessionId,
    runId: input.idempotencyKey,
  });
}

function expectedRunIdentity(run: Run, actual: ControlPlaneIdentity): ControlPlaneIdentity {
  return createControlPlaneIdentity({
    callerSessionId: actual.callerSessionId,
    actorId: requiredIdentityText(run.context.actorId, "run.actorId"),
    projectId: requiredIdentityText(run.context.projectId, "run.projectId"),
    worktreeId: run.context.environment,
    provider: run.provider,
    profileId: null,
    nativeSessionId: run.context.sessionId,
    runId: run.id,
  });
}

function assertCanonicalIdentity(expected: ControlPlaneIdentity, actual: ControlPlaneIdentity): void {
  try {
    assertIdentityMatch(expected, actual);
  } catch {
    throw new WorkbenchConflictError(
      "The command identity does not match the selected provider, project, session, or run.",
      "identity_mismatch",
    );
  }
}

export function restrictedPilotGuardState(
  operation: "start" | "resume" | "cancel",
  identity: ControlPlaneIdentity,
  attestation: RestrictedPilotAdmissionAttestation | null,
  now = Date.now(),
): ExecutionGuardState {
  if (operation === "cancel") {
    return {
      identityVerified: true,
      containmentVerified: false,
      secretControlsVerified: false,
      approvalEnforced: false,
      executableVerified: false,
      capabilityVerified: false,
    };
  }
  const observedAt = Date.parse(attestation?.observedAt ?? "");
  const validUntil = Date.parse(attestation?.validUntil ?? "");
  const executableObservedAt = Date.parse(attestation?.executable.observedAt ?? "");
  const fresh = Boolean(
    attestation
    && Number.isFinite(observedAt)
    && Number.isFinite(validUntil)
    && observedAt <= now
    && validUntil > now
    && validUntil - observedAt <= 30_000
    && Number.isFinite(executableObservedAt)
    && executableObservedAt <= now + 5_000
    && executableObservedAt >= now - (5 * 60_000),
  );
  const identityVerified = Boolean(
    fresh
    && attestation?.schemaVersion === 1
    && attestation.provider === identity.provider
    && attestation.operation === operation
    && attestation.command.callerSessionId === identity.callerSessionId
    && attestation.command.actorId === identity.actorId
    && attestation.command.projectId === identity.projectId
    && attestation.command.worktreeId === identity.worktreeId
    && attestation.command.nativeSessionId === identity.nativeSessionId
    && attestation.command.runId === identity.runId
    && attestation.command.explicitUserMutation === true,
  );
  const containmentVerified = Boolean(
    fresh
    && attestation?.containment.approvedLaunchDirectory === true
    && attestation.containment.windowsJobObjectRequired === true
    && typeof attestation.containment.directoryIdentity === "string"
    && attestation.containment.directoryIdentity.length > 0,
  );
  const secretControlsVerified = Boolean(
    fresh
    && attestation?.secretControls.promptTransport === "stdin"
    && attestation.secretControls.minimalEnvironment === true
    && attestation.secretControls.streamRedactionRequired === true,
  );
  const approvalEnforced = Boolean(
    fresh
    && attestation?.approval.kind === "explicit-run-request"
    && attestation.approval.commandBound === true
    && attestation.approval.providerApprovalSurface === "disabled"
    && attestation.approval.toolPolicy === toolPolicyFor(identity.provider as WorkbenchProvider),
  );
  const executableVerified = Boolean(
    fresh
    && attestation?.executable.schemaVersion === 2
    && attestation.executable.provider === identity.provider
    && /^[a-f0-9]{64}$/u.test(attestation.executable.sha256)
    && attestation.executable.version.trim().length > 0,
  );
  const capabilityVerified = Boolean(
    fresh
    && attestation?.capability.adapterApiVersion === "2.0.0"
    && attestation.capability.capabilitySchemaVersion === 1
    && attestation.capability.providerRestrictionsVerified === true
    && attestation.capability.runtimeIdentityVerified === true,
  );
  return {
    identityVerified,
    containmentVerified,
    secretControlsVerified,
    approvalEnforced,
    executableVerified,
    capabilityVerified,
  };
}

function policyAllows(
  operation: "start" | "resume" | "cancel",
  identity: ControlPlaneIdentity,
  attestation: RestrictedPilotAdmissionAttestation | null = null,
): void {
  const decision = pilotPolicy.decide({
    operation,
    identity,
    guards: restrictedPilotGuardState(operation, identity, attestation),
    risk: operation === "cancel" ? "low" : "high",
    metadata: { toolPolicy: toolPolicyFor(identity.provider as WorkbenchProvider) },
  });
  if (!decision.allowed) {
    throw new WorkbenchPilotError({
      message: "The restricted provider policy denied this command.",
      code: decision.code,
      category: "policy",
      status: 403,
      nextAction: "Refresh provider status and retry only after every safety gate is verified.",
    });
  }
}

function previewCommand(payload: RestrictedPilotCommandPayload, input: ValidatedCreateRun): DurableCommand {
  const timestamp = new Date().toISOString();
  const idempotencyPayload = {
    ...payload,
    commandIdentity: {
      actorId: payload.commandIdentity.actorId,
      projectId: payload.commandIdentity.projectId,
      worktreeId: payload.commandIdentity.worktreeId,
      provider: payload.commandIdentity.provider,
      profileId: payload.commandIdentity.profileId,
      nativeSessionId: payload.commandIdentity.nativeSessionId,
      runId: payload.commandIdentity.runId,
    },
  };
  const durableBinding = createRunIdempotencyBinding({
    actorId: payload.commandIdentity.actorId,
    projectId: payload.commandIdentity.projectId,
    operation: input.operation,
    callerKey: input.idempotencyKey,
    payload: idempotencyPayload,
  });
  return {
    id: `preflight-${sha256(input.idempotencyKey).slice(0, 32)}`,
    runId: `preflight-${sha256(input.idempotencyKey).slice(0, 32)}`,
    provider: input.provider,
    operation: input.operation,
    payload,
    payloadHash: sha256(payload),
    idempotencyKey: durableBinding.key,
    runGeneration: 0,
    runStateVersion: 0,
    executionId: `preflight-${sha256(payload).slice(0, 32)}`,
    attempt: 0,
    deliveryAttempts: 0,
    maxAttempts: payload.maxAttempts,
    checkpoint: "dequeued",
    availableAt: timestamp,
    resources: { ...PILOT_RESOURCE_REQUEST },
  };
}

function failurePresentation(run: Run): FailurePresentation | null {
  if (!run.error) return null;
  const code = run.error.code;
  if (/quota/iu.test(code)) {
    return { code, category: "quota", retrySafe: false, nextAction: "Review provider usage or wait for quota renewal." };
  }
  if (/auth/iu.test(code)) {
    return { code, category: "auth", retrySafe: false, nextAction: "Reconnect the provider in Setup Center." };
  }
  if (/timeout/iu.test(code)) {
    return { code, category: "timeout", retrySafe: true, nextAction: "Retry after checking provider health." };
  }
  if (/identity|executable/iu.test(code)) {
    return { code, category: "identity", retrySafe: false, nextAction: "Refresh provider and project identity before retrying." };
  }
  if (/containment|windows_job/iu.test(code)) {
    return { code, category: "containment", retrySafe: false, nextAction: "Restart AGENT-OS and re-run provider verification." };
  }
  if (/unsupported/iu.test(code)) {
    return { code, category: "unsupported", retrySafe: false, nextAction: "Use only the restricted Wave 3 capability." };
  }
  if (/unavailable|circuit/iu.test(code)) {
    return { code, category: "unavailable", retrySafe: true, nextAction: "Wait for provider recovery and retry." };
  }
  return { code, category: "unknown", retrySafe: false, nextAction: "Inspect the run events before retrying." };
}

function stopPresentation(run: Run, commands: readonly OutboxCommand[]): StopPresentation {
  const cancel = [...commands].reverse().find((command) => command.operation === "cancel");
  if (!cancel) return { state: "not_requested", verified: false };
  if (run.status === "stopping") return { state: "stopping", verified: false };
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    const verifiedOutcome = cancel.outcome?.status === run.status
      && (cancel.outcome.metadata as Record<string, unknown> | undefined)?.terminationVerified === true;
    const cancelledBeforeSpawn = run.status === "cancelled"
      && cancel.outcome?.status === "cancelled"
      && commands.some((command) =>
        (command.operation === "start" || command.operation === "resume")
        && command.providerAttemptCount === 0
        && command.checkpoint === "pending");
    const verified = verifiedOutcome || cancelledBeforeSpawn;
    return { state: verified ? "stopped_and_verified" : "failed_to_stop", verified };
  }
  return { state: "stopping", verified: false };
}

function pilotError(error: unknown, runCreated = false): WorkbenchPilotError {
  if (error instanceof WorkbenchPilotError) return error;
  if (error instanceof WorkbenchAdmissionError) {
    return new WorkbenchPilotError({
      message: error.detail,
      code: error.code,
      category: error.code === "queue_full" || error.code === "active_limit" ? "unavailable" : "policy",
      status: 429,
      runCreated,
      retrySafe: error.code === "queue_full" || error.code === "active_limit",
      nextAction: "Wait for an active run to finish, then retry with the same idempotency key.",
    });
  }
  if (error instanceof WorkbenchIdempotencyConflictError) {
    return new WorkbenchPilotError({
      message: "The idempotency key was already used with different run content.",
      code: "idempotency_conflict",
      category: "identity",
      status: 409,
      runCreated,
      nextAction: "Refresh the run list and submit a new command identifier.",
    });
  }
  const failure = error instanceof DurableExecutionError ? error.failure : null;
  const rawCode = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const failureClass = failure?.failureClass ?? rawCode;
  const category: WorkbenchErrorCategory = /quota/iu.test(failureClass)
    ? "quota"
    : /auth/iu.test(failureClass)
      ? "auth"
      : /timeout/iu.test(failureClass)
        ? "timeout"
        : /identity|executable|project/iu.test(failureClass)
          ? "identity"
          : /containment|launch_cwd|windows_job/iu.test(failureClass)
            ? "containment"
            : /policy|forbidden/iu.test(failureClass)
              ? "policy"
              : /unsupported/iu.test(failureClass)
                ? "unsupported"
                : /unavailable|transient|rate_limit/iu.test(failureClass)
                  ? "unavailable"
                  : "unknown";
  const retrySafe = ["timeout", "unavailable"].includes(category);
  return new WorkbenchPilotError({
    message: category === "identity"
      ? "Provider executable or project identity could not be verified."
      : category === "containment"
        ? "Provider containment could not be verified."
        : category === "auth"
          ? "Provider authentication is unavailable."
          : category === "quota"
            ? "Provider quota is unavailable."
            : category === "unsupported"
              ? "This provider capability is not available in the restricted pilot."
              : "The provider run could not be admitted safely.",
    code: rawCode || failure?.failureClass || "provider_preflight_failed",
    category,
    status: category === "identity" ? 409 : category === "auth" ? 401 : category === "quota" ? 429 : 503,
    runCreated,
    retrySafe,
    nextAction: retrySafe
      ? "Retry with the same idempotency key after provider health recovers."
      : "Open Setup Center, verify the provider target, and then create a new run.",
  });
}

export class DurableWorkbenchControlPlane {
  readonly store: WorkbenchStore;
  private runtime: WorkerRuntime | null = null;
  private runtimeError: WorkbenchPilotError | null = null;
  private readonly preflight: RestrictedPilotPreflightResolver;
  private readonly runtimeController: RestrictedPilotRuntimeController | null;
  private readonly claudeStreams = new Map<string, ClaudeStreamJsonParser>();
  private readonly codexStreams = new Map<string, CodexNdjsonStreamNormalizer>();

  constructor(
    store = new WorkbenchStore(),
    options: DurableWorkbenchControlPlaneOptions = {},
  ) {
    this.store = store;
    this.preflight = options.preflight ?? resolveRestrictedPilotPreflight;
    this.runtimeController = options.runtimeController ?? null;
    if (this.runtimeController) return;
    queueMicrotask(() => {
      try {
        this.ensureWorkerRuntime();
        this.kick();
      } catch (error) {
        this.runtimeError = pilotError(error);
      }
    });
  }

  agents(): AgentDescriptor[] {
    return listWorkbenchAgents();
  }

  get(runId: string): RunPresentation {
    const run = this.store.getRun(runId);
    if (!run) throw new WorkbenchNotFoundError("Run not found.");
    const commands = this.store.outboxForRun(run.id, 200);
    return { run, stop: stopPresentation(run, commands), failure: failurePresentation(run) };
  }

  /**
   * Read-only provider circuit state for callers that only want to know whether a
   * provider is currently tripped. It never calls ensureWorkerRuntime: standing up
   * the worker pool, the Windows Job driver and a second SQLite handle just to
   * answer a health question would be both wasteful and a WAL hazard. When the
   * runtime has not been created yet there is no circuit row either, so the
   * repository's own default for a missing row is the honest answer.
   */
  async providerCircuit(provider: string): Promise<DurableProviderCircuitSnapshot | null> {
    const runtime = this.runtime;
    if (!runtime) return null;
    try {
      return await runtime.repository.loadProviderCircuit(provider);
    } catch {
      return null;
    }
  }

  list(input: ListRunsInput = {}): RunPresentation[] {
    return this.store.listRuns(input).map((run) => {
      const commands = this.store.outboxForRun(run.id, 200);
      return { run, stop: stopPresentation(run, commands), failure: failurePresentation(run) };
    });
  }

  async create(
    input: ValidatedCreateRun,
    commandIdentity: ControlPlaneIdentity,
  ): Promise<{ run: Run; commandId: string; created: boolean; operation: "start" | "resume" }> {
    if (!RESTRICTED_PROVIDERS.has(input.provider)) {
      throw new WorkbenchUnsupportedError("Only Codex and Claude are enabled in the restricted Wave 3 pilot.");
    }
    if (input.adapterId !== input.provider || input.context.agentId !== input.provider) {
      throw new WorkbenchConflictError("Workbench adapter and provider targets do not match.", "identity_mismatch");
    }
    if (input.context.actorId !== input.provider) {
      throw new WorkbenchConflictError("Restricted Codex and Claude runs require their canonical actor identity.", "actor_mismatch");
    }
    const admissionIdentity = expectedCreateIdentity(input, commandIdentity);
    assertCanonicalIdentity(admissionIdentity, commandIdentity);
    const assignedNativeSessionId = input.operation === "start" && input.provider === "claude"
      ? stableNativeSessionId("claude", input.idempotencyKey)
      : input.context.sessionId;
    const executionContext: ValidatedCreateRun["context"] = {
      ...input.context,
      sessionId: assignedNativeSessionId,
    };
    const executionIdentity = createControlPlaneIdentity({
      ...admissionIdentity,
      nativeSessionId: assignedNativeSessionId,
    });
    const payload: RestrictedPilotCommandPayload = {
      schemaVersion: 1,
      operation: input.operation,
      prompt: redactText(input.prompt, 16 * 1024),
      context: redactRecord(executionContext) as unknown as RestrictedPilotCommandPayload["context"],
      options: redactRecord(input.options) as RestrictedPilotCommandPayload["options"],
      commandIdentity: executionIdentity,
      toolPolicy: toolPolicyFor(input.provider),
      resources: { ...PILOT_RESOURCE_REQUEST },
      maxAttempts: 3,
    };
    const idempotencyPayload = {
      ...payload,
      commandIdentity: {
        actorId: executionIdentity.actorId,
        projectId: executionIdentity.projectId,
        worktreeId: executionIdentity.worktreeId,
        provider: executionIdentity.provider,
        profileId: executionIdentity.profileId,
        nativeSessionId: executionIdentity.nativeSessionId,
        runId: executionIdentity.runId,
      },
    };

    try {
      const preflight = await this.preflight(
        previewCommand(payload, input),
        AbortSignal.timeout(20_000),
      );
      policyAllows(input.operation, executionIdentity, preflight.attestation);
      if (this.runtimeController) this.runtimeController.ensureReady();
      else this.ensureWorkerRuntime();
      const result = this.store.createRunCommand({
        adapterId: input.adapterId,
        provider: input.provider,
        context: executionContext,
        title: input.title,
        metadata: {
          ...input.metadata,
          evidenceLevel: "live-runtime-pending",
          toolPolicy: toolPolicyFor(input.provider),
          pilotWave: 3,
          preflight: {
            schemaVersion: preflight.attestation.schemaVersion,
            observedAt: preflight.attestation.observedAt,
            validUntil: preflight.attestation.validUntil,
            executableSha256: preflight.attestation.executable.sha256,
            executableVersion: preflight.attestation.executable.version,
            adapterApiVersion: preflight.attestation.capability.adapterApiVersion,
            capabilitySchemaVersion: preflight.attestation.capability.capabilitySchemaVersion,
          },
        },
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        payload: idempotencyPayload,
        initialStatus: "queued",
        command: {
          type: `wave3.${input.provider}.${input.operation}`,
          payload: { ...payload },
          idempotencyPayload,
        },
      });
      this.kick();
      return {
        run: result.run,
        commandId: result.command.id,
        created: result.created,
        operation: input.operation,
      };
    } catch (error) {
      throw pilotError(error);
    }
  }

  message(
    runId: string,
    mode: MessageMode,
    content: string,
    commandIdentity: ControlPlaneIdentity,
  ): never {
    const run = this.requirePilotRun(runId);
    assertCanonicalIdentity(expectedRunIdentity(run, commandIdentity), commandIdentity);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new WorkbenchConflictError("Cannot queue a message for a finished run.");
    }
    void content;
    throw new WorkbenchUnsupportedError(
      mode === "steer"
        ? "Live steer remains disabled until a provider control bridge is verified."
        : "Durable follow-up delivery remains disabled until a provider message bridge is verified.",
    );
  }

  cancel(runId: string, commandIdentity: ControlPlaneIdentity): RunPresentation {
    const run = this.requirePilotRun(runId);
    assertCanonicalIdentity(expectedRunIdentity(run, commandIdentity), commandIdentity);
    policyAllows("cancel", commandIdentity);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return this.get(run.id);

    const commands = this.store.outboxForRun(run.id, 200);
    const start = commands.find((command) => command.operation === "start" || command.operation === "resume");
    if (!start) throw new WorkbenchConflictError("Run has no durable provider command.");
    if (run.status === "stopping") return this.get(run.id);

    const noProviderAttempt = start.providerAttemptCount === 0
      && ["pending", "dequeued"].includes(start.checkpoint)
      && start.state !== "completed";
    if (["requested", "queued", "orphaned"].includes(run.status) && noProviderAttempt) {
      this.store.transitionRunWithCommand({
        runId: run.id,
        to: "cancelled",
        expectedFrom: run.status,
        command: {
          type: `wave3.${run.provider}.cancel`,
          idempotencyKey: `cancel:${run.id}`,
          payload: {
            operation: "cancel",
            targetExecutionId: start.executionId ?? start.idempotencyKey,
            targetJobObjectId: stableJobObjectId(start.executionId ?? start.idempotencyKey),
            noProviderAttempt: true,
          },
        },
        event: { payload: { stopState: "stopped_and_verified", terminationVerified: true } },
        patch: { finishedAt: new Date().toISOString(), pid: null, error: null },
      });
      return this.get(run.id);
    }

    this.store.transitionRunWithCommand({
      runId: run.id,
      to: "stopping",
      expectedFrom: run.status,
      command: {
        type: `wave3.${run.provider}.cancel`,
        idempotencyKey: `cancel:${run.id}`,
        payload: {
          operation: "cancel",
          targetExecutionId: start.executionId ?? start.idempotencyKey,
          targetJobObjectId: stableJobObjectId(start.executionId ?? start.idempotencyKey),
          resources: { ...PILOT_RESOURCE_REQUEST },
          maxAttempts: 1,
        },
      },
      event: { payload: { stopState: "stopping", terminationVerified: false } },
      patch: { error: null },
    });
    this.kick();
    return this.get(run.id);
  }

  eventPage(runId: string, after: number, limit: number) {
    this.requirePilotRun(runId);
    return this.store.eventPage(runId, after, limit);
  }

  subscribe(runId: string, after: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
    this.requirePilotRun(runId);
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        let cursor = Math.max(0, after);
        let closed = false;
        let polling = false;
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          signal?.removeEventListener("abort", close);
          try { controller.close(); } catch { /* disconnected */ }
        };
        const send = (event: RunEvent) => {
          if (closed || event.sequence <= cursor) return;
          cursor = event.sequence;
          controller.enqueue(encoder.encode(
            `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ));
        };
        const poll = () => {
          if (closed || polling) return;
          polling = true;
          try {
            let page = this.store.eventPage(runId, cursor, 500);
            if (page.gap) {
              cursor = page.gap.availableAfter;
              controller.enqueue(encoder.encode(
                `id: ${cursor}\nevent: snapshot\ndata: ${JSON.stringify({ runId, gap: page.gap, bounds: page.bounds })}\n\n`,
              ));
            }
            while (!closed) {
              for (const event of page.events) send(event);
              if (!page.hasMore) break;
              page = this.store.eventPage(runId, page.nextCursor, 500);
            }
            const current = this.store.getRun(runId);
            if (current && TERMINAL_RUN_STATUSES.has(current.status)) close();
          } catch (error) {
            if (!closed) {
              controller.enqueue(encoder.encode(
                `event: error\ndata: ${JSON.stringify({ error: redactLogMessage(error) })}\n\n`,
              ));
              close();
            }
          } finally {
            polling = false;
          }
        };
        const timer = setInterval(poll, 250);
        timer.unref?.();
        signal?.addEventListener("abort", close, { once: true });
        poll();
      },
    });
  }

  private requirePilotRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new WorkbenchNotFoundError("Run not found.");
    if (!RESTRICTED_PROVIDERS.has(run.provider)) {
      throw new WorkbenchUnsupportedError("This run is not part of the restricted Codex/Claude pilot.");
    }
    return run;
  }

  private ensureWorkerRuntime(): WorkerRuntime {
    if (this.runtime) return this.runtime;
    if (this.runtimeError) throw this.runtimeError;
    ensureWorkspaceRootSync();
    const recoveryRoot = workspacePath("AGENT_OS", "control-plane", "windows-job-recovery");
    mkdirSync(recoveryRoot, { recursive: true });
    const repository = new SqliteDurableWorkerRepository(this.store.databasePath);
    const machineKeyring = recoveryKeyring();
    const privateRecoverySecret = machineKeyring.primarySecret;
    const driver = new WindowsJobExecutionDriver({
      resolveExecutionSpec: resolveRestrictedPilotExecutionSpec,
      recoveryRepository: repository,
      recoveryRoot,
      recoverySecret: privateRecoverySecret,
      recoverySecrets: machineKeyring.recoverySecrets,
      onOutput: (event) => this.handleProviderOutput(event),
      onOutputEnd: (event) => this.finishProviderOutput(event),
    });
    const cleanupDrainer = new DurableExecutionCleanupDrainer(repository, {
      workerId: `wave2-cleanup-${process.pid}`,
      recoveryRoot,
      recoverySecret: privateRecoverySecret,
      recoverySecrets: machineKeyring.recoverySecrets,
      onCleanupCommitted: (intent) => {
        return driver.releaseCompletedExecution(intent.executionId, intent.jobObjectId);
      },
      cleanupObservationTargets: () => driver.trackedExecutionIds(),
    });
    const workers = [
      ...Array.from({ length: PROVIDER_WORKER_POOL_SIZE }, (_, index) => new DurableWorkbenchWorker(
        repository,
        driver,
        { workerId: `wave3-provider-${process.pid}-${index}`, lane: "provider" },
      )),
      new DurableWorkbenchWorker(repository, driver, {
        workerId: `wave3-control-${process.pid}`,
        lane: "control",
      }),
    ];
    const wakeTimer = setInterval(() => this.kick(), WORKER_WAKE_INTERVAL_MS);
    wakeTimer.unref?.();
    this.runtime = {
      repository,
      driver,
      cleanupDrainer,
      workers,
      running: workers.map(() => false),
      cleanupRunning: false,
      wakeTimer,
    };
    return this.runtime;
  }

  private kick(): void {
    if (this.runtimeController) {
      this.runtimeController.kick();
      return;
    }
    const runtime = this.runtime ?? this.ensureWorkerRuntime();
    runtime.workers.forEach((_worker, index) => {
      if (runtime.running[index]) return;
      runtime.running[index] = true;
      void this.drainWorker(index).finally(() => {
        runtime.running[index] = false;
      });
    });
    if (!runtime.cleanupRunning) {
      runtime.cleanupRunning = true;
      void runtime.cleanupDrainer.drainBounded()
        .catch((error) => {
          console.error("Durable execution cleanup drainer failed", redactLogMessage(error));
        })
        .finally(() => {
          runtime.cleanupRunning = false;
        });
    }
  }

  private handleProviderOutput({ runId, executionId, channel, text }: WindowsJobOutputEvent): void {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new DurableExecutionError({ failureClass: "identity", message: "Provider output targeted an unknown run." });
    }
    if (run.provider === "codex") {
      let parser = this.codexStreams.get(executionId);
      if (!parser) {
        const command = this.store.outboxForRun(runId, 200).find(
          (entry) => entry.operation === "start" || entry.operation === "resume",
        );
        const prompt = command && typeof command.payload.prompt === "string" ? command.payload.prompt : null;
        if (!prompt) {
          throw new DurableExecutionError({
            failureClass: "identity",
            message: "Codex output arrived without its admitted command prompt.",
          });
        }
        parser = new CodexNdjsonStreamNormalizer({
          prompt,
          expectedSessionId: run.context.sessionId,
        });
        this.codexStreams.set(executionId, parser);
      }
      const events = channel === "stdout" ? parser.pushStdout(text) : parser.pushStderr(text);
      this.persistCodexStreamEvents(runId, executionId, events);
      return;
    }
    if (channel === "stderr") {
      this.store.appendEvent(runId, "terminal", {
        channel,
        executionId,
        text: redactText(text, 32 * 1024),
      });
      return;
    }
    let parser = this.claudeStreams.get(executionId);
    if (!parser) {
      if (!run.context.sessionId) {
        throw new DurableExecutionError({
          failureClass: "identity",
          message: "Claude output arrived without a server-owned native session binding.",
        });
      }
      parser = new ClaudeStreamJsonParser({ expectedSessionId: run.context.sessionId });
      this.claudeStreams.set(executionId, parser);
    }
    this.persistClaudeStreamEvents(runId, executionId, parser.push(text));
  }

  private finishProviderOutput({ runId, executionId }: WindowsJobOutputEndEvent): void {
    const run = this.store.getRun(runId);
    const stopping = run?.status === "stopping" || run?.status === "cancelled";
    const codexParser = this.codexStreams.get(executionId);
    if (codexParser) {
      try {
        if (!stopping) {
          this.persistCodexStreamEvents(runId, executionId, codexParser.finish({ requireSession: true }));
        }
      } finally {
        this.codexStreams.delete(executionId);
      }
    }
    const parser = this.claudeStreams.get(executionId);
    if (!parser) return;
    try {
      if (!stopping) this.persistClaudeStreamEvents(runId, executionId, parser.finish());
    } finally {
      this.claudeStreams.delete(executionId);
    }
  }

  private persistCodexStreamEvents(
    runId: string,
    executionId: string,
    events: readonly CodexNormalizedStreamEvent[],
  ): void {
    for (const event of events) {
      if (event.type === "session") {
        this.store.bindNativeSessionId(runId, event.sessionId);
        this.store.appendEvent(runId, "terminal", {
          channel: "metadata",
          executionId,
          nativeSessionId: event.sessionId,
        });
      } else if (event.type === "assistant") {
        this.store.appendEvent(runId, "message", {
          role: "assistant",
          executionId,
          text: redactText(event.text, 128 * 1024),
        });
      } else if (event.type === "reasoning") {
        this.store.appendEvent(runId, "reasoning", {
          executionId,
          text: redactText(event.text, 128 * 1024),
        });
      } else {
        this.store.appendEvent(runId, event.severity === "error" ? "error" : "terminal", {
          channel: event.channel,
          executionId,
          category: event.category,
          severity: event.severity,
          message: redactText(event.message, 16 * 1024),
        });
      }
    }
  }

  private persistClaudeStreamEvents(
    runId: string,
    executionId: string,
    events: readonly ClaudeNormalizedStreamEvent[],
  ): void {
    for (const event of events) {
      if (event.type === "assistant_delta") {
        this.store.appendEvent(runId, "message", {
          role: "assistant",
          executionId,
          text: redactText(event.text, 64 * 1024),
        });
      } else if (event.type === "reasoning_delta") {
        this.store.appendEvent(runId, "reasoning", {
          executionId,
          text: redactText(event.text, 64 * 1024),
        });
      } else if (event.type === "session") {
        this.store.appendEvent(runId, "terminal", {
          channel: "metadata",
          executionId,
          nativeSessionId: event.sessionId,
        });
      } else if (event.type === "result") {
        if (event.textFallback) {
          this.store.appendEvent(runId, "message", {
            role: "assistant",
            executionId,
            text: redactText(event.textFallback, 256 * 1024),
          });
        }
        this.store.appendEvent(runId, "terminal", {
          channel: "metadata",
          executionId,
          providerResult: true,
          isError: event.isError,
          nativeSessionId: event.sessionId,
          metadata: redactRecord(event.metadata),
        });
        if (event.isError) {
          const failureClass = event.failureClass ?? "permanent";
          throw new DurableExecutionError({
            failureClass,
            message: failureClass === "quota"
              ? "Claude quota is unavailable."
              : failureClass === "auth"
                ? "Claude authentication is unavailable."
                : failureClass === "rate_limit"
                  ? "Claude is rate limited."
                  : "Claude reported a failed provider result.",
          });
        }
      } else if (event.type === "fatal") {
        this.store.appendEvent(runId, "error", {
          code: event.code,
          executionId,
          message: event.message,
        });
        throw new DurableExecutionError({
          failureClass: event.failureClass,
          message: event.message,
        });
      }
    }
  }

  private async drainWorker(index: number): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    try {
      while (true) {
        const result: WorkerRunResult = await runtime.workers[index].runOnce();
        if (result.status === "idle" || result.status === "lease_lost") return;
      }
    } catch (error) {
      console.error("Durable Workbench worker failed", redactLogMessage(error));
    }
  }
}

declare global {
  // Preserve the worker pool, Job handles and database connections across HMR.
  // eslint-disable-next-line no-var
  var __agentOsDurableWorkbenchControlPlane: DurableWorkbenchControlPlane | undefined;
}

export function getDurableWorkbenchControlPlane(): DurableWorkbenchControlPlane {
  if (!globalThis.__agentOsDurableWorkbenchControlPlane) {
    globalThis.__agentOsDurableWorkbenchControlPlane = new DurableWorkbenchControlPlane();
  }
  return globalThis.__agentOsDurableWorkbenchControlPlane;
}
