import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const BLOCKED_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "auth.json",
  "credentials.json",
  "secrets.json",
]);

const BLOCKED_SEGMENTS = new Set([
  ".git",
  ".gnupg",
  ".ssh",
  "secret-data",
  "secrets",
  "vault-data",
]);

const BLOCKED_EXTENSIONS = new Set([
  ".key",
  ".keystore",
  ".p12",
  ".pem",
  ".pfx",
]);

function normalizeForPolicy(candidate: string): string[] {
  return candidate
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

export function isSensitivePath(candidate: string): boolean {
  const segments = normalizeForPolicy(candidate);
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment))) return true;
  const basename = segments.at(-1) ?? "";
  if (BLOCKED_BASENAMES.has(basename)) return true;
  if (basename.startsWith(".env.")) return true;
  if (basename.endsWith(".credentials.json")) return true;
  return BLOCKED_EXTENSIONS.has(path.extname(basename));
}

export type ContainedPathFailure =
  | "absolute-path"
  | "device-or-unc-path"
  | "missing"
  | "outside-root"
  | "reparse-point"
  | "sensitive-path";

export type ContainedPathResult =
  | { ok: true; absolutePath: string; realRoot: string }
  | { ok: false; reason: ContainedPathFailure };

function isDeviceOrUncPath(candidate: string): boolean {
  return /^(?:\\\\|\\\?\\|\\\.\\|\/\/)/u.test(candidate);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    !relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative)
  );
}

export function resolveContainedExistingPathSync(
  root: string,
  relativePath: string,
): ContainedPathResult {
  if (path.isAbsolute(relativePath)) return { ok: false, reason: "absolute-path" };
  if (isDeviceOrUncPath(relativePath)) return { ok: false, reason: "device-or-unc-path" };
  if (isSensitivePath(relativePath)) return { ok: false, reason: "sensitive-path" };

  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    return { ok: false, reason: "missing" };
  }

  const lexicalCandidate = path.resolve(realRoot, relativePath);
  if (!isWithin(realRoot, lexicalCandidate)) return { ok: false, reason: "outside-root" };

  const relativeSegments = path.relative(realRoot, lexicalCandidate).split(path.sep).filter(Boolean);
  let cursor = realRoot;
  try {
    for (const segment of relativeSegments) {
      cursor = path.join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) {
        return { ok: false, reason: "reparse-point" };
      }
    }
    const realCandidate = realpathSync.native(lexicalCandidate);
    if (!isWithin(realRoot, realCandidate)) return { ok: false, reason: "outside-root" };
    return { ok: true, absolutePath: realCandidate, realRoot };
  } catch {
    return { ok: false, reason: "missing" };
  }
}
