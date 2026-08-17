import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

const {
  DurableExecutionCleanupDrainer,
  ExecutionCleanupInjectedCrash,
} = await import("./executionCleanupDrainer.ts");
const { WindowsJobContainmentError } = await import("../control-plane/windowsJobProcess.ts");

const EMPTY_DIGEST = "0".repeat(64);
const NONEMPTY_DIGEST = "1".repeat(64);

function cleanupIntent(overrides = {}) {
  const now = new Date(0).toISOString();
  return {
    executionId: "execution-cleanup-1",
    commandId: "command-cleanup-1",
    runId: "run-cleanup-1",
    jobObjectId: "agent-os-execution-cleanup-1",
    runGeneration: 0,
    chainVersion: 2,
    journalGeneration: "A".repeat(22),
    statusSequence: 3,
    previousStatusSequence: 2,
    previousSnapshotDigestSha256: EMPTY_DIGEST,
    previousJournalDigestSha256: EMPTY_DIGEST,
    snapshotDigestSha256: NONEMPTY_DIGEST,
    journalDigestSha256: "2".repeat(64),
    authenticatedPayloadDigestSha256: "3".repeat(64),
    nativeTerminalDigestSha256: "4".repeat(64),
    controllerOutcomeDigestSha256: "5".repeat(64),
    nativeTerminalStatus: "succeeded",
    nativeExitCode: 0,
    terminal: true,
    terminationVerified: true,
    terminalStatus: "succeeded",
    terminalObservedAt: now,
    rootProcessId: 71_001,
    rootProcessStartedAtFileTime: "133700000000071001",
    jobName: "Local\\AgentOS-cleanup-1",
    helperProcessId: 71_000,
    helperProcessStartedAtFileTime: "133700000000071000",
    state: "pending",
    availableAt: now,
    attemptCount: 0,
    claimedAt: null,
    claimedBy: null,
    fencingToken: 0,
    leaseExpiresAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorAt: null,
    cleanupResult: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

class FakeCleanupRepository {
  constructor(intent = cleanupIntent()) {
    this.intent = structuredClone(intent);
    this.calls = [];
    this.forceHeartbeatLoss = false;
  }

  async claimNextExecutionCleanup(input) {
    this.calls.push(["claim", structuredClone(input)]);
    const now = Date.parse(input.now);
    const claimable = (this.intent.state === "pending" && Date.parse(this.intent.availableAt) <= now)
      || (this.intent.state === "claimed" && Date.parse(this.intent.leaseExpiresAt) <= now);
    if (!claimable) return null;
    this.intent.state = "claimed";
    this.intent.claimedAt = input.now;
    this.intent.claimedBy = input.workerId;
    this.intent.leaseExpiresAt = new Date(now + input.leaseDurationMs).toISOString();
    this.intent.fencingToken += 1;
    this.intent.attemptCount += 1;
    this.intent.updatedAt = input.now;
    return structuredClone(this.intent);
  }

  owns(input) {
    return this.intent.state === "claimed"
      && this.intent.claimedBy === input.workerId
      && this.intent.fencingToken === input.fencingToken
      && Date.parse(this.intent.leaseExpiresAt) > Date.parse(input.now);
  }

  async heartbeatExecutionCleanup(input) {
    this.calls.push(["heartbeat", structuredClone(input)]);
    if (this.forceHeartbeatLoss || !this.owns(input)) return { status: "stale_fence" };
    this.intent.leaseExpiresAt = input.expiresAt;
    this.intent.updatedAt = input.now;
    return { status: "applied" };
  }

  async completeExecutionCleanup(input) {
    this.calls.push(["complete", structuredClone(input)]);
    if (this.intent.state === "completed") {
      return this.intent.cleanupResult === input.result
        ? { status: "already_applied" }
        : { status: "stale_fence" };
    }
    if (!this.owns(input)) return { status: "stale_fence" };
    Object.assign(this.intent, {
      state: "completed",
      claimedAt: null,
      claimedBy: null,
      leaseExpiresAt: null,
      cleanupResult: input.result,
      completedAt: input.completedAt,
      updatedAt: input.completedAt,
    });
    return { status: "applied" };
  }

  async retryExecutionCleanup(input) {
    this.calls.push(["retry", structuredClone(input)]);
    if (!this.owns(input)) return { status: "stale_fence" };
    Object.assign(this.intent, {
      state: "pending",
      availableAt: input.availableAt,
      claimedAt: null,
      claimedBy: null,
      leaseExpiresAt: null,
      lastErrorCode: input.error.code,
      lastErrorMessage: input.error.message,
      lastErrorAt: input.now,
      updatedAt: input.now,
    });
    return { status: "applied" };
  }

  async quarantineExecutionCleanup(input) {
    this.calls.push(["quarantine", structuredClone(input)]);
    if (!this.owns(input)) return { status: "stale_fence" };
    Object.assign(this.intent, {
      state: "quarantined",
      claimedAt: null,
      claimedBy: null,
      leaseExpiresAt: null,
      lastErrorCode: input.error.code,
      lastErrorMessage: input.error.message,
      lastErrorAt: input.quarantinedAt,
      updatedAt: input.quarantinedAt,
    });
    return { status: "applied" };
  }

  async listExecutionCleanupIntents() {
    return [structuredClone(this.intent)];
  }

  async findCompletedExecutionCleanupIntents(executionIds) {
    this.calls.push(["find_completed", [...executionIds]]);
    return this.intent.state === "completed" && executionIds.includes(this.intent.executionId)
      ? [structuredClone(this.intent)]
      : [];
  }
}

function drainer(repository, overrides = {}) {
  return new DurableExecutionCleanupDrainer(repository, {
    workerId: overrides.workerId ?? "cleanup-worker-a",
    recoveryRoot: "C:\\agent-os-cleanup-test",
    recoverySecret: "cleanup-test-recovery-secret-at-least-32-bytes",
    recoverySecrets: overrides.recoverySecrets,
    leaseDurationMs: overrides.leaseDurationMs ?? 60,
    maxAttempts: overrides.maxAttempts ?? 8,
    baseRetryMs: overrides.baseRetryMs ?? 1_000,
    maxRetryMs: overrides.maxRetryMs ?? 60_000,
    now: overrides.now,
    random: overrides.random ?? (() => 0.5),
    cleanup: overrides.cleanup ?? (async () => ({ result: "removed", controlDirectory: "C:\\case" })),
    crashInjector: overrides.crashInjector,
    onCleanupCommitted: overrides.onCleanupCommitted,
    cleanupObservationTargets: overrides.cleanupObservationTargets,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((currentResolve) => { resolve = currentResolve; });
  return { promise, resolve };
}

test("cleanup heartbeat renews a long operation and local release follows durable ACK", async () => {
  const repository = new FakeCleanupRepository();
  const gate = deferred();
  const callbackStates = [];
  let logicalNow = 0;
  const worker = drainer(repository, {
    now: () => {
      logicalNow += 5;
      return logicalNow;
    },
    cleanup: async () => {
      await gate.promise;
      return { result: "removed", controlDirectory: "C:\\case" };
    },
    onCleanupCommitted: () => {
      callbackStates.push(repository.intent.state);
      return true;
    },
  });
  const completion = worker.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 45));
  gate.resolve();
  assert.deepEqual(await completion, {
    status: "completed",
    executionId: repository.intent.executionId,
    result: "removed",
  });
  const heartbeats = repository.calls
    .filter(([name]) => name === "heartbeat")
    .map(([, input]) => input);
  assert.ok(heartbeats.length >= 2);
  for (let index = 1; index < heartbeats.length; index += 1) {
    assert.ok(Date.parse(heartbeats[index].expiresAt) > Date.parse(heartbeats[index - 1].expiresAt));
  }
  assert.deepEqual(callbackStates, ["completed"]);
});

test("cleanup retries one retained legacy recovery key before committing the durable ACK", async () => {
  const repository = new FakeCleanupRepository();
  const primarySecret = "cleanup-test-recovery-secret-at-least-32-bytes";
  const legacySecret = "cleanup-test-retained-legacy-secret-at-least-32-bytes";
  const attemptedSecrets = [];
  const result = await drainer(repository, {
    recoverySecrets: [legacySecret],
    cleanup: async (options) => {
      attemptedSecrets.push(options.recoverySecret);
      if (options.recoverySecret === primarySecret) {
        throw new WindowsJobContainmentError(
          "windows_job_invalid_specification",
          "descriptor belongs to a retained legacy key",
        );
      }
      assert.equal(options.recoverySecret, legacySecret);
      return { result: "removed", controlDirectory: "C:\\case" };
    },
  }).drainOnce();
  assert.deepEqual(attemptedSecrets, [primarySecret, legacySecret]);
  assert.deepEqual(result, {
    status: "completed",
    executionId: repository.intent.executionId,
    result: "removed",
  });
  assert.equal(repository.intent.state, "completed");
});

test("lost cleanup lease prevents ACK, retry, quarantine, and callback", async () => {
  const repository = new FakeCleanupRepository();
  const gate = deferred();
  let callbacks = 0;
  const worker = drainer(repository, {
    cleanup: async () => {
      await gate.promise;
      return { result: "removed", controlDirectory: "C:\\case" };
    },
    onCleanupCommitted: () => { callbacks += 1; },
  });
  const completion = worker.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  repository.forceHeartbeatLoss = true;
  await new Promise((resolve) => setTimeout(resolve, 25));
  gate.resolve();
  assert.equal((await completion).status, "lease_lost");
  assert.equal(callbacks, 0);
  assert.equal(repository.calls.some(([name]) => ["complete", "retry", "quarantine"].includes(name)), false);
});

test("cleanup failure after lease loss suppresses retry and quarantine mutations", async () => {
  const repository = new FakeCleanupRepository();
  const gate = deferred();
  const cleanupFailure = Object.assign(new Error("cleanup directory is busy"), { code: "EBUSY" });
  const worker = drainer(repository, {
    cleanup: async () => {
      await gate.promise;
      throw cleanupFailure;
    },
  });
  const completion = worker.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  repository.forceHeartbeatLoss = true;
  await new Promise((resolve) => setTimeout(resolve, 25));
  gate.resolve();
  assert.deepEqual(await completion, {
    status: "lease_lost",
    executionId: repository.intent.executionId,
  });
  assert.equal(repository.intent.state, "claimed");
  assert.equal(repository.calls.some(([name]) => ["retry", "quarantine"].includes(name)), false);
});

for (const boundary of ["after_claim", "after_filesystem_cleanup"]) {
  test(`cleanup crash at ${boundary} is reclaimed without duplicate durable ACK`, async () => {
    let now = 0;
    const repository = new FakeCleanupRepository();
    let cleanupCalls = 0;
    const crashing = drainer(repository, {
      leaseDurationMs: 60,
      now: () => now,
      cleanup: async () => ({
        result: cleanupCalls++ === 0 ? "removed" : "already_absent",
        controlDirectory: "C:\\case",
      }),
      crashInjector(current) {
        if (current === boundary) throw new ExecutionCleanupInjectedCrash(current);
      },
    });
    await assert.rejects(crashing.drainOnce(), ExecutionCleanupInjectedCrash);
    assert.equal(repository.intent.state, "claimed");
    now = 61;
    const recovered = drainer(repository, {
      workerId: "cleanup-worker-b",
      leaseDurationMs: 60,
      now: () => now,
      cleanup: async () => ({ result: "already_absent", controlDirectory: "C:\\case" }),
    });
    assert.equal((await recovered.drainOnce()).status, "completed");
    assert.equal(repository.intent.state, "completed");
    assert.equal(repository.calls.filter(([name]) => name === "complete").length, 1);
  });
}

test("crash after cleanup ACK is observed by another runtime without filesystem replay", async () => {
  const repository = new FakeCleanupRepository();
  let firstCallbacks = 0;
  const crashing = drainer(repository, {
    onCleanupCommitted: () => { firstCallbacks += 1; return true; },
    crashInjector(boundary) {
      if (boundary === "after_ledger_ack") throw new ExecutionCleanupInjectedCrash(boundary);
    },
  });
  await assert.rejects(crashing.drainOnce(), ExecutionCleanupInjectedCrash);
  assert.equal(repository.intent.state, "completed");
  assert.equal(firstCallbacks, 1);

  let observedBySecondRuntime = 0;
  let cleanupCalls = 0;
  const observer = drainer(repository, {
    workerId: "cleanup-worker-b",
    cleanup: async () => {
      cleanupCalls += 1;
      return { result: "already_absent", controlDirectory: "C:\\case" };
    },
    onCleanupCommitted: () => { observedBySecondRuntime += 1; return true; },
    cleanupObservationTargets: () => [repository.intent.executionId],
  });
  const results = await observer.drainBounded(1);
  assert.deepEqual(results, [{ status: "idle" }]);
  assert.equal(observedBySecondRuntime, 1);
  assert.equal(cleanupCalls, 0);
});

test("completed cleanup observation chunks more than 100 exact execution targets", async () => {
  const completedIntent = cleanupIntent({
    executionId: "execution-target-150",
    state: "completed",
    cleanupResult: "removed",
    completedAt: new Date(0).toISOString(),
  });
  const repository = new FakeCleanupRepository(completedIntent);
  const targets = Array.from({ length: 205 }, (_, index) => `execution-target-${index}`);
  const observed = [];
  const worker = drainer(repository, {
    cleanupObservationTargets: () => targets,
    onCleanupCommitted: (intent) => { observed.push(intent.executionId); },
  });
  assert.deepEqual(await worker.drainBounded(1), [{ status: "idle" }]);
  const batches = repository.calls
    .filter(([name]) => name === "find_completed")
    .map(([, executionIds]) => executionIds);
  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 5]);
  assert.deepEqual(observed, [completedIntent.executionId]);
});

