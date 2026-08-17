import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { gzipSync } from "node:zlib";

const PROTOCOL_VERSION = 1 as const;
const STATUS_PROTOCOL_VERSION = 2 as const;
const EMPTY_CHAIN_DIGEST_SHA256 = "0".repeat(64);
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;
const DEFAULT_DESCENDANT_GRACE_MS = 10_000;
const DEFAULT_RECOVERY_WATCHDOG_MS = 15_000;
const TERMINATION_DEADLINE_MS = 60_000;
const STATUS_POLL_MS = 20;
const MAX_IDENTIFIER_LENGTH = 128;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const RECOVERY_SECRET_ENV = "AGENT_OS_WORKBENCH_RECOVERY_SECRET";
const RECOVERY_AUTH_KEY_ENV = "AGENT_OS_RECOVERY_AUTH_KEY";
const RECOVERY_BOOTSTRAP_POWERSHELL_ENV = "AGENT_OS_RECOVERY_BOOTSTRAP_POWERSHELL";
const RECOVERY_BOOTSTRAP_ARGUMENTS_ENV = "AGENT_OS_RECOVERY_BOOTSTRAP_ARGUMENTS";
const JOURNAL_COMMIT_PATH_ENV = "AGENT_OS_JOURNAL_COMMIT_PATH";
const JOURNAL_COMMIT_DESIRED_PATH_ENV = "AGENT_OS_JOURNAL_COMMIT_DESIRED_PATH";
const JOURNAL_COMMIT_EXPECTED_PATH_ENV = "AGENT_OS_JOURNAL_COMMIT_EXPECTED_PATH";
const RECOVERY_AUTH_SCHEME = "hkdf-sha256+hmac-sha256" as const;
const RECOVERY_KEY_INFO_PREFIX = "agent-os/windows-job-recovery/v1";
const RECOVERY_DESCRIPTOR_PURPOSE = "descriptor";
const RECOVERY_SPECIFICATION_PURPOSE = "launch-specification";
const RECOVERY_STATUS_PURPOSE = "status";
const RECOVERY_CANCEL_PURPOSE = "cancel";
const RECOVERY_CLAIM_PURPOSE = "spawn-claim";
const RECOVERY_TERMINAL_CLAIM_PURPOSE = "controller-terminal-claim";
const RECOVERY_INPUT_PURPOSE = "stdin";
const RECOVERY_OUTPUT_PURPOSE = "stdout";
const RECOVERY_ERROR_PURPOSE = "stderr";
const RECOVERY_ENCRYPTION_SCHEME = "aes-256-cbc+hmac-sha256" as const;
const RECOVERY_ENCRYPTED_FILE_MAGIC = Buffer.from("AGOSENC1", "ascii");
const MIN_RECOVERY_SECRET_LENGTH = 32;
const CONTROLLER_TERMINAL_CLAIM_NAME = "controller-terminal.claim.json";
const CONTROLLER_TERMINAL_CLAIM_TEMP_PATTERN = /^\.controller-terminal-claim\.[a-f0-9-]+\.tmp$/u;
const CONTROLLER_TERMINAL_JOURNAL_TEMP_PATTERN = /^\.controller-terminal-journal\.[a-f0-9-]+\.tmp$/u;
const CONTROLLER_TERMINAL_JOURNAL_EXPECTED_TEMP_PATTERN = /^\.controller-terminal-journal\.[a-f0-9-]+\.expected\.tmp$/u;
const SPAWN_CLAIM_TEMP_PATTERN = /^\.spawn-claim\.[a-f0-9-]+\.tmp$/u;
const HELPER_STATUS_SNAPSHOT_TEMP_PATTERN = /^status\.json\.[1-9]\d*\.[1-9]\d*\.tmp$/u;
const HELPER_STATUS_SNAPSHOT_BACKUP_PATTERN = /^status\.json\.[1-9]\d*\.bak$/u;
const MAX_STATUS_SCRATCH_BYTES = 4 * 1024 * 1024;
const MAX_CONTROLLER_CLAIM_SCRATCH_BYTES = 64 * 1024;
const PRIVATE_HELPER_ENVIRONMENT = new Set([
  RECOVERY_SECRET_ENV,
  RECOVERY_AUTH_KEY_ENV,
  RECOVERY_BOOTSTRAP_POWERSHELL_ENV,
  RECOVERY_BOOTSTRAP_ARGUMENTS_ENV,
  JOURNAL_COMMIT_PATH_ENV,
  JOURNAL_COMMIT_DESIRED_PATH_ENV,
  JOURNAL_COMMIT_EXPECTED_PATH_ENV,
  "AGENT_OS_RECOVERY_BOOTSTRAP",
  "AGENT_OS_RECOVERY_HELPER",
  "AGENT_OS_RECOVERY_SPECIFICATION_PATH",
]);

const RECOVERY_BOOTSTRAP_SOURCE = [
  'const { spawn } = require("node:child_process");',
  `const executable = process.env.${RECOVERY_BOOTSTRAP_POWERSHELL_ENV};`,
  `const encodedArguments = process.env.${RECOVERY_BOOTSTRAP_ARGUMENTS_ENV};`,
  "if (!executable || !encodedArguments) process.exit(126);",
  "let args;",
  "try { args = JSON.parse(Buffer.from(encodedArguments, 'base64').toString('utf8')); } catch { process.exit(126); }",
  `delete process.env.${RECOVERY_BOOTSTRAP_POWERSHELL_ENV};`,
  `delete process.env.${RECOVERY_BOOTSTRAP_ARGUMENTS_ENV};`,
  "const child = spawn(executable, args, { env: process.env, windowsHide: true, stdio: 'ignore' });",
  `delete process.env.${RECOVERY_AUTH_KEY_ENV};`,
  "child.once('error', () => process.exit(127));",
  "child.once('exit', (code) => process.exit(Number.isInteger(code) ? code : 127));",
].join("");

export type WindowsJobContainmentErrorCode =
  | "windows_job_launcher_unavailable"
  | "windows_job_launcher_changed"
  | "windows_job_invalid_specification"
  | "windows_job_spawn_failed"
  | "windows_job_handshake_failed"
  | "windows_job_handshake_timeout"
  | "windows_job_protocol_invalid"
  | "windows_job_termination_unverified";

export class WindowsJobContainmentError extends Error {
  readonly code: WindowsJobContainmentErrorCode;
  readonly terminationVerified: boolean;
  readonly cleanup?: "active_process_zero" | "no_process_created";

  constructor(
    code: WindowsJobContainmentErrorCode,
    message: string,
    terminationVerified = false,
    cleanup?: "active_process_zero" | "no_process_created",
  ) {
    super(message);
    this.code = code;
    this.terminationVerified = terminationVerified;
    this.cleanup = cleanup;
    this.name = "WindowsJobContainmentError";
  }
}

export interface WindowsJobLauncherIdentity {
  schemaVersion: 1;
  powershellPath: string;
  powershellDevice: number;
  powershellInode: number;
  powershellSize: number;
  powershellModifiedMs: number;
  helperPath: string;
  helperDevice: number;
  helperInode: number;
  helperSize: number;
  helperModifiedMs: number;
  helperSha256: string;
}

export interface WindowsJobProcessIdentity {
  schemaVersion: 1;
  runId: string;
  jobId: string;
  jobName: string;
  helperProcessId: number;
  helperProcessStartedAtFileTime: string;
  rootProcessId: number;
  rootProcessStartedAtFileTime: string;
  assignmentVerified: true;
}

export type WindowsJobTerminalResult =
  | {
      status: "exited";
      exitCode: number;
      cleanup: "active_process_zero";
      terminationVerified: true;
    }
  | {
      status: "cancelled";
      exitCode: null;
      cleanup: "active_process_zero";
      terminationVerified: true;
    }
  | {
      status: "blocked";
      exitCode: null;
      cleanup: "active_process_zero" | "no_process_created";
      terminationVerified: true;
      reason: string;
    };

export interface WindowsJobWorkingDirectoryIdentity {
  absolutePath: string;
  device: number;
  inode: number;
  modifiedMs: number;
}

interface PinnedWindowsJobWorkingDirectoryIdentity {
  absolutePath: string;
  device: number;
  /** Exact unsigned 64-bit Windows file ID. JSON numbers cannot represent every FILE_ID value. */
  inode: string;
  modifiedMs: number;
}

export interface WindowsJobAuthenticatedStatusEvidence {
  journalGeneration: string;
  sequence: number;
  previousSequence: number;
  previousSnapshotDigestSha256: string;
  previousJournalDigestSha256: string;
  terminal: boolean;
  snapshotDigestSha256: string;
  journalDigestSha256: string;
  authenticatedPayloadDigestSha256: string;
  nativeTerminalDigestSha256: string | null;
  nativeTerminalState: "exited" | "cancelled" | "blocked" | null;
  nativeTerminalExitCode: number | null;
  terminationVerified: boolean;
  observedAt: string;
}

export type WindowsJobAuthenticatedStatusAcceptor = (
  evidence: WindowsJobAuthenticatedStatusEvidence,
) => Promise<void>;

export interface WindowsJobSpawnOptions {
  runId: string;
  jobId: string;
  cwd: string;
  expectedWorkingDirectory: WindowsJobWorkingDirectoryIdentity;
  env: NodeJS.ProcessEnv;
  input?: string;
  handshakeTimeoutMs?: number;
  descendantGraceMs?: number;
  launcherIdentity?: WindowsJobLauncherIdentity;
  /**
   * Every executable-chain file pinned by provider resolution. The native
   * launcher opens, hashes, and keeps these files non-writable immediately
   * through CreateProcess so runtime and shim payload cannot change in the
   * verification-to-spawn gap.
   */
  expectedExecutableFiles: readonly WindowsJobExpectedExecutableFile[];
  limits?: {
    activeProcessLimit: number;
    jobMemoryLimitBytes: number;
    cpuTimeLimitMs: number;
    outputLimitBytes?: number;
  };
  recoveryDescriptor?: WindowsJobRecoveryDescriptor;
  /**
   * Private launcher/server secret. It is never persisted or inherited by the
   * provider. When omitted, AGENT_OS_WORKBENCH_RECOVERY_SECRET is required.
   */
  recoverySecret?: string;
  /** Durable high-water gate invoked on the exact authenticated evidence before status-driven actions. */
  acceptAuthenticatedStatus?: WindowsJobAuthenticatedStatusAcceptor;
}

export interface WindowsJobExpectedExecutableFile {
  role: "configured" | "runtime" | "payload";
  absolutePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface WindowsJobRecoveryDescriptor {
  schemaVersion: 1;
  runId: string;
  jobId: string;
  /**
   * Public HKDF salt and a non-secret key identifier. The root and derived
   * authentication secrets are deliberately absent from this descriptor and
   * every recovery file.
   */
  authenticationScheme: typeof RECOVERY_AUTH_SCHEME;
  authenticationSaltBase64: string;
  authenticationKeyId: string;
  /** Opaque launch capability identifier. Authority remains the matching DB receipt. */
  launchAuthorizationId: string;
  launchGeneration: number;
  launchAttempt: number;
  journalGeneration: string;
  createdAt: string;
  supervisorProcessId: number;
  supervisorProcessStartedAtFileTime: string;
  controlDirectory: string;
  descriptorPath: string;
  statusPath: string;
  statusJournalPath: string;
  cancelPath: string;
  inputPath: string;
  outputPath: string;
  errorPath: string;
  claimPath: string;
  specificationPath: string;
  outputLimitBytes: number;
  descriptorHmacSha256: string;
}

export interface WindowsJobRecoveryPrepareOptions {
  runId: string;
  jobId: string;
  recoveryRoot: string;
  outputLimitBytes?: number;
  recoverySecret?: string;
  launchAuthorizationId?: string;
  launchGeneration?: number;
  launchAttempt?: number;
}

export interface WindowsJobRecoveryCleanupExpectation {
  runId: string;
  jobId: string;
  journalGeneration: string;
  statusSequence: number;
  previousStatusSequence: number;
  previousSnapshotDigestSha256: string;
  previousJournalDigestSha256: string;
  snapshotDigestSha256: string;
  journalDigestSha256: string;
  authenticatedPayloadDigestSha256: string;
  nativeTerminalDigestSha256: string;
  nativeTerminalStatus: "succeeded" | "failed" | "cancelled" | "blocked";
  nativeExitCode: number | null;
  terminationVerified: true;
  rootProcessId: number | null;
  rootProcessStartedAtFileTime: string | null;
  jobName: string | null;
  helperProcessId: number | null;
  helperProcessStartedAtFileTime: string | null;
}

export interface WindowsJobRecoveryCleanupOptions {
  recoveryRoot: string;
  recoverySecret: string;
  expected: WindowsJobRecoveryCleanupExpectation;
}

export interface WindowsJobRecoveryCleanupResult {
  result: "removed" | "already_absent";
  controlDirectory: string;
}

interface ProtocolStatus {
  schemaVersion: 2;
  sequence: number;
  previousSequence: number;
  previousSnapshotDigestSha256: string;
  previousJournalDigestSha256: string;
  journalGeneration: string;
  token?: string;
  runId: string;
  jobId: string;
  status: "starting" | "ready" | "stopping" | "exited" | "cancelled" | "blocked";
  jobName?: string;
  helperProcessId?: number;
  helperProcessStartedAtFileTime?: string;
  rootProcessId?: number;
  rootProcessStartedAtFileTime?: string;
  assignmentVerified?: boolean;
  exitCode?: number | null;
  cleanup: "active_process_zero" | "no_process_created" | "pending";
  terminationVerified: boolean;
  reason?: string;
  terminationRequestedAt?: string | null;
  terminationDeadlineAt?: string | null;
  encryptedStdoutBytes: number | null;
  encryptedStdoutDigestSha256: string | null;
  encryptedStderrBytes: number | null;
  encryptedStderrDigestSha256: string | null;
  nativeTerminalDigestSha256: string | null;
}

interface CancellationRequest {
  schemaVersion: 1;
  token?: string;
  runId: string;
  jobId: string;
  rootProcessId?: number;
  rootProcessStartedAtFileTime?: string;
}

interface SpawnClaim {
  schemaVersion: 1;
  kind: "helper" | "controller_revoke";
  runId: string;
  jobId: string;
  launchAuthorizationId: string;
  launchGeneration: number;
  launchAttempt: number;
  journalGeneration: string;
  descriptorHmacSha256: string;
  helperProcessId?: number;
  helperProcessStartedAtFileTime?: string;
  controllerProcessId?: number;
  controllerProcessStartedAtFileTime?: string;
  createdAt: string;
}

type ProtocolExpectation =
  | { mode: "bearer"; token: string; runId: string; jobId: string; journalGeneration: string }
  | { mode: "hmac"; authenticationKey: Buffer; runId: string; jobId: string; journalGeneration: string };

interface SignedRecoveryEnvelope {
  schemaVersion: 1;
  authenticationScheme: typeof RECOVERY_AUTH_SCHEME;
  purpose: string;
  payloadBase64: string;
  hmacSha256: string;
}

interface EncryptedRecoveryEnvelope {
  schemaVersion: 1;
  authenticationScheme: typeof RECOVERY_AUTH_SCHEME;
  encryptionScheme: typeof RECOVERY_ENCRYPTION_SCHEME;
  purpose: string;
  ivBase64: string;
  ciphertextBase64: string;
  hmacSha256: string;
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isLocalAbsolutePath(candidate: string): boolean {
  return path.isAbsolute(candidate) && !/^(?:\\\\|\\\\\?\\|\\\\\.\\|\/\/)/u.test(candidate);
}

function bundledHelperPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "windowsJobLauncher.ps1");
}

