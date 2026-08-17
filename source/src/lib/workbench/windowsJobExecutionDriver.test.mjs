import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";

const sourceRoot = process.cwd();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export default undefined" };
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      const candidate = decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:\/)/u, "");
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const { buildProviderChildEnvironment } = await import("../control-plane/childEnvironment.ts");
const { approveLaunchDirectory } = await import("../control-plane/runtimeContainment.ts");
const { WindowsJobContainmentError } = await import("../control-plane/windowsJobProcess.ts");
const { SqliteDurableWorkerRepository } = await import("./sqliteWorkerRepository.ts");
const { WorkbenchStore } = await import("./store.ts");
const { WindowsJobExecutionDriver } = await import("./windowsJobExecutionDriver.ts");
const { DurableExecutionError } = await import("./retryPolicy.ts");
const DRIVER_RECOVERY_SECRET = "agent-os-driver-test-recovery-secret-32-bytes";
const EMPTY_CHAIN_DIGEST_SHA256 = "0".repeat(64);

function authorizeSpawn(attempt = 1, onCall = () => undefined) {
  return async (request) => {
    onCall(request);
    return {
      ...request.identity,
      authorizationId: request.authorizationId,
      launchGeneration: request.launchGeneration,
      attempt,
      journalGeneration: request.journalGeneration,
      descriptorHmacSha256: request.descriptorHmacSha256,
      authorizedAt: "2030-01-01T00:00:00.000Z",
    };
  };
}

function sameStatusEvidence(left, right) {
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
    && left.nativeTerminalStatus === right.nativeTerminalStatus
    && left.nativeExitCode === right.nativeExitCode
    && left.terminationVerified === right.terminationVerified;
}

function chainedNonterminalEvidence(journalGeneration, sequence, previous = null) {
  const snapshotDigestSha256 = createHash("sha256")
    .update(`payload:${journalGeneration}:${sequence}`)
    .digest("hex");
  const journalDigestSha256 = createHash("sha256")
    .update(`journal:${journalGeneration}:${sequence}`)
    .digest("hex");
  return {
    journalGeneration,
    sequence,
    previousSequence: previous?.sequence ?? 0,
    previousSnapshotDigestSha256: previous?.snapshotDigestSha256 ?? EMPTY_CHAIN_DIGEST_SHA256,
    previousJournalDigestSha256: previous?.journalDigestSha256 ?? EMPTY_CHAIN_DIGEST_SHA256,
    terminal: false,
    snapshotDigestSha256,
    journalDigestSha256,
    authenticatedPayloadDigestSha256: snapshotDigestSha256,
    nativeTerminalDigestSha256: null,
    nativeTerminalState: null,
    nativeTerminalExitCode: null,
    terminationVerified: false,
    observedAt: new Date().toISOString(),
  };
}

function approvedCwd(candidate, projectId = "wave2-driver-test") {
  return approveLaunchDirectory("codex", projectId, candidate);
}

function scratch() {
  const base = path.join(os.tmpdir(), "agent-os-wave2-windows-driver-tests");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, "case-"));
}

function nodeIdentity() {
  const absolutePath = realpathSync.native(process.execPath);
  const file = statSync(absolutePath);
  const sha256 = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  const observedAt = new Date().toISOString();
  return {
    schemaVersion: 2,
    provider: "codex",
    absolutePath,
    launchPath: absolutePath,
    launchArgsPrefix: [],
    version: process.version,
    sha256,
    sizeBytes: file.size,
    modifiedAt: file.mtime.toISOString(),
    observedAt,
    files: [{
      role: "configured",
      absolutePath,
      sha256,
      sizeBytes: file.size,
      modifiedAt: file.mtime.toISOString(),
    }],
  };
}

function directCommand(id, overrides = {}) {
  return {
    id,
    runId: `run-${id}`,
    provider: "codex",
    operation: "start",
    payload: {},
    payloadHash: `sha256:${id}`,
    idempotencyKey: `key-${id}`,
    runGeneration: 0,
    runStateVersion: 0,
    executionId: `execution-${id}`,
    attempt: 1,
    maxAttempts: 3,
    checkpoint: "dequeued",
    availableAt: new Date().toISOString(),
    resources: {
      cpuTimeMs: 60_000,
      residentMemoryBytes: 512 * 1024 * 1024,
      diskBytes: 16 * 1024 * 1024,
      processCount: 4,
      outputBytes: 64 * 1024,
    },
    ...overrides,
  };
}

function identity(command) {
  return {
    executionId: command.executionId,
    commandId: command.id,
    runId: command.runId,
    jobObjectId: `agent-os-${command.executionId}`,
  };
}

function fakeWindowsJobProcess(pid, terminalResult = null, streamOptions = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let cancelled = false;
  let terminalPromise;
  let resolveTerminal;
  let currentTerminal = null;
  let sequence = 2;
  const journalGeneration = Buffer.alloc(16, Math.abs(pid) % 255).toString("base64url");
  function snapshotDigest(candidateSequence, terminal) {
    return createHash("sha256")
      .update(JSON.stringify({ pid, sequence: candidateSequence, terminal }))
      .digest("hex");
  }
  function journalDigest(candidateSequence) {
    return createHash("sha256").update(`journal:${pid}:${candidateSequence}`).digest("hex");
  }
  function evidence() {
    const digest = snapshotDigest(sequence, currentTerminal);
    const terminal = currentTerminal !== null && currentTerminal.terminationVerified === true;
    return {
      journalGeneration,
      sequence,
      previousSequence: sequence - 1,
      previousSnapshotDigestSha256: sequence === 1
        ? EMPTY_CHAIN_DIGEST_SHA256
        : snapshotDigest(sequence - 1, null),
      previousJournalDigestSha256: sequence === 1
        ? EMPTY_CHAIN_DIGEST_SHA256
        : journalDigest(sequence - 1),
      terminal,
      snapshotDigestSha256: digest,
      journalDigestSha256: journalDigest(sequence),
      authenticatedPayloadDigestSha256: digest,
      nativeTerminalDigestSha256: terminal
        ? createHash("sha256").update(JSON.stringify(currentTerminal)).digest("hex")
        : null,
      nativeTerminalState: terminal ? currentTerminal.status : null,
      nativeTerminalExitCode: terminal ? currentTerminal.exitCode : null,
      terminationVerified: terminal,
      observedAt: new Date().toISOString(),
    };
  }
  return {
    identity: {
      rootProcessId: pid,
      rootProcessStartedAtFileTime: String(133_700_000_000_000_000n + BigInt(pid)),
      jobName: `Local\\AgentOS-${pid}`,
      helperProcessId: pid - 1,
      helperProcessStartedAtFileTime: String(133_700_000_000_000_000n + BigInt(pid - 1)),
    },
    stdout,
    stderr,
    wait() {
      if (currentTerminal?.terminationVerified) return Promise.resolve(currentTerminal);
      if (!terminalResult) {
        terminalPromise ??= new Promise((resolve) => { resolveTerminal = resolve; });
        return terminalPromise;
      }
      terminalPromise ??= new Promise((resolve) => {
        setImmediate(() => {
          currentTerminal = terminalResult;
          sequence = 3;
          if (!streamOptions.keepOpenOnTerminal) {
            stdout.end();
            stderr.end();
          }
          resolve(terminalResult);
        });
      });
      return terminalPromise;
    },
    async cancel() {
      if (currentTerminal?.terminationVerified) return currentTerminal;
      if (!cancelled) {
        cancelled = true;
        currentTerminal = {
          status: "cancelled",
          exitCode: null,
          cleanup: "active_process_zero",
          terminationVerified: true,
        };
        sequence = 3;
        if (!streamOptions.keepOpenOnCancel) {
          stdout.end();
          stderr.end();
        }
        resolveTerminal?.(currentTerminal);
      }
      return currentTerminal;
    },
    async authenticatedStatusEvidence() { return evidence(); },
  };
}

function fakeRecoveredWindowsJobProcess(command, pid, terminalResult = null) {
  const processController = fakeWindowsJobProcess(pid, terminalResult);
  if (!terminalResult) {
    let resolveTerminal;
    const terminalPromise = new Promise((resolve) => { resolveTerminal = resolve; });
    const nativeCancel = processController.cancel.bind(processController);
    processController.wait = () => terminalPromise;
    processController.cancel = async () => {
      const result = await nativeCancel();
      resolveTerminal(result);
      return result;
    };
  }
  processController.identity = {
    schemaVersion: 1,
    runId: identity(command).runId,
    jobId: identity(command).jobObjectId,
    jobName: processController.identity.jobName,
    helperProcessId: processController.identity.helperProcessId,
    helperProcessStartedAtFileTime: processController.identity.helperProcessStartedAtFileTime,
    rootProcessId: processController.identity.rootProcessId,
    rootProcessStartedAtFileTime: processController.identity.rootProcessStartedAtFileTime,
    assignmentVerified: true,
  };
  processController.status = {
    schemaVersion: 1,
    sequence: 2,
    journalGeneration: Buffer.alloc(16, Math.abs(pid) % 255).toString("base64url"),
    runId: identity(command).runId,
    jobId: identity(command).jobObjectId,
    status: "ready",
    jobName: processController.identity.jobName,
    helperProcessId: processController.identity.helperProcessId,
    helperProcessStartedAtFileTime: processController.identity.helperProcessStartedAtFileTime,
    rootProcessId: processController.identity.rootProcessId,
    rootProcessStartedAtFileTime: processController.identity.rootProcessStartedAtFileTime,
    assignmentVerified: true,
    cleanup: "pending",
    terminationVerified: false,
  };
  return processController;
}

