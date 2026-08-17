import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, hkdfSync, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertWindowsJobLauncherIdentityBindingSync,
  captureWindowsJobLauncherIdentitySync,
  cleanupWindowsJobRecoveryArtifactsVerified,
  isWindowsJobControllerForceAllowed,
  isWindowsJobStoppingDeadlineActive,
  prepareWindowsJobRecoveryDescriptor,
  recoverWindowsJobProcess,
  resolveWindowsJobRecoveryDescriptorPath,
  spawnWindowsJobProcess,
  WindowsJobContainmentError,
} from "./windowsJobProcess.ts";

const RECOVERY_SECRET = "agent-os-recovery-test-sentinel-secret-0123456789";
const CONCURRENT_RECOVERY_FIXTURE = fileURLToPath(
  new URL("./windowsJobProcess.concurrent.fixture.mjs", import.meta.url),
);
const JOURNAL_LOCK_FIXTURE = fileURLToPath(
  new URL("./windowsJobProcess.journalLock.fixture.ps1", import.meta.url),
);
const JOURNAL_CONFLICT_FIXTURE = fileURLToPath(
  new URL("./windowsJobProcess.journalConflict.fixture.ps1", import.meta.url),
);
const JOURNAL_COMMIT_RACE_FIXTURE = fileURLToPath(
  new URL("./windowsJobProcess.journalCommitRace.fixture.ps1", import.meta.url),
);

async function expectedFile(absolutePath, role = "configured") {
  const [bytes, information] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
  return {
    role,
    absolutePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: information.size,
  };
}

async function expectedWorkingDirectory(absolutePath) {
  const canonical = await realpath(absolutePath);
  const information = await stat(canonical);
  return {
    absolutePath: canonical,
    device: information.dev,
    inode: information.ino,
    modifiedMs: information.mtimeMs,
  };
}

async function pinnedWorkingDirectory(absolutePath) {
  const canonical = await realpath(absolutePath);
  const information = await stat(canonical, { bigint: true });
  return {
    absolutePath: canonical,
    device: Number(information.dev),
    inode: information.ino.toString(10),
    modifiedMs: Number(information.mtimeMs),
  };
}

async function launchEvidence(executable, cwd, expectedExecutableFiles) {
  return {
    expectedExecutableFiles: expectedExecutableFiles ?? [await expectedFile(executable)],
    expectedWorkingDirectory: await expectedWorkingDirectory(cwd),
  };
}

function recoveryAuthenticationKey(descriptor) {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(RECOVERY_SECRET, "utf8"),
    Buffer.from(descriptor.authenticationSaltBase64, "base64"),
    Buffer.from(`agent-os/windows-job-recovery/v1\0${descriptor.runId}\0${descriptor.jobId}`, "utf8"),
    32,
  ));
}

function signedEnvelope(descriptor, purpose, value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const hmacSha256 = createHmac("sha256", recoveryAuthenticationKey(descriptor))
    .update(purpose, "utf8")
    .update(Buffer.from([0]))
    .update(payload)
    .digest("hex");
  return {
    schemaVersion: 1,
    authenticationScheme: "hkdf-sha256+hmac-sha256",
    purpose,
    payloadBase64: payload.toString("base64"),
    hmacSha256,
  };
}

function signedStatusEnvelope(descriptor, status) {
  return signedEnvelope(descriptor, "status", status);
}

async function writeAuthenticatedStatusHistory(descriptor, statuses) {
  const envelopes = statuses.map((status) => signedStatusEnvelope(descriptor, status));
  await writeFile(
    descriptor.statusJournalPath,
    `${envelopes.map((envelope) => JSON.stringify(envelope)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(descriptor.statusPath, JSON.stringify(envelopes.at(-1)), "utf8");
}

async function appendAuthenticatedStatus(descriptor, status) {
  const currentJournal = await readFile(descriptor.statusJournalPath);
  const lines = currentJournal.toString("utf8").trimEnd().split("\n");
  const previousEnvelope = JSON.parse(lines.at(-1));
  const previousStatus = signedEnvelopePayload(previousEnvelope);
  const next = {
    ...status,
    sequence: previousStatus.sequence + 1,
    previousSequence: previousStatus.sequence,
    previousSnapshotDigestSha256: createHash("sha256")
      .update(Buffer.from(previousEnvelope.payloadBase64, "base64"))
      .digest("hex"),
    previousJournalDigestSha256: createHash("sha256").update(currentJournal).digest("hex"),
  };
  const envelope = signedStatusEnvelope(descriptor, next);
  await writeFile(
    descriptor.statusJournalPath,
    Buffer.concat([currentJournal, Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8")]),
  );
  await writeFile(descriptor.statusPath, JSON.stringify(envelope), "utf8");
  return next;
}

function nativeTerminalDigestForTest(status) {
  const facts = {
    assignmentVerified: status.assignmentVerified === true,
    cleanup: status.cleanup,
    encryptedStderrBytes: status.encryptedStderrBytes,
    encryptedStderrDigestSha256: status.encryptedStderrDigestSha256,
    encryptedStdoutBytes: status.encryptedStdoutBytes,
    encryptedStdoutDigestSha256: status.encryptedStdoutDigestSha256,
    exitCode: status.exitCode ?? null,
    helperProcessId: status.helperProcessId ?? null,
    helperProcessStartedAtFileTime: status.helperProcessStartedAtFileTime ?? null,
    jobId: status.jobId,
    jobName: status.jobName ?? null,
    journalGeneration: status.journalGeneration,
    rootProcessId: status.rootProcessId ?? null,
    rootProcessStartedAtFileTime: status.rootProcessStartedAtFileTime ?? null,
    runId: status.runId,
    state: status.status,
    terminationVerified: status.terminationVerified,
  };
  if (status.terminationRequestedAt !== undefined) {
    facts.terminationDeadlineAt = status.terminationDeadlineAt ?? null;
    facts.terminationRequestedAt = status.terminationRequestedAt ?? null;
  }
  const canonical = Object.fromEntries(
    Object.entries(facts).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function signedEnvelopePayload(envelope) {
  return JSON.parse(Buffer.from(envelope.payloadBase64, "base64").toString("utf8"));
}

async function waitForJson(filePath, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    try { return JSON.parse(await readFile(filePath, "utf8")); }
    catch {
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for ${filePath}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function waitForJsonMatching(filePath, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    try {
      const value = JSON.parse(await readFile(filePath, "utf8"));
      if (predicate(value)) return value;
    } catch { }
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for matching ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForProcessExit(pid, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    try { process.kill(pid, 0); }
    catch { return; }
    if (Date.now() - started >= timeoutMs) throw new Error(`PID ${pid} remained alive`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function settleWithin(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function collectReadable(stream) {
  const chunks = [];
  for await (const raw of stream) chunks.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
  return Buffer.concat(chunks);
}

function captureChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("stopping deadline decision is fixed, fail-closed for legacy status, and exact at the boundary", () => {
  const deadlineAt = "2026-08-14T12:01:00.000Z";
  const deadlineMs = Date.parse(deadlineAt);
  assert.equal(isWindowsJobStoppingDeadlineActive({ status: "ready" }, deadlineMs + 1), true);
  assert.equal(isWindowsJobStoppingDeadlineActive({ status: "stopping" }, deadlineMs - 1), false);
  assert.equal(isWindowsJobStoppingDeadlineActive({ status: "stopping", terminationDeadlineAt: deadlineAt }, deadlineMs - 1), true);
  assert.equal(isWindowsJobStoppingDeadlineActive({ status: "stopping", terminationDeadlineAt: deadlineAt }, deadlineMs), false);
  assert.equal(isWindowsJobStoppingDeadlineActive({ status: "stopping", terminationDeadlineAt: deadlineAt }, deadlineMs + 1), false);
  assert.equal(isWindowsJobControllerForceAllowed({ status: "ready" }, deadlineMs - 1), true);
  assert.equal(isWindowsJobControllerForceAllowed({ status: "stopping" }, deadlineMs - 1), true);
  assert.equal(isWindowsJobControllerForceAllowed({ status: "stopping", terminationDeadlineAt: deadlineAt }, deadlineMs - 1), false);
  assert.equal(isWindowsJobControllerForceAllowed({ status: "stopping", terminationDeadlineAt: deadlineAt }, deadlineMs), true);
  assert.equal(isWindowsJobControllerForceAllowed({ status: "stopping", terminationDeadlineAt: deadlineAt }, deadlineMs + 1), true);
});

test("controller terminal claim completes after crash before journal append", { skip: process.platform !== "win32", timeout: 15_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-terminal-claim-${process.pid}-${Date.now()}`);
  const runId = `terminal-claim-run-${process.pid}-${Date.now()}`;
  const jobId = `terminal-claim-job-${process.pid}-${Date.now()}`;
  const emptyDigest = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  await mkdir(scratch, { recursive: true });
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    recoverySecret: RECOVERY_SECRET,
  });
  let recovered;
  try {
    const claimedTerminal = {
      schemaVersion: 2,
      sequence: 1,
      previousSequence: 0,
      previousSnapshotDigestSha256: "0".repeat(64),
      previousJournalDigestSha256: "0".repeat(64),
      journalGeneration: descriptor.journalGeneration,
      runId,
      jobId,
      status: "blocked",
      assignmentVerified: false,
      exitCode: null,
      cleanup: "no_process_created",
      terminationVerified: true,
      reason: "Recovered durable controller terminal claim.",
      encryptedStdoutBytes: 0,
      encryptedStdoutDigestSha256: emptyDigest,
      encryptedStderrBytes: 0,
      encryptedStderrDigestSha256: emptyDigest,
      nativeTerminalDigestSha256: null,
    };
    claimedTerminal.nativeTerminalDigestSha256 = nativeTerminalDigestForTest(claimedTerminal);
    await writeFile(
      path.join(descriptor.controlDirectory, "controller-terminal.claim.json"),
      JSON.stringify(signedEnvelope(descriptor, "controller-terminal-claim", claimedTerminal)),
      "utf8",
    );

    recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    assert.equal(recovered.status.status, "blocked");
    assert.deepEqual(await recovered.wait(), {
      status: "blocked",
      exitCode: null,
      cleanup: "no_process_created",
      terminationVerified: true,
      reason: "Recovered durable controller terminal claim.",
    });
    const journalLines = (await readFile(descriptor.statusJournalPath, "utf8")).trimEnd().split("\n");
    assert.equal(journalLines.length, 1);
    assert.deepEqual(signedEnvelopePayload(JSON.parse(journalLines[0])), claimedTerminal);
  } finally {
    if (recovered) await recovered.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Windows Job launcher identity pins built-in PowerShell and bundled helper bytes", { skip: process.platform !== "win32" }, () => {
  const identity = captureWindowsJobLauncherIdentitySync();
  assert.match(identity.powershellPath, /\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.match(identity.helperSha256, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => assertWindowsJobLauncherIdentityBindingSync(identity));
  assert.throws(
    () => assertWindowsJobLauncherIdentityBindingSync({ ...identity, helperSha256: "0".repeat(64) }),
    (error) => error instanceof WindowsJobContainmentError && error.code === "windows_job_launcher_changed",
  );
});