function sha256FileSync(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      `${name} must be a positive safe integer.`,
    );
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      `${name} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function validIdentifier(value: string, name: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
    || !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      `${name} must use 1-${MAX_IDENTIFIER_LENGTH} ASCII letters, digits, dot, underscore, or hyphen.`,
    );
  }
  return value;
}

function childEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!key || key.includes("\0") || key.includes("=") || value === undefined || value.includes("\0")) {
      if (value !== undefined) {
        throw new WindowsJobContainmentError(
          "windows_job_invalid_specification",
          "Windows Job child environment contains an invalid key or value.",
        );
      }
      continue;
    }
    if (PRIVATE_HELPER_ENVIRONMENT.has(key.toUpperCase())) continue;
    result[key] = value;
  }
  return result;
}

function expectedExecutableFiles(
  executable: string,
  supplied: readonly WindowsJobExpectedExecutableFile[],
): WindowsJobExpectedExecutableFile[] {
  const canonicalExecutable = realpathSync.native(executable);
  if (!Array.isArray(supplied) || supplied.length === 0) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      "Windows Job expected executable identity is required.",
    );
  }
  const candidates = supplied;
  const seen = new Set<string>();
  const normalized = candidates.map((candidate) => {
    if (
      !["configured", "runtime", "payload"].includes(candidate.role)
      || !isLocalAbsolutePath(candidate.absolutePath)
      || !/^[a-f0-9]{64}$/iu.test(candidate.sha256)
      || !Number.isSafeInteger(candidate.sizeBytes)
      || candidate.sizeBytes < 0
    ) {
      throw new WindowsJobContainmentError(
        "windows_job_invalid_specification",
        "Windows Job expected executable identity is invalid.",
      );
    }
    const canonical = realpathSync.native(candidate.absolutePath);
    const key = canonical.toLowerCase();
    if (!sameWindowsPath(canonical, candidate.absolutePath) || seen.has(key)) {
      throw new WindowsJobContainmentError(
        "windows_job_invalid_specification",
        "Windows Job expected executable identity contains a reparse alias or duplicate path.",
      );
    }
    seen.add(key);
    return {
      role: candidate.role,
      absolutePath: canonical,
      sha256: candidate.sha256.toLowerCase(),
      sizeBytes: candidate.sizeBytes,
    };
  });
  if (!normalized.some((candidate) => sameWindowsPath(candidate.absolutePath, canonicalExecutable))) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      "Windows Job launch executable is absent from expected executable identity.",
    );
  }
  return normalized;
}

function expectedWorkingDirectory(
  cwd: string,
  supplied: WindowsJobWorkingDirectoryIdentity,
): PinnedWindowsJobWorkingDirectoryIdentity {
  if (
    !supplied
    || !isLocalAbsolutePath(supplied.absolutePath)
    || !Number.isSafeInteger(supplied.device)
    || supplied.device < 0
    || !Number.isInteger(supplied.inode)
    || supplied.inode < 0
    || !Number.isFinite(supplied.modifiedMs)
  ) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      "Windows Job expected working-directory identity is invalid.",
    );
  }
  try {
    const canonicalCwd = realpathSync.native(cwd);
    const canonicalExpected = realpathSync.native(supplied.absolutePath);
    const link = lstatSync(supplied.absolutePath);
    const information = statSync(canonicalExpected);
    const exactInformation = statSync(canonicalExpected, { bigint: true });
    if (
      link.isSymbolicLink()
      || !information.isDirectory()
      || !sameWindowsPath(cwd, canonicalCwd)
      || !sameWindowsPath(canonicalExpected, supplied.absolutePath)
      || !sameWindowsPath(canonicalCwd, canonicalExpected)
      || information.dev !== supplied.device
      || information.ino !== supplied.inode
      || Number(exactInformation.dev) !== information.dev
      || Number(exactInformation.ino) !== information.ino
    ) throw new Error("working-directory identity mismatch");
    return {
      absolutePath: canonicalExpected,
      device: Number(exactInformation.dev),
      inode: exactInformation.ino.toString(10),
      modifiedMs: supplied.modifiedMs,
    };
  } catch (error) {
    if (error instanceof WindowsJobContainmentError) throw error;
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      "Windows Job working directory is missing, reparse-backed, or changed after approval.",
    );
  }
}

function recoverySecret(explicit?: string): string {
  const value = explicit ?? process.env[RECOVERY_SECRET_ENV];
  if (typeof value !== "string" || value.length < MIN_RECOVERY_SECRET_LENGTH || value.includes("\0")) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      `Windows Job recovery requires a private ${RECOVERY_SECRET_ENV} value of at least ${MIN_RECOVERY_SECRET_LENGTH} characters.`,
    );
  }
  return value;
}

function recoveryKeyId(secret: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update("agent-os/windows-job-recovery/key-id/v1", "utf8")
    .digest("hex");
}

function deriveRecoveryAuthenticationKey(
  secret: string,
  saltBase64: string,
  runId: string,
  jobId: string,
): Buffer {
  let salt: Buffer;
  try {
    salt = Buffer.from(saltBase64, "base64");
  } catch {
    salt = Buffer.alloc(0);
  }
  if (salt.byteLength !== 32 || salt.toString("base64") !== saltBase64) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      "Windows Job recovery authentication salt is invalid.",
    );
  }
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    salt,
    Buffer.from(`${RECOVERY_KEY_INFO_PREFIX}\0${runId}\0${jobId}`, "utf8"),
    32,
  ));
}

function recoveryHmac(authenticationKey: Buffer, purpose: string, payload: Buffer): string {
  return createHmac("sha256", authenticationKey)
    .update(purpose, "utf8")
    .update(Buffer.from([0]))
    .update(payload)
    .digest("hex");
}

function deriveRecoveryPurposeKey(authenticationKey: Buffer, purpose: string): Buffer {
  return createHmac("sha256", authenticationKey)
    .update("agent-os/windows-job-recovery/purpose-key/v1", "utf8")
    .update(Buffer.from([0]))
    .update(purpose, "utf8")
    .digest();
}

function recoveryCiphertextHmac(
  authenticationKey: Buffer,
  purpose: string,
  iv: Buffer,
  ciphertext: Buffer,
): string {
  const macKey = deriveRecoveryPurposeKey(authenticationKey, `mac/${purpose}`);
  return createHmac("sha256", macKey)
    .update(purpose, "utf8")
    .update(Buffer.from([0]))
    .update(iv)
    .update(ciphertext)
    .digest("hex");
}

function encryptedRecoveryEnvelope(
  purpose: string,
  payload: unknown,
  authenticationKey: Buffer,
): EncryptedRecoveryEnvelope {
  const iv = randomBytes(16);
  const encryptionKey = deriveRecoveryPurposeKey(authenticationKey, `encryption/${purpose}`);
  const cipher = createCipheriv("aes-256-cbc", encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  return {
    schemaVersion: PROTOCOL_VERSION,
    authenticationScheme: RECOVERY_AUTH_SCHEME,
    encryptionScheme: RECOVERY_ENCRYPTION_SCHEME,
    purpose,
    ivBase64: iv.toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
    hmacSha256: recoveryCiphertextHmac(authenticationKey, purpose, iv, ciphertext),
  };
}

function encryptRecoveryFileBytes(
  purpose: string,
  payload: Buffer,
  authenticationKey: Buffer,
): Buffer {
  const iv = randomBytes(16);
  const encryptionKey = deriveRecoveryPurposeKey(authenticationKey, `encryption/${purpose}`);
  const cipher = createCipheriv("aes-256-cbc", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const authenticated = Buffer.concat([RECOVERY_ENCRYPTED_FILE_MAGIC, iv, ciphertext]);
  const tag = Buffer.from(
    recoveryCiphertextHmac(authenticationKey, purpose, iv, ciphertext),
    "hex",
  );
  return Buffer.concat([authenticated, tag]);
}

function decryptRecoveryFileBytes(
  purpose: string,
  payload: Buffer,
  authenticationKey: Buffer,
): Buffer {
  if (
    payload.byteLength < RECOVERY_ENCRYPTED_FILE_MAGIC.byteLength + 16 + 16 + 32
    || !payload.subarray(0, RECOVERY_ENCRYPTED_FILE_MAGIC.byteLength).equals(RECOVERY_ENCRYPTED_FILE_MAGIC)
  ) {
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      `Windows Job encrypted ${purpose} artifact is invalid.`,
    );
  }
  const ivStart = RECOVERY_ENCRYPTED_FILE_MAGIC.byteLength;
  const ciphertextStart = ivStart + 16;
  const tagStart = payload.byteLength - 32;
  const iv = payload.subarray(ivStart, ciphertextStart);
  const ciphertext = payload.subarray(ciphertextStart, tagStart);
  const actualTag = payload.subarray(tagStart);
  const expectedTag = Buffer.from(
    recoveryCiphertextHmac(authenticationKey, purpose, iv, ciphertext),
    "hex",
  );
  if (!timingSafeEqual(actualTag, expectedTag)) {
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      `Windows Job encrypted ${purpose} artifact failed integrity validation.`,
    );
  }
  try {
    const decryptionKey = deriveRecoveryPurposeKey(authenticationKey, `encryption/${purpose}`);
    const decipher = createDecipheriv("aes-256-cbc", decryptionKey, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      `Windows Job encrypted ${purpose} artifact could not be decrypted.`,
    );
  }
}

function decryptTerminalArtifactOrDrop(
  purpose: string,
  payload: Buffer,
  authenticationKey: Buffer,
  terminalStatus?: ProtocolStatus,
): Buffer {
  try {
    return decryptRecoveryFileBytes(purpose, payload, authenticationKey);
  } catch (error) {
    if (
      terminalStatus?.status !== "blocked"
      || !terminalStatus.terminationVerified
      || !/KILL_ON_JOB_CLOSE/u.test(terminalStatus.reason ?? "")
    ) throw error;
    // Controller force cleanup can terminate the helper after artifact bytes
    // were written but before their authentication tag was appended. Exact
    // terminal evidence authenticates those bytes; both controller paths drop
    // the unauthenticated artifact instead of reporting contradictory results.
    return Buffer.alloc(0);
  }
}

function hmacMatches(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(actual) || !/^[a-f0-9]{64}$/u.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function signedRecoveryEnvelope(
  purpose: string,
  payload: unknown,
  authenticationKey: Buffer,
): SignedRecoveryEnvelope {
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    schemaVersion: PROTOCOL_VERSION,
    authenticationScheme: RECOVERY_AUTH_SCHEME,
    purpose,
    payloadBase64: payloadBytes.toString("base64"),
    hmacSha256: recoveryHmac(authenticationKey, purpose, payloadBytes),
  };
}

interface VerifiedSignedRecoveryEnvelope {
  value: unknown;
  payloadBytes: Buffer;
}

function verifySignedRecoveryEnvelopeWithPayload(
  raw: unknown,
  purpose: string,
  authenticationKey: Buffer,
): VerifiedSignedRecoveryEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const envelope = raw as Partial<SignedRecoveryEnvelope>;
  if (
    envelope.schemaVersion !== PROTOCOL_VERSION
    || envelope.authenticationScheme !== RECOVERY_AUTH_SCHEME
    || envelope.purpose !== purpose
    || typeof envelope.payloadBase64 !== "string"
    || typeof envelope.hmacSha256 !== "string"
  ) return null;
  let payload: Buffer;
  try {
    payload = Buffer.from(envelope.payloadBase64, "base64");
    if (payload.toString("base64") !== envelope.payloadBase64) return null;
  } catch {
    return null;
  }
  const expectedHmac = recoveryHmac(authenticationKey, purpose, payload);
  if (!hmacMatches(envelope.hmacSha256, expectedHmac)) return null;
  try {
    return {
      value: JSON.parse(payload.toString("utf8")) as unknown,
      payloadBytes: payload,
    };
  } catch {
    return null;
  }
}

function verifySignedRecoveryEnvelope(
  raw: unknown,
  purpose: string,
  authenticationKey: Buffer,
): unknown | null {
  return verifySignedRecoveryEnvelopeWithPayload(raw, purpose, authenticationKey)?.value ?? null;
}

function statusIsTerminal(status: ProtocolStatus): boolean {
  return status.status === "exited"
    || status.status === "cancelled"
    || (
      status.status === "blocked"
      && status.terminationVerified
      && cleanupIsVerified(status)
    );
}

function cleanupIsVerified(
  status: ProtocolStatus,
): status is ProtocolStatus & { cleanup: "active_process_zero" | "no_process_created" } {
  return status.cleanup === "active_process_zero" || status.cleanup === "no_process_created";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nativeTerminalFacts(status: ProtocolStatus): Record<string, unknown> {
  const facts: Record<string, unknown> = {
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
  return Object.fromEntries(Object.entries(facts).sort(([left], [right]) => left.localeCompare(right)));
}

function terminationWindowIsValid(value: Partial<ProtocolStatus>): boolean {
  const requested = value.terminationRequestedAt;
  const deadline = value.terminationDeadlineAt;
  const requestedPresent = typeof requested === "string";
  const deadlinePresent = typeof deadline === "string";
  if (requestedPresent !== deadlinePresent) return false;
  if (!requestedPresent) {
    return (requested === undefined || requested === null)
      && (deadline === undefined || deadline === null);
  }
  const requestedAt = Date.parse(requested);
  const deadlineAt = Date.parse(deadline as string);
  return Number.isFinite(requestedAt)
    && Number.isFinite(deadlineAt)
    && deadlineAt - requestedAt === TERMINATION_DEADLINE_MS;
}

function terminationWindowTransitionIsValid(
  previous: ProtocolStatus | null,
  current: ProtocolStatus,
): boolean {
  const previousRequested = previous?.terminationRequestedAt ?? null;
  const previousDeadline = previous?.terminationDeadlineAt ?? null;
  const currentRequested = current.terminationRequestedAt ?? null;
  const currentDeadline = current.terminationDeadlineAt ?? null;
  if (previousRequested === null && previousDeadline === null) {
    return currentRequested === null && currentDeadline === null
      || (
        current.status === "stopping"
        && typeof currentRequested === "string"
        && typeof currentDeadline === "string"
      );
  }
  return currentRequested === previousRequested && currentDeadline === previousDeadline;
}

export function isWindowsJobStoppingDeadlineActive(
  status: Pick<WindowsJobProcessStatusSnapshot, "status" | "terminationDeadlineAt">,
  nowMs = Date.now(),
): boolean {
  if (status.status !== "stopping") return true;
  if (typeof status.terminationDeadlineAt !== "string") return false;
  const deadlineAt = Date.parse(status.terminationDeadlineAt);
  return Number.isFinite(deadlineAt) && nowMs < deadlineAt;
}

export function isWindowsJobControllerForceAllowed(
  status: Pick<WindowsJobProcessStatusSnapshot, "status" | "terminationDeadlineAt">,
  nowMs = Date.now(),
): boolean {
  return status.status !== "stopping" || !isWindowsJobStoppingDeadlineActive(status, nowMs);
}

function nativeTerminalDigest(status: ProtocolStatus): string {
  return sha256Bytes(Buffer.from(JSON.stringify(nativeTerminalFacts(status)), "utf8"));
}

function parseProtocolStatus(
  raw: unknown,
  expected: ProtocolExpectation,
): ProtocolStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<ProtocolStatus>;
  if (
    value.schemaVersion !== STATUS_PROTOCOL_VERSION
    || !Number.isSafeInteger(value.sequence)
    || (value.sequence ?? 0) <= 0
    || !Number.isSafeInteger(value.previousSequence)
    || (value.previousSequence ?? -1) < 0
    || !isSha256(value.previousSnapshotDigestSha256)
    || !isSha256(value.previousJournalDigestSha256)
    || value.journalGeneration !== expected.journalGeneration
    || (expected.mode === "bearer" && value.token !== expected.token)
    || (expected.mode === "hmac" && value.token !== undefined)
    || value.runId !== expected.runId
    || value.jobId !== expected.jobId
    || !["starting", "ready", "stopping", "exited", "cancelled", "blocked"].includes(value.status ?? "")
    || !["active_process_zero", "no_process_created", "pending"].includes(value.cleanup ?? "")
    || typeof value.terminationVerified !== "boolean"
    || !terminationWindowIsValid(value)
  ) return null;

  if (!["starting", "blocked"].includes(value.status ?? "") || value.assignmentVerified === true) {
    if (
      typeof value.jobName !== "string"
      || !Number.isSafeInteger(value.helperProcessId)
      || (value.helperProcessId ?? 0) <= 0
      || typeof value.helperProcessStartedAtFileTime !== "string"
      || !/^\d+$/u.test(value.helperProcessStartedAtFileTime)
      || !Number.isSafeInteger(value.rootProcessId)
      || (value.rootProcessId ?? 0) <= 0
      || typeof value.rootProcessStartedAtFileTime !== "string"
      || !/^\d+$/u.test(value.rootProcessStartedAtFileTime)
      || value.assignmentVerified !== true
    ) return null;
  }

  if (value.status === "starting") {
    if (
      !Number.isSafeInteger(value.helperProcessId)
      || (value.helperProcessId ?? 0) <= 0
      || typeof value.helperProcessStartedAtFileTime !== "string"
      || !/^\d+$/u.test(value.helperProcessStartedAtFileTime)
      || value.assignmentVerified !== false
      || value.cleanup !== "pending"
      || value.terminationVerified
    ) return null;
  }

  if (value.status === "ready" && (value.cleanup !== "pending" || value.terminationVerified !== false)) return null;

  if (value.status === "exited") {
    if (!Number.isSafeInteger(value.exitCode) || value.cleanup !== "active_process_zero" || !value.terminationVerified) return null;
  }
  if (value.status === "cancelled") {
    if (value.exitCode !== null || value.cleanup !== "active_process_zero" || !value.terminationVerified) return null;
  }
  if (value.status === "stopping") {
    if (value.exitCode !== null || value.cleanup !== "pending" || value.terminationVerified) return null;
  }
  if (value.status === "blocked") {
    if (value.exitCode !== null || typeof value.reason !== "string" || value.reason.length === 0) return null;
    if (value.terminationVerified !== cleanupIsVerified(value as ProtocolStatus)) return null;
  }

  const terminal = statusIsTerminal(value as ProtocolStatus);
  if (terminal) {
    if (
      !Number.isSafeInteger(value.encryptedStdoutBytes)
      || (value.encryptedStdoutBytes ?? -1) < 0
      || !isSha256(value.encryptedStdoutDigestSha256)
      || !Number.isSafeInteger(value.encryptedStderrBytes)
      || (value.encryptedStderrBytes ?? -1) < 0
      || !isSha256(value.encryptedStderrDigestSha256)
      || !isSha256(value.nativeTerminalDigestSha256)
      || nativeTerminalDigest(value as ProtocolStatus) !== value.nativeTerminalDigestSha256
    ) return null;
  } else if (
    value.encryptedStdoutBytes !== null
    || value.encryptedStdoutDigestSha256 !== null
    || value.encryptedStderrBytes !== null
    || value.encryptedStderrDigestSha256 !== null
    || value.nativeTerminalDigestSha256 !== null
  ) return null;
  return value as ProtocolStatus;
}

function terminalResult(status: ProtocolStatus): WindowsJobTerminalResult {
  if (!statusIsTerminal(status) || !status.terminationVerified || !cleanupIsVerified(status)) {
    throw new WindowsJobContainmentError(
      "windows_job_termination_unverified",
      "Windows Job status is not a verified terminal cleanup record.",
    );
  }
  if (status.status === "exited") {
    return {
      status: "exited",
      exitCode: status.exitCode!,
      cleanup: "active_process_zero",
      terminationVerified: true,
    };
  }
  if (status.status === "cancelled") {
    return {
      status: "cancelled",
      exitCode: null,
      cleanup: "active_process_zero",
      terminationVerified: true,
    };
  }
  return {
    status: "blocked",
    exitCode: null,
    cleanup: status.cleanup,
    terminationVerified: true,
    reason: status.reason ?? "Windows Job helper blocked without a reason.",
  };
}

export type WindowsJobProcessStatusSnapshot = Readonly<Omit<ProtocolStatus, "token">>;

function statusSnapshot(status: ProtocolStatus): WindowsJobProcessStatusSnapshot {
  const { token: _bearerSecret, ...snapshot } = status;
  return Object.freeze(snapshot);
}

function processIdentityFromStatus(status: ProtocolStatus): WindowsJobProcessIdentity | null {
  if (!status.assignmentVerified) return null;
  return {
    schemaVersion: PROTOCOL_VERSION,
    runId: status.runId,
    jobId: status.jobId,
    jobName: status.jobName!,
    helperProcessId: status.helperProcessId!,
    helperProcessStartedAtFileTime: status.helperProcessStartedAtFileTime!,
    rootProcessId: status.rootProcessId!,
    rootProcessStartedAtFileTime: status.rootProcessStartedAtFileTime!,
    assignmentVerified: true,
  };
}

function helperEnvironment(extra?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const keys = ["COMSPEC", "PATH", "PATHEXT", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR"];
  const result: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  Object.assign(result, extra);
  return result as NodeJS.ProcessEnv;
}

function launcherFiles(): { powershellPath: string; helperPath: string } {
  if (process.platform !== "win32") {
    throw new WindowsJobContainmentError(
      "windows_job_launcher_unavailable",
      "Windows Job Object launcher is available only on Windows.",
    );
  }
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot || !isLocalAbsolutePath(systemRoot)) {
    throw new WindowsJobContainmentError(
      "windows_job_launcher_unavailable",
      "Windows system root is unavailable or is not a local absolute path.",
    );
  }
  const powershellCandidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const helperCandidate = bundledHelperPath();
  try {
    const powershellPath = realpathSync.native(powershellCandidate);
    const helperPath = realpathSync.native(helperCandidate);
    const canonicalRoot = realpathSync.native(systemRoot);
    if (
      !sameWindowsPath(powershellPath, powershellCandidate)
      || !sameWindowsPath(helperPath, helperCandidate)
      || !powershellPath.toLowerCase().startsWith(`${canonicalRoot.toLowerCase()}${path.sep}`)
      || !statSync(powershellPath).isFile()
      || !statSync(helperPath).isFile()
    ) throw new Error("launcher path identity mismatch");
    return { powershellPath, helperPath };
  } catch {
    throw new WindowsJobContainmentError(
      "windows_job_launcher_unavailable",
      "Built-in Windows PowerShell or bundled Job Object helper is missing, reparse-backed, or invalid.",
    );
  }
}

export function captureWindowsJobLauncherIdentitySync(): WindowsJobLauncherIdentity {
  const { powershellPath, helperPath } = launcherFiles();
  const powershell = statSync(powershellPath);
  const helper = statSync(helperPath);
  return {
    schemaVersion: PROTOCOL_VERSION,
    powershellPath,
    powershellDevice: powershell.dev,
    powershellInode: powershell.ino,
    powershellSize: powershell.size,
    powershellModifiedMs: powershell.mtimeMs,
    helperPath,
    helperDevice: helper.dev,
    helperInode: helper.ino,
    helperSize: helper.size,
    helperModifiedMs: helper.mtimeMs,
    helperSha256: sha256FileSync(helperPath),
  };
}

export function assertWindowsJobLauncherIdentityBindingSync(identity: WindowsJobLauncherIdentity): void {
  try {
    const current = captureWindowsJobLauncherIdentitySync();
    if (
      identity.schemaVersion !== current.schemaVersion
      || !sameWindowsPath(identity.powershellPath, current.powershellPath)
      || identity.powershellDevice !== current.powershellDevice
      || identity.powershellInode !== current.powershellInode
      || identity.powershellSize !== current.powershellSize
      || identity.powershellModifiedMs !== current.powershellModifiedMs
      || !sameWindowsPath(identity.helperPath, current.helperPath)
      || identity.helperDevice !== current.helperDevice
      || identity.helperInode !== current.helperInode
      || identity.helperSize !== current.helperSize
      || identity.helperModifiedMs !== current.helperModifiedMs
      || identity.helperSha256 !== current.helperSha256
    ) throw new Error("launcher identity changed");
  } catch (error) {
    if (error instanceof WindowsJobContainmentError && error.code === "windows_job_launcher_unavailable") throw error;
    throw new WindowsJobContainmentError(
      "windows_job_launcher_changed",
      "Windows Job Object launcher identity changed after verification; spawn denied.",
    );
  }
}

function inMemoryHelperCommand(
  identity: WindowsJobLauncherIdentity,
  operation: "launch" | "probe" | "journal_commit" = "launch",
): string {
  const helperBytes = readFileSync(identity.helperPath);
  const observedHash = createHash("sha256").update(helperBytes).digest("hex");
  if (observedHash !== identity.helperSha256) {
    throw new WindowsJobContainmentError(
      "windows_job_launcher_changed",
      "Windows Job Object helper bytes changed while preparing the in-memory launch; spawn denied.",
    );
  }
  const compressedBase64 = gzipSync(helperBytes, { level: 9 }).toString("base64");
  const entryPoint = operation === "launch"
    ? [
        "$specificationPath=[Environment]::GetEnvironmentVariable('AGENT_OS_RECOVERY_SPECIFICATION_PATH')",
        ". $block -SpecificationPath $specificationPath",
      ]
    : operation === "probe" ? [
        "$probeJobName=[Environment]::GetEnvironmentVariable('AGENT_OS_JOB_PROBE_NAME')",
        "$terminateProbe=[Environment]::GetEnvironmentVariable('AGENT_OS_JOB_PROBE_TERMINATE') -eq '1'",
        ". $block -ProbeJobName $probeJobName -TerminateProbe:$terminateProbe",
      ] : [
        `$journalCommitPath=[Environment]::GetEnvironmentVariable('${JOURNAL_COMMIT_PATH_ENV}')`,
        `$journalCommitDesiredPath=[Environment]::GetEnvironmentVariable('${JOURNAL_COMMIT_DESIRED_PATH_ENV}')`,
        `$journalCommitExpectedPath=[Environment]::GetEnvironmentVariable('${JOURNAL_COMMIT_EXPECTED_PATH_ENV}')`,
        ". $block -JournalCommitPath $journalCommitPath -JournalCommitDesiredPath $journalCommitDesiredPath -JournalCommitExpectedPath $journalCommitExpectedPath",
      ];
  const command = [
    `$compressed=[Convert]::FromBase64String('${compressedBase64}')`,
    "$memory=[IO.MemoryStream]::new($compressed)",
    "$gzip=[IO.Compression.GZipStream]::new($memory,[IO.Compression.CompressionMode]::Decompress)",
    "$helperMemory=[IO.MemoryStream]::new()",
    "$gzip.CopyTo($helperMemory)",
    "$gzip.Dispose()",
    "$memory.Dispose()",
    "$helperBytes=$helperMemory.ToArray()",
    "$helperMemory.Dispose()",
    "$sha=[Security.Cryptography.SHA256]::Create()",
    "$observed=(($sha.ComputeHash($helperBytes)|ForEach-Object{$_.ToString('x2')})-join '')",
    "$sha.Dispose()",
    `if($observed -ne '${identity.helperSha256}'){throw 'Verified Windows Job helper payload hash changed before execution.'}`,
    "$source=[Text.UTF8Encoding]::new($false,$true).GetString($helperBytes)",
    "$block=[ScriptBlock]::Create($source)",
    ...entryPoint,
  ].join(";");
  if (command.length > 30_000) {
    throw new WindowsJobContainmentError(
      "windows_job_launcher_changed",
      "Windows Job Object helper cannot be launched from verified in-memory bytes within the Windows command-line limit.",
    );
  }
  return command;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = JSON.stringify(value);
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, filePath);
    } catch (error) {
      if (["EACCES", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          try {
            if (await readFile(filePath, "utf8") === serialized) return;
          } catch {
            // A competing atomic replace may not be visible yet.
          }
          if (attempt < 9) await delay(STATUS_POLL_MS);
        }
      }
      throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function atomicReplaceDurableBytes(
  filePath: string,
  desiredBytes: Buffer,
  expectedPreviousBytes: Buffer,
): Promise<void> {
  const temporary = path.join(
    path.dirname(filePath),
    `.controller-terminal-journal.${randomUUID()}.tmp`,
  );
  const expectedTemporary = temporary.replace(/\.tmp$/u, ".expected.tmp");
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(desiredBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const expectedHandle = await open(expectedTemporary, "wx");
    try {
      await expectedHandle.writeFile(expectedPreviousBytes);
      await expectedHandle.sync();
    } finally {
      await expectedHandle.close();
    }
    const launcherIdentity = captureWindowsJobLauncherIdentitySync();
    assertWindowsJobLauncherIdentityBindingSync(launcherIdentity);
    const child = spawn(
      launcherIdentity.powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        inMemoryHelperCommand(launcherIdentity, "journal_commit"),
      ],
      {
        cwd: path.dirname(launcherIdentity.helperPath),
        env: helperEnvironment({
          [JOURNAL_COMMIT_PATH_ENV]: filePath,
          [JOURNAL_COMMIT_DESIRED_PATH_ENV]: temporary,
          [JOURNAL_COMMIT_EXPECTED_PATH_ENV]: expectedTemporary,
        }),
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(Object.assign(new Error("Windows Job journal commit helper timed out."), { code: "EBUSY" }));
      }, 10_000);
      timeout.unref();
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(Number.isInteger(code) ? code! : 76);
      });
    });
    if (exitCode === 0) return;
    if (exitCode === 73 || exitCode === 76) {
      throw new WindowsJobContainmentError(
        "windows_job_protocol_invalid",
        exitCode === 73
          ? "Windows Job controller terminal journal changed to an unexpected prefix during durable commit."
          : "Windows Job verified journal commit helper failed closed.",
      );
    }
    if (exitCode === 75) {
      throw Object.assign(new Error("Windows Job journal commit remained busy."), { code: "EBUSY" });
    }
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      "Windows Job verified journal commit helper returned an invalid result.",
    );
  } finally {
    await Promise.all([
      rm(temporary, { force: true }).catch(() => undefined),
      rm(expectedTemporary, { force: true }).catch(() => undefined),
    ]);
  }
}

async function atomicWriteProtocolJson(
  filePath: string,
  purpose: string,
  value: unknown,
  expected: ProtocolExpectation,
): Promise<void> {
  await atomicWriteJson(
    filePath,
    expected.mode === "hmac"
      ? signedRecoveryEnvelope(purpose, value, expected.authenticationKey)
      : value,
  );
}

async function atomicWriteEncryptedProtocolJson(
  filePath: string,
  purpose: string,
  value: unknown,
  authenticationKey: Buffer,
): Promise<void> {
  await atomicWriteJson(
    filePath,
    encryptedRecoveryEnvelope(purpose, value, authenticationKey),
  );
}

type WindowsJobRecoveryDescriptorCore = Omit<WindowsJobRecoveryDescriptor, "descriptorHmacSha256">;

function recoveryDescriptorCore(descriptor: WindowsJobRecoveryDescriptor): WindowsJobRecoveryDescriptorCore {
  return {
    schemaVersion: PROTOCOL_VERSION,
    runId: descriptor.runId,
    jobId: descriptor.jobId,
    authenticationScheme: descriptor.authenticationScheme,
    authenticationSaltBase64: descriptor.authenticationSaltBase64,
    authenticationKeyId: descriptor.authenticationKeyId,
    launchAuthorizationId: descriptor.launchAuthorizationId,
    launchGeneration: descriptor.launchGeneration,
    launchAttempt: descriptor.launchAttempt,
    journalGeneration: descriptor.journalGeneration,
    createdAt: descriptor.createdAt,
    supervisorProcessId: descriptor.supervisorProcessId,
    supervisorProcessStartedAtFileTime: descriptor.supervisorProcessStartedAtFileTime,
    controlDirectory: descriptor.controlDirectory,
    descriptorPath: descriptor.descriptorPath,
    statusPath: descriptor.statusPath,
    statusJournalPath: descriptor.statusJournalPath,
    cancelPath: descriptor.cancelPath,
    inputPath: descriptor.inputPath,
    outputPath: descriptor.outputPath,
    errorPath: descriptor.errorPath,
    claimPath: descriptor.claimPath,
    specificationPath: descriptor.specificationPath,
    outputLimitBytes: descriptor.outputLimitBytes,
  };
}

function recoveryDescriptorHmac(
  core: WindowsJobRecoveryDescriptorCore,
  authenticationKey: Buffer,
): string {
  return recoveryHmac(
    authenticationKey,
    RECOVERY_DESCRIPTOR_PURPOSE,
    Buffer.from(JSON.stringify(core), "utf8"),
  );
}

async function assertCanonicalDirectory(directoryPath: string, label: string): Promise<string> {
  if (!isLocalAbsolutePath(directoryPath)) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      `${label} must be a local absolute path.`,
    );
  }
  try {
    const canonical = await realpath(directoryPath);
    const information = await lstat(directoryPath);
    if (!information.isDirectory() || information.isSymbolicLink() || !sameWindowsPath(canonical, directoryPath)) {
      throw new Error("directory identity mismatch");
    }
    return canonical;
  } catch {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      `${label} must exist as a canonical local directory without a reparse-backed alias.`,
    );
  }
}

function deterministicRecoveryDirectoryName(runId: string, jobId: string): string {
  return `job-${createHash("sha256").update(`${runId}\0${jobId}`, "utf8").digest("hex")}`;
}

function windowsProcessStartedAtFileTimeSync(
  processId: number,
  launcherIdentity?: WindowsJobLauncherIdentity,
): string | null {
  if (process.platform !== "win32" || !Number.isSafeInteger(processId) || processId <= 0) return null;
  const launcher = launcherIdentity ?? captureWindowsJobLauncherIdentitySync();
  const script = [
    "$ErrorActionPreference='Stop'",
    "$processId=[Convert]::ToInt32([Environment]::GetEnvironmentVariable('AGENT_OS_IDENTITY_PID'))",
    "$process=Get-Process -Id $processId -ErrorAction Stop",
    "$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)",
  ].join(";");
  const result = spawnSync(
    launcher.powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: helperEnvironment({ AGENT_OS_IDENTITY_PID: String(processId) }),
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    },
  );
  const value = result.status === 0 && !result.error ? result.stdout.trim() : "";
  return /^\d+$/u.test(value) ? value : null;
}

function assertProcessIdentityAliveSync(
  processId: number,
  startedAtFileTime: string,
  launcherIdentity?: WindowsJobLauncherIdentity,
): boolean {
  const observed = windowsProcessStartedAtFileTimeSync(processId, launcherIdentity);
  return observed !== null && observed === startedAtFileTime;
}

function terminateProcessIdentitySync(
  processId: number,
  startedAtFileTime: string,
  launcherIdentity?: WindowsJobLauncherIdentity,
): boolean {
  if (!assertProcessIdentityAliveSync(processId, startedAtFileTime, launcherIdentity)) return true;
  const launcher = launcherIdentity ?? captureWindowsJobLauncherIdentitySync();
  assertWindowsJobLauncherIdentityBindingSync(launcher);
  const script = [
    "$ErrorActionPreference='Stop'",
    "$processId=[Convert]::ToInt32([Environment]::GetEnvironmentVariable('AGENT_OS_IDENTITY_PID'))",
    "$expected=[Environment]::GetEnvironmentVariable('AGENT_OS_IDENTITY_STARTED_AT')",
    "$process=Get-Process -Id $processId -ErrorAction Stop",
    "$observed=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)",
    "if($observed -ne $expected){exit 3}",
    "$process.Kill()",
    "if(-not $process.WaitForExit(10000)){exit 4}",
  ].join(";");
  const result = spawnSync(
    launcher.powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: helperEnvironment({
        AGENT_OS_IDENTITY_PID: String(processId),
        AGENT_OS_IDENTITY_STARTED_AT: startedAtFileTime,
      }),
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    },
  );
  return result.status === 0 && !result.error
    && !assertProcessIdentityAliveSync(processId, startedAtFileTime, launcher);
}

function probeWindowsJobActiveProcessCountSync(
  jobName: string,
  terminate: boolean,
  launcherIdentity?: WindowsJobLauncherIdentity,
): number | null {
  const launcher = launcherIdentity ?? captureWindowsJobLauncherIdentitySync();
  assertWindowsJobLauncherIdentityBindingSync(launcher);
  const result = spawnSync(
    launcher.powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      inMemoryHelperCommand(launcher, "probe"),
    ],
    {
      env: helperEnvironment({
        AGENT_OS_JOB_PROBE_NAME: jobName,
        AGENT_OS_JOB_PROBE_TERMINATE: terminate ? "1" : "0",
      }),
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    },
  );
  const value = result.status === 0 && !result.error ? result.stdout.trim().split(/\r?\n/u).at(-1) ?? "" : "";
  if (value === "-1") return null;
  if (!/^\d+$/u.test(value)) {
    throw new WindowsJobContainmentError(
      "windows_job_termination_unverified",
      "Windows Job active-process probe failed; cleanup remains unverified.",
    );
  }
  return Number(value);
}

export async function resolveWindowsJobRecoveryDescriptorPath(
  recoveryRoot: string,
  runIdValue: string,
  jobIdValue: string,
): Promise<string> {
  const recoveryRootCanonical = await assertCanonicalDirectory(recoveryRoot, "Windows Job recovery root");
  const runId = validIdentifier(runIdValue, "runId");
  const jobId = validIdentifier(jobIdValue, "jobId");
  return path.join(
    recoveryRootCanonical,
    deterministicRecoveryDirectoryName(runId, jobId),
    "descriptor.json",
  );
}

function hardenRecoveryDirectoryAcl(controlDirectory: string): void {
  if (process.platform !== "win32") return;
  const launcher = captureWindowsJobLauncherIdentitySync();
  const aclScript = [
    "$ErrorActionPreference = 'Stop'",
    "$directory = [Environment]::GetEnvironmentVariable('AGENT_OS_RECOVERY_DIRECTORY')",
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$security = [IO.Directory]::GetAccessControl($directory)",
    "$owner = ([Security.Principal.NTAccount] $security.Owner).Translate([Security.Principal.SecurityIdentifier])",
    "if ($owner.Value -ne $identity.Value) { throw 'Recovery directory owner does not match the current identity.' }",
    "$security.SetAccessRuleProtection($true, $false)",
    "$existingRules = @($security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
    "foreach ($existingRule in $existingRules) { $null = $security.RemoveAccessRuleSpecific($existingRule) }",
    "$rights = [Security.AccessControl.FileSystemRights]::FullControl",
    "$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
    "$rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)",
    "$null = $security.AddAccessRule($rule)",
    "[IO.Directory]::SetAccessControl($directory, $security)",
  ].join(";");
  const result = spawnSync(
    launcher.powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", aclScript],
    {
      env: {
        ...helperEnvironment({ AGENT_OS_RECOVERY_DIRECTORY: controlDirectory }),
      },
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || result.error) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      "Windows Job recovery directory ACL could not be restricted to the current Windows identity.",
    );
  }
}

function assertRecoveryDirectoryAcl(controlDirectory: string): void {
  if (process.platform !== "win32") return;
  const launcher = captureWindowsJobLauncherIdentitySync();
  const aclScript = [
    "$directory = [Environment]::GetEnvironmentVariable('AGENT_OS_RECOVERY_DIRECTORY')",
    "$current = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = [IO.Directory]::GetAccessControl($directory)",
    "if (-not $acl.AreAccessRulesProtected) { exit 3 }",
    "$owner = ([Security.Principal.NTAccount] $acl.Owner).Translate([Security.Principal.SecurityIdentifier])",
    "if ($owner.Value -ne $current.Value) { exit 4 }",
    "$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])",
    "$allowed = $false",
    "foreach ($rule in $rules) { if ($rule.IdentityReference.Value -ne $current.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { exit 5 }; if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $allowed = $true } }",
    "if (-not $allowed) { exit 6 }",
  ].join(";");
  const result = spawnSync(
    launcher.powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", aclScript],
    {
      env: helperEnvironment({ AGENT_OS_RECOVERY_DIRECTORY: controlDirectory }),
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || result.error) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      "Windows Job recovery directory ACL is not restricted to the current Windows identity.",
    );
  }
}

async function readVerifiedRecoveryDescriptor(
  descriptorPath: string,
  explicitRecoverySecret?: string,
): Promise<WindowsJobRecoveryDescriptor> {
  if (!isLocalAbsolutePath(descriptorPath)) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      "Windows Job recovery descriptor path must be local and absolute.",
    );
  }
  let descriptor: WindowsJobRecoveryDescriptor;
  try {
    const canonicalDescriptorPath = await realpath(descriptorPath);
    const descriptorInformation = await lstat(descriptorPath);
    if (
      !descriptorInformation.isFile()
      || descriptorInformation.isSymbolicLink()
      || !sameWindowsPath(canonicalDescriptorPath, descriptorPath)
    ) throw new Error("descriptor identity mismatch");
    descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as WindowsJobRecoveryDescriptor;
  } catch {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      "Windows Job recovery descriptor is missing, invalid, or reparse-backed.",
    );
  }

  const controlDirectory = await assertCanonicalDirectory(
    descriptor.controlDirectory,
    "Windows Job recovery control directory",
  );
  assertRecoveryDirectoryAcl(controlDirectory);
  const expectedPaths = {
    descriptorPath: path.join(controlDirectory, "descriptor.json"),
    statusPath: path.join(controlDirectory, "status.json"),
    statusJournalPath: path.join(controlDirectory, "status.journal.jsonl"),
    cancelPath: path.join(controlDirectory, "cancel.json"),
    inputPath: path.join(controlDirectory, "stdin.txt"),
    outputPath: path.join(controlDirectory, "stdout.bin"),
    errorPath: path.join(controlDirectory, "stderr.bin"),
    claimPath: path.join(controlDirectory, "spawn.claim.json"),
    specificationPath: path.join(controlDirectory, "launch-specification.json"),
  };
  const secret = recoverySecret(explicitRecoverySecret);
  let authenticationKey: Buffer;
  try {
    authenticationKey = deriveRecoveryAuthenticationKey(
      secret,
      descriptor.authenticationSaltBase64,
      descriptor.runId,
      descriptor.jobId,
    );
  } catch {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      "Windows Job recovery descriptor authentication metadata is invalid.",
    );
  }
  if (
    descriptor.schemaVersion !== PROTOCOL_VERSION
    || validIdentifier(descriptor.runId, "recovery runId") !== descriptor.runId
    || validIdentifier(descriptor.jobId, "recovery jobId") !== descriptor.jobId
    || descriptor.authenticationScheme !== RECOVERY_AUTH_SCHEME
    || typeof descriptor.authenticationSaltBase64 !== "string"
    || typeof descriptor.authenticationKeyId !== "string"
    || !hmacMatches(descriptor.authenticationKeyId, recoveryKeyId(secret))
    || typeof descriptor.launchAuthorizationId !== "string"
    || !/^[A-Za-z0-9_.-]{16,128}$/u.test(descriptor.launchAuthorizationId)
    || !Number.isSafeInteger(descriptor.launchGeneration)
    || descriptor.launchGeneration <= 0
    || !Number.isSafeInteger(descriptor.launchAttempt)
    || descriptor.launchAttempt <= 0
    || typeof descriptor.journalGeneration !== "string"
    || !/^[A-Za-z0-9_-]{22,128}$/u.test(descriptor.journalGeneration)
    || typeof descriptor.createdAt !== "string"
    || !Number.isFinite(Date.parse(descriptor.createdAt))
    || !Number.isSafeInteger(descriptor.supervisorProcessId)
    || descriptor.supervisorProcessId <= 0
    || typeof descriptor.supervisorProcessStartedAtFileTime !== "string"
    || !/^\d+$/u.test(descriptor.supervisorProcessStartedAtFileTime)
    || nonNegativeInteger(descriptor.outputLimitBytes, "recovery outputLimitBytes") !== descriptor.outputLimitBytes
    || !sameWindowsPath(descriptorPath, expectedPaths.descriptorPath)
    || Object.entries(expectedPaths).some(([key, expectedPath]) => (
      !sameWindowsPath(descriptor[key as keyof typeof expectedPaths], expectedPath)
    ))
    || typeof descriptor.descriptorHmacSha256 !== "string"
    || !hmacMatches(
      descriptor.descriptorHmacSha256,
      recoveryDescriptorHmac(recoveryDescriptorCore(descriptor), authenticationKey),
    )
  ) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      "Windows Job recovery descriptor failed path, identity, or integrity validation.",
    );
  }
  return { ...descriptor, controlDirectory };
}

export async function prepareWindowsJobRecoveryDescriptor(
  options: WindowsJobRecoveryPrepareOptions,
): Promise<WindowsJobRecoveryDescriptor> {
  const recoveryRoot = await assertCanonicalDirectory(options.recoveryRoot, "Windows Job recovery root");
  const runId = validIdentifier(options.runId, "runId");
  const jobId = validIdentifier(options.jobId, "jobId");
  const outputLimitBytes = nonNegativeInteger(
    options.outputLimitBytes ?? 64 * 1024 * 1024,
    "outputLimitBytes",
  );
  const controlDirectory = path.join(recoveryRoot, deterministicRecoveryDirectoryName(runId, jobId));
  let created = false;
  try {
    try {
      await mkdir(controlDirectory, { recursive: false, mode: 0o700 });
      created = true;
      hardenRecoveryDirectoryAcl(controlDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existingDescriptor = await readVerifiedRecoveryDescriptor(
        path.join(controlDirectory, "descriptor.json"),
        options.recoverySecret,
      );
      if (
        existingDescriptor.runId !== runId
        || existingDescriptor.jobId !== jobId
        || existingDescriptor.outputLimitBytes !== outputLimitBytes
        || (
          options.launchAuthorizationId !== undefined
          && existingDescriptor.launchAuthorizationId !== options.launchAuthorizationId
        )
        || (
          options.launchGeneration !== undefined
          && existingDescriptor.launchGeneration !== options.launchGeneration
        )
        || (
          options.launchAttempt !== undefined
          && existingDescriptor.launchAttempt !== options.launchAttempt
        )
      ) {
        throw new WindowsJobContainmentError(
          "windows_job_invalid_specification",
          "Existing Windows Job recovery descriptor does not match requested identity or output limit.",
        );
      }
      return existingDescriptor;
    }
    const canonicalControlDirectory = await assertCanonicalDirectory(
      controlDirectory,
      "Windows Job recovery control directory",
    );
    const secret = recoverySecret(options.recoverySecret);
    const authenticationSaltBase64 = randomBytes(32).toString("base64");
    const launchAuthorizationId = options.launchAuthorizationId ?? randomUUID();
    if (!/^[A-Za-z0-9_.-]{16,128}$/u.test(launchAuthorizationId)) {
      throw new WindowsJobContainmentError(
        "windows_job_invalid_specification",
        "Windows Job launch authorization identifier is invalid.",
      );
    }
    const launchGeneration = positiveInteger(options.launchGeneration ?? 1, "launchGeneration");
    const launchAttempt = positiveInteger(options.launchAttempt ?? 1, "launchAttempt");
    const core: WindowsJobRecoveryDescriptorCore = {
      schemaVersion: PROTOCOL_VERSION,
      runId,
      jobId,
      authenticationScheme: RECOVERY_AUTH_SCHEME,
      authenticationSaltBase64,
      authenticationKeyId: recoveryKeyId(secret),
      launchAuthorizationId,
      launchGeneration,
      launchAttempt,
      journalGeneration: randomBytes(16).toString("base64url"),
      createdAt: new Date().toISOString(),
      supervisorProcessId: process.pid,
      supervisorProcessStartedAtFileTime: windowsProcessStartedAtFileTimeSync(process.pid) ?? (() => {
        throw new WindowsJobContainmentError(
          "windows_job_invalid_specification",
          "Windows Job supervisor process creation time could not be verified.",
        );
      })(),
      controlDirectory: canonicalControlDirectory,
      descriptorPath: path.join(canonicalControlDirectory, "descriptor.json"),
      statusPath: path.join(canonicalControlDirectory, "status.json"),
      statusJournalPath: path.join(canonicalControlDirectory, "status.journal.jsonl"),
      cancelPath: path.join(canonicalControlDirectory, "cancel.json"),
      inputPath: path.join(canonicalControlDirectory, "stdin.txt"),
      outputPath: path.join(canonicalControlDirectory, "stdout.bin"),
      errorPath: path.join(canonicalControlDirectory, "stderr.bin"),
      claimPath: path.join(canonicalControlDirectory, "spawn.claim.json"),
      specificationPath: path.join(canonicalControlDirectory, "launch-specification.json"),
      outputLimitBytes,
    };
    const authenticationKey = deriveRecoveryAuthenticationKey(
      secret,
      authenticationSaltBase64,
      runId,
      jobId,
    );
    const descriptor: WindowsJobRecoveryDescriptor = {
      ...core,
      descriptorHmacSha256: recoveryDescriptorHmac(core, authenticationKey),
    };
    await atomicWriteJson(descriptor.descriptorPath, descriptor);
    return descriptor;
  } catch (error) {
    if (created) await rm(controlDirectory, { recursive: true, force: true });
    throw error;
  }
}

interface AuthenticatedProtocolStatus {
  status: ProtocolStatus;
  evidence: WindowsJobAuthenticatedStatusEvidence;
  evidenceChain: readonly WindowsJobAuthenticatedStatusEvidence[];
}

function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function encryptedArtifactEvidence(
  filePath: string,
): Promise<{ bytes: number; digestSha256: string }> {
  try {
    const before = await lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size)) {
      throw new Error("invalid encrypted artifact identity");
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(filePath);
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.byteLength;
      if (!Number.isSafeInteger(bytes)) throw new Error("encrypted artifact is too large");
      hash.update(chunk);
    }
    const after = await lstat(filePath);
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes !== before.size
    ) throw new Error("encrypted artifact identity changed during verification");
    return { bytes, digestSha256: hash.digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { bytes: 0, digestSha256: sha256Bytes(Buffer.alloc(0)) };
  }
}

async function terminalArtifactsMatch(status: ProtocolStatus, directory: string): Promise<boolean> {
  if (!statusIsTerminal(status)) return true;
  const [stdout, stderr] = await Promise.all([
    encryptedArtifactEvidence(path.join(directory, "stdout.bin")),
    encryptedArtifactEvidence(path.join(directory, "stderr.bin")),
  ]);
  return stdout.bytes === status.encryptedStdoutBytes
    && stdout.digestSha256 === status.encryptedStdoutDigestSha256
    && stderr.bytes === status.encryptedStderrBytes
    && stderr.digestSha256 === status.encryptedStderrDigestSha256;
}

async function readAuthenticatedStatus(
  filePath: string,
  expected: ProtocolExpectation,
  verifyTerminalArtifacts = true,
): Promise<AuthenticatedProtocolStatus | null> {
  try {
    if (expected.mode === "hmac") {
      const journalPath = path.join(path.dirname(filePath), "status.journal.jsonl");
      const journalInformation = await lstat(journalPath);
      if (
        !journalInformation.isFile()
        || journalInformation.isSymbolicLink()
        || journalInformation.size <= 0
        || journalInformation.size > 4 * 1024 * 1024
      ) return null;
      const journalBytes = await readFile(journalPath);
      const journal = journalBytes.toString("utf8");
      if (!journal.endsWith("\n")) return null;
      const lines = journal.slice(0, -1).split("\n");
      let last: ProtocolStatus | null = null;
      let lastPayloadDigest = EMPTY_CHAIN_DIGEST_SHA256;
      let lastJournalDigest = EMPTY_CHAIN_DIGEST_SHA256;
      let journalOffset = 0;
      const evidenceChain: WindowsJobAuthenticatedStatusEvidence[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        const persisted = JSON.parse(lines[index]) as unknown;
        const verified = verifySignedRecoveryEnvelopeWithPayload(
          persisted,
          RECOVERY_STATUS_PURPOSE,
          expected.authenticationKey,
        );
        const status = parseProtocolStatus(verified?.value, expected);
        if (
          !verified
          || !status
          || status.sequence !== index + 1
          || status.previousSequence !== (last?.sequence ?? 0)
          || status.previousSnapshotDigestSha256 !== lastPayloadDigest
          || status.previousJournalDigestSha256 !== lastJournalDigest
          || (last && statusIsTerminal(last))
          || !terminationWindowTransitionIsValid(last, status)
        ) return null;
        const entryBytes = Buffer.from(`${lines[index]}\n`, "utf8");
        journalOffset += entryBytes.byteLength;
        if (journalOffset > journalBytes.byteLength) return null;
        lastPayloadDigest = sha256Bytes(verified.payloadBytes);
        lastJournalDigest = sha256Bytes(journalBytes.subarray(0, journalOffset));
        last = status;
        evidenceChain.push({
          journalGeneration: status.journalGeneration,
          sequence: status.sequence,
          previousSequence: status.previousSequence,
          previousSnapshotDigestSha256: status.previousSnapshotDigestSha256,
          previousJournalDigestSha256: status.previousJournalDigestSha256,
          terminal: statusIsTerminal(status),
          snapshotDigestSha256: lastPayloadDigest,
          journalDigestSha256: lastJournalDigest,
          authenticatedPayloadDigestSha256: lastPayloadDigest,
          nativeTerminalDigestSha256: status.nativeTerminalDigestSha256,
          nativeTerminalState: statusIsTerminal(status)
            ? status.status as "exited" | "cancelled" | "blocked"
            : null,
          nativeTerminalExitCode: statusIsTerminal(status) ? (status.exitCode ?? null) : null,
          terminationVerified: status.terminationVerified,
          observedAt: new Date().toISOString(),
        });
      }
      try {
        const snapshotEnvelope = JSON.parse(await readFile(filePath, "utf8")) as unknown;
        const snapshotRaw = verifySignedRecoveryEnvelope(
          snapshotEnvelope,
          RECOVERY_STATUS_PURPOSE,
          expected.authenticationKey,
        );
        const snapshot = parseProtocolStatus(snapshotRaw, expected);
        if (
          snapshot
          && last
          && (
            snapshot.sequence > last.sequence
            || (
              snapshot.sequence === last.sequence
              && JSON.stringify(snapshot) !== JSON.stringify(last)
            )
          )
        ) return null;
      } catch {
        // The snapshot is only a cache. A complete authenticated journal is
        // authoritative unless a valid newer snapshot proves rollback.
      }
      if (!last) return null;
      if (verifyTerminalArtifacts && !(await terminalArtifactsMatch(last, path.dirname(filePath)))) return null;
      const evidence = evidenceChain.at(-1);
      if (!evidence) return null;
      return {
        status: last,
        evidence,
        evidenceChain: Object.freeze(evidenceChain.map((item) => Object.freeze({ ...item }))),
      };
    }
    const persistedBytes = await readFile(filePath);
    const persisted = JSON.parse(persistedBytes.toString("utf8")) as unknown;
    const status = parseProtocolStatus(persisted, expected);
    if (!status) return null;
    if (
      status.sequence === 1
      && (
        status.previousSequence !== 0
        || status.previousSnapshotDigestSha256 !== EMPTY_CHAIN_DIGEST_SHA256
        || status.previousJournalDigestSha256 !== EMPTY_CHAIN_DIGEST_SHA256
      )
    ) return null;
    if (verifyTerminalArtifacts && !(await terminalArtifactsMatch(status, path.dirname(filePath)))) return null;
    const digest = sha256Bytes(persistedBytes);
    const evidence: WindowsJobAuthenticatedStatusEvidence = {
      journalGeneration: status.journalGeneration,
      sequence: status.sequence,
      previousSequence: status.previousSequence,
      previousSnapshotDigestSha256: status.previousSnapshotDigestSha256,
      previousJournalDigestSha256: status.previousJournalDigestSha256,
      terminal: statusIsTerminal(status),
      snapshotDigestSha256: digest,
      journalDigestSha256: digest,
      authenticatedPayloadDigestSha256: digest,
      nativeTerminalDigestSha256: status.nativeTerminalDigestSha256,
      nativeTerminalState: statusIsTerminal(status)
        ? status.status as "exited" | "cancelled" | "blocked"
        : null,
      nativeTerminalExitCode: statusIsTerminal(status) ? (status.exitCode ?? null) : null,
      terminationVerified: status.terminationVerified,
      observedAt: new Date().toISOString(),
    };
    return {
      status,
      evidence,
      evidenceChain: Object.freeze([Object.freeze({ ...evidence })]),
    };
  } catch {
    return null;
  }
}

function durableTerminalStatus(status: ProtocolStatus): WindowsJobRecoveryCleanupExpectation["nativeTerminalStatus"] {
  if (status.status === "exited") return status.exitCode === 0 ? "succeeded" : "failed";
  if (status.status === "cancelled") return "cancelled";
  return /output exceeded the configured byte limit/iu.test(status.reason ?? "") ? "failed" : "blocked";
}

function cleanupExpectationMatches(
  descriptor: WindowsJobRecoveryDescriptor,
  authenticated: AuthenticatedProtocolStatus,
  expected: WindowsJobRecoveryCleanupExpectation,
): boolean {
  const { status, evidence } = authenticated;
  return descriptor.runId === expected.runId
    && descriptor.jobId === expected.jobId
    && descriptor.journalGeneration === expected.journalGeneration
    && evidence.journalGeneration === expected.journalGeneration
    && evidence.sequence === expected.statusSequence
    && evidence.previousSequence === expected.previousStatusSequence
    && evidence.previousSnapshotDigestSha256 === expected.previousSnapshotDigestSha256
    && evidence.previousJournalDigestSha256 === expected.previousJournalDigestSha256
    && evidence.snapshotDigestSha256 === expected.snapshotDigestSha256
    && evidence.journalDigestSha256 === expected.journalDigestSha256
    && evidence.authenticatedPayloadDigestSha256 === expected.authenticatedPayloadDigestSha256
    && evidence.nativeTerminalDigestSha256 === expected.nativeTerminalDigestSha256
    && evidence.nativeTerminalExitCode === expected.nativeExitCode
    && evidence.terminal
    && evidence.terminationVerified
    && expected.terminationVerified
    && statusIsTerminal(status)
    && status.terminationVerified
    && cleanupIsVerified(status)
    && durableTerminalStatus(status) === expected.nativeTerminalStatus
    && (status.rootProcessId ?? null) === expected.rootProcessId
    && (status.rootProcessStartedAtFileTime ?? null) === expected.rootProcessStartedAtFileTime
    && (status.jobName ?? null) === expected.jobName
    && (status.helperProcessId ?? null) === expected.helperProcessId
    && (status.helperProcessStartedAtFileTime ?? null) === expected.helperProcessStartedAtFileTime;
}

async function assertCleanupDirectoryEntries(
  descriptor: WindowsJobRecoveryDescriptor,
): Promise<void> {
  const allowed = new Set([
    descriptor.descriptorPath,
    descriptor.statusPath,
    descriptor.statusJournalPath,
    `${descriptor.statusJournalPath}.lock`,
    descriptor.cancelPath,
    descriptor.inputPath,
    descriptor.outputPath,
    descriptor.errorPath,
    descriptor.claimPath,
    descriptor.specificationPath,
    controllerTerminalClaimPath(descriptor),
  ].map((candidate) => path.basename(candidate).toLocaleLowerCase("en-US")));
  const entries = await readdir(descriptor.controlDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(descriptor.controlDirectory, entry.name);
    const information = await lstat(entryPath);
    const controllerClaimTemporary = CONTROLLER_TERMINAL_CLAIM_TEMP_PATTERN.test(entry.name);
    const controllerJournalTemporary = CONTROLLER_TERMINAL_JOURNAL_TEMP_PATTERN.test(entry.name);
    const controllerJournalExpectedTemporary = CONTROLLER_TERMINAL_JOURNAL_EXPECTED_TEMP_PATTERN.test(entry.name);
    const spawnClaimTemporary = SPAWN_CLAIM_TEMP_PATTERN.test(entry.name);
    const helperSnapshotTemporary = HELPER_STATUS_SNAPSHOT_TEMP_PATTERN.test(entry.name);
    const helperSnapshotBackup = HELPER_STATUS_SNAPSHOT_BACKUP_PATTERN.test(entry.name);
    const scratchLimit = controllerClaimTemporary || spawnClaimTemporary
      ? MAX_CONTROLLER_CLAIM_SCRATCH_BYTES
      : controllerJournalTemporary || controllerJournalExpectedTemporary
        || helperSnapshotTemporary || helperSnapshotBackup
        ? MAX_STATUS_SCRATCH_BYTES
        : null;
    if (
      (!allowed.has(entry.name.toLocaleLowerCase("en-US")) && scratchLimit === null)
      || !information.isFile()
      || information.isSymbolicLink()
      || !sameWindowsPath(await realpath(entryPath), entryPath)
      || (scratchLimit !== null && information.size > scratchLimit)
    ) {
      throw new WindowsJobContainmentError(
        "windows_job_invalid_specification",
        "Windows Job recovery cleanup found an unexpected or reparse-backed control artifact.",
      );
    }
  }
}

/**
 * Removes one exact, DB-bound recovery control directory after authenticating
 * terminal evidence. It deliberately does not read, decrypt, or emit stdout/stderr.
 */
export async function cleanupWindowsJobRecoveryArtifactsVerified(
  options: WindowsJobRecoveryCleanupOptions,
): Promise<WindowsJobRecoveryCleanupResult> {
  const recoveryRoot = await assertCanonicalDirectory(options.recoveryRoot, "Windows Job recovery root");
  const descriptorPath = await resolveWindowsJobRecoveryDescriptorPath(
    recoveryRoot,
    options.expected.runId,
    options.expected.jobId,
  );
  const controlDirectory = path.dirname(descriptorPath);
  if (!existsSync(descriptorPath)) {
    if (existsSync(controlDirectory)) {
      throw new WindowsJobContainmentError(
        "windows_job_invalid_specification",
        "Windows Job recovery control directory exists without its authenticated descriptor.",
      );
    }
    return { result: "already_absent", controlDirectory };
  }

  const verifyCanonical = async (): Promise<{
    descriptor: WindowsJobRecoveryDescriptor;
    authenticated: AuthenticatedProtocolStatus;
  }> => {
    const descriptor = await readVerifiedRecoveryDescriptor(descriptorPath, options.recoverySecret);
    if (
      !sameWindowsPath(descriptor.controlDirectory, controlDirectory)
      || !sameWindowsPath(descriptor.descriptorPath, descriptorPath)
      || !sameWindowsPath(path.dirname(descriptor.controlDirectory), recoveryRoot)
    ) {
      throw new WindowsJobContainmentError(
        "windows_job_invalid_specification",
        "Windows Job recovery cleanup escaped its deterministic recovery-root child.",
      );
    }
    const authenticationKey = deriveRecoveryAuthenticationKey(
      options.recoverySecret,
      descriptor.authenticationSaltBase64,
      descriptor.runId,
      descriptor.jobId,
    );
    const expected: Extract<ProtocolExpectation, { mode: "hmac" }> = {
      mode: "hmac",
      authenticationKey,
      runId: descriptor.runId,
      jobId: descriptor.jobId,
      journalGeneration: descriptor.journalGeneration,
    };
    const authenticated = await readAuthenticatedStatus(descriptor.statusPath, expected, false);
    if (!authenticated || !cleanupExpectationMatches(descriptor, authenticated, options.expected)) {
      throw new WindowsJobContainmentError(
        "windows_job_protocol_invalid",
        "Windows Job recovery cleanup does not match the exact durable terminal checkpoint.",
      );
    }
    if (existsSync(controllerTerminalClaimPath(descriptor))) {
      const claimed = await readControllerTerminalClaim(descriptor, expected);
      if (!claimed || JSON.stringify(claimed) !== JSON.stringify(authenticated.status)) {
        throw new WindowsJobContainmentError(
          "windows_job_protocol_invalid",
          "Windows Job recovery cleanup found a terminal claim that conflicts with durable terminal evidence.",
        );
      }
    }
    return { descriptor, authenticated };
  };

  const first = await verifyCanonical();
  const status = first.authenticated.status;
  if (
    options.expected.rootProcessId !== null
    && options.expected.rootProcessStartedAtFileTime !== null
    && assertProcessIdentityAliveSync(
      options.expected.rootProcessId,
      options.expected.rootProcessStartedAtFileTime,
    )
  ) {
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      "Windows Job terminal checkpoint conflicts with a live root process identity.",
    );
  }
  if (
    options.expected.helperProcessId !== null
    && options.expected.helperProcessStartedAtFileTime !== null
    && assertProcessIdentityAliveSync(
      options.expected.helperProcessId,
      options.expected.helperProcessStartedAtFileTime,
    )
  ) {
    throw new WindowsJobContainmentError(
      "windows_job_termination_unverified",
      "Windows Job helper is still exiting; recovery cleanup must retry.",
    );
  }
  if (options.expected.rootProcessId === null && status.cleanup !== "no_process_created") {
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      "Windows Job cleanup lacks assigned process identity without no-process-created proof.",
    );
  }
  if (options.expected.jobName) {
    const activeProcessCount = probeWindowsJobActiveProcessCountSync(options.expected.jobName, false);
    if (activeProcessCount !== null && activeProcessCount !== 0) {
      throw new WindowsJobContainmentError(
        "windows_job_protocol_invalid",
        "Windows Job terminal checkpoint conflicts with active processes in the named Job Object.",
      );
    }
  }

  // Re-authenticate canonical evidence after liveness checks. Scratch files are
  // never evidence; exact bounded regular leftovers may be discarded only now.
  const final = await verifyCanonical();
  await assertCleanupDirectoryEntries(final.descriptor);
  try {
    await rm(controlDirectory, { recursive: true, force: false, maxRetries: 0 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(controlDirectory)) {
      return { result: "already_absent", controlDirectory };
    }
    throw error;
  }
  return { result: "removed", controlDirectory };
}

async function readStatusFile(
  filePath: string,
  expected: ProtocolExpectation,
): Promise<ProtocolStatus | null> {
  return (await readAuthenticatedStatus(filePath, expected))?.status ?? null;
}

async function acceptAuthenticatedProtocolStatus(
  authenticated: AuthenticatedProtocolStatus,
  acceptor?: WindowsJobAuthenticatedStatusAcceptor,
): Promise<void> {
  if (!acceptor) return;
  for (const evidence of authenticated.evidenceChain) {
    await acceptor(Object.freeze({ ...evidence }));
  }
}

async function readVerifiedSpawnClaim(
  descriptor: WindowsJobRecoveryDescriptor,
  expected: Extract<ProtocolExpectation, { mode: "hmac" }>,
): Promise<SpawnClaim | null> {
  try {
    const information = await lstat(descriptor.claimPath);
    if (!information.isFile() || information.isSymbolicLink() || information.size <= 0 || information.size > 64 * 1024) {
      return null;
    }
    const envelope = JSON.parse(await readFile(descriptor.claimPath, "utf8")) as unknown;
    const raw = verifySignedRecoveryEnvelope(
      envelope,
      RECOVERY_CLAIM_PURPOSE,
      expected.authenticationKey,
    );
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Partial<SpawnClaim>;
    if (
      value.schemaVersion !== PROTOCOL_VERSION
      || (value.kind !== "helper" && value.kind !== "controller_revoke")
      || value.runId !== descriptor.runId
      || value.jobId !== descriptor.jobId
      || value.launchAuthorizationId !== descriptor.launchAuthorizationId
      || value.launchGeneration !== descriptor.launchGeneration
      || value.launchAttempt !== descriptor.launchAttempt
      || value.journalGeneration !== descriptor.journalGeneration
      || value.descriptorHmacSha256 !== descriptor.descriptorHmacSha256
      || typeof value.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.createdAt))
    ) return null;
    if (value.kind === "helper" && (
      !Number.isSafeInteger(value.helperProcessId)
      || Number(value.helperProcessId) <= 0
      || typeof value.helperProcessStartedAtFileTime !== "string"
      || !/^\d+$/u.test(value.helperProcessStartedAtFileTime)
      || value.controllerProcessId !== undefined
      || value.controllerProcessStartedAtFileTime !== undefined
    )) return null;
    if (value.kind === "controller_revoke" && (
      !Number.isSafeInteger(value.controllerProcessId)
      || Number(value.controllerProcessId) <= 0
      || typeof value.controllerProcessStartedAtFileTime !== "string"
      || !/^\d+$/u.test(value.controllerProcessStartedAtFileTime)
      || value.helperProcessId !== undefined
      || value.helperProcessStartedAtFileTime !== undefined
    )) return null;
    return value as SpawnClaim;
  } catch {
    return null;
  }
}

function controllerTerminalClaimPath(descriptor: WindowsJobRecoveryDescriptor): string {
  return path.join(descriptor.controlDirectory, CONTROLLER_TERMINAL_CLAIM_NAME);
}

async function readControllerTerminalClaim(
  descriptor: WindowsJobRecoveryDescriptor,
  expected: Extract<ProtocolExpectation, { mode: "hmac" }>,
): Promise<ProtocolStatus | null> {
  try {
    const claimPath = controllerTerminalClaimPath(descriptor);
    const information = await lstat(claimPath);
    if (
      !information.isFile()
      || information.isSymbolicLink()
      || information.size <= 0
      || information.size > 64 * 1024
    ) return null;
    const envelope = JSON.parse(await readFile(claimPath, "utf8")) as unknown;
    const raw = verifySignedRecoveryEnvelope(
      envelope,
      RECOVERY_TERMINAL_CLAIM_PURPOSE,
      expected.authenticationKey,
    );
    const status = parseProtocolStatus(raw, expected);
    return status && statusIsTerminal(status) && status.terminationVerified && cleanupIsVerified(status)
      ? status
      : null;
  } catch {
    return null;
  }
}

async function claimControllerTerminalStatus(
  descriptor: WindowsJobRecoveryDescriptor,
  expected: Extract<ProtocolExpectation, { mode: "hmac" }>,
  candidate: ProtocolStatus,
): Promise<ProtocolStatus> {
  const envelope = signedRecoveryEnvelope(
    RECOVERY_TERMINAL_CLAIM_PURPOSE,
    candidate,
    expected.authenticationKey,
  );
  const claimPath = controllerTerminalClaimPath(descriptor);
  const temporary = path.join(
    descriptor.controlDirectory,
    `.controller-terminal-claim.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(Buffer.from(JSON.stringify(envelope), "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  const claimed = await readControllerTerminalClaim(descriptor, expected);
  if (!claimed) {
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      "Windows Job controller terminal claim is malformed or failed authentication.",
    );
  }
  return claimed;
}