function fakeControllerRevokedWindowsJobProcess(pid) {
  const terminal = {
    status: "blocked",
    exitCode: null,
    cleanup: "no_process_created",
    terminationVerified: true,
    reason: "Authenticated controller revocation won before provider start.",
  };
  const processController = fakeWindowsJobProcess(pid, terminal);
  processController.identity = null;
  processController.status = null;
  processController.cleanupVerified = async () => true;
  return processController;
}

function recoveryRecord(command, overrides = {}) {
  const executionIdentity = identity(command);
  return {
    executionId: executionIdentity.executionId,
    commandId: executionIdentity.commandId,
    runId: executionIdentity.runId,
    jobObjectId: executionIdentity.jobObjectId,
    checkpoint: "spawn_intent",
    process: null,
    terminal: null,
    externalStatusHighWater: null,
    launchAuthorization: null,
    reconnectable: false,
    recoveryAction: "durable_terminal_probe_required",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

class FakeRecoveryRepository {
  constructor(records = [], commands = []) {
    this.records = new Map(records.map((record) => [record.executionId, record]));
    this.commands = new Map(commands.map((command) => [command.executionId, command]));
    this.loads = [];
    this.terminalWrites = [];
    this.highWaterWrites = [];
    this.highWater = new Map();
  }

  async loadExecutionCommand(executionId) {
    return this.commands.get(executionId) ?? null;
  }

  async loadExecutionRecovery(executionId) {
    this.loads.push(executionId);
    return this.records.get(executionId) ?? null;
  }

  async listExecutionRecovery() {
    return [...this.records.values()];
  }

  async acceptExternalStatusHighWater(input) {
    this.highWaterWrites.push(input);
    if (input.terminal) throw new TypeError("terminal evidence requires atomic checkpoint");
    const current = this.records.get(input.executionId);
    if (!current) return { status: "missing" };
    if (
      current.commandId !== input.commandId
      || current.runId !== input.runId
      || current.jobObjectId !== input.jobObjectId
    ) return { status: "conflict" };
    const previous = this.highWater.get(input.executionId);
    if (!previous) {
      this.highWater.set(input.executionId, { ...input });
      current.externalStatusHighWater = {
        ...input,
        chainVersion: 2,
        controllerOutcomeDigestSha256: null,
        updatedAt: input.observedAt,
      };
      return { status: "applied" };
    }
    if (
      previous.journalGeneration !== input.journalGeneration
      || input.sequence < previous.sequence
      || (input.sequence === previous.sequence && !sameStatusEvidence(previous, input))
      || (input.sequence > previous.sequence && (
        input.sequence !== previous.sequence + 1
        || input.previousSequence !== previous.sequence
        || input.previousSnapshotDigestSha256 !== previous.snapshotDigestSha256
        || input.previousJournalDigestSha256 !== previous.journalDigestSha256
      ))
      || (previous.terminal && input.sequence > previous.sequence)
    ) return { status: "conflict" };
    if (input.sequence === previous.sequence) return { status: "already_applied" };
    this.highWater.set(input.executionId, { ...input });
    current.externalStatusHighWater = {
      ...input,
      chainVersion: 2,
      controllerOutcomeDigestSha256: null,
      updatedAt: input.observedAt,
    };
    return { status: "applied" };
  }

  async recordVerifiedTerminalCheckpoint(input) {
    this.terminalWrites.push(input);
    const current = this.records.get(input.executionId);
    if (!current) return { status: "missing" };
    if (
      current.commandId !== input.commandId
      || current.runId !== input.runId
      || current.jobObjectId !== input.jobObjectId
    ) return { status: "conflict" };
    if (current.terminal) {
      return JSON.stringify(current.terminal.outcome) === JSON.stringify(input.outcome)
        && current.terminal.nativeTerminalDigestSha256 === input.statusEvidence.nativeTerminalDigestSha256
        && current.terminal.controllerOutcomeDigestSha256 === input.controllerOutcomeDigestSha256
        ? { status: "already_applied" }
        : { status: "conflict" };
    }
    const previous = this.highWater.get(input.executionId);
    if (
      !input.statusEvidence.terminal
      || !input.statusEvidence.terminationVerified
      || (previous && (
        input.statusEvidence.journalGeneration !== previous.journalGeneration
        || input.statusEvidence.sequence !== previous.sequence + 1
        || input.statusEvidence.previousSequence !== previous.sequence
        || input.statusEvidence.previousSnapshotDigestSha256 !== previous.snapshotDigestSha256
        || input.statusEvidence.previousJournalDigestSha256 !== previous.journalDigestSha256
      ))
    ) return { status: "conflict" };
    this.highWater.set(input.executionId, { ...input.statusEvidence });
    current.externalStatusHighWater = {
      ...input.statusEvidence,
      chainVersion: 2,
      controllerOutcomeDigestSha256: input.controllerOutcomeDigestSha256,
      updatedAt: input.observedAt,
    };
    current.terminal = {
      outcome: input.outcome,
      nativeTerminalDigestSha256: input.statusEvidence.nativeTerminalDigestSha256,
      controllerOutcomeDigestSha256: input.controllerOutcomeDigestSha256,
      observedAt: input.observedAt,
      terminationVerified: true,
      source: input.source,
    };
    current.recoveryAction = "terminal_replay";
    current.updatedAt = input.observedAt;
    return { status: "applied" };
  }
}

function recoveryOptions(command, recoveryRoot, repository = new FakeRecoveryRepository([
  recoveryRecord(command),
])) {
  return { recoveryRepository: repository, recoveryRoot, recoverySecret: DRIVER_RECOVERY_SECRET };
}

function durableProcess(command, pid = 72_001) {
  const executableIdentity = nodeIdentity();
  return {
    pid,
    jobObjectId: identity(command).jobObjectId,
    jobName: `Local\\AgentOS-${pid}`,
    rootProcessStartedAtFileTime: String(133_700_000_000_000_000n + BigInt(pid)),
    helperPid: pid - 1,
    helperProcessStartedAtFileTime: String(133_700_000_000_000_000n + BigInt(pid - 1)),
    executablePath: executableIdentity.launchPath,
    executableHash: executableIdentity.files[0].sha256,
    startedAt: new Date(0).toISOString(),
  };
}

function fakeDescriptorHarness(
  command,
  descriptorState = "missing",
  recoveredProcess = null,
  repository = null,
) {
  const executionIdentity = identity(command);
  const recoveryRoot = "C:\\fake-agent-os-recovery";
  const descriptorPath = `${recoveryRoot}\\${executionIdentity.jobObjectId}\\descriptor.json`;
  const claimPath = `${recoveryRoot}\\${executionIdentity.jobObjectId}\\spawn.claim.json`;
  const launchBinding = {
    launchAuthorizationId: `authorization-${command.executionId}`,
    launchGeneration: 1,
    launchAttempt: 1,
  };
  const descriptor = {
    schemaVersion: 1,
    runId: executionIdentity.runId,
    jobId: executionIdentity.jobObjectId,
    authenticationScheme: "hkdf-sha256+hmac-sha256",
    authenticationSaltBase64: Buffer.alloc(32, 1).toString("base64"),
    authenticationKeyId: "a".repeat(64),
    ...launchBinding,
    journalGeneration: Buffer.alloc(16, 1).toString("base64url"),
    createdAt: new Date(0).toISOString(),
    supervisorProcessId: process.pid,
    supervisorProcessStartedAtFileTime: "133700000000000000",
    controlDirectory: `${recoveryRoot}\\${executionIdentity.jobObjectId}`,
    descriptorPath,
    statusPath: `${recoveryRoot}\\${executionIdentity.jobObjectId}\\status.json`,
    statusJournalPath: `${recoveryRoot}\\${executionIdentity.jobObjectId}\\status.journal.jsonl`,
    cancelPath: `${recoveryRoot}\\${executionIdentity.jobObjectId}\\cancel.json`,
    inputPath: `${recoveryRoot}\\${executionIdentity.jobObjectId}\\stdin.txt`,
    outputPath: `${recoveryRoot}\\${executionIdentity.jobObjectId}\\stdout.bin`,
    errorPath: `${recoveryRoot}\\${executionIdentity.jobObjectId}\\stderr.bin`,
    claimPath,
    specificationPath: `${recoveryRoot}\\${executionIdentity.jobObjectId}\\launch-specification.json`,
    outputLimitBytes: command.resources.outputBytes,
    descriptorHmacSha256: "d".repeat(64),
  };
  let prepared = descriptorState !== "missing";
  let claimed = descriptorState === "claimed";
  const calls = [];
  const launchAuthorization = {
    ...executionIdentity,
    authorizationId: descriptor.launchAuthorizationId,
    launchGeneration: descriptor.launchGeneration,
    attempt: descriptor.launchAttempt,
    journalGeneration: descriptor.journalGeneration,
    descriptorHmacSha256: descriptor.descriptorHmacSha256,
    authorizedAt: "2030-01-01T00:00:00.000Z",
  };
  if (claimed && repository) {
    repository.records.get(command.executionId).launchAuthorization = launchAuthorization;
  }
  return {
    calls,
    descriptor,
    recoveryRoot,
    options: {
      recoveryRoot,
      recoverySecret: DRIVER_RECOVERY_SECRET,
      pathExists(candidate) {
        calls.push(["exists", candidate]);
        if (candidate === descriptorPath) return prepared;
        if (candidate === claimPath) return claimed;
        return false;
      },
      async resolveRecoveryDescriptorPath(root, runId, jobObjectId) {
        calls.push(["resolve", root, runId, jobObjectId]);
        return descriptorPath;
      },
      async prepareRecoveryDescriptor(input) {
        calls.push(["prepare", input]);
        prepared = true;
        return descriptor;
      },
      async recoverProcess(candidate, recoverySecret, acceptAuthenticatedStatus, minimumSequence) {
        calls.push(["recover", candidate, recoverySecret, minimumSequence]);
        if (!recoveredProcess) throw new Error("fake recovery process is unavailable");
        for (const evidence of recoveredProcess.replayEvidenceChain ?? []) {
          await acceptAuthenticatedStatus?.(evidence);
        }
        return recoveredProcess;
      },
      async arbitrateRecoveryDescriptor(candidate, recoverySecret, acceptAuthenticatedStatus, minimumSequence) {
        calls.push(["arbitrate", candidate, recoverySecret, minimumSequence]);
        if (!claimed || !recoveredProcess) {
          throw new WindowsJobContainmentError(
            "windows_job_termination_unverified",
            "fake unclaimed descriptor remains fail-closed",
          );
        }
        for (const evidence of recoveredProcess.replayEvidenceChain ?? []) {
          await acceptAuthenticatedStatus?.(evidence);
        }
        return { state: "helper_claimed", process: recoveredProcess };
      },
    },
    launchAuthorization,
    claim() { claimed = true; },
  };
}

function resolver(scriptPath) {
  const executableIdentity = nodeIdentity();
  return async () => ({
    provider: "codex",
    executableIdentity,
    args: [scriptPath],
    cwd: approvedCwd(path.dirname(scriptPath)),
    env: buildProviderChildEnvironment("codex"),
  });
}

async function waitForProcessExit(pid, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    try { process.kill(pid, 0); }
    catch { return; }
    if (Date.now() - started >= timeoutMs) throw new Error(`PID ${pid} remained alive`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function createStoredCommand(store, key, outputBytes = 64 * 1024) {
  return store.createRunCommand({
    adapterId: "codex",
    provider: "codex",
    context: {
      agentId: "codex",
      actorId: "codex",
      projectId: "wave2-driver-test",
      sessionId: null,
      environment: "local",
      panel: "transcript",
    },
    operation: "start",
    idempotencyKey: key,
    payload: { prompt: "safe" },
    command: {
      type: "provider.start",
      payload: {
        operation: "start",
        maxAttempts: 3,
        resources: {
          cpuTimeMs: 60_000,
          residentMemoryBytes: 512 * 1024 * 1024,
          diskBytes: 16 * 1024 * 1024,
          processCount: 4,
          outputBytes,
        },
      },
    },
  });
}

test("recovery-first spawn prepares a deterministic descriptor and preserves full native identity", async () => {
  const command = directCommand(`recovery-first-${process.pid}-${Date.now()}`);
  const executionIdentity = identity(command);
  const repository = new FakeRecoveryRepository([recoveryRecord(command)]);
  const recovery = fakeDescriptorHarness(command);
  const spawned = fakeWindowsJobProcess(72_101);
  let resolverSawRecovery = false;
  let authorizationCount = 0;
  let spawnOptions;
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    async resolveExecutionSpec() {
      resolverSawRecovery = repository.loads.length > 0;
      return {
        provider: "codex",
        executableIdentity: nodeIdentity(),
        args: [path.join(sourceRoot, "package.json")],
        cwd: approvedCwd(sourceRoot),
        env: { NO_COLOR: "1", FORCE_COLOR: "0" },
      };
    },
    async spawnProcess(_executable, _args, options) {
      spawnOptions = options;
      recovery.claim();
      return spawned;
    },
  });
  try {
    const resolution = await driver.reconcileOrSpawn(
      command,
      executionIdentity,
      new AbortController().signal,
      authorizeSpawn(1, () => { authorizationCount += 1; }),
    );
    assert.equal(resolverSawRecovery, true);
    assert.equal(repository.loads.length, 2, "association must be re-read after descriptor preparation");
    assert.equal(authorizationCount, 1);
    assert.equal(spawnOptions.recoveryDescriptor, recovery.descriptor);
    assert.equal(spawnOptions.recoverySecret, DRIVER_RECOVERY_SECRET);
    assert.equal(spawnOptions.env.AGENT_OS_WORKBENCH_RECOVERY_SECRET, undefined);
    assert.equal(resolution.state, "running");
    assert.equal(resolution.process.pid, 72_101);
    assert.equal(resolution.process.jobName, "Local\\AgentOS-72101");
    assert.equal(resolution.process.rootProcessStartedAtFileTime, String(133_700_000_000_072_101n));
    assert.equal(resolution.process.helperPid, 72_100);
    assert.equal(resolution.process.helperProcessStartedAtFileTime, String(133_700_000_000_072_100n));
    assert.deepEqual(
      recovery.calls.filter(([name]) => ["resolve", "prepare"].includes(name)).map(([name]) => name),
      ["resolve", "prepare"],
    );
  } finally {
    await driver.abortAndVerify(
      command,
      executionIdentity,
      { failureClass: "cancelled", message: "test cleanup" },
    );
  }
});

test("descriptor and authorization crash boundaries recover through one controller winner with no provider start", async (t) => {
  for (const crashBoundary of ["after_descriptor_prepared", "after_launch_authorized"]) {
    await t.test(crashBoundary, async () => {
      const command = directCommand(`controller-winner-${crashBoundary}-${process.pid}-${Date.now()}`, {
        checkpoint: "spawn_intent",
        maxAttempts: 1,
      });
      const record = recoveryRecord(command);
      const repository = new FakeRecoveryRepository([record]);
      const recovery = fakeDescriptorHarness(command, "missing", null, repository);
      let providerStarts = 0;
      let newAuthorizations = 0;
      const observedBoundaries = [];
      const authorize = async (input) => {
        assert.equal(input.authorizationId, recovery.descriptor.launchAuthorizationId);
        assert.equal(input.expectedAttempt, 1);
        if (!record.launchAuthorization) {
          newAuthorizations += 1;
          record.launchAuthorization = recovery.launchAuthorization;
        }
        return record.launchAuthorization;
      };
      const crashing = new WindowsJobExecutionDriver({
        ...recovery.options,
        recoveryRepository: repository,
        resolveExecutionSpec: resolver(path.join(sourceRoot, "package.json")),
        onLaunchBoundary(boundary) {
          observedBoundaries.push(boundary);
          if (boundary === crashBoundary) throw new Error(`injected ${boundary}`);
        },
        async spawnProcess() {
          providerStarts += 1;
          throw new Error("provider start must remain unreachable at the injected boundary");
        },
      });
      await assert.rejects(
        () => crashing.reconcileOrSpawn(
          command,
          identity(command),
          new AbortController().signal,
          authorize,
        ),
        new RegExp(`injected ${crashBoundary}`, "u"),
      );
      assert.equal(providerStarts, 0);
      assert.deepEqual(
        observedBoundaries,
        crashBoundary === "after_descriptor_prepared"
          ? ["after_descriptor_prepared"]
          : ["after_descriptor_prepared", "after_launch_authorized"],
      );
      assert.equal(newAuthorizations, crashBoundary === "after_descriptor_prepared" ? 0 : 1);

      const controller = fakeControllerRevokedWindowsJobProcess(
        crashBoundary === "after_descriptor_prepared" ? 72_201 : 72_202,
      );
      const recovering = new WindowsJobExecutionDriver({
        ...recovery.options,
        recoveryRepository: repository,
        async resolveExecutionSpec() {
          throw new Error("controller winner must complete before provider resolution");
        },
        async arbitrateRecoveryDescriptor() {
          return { state: "controller_revoked", process: controller };
        },
        async spawnProcess() {
          providerStarts += 1;
          throw new Error("controller winner must never start the provider");
        },
      });
      const resolution = await recovering.reconcileOrSpawn(
        command,
        identity(command),
        new AbortController().signal,
        authorize,
      );
      assert.equal(resolution.state, "completed_without_process");
      assert.equal(resolution.outcome.status, "blocked");
      assert.equal(resolution.outcome.metadata.cleanup, "no_process_created");
      assert.equal(providerStarts, 0);
      assert.equal(newAuthorizations, crashBoundary === "after_descriptor_prepared" ? 0 : 1);
      assert.equal(repository.terminalWrites.length, 1);
      assert.equal(repository.terminalWrites[0].source, "windows_job_controller");
    });
  }
});

test("output policy failures preserve their classification and terminate the process tree", async () => {
  const command = directCommand(`output-policy-${process.pid}-${Date.now()}`);
  const executionIdentity = identity(command);
  const repository = new FakeRecoveryRepository([recoveryRecord(command)]);
  const recovery = fakeDescriptorHarness(command);
  const spawned = fakeWindowsJobProcess(72_151);
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    resolveExecutionSpec: resolver(path.join(sourceRoot, "package.json")),
    async spawnProcess() {
      recovery.claim();
      return spawned;
    },
    onOutput() {
      throw new DurableExecutionError({
        failureClass: "policy",
        message: "Provider emitted a forbidden tool event.",
      });
    },
  });

  const resolution = await driver.reconcileOrSpawn(
    command,
    executionIdentity,
    new AbortController().signal,
    authorizeSpawn(),
  );
  assert.equal(resolution.state, "running");
  const completion = driver.waitForCompletion(
    command,
    executionIdentity,
    resolution.process,
    new AbortController().signal,
  );
  spawned.stdout.write('{"type":"tool_use"}\n');

  await assert.rejects(completion, (error) => {
    assert.equal(error instanceof DurableExecutionError, true);
    assert.equal(error.failure.failureClass, "policy");
    assert.equal(error.failure.message, "Provider emitted a forbidden tool event.");
    return true;
  });
  assert.equal((await spawned.authenticatedStatusEvidence()).terminationVerified, true);
});

