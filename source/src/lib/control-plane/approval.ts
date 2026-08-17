import { createHash } from "node:crypto";
import path from "node:path";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export type ApprovalDecision = "allow_once" | "allow_session" | "deny";

export const SAFE_APPROVAL_ENV_KEYS = [
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "TERM",
] as const;

export interface ApprovalKeyInput {
  namespacedToolId: string;
  schemaVersion: string;
  args: unknown;
  cwd: string;
  safeEnv: Readonly<Record<string, string>>;
  callerSessionId: string;
  actorId: string;
  projectId: string;
  runId: string;
  expiresAt: string;
}

interface ApprovalKeyPayload {
  actorId: string;
  args: CanonicalJsonValue;
  callerSessionId: string;
  cwd: string;
  expiresAt: string;
  namespacedToolId: string;
  projectId: string;
  runId: string;
  safeEnv: Record<string, string>;
  schemaVersion: string;
}

export interface CanonicalApprovalKey {
  digest: string;
  canonicalPayload: string;
  expiresAt: string;
  callerSessionId: string;
}

export interface ApprovalAuthorization {
  allowed: boolean;
  code: "allowed_once" | "allowed_session" | "denied" | "missing" | "expired" | "revoked";
}

interface ApprovalGrant {
  decision: ApprovalDecision;
  expiresAtMs: number;
  callerSessionId: string;
  revoked: boolean;
}

export class ApprovalContractError extends Error {
  readonly code = "invalid_approval_contract";

  constructor(message: string) {
    super(message);
    this.name = "ApprovalContractError";
  }
}

export interface ApprovalEnforcementState {
  durableGrantStore: boolean;
  atomicAllowOnce: boolean;
  preExecutionHook: boolean;
}

export interface ApprovalEnforcementAssessment {
  enforced: boolean;
  code: "enforced" | "durable_store_unavailable" | "atomic_once_unavailable" | "pre_execution_hook_unavailable";
}

export function assessApprovalEnforcement(
  state: Readonly<ApprovalEnforcementState>,
): ApprovalEnforcementAssessment {
  if (state.durableGrantStore !== true) return { enforced: false, code: "durable_store_unavailable" };
  if (state.atomicAllowOnce !== true) return { enforced: false, code: "atomic_once_unavailable" };
  if (state.preExecutionHook !== true) return { enforced: false, code: "pre_execution_hook_unavailable" };
  return { enforced: true, code: "enforced" };
}

const SAFE_ENV_KEY_SET = new Set<string>(SAFE_APPROVAL_ENV_KEYS);
const MAX_CANONICAL_ARGS_BYTES = 64 * 1024;
const MAX_ENV_VALUE_LENGTH = 512;

function requiredText(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== "string") throw new ApprovalContractError(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ApprovalContractError(`${field} is invalid.`);
  }
  return normalized;
}

function canonicalJsonValue(value: unknown, seen: Set<object>): CanonicalJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ApprovalContractError("args contain a non-finite number.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new ApprovalContractError("args must contain JSON values only.");
  }
  if (seen.has(value)) throw new ApprovalContractError("args contain a cycle.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ApprovalContractError("args contain a non-plain object.");
    }
    const record = value as Record<string, unknown>;
    if (Object.getOwnPropertySymbols(record).length > 0) {
      throw new ApprovalContractError("args contain symbol keys.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(record);
    const canonical = Object.create(null) as Record<string, CanonicalJsonValue>;
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) {
        throw new ApprovalContractError("args contain an accessor property.");
      }
      canonical[key] = canonicalJsonValue(descriptor.value, seen);
    }
    return canonical;
  } finally {
    seen.delete(value);
  }
}

export function canonicalizeApprovalArgs(value: unknown): CanonicalJsonValue {
  const canonical = canonicalJsonValue(value, new Set());
  const bytes = Buffer.byteLength(JSON.stringify(canonical), "utf8");
  if (bytes > MAX_CANONICAL_ARGS_BYTES) {
    throw new ApprovalContractError("args exceed the canonical approval size limit.");
  }
  return canonical;
}