async function readMatchingCommittedTerminal(
  descriptor: WindowsJobRecoveryDescriptor,
  expected: Extract<ProtocolExpectation, { mode: "hmac" }>,
  candidate: ProtocolStatus,
  attempts = 5,
): Promise<ProtocolStatus | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const authenticated = await readAuthenticatedStatus(descriptor.statusPath, expected);
    if (
      authenticated
      && statusIsTerminal(authenticated.status)
      && JSON.stringify(authenticated.status) === JSON.stringify(candidate)
    ) return authenticated.status;
    if (attempt + 1 < attempts) await delay(STATUS_POLL_MS);
  }
  return null;
}

async function appendRecoveryStatus(
  descriptor: WindowsJobRecoveryDescriptor,
  expected: Extract<ProtocolExpectation, { mode: "hmac" }>,
  candidate: ProtocolStatus,
): Promise<ProtocolStatus> {
  const status = await claimControllerTerminalStatus(descriptor, expected, candidate);
  const currentAuthenticated = await readAuthenticatedStatus(descriptor.statusPath, expected);
  if (currentAuthenticated && statusIsTerminal(currentAuthenticated.status)) {
    if (JSON.stringify(currentAuthenticated.status) !== JSON.stringify(status)) {
      throw new WindowsJobContainmentError(
        "windows_job_protocol_invalid",
        "Windows Job controller terminal claim conflicts with committed terminal status.",
      );
    }
    return currentAuthenticated.status;
  }
  const current = currentAuthenticated?.status ?? null;
  if (
    status.sequence !== (current?.sequence ?? 0) + 1
    || status.previousSequence !== (currentAuthenticated?.evidence.sequence ?? 0)
    || status.previousSnapshotDigestSha256 !== (
      currentAuthenticated?.evidence.snapshotDigestSha256 ?? EMPTY_CHAIN_DIGEST_SHA256
    )
    || status.previousJournalDigestSha256 !== (
      currentAuthenticated?.evidence.journalDigestSha256 ?? EMPTY_CHAIN_DIGEST_SHA256
    )
    || !terminationWindowTransitionIsValid(current, status)
  ) {
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      "Windows Job controller terminal claim predecessor no longer matches authenticated journal head.",
    );
  }
  const envelope = signedRecoveryEnvelope(
    RECOVERY_STATUS_PURPOSE,
    status,
    expected.authenticationKey,
  );
  let journalBytes = Buffer.alloc(0);
  try {
    journalBytes = await readFile(descriptor.statusJournalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    (status.sequence === 1 && journalBytes.byteLength !== 0)
    || (
      status.sequence > 1
      && sha256Bytes(journalBytes) !== status.previousJournalDigestSha256
    )
  ) {
    const racedTerminal = await readMatchingCommittedTerminal(descriptor, expected, status);
    if (racedTerminal) return racedTerminal;
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      "Windows Job controller terminal claim journal prefix changed before commit.",
    );
  }
  const bytes = Buffer.concat([
    journalBytes,
    Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8"),
  ]);
  try {
    await atomicReplaceDurableBytes(descriptor.statusJournalPath, bytes, journalBytes);
  } catch (error) {
    if (["EACCES", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      const racedTerminal = await readMatchingCommittedTerminal(descriptor, expected, status, 10);
      if (racedTerminal) return racedTerminal;
    }
    throw error;
  }
  try {
    await atomicWriteJson(descriptor.statusPath, envelope);
  } catch (error) {
    const committedTerminal = await readMatchingCommittedTerminal(descriptor, expected, status);
    if (committedTerminal) return committedTerminal;
    throw error;
  }
  return status;
}