async function outputFailureHarness(label, options = {}) {
  const command = directCommand(`${label}-${process.pid}-${Date.now()}-${Math.random()}`);
  const executionIdentity = identity(command);
  const repository = new FakeRecoveryRepository([recoveryRecord(command)]);
  const recovery = fakeDescriptorHarness(command);
  const spawned = fakeWindowsJobProcess(
    options.pid ?? 72_160,
    options.terminalResult ?? null,
    options.streamOptions,
  );
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    resolveExecutionSpec: resolver(path.join(sourceRoot, "package.json")),
    outputDrainTimeoutMs: options.outputDrainTimeoutMs ?? 100,
    async spawnProcess() {
      recovery.claim();
      return spawned;
    },
    onOutput: options.onOutput,
    onOutputEnd: options.onOutputEnd,
  });
  const resolution = await driver.reconcileOrSpawn(
    command,
    executionIdentity,
    new AbortController().signal,
    authorizeSpawn(),
  );
  assert.equal(resolution.state, "running");
  return {
    command,
    executionIdentity,
    repository,
    spawned,
    completion: driver.waitForCompletion(
      command,
      executionIdentity,
      resolution.process,
      new AbortController().signal,
    ),
  };
}

async function boundedRejection(promise, timeoutMs = 1_000) {
  return Promise.race([
    promise.then(
      () => { throw new Error("Expected output delivery failure."); },
      (error) => error,
    ),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("Output failure did not settle before the test deadline.")),
      timeoutMs,
    )),
  ]);
}

