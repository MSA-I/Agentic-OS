import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const sourceRoot = process.cwd();
const scratchRoot = path.resolve(sourceRoot, ".tmp", "wave2-durable-store-tests");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export default undefined" };
    }
    let candidate = null;
    if (specifier.startsWith("@/")) {
      candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
    } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      candidate = new URL(specifier, context.parentURL);
      candidate = decodeURIComponent(candidate.pathname).replace(/^\/(?=[A-Za-z]:\/)/u, "");
    }
    if (candidate) {
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const {
  WorkbenchAdmissionError,
  WorkbenchEventGapError,
  WorkbenchEventQuotaError,
  WorkbenchIdempotencyConflictError,
  WorkbenchSessionBindingError,
  WorkbenchStore,
  verifyWorkbenchBackup,
  verifyWorkbenchRestore,
} = await import("./store.ts");
const {
  applyWorkbenchMigrations,
  WORKBENCH_MIGRATIONS,
  WorkbenchMigrationError,
} = await import("./migrations.ts");
const { IllegalRunTransitionError, isLegalRunTransition } = await import("./stateMachine.ts");

function databasePath(label) {
  mkdirSync(scratchRoot, { recursive: true });
  return path.join(scratchRoot, `${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite3`);
}

function cleanupDatabase(filePath) {
  rmSync(filePath, { force: true });
  rmSync(`${filePath}-shm`, { force: true });
  rmSync(`${filePath}-wal`, { force: true });
}

function context(overrides = {}) {
  return {
    agentId: "codex",
    actorId: "codex",
    projectId: "wave2-scratch",
    sessionId: null,
    environment: "local",
    panel: "transcript",
    ...overrides,
  };
}

function createInput(overrides = {}) {
  return {
    adapterId: "codex",
    provider: "codex",
    context: context(),
    title: "Durable run",
    operation: "start",
    idempotencyKey: "request-001",
    payload: { promptHash: "sha256:one", mode: "safe" },
    command: { type: "run.admit", payload: { priority: 1 } },
    ...overrides,
  };
}

test("forward-only migrations configure WAL, busy timeout, foreign keys, and checksummed ledger", () => {
  const filePath = databasePath("migrations");
  const store = new WorkbenchStore(filePath);
  try {
    const configuration = store.storageConfiguration();
    assert.equal(configuration.journalMode, "wal");
    assert.equal(configuration.foreignKeys, true);
    assert.equal(configuration.busyTimeoutMs, 5_000);
    assert.equal(configuration.synchronous, 2);
    assert.equal(configuration.schemaVersion, WORKBENCH_MIGRATIONS.length);
    const ledger = store.migrationLedger();
    assert.deepEqual(ledger.map(({ version }) => version), WORKBENCH_MIGRATIONS.map(({ version }) => version));
    assert.ok(ledger.every(({ checksumSha256 }) => /^[a-f0-9]{64}$/u.test(checksumSha256)));
    assert.equal(ledger.at(-1).version, 10);
    assert.equal(ledger.at(-1).name, "durable_provider_launch_authorization_receipts");
  } finally {
    store.close();
    cleanupDatabase(filePath);
  }
});

test("forward-only v8 upgrade and fresh schema keep the SQLite transition guard in parity with the canonical state machine", () => {
  const upgradePath = databasePath("transition-v8-upgrade");
  const freshPath = databasePath("transition-v8-fresh");
  const upgrade = new DatabaseSync(upgradePath);
  const fresh = new DatabaseSync(freshPath);
  const statuses = [
    "requested",
    "queued",
    "claimed",
    "starting",
    "running",
    "awaiting_approval",
    "stopping",
    "succeeded",
    "failed",
    "cancelled",
    "orphaned",
    "blocked",
  ];
  const insert = (db, id, status) => db.prepare(`
    INSERT INTO workbench_runs (
      id, adapter_id, provider, agent_id, environment, panel, status,
      created_at, updated_at, metadata_json
    ) VALUES (?, 'codex', 'codex', 'codex', 'local', 'transcript', ?, ?, ?, '{}')
  `).run(id, status, "2036-01-01T00:00:00.000Z", "2036-01-01T00:00:00.000Z");
  try {
    applyWorkbenchMigrations(upgrade, WORKBENCH_MIGRATIONS.slice(0, 7));
    insert(upgrade, "pre-v8-stopping", "stopping");
    assert.throws(
      () => upgrade.prepare("UPDATE workbench_runs SET status = 'succeeded' WHERE id = ?").run("pre-v8-stopping"),
      /illegal_run_transition/u,
    );
    applyWorkbenchMigrations(upgrade, WORKBENCH_MIGRATIONS.slice(0, 8));
    upgrade.prepare("UPDATE workbench_runs SET status = 'succeeded' WHERE id = ?").run("pre-v8-stopping");
    assert.equal(upgrade.prepare("SELECT status FROM workbench_runs WHERE id = ?").get("pre-v8-stopping").status, "succeeded");
    assert.equal(upgrade.prepare("PRAGMA user_version").get().user_version, 8);

    applyWorkbenchMigrations(fresh, WORKBENCH_MIGRATIONS.slice(0, 8));
    fresh.exec("BEGIN IMMEDIATE");
    for (const from of statuses) {
      for (const to of statuses) {
        const id = `parity-${from}-${to}`;
        insert(fresh, id, from);
        let allowed = true;
        try {
          fresh.prepare("UPDATE workbench_runs SET status = ? WHERE id = ?").run(to, id);
        } catch (error) {
          allowed = false;
          assert.match(String(error), /illegal_run_transition/u);
        }
        assert.equal(allowed, isLegalRunTransition(from, to), `${from} -> ${to}`);
      }
    }
    fresh.exec("COMMIT");
  } finally {
    try { fresh.exec("ROLLBACK"); } catch { /* no active parity transaction */ }
    upgrade.close();
    fresh.close();
    cleanupDatabase(upgradePath);
    cleanupDatabase(freshPath);
  }
});

test("native session discovery binds once without changing durable run fencing", () => {
  const filePath = databasePath("native-session-binding");
  const store = new WorkbenchStore(filePath);
  const sessionId = "11111111-1111-5111-8111-111111111111";
  try {
    const created = store.createRunCommand(createInput());
    const before = store.getRun(created.run.id);
    const bound = store.bindNativeSessionId(created.run.id, sessionId);
    assert.equal(bound.context.sessionId, sessionId);
    assert.equal(bound.stateVersion, before.stateVersion);
    assert.equal(bound.runGeneration, before.runGeneration);
    assert.equal(store.bindNativeSessionId(created.run.id, sessionId).context.sessionId, sessionId);
    assert.throws(
      () => store.bindNativeSessionId(created.run.id, "22222222-2222-5222-8222-222222222222"),
      WorkbenchSessionBindingError,
    );
  } finally {
    store.close();
    cleanupDatabase(filePath);
  }
});

test("native session discovery cannot cross actor or project identity", () => {
  const filePath = databasePath("native-session-owner");
  const store = new WorkbenchStore(filePath);
  const sessionId = "33333333-3333-5333-8333-333333333333";
  try {
    const first = store.createRunCommand(createInput());
    store.bindNativeSessionId(first.run.id, sessionId);
    const second = store.createRunCommand(createInput({
      context: context({ projectId: "different-project" }),
      idempotencyKey: "request-002",
      payload: { promptHash: "sha256:two", mode: "safe" },
    }));
    assert.throws(
      () => store.bindNativeSessionId(second.run.id, sessionId),
      WorkbenchSessionBindingError,
    );
  } finally {
    store.close();
    cleanupDatabase(filePath);
  }
});

test("migration failure rolls back schema and ledger atomically", () => {
  const filePath = databasePath("migration-failure");
  const db = new DatabaseSync(filePath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    applyWorkbenchMigrations(db);
    const broken = [
      ...WORKBENCH_MIGRATIONS,
      {
        version: WORKBENCH_MIGRATIONS.length + 1,
        name: "injected_failure",
        sql: "CREATE TABLE migration_partial (id TEXT); INSERT INTO missing_table VALUES (1);",
      },
    ];
    assert.throws(() => applyWorkbenchMigrations(db, broken), WorkbenchMigrationError);
    const partial = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_partial'
    `).get();
    assert.equal(partial, undefined);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM workbench_schema_migrations").get().count,
      WORKBENCH_MIGRATIONS.length,
    );
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, WORKBENCH_MIGRATIONS.length);
  } finally {
    db.close();
    cleanupDatabase(filePath);
  }
});

test("run creation is idempotent and rejects same scoped key with changed payload", () => {
  const filePath = databasePath("idempotency");
  const store = new WorkbenchStore(filePath);
  try {
    const created = store.createRunCommand(createInput());
    const replay = store.createRunCommand(createInput());
    assert.equal(created.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.run.id, created.run.id);
    assert.equal(replay.event.id, created.event.id);
    assert.equal(replay.command.id, created.command.id);
    assert.equal(store.listRuns().length, 1);
    assert.equal(store.eventBounds(created.run.id).retainedCount, 1);
    assert.equal(store.outboxForRun(created.run.id).length, 1);

    assert.throws(
      () => store.createRunCommand(createInput({ payload: { promptHash: "sha256:changed", mode: "safe" } })),
      WorkbenchIdempotencyConflictError,
    );
    assert.equal(store.listRuns().length, 1);
  } finally {
    store.close();
    cleanupDatabase(filePath);
  }
});

test("creation receipt survives event compaction and preserves exact idempotent replay", () => {
  const filePath = databasePath("create-receipt-compaction");
  const store = new WorkbenchStore(filePath);
  try {
    const input = createInput({ idempotencyKey: "receipt-after-compaction" });
    const created = store.createRunCommand(input);
    store.compactEvents(created.run.id, created.event.sequence, {
      status: created.run.status,
      through: created.event.sequence,
    });
    assert.equal(store.getOutboxCommand(created.command.id).eventId, null);
    const replay = store.createRunCommand(input);
    assert.equal(replay.created, false);
    assert.equal(replay.run.id, created.run.id);
    assert.equal(replay.command.id, created.command.id);
    assert.deepEqual(replay.event, created.event);
  } finally {
    store.close();
    cleanupDatabase(filePath);
  }
});

test("cancel increments run generation and atomically invalidates older side-effect commands", () => {
  const filePath = databasePath("cancel-generation");
  const store = new WorkbenchStore(filePath);
  const inspector = new DatabaseSync(filePath);
  try {
    const created = store.createRunCommand(createInput({ idempotencyKey: "cancel-generation" }));
    const [claimed] = store.claimOutbox("generation-worker", 30_000);
    assert.equal(claimed.id, created.command.id);
    assert.equal(claimed.runGeneration, 0);
    const cancelled = store.updateRun(created.run.id, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      pid: null,
    });
    assert.equal(cancelled.status, "cancelled");
    const durable = inspector.prepare(`
      SELECT r.run_generation, o.state, o.reservation_active, o.last_error
      FROM workbench_runs r JOIN workbench_outbox o ON o.run_id = r.id
      WHERE r.id = ?
    `).get(created.run.id);
    assert.equal(durable.run_generation, 1);
    assert.equal(durable.state, "dead");
    assert.equal(durable.reservation_active, 0);
    assert.equal(durable.last_error, "run_generation_invalidated");
    assert.equal(store.heartbeatOutbox(claimed.id, "generation-worker", claimed.fencingToken, 30_000), false);
    assert.deepEqual(store.claimOutbox("new-worker", 30_000), []);
  } finally {
    inspector.close();
    store.close();
    cleanupDatabase(filePath);
  }
});

test("queue admission is atomic and rejects run 101 without durable side effects", () => {
  const filePath = databasePath("queue-admission");
  const store = new WorkbenchStore(filePath);
  try {
    for (let index = 0; index < 100; index += 1) {
      store.createRunCommand(createInput({
        idempotencyKey: `queue-${index}`,
        payload: { promptHash: `sha256:${index}`, mode: "safe" },
      }));
    }
    const beforeRuns = store.listRuns({ limit: 200 }).length;
    const beforeEvents = store.listRuns({ limit: 200 })
      .reduce((sum, run) => sum + store.eventBounds(run.id).retainedCount, 0);
    assert.equal(beforeRuns, 100);
    assert.throws(
      () => store.createRunCommand(createInput({
        idempotencyKey: "queue-101",
        payload: { promptHash: "sha256:101", mode: "safe" },
      })),
      (error) => error instanceof WorkbenchAdmissionError && error.code === "queue_full",
    );
    assert.equal(store.listRuns({ limit: 200 }).length, beforeRuns);
    assert.equal(
      store.listRuns({ limit: 200 }).reduce((sum, run) => sum + store.eventBounds(run.id).retainedCount, 0),
      beforeEvents,
    );
  } finally {
    store.close();
    cleanupDatabase(filePath);
  }
});

test("legal transition, outbox command, and monotonic event append commit in one transaction", () => {
  const filePath = databasePath("transition");
  const store = new WorkbenchStore(filePath);
  try {
    const created = store.createRunCommand(createInput());
    const transitioned = store.transitionRunWithCommand({
      runId: created.run.id,
      expectedFrom: "queued",
      to: "claimed",
      command: {
        type: "provider.claim",
        idempotencyKey: "claim-001",
        payload: { workerPool: "default" },
      },
      event: { payload: { owner: "worker-1" } },
    });
    assert.equal(transitioned.replayed, false);
    assert.equal(transitioned.run.status, "claimed");
    assert.ok(transitioned.event.sequence > created.event.sequence);
    assert.equal(transitioned.command.eventId, transitioned.event.id);
    assert.equal(transitioned.command.targetStatus, "claimed");

    const replay = store.transitionRunWithCommand({
      runId: created.run.id,
      expectedFrom: "queued",
      to: "claimed",
      command: {
        type: "provider.claim",
        idempotencyKey: "claim-001",
        payload: { workerPool: "default" },
      },
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.id, transitioned.event.id);
    assert.equal(store.eventBounds(created.run.id).retainedCount, 2);
    assert.equal(store.outboxForRun(created.run.id).length, 2);

    assert.throws(() => store.transitionRunWithCommand({
      runId: created.run.id,
      to: "claimed",
      command: {
        type: "provider.claim",
        idempotencyKey: "claim-001",
        payload: { workerPool: "changed" },
      },
    }), WorkbenchIdempotencyConflictError);
    assert.throws(() => store.transitionRunWithCommand({
      runId: created.run.id,
      to: "succeeded",
      command: { type: "provider.complete", idempotencyKey: "complete-illegal" },
    }), IllegalRunTransitionError);
  } finally {
    store.close();
    cleanupDatabase(filePath);
  }
});

test("forward-only transition guard accepts blocked as terminal from a running provider", () => {
  const filePath = databasePath("running-blocked-transition");
  const store = new WorkbenchStore(filePath);
  try {
    const created = store.createRunCommand(createInput({ idempotencyKey: "running-blocked-001" }));
    store.updateRun(created.run.id, { status: "starting" });
    store.updateRun(created.run.id, { status: "running", pid: 72_777 });
    const blocked = store.updateRun(created.run.id, {
      status: "blocked",
      pid: null,
      finishedAt: new Date().toISOString(),
      error: { code: "windows_job_blocked", message: "Verified helper terminal outcome." },
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.pid, null);
    assert.ok(blocked.finishedAt);
    assert.throws(
      () => store.updateRun(created.run.id, { status: "running" }),
      IllegalRunTransitionError,
    );
  } finally {
    store.close();
    cleanupDatabase(filePath);
  }
});

test("storage write failure injection rolls back transition, event, and outbox together", () => {
  const filePath = databasePath("write-failure");
  const store = new WorkbenchStore(filePath);
  const faultConnection = new DatabaseSync(filePath);
  try {
    const created = store.createRunCommand(createInput());
    const beforeEvents = store.eventBounds(created.run.id).retainedCount;
    const beforeCommands = store.outboxForRun(created.run.id).length;
    faultConnection.exec(`
      CREATE TRIGGER injected_outbox_write_failure
      BEFORE INSERT ON workbench_outbox
      BEGIN
        SELECT RAISE(ABORT, 'database or disk is full');
      END;
    `);
    assert.throws(() => store.transitionRunWithCommand({
      runId: created.run.id,
      expectedFrom: "queued",
      to: "claimed",
      command: { type: "provider.claim", idempotencyKey: "write-failure-claim" },
    }), /database or disk is full/u);
    assert.equal(store.getRun(created.run.id).status, "queued");
    assert.equal(store.eventBounds(created.run.id).retainedCount, beforeEvents);
    assert.equal(store.outboxForRun(created.run.id).length, beforeCommands);
  } finally {
    faultConnection.close();
    store.close();
    cleanupDatabase(filePath);
  }
});

test("outbox lease and fencing reject stale or mismatched workers", () => {
  const filePath = databasePath("fencing");
  const store = new WorkbenchStore(filePath);
  try {
    const created = store.createRunCommand(createInput());
    const [claimed] = store.claimOutbox("worker-1", 10_000);
    assert.equal(claimed.id, created.command.id);
    assert.equal(claimed.fencingToken, 1);
    assert.equal(claimed.attemptCount, 1);
    assert.equal(store.completeOutbox(claimed.id, "worker-2", claimed.fencingToken), false);
    assert.equal(store.completeOutbox(claimed.id, "worker-1", claimed.fencingToken + 1), false);
    assert.equal(store.heartbeatOutbox(claimed.id, "worker-1", claimed.fencingToken, 10_000), true);
    assert.equal(store.completeOutbox(claimed.id, "worker-1", claimed.fencingToken), true);
    assert.equal(store.getOutboxCommand(claimed.id).state, "completed");
  } finally {
    store.close();
    cleanupDatabase(filePath);
  }
});

test("event paging reports retained bounds, pagination, and compaction gap recovery", () => {
  const filePath = databasePath("events");
  const store = new WorkbenchStore(filePath);
  try {
    const created = store.createRunCommand(createInput());
    const second = store.appendEvent(created.run.id, "message", { index: 2 });
    const third = store.appendEvent(created.run.id, "message", { index: 3 });
    const fourth = store.appendEvent(created.run.id, "message", { index: 4 });
    const firstPage = store.eventPage(created.run.id, 0, 2);
    assert.equal(firstPage.events.length, 2);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.gap, null);
    assert.equal(firstPage.nextCursor, second.sequence);

    const compacted = store.compactEvents(created.run.id, third.sequence, {
      status: "queued",
      lastDeliveredSequence: third.sequence,
    });
    assert.equal(compacted.compactedThroughSequence, third.sequence);
    assert.equal(compacted.firstSequence, fourth.sequence);
    assert.equal(compacted.retainedCount, 1);

    const recovery = store.eventPage(created.run.id, 0, 10);
    assert.equal(recovery.gap.compactedThroughSequence, third.sequence);
    assert.equal(recovery.gap.snapshot.lastDeliveredSequence, third.sequence);
    assert.deepEqual(recovery.events.map(({ sequence }) => sequence), [fourth.sequence]);
    assert.throws(() => store.eventsAfter(created.run.id, 0), WorkbenchEventGapError);
  } finally {
    store.close();
    cleanupDatabase(filePath);
  }
});

test("event quotas reject oversized payloads and roll back automatic compaction when store capacity remains insufficient", () => {
  const filePath = databasePath("event-quota-reject");
  const store = new WorkbenchStore(filePath, {
    eventQuotaPolicy: {
      maxPayloadBytesPerEvent: 512,
      maxRetainedEventsPerRun: 4,
      maxStoreBytes: 120,
    },
  });
  try {
    const created = store.createRunCommand(createInput({ idempotencyKey: "event-quota-reject" }));
    const before = store.eventBounds(created.run.id);
    assert.throws(
      () => store.appendEvent(created.run.id, "message", { content: "x".repeat(200) }),
      (error) => error instanceof WorkbenchEventQuotaError && error.code === "event_store_full",
    );
    const afterStoreFailure = store.eventBounds(created.run.id);
    assert.equal(afterStoreFailure.retainedCount, before.retainedCount);
    assert.equal(afterStoreFailure.compactedThroughSequence, before.compactedThroughSequence);
    assert.throws(
      () => store.appendEvent(created.run.id, "message", { content: "x".repeat(600) }),
      (error) => error instanceof WorkbenchEventQuotaError && error.code === "event_too_large",
    );
    assert.equal(store.eventBounds(created.run.id).retainedCount, before.retainedCount);
  } finally {
    store.close();
    cleanupDatabase(filePath);
  }
});

test("event count and retained-store quotas compact automatically with snapshot gap recovery", () => {
  const filePath = databasePath("event-quota-compaction");
  const store = new WorkbenchStore(filePath, {
    eventQuotaPolicy: {
      maxPayloadBytesPerEvent: 512,
      maxRetainedEventsPerRun: 3,
      maxStoreBytes: 220,
    },
  });
  try {
    const created = store.createRunCommand(createInput({ idempotencyKey: "event-quota-compaction" }));
    for (let index = 0; index < 6; index += 1) {
      store.appendEvent(created.run.id, "message", { index, content: "y".repeat(45) });
    }
    const bounds = store.eventBounds(created.run.id);
    assert.ok(bounds.retainedCount <= 3);
    assert.ok(bounds.compactedThroughSequence > 0);
    assert.equal(bounds.snapshot.reason, "automatic_event_quota_compaction");
    assert.equal(bounds.snapshot.runId, created.run.id);
    const recovery = store.eventPage(created.run.id, 0, 100);
    assert.ok(recovery.gap);
    assert.equal(recovery.gap.snapshot.reason, "automatic_event_quota_compaction");
    assert.ok(recovery.events.every((event) => event.sequence > bounds.compactedThroughSequence));
  } finally {
    store.close();
    cleanupDatabase(filePath);
  }
});

test("backup records SHA-256 and verified restore opens with matching ledger and counts", async () => {
  const filePath = databasePath("backup-source");
  const backupPath = databasePath("backup-copy");
  const restorePath = databasePath("backup-restore");
  const store = new WorkbenchStore(filePath);
  try {
    const created = store.createRunCommand(createInput());
    store.appendEvent(created.run.id, "message", { content: "safe" });
    const manifest = await store.createBackup(backupPath);
    assert.match(manifest.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(manifest.runCount, 1);
    assert.equal(manifest.eventCount, 2);
    const verified = verifyWorkbenchBackup(backupPath, manifest.sha256);
    assert.equal(verified.integrity, "ok");
    assert.equal(verified.schemaVersion, WORKBENCH_MIGRATIONS.length);
    const restored = verifyWorkbenchRestore(backupPath, restorePath, manifest.sha256);
    assert.equal(restored.integrity, "ok");
    assert.equal(restored.runCount, manifest.runCount);
    assert.equal(restored.eventCount, manifest.eventCount);
  } finally {
    store.close();
    cleanupDatabase(filePath);
    cleanupDatabase(backupPath);
    cleanupDatabase(restorePath);
  }
});