async function writeControllerVerifiedCleanupStatus(
  descriptor: WindowsJobRecoveryDescriptor,
  expected: Extract<ProtocolExpectation, { mode: "hmac" }>,
  cleanup: "active_process_zero" | "no_process_created",
  reason: string,
  acceptor?: WindowsJobAuthenticatedStatusAcceptor,
): Promise<ProtocolStatus> {
  const previousAuthenticated = await readAuthenticatedStatus(descriptor.statusPath, expected);
  if (previousAuthenticated) await acceptAuthenticatedProtocolStatus(previousAuthenticated, acceptor);
  const previous = previousAuthenticated?.status ?? null;
  if (previous && statusIsTerminal(previous) && previous.terminationVerified && cleanupIsVerified(previous)) {
    return previous;
  }
  if (previous?.assignmentVerified && cleanup !== "active_process_zero") {
    throw new WindowsJobContainmentError(
      "windows_job_termination_unverified",
      "Windows Job controller cannot claim no-process cleanup after assigned process identity was observed.",
    );
  }
  const [stdout, stderr] = await Promise.all([
    encryptedArtifactEvidence(descriptor.outputPath),
    encryptedArtifactEvidence(descriptor.errorPath),
  ]);
  const status: ProtocolStatus = {
    schemaVersion: STATUS_PROTOCOL_VERSION,
    sequence: (previous?.sequence ?? 0) + 1,
    previousSequence: previousAuthenticated?.evidence.sequence ?? 0,
    previousSnapshotDigestSha256: previousAuthenticated?.evidence.snapshotDigestSha256
      ?? EMPTY_CHAIN_DIGEST_SHA256,
    previousJournalDigestSha256: previousAuthenticated?.evidence.journalDigestSha256
      ?? EMPTY_CHAIN_DIGEST_SHA256,
    journalGeneration: descriptor.journalGeneration,
    runId: descriptor.runId,
    jobId: descriptor.jobId,
    status: "blocked",
    jobName: previous?.jobName,
    helperProcessId: previous?.helperProcessId,
    helperProcessStartedAtFileTime: previous?.helperProcessStartedAtFileTime,
    rootProcessId: previous?.rootProcessId,
    rootProcessStartedAtFileTime: previous?.rootProcessStartedAtFileTime,
    assignmentVerified: previous?.assignmentVerified ?? false,
    exitCode: null,
    cleanup,
    terminationVerified: true,
    reason,
    terminationRequestedAt: previous?.terminationRequestedAt,
    terminationDeadlineAt: previous?.terminationDeadlineAt,
    encryptedStdoutBytes: stdout.bytes,
    encryptedStdoutDigestSha256: stdout.digestSha256,
    encryptedStderrBytes: stderr.bytes,
    encryptedStderrDigestSha256: stderr.digestSha256,
    nativeTerminalDigestSha256: null,
  };
  status.nativeTerminalDigestSha256 = nativeTerminalDigest(status);
  await appendRecoveryStatus(descriptor, expected, status);
  const authenticated = await readAuthenticatedStatus(descriptor.statusPath, expected);
  if (!authenticated || authenticated.status.sequence !== status.sequence) {
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      "Windows Job controller terminal status could not be re-authenticated after append.",
    );
  }
  await acceptAuthenticatedProtocolStatus(authenticated, acceptor);
  return authenticated.status;
}