export function canonicalizeApprovalCwd(value: unknown): string {
  const cwd = requiredText(value, "cwd", 32_768);
  if (cwd.startsWith("\\\\") || /^\\\\[?.]\\/.test(cwd)) {
    throw new ApprovalContractError("cwd must not be a UNC or device path.");
  }
  if (!path.win32.isAbsolute(cwd) || !/^[a-z]:[\\/]/i.test(cwd)) {
    throw new ApprovalContractError("cwd must be an absolute local Windows path.");
  }
  const normalized = path.win32.normalize(cwd);
  const withoutTrailingSeparators = /^[a-z]:\\$/i.test(normalized)
    ? normalized
    : normalized.replace(/\\+$/, "");
  return withoutTrailingSeparators.toLowerCase();
}

export function canonicalizeSafeApprovalEnvironment(
  value: Readonly<Record<string, string>>,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApprovalContractError("safeEnv must be an object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ApprovalContractError("safeEnv must be a plain object.");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ApprovalContractError("safeEnv must not contain symbol keys.");
  }
  const canonical: Record<string, string> = {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) {
      throw new ApprovalContractError(`safeEnv value is invalid: ${key}.`);
    }
    if (!SAFE_ENV_KEY_SET.has(key)) {
      throw new ApprovalContractError(`safeEnv key is not allowed: ${key}.`);
    }
    const entry = descriptor.value;
    if (typeof entry !== "string" || entry.length > MAX_ENV_VALUE_LENGTH || /[\u0000\r\n]/.test(entry)) {
      throw new ApprovalContractError(`safeEnv value is invalid: ${key}.`);
    }
    canonical[key] = entry;
  }
  return canonical;
}

function canonicalExpiry(value: unknown, field: string): { iso: string; milliseconds: number } {
  const raw = requiredText(value, field, 64);
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) throw new ApprovalContractError(`${field} is invalid.`);
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function approvalDigest(canonicalPayload: string): string {
  return createHash("sha256").update(canonicalPayload).digest("hex");
}

function validToolId(value: string): boolean {
  const segments = value.split(":");
  return segments.length >= 3
    && segments.every((segment) => /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(segment));
}

export function createCanonicalApprovalKey(
  input: ApprovalKeyInput,
  now = new Date(),
): Readonly<CanonicalApprovalKey> {
  const namespacedToolId = requiredText(input.namespacedToolId, "namespacedToolId", 512);
  if (!validToolId(namespacedToolId)) {
    throw new ApprovalContractError("namespacedToolId must contain at least three valid namespace segments.");
  }
  const schemaVersion = requiredText(input.schemaVersion, "schemaVersion", 128);
  const expiry = canonicalExpiry(input.expiresAt, "expiresAt");
  if (expiry.milliseconds <= now.getTime()) {
    throw new ApprovalContractError("expiresAt must be in the future.");
  }

  const payload: ApprovalKeyPayload = {
    actorId: requiredText(input.actorId, "actorId"),
    args: canonicalizeApprovalArgs(input.args),
    callerSessionId: requiredText(input.callerSessionId, "callerSessionId"),
    cwd: canonicalizeApprovalCwd(input.cwd),
    expiresAt: expiry.iso,
    namespacedToolId,
    projectId: requiredText(input.projectId, "projectId"),
    runId: requiredText(input.runId, "runId"),
    safeEnv: canonicalizeSafeApprovalEnvironment(input.safeEnv),
    schemaVersion,
  };
  const canonicalPayload = JSON.stringify(payload);
  return Object.freeze({
    digest: approvalDigest(canonicalPayload),
    canonicalPayload,
    expiresAt: payload.expiresAt,
    callerSessionId: payload.callerSessionId,
  });
}

