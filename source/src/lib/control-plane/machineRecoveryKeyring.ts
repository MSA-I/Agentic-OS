import "server-only";

import { createHash } from "node:crypto";
import {
  lstatSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureWindowsJobLauncherIdentitySync } from "./windowsJobProcess";

export interface MachineRecoveryKeyring {
  schemaVersion: 1;
  primarySecret: string;
  recoverySecrets: readonly string[];
  storagePath: string;
}

export interface MachineRecoveryKeyringOptions {
  directory?: string;
  bootstrapSecret?: string;
}

function legacyBootstrapRecoverySecret(bootstrapSecret?: string): string | null {
  if (!bootstrapSecret || bootstrapSecret.length < 32) return null;
  return createHash("sha256")
    .update("agent-os:wave3:windows-job-recovery\0", "utf8")
    .update(bootstrapSecret, "utf8")
    .digest("base64url");
}

function defaultDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA?.trim()
    || path.join(os.homedir(), "AppData", "Local");
  if (!path.isAbsolute(localAppData) || /^(?:\\\\|\\\\\?\\|\\\\\.\\|\/\/)/u.test(localAppData)) {
    throw new Error("Machine-local application data path is invalid.");
  }
  return path.join(localAppData, "AgentOS-ControlPlane");
}

function localAbsolutePath(candidate: string, label: string): string {
  const resolved = path.resolve(candidate);
  if (!path.isAbsolute(resolved) || /^(?:\\\\|\\\\\?\\|\\\\\.\\|\/\/)/u.test(resolved)) {
    throw new Error(`${label} must be local and absolute.`);
  }
  return resolved;
}

interface MachineRecoveryKeyringHelperInvocation {
  args: readonly string[];
  env: Readonly<NodeJS.ProcessEnv>;
  input: string;
}

function helperInvocation(
  directory: string,
  bootstrapSecret?: string,
): MachineRecoveryKeyringHelperInvocation {
  const scriptPath = keyringScriptPath();
  assertOrdinaryScript(scriptPath);
  const legacySecret = legacyBootstrapRecoverySecret(bootstrapSecret);
  return Object.freeze({
    args: Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath]),
    env: Object.freeze({
      NODE_ENV: process.env.NODE_ENV ?? "production",
      SystemRoot: process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
      WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
      AGENT_OS_MACHINE_KEYRING_DIRECTORY: directory,
    }),
    input: JSON.stringify({ schemaVersion: 2, legacySecret }),
  });
}

function keyringScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "machineRecoveryKeyring.ps1");
}

function assertOrdinaryScript(scriptPath: string): void {
  const information = lstatSync(scriptPath);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error("Machine recovery keyring helper is invalid.");
  }
  if (path.resolve(realpathSync.native(scriptPath)).toLowerCase() !== path.resolve(scriptPath).toLowerCase()) {
    throw new Error("Machine recovery keyring helper is reparse-backed.");
  }
}

export function loadOrCreateMachineRecoveryKeyring(
  options: MachineRecoveryKeyringOptions = {},
): MachineRecoveryKeyring {
  if (process.platform !== "win32") {
    throw new Error("Machine recovery keyring requires Windows DPAPI.");
  }
  const directory = localAbsolutePath(options.directory ?? defaultDirectory(), "Machine recovery keyring directory");
  const launcher = captureWindowsJobLauncherIdentitySync();
  const invocation = helperInvocation(
    directory,
    options.bootstrapSecret ?? process.env.AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET,
  );
  // The helper's stdin and stdout are captured anonymous pipes owned by this
  // process. They intentionally carry derived recovery secrets as private IPC.
  // They must never be inherited, logged, or forwarded to provider output.
  const result = spawnSync(
    launcher.powershellPath,
    invocation.args,
    {
      input: invocation.input,
      env: invocation.env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0 || result.error) {
    throw new Error("Machine recovery keyring could not be loaded securely.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Machine recovery keyring returned an invalid response.");
  }
  const value = parsed as Partial<{
    schemaVersion: number;
    primarySecret: string;
    legacySecrets: unknown[];
  }>;
  const legacySecrets = Array.isArray(value.legacySecrets)
    ? value.legacySecrets.filter((candidate): candidate is string => (
        typeof candidate === "string" && candidate.length >= 32
      ))
    : [];
  const storagePath = path.join(directory, "recovery-keyring.v1.dpapi");
  const storageInformation = lstatSync(storagePath);
  if (
    value.schemaVersion !== 1
    || typeof value.primarySecret !== "string"
    || value.primarySecret.length < 32
    || !storageInformation.isFile()
    || storageInformation.isSymbolicLink()
    || path.resolve(realpathSync.native(storagePath)).toLowerCase() !== path.resolve(storagePath).toLowerCase()
  ) {
    throw new Error("Machine recovery keyring response failed validation.");
  }
  const recoverySecrets = [...new Set([value.primarySecret, ...legacySecrets])];
  return Object.freeze({
    schemaVersion: 1,
    primarySecret: value.primarySecret,
    recoverySecrets: Object.freeze(recoverySecrets),
    storagePath: path.resolve(storagePath),
  });
}
