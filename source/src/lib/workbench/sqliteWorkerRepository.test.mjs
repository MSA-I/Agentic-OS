import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
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
      const target = existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : existsSync(`${candidate}.ts`)
          ? `${candidate}.ts`
          : path.join(candidate, "index.ts");
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
      const target = existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : existsSync(`${candidate}.ts`)
          ? `${candidate}.ts`
          : path.join(candidate, "index.ts");
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const {
  DurableExecutionError,
  DurableWorkbenchWorker,
  WorkerProcessCrash,
  crashAt,
  durableOutcomeDigestSha256,
} = await import("./durableWorker.ts");
const { SqliteDurableWorkerRepository } = await import("./sqliteWorkerRepository.ts");
const { DurableWorkbenchControlPlane } = await import("./durableControlPlane.ts");
const { WorkbenchStore } = await import("./store.ts");

function scratch() {
  const base = path.join(process.cwd(), ".next", "wave2-worker-store-tests");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, "case-"));
}

function command(store, key = "start-1", options = {}) {
  const provider = options.provider ?? "codex";
  const operation = options.operation ?? "start";
  const resources = options.resources ?? {
    cpuTimeMs: 1_000,
    residentMemoryBytes: 1024,
    diskBytes: 1024,
    processCount: 1,
    outputBytes: 1024,
  };
  return store.createRunCommand({
    adapterId: provider,
    provider,
    context: {
      agentId: provider,
      actorId: provider,
      projectId: "wave2-test",
      sessionId: null,
      environment: "local",
      panel: "transcript",
    },
    operation,
    idempotencyKey: key,
    payload: { prompt: "safe" },
    command: {
      type: options.commandType ?? "provider.start",
      availableAt: options.availableAt,
      payload: {
        operation,
        maxAttempts: options.maxAttempts ?? 3,
        resources,
      },
    },
  });
}

const CIRCUIT_TEST_ADMISSION = {
  maxActiveRuns: 5,
  maxQueuedRuns: 100,
  perRun: {
    cpuTimeMs: 2_000,
    residentMemoryBytes: 2048,
    diskBytes: 2048,
    processCount: 2,
    outputBytes: 2048,
  },
  aggregate: {
    cpuTimeMs: 10_000,
    residentMemoryBytes: 10_240,
    diskBytes: 10_240,
    processCount: 10,
    outputBytes: 10_240,
  },
};

async function claimAt(repository, workerId, now, leaseDurationMs = 30_000) {
  return repository.claimNext({
    workerId,
    now,
    leaseDurationMs,
    admissionPolicy: CIRCUIT_TEST_ADMISSION,
    lane: "any",
    excludedProviders: [],
  });
}

function guard(claim, now) {
  return {
    commandId: claim.command.id,
    workerId: claim.lease.workerId,
    fencingToken: claim.lease.fencingToken,
    now,
  };
}

function launchAuthorizationRequest(identity, expectedAttempt = 1) {
  return {
    identity,
    authorizationId: `authorization-${identity.executionId}-${expectedAttempt}`,
    launchGeneration: expectedAttempt,
    expectedAttempt,
    journalGeneration: "journal-generation-0123456789",
    descriptorHmacSha256: "a".repeat(64),
  };
}

function launchAuthorizationInput(claim, identity, now, expectedAttempt = 1, overrides = {}) {
  return {
    ...guard(claim, now),
    ...launchAuthorizationRequest(identity, expectedAttempt),
    ...overrides,
  };
}

async function circuitPermit(repository, claim, now, halfOpenLeaseDurationMs = 30_000) {
  return repository.acquireProviderCircuit({
    provider: claim.command.provider,
    ...guard(claim, now),
    halfOpenLeaseDurationMs,
  });
}

async function failAndReschedule(
  repository,
  claim,
  permit,
  now,
  { threshold = 1, resetMs = 60_000, availableAt = now } = {},
) {
  assert.equal(permit.allowed, true);
  return repository.rescheduleCommand({
    ...guard(claim, now),
    attempt: claim.command.attempt,
    failure: { failureClass: "provider_unavailable", message: "provider down" },
    circuit: permit.lease,
    countsTowardCircuit: true,
    circuitFailureThreshold: threshold,
    circuitResetMs: resetMs,
    availableAt,
  });
}

function completion(claim, permit, now) {
  return {
    ...guard(claim, now),
    attempt: claim.command.attempt,
    identity: {
      executionId: claim.command.executionId,
      commandId: claim.command.id,
      runId: claim.command.runId,
      jobObjectId: `agent-os-${claim.command.executionId}`,
    },
    outcome: { status: "succeeded", exitCode: 0 },
    completedAt: now,
    circuit: permit.lease,
  };
}

function verifiedTerminalInput(identity, outcome, observedAt, seed = "6") {
  return {
    ...identity,
    statusEvidence: {
      ...identity,
      journalGeneration: seed.repeat(32),
      sequence: 1,
      previousSequence: 0,
      previousSnapshotDigestSha256: "0".repeat(64),
      previousJournalDigestSha256: "0".repeat(64),
      terminal: true,
      snapshotDigestSha256: "1".repeat(64),
      journalDigestSha256: "2".repeat(64),
      authenticatedPayloadDigestSha256: "3".repeat(64),
      nativeTerminalDigestSha256: "4".repeat(64),
      nativeTerminalStatus: outcome.status,
      nativeExitCode: outcome.exitCode,
      terminationVerified: true,
      observedAt,
    },
    outcome,
    controllerOutcomeDigestSha256: durableOutcomeDigestSha256(outcome),
    observedAt,
    terminationVerified: true,
    source: "windows_job_helper",
  };
}

async function registerRunning(repository, claim, now) {
  const input = completion(claim, { lease: { provider: claim.command.provider, fencingToken: 0, probe: false } }, now);
  const process = {
    pid: 4801,
    jobObjectId: input.identity.jobObjectId,
    executablePath: "C:\\runtime\\provider.exe",
    executableHash: "a".repeat(64),
    startedAt: now,
  };
  const spawn = {
    ...guard(claim, now),
    attempt: claim.command.attempt,
    identity: input.identity,
    process,
  };
  assert.equal((await repository.recordSpawnIntent(spawn)).status, "applied");
  const authorization = await repository.authorizeProviderAttempt(
    launchAuthorizationInput(claim, input.identity, now, claim.command.attempt),
  );
  assert.ok(["applied", "already_applied"].includes(authorization.status));
  assert.equal((await repository.recordSpawnObservation(spawn)).status, "applied");
  assert.equal((await repository.registerProcess(spawn)).status, "applied");
}

function launchCancellationCompletion(fixture, databasePath, inputPath, readyPath, barrierPath, delayMs, label) {
  const child = spawn(
    process.execPath,
    [fixture, databasePath, inputPath, readyPath, barrierPath, String(delayMs)],
    {
      cwd: sourceRoot,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`${label} completion fixture exited ${code}: ${stderr}`));
      else resolve({ label, result: JSON.parse(stdout) });
    });
  });
}