for (const failure of ["error", "premature_close"]) {
  test(`raw stdout ${failure} fails closed, settles once, and preserves terminal proof`, async () => {
    const harness = await outputFailureHarness(`stream-${failure}`, { pid: failure === "error" ? 72_161 : 72_162 });
    if (failure === "error") {
      harness.spawned.stdout.destroy(new Error("RAW_STREAM_SECRET_SENTINEL"));
    } else {
      harness.spawned.stdout.destroy();
    }
    const error = await boundedRejection(harness.completion);
    assert.equal(error instanceof DurableExecutionError, true);
    assert.equal(error.failure.failureClass, "permanent");
    assert.match(error.failure.message, /stdout stream closed/iu);
    assert.doesNotMatch(error.failure.message, /RAW_STREAM_SECRET_SENTINEL/u);
    assert.equal(harness.repository.terminalWrites.length, 1);
    assert.equal((await harness.spawned.authenticatedStatusEvidence()).terminationVerified, true);
  });
}

test("onOutputEnd failure is reported after exact native terminal checkpoint", async () => {
  const harness = await outputFailureHarness("output-end", {
    pid: 72_163,
    terminalResult: {
      status: "exited",
      exitCode: 0,
      cleanup: "active_process_zero",
      terminationVerified: true,
    },
    onOutputEnd() {
      throw new DurableExecutionError({
        failureClass: "policy",
        message: "Final output validation rejected the provider stream.",
      });
    },
  });
  const error = await boundedRejection(harness.completion);
  assert.equal(error instanceof DurableExecutionError, true);
  assert.equal(error.failure.failureClass, "policy");
  assert.equal(harness.repository.terminalWrites.length, 1);
  assert.equal(harness.repository.terminalWrites[0].outcome.status, "succeeded");
});

test("verified terminal state bounds wrapper streams that never close", async () => {
  const harness = await outputFailureHarness("never-close", {
    pid: 72_164,
    streamOptions: { keepOpenOnCancel: true },
    outputDrainTimeoutMs: 25,
    onOutput() {
      throw new DurableExecutionError({
        failureClass: "policy",
        message: "Provider emitted a forbidden output event.",
      });
    },
  });
  harness.spawned.stdout.write("forbidden\n");
  const error = await boundedRejection(harness.completion);
  assert.equal(error instanceof DurableExecutionError, true);
  assert.equal(error.failure.failureClass, "policy");
  assert.equal(harness.repository.terminalWrites.length, 1);
  assert.equal(harness.spawned.stdout.destroyed, true);
  assert.equal(harness.spawned.stderr.destroyed, true);
});

test("claimed durable descriptor recovers the persisted process without duplicate spawn", async () => {
  const command = directCommand(`recover-running-${process.pid}-${Date.now()}`, {
    checkpoint: "spawn_intent",
  });
  const processIdentity = durableProcess(command, 72_201);
  const repository = new FakeRecoveryRepository([
    recoveryRecord(command, { checkpoint: "registered", process: processIdentity }),
  ]);
  const recovered = fakeRecoveredWindowsJobProcess(command, 72_201);
  const recovery = fakeDescriptorHarness(command, "claimed", recovered, repository);
  let spawnCount = 0;
  let authorizationCount = 0;
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    resolveExecutionSpec: resolver(path.join(sourceRoot, "package.json")),
    async spawnProcess() {
      spawnCount += 1;
      throw new Error("duplicate spawn must not be reached");
    },
  });
  try {
    const resolution = await driver.reconcileOrSpawn(
      command,
      identity(command),
      new AbortController().signal,
      authorizeSpawn(1, () => { authorizationCount += 1; }),
    );
    assert.equal(resolution.state, "running");
    assert.deepEqual(resolution.process, processIdentity);
    assert.equal(spawnCount, 0);
    assert.equal(authorizationCount, 1);
    assert.equal(recovery.calls.filter(([name]) => name === "arbitrate").length, 1);
  } finally {
    await driver.abortAndVerify(
      command,
      identity(command),
      { failureClass: "cancelled", message: "test cleanup" },
    );
  }
});

test("claimed recovery tries the primary key before one retained legacy key without spawning", async () => {
  const command = directCommand(`recover-legacy-key-${process.pid}-${Date.now()}`, {
    checkpoint: "spawn_intent",
  });
  const processIdentity = durableProcess(command, 72_221);
  const repository = new FakeRecoveryRepository([
    recoveryRecord(command, { checkpoint: "registered", process: processIdentity }),
  ]);
  const recovered = fakeRecoveredWindowsJobProcess(command, 72_221);
  const recovery = fakeDescriptorHarness(command, "claimed", recovered, repository);
  const legacySecret = "agent-os-driver-retained-legacy-secret-32-bytes";
  const attemptedSecrets = [];
  let spawnCount = 0;
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    recoverySecrets: [legacySecret],
    resolveExecutionSpec: resolver(path.join(sourceRoot, "package.json")),
    async arbitrateRecoveryDescriptor(_descriptorPath, recoverySecret, acceptAuthenticatedStatus) {
      attemptedSecrets.push(recoverySecret);
      if (recoverySecret === DRIVER_RECOVERY_SECRET) {
        throw new WindowsJobContainmentError(
          "windows_job_invalid_specification",
          "descriptor belongs to a retained legacy key",
        );
      }
      assert.equal(recoverySecret, legacySecret);
      for (const evidence of recovered.replayEvidenceChain ?? []) {
        await acceptAuthenticatedStatus?.(evidence);
      }
      return { state: "helper_claimed", process: recovered };
    },
    async spawnProcess() {
      spawnCount += 1;
      throw new Error("legacy recovery must not spawn a replacement provider");
    },
  });
  try {
    const resolution = await driver.reconcileOrSpawn(
      command,
      identity(command),
      new AbortController().signal,
      authorizeSpawn(),
    );
    assert.equal(resolution.state, "running");
    assert.deepEqual(attemptedSecrets, [DRIVER_RECOVERY_SECRET, legacySecret]);
    assert.equal(spawnCount, 0);
  } finally {
    await driver.abortAndVerify(
      command,
      identity(command),
      { failureClass: "cancelled", message: "test cleanup" },
    );
  }
});

test("cancel recovers its active target from durable identity after driver restart without replacement spawn", async () => {
  const start = directCommand(`restart-cancel-target-${process.pid}-${Date.now()}`, {
    checkpoint: "registered",
  });
  const processIdentity = durableProcess(start, 72_251);
  const repository = new FakeRecoveryRepository([
    recoveryRecord(start, { checkpoint: "registered", process: processIdentity }),
  ], [start]);
  const recovered = fakeRecoveredWindowsJobProcess(start, 72_251);
  let resolveTerminal;
  recovered.wait = () => new Promise((resolve) => { resolveTerminal = resolve; });
  const nativeCancel = recovered.cancel.bind(recovered);
  recovered.cancel = async () => {
    const result = await nativeCancel();
    resolveTerminal(result);
    return result;
  };
  const recovery = fakeDescriptorHarness(start, "claimed", recovered, repository);
  let spawnCount = 0;
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    resolveExecutionSpec: resolver(path.join(sourceRoot, "package.json")),
    async spawnProcess() {
      spawnCount += 1;
      throw new Error("cancel recovery must never spawn a replacement provider");
    },
  });
  const cancel = directCommand(`restart-cancel-control-${process.pid}-${Date.now()}`, {
    runId: start.runId,
    provider: start.provider,
    operation: "cancel",
    payload: {
      targetExecutionId: start.executionId,
      targetJobObjectId: identity(start).jobObjectId,
    },
  });
  const outcome = await driver.executeControl(cancel, identity(cancel), new AbortController().signal);
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.metadata.terminationVerified, true);
  assert.equal(spawnCount, 0);
  assert.equal(recovery.calls.filter(([name]) => name === "arbitrate").length, 1);
  assert.equal(repository.terminalWrites.length, 1);

  const timeoutRecoveryDriver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    resolveExecutionSpec: resolver(path.join(sourceRoot, "package.json")),
    async spawnProcess() {
      assert.fail("timeout abort recovery must never spawn a replacement provider");
    },
  });
  assert.equal(
    await timeoutRecoveryDriver.abortAndVerify(
      cancel,
      identity(cancel),
      { failureClass: "timeout", message: "cancel delivery timed out" },
    ),
    true,
    "cancel timeout must resolve and verify the payload target, not the cancel command execution",
  );
  const mismatched = { ...cancel, runId: `${cancel.runId}-other` };
  assert.equal(
    await timeoutRecoveryDriver.abortAndVerify(
      mismatched,
      identity(mismatched),
      { failureClass: "timeout", message: "mismatched cancel" },
    ),
    false,
  );
  const recoveryCallsBeforeGenerationMismatch = recovery.calls.length;
  const mismatchedGeneration = { ...cancel, runGeneration: cancel.runGeneration + 1 };
  assert.equal(
    await timeoutRecoveryDriver.abortAndVerify(
      mismatchedGeneration,
      identity(mismatchedGeneration),
      { failureClass: "timeout", message: "mismatched generation" },
    ),
    false,
  );
  assert.equal(recovery.calls.length, recoveryCallsBeforeGenerationMismatch);
});