test("EPERM schedules deterministic backoff and integrity tamper quarantines", async () => {
  const now = Date.parse("2026-08-14T00:00:00.000Z");
  const retryRepository = new FakeCleanupRepository(cleanupIntent({ availableAt: new Date(now).toISOString() }));
  const retryError = Object.assign(new Error("directory busy"), { code: "EPERM" });
  const retry = await drainer(retryRepository, {
    leaseDurationMs: 60_000,
    now: () => now,
    cleanup: async () => { throw retryError; },
  }).drainOnce();
  assert.equal(retry.status, "retry_scheduled");
  assert.equal(retry.code, "EPERM");
  assert.equal(Date.parse(retry.availableAt), now + 1_000);
  assert.equal(retryRepository.intent.state, "pending");

  const quarantineRepository = new FakeCleanupRepository(cleanupIntent({
    executionId: "execution-tamper",
    availableAt: new Date(now).toISOString(),
  }));
  const quarantined = await drainer(quarantineRepository, {
    leaseDurationMs: 60_000,
    now: () => now,
    cleanup: async () => {
      throw new WindowsJobContainmentError("windows_job_protocol_invalid", "tampered status");
    },
  }).drainOnce();
  assert.deepEqual(quarantined, {
    status: "quarantined",
    executionId: "execution-tamper",
    code: "windows_job_protocol_invalid",
  });
  assert.equal(quarantineRepository.intent.state, "quarantined");
});

