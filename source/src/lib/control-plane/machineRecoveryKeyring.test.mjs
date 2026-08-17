import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { spawn } from "node:child_process";
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

const machineRecoveryKeyringModule = await import("./machineRecoveryKeyring.ts");
const { loadOrCreateMachineRecoveryKeyring } = machineRecoveryKeyringModule;
const { captureWindowsJobLauncherIdentitySync } = await import("./windowsJobProcess.ts");

function scratch() {
  const root = path.resolve(sourceRoot, ".next", "machine-recovery-keyring-tests");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, "case-"));
}

function recoveryKeyId(secret) {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update("agent-os/windows-job-recovery/key-id/v1", "utf8")
    .digest("hex");
}

function deriveLegacyBootstrapRecoverySecret(bootstrapSecret) {
  if (typeof bootstrapSecret !== "string" || bootstrapSecret.length < 32) return null;
  return createHash("sha256")
    .update("agent-os:wave3:windows-job-recovery\0", "utf8")
    .update(bootstrapSecret, "utf8")
    .digest("base64url");
}

function bootstrapRecoveryKeyId(bootstrapSecret) {
  const legacySecret = deriveLegacyBootstrapRecoverySecret(bootstrapSecret);
  assert.ok(legacySecret);
  return recoveryKeyId(legacySecret);
}

function assertTextExcludesSecrets(text, secrets) {
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false);
  }
}

function runFixture(directory, bootstrapSecret, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", path.join(sourceRoot, "src", "lib", "control-plane", "machineRecoveryKeyring.fixture.mjs")],
      {
        cwd: sourceRoot,
        env: {
          ...process.env,
          AGENT_OS_TEST_KEYRING_DIRECTORY: directory,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`Keyring fixture failed (${code}): ${stderr}`));
      else resolve({ ...JSON.parse(stdout), rawOutput: stdout });
    });
    child.stdin.end(JSON.stringify({
      bootstrapSecret,
      sentinel: options.sentinel,
    }));
  });
}

function runPowerShell(scriptPath, request, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const launcher = captureWindowsJobLauncherIdentitySync();
    const child = spawn(
      launcher.powershellPath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath],
      {
        cwd: sourceRoot,
        env: {
          NODE_ENV: "test",
          SystemRoot: process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
          WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
          ...extraEnvironment,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(request));
  });
}

