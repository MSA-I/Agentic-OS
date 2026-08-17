import { existsSync, writeFileSync } from "node:fs";

import { ArtifactStoreError, DurableArtifactStore } from "./artifactStore.ts";

const [mode, ...args] = process.argv.slice(2);
if (!mode) process.exit(64);

const sleepState = new Int32Array(new SharedArrayBuffer(4));
const waitForFile = (filePath) => {
  const started = Date.now();
  while (!existsSync(filePath)) {
    if (Date.now() - started > 20_000) process.exit(70);
    Atomics.wait(sleepState, 0, 0, 5);
  }
};

const output = (value) => process.stdout.write(JSON.stringify(value));
const reject = (error) => output({
  result: "rejected",
  code: error instanceof ArtifactStoreError ? error.code : "unexpected_error",
  message: error instanceof Error ? error.message : String(error),
});

let store;
try {
  if (mode === "first-open") {
    const [root, readyPath, barrierPath] = args;
    if (!root || !readyPath || !barrierPath) process.exit(64);
    writeFileSync(readyPath, "ready", { flag: "wx", flush: true });
    waitForFile(barrierPath);
    store = new DurableArtifactStore(root);
    output({ result: "opened", counts: store.counts() });
  } else if (mode === "writer-hold") {
    const [root, runId, label, payload, maximumStoreBytesValue, readyPath, barrierPath] = args;
    const maximumStoreBytes = Number(maximumStoreBytesValue);
    if (!root || !runId || !label || payload === undefined || !Number.isSafeInteger(maximumStoreBytes)
      || !readyPath || !barrierPath) process.exit(64);
    store = new DurableArtifactStore(root, {
      quota: {
        maximumArtifactBytes: maximumStoreBytes,
        maximumRunBytes: maximumStoreBytes,
        maximumStoreBytes,
      },
    });
    writeFileSync(readyPath, "ready", { flag: "wx", flush: true });
    waitForFile(barrierPath);
    const artifact = store.put(runId, label, Buffer.from(payload, "utf8"));
    output({ result: "stored", artifact, counts: store.counts() });
  } else if (mode === "gc-race") {
    const [root, transactionReady, transactionBarrier, ledgerReady, ledgerBarrier,
      maximumStoreBytesValue] = args;
    const maximumStoreBytes = Number(maximumStoreBytesValue);
    if (!root || !transactionReady || !transactionBarrier || !ledgerReady || !ledgerBarrier
      || !Number.isSafeInteger(maximumStoreBytes)) process.exit(64);
    let transactionHeld = false;
    let ledgerHeld = false;
    store = new DurableArtifactStore(root, {
      quota: {
        maximumArtifactBytes: maximumStoreBytes,
        maximumRunBytes: maximumStoreBytes,
        maximumStoreBytes,
      },
      faultInjector(point) {
        if (!transactionHeld && point === "after_gc_intent_insert") {
          transactionHeld = true;
          writeFileSync(transactionReady, "ready", { flag: "wx", flush: true });
          waitForFile(transactionBarrier);
        }
        if (!ledgerHeld && point === "after_gc_ledger_commit") {
          ledgerHeld = true;
          writeFileSync(ledgerReady, "ready", { flag: "wx", flush: true });
          waitForFile(ledgerBarrier);
        }
      },
    });
    output({ result: "collected", deleted: store.garbageCollect(), counts: store.counts() });
  } else if (mode === "gc-hold") {
    const [root, readyPath, barrierPath] = args;
    if (!root || !readyPath || !barrierPath) process.exit(64);
    let held = false;
    store = new DurableArtifactStore(root, {
      faultInjector(point) {
        if (!held && point === "after_gc_intent_insert") {
          held = true;
          writeFileSync(readyPath, "ready", { flag: "wx", flush: true });
          waitForFile(barrierPath);
        }
      },
    });
    output({ result: "collected", deleted: store.garbageCollect(), counts: store.counts() });
  } else if (mode === "gc-crash") {
    const [root, crashPoint] = args;
    if (!root || !crashPoint) process.exit(64);
    store = new DurableArtifactStore(root, {
      faultInjector(point) {
        if (point === crashPoint) process.exit(86);
      },
    });
    store.garbageCollect();
    process.exit(71);
  } else if (mode === "backup-crash") {
    const [root, destination, crashPoint] = args;
    if (!root || !destination || !crashPoint) process.exit(64);
    store = new DurableArtifactStore(root, {
      faultInjector(point) {
        if (point === crashPoint) process.exit(86);
      },
    });
    store.backup(destination);
    process.exit(71);
  } else if (mode === "crash-point") {
    const [root, crashPoint, runId, label, payload, maximumStoreBytesValue] = args;
    const maximumStoreBytes = Number(maximumStoreBytesValue);
    if (!root || !crashPoint || !runId || !label || payload === undefined
      || !Number.isSafeInteger(maximumStoreBytes)) process.exit(64);
    store = new DurableArtifactStore(root, {
      quota: {
        maximumArtifactBytes: Math.max(1, maximumStoreBytes),
        maximumRunBytes: Math.max(1, maximumStoreBytes),
        maximumStoreBytes,
      },
      faultInjector(point) {
        if (point === crashPoint) process.exit(86);
      },
    });
    store.put(runId, label, Buffer.from(payload, "utf8"));
    process.exit(71);
  } else {
    const [root, runId, label, payload, maximumStoreBytesValue, readyPath, barrierPath] = args;
    const maximumStoreBytes = Number(maximumStoreBytesValue);
    if (!root || !runId || !label || payload === undefined || !Number.isSafeInteger(maximumStoreBytes)) {
      process.exit(64);
    }
    const crashPoint = mode === "crash-after-rename" ? "after_rename" : undefined;
    store = new DurableArtifactStore(root, {
      quota: {
        maximumArtifactBytes: Math.max(1, maximumStoreBytes),
        maximumRunBytes: Math.max(1, maximumStoreBytes),
        maximumStoreBytes,
      },
      faultInjector(point) {
        if (mode === "quota" && point === "after_intent_commit") Atomics.wait(sleepState, 0, 0, 350);
        if (crashPoint && point === crashPoint) process.exit(86);
      },
    });
    if (mode === "quota") {
      if (!readyPath || !barrierPath) process.exit(64);
      writeFileSync(readyPath, "ready", { flag: "wx", flush: true });
      waitForFile(barrierPath);
    } else if (mode !== "crash-after-rename" && mode !== "single") {
      process.exit(64);
    }

    const artifact = store.put(runId, label, Buffer.from(payload, "utf8"));
    output({ result: "stored", artifact, counts: store.counts() });
  }
} catch (error) {
  reject(error);
} finally {
  store?.close();
}
