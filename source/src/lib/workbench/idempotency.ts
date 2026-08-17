import { createHash } from "node:crypto";

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Idempotency payload cannot contain non-finite numbers.");
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return null;
  if (typeof value !== "object") throw new TypeError(`Unsupported idempotency payload value: ${typeof value}.`);
  if (seen.has(value)) throw new TypeError("Idempotency payload cannot contain cycles.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

export function canonicalIdempotencyJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function idempotencyPayloadHash(value: unknown): string {
  return sha256Text(canonicalIdempotencyJson(value));
}

export function createRunIdempotencyBinding(input: {
  actorId: string | null;
  projectId: string | null;
  operation: string;
  callerKey: string;
  payload: unknown;
}): { scope: string; key: string; payloadHash: string } {
  const payloadHash = idempotencyPayloadHash(input.payload);
  const scope = sha256Text(canonicalIdempotencyJson({
    actorId: input.actorId,
    projectId: input.projectId,
    operation: input.operation,
    callerKey: input.callerKey,
  }));
  const key = sha256Text(canonicalIdempotencyJson({ scope, payloadHash }));
  return { scope, key, payloadHash };
}
