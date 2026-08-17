import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const { isLegalRunTransition } = await import("./stateMachine.ts");
const { WorkbenchStore } = await import("./store.ts");
const { WORKBENCH_MIGRATIONS } = await import("./migrations.ts");

function scratch() {
  const base = path.join(process.cwd(), ".next", "wave2-concurrency-tests");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, "case-"));
}

function processState(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return error?.code === "ESRCH" ? "exited" : `unknown:${error?.code ?? "error"}`;
  }
}

async function removeScratch(root, childProcessIds = []) {
  const deadline = Date.now() + 3_000;
  let lastError;
  for (;;) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code ?? "")) throw error;
      lastError = error;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const leftovers = existsSync(root)
    ? readdirSync(root, { recursive: true }).map(String).slice(0, 50)
    : [];
  const childStates = childProcessIds.map((pid) => ({ pid, state: processState(pid) }));
  throw new Error(
    `Timed out removing concurrency scratch directory: ${JSON.stringify({ root, leftovers, childStates })}`,
    { cause: lastError },
  );
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function launchWalLocker(fixture, databasePath, readyPath, holdMilliseconds) {
  const child = spawn(process.execPath, [fixture, databasePath, readyPath, String(holdMilliseconds)], {
    cwd: sourceRoot,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(new Error(`WAL lock fixture exited code=${code} signal=${signal}: ${stderr || stdout}`));
      } else {
        resolve();
      }
    });
  });
  return { childProcessId: child.pid, completion };
}

function createRun(store) {
  return store.createRunCommand({
    adapterId: "codex",
    provider: "codex",
    context: {
      agentId: "codex",
      actorId: "codex",
      projectId: "wave2-concurrency",
      sessionId: null,
      environment: "local",
      panel: "transcript",
    },
    operation: "start",
    idempotencyKey: `seed-${process.pid}-${Date.now()}`,
    payload: { prompt: "safe" },
    command: {
      type: "provider.queue",
      payload: {
        operation: "start",
        resources: {
          cpuTimeMs: 60_000,
          residentMemoryBytes: 256 * 1024 * 1024,
          diskBytes: 16 * 1024 * 1024,
          processCount: 2,
          outputBytes: 64 * 1024,
        },
      },
    },
  });
}

function launch(fixture, databasePath, runId, operation, barrierPath) {
  const child = spawn(process.execPath, [fixture, databasePath, runId, operation, barrierPath], {
    cwd: sourceRoot,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    // On Windows the `exit` event can fire before the child stdio streams and
    // inherited SQLite file handles are fully closed. Waiting for `close`
    // keeps scratch cleanup deterministic, especially from a Unicode cwd.
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`${operation} fixture exited ${code}: ${stderr}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new Error(`${operation} fixture emitted invalid JSON: ${stdout}`, { cause: error }));
        }
      }
    });
  });
  return { childProcessId: child.pid, completion };
}

function launchFirstOpen(fixture, databasePath, barrierPath) {
  const child = spawn(process.execPath, [fixture, databasePath, barrierPath], {
    cwd: sourceRoot,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`first-open fixture exited ${code}: ${stderr}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new Error(`first-open fixture emitted invalid JSON: ${stdout}`, { cause: error }));
        }
      }
    });
  });
  return { childProcessId: child.pid, completion };
}

test("two first-open processes reconcile one new database under a single migration lock", { timeout: 30_000 }, async () => {
  const root = scratch();
  const databasePath = path.join(root, "first-open.sqlite3");
  const barrierPath = path.join(root, "first-open.barrier");
  const fixture = path.join(sourceRoot, "src", "lib", "workbench", "store.firstOpen.fixture.mjs");
  let childProcessIds = [];
  let primaryFailure;
  try {
    const openers = [
      launchFirstOpen(fixture, databasePath, barrierPath),
      launchFirstOpen(fixture, databasePath, barrierPath),
    ];
    childProcessIds = openers
      .map(({ childProcessId }) => childProcessId)
      .filter((pid) => Number.isInteger(pid));
    writeFileSync(barrierPath, "go", "utf8");
    const settled = await Promise.allSettled(openers.map(({ completion }) => completion));
    const failures = settled.filter(({ status }) => status === "rejected");
    if (failures.length === 1) throw failures[0].reason;
    if (failures.length > 1) {
      throw new AggregateError(
        failures.map(({ reason }) => reason),
        "Both first-open fixtures failed after their processes closed.",
      );
    }
    const results = settled.map(({ value }) => value);
    assert.equal(results.length, 2);
    assert.ok(results.every(({ schemaVersion }) => schemaVersion === WORKBENCH_MIGRATIONS.length));
    assert.deepEqual(results[0].ledger, results[1].ledger);
    assert.equal(results[0].ledger.length, WORKBENCH_MIGRATIONS.length);
    assert.ok(results[0].ledger.every(({ checksumSha256 }) => /^[a-f0-9]{64}$/u.test(checksumSha256)));

    const reopened = new WorkbenchStore(databasePath);
    try {
      assert.equal(reopened.migrationLedger().length, WORKBENCH_MIGRATIONS.length);
      assert.equal(reopened.storageConfiguration().schemaVersion, WORKBENCH_MIGRATIONS.length);
    } finally {
      reopened.close();
    }
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await removeScratch(root, childProcessIds);
  } catch (cleanupFailure) {
    if (primaryFailure) {
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        "First-open verification and scratch cleanup both failed.",
      );
    }
    throw cleanupFailure;
  }
  if (primaryFailure) throw primaryFailure;
});