test("cancel target at dequeued checkpoint retries without descriptor or native side effects", async () => {
  const start = directCommand(`dequeued-cancel-target-${process.pid}-${Date.now()}`);
  const targetIdentity = identity(start);
  const repository = new FakeRecoveryRepository([
    recoveryRecord(start, { checkpoint: "dequeued" }),
  ], [start]);
  const recoveryRoot = mkdtempSync(path.join(os.tmpdir(), "agent-os-dequeued-cancel-"));
  const targetControlDirectory = path.join(recoveryRoot, targetIdentity.jobObjectId);
  const calls = {
    resolveDescriptor: 0,
    prepareDescriptor: 0,
    recover: 0,
    spawn: 0,
    resolveSpec: 0,
  };
  const driver = new WindowsJobExecutionDriver({
    recoveryRepository: repository,
    recoveryRoot,
    recoverySecret: DRIVER_RECOVERY_SECRET,
    async resolveExecutionSpec() {
      calls.resolveSpec += 1;
      throw new Error("dequeued cancel recovery must not resolve provider execution");
    },
    async resolveRecoveryDescriptorPath() {
      calls.resolveDescriptor += 1;
      return path.join(targetControlDirectory, "descriptor.json");
    },
    async prepareRecoveryDescriptor() {
      calls.prepareDescriptor += 1;
      mkdirSync(targetControlDirectory, { recursive: true });
      throw new Error("dequeued cancel recovery must not prepare a descriptor");
    },
    async recoverProcess() {
      calls.recover += 1;
      throw new Error("dequeued cancel recovery must not recover a native process");
    },
    async spawnProcess() {
      calls.spawn += 1;
      throw new Error("dequeued cancel recovery must not spawn a provider");
    },
  });
  const cancel = directCommand(`dequeued-cancel-control-${process.pid}-${Date.now()}`, {
    runId: start.runId,
    provider: start.provider,
    operation: "cancel",
    payload: {
      targetExecutionId: start.executionId,
      targetJobObjectId: targetIdentity.jobObjectId,
    },
  });

  try {
    await assert.rejects(
      () => driver.executeControl(cancel, identity(cancel), new AbortController().signal),
      (error) => error.failure?.failureClass === "transient"
        && /not reached durable spawn intent/iu.test(error.message),
    );
    assert.deepEqual(calls, {
      resolveDescriptor: 0,
      prepareDescriptor: 0,
      recover: 0,
      spawn: 0,
      resolveSpec: 0,
    });
    assert.equal(existsSync(targetControlDirectory), false);
  } finally {
    rmSync(recoveryRoot, { recursive: true, force: true });
  }
});

test("verified durable terminal checkpoint replays without provider resolution or spawn", async () => {
  const command = directCommand(`recover-terminal-${process.pid}-${Date.now()}`, {
    checkpoint: "registered",
  });
  const outcome = {
    status: "blocked",
    exitCode: null,
    errorCode: "windows_job_parent_exited",
    errorMessage: "Control-plane parent exited before completion.",
    metadata: { terminationVerified: true, cleanup: "active_process_zero" },
  };
  const processIdentity = durableProcess(command, 72_301);
  const repository = new FakeRecoveryRepository([
    recoveryRecord(command, {
      checkpoint: "registered",
      process: processIdentity,
      terminal: {
        outcome,
        observedAt: new Date().toISOString(),
        terminationVerified: true,
        source: "windows_job_helper",
      },
      recoveryAction: "terminal_replay",
    }),
  ]);
  let resolverCount = 0;
  let spawnCount = 0;
  let authorizationCount = 0;
  const driver = new WindowsJobExecutionDriver({
    recoveryRepository: repository,
    recoveryRoot: "C:\\fake-agent-os-recovery",
    recoverySecret: DRIVER_RECOVERY_SECRET,
    async resolveExecutionSpec() {
      resolverCount += 1;
      throw new Error("terminal replay must not resolve a provider");
    },
    async spawnProcess() {
      spawnCount += 1;
      throw new Error("terminal replay must not spawn");
    },
  });
  const resolution = await driver.reconcileOrSpawn(
    command,
    identity(command),
    new AbortController().signal,
    authorizeSpawn(1, () => { authorizationCount += 1; }),
  );
  assert.deepEqual(resolution, { state: "completed", process: processIdentity, outcome });
  assert.equal(resolverCount, 0);
  assert.equal(spawnCount, 0);
  assert.equal(authorizationCount, 0);
});

test("post-intent redelivery with no descriptor safely prepares and authorizes exactly one spawn", async () => {
  const command = directCommand(`missing-descriptor-${process.pid}-${Date.now()}`, {
    checkpoint: "spawn_intent",
  });
  const repository = new FakeRecoveryRepository([recoveryRecord(command)]);
  const recovery = fakeDescriptorHarness(command, "missing");
  let resolverCount = 0;
  let spawnCount = 0;
  let authorizationCount = 0;
  const spawned = fakeWindowsJobProcess(72_350);
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    async resolveExecutionSpec() {
      resolverCount += 1;
      return resolver(path.join(sourceRoot, "package.json"))();
    },
    async spawnProcess() {
      spawnCount += 1;
      recovery.claim();
      return spawned;
    },
  });
  const resolution = await driver.reconcileOrSpawn(
    command,
    identity(command),
    new AbortController().signal,
    authorizeSpawn(1, () => { authorizationCount += 1; }),
  );
  assert.equal(resolution.state, "running");
  assert.equal(resolverCount, 1);
  assert.equal(spawnCount, 1);
  assert.equal(authorizationCount, 1);
  await driver.abortAndVerify(
    command,
    identity(command),
    { failureClass: "cancelled", message: "test cleanup" },
  );
});

test("claimed descriptor reconstructs full identity when durable observation was interrupted", async () => {
  const command = directCommand(`missing-process-identity-${process.pid}-${Date.now()}`, {
    checkpoint: "spawn_intent",
  });
  const repository = new FakeRecoveryRepository([recoveryRecord(command)]);
  const recovered = fakeRecoveredWindowsJobProcess(command, 72_401);
  const recovery = fakeDescriptorHarness(command, "claimed", recovered, repository);
  let spawnCount = 0;
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    resolveExecutionSpec: resolver(path.join(sourceRoot, "package.json")),
    async spawnProcess() {
      spawnCount += 1;
      throw new Error("recovered native identity must never respawn");
    },
  });
  const resolution = await driver.reconcileOrSpawn(
    command,
    identity(command),
    new AbortController().signal,
    authorizeSpawn(),
  );
  assert.equal(resolution.state, "running");
  assert.equal(resolution.process.pid, 72_401);
  assert.equal(resolution.process.jobName, recovered.identity.jobName);
  assert.equal(
    resolution.process.rootProcessStartedAtFileTime,
    recovered.identity.rootProcessStartedAtFileTime,
  );
  assert.equal(resolution.process.helperPid, recovered.identity.helperProcessId);
  assert.equal(
    resolution.process.helperProcessStartedAtFileTime,
    recovered.identity.helperProcessStartedAtFileTime,
  );
  assert.equal(spawnCount, 0);
  assert.equal(recovery.calls.filter(([name]) => name === "arbitrate").length, 1);
  await driver.abortAndVerify(
    command,
    identity(command),
    { failureClass: "cancelled", message: "test cleanup" },
  );
});

test("claimed recovery persists authenticated high-water before provider resolution or tracking", async () => {
  const command = directCommand(`high-water-ordering-${process.pid}-${Date.now()}`, {
    checkpoint: "spawn_intent",
  });
  const repository = new FakeRecoveryRepository([recoveryRecord(command)]);
  const recovered = fakeRecoveredWindowsJobProcess(command, 72_450);
  const recovery = fakeDescriptorHarness(command, "claimed", recovered, repository);
  let resolverCount = 0;
  let spawnCount = 0;
  repository.acceptExternalStatusHighWater = async (input) => {
    repository.highWaterWrites.push(input);
    return { status: "conflict" };
  };
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    async resolveExecutionSpec() {
      resolverCount += 1;
      throw new Error("provider resolution must follow accepted authenticated high-water");
    },
    async spawnProcess() {
      spawnCount += 1;
      throw new Error("claimed recovery must never spawn");
    },
  });

  await assert.rejects(
    () => driver.reconcileOrSpawn(command, identity(command), new AbortController().signal, authorizeSpawn()),
    (error) => error.failure?.failureClass === "containment"
      && /status high-water was rejected as conflict/iu.test(error.message),
  );
  assert.equal(repository.highWaterWrites.length, 1);
  assert.equal(resolverCount, 0);
  assert.equal(spawnCount, 0);
});