test("native launch fails closed when executable identity pinning is omitted", { skip: process.platform !== "win32" }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-missing-executable-${process.pid}-${Date.now()}`);
  const providerScript = path.join(scratch, "provider.mjs");
  await mkdir(scratch, { recursive: true });
  await writeFile(providerScript, "process.exit(0);\n", "utf8");
  try {
    await assert.rejects(
      spawnWindowsJobProcess(process.execPath, [providerScript], {
        runId: `missing-executable-run-${process.pid}-${Date.now()}`,
        jobId: `missing-executable-job-${process.pid}-${Date.now()}`,
        cwd: scratch,
        env: process.env,
        expectedWorkingDirectory: await expectedWorkingDirectory(scratch),
      }),
      (error) => error instanceof WindowsJobContainmentError
        && error.code === "windows_job_invalid_specification"
        && /expected executable identity is required/i.test(error.message),
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("native launch rejects replaced and reparse-backed working directories before process creation", { skip: process.platform !== "win32" }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-cwd-identity-${process.pid}-${Date.now()}`);
  const approvedPath = path.join(scratch, "approved");
  const movedPath = path.join(scratch, "moved");
  const providerScript = path.join(scratch, "provider.mjs");
  await mkdir(approvedPath, { recursive: true });
  await writeFile(providerScript, "process.exit(0);\n", "utf8");
  const evidence = await launchEvidence(process.execPath, approvedPath);
  const attempt = async (suffix) => spawnWindowsJobProcess(process.execPath, [providerScript], {
    runId: `cwd-${suffix}-run-${process.pid}-${Date.now()}`,
    jobId: `cwd-${suffix}-job-${process.pid}-${Date.now()}`,
    cwd: approvedPath,
    env: process.env,
    ...evidence,
  });
  try {
    await rename(approvedPath, movedPath);
    await mkdir(approvedPath);
    await assert.rejects(
      attempt("replacement"),
      (error) => error instanceof WindowsJobContainmentError
        && error.code === "windows_job_invalid_specification"
        && /working directory .*changed after approval/i.test(error.message),
    );

    await rm(approvedPath, { recursive: true, force: true });
    await symlink(movedPath, approvedPath, "junction");
    await assert.rejects(
      attempt("reparse"),
      (error) => error instanceof WindowsJobContainmentError
        && error.code === "windows_job_invalid_specification"
        && /working directory .*changed after approval/i.test(error.message),
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("spawn handshake proves assignment before returning and cancel verifies complete process-tree exit", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-test-${process.pid}-${Date.now()}`);
  const childScript = path.join(scratch, "root.mjs");
  const processFile = path.join(scratch, "processes.json");
  await mkdir(scratch, { recursive: true });
  await writeFile(
    childScript,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const [processFile] = process.argv.slice(2);',
      'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'writeFileSync(processFile, JSON.stringify({ root: process.pid, descendant: descendant.pid }));',
      'console.log("JOB_OUTPUT_READY");',
      'setInterval(() => {}, 1000);',
    ].join("\n"),
    "utf8",
  );

  let controller;
  try {
    controller = await spawnWindowsJobProcess(
      process.execPath,
      [childScript, processFile],
      {
        runId: `run-${process.pid}-${Date.now()}`,
        jobId: `job-${process.pid}-${Date.now()}`,
        cwd: scratch,
        env: process.env,
        ...(await launchEvidence(process.execPath, scratch)),
      },
    );
    let diagnostics = "";
    controller.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });
    assert.equal(controller.identity.assignmentVerified, true);
    assert.ok(controller.identity.rootProcessId > 0);
    assert.match(controller.identity.rootProcessStartedAtFileTime, /^\d+$/);
    assert.match(controller.identity.jobName, /^Local\\AgentOS-job-/);

    const pids = await waitForJson(processFile);
    assert.equal(pids.root, controller.identity.rootProcessId);
    assert.ok(pids.descendant > 0);
    assert.doesNotThrow(() => process.kill(pids.root, 0));
    assert.doesNotThrow(() => process.kill(pids.descendant, 0));

    const cancelled = await controller.cancel(15_000).catch((error) => {
      error.message = `${error.message}\n${diagnostics.slice(-4_000)}`;
      throw error;
    });
    assert.deepEqual(cancelled, {
      status: "cancelled",
      exitCode: null,
      cleanup: "active_process_zero",
      terminationVerified: true,
    });
    assert.deepEqual(await controller.cancel(15_000), cancelled);
    await waitForProcessExit(pids.root);
    await waitForProcessExit(pids.descendant);
  } finally {
    if (controller) {
      const result = await controller.cancel(15_000).catch(() => null);
      assert.ok(result === null || result.terminationVerified);
    }
    await rm(scratch, { recursive: true, force: true });
  }
});

test("natural completion is reported only with ACTIVE_PROCESS_ZERO", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-exit-${process.pid}-${Date.now()}`);
  const childScript = path.join(scratch, "exit.mjs");
  await mkdir(scratch, { recursive: true });
  await writeFile(childScript, 'process.stdout.write("natural-output\\n"); process.exit(7);\n', "utf8");
  try {
    const controller = await spawnWindowsJobProcess(
      process.execPath,
      [childScript],
      {
        runId: `natural-run-${process.pid}-${Date.now()}`,
        jobId: `natural-job-${process.pid}-${Date.now()}`,
        cwd: scratch,
        env: process.env,
        ...(await launchEvidence(process.execPath, scratch)),
      },
    );
    let stdout = "";
    controller.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    const result = await controller.wait();
    assert.deepEqual(result, {
      status: "exited",
      exitCode: 7,
      cleanup: "active_process_zero",
      terminationVerified: true,
    });
    assert.equal(stdout, "natural-output\n");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("wait and cleanupVerified complete without an attached output consumer above stream highWaterMark", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-unconsumed-output-${process.pid}-${Date.now()}`);
  const providerScript = path.join(scratch, "output.mjs");
  const runId = `unconsumed-output-run-${process.pid}-${Date.now()}`;
  const jobId = `unconsumed-output-job-${process.pid}-${Date.now()}`;
  const stdoutBytes = 96 * 1024;
  const stderrBytes = 96 * 1024;
  const outputLimitBytes = 256 * 1024;
  await mkdir(scratch, { recursive: true });
  await writeFile(
    providerScript,
    `process.stdout.write(Buffer.alloc(${stdoutBytes}, 0x6f)); process.stderr.write(Buffer.alloc(${stderrBytes}, 0x65));\n`,
    "utf8",
  );
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    outputLimitBytes,
    recoverySecret: RECOVERY_SECRET,
  });
  let controller;
  let recovered;
  try {
    controller = await spawnWindowsJobProcess(process.execPath, [providerScript], {
      runId,
      jobId,
      cwd: scratch,
      env: process.env,
      ...(await launchEvidence(process.execPath, scratch)),
      recoveryDescriptor: descriptor,
      recoverySecret: RECOVERY_SECRET,
      limits: {
        activeProcessLimit: 4,
        jobMemoryLimitBytes: 256 * 1024 * 1024,
        cpuTimeLimitMs: 30_000,
        outputLimitBytes,
      },
    });

    const directTerminal = await settleWithin(controller.wait(), 20_000, "direct wait without output consumer");
    recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    let passivelyObservedBytes = 0;
    const passiveListener = (chunk) => { passivelyObservedBytes += chunk.byteLength; };
    recovered.stdout.on("data", passiveListener).pause();
    recovered.stderr.on("data", passiveListener).pause();
    const recoveredTerminal = await settleWithin(recovered.wait(), 10_000, "recovered wait without output consumer");
    assert.deepEqual(recoveredTerminal, directTerminal);
    assert.equal(passivelyObservedBytes, 0);
    assert.ok(controller.stdout.readableLength + controller.stderr.readableLength <= outputLimitBytes);
    assert.ok(recovered.stdout.readableLength + recovered.stderr.readableLength <= outputLimitBytes);

    await settleWithin(controller.cleanupVerified(), 5_000, "direct cleanupVerified without output consumer");
    await settleWithin(recovered.cleanupVerified(), 5_000, "recovered cleanupVerified without output consumer");
    recovered.stdout.removeListener("data", passiveListener);
    recovered.stderr.removeListener("data", passiveListener);

    const [directStdout, directStderr, recoveredStdout, recoveredStderr] = await settleWithin(
      Promise.all([
        collectReadable(controller.stdout),
        collectReadable(controller.stderr),
        collectReadable(recovered.stdout),
        collectReadable(recovered.stderr),
      ]),
      5_000,
      "buffered output consumption after verified cleanup",
    );
    for (const output of [directStdout, recoveredStdout]) {
      assert.equal(output.byteLength, stdoutBytes);
      assert.ok(output.every((byte) => byte === 0x6f));
    }
    for (const output of [directStderr, recoveredStderr]) {
      assert.equal(output.byteLength, stderrBytes);
      assert.ok(output.every((byte) => byte === 0x65));
    }
  } finally {
    controller?.stdout.resume();
    controller?.stderr.resume();
    recovered?.stdout.resume();
    recovered?.stderr.resume();
    if (controller) await controller.cancel(5_000).catch(() => null);
    if (recovered) await recovered.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("expired stopping deadline survives restart, forces verified cleanup, and rejects timestamp extension", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-stopping-deadline-${process.pid}-${Date.now()}`);
  const providerScript = path.join(scratch, "provider.mjs");
  const runId = `stopping-deadline-run-${process.pid}-${Date.now()}`;
  const jobId = `stopping-deadline-job-${process.pid}-${Date.now()}`;
  const outputLimitBytes = 1024 * 1024;
  await mkdir(scratch, { recursive: true });
  await writeFile(providerScript, "setInterval(() => {}, 1000);\n", "utf8");
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    outputLimitBytes,
    recoverySecret: RECOVERY_SECRET,
  });
  let controller;
  let recovered;
  let originalJournal;
  let originalSnapshot;
  try {
    controller = await spawnWindowsJobProcess(process.execPath, [providerScript], {
      runId,
      jobId,
      cwd: scratch,
      env: process.env,
      ...(await launchEvidence(process.execPath, scratch)),
      recoveryDescriptor: descriptor,
      recoverySecret: RECOVERY_SECRET,
      limits: {
        activeProcessLimit: 4,
        jobMemoryLimitBytes: 256 * 1024 * 1024,
        cpuTimeLimitMs: 30_000,
        outputLimitBytes,
      },
    });
    const readyEnvelope = await waitForJsonMatching(
      descriptor.statusPath,
      (value) => signedEnvelopePayload(value).status === "ready",
      20_000,
    );
    const ready = signedEnvelopePayload(readyEnvelope);
    const requestedMs = Date.now() - 61_000;
    const terminationRequestedAt = new Date(requestedMs).toISOString();
    const terminationDeadlineAt = new Date(requestedMs + 60_000).toISOString();
    const stopping = await appendAuthenticatedStatus(descriptor, {
      ...ready,
      status: "stopping",
      exitCode: null,
      cleanup: "pending",
      terminationVerified: false,
      reason: "Injected stuck helper after a signed stopping deadline.",
      terminationRequestedAt,
      terminationDeadlineAt,
      encryptedStdoutBytes: null,
      encryptedStdoutDigestSha256: null,
      encryptedStderrBytes: null,
      encryptedStderrDigestSha256: null,
      nativeTerminalDigestSha256: null,
    });
    assert.equal(Date.parse(stopping.terminationDeadlineAt) - Date.parse(stopping.terminationRequestedAt), 60_000);

    recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    const restarted = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    assert.equal(recovered.status.status, "stopping");
    assert.equal(restarted.status.status, "stopping");
    assert.equal(recovered.status.terminationRequestedAt, terminationRequestedAt);
    assert.equal(recovered.status.terminationDeadlineAt, terminationDeadlineAt);
    assert.equal(restarted.status.terminationRequestedAt, terminationRequestedAt);
    assert.equal(restarted.status.terminationDeadlineAt, terminationDeadlineAt);

    const waiting = recovered.wait();
    const restartedWaiting = restarted.wait();
    assert.equal(await Promise.race([
      waiting.then(() => "terminal"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]), "pending");
    const [terminal, restartedTerminal] = await Promise.all([waiting, restartedWaiting]);
    assert.deepEqual(restartedTerminal, terminal);
    assert.equal(terminal.status, "blocked");
    assert.equal(terminal.cleanup, "active_process_zero");
    assert.equal(terminal.terminationVerified, true);
    assert.match(terminal.reason, /watchdog/iu);
    await waitForProcessExit(controller.identity.rootProcessId);
    await waitForProcessExit(controller.identity.helperProcessId);

    originalJournal = await readFile(descriptor.statusJournalPath);
    originalSnapshot = await readFile(descriptor.statusPath);
    const terminalLines = originalJournal.toString("utf8").trimEnd().split("\n");
    assert.equal(terminalLines.length, 4);
    const controlEntries = await readdir(descriptor.controlDirectory);
    assert.ok(controlEntries.includes("controller-terminal.claim.json"));
    assert.equal(controlEntries.some((entry) => /^\.controller-terminal-(?:claim|journal)\..+\.tmp$/u.test(entry)), false);
    const terminalStatus = signedEnvelopePayload(JSON.parse(terminalLines.at(-1)));
    assert.equal(terminalStatus.terminationRequestedAt, terminationRequestedAt);
    assert.equal(terminalStatus.terminationDeadlineAt, terminationDeadlineAt);

    const shiftedRequestedAt = new Date(Date.parse(terminationRequestedAt) + 1_000).toISOString();
    const shiftedDeadlineAt = new Date(Date.parse(terminationDeadlineAt) + 1_000).toISOString();
    const tamperedTerminal = {
      ...terminalStatus,
      terminationRequestedAt: shiftedRequestedAt,
      terminationDeadlineAt: shiftedDeadlineAt,
      nativeTerminalDigestSha256: null,
    };
    tamperedTerminal.nativeTerminalDigestSha256 = nativeTerminalDigestForTest(tamperedTerminal);
    const tamperedEnvelope = signedStatusEnvelope(descriptor, tamperedTerminal);
    await writeFile(
      descriptor.statusJournalPath,
      `${[...terminalLines.slice(0, -1), JSON.stringify(tamperedEnvelope)].join("\n")}\n`,
      "utf8",
    );
    await writeFile(descriptor.statusPath, JSON.stringify(tamperedEnvelope), "utf8");
    await assert.rejects(
      recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET),
      (error) => error instanceof WindowsJobContainmentError && error.code === "windows_job_protocol_invalid",
    );
    await writeFile(descriptor.statusJournalPath, originalJournal);
    await writeFile(descriptor.statusPath, originalSnapshot);
    assert.deepEqual(await controller.wait(), terminal);
  } finally {
    if (originalJournal && originalSnapshot) {
      await writeFile(descriptor.statusJournalPath, originalJournal).catch(() => null);
      await writeFile(descriptor.statusPath, originalSnapshot).catch(() => null);
    }
    if (controller) await controller.cancel(5_000).catch(() => null);
    if (recovered) await recovered.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("verify-only cleanup binds exact terminal evidence and never streams captured output", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-cleanup-${process.pid}-${Date.now()}`);
  const providerScript = path.join(scratch, "provider.mjs");
  await mkdir(scratch, { recursive: true });
  await writeFile(
    providerScript,
    'process.stdout.write("x".repeat(512 * 1024)); process.stderr.write("done");\n',
    "utf8",
  );
  const runId = `cleanup-run-${process.pid}-${Date.now()}`;
  const jobId = `cleanup-job-${process.pid}-${Date.now()}`;
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    outputLimitBytes: 1024 * 1024,
    recoverySecret: RECOVERY_SECRET,
  });
  let controller;
  try {
    controller = await spawnWindowsJobProcess(process.execPath, [providerScript], {
      runId,
      jobId,
      cwd: scratch,
      env: process.env,
      ...(await launchEvidence(process.execPath, scratch)),
      recoveryDescriptor: descriptor,
      recoverySecret: RECOVERY_SECRET,
      limits: {
        activeProcessLimit: 4,
        jobMemoryLimitBytes: 256 * 1024 * 1024,
        cpuTimeLimitMs: 30_000,
        outputLimitBytes: 1024 * 1024,
      },
    });
    controller.stdout.resume();
    controller.stderr.resume();
    const result = await controller.wait();
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 0);
    const evidence = await controller.authenticatedStatusEvidence();
    const expected = {
      runId,
      jobId,
      journalGeneration: evidence.journalGeneration,
      statusSequence: evidence.sequence,
      previousStatusSequence: evidence.previousSequence,
      previousSnapshotDigestSha256: evidence.previousSnapshotDigestSha256,
      previousJournalDigestSha256: evidence.previousJournalDigestSha256,
      snapshotDigestSha256: evidence.snapshotDigestSha256,
      journalDigestSha256: evidence.journalDigestSha256,
      authenticatedPayloadDigestSha256: evidence.authenticatedPayloadDigestSha256,
      nativeTerminalDigestSha256: evidence.nativeTerminalDigestSha256,
      nativeTerminalStatus: "succeeded",
      nativeExitCode: 0,
      terminationVerified: true,
      rootProcessId: controller.identity.rootProcessId,
      rootProcessStartedAtFileTime: controller.identity.rootProcessStartedAtFileTime,
      jobName: controller.identity.jobName,
      helperProcessId: controller.identity.helperProcessId,
      helperProcessStartedAtFileTime: controller.identity.helperProcessStartedAtFileTime,
    };

    await assert.rejects(
      cleanupWindowsJobRecoveryArtifactsVerified({
        recoveryRoot: scratch,
        recoverySecret: RECOVERY_SECRET,
        expected: { ...expected, snapshotDigestSha256: "f".repeat(64) },
      }),
      (error) => error instanceof WindowsJobContainmentError
        && error.code === "windows_job_protocol_invalid",
    );
    const scratchArtifacts = [
      [
        path.join(
          descriptor.controlDirectory,
          `.controller-terminal-journal.${randomUUID()}.expected.tmp`,
        ),
        Buffer.from("partial conflicting expected prefix", "utf8"),
      ],
      [
        path.join(
          descriptor.controlDirectory,
          `.controller-terminal-journal.${randomUUID()}.tmp`,
        ),
        Buffer.from("partial desired journal bytes", "utf8"),
      ],
      [
        path.join(
          descriptor.controlDirectory,
          `.controller-terminal-claim.${randomUUID()}.tmp`,
        ),
        Buffer.from("{partial-claim", "utf8"),
      ],
      [
        path.join(descriptor.controlDirectory, `status.json.${process.pid}.777.tmp`),
        Buffer.from("{partial-snapshot", "utf8"),
      ],
      [
        path.join(descriptor.controlDirectory, `status.json.${process.pid}.bak`),
        Buffer.from("stale snapshot backup", "utf8"),
      ],
    ];
    await Promise.all(scratchArtifacts.map(([filePath, bytes]) => writeFile(filePath, bytes, { flag: "wx" })));

    const directoryScratch = path.join(
      descriptor.controlDirectory,
      `status.json.${process.pid}.778.tmp`,
    );
    await mkdir(directoryScratch);
    await assert.rejects(
      cleanupWindowsJobRecoveryArtifactsVerified({
        recoveryRoot: scratch,
        recoverySecret: RECOVERY_SECRET,
        expected,
      }),
      (error) => error instanceof WindowsJobContainmentError
        && error.code === "windows_job_invalid_specification",
    );
    await rm(directoryScratch, { recursive: true, force: true });

    const reparseScratchTarget = path.join(scratch, "reparse-scratch-target");
    const reparseScratch = path.join(
      descriptor.controlDirectory,
      `status.json.${process.pid}.779.tmp`,
    );
    await mkdir(reparseScratchTarget);
    await symlink(reparseScratchTarget, reparseScratch, "junction");
    await assert.rejects(
      cleanupWindowsJobRecoveryArtifactsVerified({
        recoveryRoot: scratch,
        recoverySecret: RECOVERY_SECRET,
        expected,
      }),
      (error) => error instanceof WindowsJobContainmentError
        && error.code === "windows_job_invalid_specification",
    );
    await rm(reparseScratch, { recursive: true, force: true });

    const oversizedScratch = path.join(
      descriptor.controlDirectory,
      `.controller-terminal-claim.${randomUUID()}.tmp`,
    );
    await writeFile(oversizedScratch, Buffer.alloc((64 * 1024) + 1));
    await assert.rejects(
      cleanupWindowsJobRecoveryArtifactsVerified({
        recoveryRoot: scratch,
        recoverySecret: RECOVERY_SECRET,
        expected,
      }),
      (error) => error instanceof WindowsJobContainmentError
        && error.code === "windows_job_invalid_specification",
    );
    await rm(oversizedScratch, { force: true });

    const unexpectedArtifact = path.join(descriptor.controlDirectory, "unexpected-child");
    await writeFile(unexpectedArtifact, "unexpected", { flag: "wx" });
    await assert.rejects(
      cleanupWindowsJobRecoveryArtifactsVerified({
        recoveryRoot: scratch,
        recoverySecret: RECOVERY_SECRET,
        expected,
      }),
      (error) => error instanceof WindowsJobContainmentError
        && error.code === "windows_job_invalid_specification",
    );
    await rm(unexpectedArtifact, { force: true });

    // A cleanup drainer must not decrypt, emit, or backpressure on provider output.
    await writeFile(descriptor.outputPath, Buffer.alloc(2 * 1024 * 1024, 0x78));
    const cleaned = await cleanupWindowsJobRecoveryArtifactsVerified({
      recoveryRoot: scratch,
      recoverySecret: RECOVERY_SECRET,
      expected,
    });
    assert.equal(cleaned.result, "removed");
    await assert.rejects(readFile(descriptor.descriptorPath), { code: "ENOENT" });
    assert.equal(
      (await cleanupWindowsJobRecoveryArtifactsVerified({
        recoveryRoot: scratch,
        recoverySecret: RECOVERY_SECRET,
        expected,
      })).result,
      "already_absent",
    );
    controller = undefined;
  } finally {
    if (controller) await controller.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("pre-spawn handshake timeout returns only after no-process cleanup is verified", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-timeout-${process.pid}-${Date.now()}`);
  const childScript = path.join(scratch, "timeout.mjs");
  const processFile = path.join(scratch, "process.json");
  await mkdir(scratch, { recursive: true });
  await writeFile(
    childScript,
    [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }));',
      'setInterval(() => {}, 1000);',
    ].join("\n"),
    "utf8",
  );
  try {
    let timeoutError;
    try {
      await spawnWindowsJobProcess(
        process.execPath,
        [childScript, processFile],
        {
          runId: `timeout-run-${process.pid}-${Date.now()}`,
          jobId: `timeout-job-${process.pid}-${Date.now()}`,
          cwd: scratch,
          env: process.env,
          ...(await launchEvidence(process.execPath, scratch)),
          handshakeTimeoutMs: 500,
        },
      );
    } catch (error) {
      timeoutError = error;
    }
    assert.ok(timeoutError instanceof WindowsJobContainmentError);
    assert.equal(timeoutError.code, "windows_job_handshake_timeout");
    assert.equal(timeoutError.terminationVerified, true);
    assert.equal(timeoutError.cleanup, "no_process_created");
    try {
      const created = await waitForJson(processFile, 500);
      await waitForProcessExit(created.pid);
    } catch (error) {
      if (!String(error?.message).startsWith("Timed out waiting for ")) throw error;
      assert.equal(timeoutError.cleanup, "no_process_created");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("identity-free timeout cancellation after assignment kills the running root", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-assigned-timeout-${process.pid}-${Date.now()}`);
  const childScript = path.join(scratch, "assigned.mjs");
  const processFile = path.join(scratch, "process.json");
  const inputPath = path.join(scratch, "stdin.txt");
  const outputPath = path.join(scratch, "stdout.bin");
  const errorPath = path.join(scratch, "stderr.bin");
  const statusPath = path.join(scratch, "status.json");
  const cancelPath = path.join(scratch, "cancel.json");
  const identity = captureWindowsJobLauncherIdentitySync();
  const token = randomUUID();
  const journalGeneration = randomUUID();
  const runId = `assigned-run-${process.pid}-${Date.now()}`;
  const jobId = `assigned-job-${process.pid}-${Date.now()}`;
  await mkdir(scratch, { recursive: true });
  await writeFile(inputPath, "", "utf8");
  await writeFile(
    childScript,
    [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }));',
      'setInterval(() => {}, 1000);',
    ].join("\n"),
    "utf8",
  );

  const helper = spawn(
    identity.powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", identity.helperPath],
    { cwd: scratch, env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  helper.stdout.resume();
  helper.stderr.resume();
  const helperExit = new Promise((resolve) => helper.once("exit", resolve));
  const parentProcessStartedAtFileTime = spawnSync(
    identity.powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)`,
    ],
    { encoding: "utf8", windowsHide: true },
  ).stdout.trim();
  assert.match(parentProcessStartedAtFileTime, /^\d+$/);
  const executableBytes = await readFile(process.execPath);
  const executableInformation = await stat(process.execPath);
  helper.stdin.end(JSON.stringify({
    schemaVersion: 1,
    token,
    runId,
    jobId,
    journalGeneration,
    parentPid: process.pid,
    parentProcessStartedAtFileTime,
    executable: process.execPath,
    expectedExecutableFiles: [{
      role: "configured",
      absolutePath: process.execPath,
      sha256: createHash("sha256").update(executableBytes).digest("hex"),
      sizeBytes: executableInformation.size,
    }],
    args: [childScript, processFile],
    cwd: scratch,
    expectedWorkingDirectory: await pinnedWorkingDirectory(scratch),
    environment: { ...process.env },
    descendantGraceMs: 10_000,
    limits: {
      activeProcessLimit: 4,
      jobMemoryLimitBytes: 256 * 1024 * 1024,
      cpuTimeLimitMs: 30_000,
      outputLimitBytes: 1024 * 1024,
    },
    statusPath,
    cancelPath,
    inputPath,
    outputPath,
    errorPath,
  }));

  try {
    const created = await waitForJson(processFile);
    assert.doesNotThrow(() => process.kill(created.pid, 0));
    await writeFile(cancelPath, JSON.stringify({ schemaVersion: 1, token, runId, jobId }), { encoding: "utf8", flag: "wx" });
    const terminal = await waitForJsonMatching(statusPath, (value) => value.status === "cancelled");
    assert.equal(terminal.cleanup, "active_process_zero");
    assert.equal(terminal.terminationVerified, true);
    await helperExit;
    await waitForProcessExit(created.pid);
  } finally {
    if (helper.exitCode === null) helper.kill();
    await helperExit;
    await rm(scratch, { recursive: true, force: true });
  }
});