async function runStorageFixture(storagePath, request) {
  const result = await runPowerShell(
    path.join(sourceRoot, "src", "lib", "control-plane", "machineRecoveryKeyring.storage.fixture.ps1"),
    { schemaVersion: 1, ...request },
    { AGENT_OS_TEST_KEYRING_STORAGE_PATH: storagePath },
  );
  if (result.code !== 0) {
    throw new Error(`Keyring storage fixture failed (${result.code}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function runRawKeyringHelper(directory, bootstrapSecret, failpoint) {
  const legacySecret = deriveLegacyBootstrapRecoverySecret(bootstrapSecret);
  assert.ok(legacySecret);
  return runPowerShell(
    path.join(sourceRoot, "src", "lib", "control-plane", "machineRecoveryKeyring.ps1"),
    { schemaVersion: 2, legacySecret },
    {
      AGENT_OS_MACHINE_KEYRING_DIRECTORY: directory,
      AGENT_OS_MACHINE_KEYRING_TEST_FAILPOINT: failpoint,
    },
  );
}

test("production keyring module exposes no test-only API", () => {
  assert.deepEqual(
    Object.keys(machineRecoveryKeyringModule).filter((name) => /ForTest$/u.test(name)),
    [],
  );
});

test("DPAPI keyring survives restart and preserves every bootstrap recovery key monotonically", { skip: process.platform !== "win32" }, async () => {
  const directory = path.join(scratch(), "keyring");
  const bootstraps = Array.from({ length: 3 }, () => randomBytes(32).toString("base64url"));
  const first = await runFixture(directory, bootstraps[0]);
  const second = await runFixture(directory, bootstraps[1]);
  const third = await runFixture(directory, bootstraps[2]);
  assert.equal(second.primaryId, first.primaryId);
  assert.equal(third.primaryId, first.primaryId);
  assert.deepEqual(
    bootstraps.map(bootstrapRecoveryKeyId).sort(),
    third.recoveryKeyIds.filter((keyId) => bootstraps.map(bootstrapRecoveryKeyId).includes(keyId)).sort(),
  );
  assert.equal(third.candidateCount, 4);
  const ciphertext = readFileSync(third.storagePath);
  for (const bootstrap of bootstraps) {
    assert.equal(ciphertext.includes(Buffer.from(bootstrap, "utf8")), false);
    assert.equal(ciphertext.includes(Buffer.from(deriveLegacyBootstrapRecoverySecret(bootstrap), "utf8")), false);
  }
});

test("distinct-bootstrap concurrent processes preserve every key behind one cross-session file lock", { skip: process.platform !== "win32" }, async () => {
  const directory = path.join(scratch(), "keyring");
  const bootstraps = Array.from({ length: 8 }, () => randomBytes(32).toString("base64url"));
  const results = await Promise.all(bootstraps.map((bootstrap) => runFixture(directory, bootstrap)));
  assert.equal(new Set(results.map((result) => result.primaryId)).size, 1);
  const final = await runFixture(directory, bootstraps[0]);
  assert.equal(final.primaryId, results[0].primaryId);
  assert.equal(final.candidateCount, bootstraps.length + 1);
  assert.deepEqual(
    final.recoveryKeyIds.filter((keyId) => bootstraps.map(bootstrapRecoveryKeyId).includes(keyId)).sort(),
    bootstraps.map(bootstrapRecoveryKeyId).sort(),
  );
});

test("corrupt or path-copied DPAPI keyring fails closed", { skip: process.platform !== "win32" }, () => {
  const base = scratch();
  const originalDirectory = path.join(base, "original");
  const copiedDirectory = path.join(base, "copied");
  const bootstrap = randomBytes(32).toString("base64url");
  const original = loadOrCreateMachineRecoveryKeyring({ directory: originalDirectory, bootstrapSecret: bootstrap });
  const copied = loadOrCreateMachineRecoveryKeyring({ directory: copiedDirectory, bootstrapSecret: bootstrap });
  copyFileSync(original.storagePath, copied.storagePath);
  assert.throws(
    () => loadOrCreateMachineRecoveryKeyring({ directory: copiedDirectory, bootstrapSecret: bootstrap }),
    /could not be loaded securely/u,
  );
  writeFileSync(original.storagePath, randomBytes(64));
  assert.throws(
    () => loadOrCreateMachineRecoveryKeyring({ directory: originalDirectory, bootstrapSecret: bootstrap }),
    /could not be loaded securely/u,
  );
});

test("reparse-backed keyring directory is rejected", { skip: process.platform !== "win32" }, () => {
  const base = scratch();
  const target = path.join(base, "target");
  const junction = path.join(base, "junction");
  mkdirSync(target);
  symlinkSync(target, junction, "junction");
  try {
    assert.throws(
      () => loadOrCreateMachineRecoveryKeyring({
        directory: junction,
        bootstrapSecret: randomBytes(32).toString("base64url"),
      }),
      /could not be loaded securely/u,
    );
  } finally {
    unlinkSync(junction);
  }
});

test("real DPAPI schema 1 migrates to schema 2 across both atomic-replace crash boundaries", { skip: process.platform !== "win32" }, async () => {
  const directory = path.join(scratch(), "keyring");
  const warmBootstrap = randomBytes(32).toString("base64url");
  const warm = await runFixture(directory, warmBootstrap);
  const primarySecret = randomBytes(32).toString("base64url");
  const bootstrapA = randomBytes(32).toString("base64url");
  const bootstrapB = randomBytes(32).toString("base64url");
  const legacyA = deriveLegacyBootstrapRecoverySecret(bootstrapA);
  const legacyB = deriveLegacyBootstrapRecoverySecret(bootstrapB);
  assert.ok(legacyA);
  assert.ok(legacyB);
  const now = new Date().toISOString();
  await runStorageFixture(warm.storagePath, {
    action: "seed-v1",
    primarySecret,
    legacySecrets: [legacyA],
    createdAt: now,
    updatedAt: now,
  });
  const seeded = await runStorageFixture(warm.storagePath, { action: "inspect" });
  assert.equal(seeded.schemaVersion, 1);
  assert.equal(seeded.primaryKeyId, recoveryKeyId(primarySecret));
  assert.deepEqual(seeded.keyIds, [recoveryKeyId(primarySecret), recoveryKeyId(legacyA)].sort());

  const beforeReplaceCrash = await runRawKeyringHelper(directory, bootstrapB, "after-temp-flush");
  assert.notEqual(beforeReplaceCrash.code, 0);
  assertTextExcludesSecrets(
    `${beforeReplaceCrash.stdout}\n${beforeReplaceCrash.stderr}`,
    [primarySecret, bootstrapA, bootstrapB, legacyA, legacyB],
  );
  const afterBeforeReplaceCrash = await runStorageFixture(warm.storagePath, { action: "inspect" });
  assert.equal(afterBeforeReplaceCrash.schemaVersion, 1);
  assert.equal(afterBeforeReplaceCrash.ciphertextSha256, seeded.ciphertextSha256);
  assert.deepEqual(afterBeforeReplaceCrash.keyIds, seeded.keyIds);

  const afterReplaceCrash = await runRawKeyringHelper(directory, bootstrapB, "after-replace");
  assert.notEqual(afterReplaceCrash.code, 0);
  assertTextExcludesSecrets(
    `${afterReplaceCrash.stdout}\n${afterReplaceCrash.stderr}`,
    [primarySecret, bootstrapA, bootstrapB, legacyA, legacyB],
  );
  const migratedAfterCrash = await runStorageFixture(warm.storagePath, { action: "inspect" });
  assert.equal(migratedAfterCrash.schemaVersion, 2);
  assert.equal(migratedAfterCrash.primaryKeyId, recoveryKeyId(primarySecret));
  assert.deepEqual(
    migratedAfterCrash.keyIds,
    [recoveryKeyId(primarySecret), recoveryKeyId(legacyA), recoveryKeyId(legacyB)].sort(),
  );

  const restarted = await runFixture(directory, bootstrapB);
  assert.ok(restarted.recoveryKeyIds.includes(recoveryKeyId(primarySecret)));
  assert.ok(restarted.recoveryKeyIds.includes(recoveryKeyId(legacyA)));
  assert.ok(restarted.recoveryKeyIds.includes(recoveryKeyId(legacyB)));
});

test("schema 2 monotonic growth fails closed at payload cap without replacing schema 1", { skip: process.platform !== "win32" }, async () => {
  const directory = path.join(scratch(), "keyring");
  const warm = await runFixture(directory, randomBytes(32).toString("base64url"));
  const primarySecret = randomBytes(32).toString("base64url");
  const legacySecrets = Array.from(
    { length: 4_000 },
    (_, index) => `legacy-cap-${index.toString().padStart(4, "0")}-${"x".repeat(32)}`,
  );
  const now = new Date().toISOString();
  await runStorageFixture(warm.storagePath, {
    action: "seed-v1",
    primarySecret,
    legacySecrets,
    createdAt: now,
    updatedAt: now,
  });
  const seeded = await runStorageFixture(warm.storagePath, { action: "inspect" });
  assert.equal(seeded.schemaVersion, 1);
  await assert.rejects(
    runFixture(directory, randomBytes(32).toString("base64url")),
    /could not be loaded securely/u,
  );
  const preserved = await runStorageFixture(warm.storagePath, { action: "inspect" });
  assert.equal(preserved.schemaVersion, 1);
  assert.equal(preserved.ciphertextSha256, seeded.ciphertextSha256);
  assert.deepEqual(preserved.keyIds, seeded.keyIds);
});

test("bootstrap and derived sentinels stay outside argv, environment, errors, storage, and fixture output", { skip: process.platform !== "win32" }, async () => {
  const directory = path.join(scratch(), "keyring");
  const sentinel = `bootstrap-sentinel-${randomBytes(32).toString("base64url")}`;
  const derivedSentinel = deriveLegacyBootstrapRecoverySecret(sentinel);
  assert.ok(derivedSentinel);
  const result = await runFixture(directory, sentinel, { sentinel });
  assert.equal(result.argvContainsSentinel, false);
  assert.equal(result.environmentContainsSentinel, false);
  assert.equal(result.argvContainsDerivedSentinel, false);
  assert.equal(result.environmentContainsDerivedSentinel, false);
  assertTextExcludesSecrets(result.rawOutput, [sentinel, derivedSentinel]);
  const ciphertext = readFileSync(result.storagePath);
  assert.equal(ciphertext.includes(Buffer.from(sentinel, "utf8")), false);
  assert.equal(ciphertext.includes(Buffer.from(derivedSentinel, "utf8")), false);

  writeFileSync(result.storagePath, randomBytes(64));
  await assert.rejects(
    runFixture(directory, sentinel, { sentinel }),
    (error) => {
      const message = String(error);
      assertTextExcludesSecrets(message, [sentinel, derivedSentinel]);
      return /could not be loaded securely/u.test(message);
    },
  );
});
