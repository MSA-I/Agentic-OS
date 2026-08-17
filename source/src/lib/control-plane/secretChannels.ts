import { isSensitivePath } from "./pathSecurity";
import { redactRecord, redactText } from "../workbench/redaction";
import type { NativeArtifact } from "../workbench/types";

const ARTIFACT_PATH_KEYS = new Set(["cwd", "file", "filename", "path", "relpath", "root", "source", "uri", "url"]);

function normalizedKey(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function artifactUriPath(uri: string): string {
  try {
    const parsed = new URL(uri);
    return decodeURIComponent(parsed.pathname);
  } catch {
    return uri;
  }
}

function isArtifactPathKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return ARTIFACT_PATH_KEYS.has(normalized) || normalized.endsWith("path") || normalized.endsWith("uri") || normalized.endsWith("url");
}

function metadataContainsSensitivePath(value: unknown, key = "", depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string") return isArtifactPathKey(key) && isSensitivePath(artifactUriPath(value));
  if (Array.isArray(value)) return value.some((entry) => metadataContainsSensitivePath(entry, key, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([childKey, entry]) => metadataContainsSensitivePath(entry, childKey, depth + 1));
}

/** Final artifact DTO boundary: reject sensitive paths, then sanitize every visible field. */
export function sanitizeNativeArtifact(artifact: NativeArtifact): NativeArtifact | null {
  if (
    isSensitivePath(artifact.label)
    || isSensitivePath(artifactUriPath(artifact.uri))
    || metadataContainsSensitivePath(artifact.metadata)
  ) {
    return null;
  }
  return {
    id: redactText(artifact.id, 1_000),
    kind: redactText(artifact.kind, 100),
    label: redactText(artifact.label, 500),
    uri: redactText(artifact.uri, 4_000),
    metadata: redactRecord(artifact.metadata ?? {}) as Record<string, unknown>,
  };
}