test("output quota never writes past the combined limit and terminates the job", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-output-${process.pid}-${Date.now()}`);
  const childScript = path.join(scratch, "output.mjs");
  const quota = 32 * 1024;
  await mkdir(scratch, { recursive: true });
  await writeFile(
    childScript,
    [
      'const chunk = Buffer.alloc(64 * 1024, 65);',
      'for (;;) { process.stdout.write(chunk); process.stderr.write(chunk); }',
    ].join("\n"),
    "utf8",
  );

  let controller;
  try {
    controller = await spawnWindowsJobProcess(
      process.execPath,
      [childScript],
      {
        runId: `output-run-${process.pid}-${Date.now()}`,
        jobId: `output-job-${process.pid}-${Date.now()}`,
        cwd: scratch,
        env: process.env,
        ...(await launchEvidence(process.execPath, scratch)),
        limits: {
          activeProcessLimit: 4,
          jobMemoryLimitBytes: 256 * 1024 * 1024,
          cpuTimeLimitMs: 30_000,
          outputLimitBytes: quota,
        },
      },
    );
    let capturedBytes = 0;
    controller.stdout.on("data", (chunk) => { capturedBytes += chunk.byteLength; });
    controller.stderr.on("data", (chunk) => { capturedBytes += chunk.byteLength; });
    const rootPid = controller.identity.rootProcessId;
    const result = await controller.wait();
    assert.equal(result.status, "blocked");
    assert.equal(result.cleanup, "active_process_zero");
    assert.equal(result.terminationVerified, true);
    assert.match(result.reason, /output exceeded/i);
    assert.equal(capturedBytes, quota);
    await waitForProcessExit(rootPid);
  } finally {
    if (controller) await controller.cancel(15_000).catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("recovery ACL hardening succeeds for an owned root that grants Modify without WRITE_OWNER", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-acl-modify-${process.pid}-${Date.now()}`);
  const recoveryRoot = path.join(scratch, "recovery");
  await mkdir(recoveryRoot, { recursive: true });
  const launcher = captureWindowsJobLauncherIdentitySync();
  const restrictRootScript = [
    "$ErrorActionPreference = 'Stop'",
    "$directory = [Environment]::GetEnvironmentVariable('AGENT_OS_TEST_RECOVERY_ROOT')",
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$security = [Security.AccessControl.DirectorySecurity]::new()",
    "$security.SetOwner($identity)",
    "$security.SetAccessRuleProtection($true, $false)",
    "$rights = [Security.AccessControl.FileSystemRights]::Modify",
    "$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
    "$rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)",
    "$null = $security.AddAccessRule($rule)",
    "[IO.Directory]::SetAccessControl($directory, $security)",
  ].join(";");
  const inspectAclScript = [
    "$ErrorActionPreference = 'Stop'",
    "$directory = [Environment]::GetEnvironmentVariable('AGENT_OS_TEST_CONTROL_DIRECTORY')",
    "$current = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = [IO.Directory]::GetAccessControl($directory)",
    "$owner = ([Security.Principal.NTAccount] $acl.Owner).Translate([Security.Principal.SecurityIdentifier])",
    "$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
    "[Console]::Out.Write((ConvertTo-Json -Compress -Depth 3 ([ordered]@{ Current = $current.Value; Owner = $owner.Value; Protected = $acl.AreAccessRulesProtected; Rules = @($rules | ForEach-Object { [ordered]@{ Identity = $_.IdentityReference.Value; Type = $_.AccessControlType.ToString(); Rights = $_.FileSystemRights.ToString(); Inherited = $_.IsInherited } }) })))",
  ].join(";");
  try {
    const restricted = spawnSync(
      launcher.powershellPath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", restrictRootScript],
      {
        env: { ...process.env, AGENT_OS_TEST_RECOVERY_ROOT: recoveryRoot },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    );
    assert.equal(restricted.status, 0, restricted.stderr || restricted.error?.message);
    const descriptor = await prepareWindowsJobRecoveryDescriptor({
      runId: `acl-modify-run-${process.pid}-${Date.now()}`,
      jobId: `acl-modify-job-${process.pid}-${Date.now()}`,
      recoveryRoot,
      recoverySecret: RECOVERY_SECRET,
    });
    const inspected = spawnSync(
      launcher.powershellPath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", inspectAclScript],
      {
        env: { ...process.env, AGENT_OS_TEST_CONTROL_DIRECTORY: descriptor.controlDirectory },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    );
    assert.equal(inspected.status, 0, inspected.stderr || inspected.error?.message);
    const acl = JSON.parse(inspected.stdout);
    assert.equal(acl.Protected, true);
    assert.equal(acl.Owner, acl.Current);
    assert.equal(acl.Rules.length, 1);
    assert.deepEqual(acl.Rules[0], {
      Identity: acl.Current,
      Type: "Allow",
      Rights: "FullControl",
      Inherited: false,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("new process recovers authenticated terminal proof after controller worker crash", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-recovery-${process.pid}-${Date.now()}`);
  const workerScript = path.join(scratch, "worker.mjs");
  const providerScript = path.join(scratch, "provider.mjs");
  const readyFile = path.join(scratch, "ready.json");
  const outputLimitBytes = 1024 * 1024;
  await mkdir(scratch, { recursive: true });
  await writeFile(providerScript, 'setInterval(() => {}, 1000);\n', "utf8");
  await writeFile(
    workerScript,
    [
      'import { createHash } from "node:crypto";',
      'import { readFile, realpath, stat, writeFile } from "node:fs/promises";',
      'const [moduleUrl, descriptorPath, executable, providerScript, providerCwd, readyFile, outputLimit] = process.argv.slice(2);',
      'const { spawnWindowsJobProcess } = await import(moduleUrl);',
      'const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));',
      'const [canonicalExecutable, canonicalCwd] = await Promise.all([realpath(executable), realpath(providerCwd)]);',
      'const [executableBytes, executableInformation, cwdInformation] = await Promise.all([',
      '  readFile(canonicalExecutable), stat(canonicalExecutable), stat(canonicalCwd),',
      ']);',
      'const controller = await spawnWindowsJobProcess(executable, [providerScript], {',
      '  runId: descriptor.runId,',
      '  jobId: descriptor.jobId,',
      '  cwd: providerCwd,',
      '  env: process.env,',
      '  expectedExecutableFiles: [{',
      '    role: "configured", absolutePath: canonicalExecutable,',
      '    sha256: createHash("sha256").update(executableBytes).digest("hex"), sizeBytes: executableInformation.size,',
      '  }],',
      '  expectedWorkingDirectory: {',
      '    absolutePath: canonicalCwd, device: cwdInformation.dev, inode: cwdInformation.ino, modifiedMs: cwdInformation.mtimeMs,',
      '  },',
      '  recoveryDescriptor: descriptor,',
      '  limits: {',
      '    activeProcessLimit: 4,',
      '    jobMemoryLimitBytes: 256 * 1024 * 1024,',
      '    cpuTimeLimitMs: 30_000,',
      '    outputLimitBytes: Number(outputLimit),',
      '  },',
      '});',
      'await writeFile(readyFile, JSON.stringify({ rootProcessId: controller.identity.rootProcessId }));',
      'setInterval(() => {}, 1000);',
    ].join("\n"),
    "utf8",
  );

  const runId = `recovery-run-${process.pid}-${Date.now()}`;
  const jobId = `recovery-job-${process.pid}-${Date.now()}`;
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    outputLimitBytes,
    recoverySecret: RECOVERY_SECRET,
  });
  assert.equal(
    descriptor.descriptorPath,
    await resolveWindowsJobRecoveryDescriptorPath(scratch, runId, jobId),
  );
  const preparedAgain = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    outputLimitBytes,
    recoverySecret: RECOVERY_SECRET,
  });
  assert.deepEqual(preparedAgain, descriptor);
  const persistedDescriptor = JSON.parse(await readFile(descriptor.descriptorPath, "utf8"));
  assert.equal(persistedDescriptor.descriptorHmacSha256, descriptor.descriptorHmacSha256);
  assert.equal("token" in persistedDescriptor, false);
  assert.equal(JSON.stringify(persistedDescriptor).includes(RECOVERY_SECRET), false);

  const moduleUrl = new URL("./windowsJobProcess.ts", import.meta.url).href;
  const worker = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      workerScript,
      moduleUrl,
      descriptor.descriptorPath,
      process.execPath,
      providerScript,
      scratch,
      readyFile,
      String(outputLimitBytes),
    ],
    {
      cwd: scratch,
      env: { ...process.env, AGENT_OS_WORKBENCH_RECOVERY_SECRET: RECOVERY_SECRET },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let workerDiagnostics = "";
  worker.stdout.on("data", (chunk) => { workerDiagnostics += chunk.toString(); });
  worker.stderr.on("data", (chunk) => { workerDiagnostics += chunk.toString(); });
  const workerExit = new Promise((resolve) => worker.once("exit", resolve));
  let recovered;
  try {
    const ready = await waitForJson(readyFile, 20_000).catch((error) => {
      error.message = `${error.message}\n${workerDiagnostics.slice(-4_000)}`;
      throw error;
    });
    assert.doesNotThrow(() => process.kill(ready.rootProcessId, 0));
    assert.equal(worker.kill(), true);
    await workerExit;

    await assert.rejects(
      recoverWindowsJobProcess(descriptor.descriptorPath, "wrong-recovery-secret-value-0123456789"),
      (error) => error instanceof WindowsJobContainmentError && error.code === "windows_job_invalid_specification",
    );
    await assert.rejects(
      recoverWindowsJobProcess(descriptor.descriptorPath, ""),
      (error) => error instanceof WindowsJobContainmentError && error.code === "windows_job_invalid_specification",
    );
    recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    assert.ok(recovered.identity);
    assert.equal(recovered.identity.rootProcessId, ready.rootProcessId);
    assert.match(recovered.identity.helperProcessStartedAtFileTime, /^\d+$/);
    assert.equal(recovered.status.status, "ready");
    assert.equal("token" in recovered.status, false);
    assert.doesNotThrow(() => process.kill(recovered.identity.helperProcessId, 0));
    const result = await recovered.cancel();
    assert.equal(result.status, "cancelled");
    assert.equal(result.cleanup, "active_process_zero");
    assert.equal(result.terminationVerified, true);
    await waitForProcessExit(ready.rootProcessId);
    await waitForProcessExit(recovered.identity.helperProcessId);

    for (const fileName of await readdir(descriptor.controlDirectory)) {
      const bytes = await readFile(path.join(descriptor.controlDirectory, fileName));
      assert.equal(
        bytes.includes(Buffer.from(RECOVERY_SECRET, "utf8")),
        false,
        `${fileName} persisted the recovery secret`,
      );
    }

    await assert.rejects(
      spawnWindowsJobProcess(process.execPath, [providerScript], {
        runId,
        jobId,
        cwd: scratch,
        env: process.env,
        ...(await launchEvidence(process.execPath, scratch)),
        recoveryDescriptor: descriptor,
        recoverySecret: RECOVERY_SECRET,
        limits: {
          activeProcessLimit: 4,
          jobMemoryLimitBytes: 256 * 1024 * 1024,
          cpuTimeLimitMs: 30_000,
          outputLimitBytes,
        },
      }),
      (error) => error instanceof WindowsJobContainmentError && error.code === "windows_job_spawn_failed",
    );
    await writeFile(
      descriptor.descriptorPath,
      JSON.stringify({ ...descriptor, outputLimitBytes: outputLimitBytes + 1 }),
      "utf8",
    );
    await assert.rejects(
      recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET),
      (error) => error instanceof WindowsJobContainmentError && error.code === "windows_job_invalid_specification",
    );
    await recovered.cleanupVerified();
    await assert.rejects(readFile(descriptor.descriptorPath, "utf8"), { code: "ENOENT" });
    recovered = undefined;
  } finally {
    if (worker.exitCode === null) worker.kill();
    await workerExit;
    if (recovered) await recovered.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("authenticated blocked terminal status preserves assigned process identity without leaking helper secrets", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-blocked-recovery-${process.pid}-${Date.now()}`);
  const providerScript = path.join(scratch, "provider.mjs");
  const outputLimitBytes = 16 * 1024;
  const runId = `blocked-recovery-run-${process.pid}-${Date.now()}`;
  const jobId = `blocked-recovery-job-${process.pid}-${Date.now()}`;
  await mkdir(scratch, { recursive: true });
  await writeFile(
    providerScript,
    [
      'if (process.env.AGENT_OS_WORKBENCH_RECOVERY_SECRET || process.env.AGENT_OS_RECOVERY_AUTH_KEY) process.exit(91);',
      'const chunk = Buffer.alloc(64 * 1024, 88);',
      'for (;;) process.stdout.write(chunk);',
    ].join("\n"),
    "utf8",
  );
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    outputLimitBytes,
    recoverySecret: RECOVERY_SECRET,
  });
  let recovered;
  try {
    const controller = await spawnWindowsJobProcess(process.execPath, [providerScript], {
      runId,
      jobId,
      cwd: scratch,
      env: {
        ...process.env,
        AGENT_OS_WORKBENCH_RECOVERY_SECRET: RECOVERY_SECRET,
        AGENT_OS_RECOVERY_AUTH_KEY: "provider-must-not-inherit-this-value",
      },
      ...(await launchEvidence(process.execPath, scratch)),
      recoveryDescriptor: descriptor,
      recoverySecret: RECOVERY_SECRET,
      limits: {
        activeProcessLimit: 4,
        jobMemoryLimitBytes: 256 * 1024 * 1024,
        cpuTimeLimitMs: 30_000,
        outputLimitBytes,
      },
    });
    const result = await controller.wait();
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /output exceeded/i);
    recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    assert.equal(recovered.status.status, "blocked");
    assert.ok(recovered.identity);
    assert.equal(recovered.identity.rootProcessId, controller.identity.rootProcessId);
    assert.equal(recovered.identity.helperProcessId, controller.identity.helperProcessId);
    assert.match(recovered.identity.helperProcessStartedAtFileTime, /^\d+$/);
    assert.deepEqual(await recovered.wait(), result);
  } finally {
    if (recovered) await recovered.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("recovery control files encrypt provider input, environment, stdout, and stderr and reject ciphertext tampering", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-encrypted-recovery-${process.pid}-${Date.now()}`);
  const providerScript = path.join(scratch, "provider.mjs");
  const inputSentinel = `RECOVERY_INPUT_SENTINEL_${randomUUID()}`;
  const environmentSentinel = `RECOVERY_ENV_SENTINEL_${randomUUID()}`;
  const stdoutSentinel = `RECOVERY_STDOUT_SENTINEL_${randomUUID()}`;
  const stderrSentinel = `RECOVERY_STDERR_SENTINEL_${randomUUID()}`;
  const runId = `encrypted-recovery-run-${process.pid}-${Date.now()}`;
  const jobId = `encrypted-recovery-job-${process.pid}-${Date.now()}`;
  const outputLimitBytes = 1024 * 1024;
  await mkdir(scratch, { recursive: true });
  await writeFile(
    providerScript,
    [
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  process.stdout.write(`${input}|${process.env.RECOVERY_SENTINEL_ENV}|${process.argv[2]}`);',
      '  process.stderr.write(process.argv[3]);',
      '});',
    ].join("\n"),
    "utf8",
  );
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    outputLimitBytes,
    recoverySecret: RECOVERY_SECRET,
  });
  let controller;
  try {
    controller = await spawnWindowsJobProcess(
      process.execPath,
      [providerScript, stdoutSentinel, stderrSentinel],
      {
        runId,
        jobId,
        cwd: scratch,
        env: { ...process.env, RECOVERY_SENTINEL_ENV: environmentSentinel },
        input: inputSentinel,
        ...(await launchEvidence(process.execPath, scratch)),
        recoveryDescriptor: descriptor,
        recoverySecret: RECOVERY_SECRET,
        limits: {
          activeProcessLimit: 4,
          jobMemoryLimitBytes: 256 * 1024 * 1024,
          cpuTimeLimitMs: 30_000,
          outputLimitBytes,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    controller.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    controller.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const terminal = await controller.wait();
    assert.equal(terminal.status, "exited");
    assert.equal(stdout, `${inputSentinel}|${environmentSentinel}|${stdoutSentinel}`);
    assert.equal(stderr, stderrSentinel);
    const forbidden = [inputSentinel, environmentSentinel, stdoutSentinel, stderrSentinel];
    for (const fileName of await readdir(descriptor.controlDirectory)) {
      const bytes = await readFile(path.join(descriptor.controlDirectory, fileName));
      for (const sentinel of forbidden) {
        assert.equal(
          bytes.includes(Buffer.from(sentinel, "utf8")),
          false,
          `${fileName} persisted plaintext ${sentinel}`,
        );
      }
    }

    const recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    const encryptedOutput = await readFile(descriptor.outputPath);
    const tamperedOutput = Buffer.from(encryptedOutput);
    tamperedOutput[Math.max(24, tamperedOutput.length - 33)] ^= 1;
    await writeFile(descriptor.outputPath, tamperedOutput);
    await assert.rejects(
      recovered.wait(),
      (error) => error instanceof WindowsJobContainmentError && error.code === "windows_job_protocol_invalid",
    );
  } finally {
    if (controller) await controller.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("recovery rejects legacy, predecessor, journal-digest, terminal-digest, HMAC, ordering, and rollback tampering", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-journal-recovery-${process.pid}-${Date.now()}`);
  const providerScript = path.join(scratch, "provider.mjs");
  const runId = `journal-recovery-run-${process.pid}-${Date.now()}`;
  const jobId = `journal-recovery-job-${process.pid}-${Date.now()}`;
  const outputLimitBytes = 1024 * 1024;
  await mkdir(scratch, { recursive: true });
  await writeFile(providerScript, 'process.exit(0);\n', "utf8");
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    outputLimitBytes,
    recoverySecret: RECOVERY_SECRET,
  });
  let controller;
  try {
    controller = await spawnWindowsJobProcess(process.execPath, [providerScript], {
      runId,
      jobId,
      cwd: scratch,
      env: process.env,
      ...(await launchEvidence(process.execPath, scratch)),
      recoveryDescriptor: descriptor,
      recoverySecret: RECOVERY_SECRET,
      limits: {
        activeProcessLimit: 4,
        jobMemoryLimitBytes: 256 * 1024 * 1024,
        cpuTimeLimitMs: 30_000,
        outputLimitBytes,
      },
    });
    assert.equal((await controller.wait()).status, "exited");
    const originalJournal = await readFile(descriptor.statusJournalPath, "utf8");
    const lines = originalJournal.trimEnd().split("\n");
    const statuses = lines.map((line) => signedEnvelopePayload(JSON.parse(line)));
    assert.ok(lines.length >= 3);

    const tampered = JSON.parse(lines[0]);
    tampered.hmacSha256 = `${tampered.hmacSha256[0] === "0" ? "1" : "0"}${tampered.hmacSha256.slice(1)}`;
    await writeFile(
      descriptor.statusJournalPath,
      `${[JSON.stringify(tampered), ...lines.slice(1)].join("\n")}\n`,
      "utf8",
    );
    await assert.rejects(
      recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET),
      (error) => error instanceof WindowsJobContainmentError && error.code === "windows_job_protocol_invalid",
    );

    const predecessorTampered = {
      ...statuses[1],
      previousSnapshotDigestSha256: "f".repeat(64),
    };
    await writeFile(
      descriptor.statusJournalPath,
      `${[lines[0], JSON.stringify(signedStatusEnvelope(descriptor, predecessorTampered)), ...lines.slice(2)].join("\n")}\n`,
      "utf8",
    );
    await assert.rejects(
      recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET),
      (error) => error instanceof WindowsJobContainmentError && error.code === "windows_job_protocol_invalid",
    );

    const journalDigestTampered = {
      ...statuses[1],
      previousJournalDigestSha256: "e".repeat(64),
    };
    await writeFile(
      descriptor.statusJournalPath,
      `${[lines[0], JSON.stringify(signedStatusEnvelope(descriptor, journalDigestTampered)), ...lines.slice(2)].join("\n")}\n`,
      "utf8",
    );
    await assert.rejects(
      recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET),
      (error) => error instanceof WindowsJobContainmentError && error.code === "windows_job_protocol_invalid",
    );

    const terminalDigestTampered = {
      ...statuses.at(-1),
      nativeTerminalDigestSha256: "d".repeat(64),
    };
    await writeFile(
      descriptor.statusJournalPath,
      `${[...lines.slice(0, -1), JSON.stringify(signedStatusEnvelope(descriptor, terminalDigestTampered))].join("\n")}\n`,
      "utf8",
    );
    await assert.rejects(
      recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET),
      (error) => error instanceof WindowsJobContainmentError && error.code === "windows_job_protocol_invalid",
    );

    const legacyStatus = { ...statuses[0], schemaVersion: 1 };
    await writeFile(
      descriptor.statusJournalPath,
      `${[JSON.stringify(signedStatusEnvelope(descriptor, legacyStatus)), ...lines.slice(1)].join("\n")}\n`,
      "utf8",
    );
    await assert.rejects(
      recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET),
      (error) => error instanceof WindowsJobContainmentError && error.code === "windows_job_protocol_invalid",
    );

    await writeFile(
      descriptor.statusJournalPath,
      `${[lines[1], lines[0], ...lines.slice(2)].join("\n")}\n`,
      "utf8",
    );
    await assert.rejects(
      recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET),
      (error) => error instanceof WindowsJobContainmentError && error.code === "windows_job_protocol_invalid",
    );

    await writeFile(descriptor.statusJournalPath, `${lines.slice(0, -1).join("\n")}\n`, "utf8");
    await assert.rejects(
      recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET),
      (error) => error instanceof WindowsJobContainmentError
        && error.code === "windows_job_protocol_invalid",
    );
    await writeFile(descriptor.statusJournalPath, originalJournal, "utf8");
  } finally {
    if (controller) await controller.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("sixteen legacy terminal descriptors remain byte-identical and recover without deadline fields", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-legacy-descriptors-${process.pid}-${Date.now()}`);
  const emptyDigest = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  await mkdir(scratch, { recursive: true });
  try {
    for (let index = 0; index < 16; index += 1) {
      const runId = `legacy-descriptor-run-${index}-${process.pid}-${Date.now()}`;
      const jobId = `legacy-descriptor-job-${index}-${process.pid}-${Date.now()}`;
      const descriptor = await prepareWindowsJobRecoveryDescriptor({
        runId,
        jobId,
        recoveryRoot: scratch,
        recoverySecret: RECOVERY_SECRET,
      });
      const descriptorBefore = await readFile(descriptor.descriptorPath);
      const legacyTerminal = {
        schemaVersion: 2,
        sequence: 1,
        previousSequence: 0,
        previousSnapshotDigestSha256: "0".repeat(64),
        previousJournalDigestSha256: "0".repeat(64),
        journalGeneration: descriptor.journalGeneration,
        runId,
        jobId,
        status: "blocked",
        assignmentVerified: false,
        exitCode: null,
        cleanup: "no_process_created",
        terminationVerified: true,
        reason: "Legacy verified no-process terminal record.",
        encryptedStdoutBytes: 0,
        encryptedStdoutDigestSha256: emptyDigest,
        encryptedStderrBytes: 0,
        encryptedStderrDigestSha256: emptyDigest,
        nativeTerminalDigestSha256: null,
      };
      legacyTerminal.nativeTerminalDigestSha256 = nativeTerminalDigestForTest(legacyTerminal);
      assert.equal("terminationRequestedAt" in legacyTerminal, false);
      assert.equal("terminationDeadlineAt" in legacyTerminal, false);
      await writeAuthenticatedStatusHistory(descriptor, [legacyTerminal]);

      const recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
      const terminal = await recovered.wait();
      assert.equal(terminal.status, "blocked");
      assert.equal(terminal.cleanup, "no_process_created");
      assert.equal(terminal.terminationVerified, true);
      assert.deepEqual(await readFile(descriptor.descriptorPath), descriptorBefore);
      await recovered.cleanupVerified();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("blocked pending status remains nonterminal and concurrent recovered cancel appends one verified terminal", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-pending-recovery-${process.pid}-${Date.now()}`);
  const runId = `pending-recovery-run-${process.pid}-${Date.now()}`;
  const jobId = `pending-recovery-job-${process.pid}-${Date.now()}`;
  await mkdir(scratch, { recursive: true });
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    recoverySecret: RECOVERY_SECRET,
  });
  const pendingStatus = {
    schemaVersion: 2,
    sequence: 1,
    previousSequence: 0,
    previousSnapshotDigestSha256: "0".repeat(64),
    previousJournalDigestSha256: "0".repeat(64),
    journalGeneration: descriptor.journalGeneration,
    runId,
    jobId,
    status: "blocked",
    assignmentVerified: false,
    exitCode: null,
    cleanup: "pending",
    terminationVerified: false,
    reason: "Injected recoverable cleanup gap.",
    encryptedStdoutBytes: null,
    encryptedStdoutDigestSha256: null,
    encryptedStderrBytes: null,
    encryptedStderrDigestSha256: null,
    nativeTerminalDigestSha256: null,
  };
  await writeAuthenticatedStatusHistory(descriptor, [pendingStatus]);
  const acceptedEvidence = [];
  let recovered;
  let journalLocker;
  let journalLockerResult;
  try {
    recovered = await recoverWindowsJobProcess(
      descriptor.descriptorPath,
      RECOVERY_SECRET,
      async (evidence) => { acceptedEvidence.push(evidence); },
    );
    assert.equal(recovered.status.status, "blocked");
    assert.equal(recovered.status.exitCode, null);
    assert.equal(recovered.status.cleanup, "pending");
    assert.equal(recovered.status.terminationVerified, false);
    assert.equal(recovered.status.reason, "Injected recoverable cleanup gap.");

    const lockReadyPath = path.join(scratch, "journal-lock-ready.json");
    journalLocker = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      JOURNAL_LOCK_FIXTURE,
      "-JournalPath",
      descriptor.statusJournalPath,
      "-ReadyPath",
      lockReadyPath,
      "-HoldMilliseconds",
      "750",
    ], {
      cwd: scratch,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    journalLockerResult = captureChild(journalLocker);
    await waitForJson(lockReadyPath, 10_000);

    const waiting = recovered.wait();
    assert.equal(await Promise.race([
      waiting.then(() => "terminal"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]), "pending");

    const firstCancel = recovered.cancel(250);
    const secondCancel = recovered.cancel(250);
    assert.equal(firstCancel, secondCancel);
    const terminal = await firstCancel;
    assert.equal(terminal.status, "blocked");
    assert.equal(terminal.cleanup, "active_process_zero");
    assert.equal(terminal.terminationVerified, true);
    assert.deepEqual(await waiting, terminal);
    const lockResult = await journalLockerResult;
    assert.equal(lockResult.code, 0, lockResult.stderr || lockResult.stdout);
    assert.equal(lockResult.signal, null);

    const journalLines = (await readFile(descriptor.statusJournalPath, "utf8")).trimEnd().split("\n");
    assert.equal(journalLines.length, 2);
    assert.ok((await readFile(descriptor.cancelPath)).byteLength > 0);
    const finalEvidence = await recovered.authenticatedStatusEvidence();
    assert.equal(finalEvidence.sequence, 2);
    assert.equal(finalEvidence.terminal, true);
    assert.ok(acceptedEvidence.some((evidence) => evidence.sequence === 1 && !evidence.terminal));
    assert.ok(acceptedEvidence.some((evidence) => evidence.sequence === 2 && evidence.terminal));
    const controlEntries = await readdir(descriptor.controlDirectory);
    assert.equal(controlEntries.some((entry) => entry.endsWith(".tmp")), false);
  } finally {
    if (journalLocker && journalLocker.exitCode === null && journalLocker.signalCode === null) journalLocker.kill();
    if (journalLockerResult) await journalLockerResult.catch(() => null);
    if (recovered) await recovered.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("journal CAS serializes absent first commit across two processes", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-first-journal-${process.pid}-${Date.now()}`);
  const launcherPath = captureWindowsJobLauncherIdentitySync().helperPath;
  await mkdir(scratch, { recursive: true });

  async function runCase(name, desiredBytes) {
    const caseDirectory = path.join(scratch, name);
    const journalPath = path.join(caseDirectory, "status.journal.jsonl");
    const barrierPath = path.join(caseDirectory, "start.json");
    const readyPaths = desiredBytes.map((_, index) => path.join(caseDirectory, `ready-${index}.json`));
    await mkdir(caseDirectory);
    const commitFiles = desiredBytes.map((bytes) => {
      const commitId = randomUUID();
      return {
        bytes,
        desiredPath: path.join(caseDirectory, `.controller-terminal-journal.${commitId}.tmp`),
        expectedPath: path.join(caseDirectory, `.controller-terminal-journal.${commitId}.expected.tmp`),
      };
    });
    await Promise.all(commitFiles.flatMap(({ bytes, desiredPath, expectedPath }) => [
      writeFile(desiredPath, bytes, { flag: "wx" }),
      writeFile(expectedPath, Buffer.alloc(0), { flag: "wx" }),
    ]));
    const children = commitFiles.map(({ desiredPath, expectedPath }, index) => spawn("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        JOURNAL_COMMIT_RACE_FIXTURE,
        "-LauncherPath",
        launcherPath,
        "-JournalPath",
        journalPath,
        "-DesiredPath",
        desiredPath,
        "-ExpectedPath",
        expectedPath,
        "-ReadyPath",
        readyPaths[index],
        "-BarrierPath",
        barrierPath,
      ], {
        cwd: caseDirectory,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }));
    const completions = children.map(captureChild);
    try {
      await Promise.all(readyPaths.map((readyPath) => waitForJson(readyPath, 10_000)));
      await writeFile(barrierPath, JSON.stringify({ start: true }), { encoding: "utf8", flag: "wx" });
      const results = await Promise.all(completions);
      for (const result of results) assert.equal(result.signal, null, result.stderr || result.stdout);
      return {
        codes: results.map((result) => result.code).sort((left, right) => left - right),
        journal: await readFile(journalPath),
      };
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      await Promise.all(completions.map((completion) => completion.catch(() => null)));
    }
  }

  try {
    const different = [
      Buffer.from('{"writer":"left"}\n', "utf8"),
      Buffer.from('{"writer":"right"}\n', "utf8"),
    ];
    const conflicting = await runCase("different", different);
    assert.deepEqual(conflicting.codes, [0, 73]);
    assert.ok(different.some((candidate) => candidate.equals(conflicting.journal)));
    assert.equal(conflicting.journal.toString("utf8").endsWith("\n"), true);

    const identicalBytes = Buffer.from('{"writer":"same"}\n', "utf8");
    const identical = await runCase("identical", [identicalBytes, Buffer.from(identicalBytes)]);
    assert.deepEqual(identical.codes, [0, 0]);
    assert.deepEqual(identical.journal, identicalBytes);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("controller journal CAS rejects a conflicting signed target without overwriting it", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-journal-conflict-${process.pid}-${Date.now()}`);
  const runId = `journal-conflict-run-${process.pid}-${Date.now()}`;
  const jobId = `journal-conflict-job-${process.pid}-${Date.now()}`;
  await mkdir(scratch, { recursive: true });
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    recoverySecret: RECOVERY_SECRET,
  });
  const pendingStatus = {
    schemaVersion: 2,
    sequence: 1,
    previousSequence: 0,
    previousSnapshotDigestSha256: "0".repeat(64),
    previousJournalDigestSha256: "0".repeat(64),
    journalGeneration: descriptor.journalGeneration,
    runId,
    jobId,
    status: "blocked",
    assignmentVerified: false,
    exitCode: null,
    cleanup: "pending",
    terminationVerified: false,
    reason: "Injected journal conflict predecessor.",
    encryptedStdoutBytes: null,
    encryptedStdoutDigestSha256: null,
    encryptedStderrBytes: null,
    encryptedStderrDigestSha256: null,
    nativeTerminalDigestSha256: null,
  };
  await writeAuthenticatedStatusHistory(descriptor, [pendingStatus]);
  const initialJournal = await readFile(descriptor.statusJournalPath);
  const previousEnvelope = JSON.parse(initialJournal.toString("utf8").trimEnd());
  const conflictStatus = {
    ...pendingStatus,
    sequence: 2,
    previousSequence: 1,
    previousSnapshotDigestSha256: createHash("sha256")
      .update(Buffer.from(previousEnvelope.payloadBase64, "base64"))
      .digest("hex"),
    previousJournalDigestSha256: createHash("sha256").update(initialJournal).digest("hex"),
    status: "blocked",
    cleanup: "active_process_zero",
    terminationVerified: true,
    reason: "Injected competing signed terminal.",
    encryptedStdoutBytes: 0,
    encryptedStdoutDigestSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    encryptedStderrBytes: 0,
    encryptedStderrDigestSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    nativeTerminalDigestSha256: null,
  };
  conflictStatus.nativeTerminalDigestSha256 = nativeTerminalDigestForTest(conflictStatus);
  const conflictEnvelope = signedStatusEnvelope(descriptor, conflictStatus);
  const conflictJournal = Buffer.concat([
    initialJournal,
    Buffer.from(`${JSON.stringify(conflictEnvelope)}\n`, "utf8"),
  ]);
  const conflictJournalPath = path.join(scratch, "conflict-status.journal.jsonl");
  const lockReadyPath = path.join(scratch, "journal-conflict-lock-ready.json");
  await writeFile(conflictJournalPath, conflictJournal, { flag: "wx" });

  let recovered;
  let conflictWriter;
  let conflictWriterResult;
  try {
    recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    conflictWriter = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      JOURNAL_CONFLICT_FIXTURE,
      "-JournalPath",
      descriptor.statusJournalPath,
      "-ConflictJournalPath",
      conflictJournalPath,
      "-ReadyPath",
      lockReadyPath,
    ], {
      cwd: scratch,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    conflictWriterResult = captureChild(conflictWriter);
    await waitForJson(lockReadyPath, 10_000);

    await assert.rejects(
      recovered.cancel(500),
      (error) => error instanceof WindowsJobContainmentError
        && error.code === "windows_job_protocol_invalid"
        && /unexpected prefix/iu.test(error.message),
    );
    const writerResult = await conflictWriterResult;
    assert.equal(writerResult.code, 0, writerResult.stderr || writerResult.stdout);
    assert.equal(writerResult.signal, null);
    assert.deepEqual(JSON.parse(writerResult.stdout), { published: true });
    assert.deepEqual(await readFile(descriptor.statusJournalPath), conflictJournal);

    const journalLines = conflictJournal.toString("utf8").trimEnd().split("\n");
    assert.equal(journalLines.length, 2);
    assert.equal(signedEnvelopePayload(JSON.parse(journalLines[1])).reason, "Injected competing signed terminal.");
    const controlEntries = await readdir(descriptor.controlDirectory);
    assert.equal(
      controlEntries.some((entry) => /^\.controller-terminal-journal\..*\.tmp$/u.test(entry)),
      false,
    );

    const conflictRecovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    assert.equal((await conflictRecovered.wait()).reason, "Injected competing signed terminal.");
  } finally {
    if (conflictWriter && conflictWriter.exitCode === null && conflictWriter.signalCode === null) conflictWriter.kill();
    if (conflictWriterResult) await conflictWriterResult.catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("two Node recoverers race through one cross-process terminal claim and legal journal append", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-cross-process-cas-${process.pid}-${Date.now()}`);
  const runId = `cross-process-cas-run-${process.pid}-${Date.now()}`;
  const jobId = `cross-process-cas-job-${process.pid}-${Date.now()}`;
  const barrierPath = path.join(scratch, "start.json");
  const readyPaths = [path.join(scratch, "ready-1.json"), path.join(scratch, "ready-2.json")];
  await mkdir(scratch, { recursive: true });
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    recoverySecret: RECOVERY_SECRET,
  });
  const pendingStatus = {
    schemaVersion: 2,
    sequence: 1,
    previousSequence: 0,
    previousSnapshotDigestSha256: "0".repeat(64),
    previousJournalDigestSha256: "0".repeat(64),
    journalGeneration: descriptor.journalGeneration,
    runId,
    jobId,
    status: "blocked",
    assignmentVerified: false,
    exitCode: null,
    cleanup: "pending",
    terminationVerified: false,
    reason: "Injected cross-process terminal writer race.",
    encryptedStdoutBytes: null,
    encryptedStdoutDigestSha256: null,
    encryptedStderrBytes: null,
    encryptedStderrDigestSha256: null,
    nativeTerminalDigestSha256: null,
  };
  await writeAuthenticatedStatusHistory(descriptor, [pendingStatus]);

  const children = readyPaths.map((readyPath) => spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      CONCURRENT_RECOVERY_FIXTURE,
      descriptor.descriptorPath,
      barrierPath,
      readyPath,
    ],
    {
      cwd: scratch,
      env: { ...process.env, AGENT_OS_WORKBENCH_RECOVERY_SECRET: RECOVERY_SECRET },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ));
  const childResults = children.map(captureChild);
  let recovered;
  try {
    await Promise.all(readyPaths.map((readyPath) => waitForJson(readyPath, 10_000)));
    await writeFile(barrierPath, JSON.stringify({ start: true }), { encoding: "utf8", flag: "wx" });
    const results = await Promise.all(childResults);
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.equal(result.signal, null);
    }

    const outcomes = results.map((result) => JSON.parse(result.stdout));
    assert.notEqual(outcomes[0].pid, outcomes[1].pid);
    assert.deepEqual(outcomes[0].terminal, outcomes[1].terminal);
    assert.equal(outcomes[0].evidence.sequence, 2);
    assert.equal(outcomes[1].evidence.sequence, 2);
    assert.equal(outcomes[0].evidence.terminal, true);
    assert.equal(outcomes[1].evidence.terminal, true);

    const journalLines = (await readFile(descriptor.statusJournalPath, "utf8")).trimEnd().split("\n");
    assert.equal(journalLines.length, 2);
    const terminalStatus = signedEnvelopePayload(JSON.parse(journalLines[1]));
    assert.equal(terminalStatus.sequence, 2);
    assert.equal(terminalStatus.status, "blocked");
    assert.equal(terminalStatus.cleanup, "active_process_zero");
    assert.equal(terminalStatus.terminationVerified, true);
    const claimedStatus = signedEnvelopePayload(JSON.parse(
      await readFile(path.join(descriptor.controlDirectory, "controller-terminal.claim.json"), "utf8"),
    ));
    assert.deepEqual(claimedStatus, terminalStatus);
    const controlEntries = await readdir(descriptor.controlDirectory);
    assert.equal(controlEntries.some((entry) => entry.endsWith(".tmp")), false);

    recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    assert.deepEqual(await recovered.wait(), outcomes[0].terminal);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.all(childResults.map((result) => result.catch(() => null)));
    if (recovered) await recovered.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("recovery closes a helper-death gap with verified Job cleanup and preserved assigned identity", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-helper-death-${process.pid}-${Date.now()}`);
  const providerScript = path.join(scratch, "provider.mjs");
  const runId = `helper-death-run-${process.pid}-${Date.now()}`;
  const jobId = `helper-death-job-${process.pid}-${Date.now()}`;
  const outputLimitBytes = 1024 * 1024;
  await mkdir(scratch, { recursive: true });
  await writeFile(providerScript, 'setInterval(() => {}, 1000);\n', "utf8");
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    outputLimitBytes,
    recoverySecret: RECOVERY_SECRET,
  });
  let recovered;
  try {
    const controller = await spawnWindowsJobProcess(process.execPath, [providerScript], {
      runId,
      jobId,
      cwd: scratch,
      env: process.env,
      ...(await launchEvidence(process.execPath, scratch)),
      recoveryDescriptor: descriptor,
      recoverySecret: RECOVERY_SECRET,
      limits: {
        activeProcessLimit: 4,
        jobMemoryLimitBytes: 256 * 1024 * 1024,
        cpuTimeLimitMs: 30_000,
        outputLimitBytes,
      },
    });
    const assignedIdentity = controller.identity;
    process.kill(assignedIdentity.helperProcessId);
    await waitForProcessExit(assignedIdentity.helperProcessId);
    await waitForProcessExit(assignedIdentity.rootProcessId);
    recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    assert.ok(recovered.identity);
    assert.equal(recovered.identity.helperProcessId, assignedIdentity.helperProcessId);
    assert.equal(recovered.identity.rootProcessId, assignedIdentity.rootProcessId);
    const terminal = await recovered.wait();
    assert.equal(terminal.status, "blocked");
    assert.equal(terminal.cleanup, "active_process_zero");
    assert.equal(terminal.terminationVerified, true);
    assert.match(terminal.reason, /KILL_ON_JOB_CLOSE/i);
  } finally {
    if (recovered) await recovered.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("bootstrap erases recovery key immediately and assignment failure cleanup kills the created handle first", async () => {
  const [processSource, launcherSource] = await Promise.all([
    readFile(new URL("./windowsJobProcess.ts", import.meta.url), "utf8"),
    readFile(new URL("./windowsJobLauncher.ps1", import.meta.url), "utf8"),
  ]);
  const bootstrapSpawn = processSource.indexOf("const child = spawn(executable, args");
  const bootstrapErase = processSource.indexOf("delete process.env.${RECOVERY_AUTH_KEY_ENV}", bootstrapSpawn);
  assert.ok(bootstrapSpawn >= 0 && bootstrapErase > bootstrapSpawn);
  const assignmentCheck = launcherSource.indexOf("if (!IsProcessInJob(created.hProcess, jobHandle, out inJob))");
  const assignmentFlag = launcherSource.indexOf("processAssigned = true", assignmentCheck);
  assert.ok(assignmentCheck >= 0 && assignmentFlag > assignmentCheck);
  const catchStart = launcherSource.indexOf("catch\n        {", assignmentFlag);
  const directTermination = launcherSource.indexOf("TerminateUnassignedProcessAndWait(created.hProcess)", catchStart);
  const jobTermination = launcherSource.indexOf("TerminateJobAndWait(jobHandle)", directTermination);
  assert.ok(catchStart >= 0 && directTermination > catchStart && jobTermination > directTermination);
});

test("claim is acquired by helper so crash before starting proves no process created", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-claim-gap-${process.pid}-${Date.now()}`);
  const providerScript = path.join(scratch, "provider.mjs");
  const evidencePath = path.join(scratch, "provider-evidence.json");
  const runId = `claim-gap-run-${process.pid}-${Date.now()}`;
  const jobId = `claim-gap-job-${process.pid}-${Date.now()}`;
  const outputLimitBytes = 1024 * 1024;
  await mkdir(scratch, { recursive: true });
  await writeFile(providerScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(evidencePath)}, "spawned");`, "utf8");
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId,
    jobId,
    recoveryRoot: scratch,
    outputLimitBytes,
    recoverySecret: RECOVERY_SECRET,
  });
  let recovered;
  try {
    const spawning = spawnWindowsJobProcess(process.execPath, [providerScript], {
      runId,
      jobId,
      cwd: scratch,
      env: process.env,
      input: Buffer.alloc(16 * 1024 * 1024, 65),
      ...(await launchEvidence(process.execPath, scratch)),
      recoveryDescriptor: descriptor,
      recoverySecret: RECOVERY_SECRET,
      limits: {
        activeProcessLimit: 4,
        jobMemoryLimitBytes: 256 * 1024 * 1024,
        cpuTimeLimitMs: 30_000,
        outputLimitBytes,
      },
    });
    const claimEnvelope = await waitForJson(descriptor.claimPath, 20_000);
    const claim = signedEnvelopePayload(claimEnvelope);
    process.kill(claim.helperProcessId);
    await waitForProcessExit(claim.helperProcessId);
    await assert.rejects(spawning, (error) => error instanceof WindowsJobContainmentError);
    recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    const terminal = await recovered.wait();
    assert.equal(terminal.cleanup, "no_process_created");
    assert.equal(terminal.terminationVerified, true);
    await assert.rejects(readFile(evidencePath), (error) => error.code === "ENOENT");
  } finally {
    if (recovered) await recovered.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("native launch rejects runtime and payload mutation after helper claim", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  for (const mutationTarget of ["runtime", "payload"]) {
    const scratch = path.join(os.tmpdir(), `agent-os-job-mutation-${mutationTarget}-${process.pid}-${Date.now()}`);
    const runtimePath = path.join(scratch, "node-copy.exe");
    const providerScript = path.join(scratch, "provider.mjs");
    const evidencePath = path.join(scratch, "provider-evidence.json");
    const runId = `mutation-${mutationTarget}-run-${process.pid}-${Date.now()}`;
    const jobId = `mutation-${mutationTarget}-job-${process.pid}-${Date.now()}`;
    const outputLimitBytes = 1024 * 1024;
    await mkdir(scratch, { recursive: true });
    await copyFile(process.execPath, runtimePath);
    await writeFile(providerScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(evidencePath)}, "spawned");`, "utf8");
    const expectedExecutableFiles = await Promise.all([
      expectedFile(runtimePath, "runtime"),
      expectedFile(providerScript, "payload"),
    ]);
    const descriptor = await prepareWindowsJobRecoveryDescriptor({
      runId,
      jobId,
      recoveryRoot: scratch,
      outputLimitBytes,
      recoverySecret: RECOVERY_SECRET,
    });
    let recovered;
    try {
      const spawning = spawnWindowsJobProcess(runtimePath, [providerScript], {
        runId,
        jobId,
        cwd: scratch,
        env: process.env,
        input: Buffer.alloc(16 * 1024 * 1024, 66),
        ...(await launchEvidence(runtimePath, scratch, expectedExecutableFiles)),
        recoveryDescriptor: descriptor,
        recoverySecret: RECOVERY_SECRET,
        limits: {
          activeProcessLimit: 4,
          jobMemoryLimitBytes: 256 * 1024 * 1024,
          cpuTimeLimitMs: 30_000,
          outputLimitBytes,
        },
      });
      await waitForJson(descriptor.claimPath, 20_000);
      await writeFile(mutationTarget === "runtime" ? runtimePath : providerScript, "mutated", "utf8");
      await assert.rejects(
        spawning,
        (error) => error instanceof WindowsJobContainmentError && error.terminationVerified,
      );
      recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
      const terminal = await recovered.wait();
      assert.equal(terminal.cleanup, "active_process_zero");
      assert.match(terminal.reason, /executable (?:size|hash|identity)/iu);
      await assert.rejects(readFile(evidencePath), (error) => error.code === "ENOENT");
    } finally {
      if (recovered) await recovered.cleanupVerified().catch(() => null);
      await rm(scratch, { recursive: true, force: true });
    }
  }
});

test("helper death after recovery proves descendant cleanup through named Job active count", { skip: process.platform !== "win32", timeout: 75_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-recovered-helper-death-${process.pid}-${Date.now()}`);
  const providerScript = path.join(scratch, "provider.mjs");
  const processFile = path.join(scratch, "process.json");
  const runId = `recovered-helper-death-run-${process.pid}-${Date.now()}`;
  const jobId = `recovered-helper-death-job-${process.pid}-${Date.now()}`;
  const outputLimitBytes = 1024 * 1024;
  await mkdir(scratch, { recursive: true });
  await writeFile(providerScript, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
    'writeFileSync(process.argv[2], JSON.stringify({ root: process.pid, descendant: descendant.pid }));',
    'setInterval(() => {}, 1000);',
  ].join("\n"), "utf8");
  const descriptor = await prepareWindowsJobRecoveryDescriptor({ runId, jobId, recoveryRoot: scratch, outputLimitBytes, recoverySecret: RECOVERY_SECRET });
  let recovered;
  try {
    const controller = await spawnWindowsJobProcess(process.execPath, [providerScript, processFile], {
      runId, jobId, cwd: scratch, env: process.env, recoveryDescriptor: descriptor, recoverySecret: RECOVERY_SECRET,
      ...(await launchEvidence(process.execPath, scratch)),
      limits: { activeProcessLimit: 4, jobMemoryLimitBytes: 256 * 1024 * 1024, cpuTimeLimitMs: 30_000, outputLimitBytes },
    });
    const pids = await waitForJson(processFile, 20_000);
    recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    assert.equal(recovered.status.status, "ready");
    process.kill(controller.identity.helperProcessId);
    await waitForProcessExit(controller.identity.helperProcessId);
    const terminal = await recovered.wait();
    assert.equal(terminal.cleanup, "active_process_zero");
    assert.equal(terminal.terminationVerified, true);
    await waitForProcessExit(pids.root);
    await waitForProcessExit(pids.descendant);
  } finally {
    if (recovered) await recovered.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("recovery terminates surviving descendant when assigned root identity has exited", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-job-root-death-${process.pid}-${Date.now()}`);
  const providerScript = path.join(scratch, "provider.mjs");
  const processFile = path.join(scratch, "process.json");
  const runId = `root-death-run-${process.pid}-${Date.now()}`;
  const jobId = `root-death-job-${process.pid}-${Date.now()}`;
  const outputLimitBytes = 1024 * 1024;
  await mkdir(scratch, { recursive: true });
  await writeFile(providerScript, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
    'writeFileSync(process.argv[2], JSON.stringify({ root: process.pid, descendant: descendant.pid }));',
    'setInterval(() => {}, 1000);',
  ].join("\n"), "utf8");
  const descriptor = await prepareWindowsJobRecoveryDescriptor({ runId, jobId, recoveryRoot: scratch, outputLimitBytes, recoverySecret: RECOVERY_SECRET });
  let recovered;
  try {
    await spawnWindowsJobProcess(process.execPath, [providerScript, processFile], {
      runId, jobId, cwd: scratch, env: process.env, recoveryDescriptor: descriptor, recoverySecret: RECOVERY_SECRET,
      ...(await launchEvidence(process.execPath, scratch)),
      limits: { activeProcessLimit: 4, jobMemoryLimitBytes: 256 * 1024 * 1024, cpuTimeLimitMs: 30_000, outputLimitBytes },
    });
    const pids = await waitForJson(processFile, 20_000);
    process.kill(pids.root);
    await waitForProcessExit(pids.root);
    assert.doesNotThrow(() => process.kill(pids.descendant, 0));
    recovered = await recoverWindowsJobProcess(descriptor.descriptorPath, RECOVERY_SECRET);
    const terminal = await recovered.wait();
    assert.equal(terminal.cleanup, "active_process_zero");
    assert.equal(terminal.terminationVerified, true);
    await waitForProcessExit(pids.descendant);
  } finally {
    if (recovered) await recovered.cleanupVerified().catch(() => null);
    await rm(scratch, { recursive: true, force: true });
  }
});
