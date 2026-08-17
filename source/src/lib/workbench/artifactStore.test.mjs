import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ArtifactStoreError, DurableArtifactStore } from "./artifactStore.ts";

const sourceRoot = process.cwd();
const processFixture = path.join(sourceRoot, "src", "lib", "workbench", "artifactStore.process.fixture.mjs");

function scratch(prefix = "case-") {
  const base = path.join(sourceRoot, ".next", "wave2-artifact-tests");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, prefix));
}

function cleanup(target) {
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

async function cleanupEventually(target) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      cleanup(target);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

function hash(data) {
  return createHash("sha256").update(data).digest("hex");
}

function quota(overrides = {}) {
  return {
    maximumArtifactBytes: 1024,
    maximumRunBytes: 4096,
    maximumStoreBytes: 8192,
    maximumBlobCount: 100,
    maximumReferenceCount: 100,
    maximumRunReferenceCount: 100,
    maximumIntentCount: 100,
    maximumMetadataBytes: 1024 * 1024,
    maximumDatabaseBytes: 16 * 1024 * 1024,
    ...overrides,
  };
}

function expectCode(code) {
  return (error) => error instanceof ArtifactStoreError && error.code === code;
}

function counts(store, expected) {
  const actual = store.counts();
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, key);
}

function openDatabase(root) {
  return new DatabaseSync(path.join(root, "artifacts.sqlite3"));
}

function insertIntent(root, {
  payload = "payload",
  runId = "run-intent",
  label = "result.txt",
  ownerPid = process.pid,
  leaseExpiresAt = new Date(Date.now() + 60_000).toISOString(),
  publish = false,
} = {}) {
  const contentHash = hash(Buffer.from(payload));
  const relativePath = path.join(contentHash.slice(0, 2), contentHash);
  const createdAt = new Date().toISOString();
  const database = openDatabase(root);
  try {
    database.prepare(`
      INSERT INTO artifact_write_intents (
        intent_id, content_hash, bytes, relative_path, run_id, label,
        reference_id, created_at, owner_pid, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), contentHash, Buffer.byteLength(payload), relativePath, runId, label,
      randomUUID(), createdAt, ownerPid, leaseExpiresAt,
    );
  } finally { database.close(); }
  if (publish) {
    const target = path.join(root, "blobs", relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, payload, { flag: "wx", flush: true });
  }
  return { contentHash, relativePath };
}

function backupFromBundle(bundlePath) {
  const manifestPath = path.join(bundlePath, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return {
    schemaVersion: 1,
    bundlePath,
    manifestPath,
    path: path.join(bundlePath, "artifacts.sqlite3"),
    sha256: manifest.database.sha256,
    bytes: manifest.database.bytes,
    createdAt: manifest.createdAt,
    blobDirectory: path.join(bundlePath, "blobs"),
    blobs: manifest.blobs,
  };
}

function crashFixture(argumentsList) {
  return spawnSync(process.execPath, ["--experimental-strip-types", processFixture, ...argumentsList], {
    cwd: sourceRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
}

function databaseFootprint(root) {
  return ["artifacts.sqlite3", "artifacts.sqlite3-wal", "artifacts.sqlite3-shm"]
    .map((name) => path.join(root, name))
    .filter((filePath) => existsSync(filePath))
    .reduce((total, filePath) => total + statSync(filePath).size, 0);
}

function launchQuotaWriter(root, index, barrierPath) {
  const readyPath = path.join(root, `writer-${index}.ready`);
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    processFixture,
    "quota",
    root,
    `run-${index}`,
    `artifact-${index}.txt`,
    `blob-00${index}`,
    "8",
    readyPath,
    barrierPath,
  ], { cwd: sourceRoot, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const completion = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`quota fixture exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
  return { readyPath, completion };
}

function launchFixture(argumentsList) {
  const child = spawn(process.execPath, ["--experimental-strip-types", processFixture, ...argumentsList], {
    cwd: sourceRoot,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`artifact fixture exited ${code}: ${stderr}`));
      else resolve(stdout ? JSON.parse(stdout) : undefined);
    });
  });
}

