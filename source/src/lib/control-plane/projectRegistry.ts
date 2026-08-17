import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { listNativeAgentHistory } from "@/lib/nativeAgentHistory";
import { isSafeProjectName } from "@/lib/projectName";
import { AGENT_OS_FOLDERS_ROOT } from "@/lib/workspaceRoot";
import type { GuardedProvider } from "./executableIdentity";
import { approveLaunchDirectory, type ApprovedLaunchDirectory } from "./runtimeContainment";

export class ProjectRegistryError extends Error {
  readonly code: "project_not_registered" | "project_directory_invalid";
  constructor(
    code: "project_not_registered" | "project_directory_invalid",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "ProjectRegistryError";
  }
}

function exactRegistryRoot(
  groups: Awaited<ReturnType<typeof listNativeAgentHistory>>["groups"],
  projectId: string,
): string | null {
  const matches = groups.filter((group) => group.id === projectId);
  return matches.length === 1 && matches[0].root ? matches[0].root : null;
}

/**
 * Resolves client project identity through server-owned registry state. The
 * client never supplies a filesystem path. A simple project name that is not
 * yet in native history maps to the server-owned scratch registry root.
 */
export async function resolveRegisteredProjectLaunchDirectory(
  provider: GuardedProvider,
  projectId: string | null | undefined,
): Promise<ApprovedLaunchDirectory> {
  const requested = projectId?.trim() || `${provider}-default`;
  const index = await listNativeAgentHistory(provider);
  let root = exactRegistryRoot(index.groups, requested);

  if (!root && isSafeProjectName(requested)) {
    root = path.join(AGENT_OS_FOLDERS_ROOT, requested);
    if (!existsSync(root)) await mkdir(root, { recursive: true });
  }
  if (!root) {
    throw new ProjectRegistryError("project_not_registered", "Selected provider project is not present in the server project registry.");
  }

  try {
    return approveLaunchDirectory(provider, requested, root);
  } catch {
    throw new ProjectRegistryError("project_directory_invalid", "Registered provider project failed canonical cwd validation.");
  }
}
