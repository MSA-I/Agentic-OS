import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type GuardedProvider = "codex" | "claude" | "hermes" | "openclaw" | "antigravity";

export type ExecutableIdentityErrorCode =
  | "executable_unconfigured"
  | "executable_not_found"
  | "executable_not_absolute"
  | "executable_collision"
  | "executable_version_unavailable"
  | "executable_identity_changed"
  | "executable_identity_invalidated"
  | "executable_shim_unverifiable"
  | "forbidden_provider_flag"
  | "forbidden_provider_environment";

export class ExecutableIdentityError extends Error {
  readonly code: ExecutableIdentityErrorCode;
  constructor(
    code: ExecutableIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "ExecutableIdentityError";
  }
}

export interface ExecutableFileIdentity {
  role: "configured" | "runtime" | "payload";
  absolutePath: string;
  sha256: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface ExecutableIdentity {
  schemaVersion: 2;
  provider: GuardedProvider;
  /** Canonical configured executable. Kept separate from the actual launch chain. */
  absolutePath: string;
  /** Canonical program handed to CreateProcess/spawn. */
  launchPath: string;
  /** Verified arguments placed before provider-controlled arguments. */
  launchArgsPrefix: string[];
  version: string;
  sha256: string;
  sizeBytes: number;
  modifiedAt: string;
  observedAt: string;
  files: ExecutableFileIdentity[];
}

export interface ExecutableResolutionOptions {
  pathValue?: string;
  pathExtensions?: string;
  platform?: NodeJS.Platform;
}

export interface ExecutableIdentityOptions extends ExecutableResolutionOptions {
  versionArgs?: readonly string[];
  versionTimeoutMs?: number;
  versionReader?: (absolutePath: string, args: readonly string[]) => Promise<string>;
  versionEnvironment?: Readonly<Record<string, string | undefined>>;
}

interface LaunchChain {
  configuredPath: string;
  launchPath: string;
  launchArgsPrefix: string[];
  files: Array<{ role: ExecutableFileIdentity["role"]; absolutePath: string }>;
}

const pins = new Map<GuardedProvider, ExecutableIdentity>();
const invalidations = new Map<GuardedProvider, ExecutableIdentityErrorCode>();

function pathKey(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

async function canonicalFile(candidate: string): Promise<string | null> {
  try {
    const resolved = await realpath(candidate);
    const file = await stat(resolved);
    return file.isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function executableNames(command: string, platform: NodeJS.Platform, pathExtensions?: string): string[] {
  if (platform !== "win32" || path.extname(command)) return [command];
  const extensions = (pathExtensions || process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return extensions.map((extension) => `${command}${extension.toLowerCase()}`);
}

export async function resolveExecutablePath(
  configuredExecutable: string | null | undefined,
  options: ExecutableResolutionOptions = {},
): Promise<string> {
  const configured = configuredExecutable?.trim();
  if (!configured) {
    throw new ExecutableIdentityError("executable_unconfigured", "Provider executable is not configured.");
  }

  if (path.isAbsolute(configured)) {
    const canonical = await canonicalFile(configured);
    if (!canonical) throw new ExecutableIdentityError("executable_not_found", "Configured provider executable was not found.");
    return canonical;
  }

  if (configured.includes("/") || configured.includes("\\")) {
    throw new ExecutableIdentityError("executable_not_absolute", "Relative executable paths are not accepted.");
  }

  const platform = options.platform ?? process.platform;
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const matches = new Map<string, string>();
  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    for (const name of executableNames(configured, platform, options.pathExtensions)) {
      const canonical = await canonicalFile(path.join(directory, name));
      if (canonical) matches.set(pathKey(canonical, platform), canonical);
    }
  }

  if (matches.size === 0) {
    throw new ExecutableIdentityError("executable_not_found", "Provider executable could not be resolved from PATH.");
  }
  if (matches.size > 1) {
    throw new ExecutableIdentityError("executable_collision", "Multiple provider executables resolve from PATH; configure one absolute path.");
  }
  return [...matches.values()][0];
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sha256FileSync(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function safeVersion(value: string): string {
  return stripAnsi(value)
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 300) ?? "";
}

function shimPayloadReference(contents: string): string | null {
  const normalized = contents.replaceAll("\\", "/");
  const matches = [...normalized.matchAll(/(?:%dp0%|\$basedir)\/?([^"'\r\n]+?\.(?:c?js|mjs))/gi)];
  const unique = [...new Set(matches.map((match) => match[1].replace(/^\/+/, "")))];
  return unique.length === 1 ? unique[0] : null;
}

async function resolveLaunchChain(configuredPath: string, platform: NodeJS.Platform): Promise<LaunchChain> {
  const extension = path.extname(configuredPath).toLowerCase();
  if (platform !== "win32" || ![".cmd", ".bat", ".ps1"].includes(extension)) {
    return {
      configuredPath,
      launchPath: configuredPath,
      launchArgsPrefix: [],
      files: [{ role: "configured", absolutePath: configuredPath }],
    };
  }

  const payloadReference = shimPayloadReference(await readFile(configuredPath, "utf8"));
  if (!payloadReference) {
    throw new ExecutableIdentityError(
      "executable_shim_unverifiable",
      "Windows provider shim payload could not be resolved deterministically; launch denied.",
    );
  }
  const payloadPath = await canonicalFile(path.resolve(path.dirname(configuredPath), payloadReference));
  const runtimePath = await canonicalFile(process.execPath);
  if (!payloadPath || !runtimePath) {
    throw new ExecutableIdentityError("executable_shim_unverifiable", "Windows provider shim runtime or payload is missing.");
  }
  return {
    configuredPath,
    launchPath: runtimePath,
    launchArgsPrefix: [payloadPath],
    files: [
      { role: "configured", absolutePath: configuredPath },
      { role: "runtime", absolutePath: runtimePath },
      { role: "payload", absolutePath: payloadPath },
    ],
  };
}

async function readExecutableVersion(
  launchPath: string,
  launchArgsPrefix: readonly string[],
  args: readonly string[],
  timeoutMs: number,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(launchPath, [...launchArgsPrefix, ...args], {
      windowsHide: true,
      env: { ...environment } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(safeVersion(output));
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      finish(new ExecutableIdentityError("executable_version_unavailable", "Provider executable version probe timed out."));
    }, timeoutMs);
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(0, 16_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", () => finish(new ExecutableIdentityError("executable_version_unavailable", "Provider executable version probe failed.")));
    child.on("close", (code) => {
      const version = safeVersion(output);
      if (code !== 0 || !version) {
        finish(new ExecutableIdentityError("executable_version_unavailable", "Provider executable did not return a version."));
        return;
      }
      finish();
    });
  });
}

function matchesForbiddenArgument(argument: string, forbidden: readonly string[]): boolean {
  const normalized = argument.trim().toLowerCase();
  return forbidden.some((flag) => normalized === flag || normalized.startsWith(`${flag}=`));
}

export function assertProviderExecutionArguments(
  provider: GuardedProvider,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): void {
  const forbidden = provider === "hermes"
    ? ["--yolo", "--accept-hooks"]
    : provider === "codex"
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : provider === "claude"
        ? ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"]
        : provider === "antigravity"
          ? ["--dangerously-skip-permissions"]
          : [];
  if (args.some((argument) => matchesForbiddenArgument(argument, forbidden))) {
    throw new ExecutableIdentityError("forbidden_provider_flag", `${provider} launch contains a forbidden bypass flag.`);
  }
  if (provider === "codex") {
    const normalized = args.map((argument) => argument.trim().toLowerCase().replaceAll("'", "").replaceAll('"', ""));
    const dangerousSandbox = normalized.some((argument, index) =>
      argument === "--sandbox=danger-full-access"
      || argument === "sandbox_mode=danger-full-access"
      || (argument === "--sandbox" && normalized[index + 1] === "danger-full-access"));
    if (dangerousSandbox) {
      throw new ExecutableIdentityError("forbidden_provider_flag", "Codex launch requests an unrestricted sandbox.");
    }
  }
  for (const [key, rawValue] of Object.entries(environment)) {
    const normalizedKey = key.toUpperCase();
    const normalizedValue = String(rawValue ?? "").trim().toLowerCase();
    const enabled = normalizedValue !== "" && !["0", "false", "no", "off"].includes(normalizedValue);
    if (provider === "hermes" && enabled && ["HERMES_ACCEPT_HOOKS", "HERMES_YOLO"].includes(normalizedKey)) {
      throw new ExecutableIdentityError("forbidden_provider_environment", `${provider} launch contains a forbidden bypass environment variable.`);
    }
    if (provider === "antigravity" && enabled && normalizedKey === "ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS") {
      throw new ExecutableIdentityError("forbidden_provider_environment", `${provider} launch contains a forbidden bypass environment variable.`);
    }
  }
}

export function compareExecutableIdentity(
  expected: ExecutableIdentity,
  observed: Pick<ExecutableIdentity, "absolutePath" | "sha256" | "sizeBytes">,
): { valid: boolean; changedFields: string[] } {
  const changedFields: string[] = [];
  if (pathKey(expected.absolutePath, process.platform) !== pathKey(observed.absolutePath, process.platform)) changedFields.push("absolutePath");
  if (expected.sha256 !== observed.sha256) changedFields.push("sha256");
  if (expected.sizeBytes !== observed.sizeBytes) changedFields.push("sizeBytes");
  return { valid: changedFields.length === 0, changedFields };
}

async function observeFiles(chain: LaunchChain): Promise<ExecutableFileIdentity[]> {
  return Promise.all(chain.files.map(async ({ role, absolutePath }) => {
    const [file, sha256] = await Promise.all([stat(absolutePath), sha256File(absolutePath)]);
    return { role, absolutePath, sha256, sizeBytes: file.size, modifiedAt: file.mtime.toISOString() };
  }));
}

function sameFileIdentities(expected: readonly ExecutableFileIdentity[], observed: readonly ExecutableFileIdentity[]): boolean {
  return expected.length === observed.length && expected.every((file, index) => {
    const next = observed[index];
    return file.role === next?.role
      && pathKey(file.absolutePath, process.platform) === pathKey(next.absolutePath, process.platform)
      && file.sha256 === next.sha256
      && file.sizeBytes === next.sizeBytes;
  });
}

export async function assertPinnedExecutableIdentity(
  provider: GuardedProvider,
  configuredExecutable: string | null | undefined,
  options: ExecutableIdentityOptions = {},
): Promise<ExecutableIdentity> {
  if (invalidations.has(provider)) {
    throw new ExecutableIdentityError("executable_identity_invalidated", `${provider} executable identity is invalidated until process restart or explicit re-verification.`);
  }

  const absolutePath = await resolveExecutablePath(configuredExecutable, options);
  const chain = await resolveLaunchChain(absolutePath, options.platform ?? process.platform);
  const files = await observeFiles(chain);
  const configuredFile = files.find((file) => file.role === "configured") ?? files[0];
  const pinned = pins.get(provider);
  if (pinned) {
    if (!sameFileIdentities(pinned.files, files)) {
      invalidations.set(provider, "executable_identity_changed");
      throw new ExecutableIdentityError("executable_identity_changed", `${provider} executable chain changed after it was pinned; launch denied.`);
    }
    // observedAt records when the chain was last verified, not when it was
    // first seen. Every digest above has just been re-read and matched, so
    // this observation is happening now. Returning the original timestamp
    // made the pin look stale to the admission guard, which requires an
    // observation within five minutes — so a server left running for longer
    // than that refused every pilot run with guard_missing.
    const revalidated: ExecutableIdentity = { ...pinned, observedAt: new Date().toISOString() };
    pins.set(provider, revalidated);
    return revalidated;
  }

  const versionArgs = options.versionArgs ?? ["--version"];
  const versionReader = options.versionReader;
  const version = safeVersion(versionReader
    ? await versionReader(absolutePath, versionArgs)
    : await readExecutableVersion(
        chain.launchPath,
        chain.launchArgsPrefix,
        versionArgs,
        options.versionTimeoutMs ?? 10_000,
        options.versionEnvironment ?? {},
      ));
  if (!version) {
    throw new ExecutableIdentityError("executable_version_unavailable", `${provider} executable version could not be verified.`);
  }
  const identity: ExecutableIdentity = {
    schemaVersion: 2,
    provider,
    absolutePath,
    launchPath: chain.launchPath,
    launchArgsPrefix: chain.launchArgsPrefix,
    version,
    sha256: configuredFile.sha256,
    sizeBytes: configuredFile.sizeBytes,
    modifiedAt: configuredFile.modifiedAt,
    observedAt: new Date().toISOString(),
    files,
  };
  pins.set(provider, identity);
  return identity;
}

/**
 * Revalidates every canonical path and digest immediately before spawn. This
 * narrows hash-to-spawn TOCTOU. A native suspended-process handshake remains
 * required before Windows execution can be enabled.
 */
export function assertExecutableIdentityBindingSync(identity: ExecutableIdentity): void {
  try {
    for (const expected of identity.files) {
      const canonical = realpathSync.native(expected.absolutePath);
      const file = statSync(canonical);
      const valid = pathKey(canonical, process.platform) === pathKey(expected.absolutePath, process.platform)
        && file.isFile()
        && file.size === expected.sizeBytes
        && sha256FileSync(canonical) === expected.sha256;
      if (!valid) throw new Error("identity mismatch");
    }
  } catch {
    invalidations.set(identity.provider, "executable_identity_changed");
    throw new ExecutableIdentityError("executable_identity_changed", `${identity.provider} executable binding changed before spawn; launch denied.`);
  }
}

export async function assertProviderLaunch(
  provider: GuardedProvider,
  configuredExecutable: string | null | undefined,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
  options: ExecutableIdentityOptions = {},
): Promise<ExecutableIdentity> {
  assertProviderExecutionArguments(provider, args, environment);
  return assertPinnedExecutableIdentity(provider, configuredExecutable, { ...options, versionEnvironment: environment });
}

export function invalidateExecutableIdentity(provider: GuardedProvider): void {
  invalidations.set(provider, "executable_identity_invalidated");
}

export function resetExecutableIdentityPinsForTests(): void {
  pins.clear();
  invalidations.clear();
}