function parseAndVerifyKey(key: CanonicalApprovalKey): ApprovalKeyPayload {
  if (!key || typeof key !== "object") throw new ApprovalContractError("approval key is invalid.");
  if (typeof key.canonicalPayload !== "string" || !/^[a-f0-9]{64}$/.test(key.digest)) {
    throw new ApprovalContractError("approval key is invalid.");
  }
  if (approvalDigest(key.canonicalPayload) !== key.digest) {
    throw new ApprovalContractError("approval key digest does not match its payload.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(key.canonicalPayload);
  } catch {
    throw new ApprovalContractError("approval key payload is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApprovalContractError("approval key payload is invalid.");
  }
  const payload = parsed as ApprovalKeyPayload;
  const namespacedToolId = requiredText(payload.namespacedToolId, "namespacedToolId", 512);
  if (!validToolId(namespacedToolId)) {
    throw new ApprovalContractError("approval key tool id is invalid.");
  }
  const expiry = canonicalExpiry(payload.expiresAt, "expiresAt");
  const canonicalPayload: ApprovalKeyPayload = {
    actorId: requiredText(payload.actorId, "actorId"),
    args: canonicalizeApprovalArgs(payload.args),
    callerSessionId: requiredText(payload.callerSessionId, "callerSessionId"),
    cwd: canonicalizeApprovalCwd(payload.cwd),
    expiresAt: expiry.iso,
    namespacedToolId,
    projectId: requiredText(payload.projectId, "projectId"),
    runId: requiredText(payload.runId, "runId"),
    safeEnv: canonicalizeSafeApprovalEnvironment(payload.safeEnv),
    schemaVersion: requiredText(payload.schemaVersion, "schemaVersion", 128),
  };
  if (JSON.stringify(canonicalPayload) !== key.canonicalPayload) {
    throw new ApprovalContractError("approval key payload is not canonical.");
  }
  if (canonicalPayload.expiresAt !== key.expiresAt || canonicalPayload.callerSessionId !== key.callerSessionId) {
    throw new ApprovalContractError("approval key identity fields do not match its payload.");
  }
  return canonicalPayload;
}

/**
 * Reference grant store for contract tests and a single server process.
 * Wave 2 must preserve these semantics inside a durable transaction.
 */
export class InMemoryApprovalGrantStore {
  private readonly grants = new Map<string, ApprovalGrant>();

  recordDecision(
    key: CanonicalApprovalKey,
    decision: ApprovalDecision,
    options: { now?: Date; sessionExpiresAt?: string } = {},
  ): void {
    const payload = parseAndVerifyKey(key);
    const nowMs = (options.now ?? new Date()).getTime();
    const approvalExpiryMs = Date.parse(payload.expiresAt);
    if (approvalExpiryMs <= nowMs) throw new ApprovalContractError("approval key has expired.");
    if (decision !== "allow_once" && decision !== "allow_session" && decision !== "deny") {
      throw new ApprovalContractError("approval decision is invalid.");
    }
    if (this.grants.has(key.digest)) {
      throw new ApprovalContractError("approval decision was already recorded.");
    }

    let expiresAtMs = approvalExpiryMs;
    if (decision === "allow_session") {
      if (!options.sessionExpiresAt) {
        throw new ApprovalContractError("allow_session requires sessionExpiresAt.");
      }
      const sessionExpiry = canonicalExpiry(options.sessionExpiresAt, "sessionExpiresAt");
      if (sessionExpiry.milliseconds <= nowMs) {
        throw new ApprovalContractError("sessionExpiresAt must be in the future.");
      }
      expiresAtMs = Math.min(approvalExpiryMs, sessionExpiry.milliseconds);
    }

    this.grants.set(key.digest, {
      decision,
      expiresAtMs,
      callerSessionId: payload.callerSessionId,
      revoked: false,
    });
  }

  authorizeAndConsume(
    key: CanonicalApprovalKey,
    now = new Date(),
  ): ApprovalAuthorization {
    parseAndVerifyKey(key);
    const grant = this.grants.get(key.digest);
    if (!grant) return { allowed: false, code: "missing" };
    if (grant.revoked) return { allowed: false, code: "revoked" };
    if (grant.expiresAtMs <= now.getTime()) {
      this.grants.delete(key.digest);
      return { allowed: false, code: "expired" };
    }
    if (grant.decision === "deny") return { allowed: false, code: "denied" };
    if (grant.decision === "allow_once") {
      // Deletion happens before success returns. No second caller can consume this grant.
      this.grants.delete(key.digest);
      return { allowed: true, code: "allowed_once" };
    }
    return { allowed: true, code: "allowed_session" };
  }

  revoke(key: CanonicalApprovalKey): boolean {
    parseAndVerifyKey(key);
    const grant = this.grants.get(key.digest);
    if (!grant) return false;
    grant.revoked = true;
    return true;
  }

  revokeSession(callerSessionId: string): number {
    const sessionId = requiredText(callerSessionId, "callerSessionId");
    let revoked = 0;
    for (const grant of this.grants.values()) {
      if (grant.decision === "allow_session" && grant.callerSessionId === sessionId && !grant.revoked) {
        grant.revoked = true;
        revoked += 1;
      }
    }
    return revoked;
  }
}
