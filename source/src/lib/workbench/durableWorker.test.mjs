import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = process.cwd();

registerHooks({
  resolve(specifier, context, nextResolve) {
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

const {
  crashAt,
  DurableExecutionError,
  DurableWorkbenchWorker,
  LeaseHeartbeat,
  transientFailure,
  WorkerProcessCrash,
} = await import("./durableWorker.ts");
const {
  DEFAULT_ADMISSION_POLICY,
  DEFAULT_RESOURCE_REQUEST,
  evaluateClaimAdmission,
  evaluateQueueAdmission,
} = await import("./resourceAdmission.ts");
const {
  ProviderCircuitBreaker,
  retryDecision,
  runWithAttemptTimeout,
} = await import("./retryPolicy.ts");

const BASE_TIME = Date.parse("2026-08-13T12:00:00.000Z");

function command(overrides = {}) {
  return {
    id: "command-1",
    runId: "run-1",
    provider: "codex",
    operation: "start",
    payload: { prompt: "safe" },
    payloadHash: "sha256:payload",
    idempotencyKey: "actor:project:start:payload",
    executionId: "execution-stable-1",
    attempt: 1,
    deliveryAttempts: 1,
    maxAttempts: 3,
    checkpoint: "dequeued",
    availableAt: new Date(BASE_TIME).toISOString(),
    resources: { ...DEFAULT_RESOURCE_REQUEST },
    ...overrides,
  };
}

function claim(overrides = {}) {
  return {
    command: command(overrides.command),
    lease: {
      workerId: "worker-1",
      fencingToken: 41,
      expiresAt: new Date(BASE_TIME + 30_000).toISOString(),
      ...overrides.lease,
    },
  };
}

function applied() {
  return Promise.resolve({ status: "applied" });
}

function closedCircuit(provider = "codex", updatedAt = new Date(BASE_TIME).toISOString()) {
  return {
    provider,
    state: "closed",
    fencingToken: 7,
    consecutiveFailures: 0,
    openUntil: null,
    halfOpenOwner: null,
    halfOpenLeaseExpiresAt: null,
    updatedAt,
  };
}

function repository(claims = [claim()], overrides = {}) {
  const state = {
    claims: [...claims],
    calls: [],
    providerAttempts: 0,
  };
  return {
    state,
    async claimNext(input) {
      state.calls.push(["claimNext", input]);
      return state.claims.shift() ?? null;
    },
    async acquireProviderCircuit(input) {
      state.calls.push(["acquireProviderCircuit", input]);
      return {
        allowed: true,
        lease: { provider: input.provider, fencingToken: 7, probe: false },
        snapshot: closedCircuit(input.provider, input.now),
      };
    },
    async loadProviderCircuit(provider) {
      state.calls.push(["loadProviderCircuit", provider]);
      return closedCircuit(provider);
    },
    heartbeatLease(input) { state.calls.push(["heartbeatLease", input]); return applied(); },
    recordSpawnIntent(input) { state.calls.push(["recordSpawnIntent", input]); return applied(); },
    async authorizeProviderAttempt(input) {
      state.calls.push(["authorizeProviderAttempt", input]);
      state.providerAttempts += 1;
      const authorization = {
        ...input.identity,
        authorizationId: input.authorizationId,
        launchGeneration: input.launchGeneration,
        attempt: state.providerAttempts,
        journalGeneration: input.journalGeneration,
        descriptorHmacSha256: input.descriptorHmacSha256,
        authorizedAt: input.now,
      };
      return { status: "applied", attempt: state.providerAttempts, authorization };
    },
    recordSpawnObservation(input) { state.calls.push(["recordSpawnObservation", input]); return applied(); },
    registerProcess(input) { state.calls.push(["registerProcess", input]); return applied(); },
    completeCommand(input) { state.calls.push(["completeCommand", input]); return applied(); },
    rescheduleCommand(input) { state.calls.push(["rescheduleCommand", input]); return applied(); },
    rescheduleControlCommand(input) { state.calls.push(["rescheduleControlCommand", input]); return applied(); },
    deadLetterCommand(input) { state.calls.push(["deadLetterCommand", input]); return applied(); },
    deferCommand(input) { state.calls.push(["deferCommand", input]); return applied(); },
    ...overrides,
  };
}

function processIdentity() {
  return {
    pid: 4421,
    jobObjectId: "agent-os-execution-stable-1",
    executablePath: "C:\\runtime\\codex.exe",
    executableHash: "sha256:executable",
    startedAt: new Date(BASE_TIME).toISOString(),
  };
}

function successOutcome() {
  return { status: "succeeded", exitCode: 0 };
}

function launchAuthorizationRequest(identity, expectedAttempt = 1) {
  return {
    identity,
    authorizationId: `authorization-${expectedAttempt}`,
    launchGeneration: expectedAttempt,
    expectedAttempt,
    journalGeneration: "journal-generation-0123456789",
    descriptorHmacSha256: "a".repeat(64),
  };
}

function driver(overrides = {}) {
  const state = { spawnCalls: [], controlCalls: [], waitCalls: [], abortCalls: [] };
  return {
    state,
    async reconcileOrSpawn(receivedCommand, identity, signal, authorizeNewSpawn) {
      await authorizeNewSpawn(launchAuthorizationRequest(identity));
      state.spawnCalls.push({ receivedCommand, identity, signal });
      return { state: "running", process: processIdentity() };
    },
    async waitForCompletion(receivedCommand, identity, process, signal) {
      state.waitCalls.push({ receivedCommand, identity, process, signal });
      return successOutcome();
    },
    async executeControl(receivedCommand, identity, signal) {
      state.controlCalls.push({ receivedCommand, identity, signal });
      return successOutcome();
    },
    async abortAndVerify(receivedCommand, identity, reason) {
      state.abortCalls.push({ receivedCommand, identity, reason });
      return true;
    },
    ...overrides,
  };
}

function worker(store, executionDriver, overrides = {}) {
  return new DurableWorkbenchWorker(store, executionDriver, {
    workerId: "worker-1",
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
    now: () => BASE_TIME,
    random: () => 0.5,
    ...overrides,
  });
}

test("admission defaults enforce 5 active, queue 100 and every resource dimension", () => {
  assert.equal(DEFAULT_ADMISSION_POLICY.maxActiveRuns, 5);
  assert.equal(DEFAULT_ADMISSION_POLICY.maxQueuedRuns, 100);
  assert.deepEqual(
    Object.keys(DEFAULT_ADMISSION_POLICY.perRun).sort(),
    ["cpuTimeMs", "residentMemoryBytes", "diskBytes", "processCount", "outputBytes"].sort(),
  );
  const emptyReserved = { cpuTimeMs: 0, residentMemoryBytes: 0, diskBytes: 0, processCount: 0, outputBytes: 0 };
  assert.equal(evaluateQueueAdmission({ activeRuns: 0, queuedRuns: 99, reserved: emptyReserved }, { ...DEFAULT_RESOURCE_REQUEST }).accepted, true);
  assert.equal(evaluateQueueAdmission({ activeRuns: 0, queuedRuns: 100, reserved: emptyReserved }, { ...DEFAULT_RESOURCE_REQUEST }).code, "queue_full");
  assert.equal(evaluateClaimAdmission({ activeRuns: 5, queuedRuns: 1, reserved: emptyReserved }, { ...DEFAULT_RESOURCE_REQUEST }).code, "active_limit");
  assert.deepEqual(
    evaluateClaimAdmission(
      { activeRuns: 0, queuedRuns: 1, reserved: emptyReserved },
      { ...DEFAULT_RESOURCE_REQUEST, outputBytes: DEFAULT_ADMISSION_POLICY.perRun.outputBytes + 1 },
    ),
    {
      accepted: false,
      code: "per_run_budget_exceeded",
      detail: "outputBytes request exceeds the per-run budget.",
      resource: "outputBytes",
    },
  );
});

test("retry taxonomy uses capped exponential backoff, jitter, retry-after and attempt cap", () => {
  const policy = {
    maxAttempts: 3,
    attemptTimeoutMs: 100,
    baseDelayMs: 1_000,
    maxDelayMs: 10_000,
    jitterRatio: 0.2,
    circuitFailureThreshold: 2,
    circuitResetMs: 5_000,
    halfOpenMaxAttempts: 1,
  };
  assert.deepEqual(
    retryDecision(policy, { failureClass: "rate_limit", message: "slow", retryAfterMs: 3_000 }, 1, () => 0.5),
    { retry: true, delayMs: 3_000, reason: "retryable" },
  );
  assert.deepEqual(
    retryDecision(policy, { failureClass: "rate_limit", message: "slow", retryAfterMs: 3_000 }, 1, () => 0),
    { retry: true, delayMs: 3_000, reason: "retryable" },
    "negative jitter must never shorten the provider Retry-After lower bound",
  );
  assert.deepEqual(
    retryDecision(policy, { failureClass: "transient", message: "again" }, 2, () => 1),
    { retry: true, delayMs: 2_400, reason: "retryable" },
  );
  assert.deepEqual(
    retryDecision(policy, { failureClass: "transient", message: "again" }, 3),
    { retry: false, delayMs: null, reason: "attempt_cap" },
  );
  assert.deepEqual(
    retryDecision(policy, { failureClass: "auth", message: "bad token" }, 1),
    { retry: false, delayMs: null, reason: "non_retryable" },
  );
});

test("provider circuit opens, blocks, permits one half-open probe and closes on success", () => {
  const policy = {
    maxAttempts: 3,
    attemptTimeoutMs: 100,
    baseDelayMs: 10,
    maxDelayMs: 100,
    jitterRatio: 0,
    circuitFailureThreshold: 2,
    circuitResetMs: 1_000,
    halfOpenMaxAttempts: 1,
  };
  const breaker = new ProviderCircuitBreaker({ codex: policy });
  const failure = { failureClass: "provider_unavailable", message: "down" };
  breaker.recordFailure("codex", failure, BASE_TIME);
  breaker.recordFailure("codex", failure, BASE_TIME);
  assert.deepEqual(breaker.beforeAttempt("codex", BASE_TIME + 999), { allowed: false, retryAt: BASE_TIME + 1_000 });
  assert.deepEqual(breaker.beforeAttempt("codex", BASE_TIME + 1_000), { allowed: true });
  assert.deepEqual(breaker.beforeAttempt("codex", BASE_TIME + 1_000), { allowed: false, retryAt: BASE_TIME + 2_000 });
  breaker.recordSuccess("codex");
  assert.deepEqual(breaker.snapshot("codex"), {
    state: "closed",
    consecutiveFailures: 0,
    openUntil: null,
    halfOpenAttempts: 0,
  });
});

test("worker consults durable circuit permit and defers without provider execution when denied", async () => {
  const retryAt = new Date(BASE_TIME + 60_000).toISOString();
  let store;
  store = repository([claim()], {
    async acquireProviderCircuit(input) {
      store.state.calls.push(["acquireProviderCircuit", input]);
      return {
        allowed: false,
        reason: "circuit_open",
        retryAt,
        snapshot: {
          ...closedCircuit(input.provider, input.now),
          state: "open",
          consecutiveFailures: 3,
          openUntil: retryAt,
        },
      };
    },
  });
  const executionDriver = driver();
  const result = await worker(store, executionDriver).runOnce();
  assert.deepEqual(result, {
    status: "deferred",
    commandId: "command-1",
    availableAt: retryAt,
  });
  assert.deepEqual(
    store.state.calls.map(([name]) => name),
    ["claimNext", "acquireProviderCircuit", "deferCommand"],
  );
  assert.equal(executionDriver.state.spawnCalls.length, 0);
  assert.equal(executionDriver.state.controlCalls.length, 0);
});

test("attempt timeout aborts driver signal and yields timeout taxonomy", async () => {
  let aborted = false;
  await assert.rejects(
    runWithAttemptTimeout(
      (signal) => new Promise((_resolve) => signal.addEventListener("abort", () => { aborted = true; }, { once: true })),
      10,
    ),
    (error) => error instanceof DurableExecutionError && error.failure.failureClass === "timeout",
  );
  assert.equal(aborted, true);
});

test("lease heartbeat carries worker and fencing token and aborts on stale fence", async () => {
  const store = repository([]);
  store.heartbeatLease = async (input) => {
    store.state.calls.push(["heartbeatLease", input]);
    return { status: "stale_fence" };
  };
  const heartbeat = new LeaseHeartbeat(store, claim(), 30_000, () => BASE_TIME);
  assert.equal(await heartbeat.pulse(), false);
  assert.equal(heartbeat.signal.aborted, true);
  const input = store.state.calls.at(-1)[1];
  assert.equal(input.workerId, "worker-1");
  assert.equal(input.fencingToken, 41);
  assert.equal(input.expiresAt, new Date(BASE_TIME + 30_000).toISOString());
});

test("successful start uses stable execution handshake, fenced register and completion", async () => {
  const store = repository();
  const executionDriver = driver();
  const result = await worker(store, executionDriver).runOnce();
  assert.equal(result.status, "completed");
  assert.deepEqual(
    store.state.calls.map(([name]) => name),
    [
      "claimNext",
      "acquireProviderCircuit",
      "recordSpawnIntent",
      "authorizeProviderAttempt",
      "recordSpawnObservation",
      "registerProcess",
      "completeCommand",
    ],
  );
  assert.equal(executionDriver.state.spawnCalls[0].identity.executionId, "execution-stable-1");
  assert.equal(executionDriver.state.spawnCalls[0].identity.jobObjectId, "agent-os-execution-stable-1");
  for (const [, input] of store.state.calls.filter(([, input]) => "fencingToken" in input)) {
    assert.equal(input.fencingToken, 41);
  }
});

test("control commands are at-least-once idempotent deliveries and never spawn", async () => {
  const store = repository([claim({ command: { operation: "steer" } })]);
  const executionDriver = driver();
  const result = await worker(store, executionDriver).runOnce();
  assert.equal(result.status, "completed");
  assert.equal(executionDriver.state.spawnCalls.length, 0);
  assert.equal(executionDriver.state.controlCalls.length, 1);
  assert.deepEqual(
    store.state.calls.map(([name]) => name),
    ["claimNext", "acquireProviderCircuit", "completeCommand"],
  );
});

test("cancel bypasses provider circuit and timeout remains a non-terminal control retry", async () => {
  const store = repository([claim({ command: {
    operation: "cancel",
    payload: {
      targetExecutionId: "execution-target-1",
      targetJobObjectId: "agent-os-execution-target-1",
    },
  } })], {
    async acquireProviderCircuit() {
      assert.fail("cancel must never acquire or mutate the provider circuit");
    },
  });
  const executionDriver = driver({
    async executeControl(receivedCommand, identity, signal) {
      executionDriver.state.controlCalls.push({ receivedCommand, identity, signal });
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    async abortAndVerify(receivedCommand, identity, reason) {
      executionDriver.state.abortCalls.push({ receivedCommand, identity, reason });
      return false;
    },
  });
  const result = await worker(store, executionDriver, {
    lane: "control",
    retryPolicies: {
      codex: {
        maxAttempts: 3,
        attemptTimeoutMs: 10,
        baseDelayMs: 1,
        maxDelayMs: 10,
        jitterRatio: 0,
        circuitFailureThreshold: 1,
        circuitResetMs: 1_000,
        halfOpenMaxAttempts: 1,
      },
    },
  }).runOnce();
  assert.equal(result.status, "retry_scheduled");
  assert.equal(result.failure.failureClass, "transient");
  assert.equal(executionDriver.state.controlCalls.length, 1);
  assert.equal(executionDriver.state.abortCalls.length, 1);
  assert.deepEqual(
    store.state.calls.map(([name]) => name),
    ["claimNext", "rescheduleControlCommand"],
  );
  assert.equal(store.state.calls[0][1].lane, "control");
  assert.equal(store.state.calls.some(([name]) => name === "deadLetterCommand"), false);
  assert.equal(store.state.calls.some(([name]) => name === "rescheduleCommand"), false);
});

test("transient failure reschedules with fenced lease and stable command identity", async () => {
  const store = repository();
  const executionDriver = driver({
    async reconcileOrSpawn(_command, _identity, _signal, authorizeNewSpawn) {
      await authorizeNewSpawn(launchAuthorizationRequest(_identity));
      throw transientFailure("provider warming");
    },
  });
  const result = await worker(store, executionDriver).runOnce();
  assert.equal(result.status, "retry_scheduled");
  assert.equal(result.availableAt, new Date(BASE_TIME + 1_000).toISOString());
  const reschedule = store.state.calls.find(([name]) => name === "rescheduleCommand")[1];
  assert.equal(reschedule.attempt, 1);
  assert.equal(reschedule.fencingToken, 41);
  assert.equal(store.state.calls.some(([name]) => name === "completeCommand"), false);
});

test("auth failure dead-letters immediately while timed-out unverified process is containment failure", async () => {
  const authStore = repository();
  const authDriver = driver({
    async reconcileOrSpawn(_command, _identity, _signal, authorizeNewSpawn) {
      await authorizeNewSpawn(launchAuthorizationRequest(_identity));
      throw new DurableExecutionError({ failureClass: "auth", message: "credentials rejected" });
    },
  });
  const authResult = await worker(authStore, authDriver).runOnce();
  assert.equal(authResult.status, "dead_lettered");
  assert.equal(authResult.failure.failureClass, "auth");

  const timeoutStore = repository();
  const timeoutDriver = driver({
    async reconcileOrSpawn(_command, _identity, signal, authorizeNewSpawn) {
      await authorizeNewSpawn(launchAuthorizationRequest(_identity));
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    async abortAndVerify() { return false; },
  });
  const timeoutWorker = worker(timeoutStore, timeoutDriver, {
    retryPolicies: {
      codex: {
        maxAttempts: 3,
        attemptTimeoutMs: 10,
        baseDelayMs: 1,
        maxDelayMs: 10,
        jitterRatio: 0,
        circuitFailureThreshold: 3,
        circuitResetMs: 1_000,
        halfOpenMaxAttempts: 1,
      },
    },
  });
  const timeoutResult = await timeoutWorker.runOnce();
  assert.equal(timeoutResult.status, "dead_lettered");
  assert.equal(timeoutResult.failure.failureClass, "containment");
});

test("stale fencing token stops execution state mutation", async () => {
  const store = repository();
  store.registerProcess = async (input) => {
    store.state.calls.push(["registerProcess", input]);
    return { status: "stale_fence" };
  };
  const result = await worker(store, driver()).runOnce();
  assert.equal(result.status, "lease_lost");
  assert.equal(store.state.calls.some(([name]) => name === "completeCommand"), false);
});

for (const boundary of ["after_dequeue", "after_spawn", "after_register", "before_complete", "after_complete"]) {
  test(`crash injection exposes ${boundary} recovery boundary without failure disposition`, async () => {
    const store = repository();
    const executionDriver = driver();
    await assert.rejects(
      worker(store, executionDriver, { crashInjector: crashAt(boundary) }).runOnce(),
      (error) => error instanceof WorkerProcessCrash && error.boundary === boundary,
    );
    assert.equal(store.state.calls.some(([name]) => name === "rescheduleCommand" || name === "deadLetterCommand"), false);
  });
}

test("redelivery after spawn reconciles same execution and job identity instead of duplicating spawn", async () => {
  const firstStore = repository();
  const firstDriver = driver();
  await assert.rejects(
    worker(firstStore, firstDriver, { crashInjector: crashAt("after_spawn") }).runOnce(),
    WorkerProcessCrash,
  );
  assert.equal(firstDriver.state.spawnCalls.length, 1);

  const secondStore = repository([claim({
    command: { attempt: 2, checkpoint: "spawn_intent" },
    lease: { fencingToken: 42 },
  })]);
  const secondDriver = driver({
    async reconcileOrSpawn(receivedCommand, identity, signal) {
      secondDriver.state.spawnCalls.push({ receivedCommand, identity, signal });
      return { state: "completed", process: processIdentity(), outcome: successOutcome() };
    },
  });
  const result = await worker(secondStore, secondDriver).runOnce();
  assert.equal(result.status, "completed");
  assert.equal(firstDriver.state.spawnCalls[0].identity.executionId, secondDriver.state.spawnCalls[0].identity.executionId);
  assert.equal(firstDriver.state.spawnCalls[0].identity.jobObjectId, secondDriver.state.spawnCalls[0].identity.jobObjectId);
  assert.equal(
    secondStore.state.calls.some(([name]) => name === "authorizeProviderAttempt"),
    false,
    "recovery of a completed provider process must not consume a new provider attempt",
  );
  assert.equal(secondStore.state.calls.find(([name]) => name === "completeCommand")[1].fencingToken, 42);
});