async function forceVerifiedRecoveryCleanup(
  descriptor: WindowsJobRecoveryDescriptor,
  expected: Extract<ProtocolExpectation, { mode: "hmac" }>,
  previous: ProtocolStatus | null,
  claim: SpawnClaim | null,
  reason: string,
  acceptor?: WindowsJobAuthenticatedStatusAcceptor,
): Promise<ProtocolStatus> {
  const currentAuthenticated = await readAuthenticatedStatus(descriptor.statusPath, expected);
  if (currentAuthenticated) {
    await acceptAuthenticatedProtocolStatus(currentAuthenticated, acceptor);
    previous = currentAuthenticated.status;
    if (statusIsTerminal(previous)) return previous;
  } else if (previous) {
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      "Windows Job recovery status disappeared before cleanup action.",
    );
  }
  const launcherIdentity = captureWindowsJobLauncherIdentitySync();
  const helperProcessId = previous?.helperProcessId ?? claim?.helperProcessId;
  const helperStartedAt = previous?.helperProcessStartedAtFileTime ?? claim?.helperProcessStartedAtFileTime;
  if (helperProcessId && helperStartedAt && assertProcessIdentityAliveSync(
    helperProcessId,
    helperStartedAt,
    launcherIdentity,
  )) {
    if (!terminateProcessIdentitySync(helperProcessId, helperStartedAt, launcherIdentity)) {
      throw new WindowsJobContainmentError(
        "windows_job_termination_unverified",
        "Windows Job recovery watchdog could not terminate the identity-bound helper.",
      );
    }
  }
  const jobName = previous?.jobName ?? `Local\\AgentOS-${descriptor.jobId}`;
  const activeProcesses = probeWindowsJobActiveProcessCountSync(jobName, true, launcherIdentity);
  if (activeProcesses !== null && activeProcesses !== 0) {
    throw new WindowsJobContainmentError(
      "windows_job_termination_unverified",
      "Windows Job recovery watchdog did not prove ACTIVE_PROCESS_ZERO.",
    );
  }
  const cleanup = previous || activeProcesses !== null
    ? "active_process_zero"
    : "no_process_created";
  return writeControllerVerifiedCleanupStatus(descriptor, expected, cleanup, reason, acceptor);
}