async function waitForFiles(filePaths) {
  const started = Date.now();
  while (!filePaths.every((filePath) => existsSync(filePath))) {
    if (Date.now() - started > 20_000) throw new Error("Timed out waiting for artifact writer barriers.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("content addressing, deduplication, and byte quotas remain enforced", () => {
  const root = scratch();
  const store = new DurableArtifactStore(root, {
    quota: quota({ maximumArtifactBytes: 16, maximumRunBytes: 20, maximumStoreBytes: 24 }),
  });
  try {
    const first = store.put("run-1", "result.txt", Buffer.from("same"));
    const duplicate = store.put("run-1", "result.txt", Buffer.from("same"));
    const crossRun = store.put("run-2", "copy.txt", Buffer.from("same"));
    assert.equal(first.deduplicated, false);
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(crossRun.contentHash, first.contentHash);
    counts(store, { blobs: 1, references: 2, intents: 0, bytes: 4 });
    assert.throws(() => store.put("run-1", "large.txt", Buffer.alloc(17)), expectCode("quota_exceeded"));
  } finally {
    store.close();
    cleanup(root);
  }
});

test("multi-process writers reserve store quota under BEGIN IMMEDIATE", { timeout: 30_000 }, async () => {
  const root = scratch();
  const barrierPath = path.join(root, "quota.barrier");
  const sharedQuota = { maximumArtifactBytes: 8, maximumRunBytes: 8, maximumStoreBytes: 8 };
  try {
    new DurableArtifactStore(root, { quota: sharedQuota }).close();
    const writers = Array.from({ length: 4 }, (_, index) => launchQuotaWriter(root, index, barrierPath));
    await waitForFiles(writers.map((writer) => writer.readyPath));
    writeFileSync(barrierPath, "go", { flag: "wx", flush: true });
    const results = await Promise.all(writers.map((writer) => writer.completion));
    assert.equal(results.filter((result) => result.result === "stored").length, 1);
    assert.equal(results.filter((result) => result.code === "quota_exceeded").length, 3);
    const reopened = new DurableArtifactStore(root, { quota: sharedQuota });
    try { counts(reopened, { blobs: 1, references: 1, intents: 0, bytes: 8 }); }
    finally { reopened.close(); }
  } finally {
    await cleanupEventually(root);
  }
});

test("zero-byte and deduplicated references consume count and metadata quotas", () => {
  const referenceRoot = scratch("reference-");
  const referenceQuota = quota({ maximumReferenceCount: 2, maximumRunReferenceCount: 2 });
  const store = new DurableArtifactStore(referenceRoot, { quota: referenceQuota });
  try {
    store.put("run-1", "one", Buffer.alloc(0));
    store.put("run-2", "two", Buffer.alloc(0));
    assert.throws(() => store.put("run-3", "three", Buffer.alloc(0)), expectCode("quota_exceeded"));
    counts(store, { blobs: 1, references: 2, bytes: 0 });
  } finally {
    store.close();
    rmSync(referenceRoot, { recursive: true, force: true });
  }

  const metadataRoot = scratch("metadata-");
  const metadataStore = new DurableArtifactStore(metadataRoot, {
    quota: quota({ maximumMetadataBytes: 350 }),
  });
  try {
    metadataStore.put("run-1", "one", Buffer.alloc(0));
    assert.throws(() => metadataStore.put("run-2", "two", Buffer.alloc(0)), expectCode("quota_exceeded"));
  } finally {
    metadataStore.close();
    rmSync(metadataRoot, { recursive: true, force: true });
  }
});

test("blob count, intent count, and database footprint quotas fail closed", () => {
  const blobRoot = scratch("blob-count-");
  const blobStore = new DurableArtifactStore(blobRoot, { quota: quota({ maximumBlobCount: 1 }) });
  try {
    blobStore.put("run-1", "one", Buffer.from("a"));
    assert.throws(() => blobStore.put("run-2", "two", Buffer.from("b")), expectCode("quota_exceeded"));
  } finally {
    blobStore.close();
    rmSync(blobRoot, { recursive: true, force: true });
  }

  const intentRoot = scratch("intent-count-");
  let fired = false;
  const intentStore = new DurableArtifactStore(intentRoot, {
    quota: quota({ maximumIntentCount: 1 }),
    faultInjector(point) {
      if (!fired && point === "after_intent_commit") {
        fired = true;
        const error = new Error("simulated crash");
        error.code = "ENOSPC";
        throw error;
      }
    },
  });
  try {
    assert.throws(() => intentStore.put("run-1", "one", Buffer.from("a")));
    intentStore.put("run-2", "two", Buffer.from("b"));
    counts(intentStore, { blobs: 1, references: 1, intents: 0, bytes: 1 });
  } finally {
    intentStore.close();
    rmSync(intentRoot, { recursive: true, force: true });
  }

  const databaseRoot = scratch("database-count-");
  assert.throws(
    () => new DurableArtifactStore(databaseRoot, { quota: quota({ maximumDatabaseBytes: 1 }) }),
    expectCode("quota_exceeded"),
  );
  rmSync(databaseRoot, { recursive: true, force: true });
});

test("SQLite page cap and post-checkpoint footprint stay within the durable database quota", () => {
  const root = scratch("database-hard-cap-");
  const maximumDatabaseBytes = 256 * 1024;
  const hardQuota = quota({
    maximumDatabaseBytes,
    maximumReferenceCount: 10_000,
    maximumRunReferenceCount: 10_000,
    maximumIntentCount: 10_000,
    maximumMetadataBytes: 16 * 1024 * 1024,
  });
  const store = new DurableArtifactStore(root, { quota: hardQuota });
  let failure;
  try {
    for (let index = 0; index < 5_000; index += 1) {
      try {
        store.put(`run-${index}`, `artifact-${index}-${"x".repeat(400)}`, Buffer.alloc(0));
      } catch (error) {
        failure = error;
        break;
      }
    }
    assert.ok(failure instanceof ArtifactStoreError, "database quota should eventually stop new writes");
    assert.ok(["quota_exceeded", "disk_write_failed"].includes(failure.code), failure.code);
    store.checkpoint();
    assert.ok(databaseFootprint(root) <= maximumDatabaseBytes);
    const durableCounts = store.counts();
    store.close();
    const reopened = new DurableArtifactStore(root, { quota: hardQuota });
    try {
      assert.deepEqual(reopened.counts(), durableCounts);
      assert.ok(databaseFootprint(root) <= maximumDatabaseBytes);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable policy is single source and process configuration mismatch fails closed", () => {
  const root = scratch();
  const originalQuota = { maximumArtifactBytes: 64, maximumRunBytes: 64, maximumStoreBytes: 64 };
  new DurableArtifactStore(root, { quota: originalQuota }).close();
  try {
    assert.throws(
      () => new DurableArtifactStore(root, {
        quota: { maximumArtifactBytes: 65, maximumRunBytes: 65, maximumStoreBytes: 65 },
      }),
      expectCode("policy_mismatch"),
    );
    const child = spawnSync(process.execPath, [
      "--experimental-strip-types", processFixture, "single", root, "run", "label", "x", "65",
    ], { cwd: sourceRoot, env: process.env, encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).code, "policy_mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mismatched process cannot persist a different SQLite page cap", () => {
  const root = scratch("page-policy-");
  const original = quota({ maximumDatabaseBytes: 512 * 1024 });
  new DurableArtifactStore(root, { quota: original }).close();
  const readCap = () => {
    const database = openDatabase(root);
    try { return Number(database.prepare("PRAGMA max_page_count").get().max_page_count); }
    finally { database.close(); }
  };
  try {
    const baseline = readCap();
    assert.throws(
      () => new DurableArtifactStore(root, {
        quota: quota({ maximumDatabaseBytes: 256 * 1024 }),
      }),
      expectCode("policy_mismatch"),
    );
    assert.equal(readCap(), baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reopen fails closed when durable per-run rows exceed the stored policy", () => {
  const root = scratch("durable-run-quota-");
  const sharedQuota = quota({ maximumArtifactBytes: 4, maximumRunBytes: 4 });
  const store = new DurableArtifactStore(root, { quota: sharedQuota });
  const artifact = store.put("run", "one", Buffer.from("four"));
  store.close();
  const database = openDatabase(root);
  try {
    database.prepare(`
      INSERT INTO artifact_references (id, run_id, content_hash, label, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("manual-reference", "run", artifact.contentHash, "two", new Date().toISOString());
  } finally {
    database.close();
  }
  try {
    assert.throws(() => new DurableArtifactStore(root, { quota: sharedQuota }), expectCode("quota_exceeded"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("root, UNC, device, junction, shard link, and deletion containment fail safely", () => {
  assert.throws(() => new DurableArtifactStore("relative-artifacts"), expectCode("containment_failed"));
  assert.throws(() => new DurableArtifactStore("\\\\server\\share\\artifacts"), expectCode("containment_failed"));
  assert.throws(() => new DurableArtifactStore("\\\\?\\C:\\artifacts"), expectCode("containment_failed"));

  const external = scratch("external-");
  const junction = `${external}-junction`;
  try {
    symlinkSync(external, junction, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => new DurableArtifactStore(junction), expectCode("containment_failed"));
  } finally {
    rmSync(junction, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }

  const root = scratch("shard-");
  const outside = scratch("outside-");
  const payload = Buffer.from("payload");
  const shard = hash(payload).slice(0, 2);
  const store = new DurableArtifactStore(root);
  try {
    symlinkSync(outside, path.join(root, "blobs", shard), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => store.put("run-1", "result", payload), expectCode("containment_failed"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }

  const gcRoot = scratch("gc-link-");
  const externalDirectory = scratch("external-file-");
  const externalFile = path.join(externalDirectory, "keep.txt");
  writeFileSync(externalFile, "keep", "utf8");
  new DurableArtifactStore(gcRoot).close();
  symlinkSync(
    externalDirectory,
    path.join(gcRoot, "blobs", "untracked-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  new DurableArtifactStore(gcRoot).close();
  assert.equal(readFileSync(externalFile, "utf8"), "keep");
  rmSync(gcRoot, { recursive: true, force: true });
  rmSync(externalDirectory, { recursive: true, force: true });
});

test("Windows handle pins reject root, shard, backup-parent, and restore-parent rename races", {
  skip: process.platform !== "win32",
}, () => {
  const root = scratch("windows-pins-");
  const backupParent = scratch("windows-backup-parent-");
  const restoreParent = scratch("windows-restore-parent-");
  const validBackupParent = scratch("windows-valid-backup-");
  const payload = Buffer.from("payload");
  let store;
  let raceStore;
  try {
    store = new DurableArtifactStore(root);
    const artifact = store.put("run", "result", payload);
    assert.throws(() => renameSync(root, `${root}-moved`));
    const shard = path.join(root, "blobs", artifact.contentHash.slice(0, 2));
    assert.throws(() => renameSync(shard, `${shard}-moved`));
    const validBackup = store.backup(path.join(validBackupParent, "valid"));
    store.close();
    store = undefined;

    let backupProbeFired = false;
    raceStore = new DurableArtifactStore(root, {
      faultInjector(point) {
        if (!backupProbeFired && point === "after_backup_database") {
          backupProbeFired = true;
          assert.throws(() => renameSync(backupParent, `${backupParent}-moved`));
          throw new Error("stop-after-backup-parent-probe");
        }
      },
    });
    assert.throws(
      () => raceStore.backup(path.join(backupParent, "race")),
      /stop-after-backup-parent-probe/u,
    );
    assert.equal(backupProbeFired, true);
    raceStore.close();
    raceStore = undefined;

    let restoreProbeFired = false;
    assert.throws(() => DurableArtifactStore.restoreBackup(
      validBackup,
      path.join(restoreParent, "restored"),
      (point) => {
        if (!restoreProbeFired && point === "after_restore_database_copy") {
          restoreProbeFired = true;
          assert.throws(() => renameSync(restoreParent, `${restoreParent}-moved`));
          throw new Error("stop-after-restore-parent-probe");
        }
      },
    ), /stop-after-restore-parent-probe/u);
    assert.equal(restoreProbeFired, true);
  } finally {
    try { raceStore?.close(); } catch { /* best effort */ }
    try { store?.close(); } catch { /* best effort */ }
    cleanup(root);
    cleanup(backupParent);
    cleanup(restoreParent);
    cleanup(validBackupParent);
  }
});

test("Windows publication keeps the source handle pinned until rename identity is verified", {
  skip: process.platform !== "win32",
}, () => {
  const root = scratch("windows-rename-identity-");
  const payload = Buffer.from("rename-identity");
  const contentHash = hash(payload);
  const shard = path.join(root, "blobs", contentHash.slice(0, 2));
  let movedSource;
  let fired = false;
  const store = new DurableArtifactStore(root, {
    faultInjector(point) {
      if (fired || point !== "after_blob_publish_source_pin") return;
      fired = true;
      const temporaryName = readdirSync(shard).find((name) => name.endsWith(".tmp"));
      assert.ok(temporaryName, "expected a pinned publication source");
      const temporaryPath = path.join(shard, temporaryName);
      movedSource = `${temporaryPath}.moved`;
      renameSync(temporaryPath, movedSource);
    },
  });
  try {
    assert.throws(
      () => store.put("run", "result", payload),
      expectCode("containment_failed"),
    );
    assert.equal(fired, true);
    assert.ok(movedSource && existsSync(movedSource));
    assert.equal(existsSync(path.join(shard, contentHash)), false);
    counts(store, { blobs: 0, references: 0, intents: 0, bytes: 0 });
  } finally {
    store.close();
    cleanup(root);
  }
});

test("Windows restore copies keep database, blob, and manifest sources pinned against rename and write", {
  skip: process.platform !== "win32",
}, () => {
  const root = scratch("windows-restore-copy-source-");
  const backupRoot = scratch("windows-restore-copy-backup-");
  const restoreParent = scratch("windows-restore-copy-output-");
  const restoreRoot = path.join(restoreParent, "restored");
  const source = new DurableArtifactStore(root);
  try {
    source.put("run", "result", Buffer.from("payload"));
    const backup = source.backup(path.join(backupRoot, "bundle"));
    source.close();
    const sourceByPoint = new Map([
      ["after_restore_database_source_pin", backup.path],
      ["after_restore_blob_source_pin", path.join(backup.blobDirectory, backup.blobs[0].relativePath)],
      ["after_restore_manifest_source_pin", backup.manifestPath],
    ]);
    const fired = new Set();
    DurableArtifactStore.restoreBackup(backup, restoreRoot, (point) => {
      const sourcePath = sourceByPoint.get(point);
      if (!sourcePath || fired.has(point)) return;
      fired.add(point);
      assert.throws(() => renameSync(sourcePath, `${sourcePath}.moved`));
      assert.throws(() => writeFileSync(sourcePath, "tamper"));
    });
    assert.deepEqual([...fired].sort(), [...sourceByPoint.keys()].sort());
    const restored = new DurableArtifactStore(restoreRoot);
    try { counts(restored, { blobs: 1, references: 1, intents: 0, bytes: 7 }); }
    finally { restored.close(); }
  } finally {
    try { source.close(); } catch { /* already closed */ }
    cleanup(root);
    cleanup(backupRoot);
    cleanup(restoreParent);
  }
});

test("Windows stale staging cleanup fails closed when the pinned source is renamed and replaced", {
  skip: process.platform !== "win32",
}, () => {
  const root = scratch("windows-cleanup-race-source-");
  const backupRoot = scratch("windows-cleanup-race-backup-");
  const restoreParent = scratch("windows-cleanup-race-output-");
  const destination = path.join(restoreParent, "restore-target");
  const stale = path.join(restoreParent, ".restore-target.dead.restore");
  const moved = `${stale}.moved`;
  const source = new DurableArtifactStore(root);
  try {
    source.put("run", "result", Buffer.from("payload"));
    const backup = source.backup(path.join(backupRoot, "bundle"));
    source.close();
    mkdirSync(stale);
    writeFileSync(path.join(stale, "original.txt"), "original");
    new DatabaseSync(`${stale}.owner.sqlite3`).close();
    utimesSync(stale, new Date(0), new Date(0));
    let fired = false;
    assert.throws(() => DurableArtifactStore.restoreBackup(backup, destination, (point) => {
      if (fired || point !== "after_staging_cleanup_source_pin") return;
      fired = true;
      renameSync(stale, moved);
      mkdirSync(stale);
      writeFileSync(path.join(stale, "replacement.txt"), "replacement");
    }), expectCode("containment_failed"));
    assert.equal(fired, true);
    assert.equal(readFileSync(path.join(moved, "original.txt"), "utf8"), "original");
    assert.equal(readFileSync(path.join(stale, "replacement.txt"), "utf8"), "replacement");
    assert.equal(existsSync(destination), false);
  } finally {
    try { source.close(); } catch { /* already closed */ }
    cleanup(root);
    cleanup(backupRoot);
    cleanup(restoreParent);
  }
});

test("malformed intent metadata fails before finalize or pending quota calculation", () => {
  const root = scratch();
  new DurableArtifactStore(root).close();
  const database = openDatabase(root);
  try {
    database.prepare(`
      INSERT INTO artifact_write_intents (
        intent_id, content_hash, bytes, relative_path, run_id, label,
        reference_id, created_at, owner_pid, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "intent", "a".repeat(64), 1, path.join("..", "escape"), "run", "label", "reference",
      new Date().toISOString(), process.pid, new Date(Date.now() + 60_000).toISOString(),
    );
  } finally {
    database.close();
  }
  try {
    assert.throws(() => new DurableArtifactStore(root), expectCode("integrity_failed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed intent owner identity fails before recovery", () => {
  const root = scratch("intent-owner-");
  new DurableArtifactStore(root).close();
  const contentHash = hash(Buffer.from("x"));
  const database = openDatabase(root);
  try {
    database.prepare(`
      INSERT INTO artifact_write_intents (
        intent_id, content_hash, bytes, relative_path, run_id, label,
        reference_id, created_at, owner_pid, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "intent", contentHash, 1, path.join(contentHash.slice(0, 2), contentHash), "run", "label",
      "reference", new Date().toISOString(), 0, new Date(Date.now() + 60_000).toISOString(),
    );
  } catch (error) {
    assert.match(String(error), /CHECK constraint failed/u);
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare(`
      INSERT INTO artifact_write_intents (
        intent_id, content_hash, bytes, relative_path, run_id, label,
        reference_id, created_at, owner_pid, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "intent", contentHash, 1, path.join(contentHash.slice(0, 2), contentHash), "run", "label",
      "reference", new Date().toISOString(), 0, new Date(Date.now() + 60_000).toISOString(),
    );
  } finally {
    database.close();
  }
  try {
    assert.throws(() => new DurableArtifactStore(root), expectCode("integrity_failed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("crash after rename is authenticated and reconciled without quota bypass", () => {
  const root = scratch();
  const payload = "crash-payload";
  const sharedQuota = {
    maximumArtifactBytes: Buffer.byteLength(payload),
    maximumRunBytes: Buffer.byteLength(payload),
    maximumStoreBytes: Buffer.byteLength(payload),
  };
  try {
    new DurableArtifactStore(root, { quota: sharedQuota }).close();
    const crashed = spawnSync(process.execPath, [
      "--experimental-strip-types", processFixture, "crash-after-rename", root,
      "run-crash", "result.txt", payload, String(Buffer.byteLength(payload)),
    ], { cwd: sourceRoot, env: process.env, encoding: "utf8", windowsHide: true });
    assert.equal(crashed.status, 86, crashed.stderr);
    const reopened = new DurableArtifactStore(root, { quota: sharedQuota });
    try {
      counts(reopened, { blobs: 1, references: 1, intents: 0, bytes: Buffer.byteLength(payload) });
      assert.equal(reopened.put("run-copy", "copy.txt", Buffer.from(payload)).deduplicated, true);
      assert.throws(() => reopened.put("run-new", "new.txt", Buffer.from("x")), expectCode("quota_exceeded"));
    } finally { reopened.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all publish, SQLite, commit, and disk-full fault boundaries recover consistently", async (context) => {
  const committed = new Set(["after_commit"]);
  const points = [
    "after_intent_commit", "after_temp_write", "after_rename", "after_file_fsync",
    "before_blob_insert", "after_blob_insert", "before_commit", "after_commit",
  ];
  for (const point of points) {
    await context.test(point, async () => {
      const root = scratch(`fault-${point}-`);
      const sharedQuota = quota();
      let fired = false;
      const store = new DurableArtifactStore(root, {
        quota: sharedQuota,
        intentLeaseMs: 5,
        faultInjector(current) {
          if (!fired && current === point) {
            fired = true;
            const error = new Error(`fault:${point}`);
            error.code = point === "before_blob_insert" ? "SQLITE_FULL" : "ENOSPC";
            throw error;
          }
        },
      });
      try { assert.throws(() => store.put("run", "result", Buffer.from("payload"))); }
      finally { store.close(); }
      await new Promise((resolve) => setTimeout(resolve, 10));
      const reopened = new DurableArtifactStore(root, { quota: sharedQuota, intentLeaseMs: 5 });
      try {
        if (committed.has(point)) counts(reopened, { blobs: 1, references: 1, intents: 0, bytes: 7 });
        else counts(reopened, { blobs: 0, references: 0, intents: 0, bytes: 0 });
      } finally {
        reopened.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("WAL checkpoint fault is explicit and leaves committed artifact recoverable", () => {
  const root = scratch();
  let fired = false;
  const store = new DurableArtifactStore(root, {
    faultInjector(point) {
      if (!fired && point === "before_wal_checkpoint") {
        fired = true;
        const error = new Error("simulated WAL checkpoint fault");
        error.code = "ENOSPC";
        throw error;
      }
    },
  });
  try {
    store.put("run", "result", Buffer.from("payload"));
    assert.throws(() => store.checkpoint());
  } finally {
    store.close();
  }
  const reopened = new DurableArtifactStore(root);
  try { counts(reopened, { blobs: 1, references: 1, intents: 0, bytes: 7 }); }
  finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration ledger is forward-only, checksummed, and integrity checked", () => {
  const root = scratch();
  new DurableArtifactStore(root).close();
  const database = openDatabase(root);
  try {
    const rows = database.prepare(`
      SELECT version, checksum FROM artifact_schema_migrations ORDER BY version
    `).all();
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2, 3]);
    assert.ok(rows.every((row) => /^[a-f0-9]{64}$/u.test(String(row.checksum))));
    database.prepare("UPDATE artifact_schema_migrations SET checksum = ? WHERE version = 1").run("0".repeat(64));
  } finally { database.close(); }
  try { assert.throws(() => new DurableArtifactStore(root), expectCode("integrity_failed")); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonical schema DDL and index identity tampering fail closed", async (context) => {
  const cases = [
    {
      name: "same-name index on wrong columns",
      tamper(database) {
        database.exec(`
          DROP INDEX artifact_references_run_idx;
          CREATE INDEX artifact_references_run_idx ON artifact_references(label);
        `);
      },
    },
    {
      name: "UNIQUE DDL",
      table: "artifact_references",
      before: "UNIQUE(run_id, content_hash, label)",
      after: "UNIQUE(run_id, content_hash)",
    },
    {
      name: "CHECK DDL",
      table: "artifact_blobs",
      before: "CHECK(bytes >= 0)",
      after: "CHECK(bytes > 0)",
    },
    {
      name: "foreign-key DDL",
      table: "artifact_references",
      before: "REFERENCES artifact_blobs(content_hash)",
      after: "REFERENCES artifact_blobs(relative_path)",
    },
  ];
  for (const probe of cases) {
    await context.test(probe.name, () => {
      const root = scratch("schema-tamper-");
      try {
        new DurableArtifactStore(root).close();
        const database = openDatabase(root);
        try {
          if (probe.tamper) {
            probe.tamper(database);
          } else {
            database.enableDefensive(false);
            database.exec("PRAGMA writable_schema = ON;");
            const result = database.prepare(`
              UPDATE sqlite_schema SET sql = replace(sql, ?, ?)
              WHERE type = 'table' AND name = ?
            `).run(probe.before, probe.after, probe.table);
            assert.equal(Number(result.changes), 1);
            database.exec("PRAGMA writable_schema = OFF;");
            database.enableDefensive(true);
          }
        } finally {
          try { database.exec("PRAGMA writable_schema = OFF;"); } catch { /* best effort */ }
          try { database.enableDefensive(true); } catch { /* best effort */ }
          database.close();
        }
        assert.throws(() => new DurableArtifactStore(root), expectCode("integrity_failed"));
      } finally { cleanup(root); }
    });
  }
});

test("database and blobs backup hash, verify, restore, and reopen", () => {
  const root = scratch("backup-source-");
  const backupRoot = scratch("backup-output-");
  const restoreRoot = scratch("backup-restore-");
  rmSync(restoreRoot, { recursive: true, force: true });
  const store = new DurableArtifactStore(root);
  try {
    store.put("run", "result", Buffer.from("payload"));
    const backup = store.backup(path.join(backupRoot, "artifacts-backup.sqlite3"));
    assert.equal(backup.schemaVersion, 1);
    assert.equal(existsSync(backup.manifestPath), true);
    assert.match(backup.sha256, /^[a-f0-9]{64}$/u);
    DurableArtifactStore.verifyBackup(backup);
    DurableArtifactStore.restoreBackup(backup, restoreRoot);
    const restored = new DurableArtifactStore(restoreRoot);
    try {
      counts(restored, { blobs: 1, references: 1, intents: 0, bytes: 7 });
      assert.equal(restored.put("run", "result", Buffer.from("payload")).deduplicated, true);
    } finally { restored.close(); }
    writeFileSync(backup.path, "tamper", { flag: "a" });
    assert.throws(() => DurableArtifactStore.verifyBackup(backup), expectCode("integrity_failed"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
    rmSync(restoreRoot, { recursive: true, force: true });
  }
});

test("backup staging removes every partial output before publication", () => {
  const root = scratch("backup-fault-source-");
  const backupRoot = scratch("backup-fault-output-");
  const store = new DurableArtifactStore(root);
  try {
    store.put("run", "result", Buffer.from("payload"));
    for (const point of ["after_backup_database", "after_backup_blob_copy", "before_backup_manifest", "after_backup_manifest", "after_backup_publish"]) {
      let fired = false;
      const destination = path.join(backupRoot, `${point}.sqlite3`);
      const injected = new DurableArtifactStore(root, {
        faultInjector(current) {
          if (!fired && current === point) {
            fired = true;
            throw new Error(`fault:${point}`);
          }
        },
      });
      try {
        assert.throws(() => injected.backup(destination));
      } finally {
        injected.close();
      }
      assert.equal(existsSync(destination), false);
      assert.equal(existsSync(`${destination}.blobs`), false);
      assert.deepEqual(readdirSync(backupRoot), []);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
  }
});

test("restore staging leaves an empty destination after every injected copy failure", () => {
  const root = scratch("restore-fault-source-");
  const backupRoot = scratch("restore-fault-backup-");
  const store = new DurableArtifactStore(root);
  try {
    store.put("run", "result", Buffer.from("payload"));
    const backup = store.backup(path.join(backupRoot, "artifacts.sqlite3"));
    for (const point of [
      "after_restore_database_copy", "after_restore_blob_copy",
      "before_restore_manifest_copy", "after_restore_manifest_copy",
    ]) {
      const restoreRoot = scratch(`restore-${point}-`);
      rmSync(restoreRoot, { recursive: true, force: true });
      let fired = false;
      try {
        assert.throws(() => DurableArtifactStore.restoreBackup(backup, restoreRoot, (current) => {
          if (!fired && current === point) {
            fired = true;
            throw new Error(`fault:${point}`);
          }
        }));
        assert.equal(existsSync(restoreRoot), false);
        DurableArtifactStore.restoreBackup(backup, restoreRoot);
        const restored = new DurableArtifactStore(restoreRoot);
        try { counts(restored, { blobs: 1, references: 1, intents: 0, bytes: 7 }); }
        finally { restored.close(); }
      } finally {
        rmSync(restoreRoot, { recursive: true, force: true });
      }
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
  }
});

test("durable GC tombstones recover before and after filesystem deletion", async (context) => {
  for (const point of ["after_gc_ledger_commit", "after_gc_file_delete"]) {
    await context.test(point, () => {
      const root = scratch(`gc-${point}-`);
      const sharedQuota = quota({ maximumStoreBytes: 7 });
      let fired = false;
      const store = new DurableArtifactStore(root, {
        quota: sharedQuota,
        faultInjector(current) {
          if (!fired && current === point) {
            fired = true;
            const error = new Error(`fault:${point}`);
            error.code = "ENOSPC";
            throw error;
          }
        },
      });
      const artifact = store.put("run", "result", Buffer.from("payload"));
      const blobPath = path.join(root, "blobs", artifact.contentHash.slice(0, 2), artifact.contentHash);
      try {
        assert.throws(() => store.deleteReference(artifact.id));
        counts(store, { blobs: 1, references: 0, intents: 0, bytes: 7 });
        assert.throws(
          () => store.put("blocked", "blocked", Buffer.from("x")),
          expectCode("quota_exceeded"),
        );
        const database = openDatabase(root);
        try {
          assert.equal(Number(database.prepare("SELECT COUNT(*) AS value FROM artifact_gc_intents").get().value), 1);
        } finally {
          database.close();
        }
        assert.equal(existsSync(blobPath), point === "after_gc_ledger_commit");
      } finally {
        store.close();
      }
      const reopened = new DurableArtifactStore(root, { quota: sharedQuota });
      try {
        counts(reopened, { blobs: 0, references: 0, intents: 0, bytes: 0 });
        assert.equal(existsSync(blobPath), false);
      } finally {
        reopened.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("retention, explicit deletion, and unreferenced blob GC are deterministic", async () => {
  const root = scratch();
  const store = new DurableArtifactStore(root, {
    retention: { maximumReferenceAgeMs: 5, garbageCollectUnreferencedBlobs: true },
  });
  try {
    const first = store.put("run-1", "one", Buffer.from("same"));
    const second = store.put("run-2", "two", Buffer.from("same"));
    assert.equal(store.deleteReference(first.id), true);
    counts(store, { blobs: 1, references: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const retained = store.applyRetention();
    assert.deepEqual(retained, { referencesDeleted: 1, blobsDeleted: 1 });
    counts(store, { blobs: 0, references: 0, intents: 0, bytes: 0 });
    assert.equal(store.deleteReference(second.id), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent first-open processes serialize migration and mutex initialization under stress", {
  timeout: 120_000,
}, async () => {
  for (let round = 0; round < 10; round += 1) {
    const root = scratch(`first-open-${round}-`);
    const barrierPath = path.join(root, "open.barrier");
    try {
      const workers = Array.from({ length: 4 }, (_, index) => {
        const readyPath = path.join(root, `open-${index}.ready`);
        return {
          readyPath,
          completion: launchFixture(["first-open", root, readyPath, barrierPath]),
        };
      });
      await waitForFiles(workers.map((worker) => worker.readyPath));
      writeFileSync(barrierPath, "go", { flag: "wx", flush: true });
      const results = await Promise.all(workers.map((worker) => worker.completion));
      assert.ok(results.every((result) => result.result === "opened"), `round ${round}: ${JSON.stringify(results)}`);
      const database = openDatabase(root);
      try {
        assert.deepEqual(
          database.prepare("SELECT version FROM artifact_schema_migrations ORDER BY version").all()
            .map((row) => Number(row.version)),
          [1, 2, 3],
        );
      } finally { database.close(); }
    } finally { await cleanupEventually(root); }
  }
});

test("first-open mutex contention rejects with a typed phase after bounded retries", {
  timeout: 30_000,
}, async () => {
  const root = scratch("first-open-mutex-contention-");
  const readyPath = path.join(root, "blocked-open.ready");
  const barrierPath = path.join(root, "blocked-open.barrier");
  let mutex;
  try {
    new DurableArtifactStore(root).close();
    mutex = new DatabaseSync(path.join(root, ".artifact-backup-mutex.sqlite3"));
    mutex.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    writeFileSync(barrierPath, "go", { flag: "wx", flush: true });
    const result = await launchFixture(["first-open", root, readyPath, barrierPath]);
    assert.equal(result.result, "rejected");
    assert.equal(result.code, "operation_in_progress");
    assert.match(result.message, /backup_mutex_initialization/u);
    assert.doesNotMatch(result.message, /^database is locked$/iu);
  } finally {
    if (mutex) {
      try { mutex.exec("ROLLBACK"); } catch { /* best effort */ }
      try { mutex.close(); } catch { /* best effort */ }
    }
    await cleanupEventually(root);
  }
});

test("real process exits recover every write boundary without confusing returned faults with crashes", async (context) => {
  const emptyAfterCrash = new Set(["after_intent_commit", "after_temp_write"]);
  const points = [
    "after_intent_commit", "after_temp_write", "after_rename", "after_file_fsync",
    "before_blob_insert", "after_blob_insert", "before_commit", "after_commit",
  ];
  for (const point of points) {
    await context.test(point, () => {
      const root = scratch(`process-${point}-`);
      const durableQuota = { maximumArtifactBytes: 1024, maximumRunBytes: 1024, maximumStoreBytes: 1024 };
      try {
        new DurableArtifactStore(root, { quota: durableQuota }).close();
        const crashed = crashFixture([
          "crash-point", root, point, "run", "result", "payload", "1024",
        ]);
        assert.equal(crashed.status, 86, crashed.stderr);
        const reopened = new DurableArtifactStore(root, { quota: durableQuota });
        try {
          if (emptyAfterCrash.has(point)) counts(reopened, { blobs: 0, references: 0, intents: 0, bytes: 0 });
          else counts(reopened, { blobs: 1, references: 1, intents: 0, bytes: 7 });
        } finally { reopened.close(); }
      } finally { cleanup(root); }
    });
  }
});

test("writer resolving a committed GC tombstone wins atomically without deleting the replacement", { timeout: 30_000 }, async () => {
  const root = scratch("gc-writer-race-");
  const durableQuota = { maximumArtifactBytes: 1024, maximumRunBytes: 1024, maximumStoreBytes: 1024 };
  const payload = "same-payload";
  const writerReady = path.join(root, "writer.ready");
  const writerBarrier = path.join(root, "writer.barrier");
  const transactionReady = path.join(root, "gc-transaction.ready");
  const transactionBarrier = path.join(root, "gc-transaction.barrier");
  const ledgerReady = path.join(root, "gc-ledger.ready");
  const ledgerBarrier = path.join(root, "gc-ledger.barrier");
  try {
    const seed = new DurableArtifactStore(root, { quota: durableQuota });
    seed.put("seed", "seed.txt", Buffer.from(payload));
    seed.close();
    const database = openDatabase(root);
    try { database.exec("DELETE FROM artifact_references"); } finally { database.close(); }

    const writer = launchFixture([
      "writer-hold", root, "writer", "replacement.txt", payload, "1024", writerReady, writerBarrier,
    ]);
    await waitForFiles([writerReady]);
    const collector = launchFixture([
      "gc-race", root, transactionReady, transactionBarrier, ledgerReady, ledgerBarrier, "1024",
    ]);
    await waitForFiles([transactionReady]);
    writeFileSync(writerBarrier, "write", { flag: "wx", flush: true });
    writeFileSync(transactionBarrier, "commit", { flag: "wx", flush: true });
    await waitForFiles([ledgerReady]);
    const writerResult = await writer;
    assert.equal(writerResult.result, "stored");
    writeFileSync(ledgerBarrier, "finish", { flag: "wx", flush: true });
    const collectorResult = await collector;
    assert.equal(collectorResult.result, "collected");

    const reopened = new DurableArtifactStore(root, { quota: durableQuota });
    try { counts(reopened, { blobs: 1, references: 1, intents: 0, bytes: Buffer.byteLength(payload) }); }
    finally { reopened.close(); }
  } finally { cleanup(root); }
});

test("backup settles verified and abandoned intents but rejects an active unresolved write", () => {
  const root = scratch("backup-intents-");
  const outputRoot = scratch("backup-intents-output-");
  const store = new DurableArtifactStore(root);
  try {
    insertIntent(root, { payload: "verified", runId: "verified-run", publish: true });
    const verifiedBackup = store.backup(path.join(outputRoot, "verified"));
    DurableArtifactStore.verifyBackup(verifiedBackup);
    counts(store, { blobs: 1, references: 1, intents: 0, bytes: 8 });

    const active = insertIntent(root, { payload: "active", runId: "active-run" });
    assert.throws(() => store.backup(path.join(outputRoot, "active")), expectCode("operation_in_progress"));
    assert.equal(existsSync(path.join(root, ".artifact-backup.lock")), false);
    const database = openDatabase(root);
    try {
      database.prepare("UPDATE artifact_write_intents SET lease_expires_at = ? WHERE content_hash = ?")
        .run(new Date(0).toISOString(), active.contentHash);
    } finally { database.close(); }
    const expiredBackup = store.backup(path.join(outputRoot, "expired"));
    DurableArtifactStore.verifyBackup(expiredBackup);
    counts(store, { blobs: 1, references: 1, intents: 0, bytes: 8 });
  } finally {
    store.close();
    cleanup(root);
    cleanup(outputRoot);
  }
});

test("metadata admission reserves the larger of intent and final blob plus reference", () => {
  const finalRoot = scratch("metadata-final-");
  const finalStore = new DurableArtifactStore(finalRoot, { quota: quota({ maximumMetadataBytes: 280 }) });
  try {
    assert.throws(() => finalStore.put("run-1", "one", Buffer.alloc(0)), expectCode("quota_exceeded"));
    counts(finalStore, { blobs: 0, references: 0, intents: 0, bytes: 0 });
  } finally {
    finalStore.close();
    cleanup(finalRoot);
  }

  const intentRoot = scratch("metadata-intent-");
  const intentStore = new DurableArtifactStore(intentRoot, { quota: quota({ maximumMetadataBytes: 500 }) });
  try {
    intentStore.put("run-1", "one", Buffer.alloc(0));
    assert.throws(() => intentStore.put("run-2", "two", Buffer.alloc(0)), expectCode("quota_exceeded"));
    counts(intentStore, { blobs: 1, references: 1, intents: 0, bytes: 0 });
  } finally {
    intentStore.close();
    cleanup(intentRoot);
  }
});

test("backup lock survives process crash, rejects live owners, and cleans abandoned staging", () => {
  const root = scratch("backup-lock-");
  const outputRoot = scratch("backup-lock-output-");
  const firstDestination = path.join(outputRoot, "after-database");
  let liveMutex;
  try {
    const seed = new DurableArtifactStore(root);
    seed.put("run", "result", Buffer.from("payload"));
    seed.close();
    const crashed = crashFixture(["backup-crash", root, firstDestination, "after_backup_database"]);
    assert.equal(crashed.status, 86, crashed.stderr);
    assert.equal(existsSync(path.join(root, ".artifact-backup.lock")), true);
    assert.ok(readdirSync(outputRoot).some((name) => name.endsWith(".tmp")));

    const reopened = new DurableArtifactStore(root);
    const recoveredBackup = reopened.backup(firstDestination);
    DurableArtifactStore.verifyBackup(recoveredBackup);
    assert.deepEqual(readdirSync(outputRoot), ["after-database"]);

    const lockPath = path.join(root, ".artifact-backup.lock");
    liveMutex = new DatabaseSync(path.join(root, ".artifact-backup-mutex.sqlite3"));
    liveMutex.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    const liveLockDocument = JSON.stringify({
      schemaVersion: 1,
      token: randomUUID(),
      pid: process.pid,
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    writeFileSync(lockPath, liveLockDocument, { flag: "wx", flush: true });
    const blockedBackup = path.join(outputRoot, "blocked-by-live-owner");
    assert.throws(() => reopened.backup(blockedBackup), expectCode("operation_in_progress"));
    assert.equal(readFileSync(lockPath, "utf8"), liveLockDocument);
    assert.equal(existsSync(blockedBackup), false);
    assert.throws(() => reopened.put("blocked", "blocked", Buffer.from("x")), expectCode("operation_in_progress"));
    liveMutex.exec("ROLLBACK");
    liveMutex.close();
    liveMutex = undefined;
    reopened.put("allowed", "allowed", Buffer.from("x"));
    assert.equal(existsSync(lockPath), false);
    reopened.close();

    const publishedDestination = path.join(outputRoot, "published");
    const publishedCrash = crashFixture(["backup-crash", root, publishedDestination, "after_backup_publish"]);
    assert.equal(publishedCrash.status, 86, publishedCrash.stderr);
    DurableArtifactStore.verifyBackup(backupFromBundle(publishedDestination));
    const afterPublishedCrash = new DurableArtifactStore(root);
    afterPublishedCrash.put("after-crash", "after-crash", Buffer.from("y"));
    afterPublishedCrash.close();
    assert.equal(existsSync(path.join(root, ".artifact-backup.lock")), false);
  } finally {
    if (liveMutex) {
      try { liveMutex.exec("ROLLBACK"); } catch { /* best effort */ }
      try { liveMutex.close(); } catch { /* best effort */ }
    }
    cleanup(root);
    cleanup(outputRoot);
  }
});

test("reader-held WAL snapshots report busy checkpoints while committed data remains recoverable", () => {
  const root = scratch("wal-reader-");
  const store = new DurableArtifactStore(root, { quota: quota({ maximumDatabaseBytes: 512 * 1024 }) });
  const reader = openDatabase(root);
  try {
    reader.exec("PRAGMA journal_mode = WAL; BEGIN");
    reader.prepare("SELECT COUNT(*) AS value FROM artifact_blobs").get();
    assert.throws(
      () => store.put("run", "result", Buffer.from("payload")),
      expectCode("operation_in_progress"),
    );
    reader.exec("ROLLBACK");
    store.checkpoint();
    counts(store, { blobs: 1, references: 1, intents: 0, bytes: 7 });
    assert.ok(databaseFootprint(root) <= 512 * 1024);
  } finally {
    try { reader.exec("ROLLBACK"); } catch { /* already closed transaction */ }
    reader.close();
    store.close();
    cleanup(root);
  }
});

test("manifest tampering, missing files, and extra blobs fail backup verification", () => {
  const root = scratch("manifest-source-");
  const outputRoot = scratch("manifest-output-");
  const store = new DurableArtifactStore(root);
  try {
    store.put("run", "result", Buffer.from("payload"));
    const tampered = store.backup(path.join(outputRoot, "tampered"));
    const manifest = JSON.parse(readFileSync(tampered.manifestPath, "utf8"));
    manifest.unexpected = true;
    writeFileSync(tampered.manifestPath, JSON.stringify(manifest));
    assert.throws(() => DurableArtifactStore.verifyBackup(tampered), expectCode("integrity_failed"));

    const missingManifest = store.backup(path.join(outputRoot, "missing-manifest"));
    cleanup(missingManifest.manifestPath);
    assert.throws(() => DurableArtifactStore.verifyBackup(missingManifest), expectCode("integrity_failed"));

    const extraBlob = store.backup(path.join(outputRoot, "extra-blob"));
    const extraPath = path.join(extraBlob.blobDirectory, "ff", "extra");
    mkdirSync(path.dirname(extraPath), { recursive: true });
    writeFileSync(extraPath, "extra");
    assert.throws(() => DurableArtifactStore.verifyBackup(extraBlob), expectCode("integrity_failed"));

    const missingBlob = store.backup(path.join(outputRoot, "missing-blob"));
    cleanup(path.join(missingBlob.blobDirectory, missingBlob.blobs[0].relativePath));
    assert.throws(() => DurableArtifactStore.verifyBackup(missingBlob), expectCode("integrity_failed"));
  } finally {
    store.close();
    cleanup(root);
    cleanup(outputRoot);
  }
});

test("live verification rejects schema, foreign-key, and durable metadata tampering", () => {
  const schemaRoot = scratch("schema-tamper-");
  try {
    new DurableArtifactStore(schemaRoot).close();
    const database = openDatabase(schemaRoot);
    try { database.exec("DROP INDEX artifact_references_run_idx"); } finally { database.close(); }
    assert.throws(() => new DurableArtifactStore(schemaRoot), expectCode("integrity_failed"));
  } finally { cleanup(schemaRoot); }

  const foreignKeyRoot = scratch("fk-tamper-");
  try {
    new DurableArtifactStore(foreignKeyRoot).close();
    const database = openDatabase(foreignKeyRoot);
    try {
      database.exec("PRAGMA foreign_keys = OFF");
      database.prepare(`
        INSERT INTO artifact_references (id, run_id, content_hash, label, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), "run", "0".repeat(64), "missing", new Date().toISOString());
    } finally { database.close(); }
    assert.throws(() => new DurableArtifactStore(foreignKeyRoot), expectCode("integrity_failed"));
  } finally { cleanup(foreignKeyRoot); }

  const metadataRoot = scratch("metadata-tamper-");
  const metadataQuota = quota({ maximumMetadataBytes: 500 });
  try {
    const store = new DurableArtifactStore(metadataRoot, { quota: metadataQuota });
    const artifact = store.put("run-1", "one", Buffer.alloc(0));
    store.close();
    const database = openDatabase(metadataRoot);
    try {
      for (let index = 2; index <= 3; index += 1) {
        database.prepare(`
          INSERT INTO artifact_references (id, run_id, content_hash, label, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(randomUUID(), `run-${index}`, artifact.contentHash, `label-${index}`, new Date().toISOString());
      }
    } finally { database.close(); }
    assert.throws(
      () => new DurableArtifactStore(metadataRoot, { quota: metadataQuota }),
      expectCode("quota_exceeded"),
    );
  } finally { cleanup(metadataRoot); }
});

test("nearest existing ancestors, mixed device paths, and stale staging remain contained", () => {
  const external = scratch("ancestor-external-");
  const junction = `${external}-junction`;
  try {
    symlinkSync(external, junction, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => new DurableArtifactStore(path.join(junction, "missing", "store")),
      expectCode("containment_failed"),
    );
    for (const candidate of ["\\\\?\\C:\\artifact-device", "//server\\share/artifacts", "\\??\\C:\\artifact-device"]) {
      assert.throws(() => new DurableArtifactStore(candidate), expectCode("containment_failed"));
    }
  } finally {
    if (existsSync(junction)) rmSync(junction, { recursive: true, force: true });
    cleanup(external);
  }

  const root = scratch("staging-source-");
  const outputRoot = scratch("staging-output-");
  const restoreParent = scratch("staging-restore-");
  const store = new DurableArtifactStore(root);
  let activeBackupOwner;
  let activeRestoreOwner;
  try {
    store.put("run", "result", Buffer.from("payload"));
    const destination = path.join(outputRoot, "bundle");
    const staleBackup = path.join(outputRoot, ".bundle.dead.tmp");
    mkdirSync(staleBackup);
    new DatabaseSync(`${staleBackup}.owner.sqlite3`).close();
    utimesSync(staleBackup, new Date(0), new Date(0));
    const orphanBackupOwner = path.join(outputRoot, ".bundle.orphan.tmp.owner.sqlite3");
    new DatabaseSync(orphanBackupOwner).close();
    const activeBackup = path.join(outputRoot, ".bundle.active.tmp");
    mkdirSync(activeBackup);
    activeBackupOwner = new DatabaseSync(`${activeBackup}.owner.sqlite3`);
    activeBackupOwner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    const backup = store.backup(destination);
    assert.equal(existsSync(staleBackup), false);
    assert.equal(existsSync(`${staleBackup}.owner.sqlite3`), false);
    assert.equal(existsSync(orphanBackupOwner), false);
    assert.equal(existsSync(activeBackup), true);
    assert.equal(existsSync(`${activeBackup}.owner.sqlite3`), true);

    const restoreDestination = path.join(restoreParent, "restore-target");
    const staleRestore = path.join(restoreParent, ".restore-target.dead.restore");
    mkdirSync(staleRestore);
    new DatabaseSync(`${staleRestore}.owner.sqlite3`).close();
    utimesSync(staleRestore, new Date(0), new Date(0));
    const orphanRestoreOwner = path.join(
      restoreParent, ".restore-target.orphan.restore.owner.sqlite3",
    );
    new DatabaseSync(orphanRestoreOwner).close();
    utimesSync(orphanRestoreOwner, new Date(0), new Date(0));
    const activeRestore = path.join(restoreParent, ".restore-target.active.restore");
    mkdirSync(activeRestore);
    utimesSync(activeRestore, new Date(0), new Date(0));
    activeRestoreOwner = new DatabaseSync(`${activeRestore}.owner.sqlite3`);
    activeRestoreOwner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    DurableArtifactStore.restoreBackup(backup, restoreDestination);
    assert.equal(existsSync(staleRestore), false);
    assert.equal(existsSync(`${staleRestore}.owner.sqlite3`), false);
    assert.equal(existsSync(orphanRestoreOwner), false);
    assert.equal(existsSync(activeRestore), true);
    assert.equal(existsSync(`${activeRestore}.owner.sqlite3`), true);
  } finally {
    if (activeBackupOwner) {
      try { activeBackupOwner.exec("ROLLBACK"); } catch { /* best effort */ }
      try { activeBackupOwner.close(); } catch { /* best effort */ }
    }
    if (activeRestoreOwner) {
      try { activeRestoreOwner.exec("ROLLBACK"); } catch { /* best effort */ }
      try { activeRestoreOwner.close(); } catch { /* best effort */ }
    }
    store.close();
    cleanup(root);
    cleanup(outputRoot);
    cleanup(restoreParent);
  }
});

test("ENOSPC taxonomy is consistent across backup manifest and restore copy boundaries", async (context) => {
  const root = scratch("enospc-source-");
  const outputRoot = scratch("enospc-output-");
  const seed = new DurableArtifactStore(root);
  seed.put("run", "result", Buffer.from("payload"));
  seed.close();
  try {
    const backupPoints = [
      "after_backup_lock_acquired", "after_backup_database", "after_backup_blob_copy",
      "before_backup_manifest", "after_backup_manifest", "after_backup_publish",
    ];
    for (const point of backupPoints) {
      await context.test(`backup:${point}`, () => {
        const destination = path.join(outputRoot, `backup-${point}`);
        let fired = false;
        const store = new DurableArtifactStore(root, {
          faultInjector(current) {
            if (!fired && current === point) {
              fired = true;
              const error = new Error(`ENOSPC:${point}`);
              error.code = "ENOSPC";
              throw error;
            }
          },
        });
        try { assert.throws(() => store.backup(destination), expectCode("disk_write_failed")); }
        finally { store.close(); }
        assert.equal(existsSync(destination), false);
        assert.equal(existsSync(path.join(root, ".artifact-backup.lock")), false);
      });
    }

    const source = new DurableArtifactStore(root);
    const backup = source.backup(path.join(outputRoot, "valid"));
    source.close();
    const restorePoints = [
      "after_restore_database_copy", "after_restore_blob_copy",
      "before_restore_manifest_copy", "after_restore_manifest_copy",
    ];
    for (const point of restorePoints) {
      await context.test(`restore:${point}`, () => {
        const destination = path.join(outputRoot, `restore-${point}`);
        let fired = false;
        assert.throws(() => DurableArtifactStore.restoreBackup(backup, destination, (current) => {
          if (!fired && current === point) {
            fired = true;
            const error = new Error(`ENOSPC:${point}`);
            error.code = "ENOSPC";
            throw error;
          }
        }), expectCode("disk_write_failed"));
        assert.equal(existsSync(destination), false);
      });
    }
  } finally {
    cleanup(root);
    cleanup(outputRoot);
  }
});

test("ENOSPC taxonomy covers database open, database close, and external parent setup", () => {
  const diskFull = (label) => {
    const error = new Error(`ENOSPC:${label}`);
    error.code = "ENOSPC";
    return error;
  };

  const openRoot = scratch("enospc-open-");
  try {
    assert.throws(() => new DurableArtifactStore(openRoot, {
      faultInjector(point) {
        if (point === "before_database_open") throw diskFull(point);
      },
    }), expectCode("disk_write_failed"));
  } finally { cleanup(openRoot); }

  const closeRoot = scratch("enospc-close-");
  const closeStore = new DurableArtifactStore(closeRoot, {
    faultInjector(point) {
      if (point === "before_database_close") throw diskFull(point);
    },
  });
  try {
    assert.throws(() => closeStore.close(), expectCode("disk_write_failed"));
  } finally {
    try { closeStore.close(); } catch { /* already closed */ }
    cleanup(closeRoot);
  }

  const backupRoot = scratch("enospc-parent-source-");
  const backupParent = scratch("enospc-parent-output-");
  const backupStore = new DurableArtifactStore(backupRoot, {
    faultInjector(point) {
      if (point === "before_backup_parent_open") throw diskFull(point);
    },
  });
  try {
    backupStore.put("run", "result", Buffer.from("payload"));
    assert.throws(
      () => backupStore.backup(path.join(backupParent, "backup")),
      expectCode("disk_write_failed"),
    );
  } finally {
    backupStore.close();
    cleanup(backupRoot);
    cleanup(backupParent);
  }

  const restoreSource = scratch("enospc-restore-source-");
  const restoreBackupParent = scratch("enospc-restore-backup-");
  const restoreParent = scratch("enospc-restore-parent-");
  const restoreStore = new DurableArtifactStore(restoreSource);
  try {
    restoreStore.put("run", "result", Buffer.from("payload"));
    const backup = restoreStore.backup(path.join(restoreBackupParent, "backup"));
    assert.throws(() => DurableArtifactStore.restoreBackup(
      backup,
      path.join(restoreParent, "restored"),
      (point) => {
        if (point === "before_restore_parent_open") throw diskFull(point);
      },
    ), expectCode("disk_write_failed"));
  } finally {
    restoreStore.close();
    cleanup(restoreSource);
    cleanup(restoreBackupParent);
    cleanup(restoreParent);
  }
});

test("real GC process exits recover transaction, ledger, and file-delete boundaries", async (context) => {
  for (const point of ["after_gc_intent_insert", "after_gc_ledger_commit", "after_gc_file_delete"]) {
    await context.test(point, () => {
      const root = scratch(`gc-process-${point}-`);
      try {
        const store = new DurableArtifactStore(root);
        store.put("run", "result", Buffer.from("payload"));
        store.close();
        const database = openDatabase(root);
        try { database.exec("DELETE FROM artifact_references"); } finally { database.close(); }
        const crashed = crashFixture(["gc-crash", root, point]);
        assert.equal(crashed.status, 86, crashed.stderr);
        const reopened = new DurableArtifactStore(root);
        try {
          if (point === "after_gc_intent_insert") {
            counts(reopened, { blobs: 1, references: 0, intents: 0, bytes: 7 });
            assert.equal(reopened.garbageCollect(), 1);
          }
          counts(reopened, { blobs: 0, references: 0, intents: 0, bytes: 0 });
        } finally { reopened.close(); }
      } finally { cleanup(root); }
    });
  }
});