test("claimed recovery replays every authenticated entry after the durable high-water in order", async () => {
  const command = directCommand(`high-water-replay-${process.pid}-${Date.now()}`, {
    checkpoint: "spawn_intent",
  });
  const journalGeneration = Buffer.alloc(16, 91).toString("base64url");
  const first = chainedNonterminalEvidence(journalGeneration, 1);
  const second = chainedNonterminalEvidence(journalGeneration, 2, first);
  const third = chainedNonterminalEvidence(journalGeneration, 3, second);
  const persisted = {
    ...identity(command),
    ...first,
    nativeTerminalStatus: null,
    nativeExitCode: null,
    chainVersion: 2,
    controllerOutcomeDigestSha256: null,
    updatedAt: first.observedAt,
  };
  const repository = new FakeRecoveryRepository([
    recoveryRecord(command, { externalStatusHighWater: persisted }),
  ]);
  repository.highWater.set(command.executionId, { ...persisted });
  const recovered = fakeRecoveredWindowsJobProcess(command, 72_460);
  recovered.replayEvidenceChain = [first, second, third];
  recovered.authenticatedStatusEvidence = async () => third;
  const recovery = fakeDescriptorHarness(command, "claimed", recovered, repository);
  let authorizationCount = 0;
  let spawnCount = 0;
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    resolveExecutionSpec: resolver(path.join(sourceRoot, "package.json")),
    async spawnProcess() {
      spawnCount += 1;
      throw new Error("authenticated recovery replay must never respawn");
    },
  });

  const resolution = await driver.reconcileOrSpawn(
    command,
    identity(command),
    new AbortController().signal,
    authorizeSpawn(1, () => { authorizationCount += 1; }),
  );
  assert.equal(resolution.state, "running");
  assert.deepEqual(repository.highWaterWrites.map((evidence) => evidence.sequence), [2, 3]);
  assert.equal(recovery.calls.find(([name]) => name === "arbitrate")?.[3], 1);
  assert.equal(authorizationCount, 1);
  assert.equal(spawnCount, 0);
});

test("invalid durable descriptor fails closed without resolver or spawn fallback", async () => {
  const command = directCommand(`invalid-descriptor-${process.pid}-${Date.now()}`, {
    checkpoint: "spawn_intent",
  });
  const repository = new FakeRecoveryRepository([
    recoveryRecord(command, { checkpoint: "registered", process: durableProcess(command, 72_451) }),
  ]);
  const recovery = fakeDescriptorHarness(
    command,
    "claimed",
    fakeRecoveredWindowsJobProcess(command, 72_451),
    repository,
  );
  let resolverCount = 0;
  let spawnCount = 0;
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    async prepareRecoveryDescriptor() {
      throw new Error("descriptor integrity mismatch");
    },
    async resolveExecutionSpec() {
      resolverCount += 1;
      throw new Error("invalid descriptor must fail before provider resolution");
    },
    async spawnProcess() {
      spawnCount += 1;
      throw new Error("invalid descriptor must never respawn");
    },
  });
  await assert.rejects(
    () => driver.reconcileOrSpawn(command, identity(command), new AbortController().signal, authorizeSpawn()),
    (error) => error.failure?.failureClass === "containment"
      && /could not be prepared or verified/iu.test(error.message),
  );
  assert.equal(resolverCount, 0);
  assert.equal(spawnCount, 0);
});

test("persisted process evidence with an unclaimed descriptor never falls back to spawn", async () => {
  const command = directCommand(`unclaimed-conflict-${process.pid}-${Date.now()}`, {
    checkpoint: "registered",
  });
  const repository = new FakeRecoveryRepository([
    recoveryRecord(command, { checkpoint: "registered", process: durableProcess(command, 72_475) }),
  ]);
  const recovery = fakeDescriptorHarness(command, "prepared");
  let resolverCount = 0;
  let spawnCount = 0;
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    async resolveExecutionSpec() {
      resolverCount += 1;
      throw new Error("conflicting durable evidence must fail before provider resolution");
    },
    async spawnProcess() {
      spawnCount += 1;
      throw new Error("conflicting durable evidence must never respawn");
    },
  });
  await assert.rejects(
    () => driver.reconcileOrSpawn(command, identity(command), new AbortController().signal, authorizeSpawn()),
    (error) => error.failure?.failureClass === "containment"
      && /claim arbitration failed/iu.test(error.message),
  );
  assert.equal(resolverCount, 0);
  assert.equal(spawnCount, 0);
});

test("restart with an existing unclaimed descriptor fails closed without a disk-replay spawn", async () => {
  const command = directCommand(`unclaimed-restart-${process.pid}-${Date.now()}`, {
    checkpoint: "spawn_intent",
  });
  const repository = new FakeRecoveryRepository([recoveryRecord(command)]);
  const recovery = fakeDescriptorHarness(command, "prepared");
  let resolverCount = 0;
  let spawnCount = 0;
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    async resolveExecutionSpec() {
      resolverCount += 1;
      throw new Error("ambiguous descriptor must fail before provider resolution");
    },
    async spawnProcess() {
      spawnCount += 1;
      throw new Error("disk state must not grant a new spawn capability");
    },
  });
  await assert.rejects(
    () => driver.reconcileOrSpawn(command, identity(command), new AbortController().signal, authorizeSpawn()),
    (error) => error.failure?.failureClass === "containment"
      && /claim arbitration failed/iu.test(error.message),
  );
  assert.equal(resolverCount, 0);
  assert.equal(spawnCount, 0);
});

test("verified helper terminal result is durably checkpointed before worker completion", async () => {
  const command = directCommand(`terminal-checkpoint-${process.pid}-${Date.now()}`);
  const repository = new FakeRecoveryRepository([recoveryRecord(command)]);
  const recovery = fakeDescriptorHarness(command);
  const spawned = fakeWindowsJobProcess(72_501, {
    status: "exited",
    exitCode: 0,
    cleanup: "active_process_zero",
    terminationVerified: true,
  });
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    resolveExecutionSpec: resolver(path.join(sourceRoot, "package.json")),
    async spawnProcess() {
      recovery.claim();
      return spawned;
    },
  });
  const resolution = await driver.reconcileOrSpawn(
    command,
    identity(command),
    new AbortController().signal,
    authorizeSpawn(),
  );
  const outcome = await driver.waitForCompletion(
    command,
    identity(command),
    resolution.process,
    new AbortController().signal,
  );
  assert.equal(outcome.status, "succeeded");
  assert.equal(repository.terminalWrites.length, 1);
  assert.equal(repository.terminalWrites[0].source, "windows_job_helper");
  assert.equal(repository.terminalWrites[0].terminationVerified, true);
  assert.deepEqual(repository.terminalWrites[0].outcome, outcome);
});

test("native terminal evidence that disagrees with the deterministic controller mapping is rejected", async () => {
  const command = directCommand(`terminal-mismatch-${process.pid}-${Date.now()}`);
  const repository = new FakeRecoveryRepository([recoveryRecord(command)]);
  const recovery = fakeDescriptorHarness(command);
  const spawned = fakeWindowsJobProcess(72_525, {
    status: "exited",
    exitCode: 0,
    cleanup: "active_process_zero",
    terminationVerified: true,
  });
  const authenticatedStatusEvidence = spawned.authenticatedStatusEvidence.bind(spawned);
  spawned.authenticatedStatusEvidence = async () => {
    const evidence = await authenticatedStatusEvidence();
    return evidence.terminal
      ? { ...evidence, nativeTerminalState: "cancelled", nativeTerminalExitCode: null }
      : evidence;
  };
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    resolveExecutionSpec: resolver(path.join(sourceRoot, "package.json")),
    async spawnProcess() {
      recovery.claim();
      return spawned;
    },
  });
  const resolution = await driver.reconcileOrSpawn(
    command,
    identity(command),
    new AbortController().signal,
    authorizeSpawn(),
  );
  await assert.rejects(
    driver.waitForCompletion(
      command,
      identity(command),
      resolution.process,
      new AbortController().signal,
    ),
    (error) => error.failure?.failureClass === "containment"
      && /does not match deterministic controller outcome mapping/iu.test(error.message),
  );
  assert.equal(repository.terminalWrites.length, 0);
});

test("verified terminal status recovered from disk returns completed before worker registration", async () => {
  const command = directCommand(`recovered-terminal-status-${process.pid}-${Date.now()}`, {
    checkpoint: "spawn_intent",
  });
  const repository = new FakeRecoveryRepository([recoveryRecord(command)]);
  const terminalResult = {
    status: "blocked",
    exitCode: null,
    cleanup: "active_process_zero",
    terminationVerified: true,
    reason: "Control-plane parent exited before completion.",
  };
  const recovered = fakeRecoveredWindowsJobProcess(command, 72_551, terminalResult);
  recovered.status = {
    ...recovered.status,
    status: "blocked",
    exitCode: null,
    cleanup: "active_process_zero",
    terminationVerified: true,
    reason: terminalResult.reason,
  };
  const recovery = fakeDescriptorHarness(command, "claimed", recovered, repository);
  let spawnCount = 0;
  let authorizationCount = 0;
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    resolveExecutionSpec: resolver(path.join(sourceRoot, "package.json")),
    async spawnProcess() {
      spawnCount += 1;
      throw new Error("verified recovered terminal status must never respawn");
    },
  });
  const resolution = await driver.reconcileOrSpawn(
    command,
    identity(command),
    new AbortController().signal,
    authorizeSpawn(1, () => { authorizationCount += 1; }),
  );
  assert.equal(resolution.state, "completed");
  assert.equal(resolution.outcome.status, "blocked");
  assert.equal(resolution.process.pid, 72_551);
  assert.equal(repository.terminalWrites.length, 1);
  assert.equal(spawnCount, 0);
  assert.equal(authorizationCount, 1);
  assert.equal(
    recovery.calls.find(([name]) => name === "arbitrate")?.[2],
    DRIVER_RECOVERY_SECRET,
  );
});