async function waitForRecoveredTerminal(
  descriptor: WindowsJobRecoveryDescriptor,
  expected: Extract<ProtocolExpectation, { mode: "hmac" }>,
  forceAfterWatchdog = false,
  watchdogMs = DEFAULT_RECOVERY_WATCHDOG_MS,
  acceptor?: WindowsJobAuthenticatedStatusAcceptor,
): Promise<ProtocolStatus & { cleanup: "active_process_zero" | "no_process_created" }> {
  for (;;) {
    try {
      return await waitForVerifiedTerminalFailClosed(
        descriptor.statusPath,
        expected,
        watchdogMs,
        acceptor,
      );
    } catch (error) {
      if (!(error instanceof WindowsJobContainmentError) || error.code !== "windows_job_termination_unverified") {
        throw error;
      }
      const currentAuthenticated = await readAuthenticatedStatus(descriptor.statusPath, expected);
      if (!currentAuthenticated) {
        throw new WindowsJobContainmentError(
          "windows_job_protocol_invalid",
          "Windows Job recovery status disappeared while the watchdog was active.",
        );
      }
      await acceptAuthenticatedProtocolStatus(currentAuthenticated, acceptor);
      const current = currentAuthenticated.status;
      const helperAlive = assertProcessIdentityAliveSync(
        current.helperProcessId!,
        current.helperProcessStartedAtFileTime!,
      );
      const rootAlive = current.assignmentVerified
        ? assertProcessIdentityAliveSync(current.rootProcessId!, current.rootProcessStartedAtFileTime!)
        : false;
      const activeProcesses = probeWindowsJobActiveProcessCountSync(
        current.jobName ?? `Local\\AgentOS-${descriptor.jobId}`,
        false,
      );
      const stoppingDeadlineActive = !isWindowsJobControllerForceAllowed(current);
      const healthyAssignedProcess = !current.assignmentVerified
        || (rootAlive && activeProcesses !== null && activeProcesses > 0);
      if (
        helperAlive
        && current.status === "stopping"
        && stoppingDeadlineActive
        && healthyAssignedProcess
      ) {
        if (forceAfterWatchdog) {
          throw new WindowsJobContainmentError(
            "windows_job_termination_unverified",
            `Windows Job termination deadline ${current.terminationDeadlineAt} has not elapsed; force cleanup was not attempted.`,
          );
        }
        continue;
      }
      if (
        !forceAfterWatchdog
        && helperAlive
        && current.status === "ready"
        && healthyAssignedProcess
      ) {
        // Each watchdog interval is bounded. A healthy long-running provider
        // may continue, but helper/root identity and named Job membership are
        // re-proved before another interval begins.
        continue;
      }
      const terminal = await forceVerifiedRecoveryCleanup(
        descriptor,
        expected,
        current,
        null,
        "Windows Job recovery watchdog used KILL_ON_JOB_CLOSE plus the named Job probe and proved ACTIVE_PROCESS_ZERO.",
        acceptor,
      );
      return terminal as ProtocolStatus & { cleanup: "active_process_zero" | "no_process_created" };
    }
  }
}

function helperExit(child: ChildProcess): Promise<{ code: number | null; error?: Error; diagnostics?: string }> {
  return new Promise((resolve) => {
    let diagnostics = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-4_000);
    });
    child.once("error", (error) => resolve({ code: null, error, diagnostics }));
    child.once("close", (code) => resolve({ code, diagnostics }));
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function capturedOutputHasConsumer(destination: PassThrough): boolean {
  return destination.readableFlowing === true;
}

async function writeCapturedOutput(destination: PassThrough, chunk: Buffer): Promise<void> {
  if (chunk.byteLength === 0) return;
  const accepted = destination.write(chunk);
  if (accepted || !capturedOutputHasConsumer(destination)) return;
  // With an attached driver, preserve normal stream backpressure. With no
  // consumer, waiting for drain would deadlock wait()/cleanupVerified(); the
  // configured combined output limit bounds the bytes staged in both streams.
  await once(destination, "drain");
}

async function waitForStatus(
  statusPath: string,
  expected: ProtocolExpectation,
  predicate: (status: ProtocolStatus) => boolean,
  childExit?: Promise<{ code: number | null; error?: Error; diagnostics?: string }>,
  timeoutMs?: number,
  acceptor?: WindowsJobAuthenticatedStatusAcceptor,
): Promise<ProtocolStatus> {
  const started = Date.now();
  for (;;) {
    const authenticated = await readAuthenticatedStatus(statusPath, expected);
    const status = authenticated?.status ?? null;
    if (status && predicate(status)) {
      await acceptAuthenticatedProtocolStatus(authenticated!, acceptor);
      return status;
    }
    if (timeoutMs !== undefined && Date.now() - started >= timeoutMs) {
      throw new WindowsJobContainmentError(
        "windows_job_termination_unverified",
        "Windows Job helper did not provide verified status before the deadline.",
      );
    }
    const event = childExit
      ? await Promise.race([
          childExit.then((result) => ({ kind: "exit" as const, result })),
          delay(STATUS_POLL_MS).then(() => ({ kind: "poll" as const })),
        ])
      : await delay(STATUS_POLL_MS).then(() => ({ kind: "poll" as const }));
    if (event.kind === "exit") {
      const finalAuthenticated = await readAuthenticatedStatus(statusPath, expected);
      const finalStatus = finalAuthenticated?.status ?? null;
      if (finalStatus && predicate(finalStatus)) {
        await acceptAuthenticatedProtocolStatus(finalAuthenticated!, acceptor);
        return finalStatus;
      }
      const reason = event.result.error?.message
        ?? [
          `exit code ${event.result.code ?? "unknown"}`,
          event.result.diagnostics?.trim(),
        ].filter(Boolean).join(": ");
      throw new WindowsJobContainmentError(
        "windows_job_protocol_invalid",
        `Windows Job helper ended without required verified protocol status (${reason}).`,
      );
    }
  }
}

async function waitForVerifiedTerminalFailClosed(
  statusPath: string,
  expected: ProtocolExpectation,
  timeoutMs?: number,
  acceptor?: WindowsJobAuthenticatedStatusAcceptor,
): Promise<ProtocolStatus & { cleanup: "active_process_zero" | "no_process_created" }> {
  const started = Date.now();
  for (;;) {
    const authenticated = await readAuthenticatedStatus(statusPath, expected);
    const status = authenticated?.status ?? null;
    if (status && statusIsTerminal(status) && status.terminationVerified && cleanupIsVerified(status)) {
      await acceptAuthenticatedProtocolStatus(authenticated!, acceptor);
      return status;
    }
    if (timeoutMs !== undefined && Date.now() - started >= timeoutMs) {
      throw new WindowsJobContainmentError(
        "windows_job_termination_unverified",
        "Windows Job helper did not provide verified terminal cleanup before the recovery watchdog expired.",
      );
    }
    // No deadline and no helper-exit shortcut: without a verified cleanup
    // record the containment promise must remain fail-closed.
    await delay(STATUS_POLL_MS);
  }
}

export class WindowsJobProcess {
  readonly identity: WindowsJobProcessIdentity;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;

  readonly #child: ChildProcess;
  readonly #childExit: Promise<{ code: number | null; error?: Error }>;
  readonly #statusChildExit?: Promise<{ code: number | null; error?: Error }>;
  readonly #statusPath: string;
  readonly #cancelPath: string;
  readonly #controlDirectory: string;
  readonly #outputPath: string;
  readonly #errorPath: string;
  readonly #outputLimitBytes: number;
  readonly #stdoutStream: PassThrough;
  readonly #stderrStream: PassThrough;
  readonly #expected: ProtocolExpectation;
  readonly #autoCleanup: boolean;
  readonly #recoveryDescriptor?: WindowsJobRecoveryDescriptor;
  readonly #acceptAuthenticatedStatus?: WindowsJobAuthenticatedStatusAcceptor;
  #terminalPromise?: Promise<WindowsJobTerminalResult>;
  #cancelPromise?: Promise<WindowsJobTerminalResult>;
  #cleanupPromise?: Promise<void>;
  #emitOutputPromise?: Promise<void>;

  constructor(parameters: {
    identity: WindowsJobProcessIdentity;
    child: ChildProcess;
    childExit: Promise<{ code: number | null; error?: Error }>;
    statusChildExit?: Promise<{ code: number | null; error?: Error }>;
    stdout: PassThrough;
    stderr: PassThrough;
    statusPath: string;
    cancelPath: string;
    controlDirectory: string;
    outputPath: string;
    errorPath: string;
    outputLimitBytes: number;
    expected: ProtocolExpectation;
    autoCleanup: boolean;
    recoveryDescriptor?: WindowsJobRecoveryDescriptor;
    acceptAuthenticatedStatus?: WindowsJobAuthenticatedStatusAcceptor;
  }) {
    this.identity = parameters.identity;
    this.stdout = parameters.stdout;
    this.stderr = parameters.stderr;
    this.#child = parameters.child;
    this.#childExit = parameters.childExit;
    this.#statusChildExit = parameters.statusChildExit;
    this.#statusPath = parameters.statusPath;
    this.#cancelPath = parameters.cancelPath;
    this.#controlDirectory = parameters.controlDirectory;
    this.#outputPath = parameters.outputPath;
    this.#errorPath = parameters.errorPath;
    this.#outputLimitBytes = parameters.outputLimitBytes;
    this.#stdoutStream = parameters.stdout;
    this.#stderrStream = parameters.stderr;
    this.#expected = parameters.expected;
    this.#autoCleanup = parameters.autoCleanup;
    this.#recoveryDescriptor = parameters.recoveryDescriptor;
    this.#acceptAuthenticatedStatus = parameters.acceptAuthenticatedStatus;
  }