async function waitForFiles(paths, timeoutMs = 10_000) {
  const started = Date.now();
  while (!paths.every((candidate) => existsSync(candidate))) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for child readiness: ${paths.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function halfOpenRaceFixture() {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  command(store, "race-seed", { provider: "codex" });
  command(store, "race-old", { provider: "codex" });
  command(store, "race-new", { provider: "codex" });
  const seed = new SqliteDurableWorkerRepository(databasePath);
  const openedAt = "2031-03-01T00:00:00.000Z";
  const seedClaim = await claimAt(seed, "seed-worker", openedAt);
  const oldClaim = await claimAt(seed, "old-worker", openedAt);
  const newClaim = await claimAt(seed, "new-worker", openedAt);
  assert.ok(seedClaim && oldClaim && newClaim);
  const seedPermit = await circuitPermit(seed, seedClaim, openedAt);
  assert.equal((await failAndReschedule(seed, seedClaim, seedPermit, openedAt, {
    resetMs: 1_000,
  })).status, "applied");
  assert.equal((await seed.loadProviderCircuit("codex")).state, "open");
  return { root, databasePath, store, seed, oldClaim, newClaim };
}

class IdempotentDriver {
  processes = new Map();
  spawnCount = 0;

  async reconcileOrSpawn(_command, identity, _signal, authorizeNewSpawn) {
    const existing = this.processes.get(identity.executionId);
    if (existing) return { state: "running", process: existing };
    await authorizeNewSpawn(launchAuthorizationRequest(identity));
    this.spawnCount += 1;
    const process = {
      pid: 40_000 + this.spawnCount,
      jobObjectId: identity.jobObjectId,
      executablePath: "C:\\fake\\provider.exe",
      executableHash: "a".repeat(64),
      startedAt: new Date(0).toISOString(),
    };
    this.processes.set(identity.executionId, process);
    return { state: "running", process };
  }

  async waitForCompletion() {
    return { status: "succeeded", exitCode: 0 };
  }

  async executeControl() {
    return { status: "cancelled", exitCode: 0 };
  }

  async abortAndVerify() {
    return true;
  }
}

class FreshRecoveryDriver {
  constructor(repository) {
    this.repository = repository;
    this.spawnCount = 0;
  }

  async reconcileOrSpawn(_command, identity) {
    const recovery = await this.repository.loadExecutionRecovery(identity.executionId);
    if (recovery?.recoveryAction === "terminal_replay") {
      return { state: "completed", process: recovery.process, outcome: recovery.terminal.outcome };
    }
    if (recovery?.recoveryAction === "durable_terminal_probe_required") {
      throw new DurableExecutionError({
        failureClass: "containment",
        message: "Fresh driver refuses duplicate spawn until durable helper terminal proof is available.",
      });
    }
    this.spawnCount += 1;
    throw new Error("Fresh recovery driver unexpectedly reached spawn path.");
  }

  async waitForCompletion() {
    throw new Error("Fresh recovery driver cannot wait without terminal proof.");
  }

  async executeControl() {
    return { status: "blocked", exitCode: null };
  }

  async abortAndVerify() {
    return false;
  }
}

test("maxAttempts=1 still delivers post-spawn recovery without consuming a second provider attempt", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  const created = command(store, "post-spawn-cap-one", { maxAttempts: 1 });
  const repository = new SqliteDurableWorkerRepository(databasePath);
  const driver = new IdempotentDriver();
  let clock = Date.now() + 100;
  try {
    const crashing = new DurableWorkbenchWorker(repository, driver, {
      workerId: "worker-a",
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
      now: () => clock,
      crashInjector: crashAt("after_spawn"),
    });
    await assert.rejects(() => crashing.runOnce(), WorkerProcessCrash);
    assert.equal(driver.spawnCount, 1);
    assert.equal(store.getOutboxCommand(created.command.id).providerAttemptCount, 1);
    assert.equal(store.getRun(created.run.id).status, "starting");

    clock += 1_500;
    const recovering = new DurableWorkbenchWorker(repository, driver, {
      workerId: "worker-b",
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
      now: () => clock,
    });
    const result = await recovering.runOnce();
    assert.equal(result.status, "completed");
    assert.equal(driver.spawnCount, 1);
    assert.equal(store.getOutboxCommand(created.command.id).providerAttemptCount, 1);
    assert.equal(store.getRun(created.run.id).status, "succeeded");
    assert.equal(store.outboxForRun(created.run.id)[0].state, "completed");
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch authorization receipt is immutable, restart-durable, and enforces maxAttempts=1", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  const created = command(store, "launch-receipt-cap-one", { maxAttempts: 1 });
  let repository = new SqliteDurableWorkerRepository(databasePath);
  const now = "2030-01-01T00:00:00.000Z";
  try {
    const claimed = await claimAt(repository, "receipt-worker", now);
    assert.ok(claimed);
    const identity = {
      executionId: claimed.command.executionId,
      commandId: claimed.command.id,
      runId: claimed.command.runId,
      jobObjectId: `agent-os-${claimed.command.executionId}`,
    };
    assert.equal((await repository.recordSpawnIntent({
      ...guard(claimed, now),
      attempt: claimed.command.attempt,
      identity,
    })).status, "applied");

    const request = launchAuthorizationInput(claimed, identity, now);
    const first = await repository.authorizeProviderAttempt(request);
    assert.equal(first.status, "applied");
    assert.equal(first.attempt, 1);
    assert.deepEqual(first.authorization, {
      ...identity,
      authorizationId: request.authorizationId,
      launchGeneration: 1,
      attempt: 1,
      journalGeneration: request.journalGeneration,
      descriptorHmacSha256: request.descriptorHmacSha256,
      authorizedAt: now,
    });
    assert.deepEqual(await repository.authorizeProviderAttempt(request), {
      status: "already_applied",
      attempt: 1,
      authorization: first.authorization,
    });
    assert.equal((await repository.authorizeProviderAttempt({
      ...request,
      descriptorHmacSha256: "b".repeat(64),
    })).status, "conflict");
    assert.equal((await repository.authorizeProviderAttempt(launchAuthorizationInput(
      claimed,
      identity,
      now,
      2,
    ))).status, "attempt_cap_exhausted");
    assert.equal(store.getOutboxCommand(created.command.id).providerAttemptCount, 1);

    repository.close();
    repository = new SqliteDurableWorkerRepository(databasePath);
    const recovery = await repository.loadExecutionRecovery(identity.executionId);
    assert.deepEqual(recovery.launchAuthorization, first.authorization);
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh repository and driver after post-spawn crash fail closed without duplicate spawn", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  const created = command(store, "fresh-driver-after-spawn");
  let repository = new SqliteDurableWorkerRepository(databasePath);
  const firstDriver = new IdempotentDriver();
  let clock = Date.now() + 100;
  try {
    const crashing = new DurableWorkbenchWorker(repository, firstDriver, {
      workerId: "worker-before-crash",
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
      now: () => clock,
      crashInjector: crashAt("after_spawn"),
    });
    await assert.rejects(() => crashing.runOnce(), WorkerProcessCrash);
    assert.equal(firstDriver.spawnCount, 1);
    const executionId = store.outboxForRun(created.run.id)[0].idempotencyKey;
    const intent = await repository.loadExecutionRecovery(executionId);
    assert.equal(intent.checkpoint, "spawn_intent");
    assert.equal(intent.process, null);
    assert.equal(intent.reconnectable, false);
    assert.equal(intent.recoveryAction, "durable_terminal_probe_required");

    repository.close();
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        path.join(sourceRoot, "src", "lib", "workbench", "sqliteWorkerRecovery.fixture.mjs"),
        databasePath,
        executionId,
      ],
      { cwd: sourceRoot, encoding: "utf8", windowsHide: true },
    );
    assert.equal(child.status, 0, child.stderr);
    const childRecovery = JSON.parse(child.stdout);
    assert.equal(childRecovery.action, "fail_closed");
    assert.equal(childRecovery.spawnCount, 0);
    assert.equal(childRecovery.recovery.reconnectable, false);
    assert.equal(childRecovery.recovery.recoveryAction, "durable_terminal_probe_required");

    repository = new SqliteDurableWorkerRepository(databasePath);
    const freshDriver = new FreshRecoveryDriver(repository);
    clock += 1_500;
    const recovering = new DurableWorkbenchWorker(repository, freshDriver, {
      workerId: "worker-after-crash",
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
      now: () => clock,
    });
    const result = await recovering.runOnce();
    assert.equal(result.status, "dead_lettered");
    assert.equal(freshDriver.spawnCount, 0);
    assert.equal(store.getRun(created.run.id).status, "failed");
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("process identity and verified terminal checkpoint survive database and repository reopen", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  const created = command(store, "identity-reopen");
  let repository = new SqliteDurableWorkerRepository(databasePath);
  const now = new Date(Date.now() + 100).toISOString();
  const claim = await repository.claimNext({
    workerId: "identity-worker",
    now,
    leaseDurationMs: 30_000,
    admissionPolicy: {
      maxActiveRuns: 5,
      maxQueuedRuns: 100,
      perRun: { cpuTimeMs: 2_000, residentMemoryBytes: 2048, diskBytes: 2048, processCount: 2, outputBytes: 2048 },
      aggregate: { cpuTimeMs: 10_000, residentMemoryBytes: 10_240, diskBytes: 10_240, processCount: 10, outputBytes: 10_240 },
    },
    excludedProviders: [],
  });
  const identity = {
    executionId: claim.command.executionId,
    commandId: claim.command.id,
    runId: claim.command.runId,
    jobObjectId: `agent-os-${claim.command.executionId}`,
  };
  const guard = {
    commandId: claim.command.id,
    workerId: claim.lease.workerId,
    fencingToken: claim.lease.fencingToken,
    now,
    attempt: claim.command.attempt,
    identity,
  };
  const process = {
    pid: 41001,
    rootProcessStartedAtFileTime: "133700000000000001",
    jobObjectId: identity.jobObjectId,
    jobName: "Local\\AgentOS-identity-reopen",
    helperPid: 41000,
    helperProcessStartedAtFileTime: "133700000000000000",
    executablePath: "C:\\fake\\provider.exe",
    executableHash: "b".repeat(64),
    startedAt: now,
  };
  try {
    assert.equal((await repository.recordSpawnIntent(guard)).status, "applied");
    assert.equal((await repository.recordSpawnObservation({ ...guard, process })).status, "missing");
    assert.equal((await repository.registerProcess({ ...guard, process })).status, "missing");
    const beforeAuthorization = await repository.loadExecutionRecovery(identity.executionId);
    assert.equal(beforeAuthorization.checkpoint, "spawn_intent");
    assert.equal(beforeAuthorization.process, null);

    const authorization = await repository.authorizeProviderAttempt(
      launchAuthorizationInput(claim, identity, now, claim.command.attempt),
    );
    assert.equal(authorization.status, "applied");
    assert.equal((await repository.recordSpawnObservation({ ...guard, process })).status, "applied");
    assert.equal((await repository.registerProcess({ ...guard, process })).status, "applied");
    repository.close();

    repository = new SqliteDurableWorkerRepository(databasePath);
    const recovered = await repository.loadExecutionRecovery(identity.executionId);
    assert.equal(recovered.commandId, identity.commandId);
    assert.equal(recovered.runId, identity.runId);
    assert.equal(recovered.jobObjectId, identity.jobObjectId);
    assert.deepEqual(recovered.process, process);
    assert.equal(recovered.checkpoint, "registered");
    assert.equal(recovered.reconnectable, false);
    assert.equal(recovered.recoveryAction, "durable_terminal_probe_required");

    const outcome = {
      status: "succeeded",
      exitCode: 0,
      metadata: { cleanup: "active_process_zero", terminationVerified: true },
    };
    const checkpoint = await repository.recordVerifiedTerminalCheckpoint(verifiedTerminalInput(
      identity,
      outcome,
      new Date(Date.parse(now) + 1_000).toISOString(),
    ));
    assert.equal(checkpoint.status, "applied");
    repository.close();

    repository = new SqliteDurableWorkerRepository(databasePath);
    const terminal = await repository.loadExecutionRecovery(identity.executionId);
    assert.equal(terminal.recoveryAction, "terminal_replay");
    assert.deepEqual(JSON.parse(JSON.stringify(terminal.terminal.outcome)), outcome);
    assert.equal(terminal.terminal.terminationVerified, true);
    assert.equal(terminal.terminal.source, "windows_job_helper");

    const recoveryClock = Date.parse(now) + 31_000;
    const recoveringDriver = new FreshRecoveryDriver(repository);
    const recoveringWorker = new DurableWorkbenchWorker(repository, recoveringDriver, {
      workerId: "terminal-replay-worker",
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      now: () => recoveryClock,
    });
    const completed = await recoveringWorker.runOnce();
    assert.equal(completed.status, "completed");
    assert.equal(recoveringDriver.spawnCount, 0);
    assert.equal(store.getRun(created.run.id).status, "succeeded");
    const finalRecovery = await repository.loadExecutionRecovery(identity.executionId);
    assert.equal(finalRecovery.checkpoint, "completed");
    assert.equal(finalRecovery.recoveryAction, "completed");
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified native completion atomically creates one fenced cleanup intent without changing terminal outcome", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  command(store, "verified-cleanup-ledger");
  const repository = new SqliteDurableWorkerRepository(databasePath);
  let left;
  let right;
  let inspector;
  try {
    const claimedAt = "2030-01-02T00:00:00.000Z";
    const terminalAt = "2030-01-02T00:00:00.500Z";
    const claim = await claimAt(repository, "provider-worker", claimedAt);
    assert.ok(claim);
    const permit = await circuitPermit(repository, claim, claimedAt);
    assert.equal(permit.allowed, true);
    await registerRunning(repository, claim, claimedAt);
    const identity = completion(claim, permit, terminalAt).identity;
    const outcome = {
      status: "succeeded",
      exitCode: 0,
      metadata: { cleanup: "active_process_zero", terminationVerified: true },
    };
    assert.equal(
      (await repository.recordVerifiedTerminalCheckpoint(
        verifiedTerminalInput(identity, outcome, terminalAt),
      )).status,
      "applied",
    );
    assert.equal(
      (await repository.completeCommand({
        ...completion(claim, permit, terminalAt),
        outcome,
      })).status,
      "applied",
    );

    const [pending] = await repository.listExecutionCleanupIntents();
    assert.ok(pending);
    assert.equal(pending.executionId, identity.executionId);
    assert.equal(pending.commandId, identity.commandId);
    assert.equal(pending.runId, identity.runId);
    assert.equal(pending.jobObjectId, identity.jobObjectId);
    assert.equal(pending.runGeneration, claim.command.runGeneration);
    assert.equal(pending.chainVersion, 2);
    assert.equal(pending.terminal, true);
    assert.equal(pending.terminationVerified, true);
    assert.equal(pending.terminalStatus, "succeeded");
    assert.equal(pending.nativeTerminalStatus, "succeeded");
    assert.equal(pending.state, "pending");
    assert.equal(pending.attemptCount, 0);
    assert.equal(store.getRun(identity.runId).status, "succeeded");
    assert.equal(store.getOutboxCommand(identity.commandId).state, "completed");

    inspector = new DatabaseSync(databasePath);
    inspector.exec("PRAGMA foreign_keys = ON");
    assert.throws(
      () => inspector.prepare(`
        UPDATE workbench_execution_cleanup_intents
        SET status_sequence = status_sequence + 1 WHERE execution_id = ?
      `).run(identity.executionId),
      /execution_cleanup_intent_conflict/u,
    );
    assert.throws(
      () => inspector.prepare(`
        DELETE FROM workbench_execution_recovery WHERE execution_id = ?
      `).run(identity.executionId),
      /execution_cleanup_debt_delete_denied/u,
    );

    left = new SqliteDurableWorkerRepository(databasePath);
    right = new SqliteDurableWorkerRepository(databasePath);
    const [leftClaim, rightClaim] = await Promise.all([
      left.claimNextExecutionCleanup({
        workerId: "cleanup-left",
        now: "2030-01-02T00:00:01.000Z",
        leaseDurationMs: 1_000,
      }),
      right.claimNextExecutionCleanup({
        workerId: "cleanup-right",
        now: "2030-01-02T00:00:01.000Z",
        leaseDurationMs: 1_000,
      }),
    ]);
    assert.equal([leftClaim, rightClaim].filter(Boolean).length, 1);
    const first = leftClaim ?? rightClaim;
    const firstRepository = leftClaim ? left : right;
    const secondRepository = leftClaim ? right : left;
    assert.equal(
      (await firstRepository.heartbeatExecutionCleanup({
        executionId: first.executionId,
        workerId: "cleanup-wrong-owner",
        fencingToken: first.fencingToken,
        now: "2030-01-02T00:00:01.200Z",
        expiresAt: "2030-01-02T00:00:03.500Z",
      })).status,
      "stale_fence",
    );
    assert.equal(
      (await firstRepository.heartbeatExecutionCleanup({
        executionId: first.executionId,
        workerId: first.claimedBy,
        fencingToken: first.fencingToken + 1,
        now: "2030-01-02T00:00:01.200Z",
        expiresAt: "2030-01-02T00:00:03.500Z",
      })).status,
      "stale_fence",
    );
    assert.equal(
      (await firstRepository.heartbeatExecutionCleanup({
        executionId: first.executionId,
        workerId: first.claimedBy,
        fencingToken: first.fencingToken,
        now: "2030-01-02T00:00:01.200Z",
        expiresAt: "2030-01-02T00:00:03.500Z",
      })).status,
      "applied",
    );
    assert.equal(
      await secondRepository.claimNextExecutionCleanup({
        workerId: "cleanup-too-early",
        now: "2030-01-02T00:00:03.000Z",
        leaseDurationMs: 2_000,
      }),
      null,
    );
    const reclaimed = await secondRepository.claimNextExecutionCleanup({
      workerId: "cleanup-restart",
      now: "2030-01-02T00:00:03.600Z",
      leaseDurationMs: 2_000,
    });
    assert.ok(reclaimed);
    assert.ok(reclaimed.fencingToken > first.fencingToken);
    assert.equal(
      (await firstRepository.completeExecutionCleanup({
        executionId: first.executionId,
        workerId: first.claimedBy,
        fencingToken: first.fencingToken,
        now: "2030-01-02T00:00:03.600Z",
        completedAt: "2030-01-02T00:00:03.600Z",
        result: "removed",
      })).status,
      "stale_fence",
    );
    assert.equal(
      (await firstRepository.retryExecutionCleanup({
        executionId: first.executionId,
        workerId: first.claimedBy,
        fencingToken: first.fencingToken,
        now: "2030-01-02T00:00:03.600Z",
        availableAt: "2030-01-02T00:00:04.000Z",
        error: { code: "EPERM", message: "stale retry must not win" },
      })).status,
      "stale_fence",
    );
    assert.equal(
      (await firstRepository.quarantineExecutionCleanup({
        executionId: first.executionId,
        workerId: first.claimedBy,
        fencingToken: first.fencingToken,
        now: "2030-01-02T00:00:03.600Z",
        quarantinedAt: "2030-01-02T00:00:03.600Z",
        error: { code: "stale", message: "stale quarantine must not win" },
      })).status,
      "stale_fence",
    );
    assert.equal(
      (await secondRepository.retryExecutionCleanup({
        executionId: reclaimed.executionId,
        workerId: reclaimed.claimedBy,
        fencingToken: reclaimed.fencingToken,
        now: "2030-01-02T00:00:03.700Z",
        availableAt: "2030-01-02T00:00:04.000Z",
        error: { code: "EPERM", message: "Control directory is temporarily locked." },
      })).status,
      "applied",
    );
    assert.equal(store.getRun(identity.runId).status, "succeeded");
    assert.equal(store.getOutboxCommand(identity.commandId).state, "completed");

    const finalClaim = await repository.claimNextExecutionCleanup({
      workerId: "cleanup-final",
      now: "2030-01-02T00:00:04.000Z",
      leaseDurationMs: 2_000,
    });
    assert.ok(finalClaim);
    assert.equal(finalClaim.attemptCount, 3);
    assert.equal(
      (await repository.completeExecutionCleanup({
        executionId: finalClaim.executionId,
        workerId: finalClaim.claimedBy,
        fencingToken: finalClaim.fencingToken,
        now: "2030-01-02T00:00:04.100Z",
        completedAt: "2030-01-02T00:00:04.100Z",
        result: "removed",
      })).status,
      "applied",
    );
    assert.equal(
      (await repository.completeExecutionCleanup({
        executionId: finalClaim.executionId,
        workerId: finalClaim.claimedBy,
        fencingToken: finalClaim.fencingToken,
        now: "2030-01-02T00:00:04.200Z",
        completedAt: "2030-01-02T00:00:04.200Z",
        result: "removed",
      })).status,
      "already_applied",
    );
    const [completed] = await repository.listExecutionCleanupIntents();
    assert.equal(completed.state, "completed");
    assert.equal(completed.cleanupResult, "removed");
    assert.equal(completed.claimedBy, null);
    assert.equal(completed.leaseExpiresAt, null);
    const exactCompleted = await repository.findCompletedExecutionCleanupIntents([
      "missing-execution",
      identity.executionId.slice(0, -1),
      identity.executionId,
      identity.executionId,
    ]);
    assert.deepEqual(exactCompleted.map((intent) => intent.executionId), [identity.executionId]);

    command(store, "verified-cleanup-quarantine");
    const quarantineAt = "2030-01-02T00:00:06.000Z";
    const quarantineClaim = await claimAt(repository, "provider-quarantine", quarantineAt);
    assert.ok(quarantineClaim);
    const quarantinePermit = await circuitPermit(repository, quarantineClaim, quarantineAt);
    assert.equal(quarantinePermit.allowed, true);
    await registerRunning(repository, quarantineClaim, quarantineAt);
    const quarantineIdentity = completion(quarantineClaim, quarantinePermit, quarantineAt).identity;
    const quarantineOutcome = {
      status: "succeeded",
      exitCode: 0,
      metadata: { cleanup: "active_process_zero", terminationVerified: true },
    };
    assert.equal(
      (await repository.recordVerifiedTerminalCheckpoint(
        verifiedTerminalInput(quarantineIdentity, quarantineOutcome, quarantineAt, "7"),
      )).status,
      "applied",
    );
    assert.equal(
      (await repository.completeCommand({
        ...completion(quarantineClaim, quarantinePermit, quarantineAt),
        outcome: quarantineOutcome,
      })).status,
      "applied",
    );
    const pendingExcluded = await repository.findCompletedExecutionCleanupIntents([
      identity.executionId,
      quarantineIdentity.executionId,
      quarantineIdentity.executionId.slice(0, -1),
    ]);
    assert.deepEqual(pendingExcluded.map((intent) => intent.executionId), [identity.executionId]);
    const quarantineCleanup = await repository.claimNextExecutionCleanup({
      workerId: "cleanup-quarantine",
      now: "2030-01-02T00:00:07.000Z",
      leaseDurationMs: 2_000,
    });
    assert.ok(quarantineCleanup);
    assert.equal(
      (await repository.quarantineExecutionCleanup({
        executionId: quarantineCleanup.executionId,
        workerId: quarantineCleanup.claimedBy,
        fencingToken: quarantineCleanup.fencingToken,
        now: "2030-01-02T00:00:07.100Z",
        quarantinedAt: "2030-01-02T00:00:07.100Z",
        error: { code: "windows_job_protocol_invalid", message: "signed status mismatch" },
      })).status,
      "applied",
    );
    const persistenceProbe = new SqliteDurableWorkerRepository(databasePath);
    try {
      const quarantined = (await persistenceProbe.listExecutionCleanupIntents())
        .find((intent) => intent.executionId === quarantineIdentity.executionId);
      assert.ok(quarantined);
      assert.equal(quarantined.state, "quarantined");
      assert.equal(quarantined.lastErrorCode, "windows_job_protocol_invalid");
      assert.equal(quarantined.lastErrorMessage, "signed status mismatch");
      assert.equal(quarantined.claimedBy, null);
      assert.equal(quarantined.leaseExpiresAt, null);
      const quarantinedExcluded = await persistenceProbe.findCompletedExecutionCleanupIntents([
        identity.executionId,
        quarantineIdentity.executionId,
        quarantineIdentity.executionId.slice(0, -1),
      ]);
      assert.deepEqual(quarantinedExcluded.map((intent) => intent.executionId), [identity.executionId]);
      assert.equal(
        await persistenceProbe.claimNextExecutionCleanup({
          workerId: "cleanup-after-quarantine-reopen",
          now: "2030-01-02T01:00:00.000Z",
          leaseDurationMs: 2_000,
        }),
        null,
      );
    } finally {
      persistenceProbe.close();
    }
    assert.equal(store.getRun(identity.runId).status, "succeeded");
  } finally {
    inspector?.close();
    left?.close();
    right?.close();
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart orphaning preserves unresolved durable recovery runs and only orphans legacy active runs", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  const durable = command(store, "durable-recovery-orphan-guard");
  const repository = new SqliteDurableWorkerRepository(databasePath);
  const claimedAt = new Date().toISOString();
  try {
    const claim = await repository.claimNext({
      workerId: "recovery-orphan-worker",
      now: claimedAt,
      leaseDurationMs: 30_000,
      admissionPolicy: {
        maxActiveRuns: 5,
        maxQueuedRuns: 100,
        perRun: { cpuTimeMs: 2_000, residentMemoryBytes: 2048, diskBytes: 2048, processCount: 2, outputBytes: 2048 },
        aggregate: { cpuTimeMs: 10_000, residentMemoryBytes: 10_240, diskBytes: 10_240, processCount: 10, outputBytes: 10_240 },
      },
      excludedProviders: [],
    });
    assert.ok(claim);
    const identity = {
      executionId: claim.command.executionId,
      commandId: claim.command.id,
      runId: claim.command.runId,
      jobObjectId: `agent-os-${claim.command.executionId}`,
    };
    assert.equal((await repository.loadExecutionRecovery(identity.executionId)).checkpoint, "dequeued");
    assert.equal(store.getRun(durable.run.id).status, "claimed");

    const legacy = command(store, "legacy-active-orphan");
    store.updateRun(legacy.run.id, { status: "starting", pid: 42_424 });
    const orphaned = store.orphanActiveRuns();
    assert.deepEqual(orphaned.map(({ id }) => id), [legacy.run.id]);
    assert.equal(store.getRun(legacy.run.id).status, "orphaned");
    assert.equal(store.getRun(durable.run.id).status, "claimed");
    assert.equal((await repository.loadExecutionRecovery(identity.executionId)).checkpoint, "dequeued");
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphan reconciliation is a dedicated non-provider command and never dead-letters the run", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  const repository = new SqliteDurableWorkerRepository(databasePath);
  try {
    const created = command(store, "legacy-orphan-reconciliation");
    store.updateRun(created.run.id, { status: "starting", pid: 52_052 });
    assert.deepEqual(store.orphanActiveRuns().map(({ id }) => id), [created.run.id]);

    const orphanCommand = store.outboxForRun(created.run.id)
      .find(({ type }) => type === "run.reconcile_orphan");
    assert.ok(orphanCommand);
    assert.equal(orphanCommand.operation, "reconcile_orphan");

    const claim = await claimAt(repository, "orphan-reconciliation-worker", "2032-01-01T00:00:00.000Z");
    assert.equal(claim, null);
    assert.equal(store.getOutboxCommand(orphanCommand.id).state, "completed");
    assert.equal(store.getOutboxCommand(orphanCommand.id).deliveryAttemptCount, 0);
    assert.equal(store.getOutboxCommand(orphanCommand.id).providerAttemptCount, 0);
    assert.equal(store.getRun(created.run.id).status, "orphaned");
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("two workers cannot claim the same durable command concurrently", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  command(store, "concurrent-start");
  const left = new SqliteDurableWorkerRepository(databasePath);
  const right = new SqliteDurableWorkerRepository(databasePath);
  const now = new Date().toISOString();
  const input = {
    now,
    leaseDurationMs: 30_000,
    admissionPolicy: {
      maxActiveRuns: 5,
      maxQueuedRuns: 100,
      perRun: { cpuTimeMs: 2_000, residentMemoryBytes: 2048, diskBytes: 2048, processCount: 2, outputBytes: 2048 },
      aggregate: { cpuTimeMs: 10_000, residentMemoryBytes: 10_240, diskBytes: 10_240, processCount: 10, outputBytes: 10_240 },
    },
    excludedProviders: [],
  };
  try {
    const [a, b] = await Promise.all([
      left.claimNext({ ...input, workerId: "left" }),
      right.claimNext({ ...input, workerId: "right" }),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1);
  } finally {
    left.close();
    right.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("authenticated terminal cancellation pair closes both commands across process races", {
  timeout: 60_000,
}, async (t) => {
  const fixture = path.join(sourceRoot, "src", "lib", "workbench", "sqliteWorkerCancellation.fixture.mjs");
  const variants = [
    { name: "start-first-cancelled", status: "cancelled", startDelay: 0, cancelDelay: 75 },
    { name: "cancel-first-cancelled", status: "cancelled", startDelay: 75, cancelDelay: 0 },
    { name: "start-first-succeeded", status: "succeeded", startDelay: 0, cancelDelay: 75 },
    { name: "cancel-first-succeeded", status: "succeeded", startDelay: 75, cancelDelay: 0 },
    { name: "start-first-failed", status: "failed", startDelay: 0, cancelDelay: 75 },
    { name: "cancel-first-failed", status: "failed", startDelay: 75, cancelDelay: 0 },
    { name: "start-first-blocked", status: "blocked", startDelay: 0, cancelDelay: 75 },
    { name: "cancel-first-blocked", status: "blocked", startDelay: 75, cancelDelay: 0 },
  ];

  for (const variant of variants) {
    await t.test(variant.name, async () => {
      const root = scratch();
      const databasePath = path.join(root, "workbench.sqlite3");
      const barrierPath = path.join(root, "complete.barrier");
      const startReadyPath = path.join(root, "start.ready");
      const cancelReadyPath = path.join(root, "cancel.ready");
      const startInputPath = path.join(root, "start-completion.json");
      const cancelInputPath = path.join(root, "cancel-completion.json");
      const store = new WorkbenchStore(databasePath);
      let startRepository = new SqliteDurableWorkerRepository(databasePath);
      let cancelRepository = new SqliteDurableWorkerRepository(databasePath);
      const startedAt = "2033-04-01T00:00:00.000Z";
      const terminalAt = "2033-04-01T00:00:01.000Z";
      try {
        const created = command(store, `verified-pair-${variant.name}`, { provider: "codex" });
        const startClaim = await claimAt(startRepository, `start-${variant.name}`, startedAt);
        assert.ok(startClaim);
        const startPermit = await circuitPermit(startRepository, startClaim, startedAt);
        assert.equal(startPermit.allowed, true);
        await registerRunning(startRepository, startClaim, startedAt);

        const targetJobObjectId = `agent-os-${startClaim.command.executionId}`;
        const stopping = store.transitionRunWithCommand({
          runId: created.run.id,
          to: "stopping",
          expectedFrom: "running",
          command: {
            type: "wave3.codex.cancel",
            idempotencyKey: `cancel:${created.run.id}`,
            payload: {
              operation: "cancel",
              targetExecutionId: startClaim.command.executionId,
              targetJobObjectId,
              resources: {
                cpuTimeMs: 1_000,
                residentMemoryBytes: 1024,
                diskBytes: 1024,
                processCount: 1,
                outputBytes: 1024,
              },
              maxAttempts: 1,
            },
          },
          event: { payload: { stopState: "stopping", terminationVerified: false } },
        });
        const cancelClaim = await claimAt(cancelRepository, `cancel-${variant.name}`, terminalAt);
        assert.ok(cancelClaim);
        assert.equal(cancelClaim.command.id, stopping.command.id);

        const providerOutcome = {
          status: variant.status,
          exitCode: variant.status === "succeeded" ? 0 : variant.status === "failed" ? 17 : null,
          ...(["failed", "blocked"].includes(variant.status)
            ? {
                errorCode: variant.status === "blocked" ? "native_blocked" : "process_exit_nonzero",
                errorMessage: variant.status === "blocked"
                  ? "Native execution was blocked."
                  : "Provider exited with code 17.",
              }
            : {}),
          metadata: { cleanup: "active_process_zero", terminationVerified: true },
        };
        const startCompletion = {
          ...completion(startClaim, startPermit, terminalAt),
          outcome: providerOutcome,
        };
        const cancelCompletion = {
          ...completion(cancelClaim, {
            lease: { provider: "codex", fencingToken: -1, probe: false },
          }, terminalAt),
          outcome: {
            ...providerOutcome,
            metadata: {
              ...providerOutcome.metadata,
              cancelRequested: true,
              cancelledBeforeCompletion: variant.status === "cancelled",
              terminationVerified: true,
            },
          },
        };
        assert.equal(
          (await startRepository.recordVerifiedTerminalCheckpoint(verifiedTerminalInput(
            startCompletion.identity,
            providerOutcome,
            terminalAt,
          ))).status,
          "applied",
        );
        writeFileSync(startInputPath, JSON.stringify(startCompletion), "utf8");
        writeFileSync(cancelInputPath, JSON.stringify(cancelCompletion), "utf8");
        startRepository.close();
        cancelRepository.close();
        startRepository = null;
        cancelRepository = null;

        const pending = [
          launchCancellationCompletion(
            fixture,
            databasePath,
            startInputPath,
            startReadyPath,
            barrierPath,
            variant.startDelay,
            "start",
          ),
          launchCancellationCompletion(
            fixture,
            databasePath,
            cancelInputPath,
            cancelReadyPath,
            barrierPath,
            variant.cancelDelay,
            "cancel",
          ),
        ];
        await waitForFiles([startReadyPath, cancelReadyPath]);
        writeFileSync(barrierPath, "go", "utf8");
        const results = await Promise.all(pending);
        assert.deepEqual(results.map(({ result }) => result.status).sort(), ["already_applied", "applied"]);
        const byLabel = Object.fromEntries(results.map(({ label, result }) => [label, result]));
        assert.equal(byLabel.start.status, variant.startDelay < variant.cancelDelay ? "applied" : "already_applied");
        assert.equal(byLabel.cancel.status, variant.cancelDelay < variant.startDelay ? "applied" : "already_applied");

        const persisted = new DatabaseSync(databasePath);
        try {
          const rows = persisted.prepare(`
            SELECT id, state, checkpoint, claimed_by, lease_expires_at,
              reservation_active, outcome_json
            FROM workbench_outbox WHERE id IN (?, ?) ORDER BY id
          `).all(startClaim.command.id, cancelClaim.command.id);
          assert.equal(rows.length, 2);
          for (const row of rows) {
            assert.equal(row.state, "completed");
            assert.equal(row.checkpoint, "completed");
            assert.equal(row.claimed_by, null);
            assert.equal(row.lease_expires_at, null);
            assert.equal(row.reservation_active, 0);
          }
          const providerRow = rows.find((row) => row.id === startClaim.command.id);
          const cancelRow = rows.find((row) => row.id === cancelClaim.command.id);
          assert.deepEqual(JSON.parse(providerRow.outcome_json), providerOutcome);
          assert.deepEqual(JSON.parse(cancelRow.outcome_json), cancelCompletion.outcome);
          const recovery = persisted.prepare(`
            SELECT checkpoint, terminal_status, termination_verified
            FROM workbench_execution_recovery WHERE execution_id = ?
          `).get(startClaim.command.executionId);
          assert.equal(recovery.checkpoint, "completed");
          assert.equal(recovery.terminal_status, variant.status);
          assert.equal(recovery.termination_verified, 1);
          const activeClaim = persisted.prepare(`
            SELECT COUNT(*) AS count FROM workbench_outbox
            WHERE run_id = ? AND (state = 'claimed' OR lease_expires_at IS NOT NULL OR reservation_active = 1)
          `).get(created.run.id);
          assert.equal(activeClaim.count, 0);
          const terminalEvents = persisted.prepare(`
            SELECT payload_json FROM workbench_events WHERE run_id = ? AND type = 'status'
          `).all(created.run.id).filter(({ payload_json }) =>
            JSON.parse(payload_json).status === variant.status);
          assert.equal(terminalEvents.length, 1);
        } finally {
          persisted.close();
        }

        const plane = new DurableWorkbenchControlPlane(store, {
          runtimeController: { ensureReady() {}, kick() {} },
        });
        const presentation = plane.get(created.run.id);
        assert.equal(presentation.run.status, variant.status);
        assert.equal(presentation.run.pid, null);
        assert.deepEqual(presentation.stop, { state: "stopped_and_verified", verified: true });
      } finally {
        try { startRepository?.close(); } catch { /* already closed */ }
        try { cancelRepository?.close(); } catch { /* already closed */ }
        store.close();
        await new Promise((resolve) => setTimeout(resolve, 100));
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    });
  }
});

test("provider circuit survives repository restart and filters only its provider", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  const codex = command(store, "circuit-codex", { provider: "codex" });
  const claude = command(store, "circuit-claude", { provider: "claude" });
  const openedAt = "2030-03-01T00:00:00.000Z";
  let repository = new SqliteDurableWorkerRepository(databasePath);
  try {
    const openingClaim = await claimAt(repository, "opening-worker", openedAt);
    assert.ok(openingClaim);
    const permit = await circuitPermit(repository, openingClaim, openedAt);
    assert.equal((await failAndReschedule(repository, openingClaim, permit, openedAt)).status, "applied");
    const opened = await repository.loadProviderCircuit("codex");
    assert.equal(opened.state, "open");
    assert.equal(opened.consecutiveFailures, 1);
    repository.close();

    repository = new SqliteDurableWorkerRepository(databasePath);
    assert.equal((await repository.loadProviderCircuit("codex")).state, "open");
    assert.equal((await repository.loadProviderCircuit("claude")).state, "closed");
    const claim = await claimAt(repository, "provider-scoped-worker", "2030-03-01T00:00:30.000Z");
    assert.ok(claim);
    assert.equal(claim.command.runId, claude.run.id);
    assert.equal(store.getRun(codex.run.id).status, "queued");
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("two repository instances grant exactly one half-open provider probe", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  let seed = new SqliteDurableWorkerRepository(databasePath);
  let left;
  let right;
  try {
    command(store, "half-open-seed", { provider: "codex" });
    command(store, "half-open-left", { provider: "codex" });
    command(store, "half-open-right", { provider: "codex" });
    const seedClaim = await claimAt(seed, "seed-worker", "2030-03-01T00:00:00.000Z");
    const leftClaim = await claimAt(seed, "half-open-left", "2030-03-01T00:00:00.000Z");
    const rightClaim = await claimAt(seed, "half-open-right", "2030-03-01T00:00:00.000Z");
    assert.ok(seedClaim && leftClaim && rightClaim);
    const seedPermit = await circuitPermit(seed, seedClaim, "2030-03-01T00:00:00.000Z");
    await failAndReschedule(seed, seedClaim, seedPermit, "2030-03-01T00:00:00.000Z", {
      resetMs: 1_000,
    });
    const opened = await seed.loadProviderCircuit("codex");
    assert.equal(opened.state, "open");
    seed.close();
    left = new SqliteDurableWorkerRepository(databasePath);
    right = new SqliteDurableWorkerRepository(databasePath);
    const [a, b] = await Promise.all([
      circuitPermit(left, leftClaim, "2030-03-01T00:00:01.000Z"),
      circuitPermit(right, rightClaim, "2030-03-01T00:00:01.000Z"),
    ]);
    assert.equal([a, b].filter(({ allowed }) => allowed).length, 1);
    assert.equal([a, b].filter(({ allowed }) => !allowed).length, 1);
    const persisted = await left.loadProviderCircuit("codex");
    assert.equal(persisted.state, "half_open");
    assert.ok(["half-open-left", "half-open-right"].includes(persisted.halfOpenOwner));
    const winnerRepository = a.allowed ? left : right;
    const winnerClaim = a.allowed ? leftClaim : rightClaim;
    const winnerPermit = a.allowed ? a : b;
    await registerRunning(winnerRepository, winnerClaim, "2030-03-01T00:00:02.000Z");
    assert.equal(
      (await winnerRepository.completeCommand(
        completion(winnerClaim, winnerPermit, "2030-03-01T00:00:02.000Z"),
      )).status,
      "applied",
    );
    const closed = await left.loadProviderCircuit("codex");
    assert.equal(closed.state, "closed");
    assert.equal(closed.consecutiveFailures, 0);
  } finally {
    left?.close();
    right?.close();
    try { seed.close(); } catch { /* already closed */ }
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired half-open lease is reclaimed with a newer circuit fencing token", async () => {
  const fixture = await halfOpenRaceFixture();
  const left = new SqliteDurableWorkerRepository(fixture.databasePath);
  const right = new SqliteDurableWorkerRepository(fixture.databasePath);
  try {
    const oldPermit = await circuitPermit(
      left,
      fixture.oldClaim,
      "2031-03-01T00:00:01.000Z",
      1_000,
    );
    const newPermit = await circuitPermit(
      right,
      fixture.newClaim,
      "2031-03-01T00:00:02.000Z",
      1_000,
    );
    assert.equal(oldPermit.allowed, true);
    assert.equal(newPermit.allowed, true);
    assert.equal(oldPermit.lease.probe, true);
    assert.equal(newPermit.lease.probe, true);
    assert.ok(newPermit.lease.fencingToken > oldPermit.lease.fencingToken);
    const current = await left.loadProviderCircuit("codex");
    assert.equal(current.halfOpenOwner, "new-worker");
    assert.equal(current.fencingToken, newPermit.lease.fencingToken);
  } finally {
    left.close();
    right.close();
    fixture.seed.close();
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("stale half-open owner and token cannot close or reopen the provider circuit", async () => {
  const fixture = await halfOpenRaceFixture();
  const repository = new SqliteDurableWorkerRepository(fixture.databasePath);
  try {
    const oldPermit = await circuitPermit(
      repository,
      fixture.oldClaim,
      "2031-03-01T00:00:01.000Z",
      1_000,
    );
    const newPermit = await circuitPermit(
      repository,
      fixture.newClaim,
      "2031-03-01T00:00:02.000Z",
      1_000,
    );
    assert.equal(oldPermit.allowed && newPermit.allowed, true);
    await registerRunning(repository, fixture.oldClaim, "2031-03-01T00:00:02.050Z");
    assert.equal(
      (await repository.completeCommand(
        completion(fixture.oldClaim, oldPermit, "2031-03-01T00:00:02.100Z"),
      )).status,
      "applied",
    );
    const current = await repository.loadProviderCircuit("codex");
    assert.equal(current.state, "half_open");
    assert.equal(current.halfOpenOwner, "new-worker");
    assert.equal(current.fencingToken, newPermit.lease.fencingToken);
  } finally {
    repository.close();
    fixture.seed.close();
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("lost command fence cannot mutate provider circuit state", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  command(store, "lost-command-fence", { provider: "codex" });
  const repository = new SqliteDurableWorkerRepository(databasePath);
  try {
    const first = await claimAt(repository, "old-worker", "2032-03-01T00:00:00.000Z", 1_000);
    assert.ok(first);
    const oldPermit = await circuitPermit(repository, first, "2032-03-01T00:00:00.000Z");
    assert.equal(oldPermit.allowed, true);
    const reclaimed = await claimAt(repository, "new-worker", "2032-03-01T00:00:02.000Z", 30_000);
    assert.ok(reclaimed);
    assert.ok(reclaimed.lease.fencingToken > first.lease.fencingToken);
    const staleAcquire = await circuitPermit(
      repository,
      first,
      "2032-03-01T00:00:02.100Z",
    );
    assert.equal(staleAcquire.allowed, false);
    assert.equal(staleAcquire.reason, "stale_fence");
    assert.equal(
      (await failAndReschedule(
        repository,
        first,
        oldPermit,
        "2032-03-01T00:00:02.100Z",
      )).status,
      "stale_fence",
    );
    const circuit = await repository.loadProviderCircuit("codex");
    assert.equal(circuit.state, "closed");
    assert.equal(circuit.consecutiveFailures, 0);
    assert.equal(circuit.fencingToken, oldPermit.lease.fencingToken);
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("newer half-open failure wins and stale success cannot overwrite it", async () => {
  const fixture = await halfOpenRaceFixture();
  const repository = new SqliteDurableWorkerRepository(fixture.databasePath);
  try {
    const oldPermit = await circuitPermit(
      repository,
      fixture.oldClaim,
      "2031-03-01T00:00:01.000Z",
      1_000,
    );
    const newPermit = await circuitPermit(
      repository,
      fixture.newClaim,
      "2031-03-01T00:00:02.000Z",
      1_000,
    );
    assert.equal(oldPermit.allowed && newPermit.allowed, true);
    await registerRunning(repository, fixture.oldClaim, "2031-03-01T00:00:02.050Z");
    assert.equal(
      (await failAndReschedule(
        repository,
        fixture.newClaim,
        newPermit,
        "2031-03-01T00:00:02.100Z",
        { resetMs: 60_000 },
      )).status,
      "applied",
    );
    assert.equal(
      (await repository.completeCommand(
        completion(fixture.oldClaim, oldPermit, "2031-03-01T00:00:02.100Z"),
      )).status,
      "applied",
    );
    const current = await repository.loadProviderCircuit("codex");
    assert.equal(current.state, "open");
    assert.equal(current.fencingToken, newPermit.lease.fencingToken);
    assert.equal(current.halfOpenOwner, null);
  } finally {
    repository.close();
    fixture.seed.close();
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("claimNext keyset pagination reaches eligible work after more than 200 inadmissible rows", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const generous = {
    cpuTimeMs: 10_000,
    residentMemoryBytes: 10_000,
    diskBytes: 10_000,
    processCount: 10_000,
    outputBytes: 10_000,
  };
  const store = new WorkbenchStore(databasePath, {
    admissionPolicy: {
      maxActiveRuns: 5,
      maxQueuedRuns: 500,
      perRun: generous,
      aggregate: {
        cpuTimeMs: 50_000,
        residentMemoryBytes: 50_000,
        diskBytes: 50_000,
        processCount: 50_000,
        outputBytes: 50_000,
      },
    },
  });
  let repository;
  try {
    const tooLarge = {
      cpuTimeMs: 2,
      residentMemoryBytes: 2,
      diskBytes: 2,
      processCount: 2,
      outputBytes: 2,
    };
    for (let index = 0; index < 200; index += 1) {
      command(store, `starvation-ineligible-${index}`, {
        resources: tooLarge,
        availableAt: "2026-01-01T00:00:00.000Z",
      });
    }
    const eligible = command(store, "starvation-eligible", {
      resources: {
        cpuTimeMs: 1,
        residentMemoryBytes: 1,
        diskBytes: 1,
        processCount: 1,
        outputBytes: 1,
      },
      availableAt: "2026-01-01T00:00:01.000Z",
    });
    repository = new SqliteDurableWorkerRepository(databasePath);
    const claim = await repository.claimNext({
      workerId: "pagination-worker",
      now: "2026-02-01T00:00:00.000Z",
      leaseDurationMs: 30_000,
      admissionPolicy: {
        maxActiveRuns: 5,
        maxQueuedRuns: 500,
        perRun: {
          cpuTimeMs: 1,
          residentMemoryBytes: 1,
          diskBytes: 1,
          processCount: 1,
          outputBytes: 1,
        },
        aggregate: {
          cpuTimeMs: 5,
          residentMemoryBytes: 5,
          diskBytes: 5,
          processCount: 5,
          outputBytes: 5,
        },
      },
      excludedProviders: [],
    });
    assert.ok(claim);
    assert.equal(claim.command.runId, eligible.run.id);
  } finally {
    repository?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dedicated control lane bypasses open circuits and saturated admission without reserving provider resources", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  const repository = new SqliteDurableWorkerRepository(databasePath);
  const startedAt = "2033-02-01T00:00:00.000Z";
  try {
    const target = command(store, "control-lane-target", { provider: "codex" });
    const targetClaim = await repository.claimNext({
      workerId: "provider-target",
      now: startedAt,
      leaseDurationMs: 30_000,
      admissionPolicy: CIRCUIT_TEST_ADMISSION,
      lane: "provider",
      excludedProviders: [],
    });
    assert.ok(targetClaim);
    await registerRunning(repository, targetClaim, startedAt);

    command(store, "control-lane-circuit-breaker", { provider: "codex" });
    const breakerClaim = await repository.claimNext({
      workerId: "provider-breaker",
      now: startedAt,
      leaseDurationMs: 30_000,
      admissionPolicy: CIRCUIT_TEST_ADMISSION,
      lane: "provider",
      excludedProviders: [],
    });
    assert.ok(breakerClaim);
    const breakerPermit = await circuitPermit(repository, breakerClaim, startedAt);
    assert.equal((await failAndReschedule(repository, breakerClaim, breakerPermit, startedAt)).status, "applied");
    assert.equal((await repository.loadProviderCircuit("codex")).state, "open");

    for (let index = 0; index < 4; index += 1) {
      command(store, `control-lane-saturation-${index}`, { provider: "claude" });
      const claim = await repository.claimNext({
        workerId: `provider-saturation-${index}`,
        now: startedAt,
        leaseDurationMs: 30_000,
        admissionPolicy: CIRCUIT_TEST_ADMISSION,
        lane: "provider",
        excludedProviders: [],
      });
      assert.ok(claim);
      await registerRunning(repository, claim, startedAt);
    }

    const stopping = store.transitionRunWithCommand({
      runId: target.run.id,
      to: "stopping",
      expectedFrom: "running",
      command: {
        type: "wave3.codex.cancel",
        idempotencyKey: `cancel:${target.run.id}`,
        payload: {
          operation: "cancel",
          targetExecutionId: targetClaim.command.executionId,
          targetJobObjectId: `agent-os-${targetClaim.command.executionId}`,
          maxAttempts: 1,
          resources: {
            cpuTimeMs: 99_999,
            residentMemoryBytes: 99_999,
            diskBytes: 99_999,
            processCount: 99_999,
            outputBytes: 99_999,
          },
        },
      },
      event: { payload: { stopState: "stopping", terminationVerified: false } },
    });

    const providerLane = await repository.claimNext({
      workerId: "provider-reserve-check",
      now: startedAt,
      leaseDurationMs: 30_000,
      admissionPolicy: CIRCUIT_TEST_ADMISSION,
      lane: "provider",
      excludedProviders: [],
    });
    assert.equal(providerLane, null);

    const zero = { cpuTimeMs: 0, residentMemoryBytes: 0, diskBytes: 0, processCount: 0, outputBytes: 0 };
    const controlClaim = await repository.claimNext({
      workerId: "dedicated-control",
      now: startedAt,
      leaseDurationMs: 30_000,
      admissionPolicy: {
        maxActiveRuns: 0,
        maxQueuedRuns: 0,
        perRun: zero,
        aggregate: zero,
      },
      lane: "control",
      excludedProviders: ["codex", "claude"],
    });
    assert.ok(controlClaim);
    assert.equal(controlClaim.command.id, stopping.command.id);
    assert.deepEqual(controlClaim.command.resources, zero);

    const persisted = new DatabaseSync(databasePath);
    try {
      const row = persisted.prepare(`
        SELECT reservation_active, resources_json FROM workbench_outbox WHERE id = ?
      `).get(stopping.command.id);
      assert.equal(row.reservation_active, 0);
      assert.deepEqual(JSON.parse(row.resources_json), zero);
    } finally {
      persisted.close();
    }
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const controlCrashBoundary of ["before_complete", "after_complete"]) {
test(`reserved control worker survives ${controlCrashBoundary} crash while five provider workers are blocked`, { timeout: 30_000 }, async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  const repository = new SqliteDurableWorkerRepository(databasePath);
  let resolveAllWaiting;
  let resolveControlCalled;
  const allWaiting = new Promise((resolve) => { resolveAllWaiting = resolve; });
  const controlCalled = new Promise((resolve) => { resolveControlCalled = resolve; });
  const waiters = new Map();
  let waitingCount = 0;
  let naturalCompletions = 0;
  const driver = {
    async reconcileOrSpawn(_command, identity, _signal, authorizeNewSpawn) {
      const authorization = await authorizeNewSpawn(launchAuthorizationRequest(identity));
      assert.ok(authorization.attempt);
      return {
        state: "running",
        process: {
          pid: 60_000 + waiters.size,
          jobObjectId: identity.jobObjectId,
          executablePath: "C:\\fake\\provider.exe",
          executableHash: "a".repeat(64),
          startedAt: "2033-02-02T00:00:00.000Z",
        },
      };
    },
    async waitForCompletion(_command, identity) {
      const outcome = await new Promise((resolve) => {
        waiters.set(identity.executionId, resolve);
        waitingCount += 1;
        if (waitingCount === 5) resolveAllWaiting();
      });
      return outcome;
    },
    async executeControl(command) {
      assert.equal(naturalCompletions, 0, "Stop must reach the reserved worker before a provider slot frees");
      const targetExecutionId = String(command.payload.targetExecutionId);
      const recovery = await repository.loadExecutionRecovery(targetExecutionId);
      assert.ok(recovery);
      assert.equal(recovery.checkpoint, "registered");
      const providerOutcome = {
        status: "cancelled",
        exitCode: 0,
        metadata: { reason: "active_process_zero", terminationVerified: true },
      };
      const targetIdentity = {
        executionId: recovery.executionId,
        commandId: recovery.commandId,
        runId: recovery.runId,
        jobObjectId: recovery.jobObjectId,
      };
      assert.equal(
        (await repository.recordVerifiedTerminalCheckpoint(
          verifiedTerminalInput(targetIdentity, providerOutcome, "2033-02-02T00:00:01.000Z"),
        )).status,
        "applied",
      );
      resolveControlCalled();
      waiters.get(targetExecutionId)(providerOutcome);
      return {
        ...providerOutcome,
        metadata: {
          ...providerOutcome.metadata,
          cancelRequested: true,
          cancelledBeforeCompletion: true,
        },
      };
    },
    async abortAndVerify() {
      return true;
    },
  };
  const providerWorkers = Array.from({ length: 5 }, (_, index) => new DurableWorkbenchWorker(
    repository,
    driver,
    {
      workerId: `saturated-provider-${index}`,
      lane: "provider",
      admissionPolicy: CIRCUIT_TEST_ADMISSION,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 2_000,
    },
  ));
  const controlWorker = new DurableWorkbenchWorker(repository, driver, {
    workerId: "reserved-control-worker",
    lane: "control",
    admissionPolicy: CIRCUIT_TEST_ADMISSION,
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 2_000,
    crashInjector: crashAt(controlCrashBoundary),
  });
  try {
    const created = Array.from({ length: 5 }, (_, index) => command(store, `reserved-worker-${index}`, {
      provider: index === 0 ? "codex" : "claude",
      resources: { cpuTimeMs: 1, residentMemoryBytes: 1, diskBytes: 1, processCount: 1, outputBytes: 1 },
    }));
    const providerRuns = providerWorkers.map((worker) => worker.runOnce());
    await allWaiting;

    const targetCommand = store.outboxForRun(created[0].run.id)[0];
    const stopping = store.transitionRunWithCommand({
      runId: created[0].run.id,
      to: "stopping",
      expectedFrom: "running",
      command: {
        type: "wave3.codex.cancel",
        idempotencyKey: `cancel:${created[0].run.id}`,
        payload: {
          operation: "cancel",
          targetExecutionId: targetCommand.executionId,
          targetJobObjectId: `agent-os-${targetCommand.executionId}`,
          maxAttempts: 1,
        },
      },
      event: { payload: { stopState: "stopping", terminationVerified: false } },
    });
    const controlRun = controlWorker.runOnce();
    await Promise.race([
      controlCalled,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Reserved control worker did not execute Stop.")), 5_000)),
    ]);

    for (const [executionId, resolve] of waiters) {
      if (executionId === targetCommand.executionId) continue;
      naturalCompletions += 1;
      resolve({ status: "succeeded", exitCode: 0 });
    }
    const [controlResult, ...providerResults] = await Promise.allSettled([controlRun, ...providerRuns]);
    assert.equal(controlResult.status, "rejected");
    assert.ok(controlResult.reason instanceof WorkerProcessCrash);
    assert.equal(controlResult.reason.boundary, controlCrashBoundary);
    assert.ok(providerResults.every(({ status, value }) => status === "fulfilled" && value.status === "completed"));
    assert.equal(store.getRun(created[0].run.id).status, "cancelled");
    assert.equal(store.getOutboxCommand(stopping.command.id).state, "completed");
    assert.deepEqual(await controlWorker.runOnce(), { status: "idle" });

    const persisted = new DatabaseSync(databasePath);
    try {
      const row = persisted.prepare(`
        SELECT COUNT(*) AS count FROM workbench_outbox
        WHERE state = 'claimed' OR reservation_active = 1 OR claimed_by IS NOT NULL OR lease_expires_at IS NOT NULL
      `).get();
      assert.equal(row.count, 0);
    } finally {
      persisted.close();
    }
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
}

test("cancelled run generation fences an already-claimed provider command", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  const created = command(store, "cancel-generation-fence");
  const repository = new SqliteDurableWorkerRepository(databasePath);
  try {
    const claimedAt = "2033-03-01T00:00:00.000Z";
    const claim = await claimAt(repository, "cancelled-worker", claimedAt);
    assert.ok(claim);
    const permit = await circuitPermit(repository, claim, claimedAt);
    assert.equal(permit.allowed, true);
    assert.equal(store.getOutboxCommand(claim.command.id).providerAttemptCount, 0);

    store.updateRun(created.run.id, {
      status: "cancelled",
      finishedAt: "2033-03-01T00:00:01.000Z",
      pid: null,
    });
    assert.equal(store.getOutboxCommand(claim.command.id).state, "dead");
    assert.equal(
      (await repository.completeCommand(
        completion(claim, permit, "2033-03-01T00:00:02.000Z"),
      )).status,
      "stale_fence",
    );
    assert.equal(store.getRun(created.run.id).status, "cancelled");
    assert.equal(await claimAt(repository, "replacement-worker", "2033-03-01T00:00:03.000Z"), null);
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown operation is DB-constrained and dead-lettered without provider execution", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  const created = command(store, "unknown-operation", {
    operation: "teleport",
    // An explicit invalid operation must not be inferred back to `start` from
    // an otherwise recognizable command type.
    commandType: "provider.start",
  });
  const repository = new SqliteDurableWorkerRepository(databasePath);
  const inspector = new DatabaseSync(databasePath);
  try {
    assert.equal(created.command.operation, "unknown");
    assert.throws(
      () => inspector.prepare("UPDATE workbench_outbox SET operation = 'teleport' WHERE id = ?").run(created.command.id),
      /CHECK constraint failed/u,
    );
    const claim = await claimAt(repository, "unknown-operation-worker", "2034-03-01T00:00:00.000Z");
    assert.equal(claim, null);
    assert.equal(store.getOutboxCommand(created.command.id).state, "dead");
    assert.equal(store.getOutboxCommand(created.command.id).providerAttemptCount, 0);
    assert.equal(store.getRun(created.run.id).status, "failed");
    assert.equal(store.getRun(created.run.id).error.code, "unknown_operation");
  } finally {
    inspector.close();
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-retryable provider quota is durably blocked rather than reported as a product failure", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  const created = command(store, "provider-quota-blocked");
  const repository = new SqliteDurableWorkerRepository(databasePath);
  try {
    const now = "2034-04-01T00:00:00.000Z";
    const claim = await claimAt(repository, "quota-worker", now);
    assert.ok(claim);
    const permit = await circuitPermit(repository, claim, now);
    assert.equal(permit.allowed, true);
    const result = await repository.deadLetterCommand({
      ...guard(claim, now),
      attempt: claim.command.attempt,
      failure: { failureClass: "quota", message: "Provider quota is unavailable." },
      circuit: permit.lease,
      countsTowardCircuit: false,
      circuitFailureThreshold: 3,
      circuitResetMs: 60_000,
      completedAt: now,
    });
    assert.equal(result.status, "applied");
    assert.equal(store.getRun(created.run.id).status, "blocked");
    assert.equal(store.getRun(created.run.id).error.code, "quota");
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified terminal recovery replays before provider attempt cap and keeps counters separate", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  const created = command(store, "terminal-before-attempt-cap", { maxAttempts: 1 });
  const repository = new SqliteDurableWorkerRepository(databasePath);
  try {
    const firstAt = "2035-03-01T00:00:00.000Z";
    const first = await claimAt(repository, "first-delivery", firstAt, 1_000);
    assert.ok(first);
    const firstPermit = await circuitPermit(repository, first, firstAt);
    assert.equal(firstPermit.allowed, true);
    const identity = {
      executionId: first.command.executionId,
      commandId: first.command.id,
      runId: first.command.runId,
      jobObjectId: `agent-os-${first.command.executionId}`,
    };
    assert.equal((await repository.recordVerifiedTerminalCheckpoint(verifiedTerminalInput(
      identity,
      { status: "succeeded", exitCode: 0 },
      "2035-03-01T00:00:00.500Z",
    ))).status, "applied");

    const replayAt = "2035-03-01T00:00:02.000Z";
    const replay = await claimAt(repository, "recovery-delivery", replayAt);
    assert.ok(replay);
    assert.equal(replay.command.attempt, 1);
    assert.equal(replay.command.deliveryAttempts, 2);
    const replayPermit = await circuitPermit(repository, replay, replayAt);
    assert.equal(replayPermit.allowed, true);
    assert.equal(store.getOutboxCommand(created.command.id).providerAttemptCount, 0);
    assert.equal(store.getOutboxCommand(created.command.id).deliveryAttemptCount, 2);

    assert.equal((await repository.recordSpawnIntent({
      ...guard(replay, "2035-03-01T00:00:02.100Z"),
      attempt: replay.command.attempt,
      identity,
    })).status, "applied");
    const terminalRecovery = await repository.loadExecutionRecovery(identity.executionId);
    assert.equal(terminalRecovery.recoveryAction, "terminal_replay");
    assert.equal(terminalRecovery.process, null);
    assert.equal(
      (await repository.completeCommand(
        completion(replay, replayPermit, "2035-03-01T00:00:02.200Z"),
      )).status,
      "applied",
    );
    assert.equal(store.getRun(created.run.id).status, "succeeded");
    assert.equal(store.getOutboxCommand(created.command.id).providerAttemptCount, 0);
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("external status high-water rejects rollback, fork and terminal regression", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  command(store, "external-status-high-water");
  const repository = new SqliteDurableWorkerRepository(databasePath);
  try {
    const claimedAt = "2035-04-01T00:00:00.000Z";
    const claim = await claimAt(repository, "external-status-worker", claimedAt);
    assert.ok(claim);
    const identity = {
      executionId: claim.command.executionId,
      commandId: claim.command.id,
      runId: claim.command.runId,
      jobObjectId: `agent-os-${claim.command.executionId}`,
    };
    const status1 = {
      ...identity,
      journalGeneration: "1".repeat(32),
      sequence: 1,
      previousSequence: 0,
      previousSnapshotDigestSha256: "0".repeat(64),
      previousJournalDigestSha256: "0".repeat(64),
      terminal: false,
      snapshotDigestSha256: "a".repeat(64),
      journalDigestSha256: "b".repeat(64),
      authenticatedPayloadDigestSha256: "c".repeat(64),
      nativeTerminalDigestSha256: null,
      nativeTerminalStatus: null,
      nativeExitCode: null,
      terminationVerified: false,
      observedAt: claimedAt,
    };
    assert.equal((await repository.acceptExternalStatusHighWater(status1)).status, "applied");
    assert.equal((await repository.acceptExternalStatusHighWater(status1)).status, "already_applied");
    assert.deepEqual(
      (await repository.loadExecutionRecovery(identity.executionId)).externalStatusHighWater,
      {
        ...status1,
        chainVersion: 2,
        controllerOutcomeDigestSha256: null,
        updatedAt: status1.observedAt,
      },
    );
    assert.equal((await repository.acceptExternalStatusHighWater({
      ...status1,
      snapshotDigestSha256: "c".repeat(64),
    })).status, "conflict");
    assert.equal((await repository.acceptExternalStatusHighWater({
      ...status1,
      journalGeneration: "2".repeat(32),
      sequence: 2,
    })).status, "conflict");

    const status2 = {
      ...status1,
      sequence: 2,
      previousSequence: 1,
      previousSnapshotDigestSha256: status1.snapshotDigestSha256,
      previousJournalDigestSha256: status1.journalDigestSha256,
      snapshotDigestSha256: "d".repeat(64),
      journalDigestSha256: "e".repeat(64),
      authenticatedPayloadDigestSha256: "f".repeat(64),
      observedAt: "2035-04-01T00:00:01.000Z",
    };
    assert.equal((await repository.acceptExternalStatusHighWater({
      ...status2,
      previousJournalDigestSha256: "8".repeat(64),
    })).status, "conflict");
    assert.equal((await repository.acceptExternalStatusHighWater(status2)).status, "applied");

    const outcome = { status: "succeeded", exitCode: 0 };
    const controllerOutcomeDigestSha256 = durableOutcomeDigestSha256(outcome);
    const terminal = {
      ...status2,
      sequence: 3,
      previousSequence: 2,
      previousSnapshotDigestSha256: status2.snapshotDigestSha256,
      previousJournalDigestSha256: status2.journalDigestSha256,
      terminal: true,
      snapshotDigestSha256: "1".repeat(64),
      journalDigestSha256: "2".repeat(64),
      authenticatedPayloadDigestSha256: "3".repeat(64),
      nativeTerminalDigestSha256: "4".repeat(64),
      nativeTerminalStatus: "succeeded",
      nativeExitCode: 0,
      terminationVerified: true,
      observedAt: "2035-04-01T00:00:02.000Z",
    };
    const terminalInput = {
      ...identity,
      statusEvidence: terminal,
      outcome,
      controllerOutcomeDigestSha256,
      observedAt: terminal.observedAt,
      terminationVerified: true,
      source: "windows_job_helper",
    };
    assert.equal((await repository.recordVerifiedTerminalCheckpoint(terminalInput)).status, "applied");
    assert.equal((await repository.recordVerifiedTerminalCheckpoint(terminalInput)).status, "already_applied");
    assert.deepEqual(
      (await repository.loadExecutionRecovery(identity.executionId)).externalStatusHighWater,
      {
        ...terminal,
        chainVersion: 2,
        controllerOutcomeDigestSha256,
        updatedAt: terminal.observedAt,
      },
    );
    assert.equal((await repository.acceptExternalStatusHighWater({
      ...terminal,
      sequence: 4,
      previousSequence: 3,
      previousSnapshotDigestSha256: terminal.snapshotDigestSha256,
      previousJournalDigestSha256: terminal.journalDigestSha256,
      terminal: false,
      snapshotDigestSha256: "f".repeat(64),
      journalDigestSha256: "0".repeat(64),
      nativeTerminalDigestSha256: null,
      nativeTerminalStatus: null,
      nativeExitCode: null,
      terminationVerified: false,
    })).status, "conflict");
    assert.equal((await repository.recordVerifiedTerminalCheckpoint({
      ...terminalInput,
      commandId: "different-command",
    })).status, "conflict");
    assert.equal(
      (await repository.loadExecutionRecovery(identity.executionId)).terminal.outcome.status,
      "succeeded",
    );

    const inspector = new DatabaseSync(databasePath);
    try {
      inspector.exec("PRAGMA foreign_keys = ON");
      assert.throws(
        () => inspector.prepare(`
          UPDATE workbench_external_status_high_water SET status_sequence = 1
          WHERE execution_id = ?
        `).run(identity.executionId),
        /external_status_chain_v2_conflict/u,
      );
    } finally {
      inspector.close();
    }
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal checkpoint rejects an outcome that is not bound to the exact authenticated HWM tuple", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath);
  command(store, "terminal-hwm-outcome-binding");
  const repository = new SqliteDurableWorkerRepository(databasePath);
  try {
    const observedAt = "2035-05-01T00:00:00.000Z";
    const claim = await claimAt(repository, "terminal-binding-worker", observedAt);
    assert.ok(claim);
    const identity = {
      executionId: claim.command.executionId,
      commandId: claim.command.id,
      runId: claim.command.runId,
      jobObjectId: `agent-os-${claim.command.executionId}`,
    };
    const terminalEvidence = {
      ...identity,
      journalGeneration: "7".repeat(32),
      sequence: 1,
      previousSequence: 0,
      previousSnapshotDigestSha256: "0".repeat(64),
      previousJournalDigestSha256: "0".repeat(64),
      terminal: true,
      snapshotDigestSha256: "1".repeat(64),
      journalDigestSha256: "2".repeat(64),
      authenticatedPayloadDigestSha256: "3".repeat(64),
      nativeTerminalDigestSha256: "4".repeat(64),
      nativeTerminalStatus: "succeeded",
      nativeExitCode: 0,
      terminationVerified: true,
      observedAt,
    };
    assert.equal((await repository.recordVerifiedTerminalCheckpoint({
      ...identity,
      statusEvidence: terminalEvidence,
      outcome: { status: "succeeded", exitCode: 0 },
      // Deliberately not the digest of the supplied succeeded outcome.
      controllerOutcomeDigestSha256: "5".repeat(64),
      observedAt,
      terminationVerified: true,
      source: "windows_job_helper",
    })).status, "conflict");
    const recovery = await repository.loadExecutionRecovery(identity.executionId);
    assert.equal(recovery.externalStatusHighWater, null);
    assert.equal(recovery.terminal, null);
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository event writer obeys canonical DB quota and rolls back the claim", async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const store = new WorkbenchStore(databasePath, {
    eventQuotaPolicy: {
      maxPayloadBytesPerEvent: 512,
      maxRetainedEventsPerRun: 1,
      maxStoreBytes: 4_096,
      maxSnapshotBytes: 512,
    },
  });
  const created = command(store, "repository-event-quota");
  const repository = new SqliteDurableWorkerRepository(databasePath);
  try {
    await assert.rejects(
      claimAt(repository, "quota-worker", "2036-03-01T00:00:00.000Z"),
      /event_store_full/u,
    );
    const commandAfter = store.getOutboxCommand(created.command.id);
    assert.equal(commandAfter.state, "pending");
    assert.equal(commandAfter.deliveryAttemptCount, 0);
    assert.equal(store.getRun(created.run.id).status, "queued");
    assert.equal(await repository.loadExecutionRecovery(created.command.idempotencyKey), null);
  } finally {
    repository.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("event paging reconnects beyond 500 events and reports compaction gaps", () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  let store = new WorkbenchStore(databasePath);
  try {
    const created = command(store, "event-page");
    for (let index = 0; index < 650; index += 1) {
      store.appendEvent(created.run.id, "message", { index });
    }
    store.close();
    store = new WorkbenchStore(databasePath);
    let cursor = 0;
    let count = 0;
    do {
      const page = store.eventPage(created.run.id, cursor, 125);
      count += page.events.length;
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (true);
    assert.equal(count, 651);
    const through = store.eventPage(created.run.id, 0, 100).nextCursor;
    store.compactEvents(created.run.id, through, { status: "queued", cursor: through });
    store.close();
    store = new WorkbenchStore(databasePath);
    const gap = store.eventPage(created.run.id, 0, 50);
    assert.equal(gap.gap?.snapshot.cursor, through);
    assert.equal(gap.events[0].sequence > through, true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
