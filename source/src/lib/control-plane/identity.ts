import { createHash } from "node:crypto";

export const CONTROL_PLANE_PROVIDERS = [
  "codex",
  "claude",
  "hermes",
  "openclaw",
  "antigravity",
] as const;

export type ControlPlaneProvider = (typeof CONTROL_PLANE_PROVIDERS)[number];

export interface ControlPlaneIdentity {
  callerSessionId: string;
  actorId: string;
  projectId: string;
  worktreeId: string;
  provider: ControlPlaneProvider;
  profileId: string | null;
  nativeSessionId: string | null;
  runId: string;
}

export class ControlPlaneIdentityError extends Error {
  readonly code = "invalid_identity";

  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneIdentityError";
  }
}

const REQUIRED_FIELDS = [
  "callerSessionId",
  "actorId",
  "projectId",
  "worktreeId",
  "runId",
] as const;

const IDENTITY_FIELDS = [
  ...REQUIRED_FIELDS,
  "provider",
  "profileId",
  "nativeSessionId",
] as const;

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ControlPlaneIdentityError(`${field} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ControlPlaneIdentityError(`${field} is invalid.`);
  }
  return normalized;
}

function optionalIdentifier(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredIdentifier(value, field);
}

export function createControlPlaneIdentity(input: Record<string, unknown>): Readonly<ControlPlaneIdentity> {
  const provider = requiredIdentifier(input.provider, "provider");
  if (!CONTROL_PLANE_PROVIDERS.includes(provider as ControlPlaneProvider)) {
    throw new ControlPlaneIdentityError("provider is not supported.");
  }

  const identity: ControlPlaneIdentity = {
    callerSessionId: requiredIdentifier(input.callerSessionId, "callerSessionId"),
    actorId: requiredIdentifier(input.actorId, "actorId"),
    projectId: requiredIdentifier(input.projectId, "projectId"),
    worktreeId: requiredIdentifier(input.worktreeId, "worktreeId"),
    provider: provider as ControlPlaneProvider,
    profileId: optionalIdentifier(input.profileId, "profileId"),
    nativeSessionId: optionalIdentifier(input.nativeSessionId, "nativeSessionId"),
    runId: requiredIdentifier(input.runId, "runId"),
  };

  return Object.freeze(identity);
}

export function assertControlPlaneIdentity(value: unknown): asserts value is ControlPlaneIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlPlaneIdentityError("identity must be an object.");
  }
  const record = value as Record<string, unknown>;
  const canonical = createControlPlaneIdentity(record);
  for (const field of IDENTITY_FIELDS) {
    if (record[field] !== canonical[field]) {
      throw new ControlPlaneIdentityError(`${field} is not canonical.`);
    }
  }
}

export function identityMismatchFields(
  expected: ControlPlaneIdentity,
  actual: ControlPlaneIdentity,
): string[] {
  return IDENTITY_FIELDS.filter((field) => expected[field] !== actual[field]);
}

export function assertIdentityMatch(
  expected: ControlPlaneIdentity,
  actual: ControlPlaneIdentity,
): void {
  assertControlPlaneIdentity(expected);
  assertControlPlaneIdentity(actual);
  const mismatches = identityMismatchFields(expected, actual);
  if (mismatches.length > 0) {
    throw new ControlPlaneIdentityError(`identity mismatch: ${mismatches.join(", ")}.`);
  }
}

export function identityFingerprint(identity: ControlPlaneIdentity): string {
  assertControlPlaneIdentity(identity);
  const canonical = JSON.stringify(Object.fromEntries(
    IDENTITY_FIELDS.map((field) => [field, identity[field]]),
  ));
  return createHash("sha256").update(canonical).digest("hex");
}