test("concrete Windows driver reconciles one stable job and captures bounded redacted output", {
  skip: process.platform !== "win32",
  timeout: 45_000,
}, async () => {
  const root = scratch();
  const script = path.join(root, "natural.mjs");
  const sideEvidence = path.join(root, "natural-ran.txt");
  writeFileSync(
    script,
    `import { fstatSync, writeFileSync, writeSync } from "node:fs"; const stat = fstatSync(1); const written = writeSync(1, "driver-output\\n"); writeFileSync(${JSON.stringify(sideEvidence)}, JSON.stringify({ written, isFile: stat.isFile(), isFIFO: stat.isFIFO(), isCharacterDevice: stat.isCharacterDevice() }));\n`,
    "utf8",
  );
  const command = directCommand(`natural-${process.pid}-${Date.now()}`);
  const executionIdentity = identity(command);
  const driver = new WindowsJobExecutionDriver({
    ...recoveryOptions(command, root),
    resolveExecutionSpec: resolver(script),
  });
  try {
    const first = await driver.reconcileOrSpawn(
      command,
      executionIdentity,
      new AbortController().signal,
      authorizeSpawn(),
    );
    assert.equal(first.state, "running");
    const second = await driver.reconcileOrSpawn(
      command,
      executionIdentity,
      new AbortController().signal,
      authorizeSpawn(1, () => assert.fail("tracked recovery must not authorize another spawn")),
    );
    assert.equal(second.process.pid, first.process.pid);
    const outcome = await driver.waitForCompletion(
      command,
      executionIdentity,
      first.process,
      new AbortController().signal,
    );
    assert.equal(outcome.status, "succeeded");
    const side = JSON.parse(readFileSync(sideEvidence, "utf8"));
    assert.equal(side.written, 14);
    assert.equal(side.isFile, false);
    assert.equal(side.isFIFO, false);
    assert.equal(side.isCharacterDevice, false);
    assert.equal(outcome.metadata.terminationVerified, true);
    assert.match(outcome.metadata.stdoutPreview, /driver-output/u, JSON.stringify(side));
    const completed = await driver.reconcileOrSpawn(
      command,
      executionIdentity,
      new AbortController().signal,
      authorizeSpawn(1, () => assert.fail("terminal replay must not authorize another spawn")),
    );
    assert.equal(completed.state, "completed");
    assert.equal(completed.process.pid, first.process.pid);
    await waitForProcessExit(first.process.pid);
  } finally {
    await driver.abortAndVerify(
      command,
      executionIdentity,
      { failureClass: "cancelled", message: "test cleanup" },
    ).catch(() => false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcileOrSpawn single-flights concurrent calls for the same stable Windows Job", async () => {
  const command = directCommand(`single-flight-${process.pid}-${Date.now()}`);
  const executionIdentity = identity(command);
  const executableIdentity = nodeIdentity();
  let releaseResolver;
  const resolverGate = new Promise((resolve) => { releaseResolver = resolve; });
  let resolverCount = 0;
  let spawnCount = 0;
  let authorizationCount = 0;
  const spawned = fakeWindowsJobProcess(71_001);
  const repository = new FakeRecoveryRepository([recoveryRecord(command)]);
  const recovery = fakeDescriptorHarness(command);
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    async resolveExecutionSpec() {
      resolverCount += 1;
      await resolverGate;
      return {
        provider: "codex",
        executableIdentity,
        args: [path.join(sourceRoot, "package.json")],
        cwd: approvedCwd(sourceRoot),
        env: { NO_COLOR: "1", FORCE_COLOR: "0" },
      };
    },
    async spawnProcess(_executable, _args, options) {
      spawnCount += 1;
      assert.equal(options.env.NO_COLOR, "1");
      assert.equal(options.env.FORCE_COLOR, "0");
      assert.deepEqual(options.expectedExecutableFiles, executableIdentity.files.map((file) => ({
        role: file.role,
        absolutePath: file.absolutePath,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      })));
      await new Promise((resolve) => setImmediate(resolve));
      return spawned;
    },
  });
  const first = driver.reconcileOrSpawn(
    command,
    executionIdentity,
    new AbortController().signal,
    authorizeSpawn(1, () => { authorizationCount += 1; }),
  );
  const second = driver.reconcileOrSpawn(
    command,
    executionIdentity,
    new AbortController().signal,
    authorizeSpawn(1, () => { authorizationCount += 1; }),
  );
  releaseResolver();
  try {
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(resolverCount, 1);
    assert.equal(spawnCount, 1);
    assert.equal(authorizationCount, 1);
    assert.deepEqual(secondResult, firstResult);
    assert.equal(firstResult.state, "running");
    assert.equal(firstResult.process.pid, 71_001);
  } finally {
    await driver.abortAndVerify(
      command,
      executionIdentity,
      { failureClass: "cancelled", message: "test cleanup" },
    );
  }
});

test("environment revalidation accepts only canonical color controls", async () => {
  const command = directCommand(`color-environment-${process.pid}-${Date.now()}`);
  const executionIdentity = identity(command);
  const executableIdentity = nodeIdentity();
  const spawned = fakeWindowsJobProcess(71_002);
  let spawnCount = 0;
  const repository = new FakeRecoveryRepository([recoveryRecord(command)]);
  const recovery = fakeDescriptorHarness(command);
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    async resolveExecutionSpec() {
      return {
        provider: "codex",
        executableIdentity,
        args: [path.join(sourceRoot, "package.json")],
        cwd: approvedCwd(sourceRoot),
        env: { NO_COLOR: "1", FORCE_COLOR: "0" },
      };
    },
    async spawnProcess(_executable, _args, options) {
      spawnCount += 1;
      assert.equal(options.env.NO_COLOR, "1");
      assert.equal(options.env.FORCE_COLOR, "0");
      assert.deepEqual(
        Object.keys(options.env).filter((key) => key.startsWith("CUSTOM_")),
        [],
      );
      return spawned;
    },
  });
  try {
    const result = await driver.reconcileOrSpawn(
      command,
      executionIdentity,
      new AbortController().signal,
      authorizeSpawn(),
    );
    assert.equal(result.state, "running");
    assert.equal(spawnCount, 1);
  } finally {
    await driver.abortAndVerify(
      command,
      executionIdentity,
      { failureClass: "cancelled", message: "test cleanup" },
    );
  }
});

test("driver re-applies the provider environment allowlist before spawn", async () => {
  const command = directCommand(`environment-${process.pid}-${Date.now()}`);
  const executableIdentity = nodeIdentity();
  let spawnCount = 0;
  const repository = new FakeRecoveryRepository([recoveryRecord(command)]);
  const recovery = fakeDescriptorHarness(command);
  const driver = new WindowsJobExecutionDriver({
    ...recovery.options,
    recoveryRepository: repository,
    async resolveExecutionSpec() {
      return {
        provider: "codex",
        executableIdentity,
        args: [path.join(sourceRoot, "package.json")],
        cwd: approvedCwd(sourceRoot),
        env: {
          ...buildProviderChildEnvironment("codex"),
          CUSTOM_UNVERIFIED_ENVIRONMENT: "denied",
        },
      };
    },
    async spawnProcess() {
      spawnCount += 1;
      throw new Error("spawn must not be reached");
    },
  });
  await assert.rejects(
    () => driver.reconcileOrSpawn(command, identity(command), new AbortController().signal, authorizeSpawn()),
    (error) => error.code === "forbidden_provider_environment",
  );
  assert.equal(spawnCount, 0);
});