  wait(): Promise<WindowsJobTerminalResult> {
    if (!this.#terminalPromise) {
      const terminalStatus = this.#recoveryDescriptor && this.#expected.mode === "hmac"
        ? waitForRecoveredTerminal(
            this.#recoveryDescriptor,
            this.#expected,
            false,
            DEFAULT_RECOVERY_WATCHDOG_MS,
            this.#acceptAuthenticatedStatus,
          )
        : waitForStatus(
            this.#statusPath,
            this.#expected,
            statusIsTerminal,
            this.#statusChildExit,
            undefined,
            this.#acceptAuthenticatedStatus,
          );
      this.#terminalPromise = terminalStatus.then(async (status) => {
        const result = terminalResult(status);
        if (result.terminationVerified) {
          await this.#emitCapturedOutput(status);
          if (this.#autoCleanup) await this.#cleanup();
        }
        return result;
      });
    }
    return this.#terminalPromise;
  }

  cancel(timeoutMs = DEFAULT_CANCEL_TIMEOUT_MS): Promise<WindowsJobTerminalResult> {
    positiveInteger(timeoutMs, "cancel timeoutMs");
    if (!this.#cancelPromise) {
      this.#cancelPromise = (async () => {
        const alreadyAuthenticated = await readAuthenticatedStatus(this.#statusPath, this.#expected);
        if (alreadyAuthenticated) {
          await acceptAuthenticatedProtocolStatus(alreadyAuthenticated, this.#acceptAuthenticatedStatus);
        }
        const alreadyTerminal = alreadyAuthenticated?.status ?? null;
        if (alreadyTerminal && statusIsTerminal(alreadyTerminal)) {
          return { result: terminalResult(alreadyTerminal), status: alreadyTerminal };
        }
        const request: CancellationRequest = {
          schemaVersion: PROTOCOL_VERSION,
          ...(this.#expected.mode === "bearer" ? { token: this.#expected.token } : {}),
          runId: this.identity.runId,
          jobId: this.identity.jobId,
          rootProcessId: this.identity.rootProcessId,
          rootProcessStartedAtFileTime: this.identity.rootProcessStartedAtFileTime,
        };
        await atomicWriteProtocolJson(this.#cancelPath, RECOVERY_CANCEL_PURPOSE, request, this.#expected);
        const status = this.#recoveryDescriptor && this.#expected.mode === "hmac"
          ? await waitForRecoveredTerminal(
              this.#recoveryDescriptor,
              this.#expected,
              true,
              timeoutMs,
              this.#acceptAuthenticatedStatus,
            )
          : await waitForVerifiedTerminalFailClosed(
              this.#statusPath,
              this.#expected,
              timeoutMs,
              this.#acceptAuthenticatedStatus,
            );
        const result = terminalResult(status);
        if (!result.terminationVerified) {
          throw new WindowsJobContainmentError(
            "windows_job_termination_unverified",
            "Windows Job cancellation did not prove ACTIVE_PROCESS_ZERO.",
          );
        }
        return { result, status };
      })().then(async ({ result, status }) => {
        if (result.terminationVerified) {
          await this.#emitCapturedOutput(status);
          if (this.#autoCleanup) await this.#cleanup();
        }
        return result;
      });
    }
    return this.#cancelPromise;
  }

  async authenticatedStatusEvidence(): Promise<WindowsJobAuthenticatedStatusEvidence> {
    const authenticated = await readAuthenticatedStatus(this.#statusPath, this.#expected);
    if (!authenticated) {
      throw new WindowsJobContainmentError(
        "windows_job_protocol_invalid",
        "Windows Job authenticated status evidence is unavailable or invalid.",
      );
    }
    return Object.freeze({ ...authenticated.evidence });
  }

  async cleanupVerified(): Promise<void> {
    const status = await readStatusFile(this.#statusPath, this.#expected);
    if (!status || !statusIsTerminal(status) || !status.terminationVerified || !cleanupIsVerified(status)) {
      throw new WindowsJobContainmentError(
        "windows_job_termination_unverified",
        "Windows Job recovery artifacts cannot be removed before verified terminal cleanup.",
      );
    }
    await this.#emitCapturedOutput(status);
    await this.#cleanup();
  }

  async #emitCapturedOutput(terminalStatus?: ProtocolStatus): Promise<void> {
    if (!this.#emitOutputPromise) {
      this.#emitOutputPromise = (async () => {
        await this.#childExit;
        let remaining = this.#outputLimitBytes;
        for (const [filePath, destination, purpose] of [
          [this.#outputPath, this.#stdoutStream, RECOVERY_OUTPUT_PURPOSE],
          [this.#errorPath, this.#stderrStream, RECOVERY_ERROR_PURPOSE],
        ] as const) {
          if (remaining > 0 && existsSync(filePath)) {
            if (this.#expected.mode === "hmac") {
              const encrypted = await readFile(filePath);
              const decrypted = decryptTerminalArtifactOrDrop(
                purpose,
                encrypted,
                this.#expected.authenticationKey,
                terminalStatus,
              ).subarray(0, remaining);
              await writeCapturedOutput(destination, decrypted);
              remaining -= decrypted.byteLength;
            } else {
              const source = createReadStream(filePath, { start: 0, end: remaining - 1 });
              for await (const raw of source) {
                const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
                await writeCapturedOutput(destination, chunk);
                remaining -= chunk.byteLength;
                if (remaining <= 0) break;
              }
            }
          }
          destination.end();
        }
      })();
    }
    await this.#emitOutputPromise;
  }

  async #cleanup(): Promise<void> {
    if (!this.#cleanupPromise) {
      this.#cleanupPromise = (async () => {
        await this.#childExit;
        await this.#emitOutputPromise;
        await rm(this.#controlDirectory, { recursive: true, force: true });
      })();
    }
    await this.#cleanupPromise;
  }
}

export class RecoveredWindowsJobProcess {
  readonly descriptor: WindowsJobRecoveryDescriptor;
  readonly identity: WindowsJobProcessIdentity | null;
  readonly status: WindowsJobProcessStatusSnapshot | null;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;

  readonly #stdoutStream = new PassThrough({ highWaterMark: 64 * 1024 });
  readonly #stderrStream = new PassThrough({ highWaterMark: 64 * 1024 });
  readonly #expected: Extract<ProtocolExpectation, { mode: "hmac" }>;
  readonly #acceptAuthenticatedStatus?: WindowsJobAuthenticatedStatusAcceptor;
  #terminalPromise?: Promise<WindowsJobTerminalResult>;
  #cancelPromise?: Promise<WindowsJobTerminalResult>;
  #emitOutputPromise?: Promise<void>;
  #cleanupPromise?: Promise<void>;

  constructor(
    descriptor: WindowsJobRecoveryDescriptor,
    recoveredStatus: ProtocolStatus | null,
    authenticationKey: Buffer,
    acceptAuthenticatedStatus?: WindowsJobAuthenticatedStatusAcceptor,
  ) {
    this.descriptor = descriptor;
    this.identity = recoveredStatus ? processIdentityFromStatus(recoveredStatus) : null;
    this.status = recoveredStatus ? statusSnapshot(recoveredStatus) : null;
    this.stdout = this.#stdoutStream;
    this.stderr = this.#stderrStream;
    this.#acceptAuthenticatedStatus = acceptAuthenticatedStatus;
    this.#expected = {
      mode: "hmac",
      authenticationKey,
      runId: descriptor.runId,
      jobId: descriptor.jobId,
      journalGeneration: descriptor.journalGeneration,
    };
  }

  wait(): Promise<WindowsJobTerminalResult> {
    if (!this.#terminalPromise) {
      this.#terminalPromise = waitForRecoveredTerminal(
        this.descriptor,
        this.#expected,
        false,
        DEFAULT_RECOVERY_WATCHDOG_MS,
        this.#acceptAuthenticatedStatus,
      ).then(async (status) => {
        await this.#emitCapturedOutput(status);
        return terminalResult(status);
      });
    }
    return this.#terminalPromise;
  }

  cancel(timeoutMs = DEFAULT_CANCEL_TIMEOUT_MS): Promise<WindowsJobTerminalResult> {
    positiveInteger(timeoutMs, "cancel timeoutMs");
    if (!this.#cancelPromise) {
      this.#cancelPromise = (async () => {
        const alreadyAuthenticated = await readAuthenticatedStatus(this.descriptor.statusPath, this.#expected);
        if (alreadyAuthenticated) {
          await acceptAuthenticatedProtocolStatus(alreadyAuthenticated, this.#acceptAuthenticatedStatus);
        }
        const alreadyTerminal = alreadyAuthenticated?.status ?? null;
        if (alreadyTerminal && statusIsTerminal(alreadyTerminal)) {
          await this.#emitCapturedOutput(alreadyTerminal);
          return terminalResult(alreadyTerminal);
        }
        const request: CancellationRequest = {
          schemaVersion: PROTOCOL_VERSION,
          runId: this.descriptor.runId,
          jobId: this.descriptor.jobId,
        };
        await atomicWriteProtocolJson(
          this.descriptor.cancelPath,
          RECOVERY_CANCEL_PURPOSE,
          request,
          this.#expected,
        );
        const status = await waitForRecoveredTerminal(
          this.descriptor,
          this.#expected,
          true,
          timeoutMs,
          this.#acceptAuthenticatedStatus,
        );
        await this.#emitCapturedOutput(status);
        return terminalResult(status);
      })();
    }
    return this.#cancelPromise;
  }

  async authenticatedStatusEvidence(): Promise<WindowsJobAuthenticatedStatusEvidence> {
    const authenticated = await readAuthenticatedStatus(this.descriptor.statusPath, this.#expected);
    if (!authenticated) {
      throw new WindowsJobContainmentError(
        "windows_job_protocol_invalid",
        "Recovered Windows Job authenticated status evidence is unavailable or invalid.",
      );
    }
    return Object.freeze({ ...authenticated.evidence });
  }

  async cleanupVerified(): Promise<void> {
    if (!this.#cleanupPromise) {
      this.#cleanupPromise = (async () => {
        const result = await this.wait();
        if (!result.terminationVerified) {
          throw new WindowsJobContainmentError(
            "windows_job_termination_unverified",
            "Windows Job recovery artifacts cannot be removed before verified terminal cleanup.",
          );
        }
        await rm(this.descriptor.controlDirectory, { recursive: true, force: true });
      })();
    }
    await this.#cleanupPromise;
  }

  async #emitCapturedOutput(terminalStatus?: ProtocolStatus): Promise<void> {
    if (!this.#emitOutputPromise) {
      this.#emitOutputPromise = (async () => {
        let remaining = this.descriptor.outputLimitBytes;
        for (const [filePath, destination, purpose] of [
          [this.descriptor.outputPath, this.#stdoutStream, RECOVERY_OUTPUT_PURPOSE],
          [this.descriptor.errorPath, this.#stderrStream, RECOVERY_ERROR_PURPOSE],
        ] as const) {
          if (remaining > 0 && existsSync(filePath)) {
            const encrypted = await readFile(filePath);
            const decrypted = decryptTerminalArtifactOrDrop(
              purpose,
              encrypted,
              this.#expected.authenticationKey,
              terminalStatus,
            ).subarray(0, remaining);
            await writeCapturedOutput(destination, decrypted);
            remaining -= decrypted.byteLength;
          }
          destination.end();
        }
      })();
    }
    await this.#emitOutputPromise;
  }
}

type WindowsProcessIdentityState = "alive" | "dead" | "replaced" | "unknown";

function windowsProcessIdentityStateSync(
  processId: number,
  startedAtFileTime: string,
): WindowsProcessIdentityState {
  if (process.platform !== "win32" || !Number.isSafeInteger(processId) || processId <= 0) return "unknown";
  const launcher = captureWindowsJobLauncherIdentitySync();
  const script = [
    "$ErrorActionPreference='Stop'",
    "$processId=[Convert]::ToInt32([Environment]::GetEnvironmentVariable('AGENT_OS_IDENTITY_PID'))",
    "$expected=[Environment]::GetEnvironmentVariable('AGENT_OS_IDENTITY_STARTED_AT')",
    "$candidate=Get-Process -Id $processId -ErrorAction SilentlyContinue",
    "if($null -eq $candidate){[Console]::Out.Write('dead');exit 0}",
    "try{$observed=$candidate.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)}catch{[Console]::Out.Write('unknown');exit 0}",
    "if($observed -eq $expected){[Console]::Out.Write('alive')}else{[Console]::Out.Write('replaced')}",
  ].join(";");
  const result = spawnSync(
    launcher.powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: helperEnvironment({
        AGENT_OS_IDENTITY_PID: String(processId),
        AGENT_OS_IDENTITY_STARTED_AT: startedAtFileTime,
      }),
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    },
  );
  const state = result.status === 0 && !result.error ? result.stdout.trim() : "unknown";
  return ["alive", "dead", "replaced"].includes(state)
    ? state as WindowsProcessIdentityState
    : "unknown";
}

