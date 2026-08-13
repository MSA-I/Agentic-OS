import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { foldersRoot } from "./config";

export const AGENT_OS_FOLDERS_ROOT = foldersRoot();

export function workspacePath(...segments: string[]): string {
  const target = path.resolve(AGENT_OS_FOLDERS_ROOT, ...segments);
  if (target !== AGENT_OS_FOLDERS_ROOT && !target.startsWith(AGENT_OS_FOLDERS_ROOT + path.sep)) {
    throw new Error(`Workspace path escapes AGENT_OS_FOLDERS_ROOT: ${target}`);
  }
  return target;
}

export function ensureWorkspaceRootSync(): string {
  if (!existsSync(AGENT_OS_FOLDERS_ROOT)) {
    mkdirSync(AGENT_OS_FOLDERS_ROOT, { recursive: true });
  }
  return AGENT_OS_FOLDERS_ROOT;
}

export function isInsideWorkspaceRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved === AGENT_OS_FOLDERS_ROOT || resolved.startsWith(AGENT_OS_FOLDERS_ROOT + path.sep);
}