test("attempt cap quarantines retryable cleanup and stale fencing cannot commit", async () => {
  const now = Date.parse("2026-08-14T00:00:00.000Z");
  const cappedRepository = new FakeCleanupRepository(cleanupIntent({
    executionId: "execution-cap",
    availableAt: new Date(now).toISOString(),
    attemptCount: 7,
  }));
  const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
  const capped = await drainer(cappedRepository, {
    leaseDurationMs: 60_000,
    now: () => now,
    maxAttempts: 8,
    cleanup: async () => { throw busy; },
  }).drainOnce();
  assert.deepEqual(capped, {
    status: "quarantined",
    executionId: "execution-cap",
    code: "execution_cleanup_attempt_cap",
  });

  const staleRepository = new FakeCleanupRepository(cleanupIntent({
    executionId: "execution-stale",
    availableAt: new Date(now).toISOString(),
  }));
  const staleWorker = drainer(staleRepository, {
    leaseDurationMs: 60_000,
    now: () => now,
    cleanup: async () => {
      staleRepository.forceHeartbeatLoss = true;
      return { result: "removed", controlDirectory: "C:\\case" };
    },
  });
  assert.equal((await staleWorker.drainOnce()).status, "lease_lost");
  assert.equal(staleRepository.intent.state, "claimed");
  assert.equal(staleRepository.calls.some(([name]) => name === "complete"), false);
});