test("output quota terminates the complete Windows Job process tree", {
  skip: process.platform !== "win32",
  timeout: 45_000,
}, async () => {
  const root = scratch();
  const script = path.join(root, "overflow.mjs");
  writeFileSync(
    script,
    'import { writeSync } from "node:fs"; writeSync(1, Buffer.alloc(32768, "x")); setInterval(() => {}, 1000);\n',
    "utf8",
  );
  const command = directCommand(`overflow-${process.pid}-${Date.now()}`, {
    resources: { ...directCommand("defaults").resources, outputBytes: 1024 },
  });
  const executionIdentity = identity(command);
  const driver = new WindowsJobExecutionDriver({
    ...recoveryOptions(command, root),
    resolveExecutionSpec: resolver(script),
  });
  try {
    const resolution = await driver.reconcileOrSpawn(
      command,
      executionIdentity,
      new AbortController().signal,
      authorizeSpawn(),
    );
    const outcome = await driver.waitForCompletion(
      command,
      executionIdentity,
      resolution.process,
      new AbortController().signal,
    );
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.errorCode, "resource_exhausted");
    assert.equal(outcome.metadata.outputLimitExceeded, true);
    assert.equal(outcome.metadata.terminationVerified, true);
    assert.equal(outcome.metadata.cleanup, "active_process_zero");
    await waitForProcessExit(resolution.process.pid);
  } finally {
    await driver.abortAndVerify(
      command,
      executionIdentity,
      { failureClass: "cancelled", message: "test cleanup" },
    ).catch(() => false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancel control reports success only after ACTIVE_PROCESS_ZERO", {
  skip: process.platform !== "win32",
  timeout: 45_000,
}, async () => {
  const root = scratch();
  const script = path.join(root, "cancel.mjs");
  writeFileSync(script, 'setInterval(() => {}, 1000);\n', "utf8");
  const start = directCommand(`cancel-target-${process.pid}-${Date.now()}`);
  const targetIdentity = identity(start);
  const driver = new WindowsJobExecutionDriver({
    ...recoveryOptions(start, root),
    resolveExecutionSpec: resolver(script),
  });
  try {
    const resolution = await driver.reconcileOrSpawn(
      start,
      targetIdentity,
      new AbortController().signal,
      authorizeSpawn(),
    );
    const cancel = directCommand(`cancel-control-${process.pid}-${Date.now()}`, {
      runId: start.runId,
      provider: start.provider,
      operation: "cancel",
      payload: {
        targetExecutionId: targetIdentity.executionId,
        targetJobObjectId: targetIdentity.jobObjectId,
      },
    });
    const outcome = await driver.executeControl(cancel, identity(cancel), new AbortController().signal);
    assert.equal(outcome.status, "cancelled");
    assert.equal(outcome.metadata.terminationVerified, true);
    assert.equal(outcome.metadata.cleanup, "active_process_zero");
    await waitForProcessExit(resolution.process.pid);
  } finally {
    await driver.abortAndVerify(
      start,
      targetIdentity,
      { failureClass: "cancelled", message: "test cleanup" },
    ).catch(() => false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-process crash recovery at every durable boundary creates one spawn and zero active orphans", {
  skip: process.platform !== "win32",
  timeout: 240_000,
}, async () => {
  const fixture = path.join(
    sourceRoot,
    "src",
    "lib",
    "workbench",
    "windowsJobExecutionDriver.crash.fixture.mjs",
  );
  for (const boundary of ["after_dequeue", "after_spawn", "after_register", "before_complete", "after_complete"]) {
    const root = scratch();
    const script = path.join(root, "provider.mjs");
    const databasePath = path.join(root, "workbench.sqlite3");
    const evidencePath = path.join(root, "controller-evidence.jsonl");
    const providerEvidencePath = path.join(root, "provider-evidence.jsonl");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        'const [evidencePath, boundary] = process.argv.slice(2);',
        'appendFileSync(evidencePath, `${JSON.stringify({ pid: process.pid, parentPid: process.ppid, boundary, startedAt: new Date().toISOString() })}\\n`, "utf8");',
        'process.stdout.write("cross-process-boundary\\n");',
        'const delay = boundary === "after_spawn" || boundary === "after_register" ? 30000 : 500;',
        'setTimeout(() => process.exit(0), delay);',
      ].join("\n"),
      "utf8",
    );
    const store = new WorkbenchStore(databasePath);
    const created = createStoredCommand(store, `${boundary}-${process.pid}-${Date.now()}`);
    const runId = created.run.id;
    store.close();
    const clock = Date.now() + 100;
    const recoverySecret = randomBytes(32).toString("base64url");
    const baseConfig = {
      boundary,
      databasePath,
      recoveryRoot: root,
      providerScript: script,
      providerEvidencePath,
      evidencePath,
    };
    const crashConfigPath = path.join(root, "crash-config.json");
    const recoverConfigPath = path.join(root, "recover-config.json");
    writeFileSync(crashConfigPath, JSON.stringify({
      ...baseConfig,
      mode: "crash",
      workerId: `controller-${boundary}`,
      now: clock,
    }), "utf8");
    writeFileSync(recoverConfigPath, JSON.stringify({
      ...baseConfig,
      mode: "recover",
      workerId: `recovery-${boundary}`,
      now: clock + 2_000,
    }), "utf8");

    let finalStore;
    let finalRepository;
    try {
      const crashed = spawnSync(
        process.execPath,
        ["--experimental-strip-types", fixture, crashConfigPath],
        {
          cwd: sourceRoot,
          encoding: "utf8",
          env: { ...process.env, AGENT_OS_WORKBENCH_RECOVERY_SECRET: recoverySecret },
          timeout: 60_000,
          windowsHide: true,
        },
      );
      assert.equal(crashed.status, 86, `${boundary} controller did not exit at the injected crash: ${crashed.stderr}`);
      assert.ok(Number.isSafeInteger(crashed.pid) && crashed.pid > 0, `${boundary} controller PID missing`);

      const recovered = spawnSync(
        process.execPath,
        ["--experimental-strip-types", fixture, recoverConfigPath],
        {
          cwd: sourceRoot,
          encoding: "utf8",
          env: { ...process.env, AGENT_OS_WORKBENCH_RECOVERY_SECRET: recoverySecret },
          timeout: 60_000,
          windowsHide: true,
        },
      );
      assert.equal(recovered.status, 0, `${boundary} recovery process failed: ${recovered.stderr}`);
      assert.ok(Number.isSafeInteger(recovered.pid) && recovered.pid > 0, `${boundary} recovery PID missing`);
      const recoveryOutput = JSON.parse(recovered.stdout.trim().split(/\r?\n/u).at(-1));
      assert.equal(recoveryOutput.fixturePid, recovered.pid);
      if (boundary === "after_complete") assert.equal(recoveryOutput.result.status, "idle");
      else assert.equal(recoveryOutput.result.status, "completed", JSON.stringify(recoveryOutput));

      const events = readFileSync(evidencePath, "utf8")
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const crashEvent = events.find((event) => event.type === "injected_crash");
      assert.equal(crashEvent?.boundary, boundary);
      assert.equal(crashEvent?.fixturePid, crashed.pid);
      const nativeSpawns = events.filter((event) => event.type === "native_spawn");
      assert.equal(nativeSpawns.length, 1, `${boundary} native spawn evidence: ${JSON.stringify(nativeSpawns)}`);
      const nativeIdentity = nativeSpawns[0].identity;
      assert.ok(Number.isSafeInteger(nativeIdentity.rootProcessId) && nativeIdentity.rootProcessId > 0);
      assert.ok(Number.isSafeInteger(nativeIdentity.helperProcessId) && nativeIdentity.helperProcessId > 0);
      assert.match(nativeIdentity.rootProcessStartedAtFileTime, /^\d+$/u);
      assert.match(nativeIdentity.helperProcessStartedAtFileTime, /^\d+$/u);
      assert.equal(nativeIdentity.assignmentVerified, true);

      const providerStarts = readFileSync(providerEvidencePath, "utf8")
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(providerStarts.length, 1, `${boundary} provider started more than once`);
      assert.equal(providerStarts[0].pid, nativeIdentity.rootProcessId);
      assert.equal(providerStarts[0].parentPid, nativeIdentity.helperProcessId);

      finalStore = new WorkbenchStore(databasePath);
      const finalRun = finalStore.getRun(runId);
      const outbox = finalStore.outboxForRun(runId);
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0].state, "completed");
      assert.equal(outbox[0].attemptCount, boundary === "after_complete" ? 1 : 2);

      finalRepository = new SqliteDurableWorkerRepository(databasePath);
      const finalRecovery = await finalRepository.loadExecutionRecovery(crashEvent.executionId);
      assert.ok(finalRecovery, `${boundary} final recovery record missing`);
      assert.equal(finalRecovery.checkpoint, "completed");
      assert.ok(finalRecovery.process, `${boundary} final process identity missing`);
      assert.equal(finalRecovery.process.pid, nativeIdentity.rootProcessId);
      assert.equal(finalRecovery.process.jobName, nativeIdentity.jobName);
      assert.equal(
        finalRecovery.process.rootProcessStartedAtFileTime,
        nativeIdentity.rootProcessStartedAtFileTime,
      );
      assert.equal(finalRecovery.process.helperPid, nativeIdentity.helperProcessId);
      assert.equal(
        finalRecovery.process.helperProcessStartedAtFileTime,
        nativeIdentity.helperProcessStartedAtFileTime,
      );
      assert.equal(finalRecovery.terminal?.terminationVerified, true);
      assert.equal(finalRecovery.terminal?.source, "windows_job_helper");
      assert.ok(finalRecovery.externalStatusHighWater, `${boundary} external status high-water missing`);
      assert.equal(finalRecovery.externalStatusHighWater.terminal, true);
      assert.match(finalRecovery.externalStatusHighWater.journalGeneration, /^[A-Za-z0-9_-]{22,128}$/u);
      const expectedStatus = boundary === "after_spawn" || boundary === "after_register"
        ? "blocked"
        : "succeeded";
      assert.equal(finalRecovery.terminal?.outcome.status, expectedStatus);
      assert.equal(finalRun.status, expectedStatus);

      const observedPids = [
        crashed.pid,
        recovered.pid,
        nativeIdentity.rootProcessId,
        nativeIdentity.helperProcessId,
      ];
      for (const pid of new Set(observedPids)) await waitForProcessExit(pid, 20_000);
      console.log(JSON.stringify({
        evidenceLevel: "live-runtime",
        boundary,
        controllerPid: crashed.pid,
        recoveryPid: recovered.pid,
        rootPid: nativeIdentity.rootProcessId,
        helperPid: nativeIdentity.helperProcessId,
        rootProcessStartedAtFileTime: nativeIdentity.rootProcessStartedAtFileTime,
        helperProcessStartedAtFileTime: nativeIdentity.helperProcessStartedAtFileTime,
        spawnCount: nativeSpawns.length,
        orphanCount: 0,
        runStatus: finalRun.status,
        outboxState: outbox[0].state,
      }));
    } finally {
      finalRepository?.close();
      finalStore?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
