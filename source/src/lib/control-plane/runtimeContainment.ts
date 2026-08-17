import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { GuardedProvider } from "./executableIdentity";

export type RuntimeContainmentBlocker = "windows_job_object_launcher_unavailable";

export class RuntimeContainmentError extends Error {
  readonly code: "launch_cwd_invalid" | "launch_cwd_changed" | "runtime_containment_unavailable";
  readonly blocker?: RuntimeContainmentBlocker;
  constructor(
    code: "launch_cwd_invalid" | "launch_cwd_changed" | "runtime_containment_unavailable",
    message: string,
    blocker?: RuntimeContainmentBlocker,
  ) {
    super(message);
    this.code = code;
    this.blocker = blocker;
    this.name = "RuntimeContainmentError";
  }
}

export interface ApprovedLaunchDirectory {
  schemaVersion: 1;
  provider: GuardedProvider;
  projectId: string;
  absolutePath: string;
  device: number;
  inode: number;
  modifiedMs: number;
}

function isDeviceOrUncPath(candidate: string): boolean {
  return /^(?:\\\\|\\\?\\|\\\.\\|\/\/)/u.test(candidate);
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function approveLaunchDirectory(
  provider: GuardedProvider,
  projectId: string,
  candidate: string,
): ApprovedLaunchDirectory {
  if (!path.isAbsolute(candidate) || isDeviceOrUncPath(candidate)) {
    throw new RuntimeContainmentError("launch_cwd_invalid", "Provider launch cwd must be an absolute local directory from the project registry.");
  }
  try {
    const canonical = realpathSync.native(candidate);
    const link = lstatSync(candidate);
    const directory = statSync(canonical);
    if (link.isSymbolicLink() || !samePath(candidate, canonical) || !directory.isDirectory()) throw new Error("not a canonical directory");
    return {
      schemaVersion: 1,
      provider,
      projectId,
      absolutePath: canonical,
      device: directory.dev,
      inode: directory.ino,
      modifiedMs: directory.mtimeMs,
    };
  } catch {
    throw new RuntimeContainmentError("launch_cwd_invalid", "Provider launch cwd is missing, reparse-backed, or not a directory.");
  }
}

export function assertLaunchDirectoryBindingSync(directory: ApprovedLaunchDirectory): void {
  try {
    const canonical = realpathSync.native(directory.absolutePath);
    const link = lstatSync(directory.absolutePath);
    const current = statSync(canonical);
    if (link.isSymbolicLink()
      || !current.isDirectory()
      || !samePath(canonical, directory.absolutePath)
      || current.dev !== directory.device
      || current.ino !== directory.inode) {
      throw new Error("cwd identity mismatch");
    }
  } catch {
    throw new RuntimeContainmentError("launch_cwd_changed", "Provider launch cwd changed after registry approval; launch denied.");
  }
}

/**
 * Wave 1 deliberately keeps Windows provider starts disabled. Node does not
 * expose suspended CreateProcess + AssignProcessToJobObject, and taskkill after
 * spawn cannot close the spawn/register escape. Wave 2 must supply that native
 * launcher before this gate can return.
 */
export function assertRuntimeContainmentAvailable(_provider: GuardedProvider): void {
  if (process.platform === "win32") {
    throw new RuntimeContainmentError(
      "runtime_containment_unavailable",
      "Windows provider start is disabled until a verified Job Object launcher is installed.",
      "windows_job_object_launcher_unavailable",
    );
  }
}