async function claimControllerRevocation(
  descriptor: WindowsJobRecoveryDescriptor,
  expected: Extract<ProtocolExpectation, { mode: "hmac" }>,
): Promise<SpawnClaim> {
  const controllerProcessStartedAtFileTime = windowsProcessStartedAtFileTimeSync(process.pid);
  if (!controllerProcessStartedAtFileTime) {
    throw new WindowsJobContainmentError(
      "windows_job_termination_unverified",
      "Windows Job recovery controller process identity could not be verified.",
    );
  }
  const candidate: SpawnClaim = {
    schemaVersion: PROTOCOL_VERSION,
    kind: "controller_revoke",
    runId: descriptor.runId,
    jobId: descriptor.jobId,
    launchAuthorizationId: descriptor.launchAuthorizationId,
    launchGeneration: descriptor.launchGeneration,
    launchAttempt: descriptor.launchAttempt,
    journalGeneration: descriptor.journalGeneration,
    descriptorHmacSha256: descriptor.descriptorHmacSha256,
    controllerProcessId: process.pid,
    controllerProcessStartedAtFileTime,
    createdAt: new Date().toISOString(),
  };
  const envelope = signedRecoveryEnvelope(
    RECOVERY_CLAIM_PURPOSE,
    candidate,
    expected.authenticationKey,
  );
  const temporary = path.join(
    descriptor.controlDirectory,
    `.spawn-claim.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(Buffer.from(JSON.stringify(envelope), "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, descriptor.claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  const claimed = await readVerifiedSpawnClaim(descriptor, expected);
  if (!claimed) {
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      "Windows Job spawn claim is malformed or failed authentication after arbitration.",
    );
  }
  return claimed;
}

export type WindowsJobRecoveryArbitrationResult =
  | { state: "helper_claimed"; process: RecoveredWindowsJobProcess }
  | { state: "controller_revoked"; process: RecoveredWindowsJobProcess };

/**
 * Arbitrates the single crash-atomic spawn claim. A descriptor is discovery
 * metadata only: the helper may continue solely after winning this claim,
 * while a replacement controller may revoke only after proving the exact
 * descriptor supervisor PID+creation-time identity is no longer alive.
 */
export async function arbitrateWindowsJobRecoveryDescriptor(
  descriptorPath: string,
  explicitRecoverySecret?: string,
  acceptAuthenticatedStatus?: WindowsJobAuthenticatedStatusAcceptor,
  minimumAuthenticatedSequence = 0,
): Promise<WindowsJobRecoveryArbitrationResult> {
  const secret = recoverySecret(explicitRecoverySecret);
  const descriptor = await readVerifiedRecoveryDescriptor(descriptorPath, secret);
  const authenticationKey = deriveRecoveryAuthenticationKey(
    secret,
    descriptor.authenticationSaltBase64,
    descriptor.runId,
    descriptor.jobId,
  );
  const expected: Extract<ProtocolExpectation, { mode: "hmac" }> = {
    mode: "hmac",
    authenticationKey,
    runId: descriptor.runId,
    jobId: descriptor.jobId,
    journalGeneration: descriptor.journalGeneration,
  };
  const claimExists = existsSync(descriptor.claimPath);
  let claim = claimExists ? await readVerifiedSpawnClaim(descriptor, expected) : null;
  if (claimExists && !claim) {
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      "Windows Job spawn claim is partial, malformed, reparse-backed, or failed authentication.",
    );
  }
  if (!claim) {
    const supervisorState = windowsProcessIdentityStateSync(
      descriptor.supervisorProcessId,
      descriptor.supervisorProcessStartedAtFileTime,
    );
    if (supervisorState === "alive" || supervisorState === "unknown") {
      throw new WindowsJobContainmentError(
        "windows_job_termination_unverified",
        supervisorState === "alive"
          ? "Windows Job descriptor supervisor is still alive; replacement controller revoke is denied."
          : "Windows Job descriptor supervisor liveness could not be proven; replacement controller revoke is denied.",
      );
    }
    claim = await claimControllerRevocation(descriptor, expected);
  }
  if (claim.kind === "helper") {
    return {
      state: "helper_claimed",
      process: await recoverWindowsJobProcess(
        descriptorPath,
        secret,
        acceptAuthenticatedStatus,
        minimumAuthenticatedSequence,
      ),
    };
  }

  const current = await readAuthenticatedStatus(descriptor.statusPath, expected);
  if (current) {
    if (current.evidence.sequence < minimumAuthenticatedSequence) {
      throw new WindowsJobContainmentError(
        "windows_job_protocol_invalid",
        "Controller-revoked Windows Job journal is behind the durable high-water mark.",
      );
    }
    await acceptAuthenticatedProtocolStatus(current, acceptAuthenticatedStatus);
  }
  if (!current || !statusIsTerminal(current.status)) {
    await writeControllerVerifiedCleanupStatus(
      descriptor,
      expected,
      "no_process_created",
      "Windows Job descriptor was revoked after its exact supervisor process identity ended before helper claim publication.",
      acceptAuthenticatedStatus,
    );
  }
  return {
    state: "controller_revoked",
    process: await recoverWindowsJobProcess(
      descriptorPath,
      secret,
      acceptAuthenticatedStatus,
      minimumAuthenticatedSequence,
    ),
  };
}

export async function recoverWindowsJobProcess(
  descriptorPath: string,
  explicitRecoverySecret?: string,
  acceptAuthenticatedStatus?: WindowsJobAuthenticatedStatusAcceptor,
  minimumAuthenticatedSequence = 0,
): Promise<RecoveredWindowsJobProcess> {
  if (!Number.isSafeInteger(minimumAuthenticatedSequence) || minimumAuthenticatedSequence < 0) {
    throw new TypeError("minimumAuthenticatedSequence must be a non-negative safe integer.");
  }
  const secret = recoverySecret(explicitRecoverySecret);
  const descriptor = await readVerifiedRecoveryDescriptor(descriptorPath, secret);
  const authenticationKey = deriveRecoveryAuthenticationKey(
    secret,
    descriptor.authenticationSaltBase64,
    descriptor.runId,
    descriptor.jobId,
  );
  const expected: Extract<ProtocolExpectation, { mode: "hmac" }> = {
    mode: "hmac",
    authenticationKey,
    runId: descriptor.runId,
    jobId: descriptor.jobId,
    journalGeneration: descriptor.journalGeneration,
  };
  const claimExists = existsSync(descriptor.claimPath);
  const claim = claimExists ? await readVerifiedSpawnClaim(descriptor, expected) : null;
  if (claimExists && !claim) {
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      "Windows Job recovery claim is malformed, reparse-backed, or failed authentication.",
    );
  }
  let recoveredAuthenticated = await readAuthenticatedStatus(descriptor.statusPath, expected);
  if (recoveredAuthenticated) {
    if (recoveredAuthenticated.evidence.sequence < minimumAuthenticatedSequence) {
      throw new WindowsJobContainmentError(
        "windows_job_protocol_invalid",
        "Authenticated Windows Job status journal is behind the durable high-water mark.",
      );
    }
    await acceptAuthenticatedProtocolStatus(recoveredAuthenticated, acceptAuthenticatedStatus);
  }
  let recoveredStatus = recoveredAuthenticated?.status ?? null;
  if (!recoveredStatus && existsSync(descriptor.statusJournalPath)) {
    for (let attempt = 0; attempt < 3 && !recoveredStatus; attempt += 1) {
      await delay(STATUS_POLL_MS);
      recoveredAuthenticated = await readAuthenticatedStatus(descriptor.statusPath, expected);
      if (recoveredAuthenticated) {
        if (recoveredAuthenticated.evidence.sequence < minimumAuthenticatedSequence) {
          throw new WindowsJobContainmentError(
            "windows_job_protocol_invalid",
            "Authenticated Windows Job status journal is behind the durable high-water mark.",
          );
        }
        await acceptAuthenticatedProtocolStatus(recoveredAuthenticated, acceptAuthenticatedStatus);
        recoveredStatus = recoveredAuthenticated.status;
      }
    }
    if (!recoveredStatus) {
      throw new WindowsJobContainmentError(
        "windows_job_protocol_invalid",
        "Windows Job recovery status journal is truncated, reordered, rolled back, or failed authentication.",
      );
    }
  }
  if (!recoveredStatus && minimumAuthenticatedSequence > 0) {
    throw new WindowsJobContainmentError(
      "windows_job_protocol_invalid",
      "Durable Windows Job high-water exists but authenticated native status is missing or rolled back.",
    );
  }
  const pendingControllerTerminalClaim = await readControllerTerminalClaim(descriptor, expected);
  if (pendingControllerTerminalClaim && (!recoveredStatus || !statusIsTerminal(recoveredStatus))) {
    await appendRecoveryStatus(descriptor, expected, pendingControllerTerminalClaim);
    recoveredAuthenticated = await readAuthenticatedStatus(descriptor.statusPath, expected);
    if (!recoveredAuthenticated || !statusIsTerminal(recoveredAuthenticated.status)) {
      throw new WindowsJobContainmentError(
        "windows_job_protocol_invalid",
        "Windows Job controller terminal claim could not be completed after recovery.",
      );
    }
    await acceptAuthenticatedProtocolStatus(recoveredAuthenticated, acceptAuthenticatedStatus);
    recoveredStatus = recoveredAuthenticated.status;
  }
  if (!recoveredStatus && claim?.kind === "helper") {
    const helperAlive = assertProcessIdentityAliveSync(
      claim.helperProcessId!,
      claim.helperProcessStartedAtFileTime!,
    );
    if (helperAlive) {
      try {
        recoveredStatus = await waitForStatus(
          descriptor.statusPath,
          expected,
          () => true,
          undefined,
          DEFAULT_RECOVERY_WATCHDOG_MS,
          acceptAuthenticatedStatus,
        );
      } catch (error) {
        if (!(error instanceof WindowsJobContainmentError) || error.code !== "windows_job_termination_unverified") {
          throw error;
        }
      }
    }
    if (!recoveredStatus) {
      recoveredStatus = await forceVerifiedRecoveryCleanup(
        descriptor,
        expected,
        null,
        claim,
        "Windows Job helper acquired the spawn claim but ended before native process creation; no-process cleanup was verified.",
        acceptAuthenticatedStatus,
      );
    }
  }
  if (recoveredStatus?.status === "starting") {
    const helperAlive = assertProcessIdentityAliveSync(
      recoveredStatus.helperProcessId!,
      recoveredStatus.helperProcessStartedAtFileTime!,
    );
    if (helperAlive) {
      try {
        recoveredStatus = await waitForStatus(
          descriptor.statusPath,
          expected,
          (status) => status.status === "ready" || statusIsTerminal(status),
          undefined,
          DEFAULT_RECOVERY_WATCHDOG_MS,
          acceptAuthenticatedStatus,
        );
      } catch (error) {
        if (!(error instanceof WindowsJobContainmentError) || error.code !== "windows_job_termination_unverified") {
          throw error;
        }
        recoveredAuthenticated = await readAuthenticatedStatus(descriptor.statusPath, expected);
        if (recoveredAuthenticated) {
          await acceptAuthenticatedProtocolStatus(recoveredAuthenticated, acceptAuthenticatedStatus);
          recoveredStatus = recoveredAuthenticated.status;
        }
      }
    }
    if (recoveredStatus.status === "starting") {
      recoveredStatus = await forceVerifiedRecoveryCleanup(
        descriptor,
        expected,
        recoveredStatus,
        claim,
        "Windows Job helper did not complete startup before the bounded recovery watchdog; KILL_ON_JOB_CLOSE plus the named Job probe reached ACTIVE_PROCESS_ZERO.",
        acceptAuthenticatedStatus,
      );
    }
  }
  if (recoveredStatus?.assignmentVerified) {
    const helperAlive = assertProcessIdentityAliveSync(
      recoveredStatus.helperProcessId!,
      recoveredStatus.helperProcessStartedAtFileTime!,
    );
    const rootAlive = assertProcessIdentityAliveSync(
      recoveredStatus.rootProcessId!,
      recoveredStatus.rootProcessStartedAtFileTime!,
    );
    if (statusIsTerminal(recoveredStatus) && recoveredStatus.terminationVerified && rootAlive) {
      throw new WindowsJobContainmentError(
        "windows_job_protocol_invalid",
        "Windows Job terminal recovery status conflicts with a live root process identity.",
      );
    }
    if (!statusIsTerminal(recoveredStatus) && (!helperAlive || !rootAlive)) {
      recoveredStatus = await forceVerifiedRecoveryCleanup(
        descriptor,
        expected,
        recoveredStatus,
        claim,
        "Windows Job helper or root identity ended before terminal status; KILL_ON_JOB_CLOSE plus the named Job probe reached ACTIVE_PROCESS_ZERO.",
        acceptAuthenticatedStatus,
      );
    }
  }
  return new RecoveredWindowsJobProcess(
    descriptor,
    recoveredStatus,
    authenticationKey,
    acceptAuthenticatedStatus,
  );
}

export async function spawnWindowsJobProcess(
  executable: string,
  args: readonly string[],
  options: WindowsJobSpawnOptions,
): Promise<WindowsJobProcess> {
  if (!isLocalAbsolutePath(executable) || !isLocalAbsolutePath(options.cwd)) {
    throw new WindowsJobContainmentError(
      "windows_job_invalid_specification",
      "Windows Job executable and cwd must be local absolute paths.",
    );
  }
  const runId = validIdentifier(options.runId, "runId");
  const jobId = validIdentifier(options.jobId, "jobId");
  const handshakeTimeoutMs = positiveInteger(
    options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    "handshakeTimeoutMs",
  );
  const descendantGraceMs = positiveInteger(
    options.descendantGraceMs ?? DEFAULT_DESCENDANT_GRACE_MS,
    "descendantGraceMs",
  );
  for (const argument of args) {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw new WindowsJobContainmentError(
        "windows_job_invalid_specification",
        "Windows Job argument contains an invalid value.",
      );
    }
  }
  const launcherIdentity = options.launcherIdentity ?? captureWindowsJobLauncherIdentitySync();
  assertWindowsJobLauncherIdentityBindingSync(launcherIdentity);

  const outputLimitBytes = nonNegativeInteger(
    options.limits?.outputLimitBytes ?? 64 * 1024 * 1024,
    "outputLimitBytes",
  );
  let recoveryDescriptor: WindowsJobRecoveryDescriptor | undefined;
  let recoveryAuthenticationKey: Buffer | undefined;
  if (options.recoveryDescriptor) {
    const secret = recoverySecret(options.recoverySecret);
    recoveryDescriptor = await readVerifiedRecoveryDescriptor(options.recoveryDescriptor.descriptorPath, secret);
    recoveryAuthenticationKey = deriveRecoveryAuthenticationKey(
      secret,
      recoveryDescriptor.authenticationSaltBase64,
      recoveryDescriptor.runId,
      recoveryDescriptor.jobId,
    );
    if (
      recoveryDescriptor.descriptorHmacSha256 !== options.recoveryDescriptor.descriptorHmacSha256
      || recoveryDescriptor.runId !== runId
      || recoveryDescriptor.jobId !== jobId
      || recoveryDescriptor.outputLimitBytes !== outputLimitBytes
    ) {
      throw new WindowsJobContainmentError(
        "windows_job_invalid_specification",
        "Windows Job recovery descriptor does not match the requested run, job, or output limit.",
      );
    }
  }

  if (recoveryDescriptor && existsSync(recoveryDescriptor.claimPath)) {
    throw new WindowsJobContainmentError(
      "windows_job_spawn_failed",
      "Windows Job recovery descriptor is already claimed; duplicate spawn denied.",
    );
  }
  const token = recoveryDescriptor ? undefined : randomUUID();
  const journalGeneration = recoveryDescriptor?.journalGeneration ?? randomBytes(16).toString("base64url");
  const expected: ProtocolExpectation = recoveryDescriptor
    ? { mode: "hmac", authenticationKey: recoveryAuthenticationKey!, runId, jobId, journalGeneration }
    : { mode: "bearer", token: token!, runId, jobId, journalGeneration };
  const controlDirectory = recoveryDescriptor?.controlDirectory
    ?? await mkdtemp(path.join(os.tmpdir(), "agent-os-job-"));
  const statusPath = recoveryDescriptor?.statusPath ?? path.join(controlDirectory, "status.json");
  const cancelPath = recoveryDescriptor?.cancelPath ?? path.join(controlDirectory, "cancel.json");
  const inputPath = recoveryDescriptor?.inputPath ?? path.join(controlDirectory, "stdin.txt");
  const outputPath = recoveryDescriptor?.outputPath ?? path.join(controlDirectory, "stdout.bin");
  const errorPath = recoveryDescriptor?.errorPath ?? path.join(controlDirectory, "stderr.bin");
  await mkdir(controlDirectory, { recursive: true });
  await writeFile(
    inputPath,
    recoveryDescriptor
      ? encryptRecoveryFileBytes(
          RECOVERY_INPUT_PURPOSE,
          Buffer.from(options.input ?? "", "utf8"),
          recoveryAuthenticationKey!,
        )
      : options.input ?? "",
    { flag: "wx" },
  );
  const canonicalExecutable = realpathSync.native(executable);
  const pinnedExecutableFiles = expectedExecutableFiles(
    canonicalExecutable,
    options.expectedExecutableFiles,
  );
  const pinnedWorkingDirectory = expectedWorkingDirectory(options.cwd, options.expectedWorkingDirectory);
  const specification = {
    schemaVersion: PROTOCOL_VERSION,
    ...(token ? { token } : {}),
    runId,
    jobId,
    journalGeneration,
    ...(recoveryDescriptor ? {
      launchAuthorizationId: recoveryDescriptor.launchAuthorizationId,
      launchGeneration: recoveryDescriptor.launchGeneration,
      launchAttempt: recoveryDescriptor.launchAttempt,
      descriptorHmacSha256: recoveryDescriptor.descriptorHmacSha256,
    } : {}),
    parentPid: recoveryDescriptor?.supervisorProcessId ?? process.pid,
    parentProcessStartedAtFileTime: recoveryDescriptor?.supervisorProcessStartedAtFileTime
      ?? windowsProcessStartedAtFileTimeSync(process.pid, launcherIdentity),
    executable: canonicalExecutable,
    expectedExecutableFiles: pinnedExecutableFiles,
    args: [...args],
    cwd: pinnedWorkingDirectory.absolutePath,
    expectedWorkingDirectory: pinnedWorkingDirectory,
    environment: childEnvironment(options.env),
    descendantGraceMs,
    limits: {
      activeProcessLimit: positiveInteger(options.limits?.activeProcessLimit ?? 16, "activeProcessLimit"),
      jobMemoryLimitBytes: positiveInteger(options.limits?.jobMemoryLimitBytes ?? 1024 * 1024 * 1024, "jobMemoryLimitBytes"),
      cpuTimeLimitMs: positiveInteger(options.limits?.cpuTimeLimitMs ?? 30 * 60 * 1_000, "cpuTimeLimitMs"),
      outputLimitBytes,
    },
    statusPath,
    statusJournalPath: recoveryDescriptor?.statusJournalPath,
    cancelPath,
    inputPath,
    outputPath,
    errorPath,
    claimPath: recoveryDescriptor?.claimPath,
    specificationPath: recoveryDescriptor?.specificationPath,
    encryptedControlFiles: recoveryDescriptor !== undefined,
  };

  assertWindowsJobLauncherIdentityBindingSync(launcherIdentity);
  if (recoveryDescriptor) {
    await atomicWriteEncryptedProtocolJson(
      recoveryDescriptor.specificationPath,
      RECOVERY_SPECIFICATION_PURPOSE,
      specification,
      recoveryAuthenticationKey!,
    );
  }
  const helperCommand = inMemoryHelperCommand(launcherIdentity);
  const helperArguments = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    helperCommand,
  ];
  let child: ChildProcess;
  try {
    const recoveryBootstrapEnvironment = recoveryDescriptor ? {
      AGENT_OS_RECOVERY_HELPER: "1",
      AGENT_OS_RECOVERY_SPECIFICATION_PATH: recoveryDescriptor.specificationPath,
      [RECOVERY_AUTH_KEY_ENV]: recoveryAuthenticationKey!.toString("base64"),
      [RECOVERY_BOOTSTRAP_POWERSHELL_ENV]: launcherIdentity.powershellPath,
      [RECOVERY_BOOTSTRAP_ARGUMENTS_ENV]: Buffer.from(
        JSON.stringify(helperArguments),
        "utf8",
      ).toString("base64"),
    } : undefined;
    child = spawn(
      recoveryDescriptor ? process.execPath : launcherIdentity.powershellPath,
      recoveryDescriptor ? ["-e", RECOVERY_BOOTSTRAP_SOURCE] : helperArguments,
      {
        cwd: path.dirname(launcherIdentity.helperPath),
        env: helperEnvironment(recoveryBootstrapEnvironment),
        detached: recoveryDescriptor !== undefined,
        windowsHide: true,
        stdio: recoveryDescriptor ? "ignore" : ["pipe", "ignore", "pipe"],
      },
    );
  } catch (error) {
    if (recoveryDescriptor) {
      await writeControllerVerifiedCleanupStatus(
        recoveryDescriptor,
        expected as Extract<ProtocolExpectation, { mode: "hmac" }>,
        "no_process_created",
        "Windows Job helper could not be created.",
        options.acceptAuthenticatedStatus,
      );
    }
    throw error;
  }
  const exit = helperExit(child);
  const stdout = new PassThrough({ highWaterMark: 64 * 1024 });
  const stderr = new PassThrough({ highWaterMark: 64 * 1024 });
  // Provider output lives in private scratch files. Drain helper diagnostics
  // so they cannot deadlock the protocol; verified provider bytes are emitted
  // into the streams only after the Windows Job reaches ACTIVE_PROCESS_ZERO.
  if (child.stdin) {
    child.stdin.on("error", () => undefined);
    child.stdin.end(
      recoveryDescriptor ? "" : JSON.stringify(specification),
      "utf8",
    );
  }

  try {
    const status = await waitForStatus(
      statusPath,
      expected,
      (candidate) => candidate.status === "ready" || statusIsTerminal(candidate),
      exit,
      handshakeTimeoutMs,
      options.acceptAuthenticatedStatus,
    );
    if (status.status === "blocked") {
      throw new WindowsJobContainmentError(
        "windows_job_handshake_failed",
        status.reason ?? "Windows Job helper blocked before spawn handshake.",
        cleanupIsVerified(status),
        cleanupIsVerified(status) ? status.cleanup : undefined,
      );
    }
    const identity = processIdentityFromStatus(status);
    if (!identity) {
      throw new WindowsJobContainmentError(
        "windows_job_protocol_invalid",
        "Windows Job helper ready status did not include verified process identity.",
      );
    }
    return new WindowsJobProcess({
      identity,
      child,
      childExit: exit,
      statusChildExit: exit,
      stdout,
      stderr,
      statusPath,
      cancelPath,
      controlDirectory,
      outputPath,
      errorPath,
      outputLimitBytes: specification.limits.outputLimitBytes,
      expected,
      autoCleanup: recoveryDescriptor === undefined,
      recoveryDescriptor,
      acceptAuthenticatedStatus: options.acceptAuthenticatedStatus,
    });
  } catch (error) {
    if (
      recoveryDescriptor
      && error instanceof WindowsJobContainmentError
      && error.code === "windows_job_protocol_invalid"
    ) {
      await exit;
      const previousAuthenticated = await readAuthenticatedStatus(statusPath, expected);
      if (previousAuthenticated) {
        await acceptAuthenticatedProtocolStatus(previousAuthenticated, options.acceptAuthenticatedStatus);
      }
      const previous = previousAuthenticated?.status ?? null;
      const recoveryExpected = expected as Extract<ProtocolExpectation, { mode: "hmac" }>;
      const claimExists = existsSync(recoveryDescriptor.claimPath);
      const claim = claimExists
        ? await readVerifiedSpawnClaim(recoveryDescriptor, recoveryExpected)
        : null;
      if (claimExists && !claim) {
        throw new WindowsJobContainmentError(
          "windows_job_protocol_invalid",
          "Windows Job recovery claim failed authentication after helper exit.",
        );
      }
      if (!previous && claim) {
        throw new WindowsJobContainmentError(
          "windows_job_spawn_failed",
          "Windows Job recovery descriptor was claimed by another authenticated helper; duplicate spawn denied.",
        );
      }
      if (!previous || (previous.status === "starting" && previous.assignmentVerified === false)) {
        const terminalStatus = previous
          ? await forceVerifiedRecoveryCleanup(
              recoveryDescriptor,
              recoveryExpected,
              previous,
              claim,
              "Windows Job helper exited before completing the authenticated spawn handshake; KILL_ON_JOB_CLOSE plus the named Job probe reached ACTIVE_PROCESS_ZERO.",
              options.acceptAuthenticatedStatus,
            )
          : await writeControllerVerifiedCleanupStatus(
              recoveryDescriptor,
              recoveryExpected,
              "no_process_created",
              "Windows Job bootstrap exited before an authenticated helper acquired the spawn claim.",
              options.acceptAuthenticatedStatus,
            );
        throw new WindowsJobContainmentError(
          "windows_job_handshake_failed",
          `Windows Job helper exited before completing the authenticated spawn handshake (${error.message}).`,
          true,
          terminalStatus.cleanup as "active_process_zero" | "no_process_created",
        );
      }
    }
    if (error instanceof WindowsJobContainmentError && error.code === "windows_job_termination_unverified") {
      const currentAuthenticated = await readAuthenticatedStatus(statusPath, expected);
      if (currentAuthenticated) {
        await acceptAuthenticatedProtocolStatus(currentAuthenticated, options.acceptAuthenticatedStatus);
      }
      const request: CancellationRequest = {
        schemaVersion: PROTOCOL_VERSION,
        ...(token ? { token } : {}),
        runId,
        jobId,
      };
      await atomicWriteProtocolJson(cancelPath, RECOVERY_CANCEL_PURPOSE, request, expected);
      const terminalStatus = recoveryDescriptor && expected.mode === "hmac"
        ? await waitForRecoveredTerminal(
            recoveryDescriptor,
            expected,
            true,
            DEFAULT_RECOVERY_WATCHDOG_MS,
            options.acceptAuthenticatedStatus,
          )
        : await waitForVerifiedTerminalFailClosed(
            statusPath,
            expected,
            DEFAULT_RECOVERY_WATCHDOG_MS,
            options.acceptAuthenticatedStatus,
          );
      await exit;
      if (!recoveryDescriptor) await rm(controlDirectory, { recursive: true, force: true });
      throw new WindowsJobContainmentError(
        "windows_job_handshake_timeout",
        `Windows Job spawn handshake timed out; cleanup verified as ${terminalStatus.cleanup}.`,
        true,
        terminalStatus.cleanup,
      );
    }
    if (error instanceof WindowsJobContainmentError && error.terminationVerified) {
      await exit;
      if (!recoveryDescriptor) await rm(controlDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}
