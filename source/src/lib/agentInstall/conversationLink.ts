import type { InstallAgentId } from "./agentTypes";

/**
 * Builds the link that opens the install conversation on the agent's own page.
 *
 * Each desktop reads its own query parameters and then hydrates by matching the
 * requested id against the native history index, so a native session id is
 * enough — the app does not need to know where the transcript file lives.
 *
 * Caveat the UI must show rather than hide: the session file is written by the
 * agent and the index is read from disk, so immediately after a run the link can
 * land on an empty page for a few seconds. Polling for it would block the panel
 * for no real gain.
 */

export function buildConversationHref(
  agent: InstallAgentId,
  sessionId: string | null,
  projectId: string,
  profile?: string | null,
): string {
  const base = `/${agent}`;
  if (!sessionId) return base;
  const params = new URLSearchParams();
  if (agent === "codex") {
    params.set("agent", "codex");
    params.set("environment", "local");
  }
  params.set("project", projectId);
  params.set("session", sessionId);
  if (agent === "hermes" && profile) params.set("profile", profile);
  return `${base}?${params.toString()}`;
}