test("WAL negotiation retries bounded SQLITE_BUSY after a DELETE exclusive lock", {
  skip: process.platform !== "win32",
  timeout: 20_000,
}, async () => {
  const root = scratch();
  const databasePath = path.join(root, "wal-retry.sqlite3");
  const readyPath = path.join(root, "wal-lock-ready.json");
  const fixture = path.join(sourceRoot, "src", "lib", "workbench", "store.walLock.fixture.mjs");
  const locker = launchWalLocker(fixture, databasePath, readyPath, 6_000);
  let primaryFailure;
  let lockerFailure;
  try {
    await waitForFile(readyPath);
    const started = Date.now();
    const store = new WorkbenchStore(databasePath);
    try {
      assert.equal(store.storageConfiguration().journalMode, "wal");
      assert.equal(store.migrationLedger().length, WORKBENCH_MIGRATIONS.length);
      assert.ok(Date.now() - started >= 5_000, "exclusive lock did not exercise the busy-timeout path");
    } finally {
      store.close();
    }
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await locker.completion;
  } catch (error) {
    lockerFailure = error;
  }
  try {
    await removeScratch(
      root,
      Number.isInteger(locker.childProcessId) ? [locker.childProcessId] : [],
    );
  } catch (cleanupFailure) {
    const failures = [primaryFailure, lockerFailure, cleanupFailure].filter(Boolean);
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "WAL retry verification and cleanup failed.");
  }
  const failures = [primaryFailure, lockerFailure].filter(Boolean);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "WAL retry verification failed.");
});

test("concurrent start resume cancel serialize without persisting an illegal transition", { timeout: 30_000 }, async () => {
  const root = scratch();
  const databasePath = path.join(root, "workbench.sqlite3");
  const barrierPath = path.join(root, "start.barrier");
  const fixture = path.join(sourceRoot, "src", "lib", "workbench", "store.concurrent.fixture.mjs");
  const seed = new WorkbenchStore(databasePath);
  const created = createRun(seed);
  seed.close();
  const children = [];
  const childProcessIds = [];
  let primaryFailure;
  try {
    for (const operation of ["start", "resume", "cancel"]) {
      const child = launch(fixture, databasePath, created.run.id, operation, barrierPath);
      children.push(child);
      if (Number.isInteger(child.childProcessId)) childProcessIds.push(child.childProcessId);
    }
    writeFileSync(barrierPath, "go", "utf8");
    const settled = await Promise.allSettled(children.map(({ completion }) => completion));
    const failures = settled.filter(({ status }) => status === "rejected");
    if (failures.length === 1) throw failures[0].reason;
    if (failures.length > 1) {
      throw new AggregateError(
        failures.map(({ reason }) => reason),
        "Concurrent start/resume/cancel fixtures failed after every process closed.",
      );
    }
    const results = settled.map(({ value }) => value);
    assert.equal(results.length, 3);
    assert.ok(results.some((result) => result.operation === "cancel"));
    assert.ok(results.every((result) => ["applied", "rejected"].includes(result.result)));

    const store = new WorkbenchStore(databasePath);
    try {
      const events = store.eventsAfter(created.run.id, 0, 100)
        .filter((event) => event.type === "status" && typeof event.payload.from === "string");
      assert.ok(events.length >= 1);
      for (const event of events) {
        assert.equal(
          isLegalRunTransition(event.payload.from, event.payload.status),
          true,
          `${event.payload.from} -> ${event.payload.status}`,
        );
      }
      const finalRun = store.getRun(created.run.id);
      assert.ok(finalRun);
      assert.notEqual(finalRun.status, "succeeded");
      assert.notEqual(finalRun.status, "cancelled");
      assert.notEqual(finalRun.status, "failed");
      assert.notEqual(finalRun.status, "blocked");
      const commands = store.outboxForRun(created.run.id, 20);
      assert.equal(new Set(commands.map((command) => command.id)).size, commands.length);
    } finally {
      store.close();
    }
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await removeScratch(root, childProcessIds);
  } catch (cleanupFailure) {
    if (primaryFailure) {
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        "Concurrent transition verification and scratch cleanup both failed.",
      );
    }
    throw cleanupFailure;
  }
  if (primaryFailure) throw primaryFailure;
});

test("event page bounds and rows remain on one WAL snapshot across concurrent compaction", () => {
  const root = scratch();
  const databasePath = path.join(root, "event-snapshot.sqlite3");
  const writer = new WorkbenchStore(databasePath);
  const created = createRun(writer);
  const second = writer.appendEvent(created.run.id, "message", { index: 1 });
  const third = writer.appendEvent(created.run.id, "message", { index: 2 });
  let barrierCalls = 0;
  const reader = new WorkbenchStore(databasePath, {
    eventPageSnapshotHook: () => {
      barrierCalls += 1;
      if (barrierCalls === 1) {
        writer.compactEvents(created.run.id, second.sequence, {
          status: "queued",
          through: second.sequence,
        });
      }
    },
  });
  try {
    const snapshotPage = reader.eventPage(created.run.id, 0, 100);
    assert.equal(barrierCalls, 1);
    assert.equal(snapshotPage.bounds.compactedThroughSequence, 0);
    assert.equal(snapshotPage.gap, null);
    assert.deepEqual(
      snapshotPage.events.map(({ sequence }) => sequence),
      [created.event.sequence, second.sequence, third.sequence],
    );

    const committedPage = writer.eventPage(created.run.id, 0, 100);
    assert.equal(committedPage.gap?.compactedThroughSequence, second.sequence);
    assert.deepEqual(committedPage.events.map(({ sequence }) => sequence), [third.sequence]);
  } finally {
    reader.close();
    writer.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
