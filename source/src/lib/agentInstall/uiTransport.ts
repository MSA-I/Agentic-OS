"use client";

import { executeWorkbenchRun, type WorkbenchPilotProvider } from "@/lib/workbench/uiClient";
import type { InstallAgentId } from "./agentTypes";

/**
 * One call the panel makes, whichever agent answers.
 *
 * Claude and Codex go through the durable Workbench pilot from the browser, so
 * the conversation is saved as a normal session of that agent — which is the
 * whole point of routing through it rather than inventing a side channel.
 * Hermes has no Workbench provider yet and cannot launch on Windows at all, so
 * asking for it fails here with the reason rather than somewhere deeper.
 */

/** One stable project for every install conversation, so the deep link is deterministic. */
export const INSTALL_PROJECT_ID = "setup-center";

export interface AskResult {
  text: string;
  sessionId: string | null;
  runId: string | null;
  agent: InstallAgentId;
}

export class InstallTransportError extends Error {
  readonly agent: InstallAgentId;
  constructor(agent: InstallAgentId, message: string) {
    super(message);
    this.name = "InstallTransportError";
    this.agent = agent;
  }
}

function isWorkbenchAgent(agent: InstallAgentId): agent is WorkbenchPilotProvider {
  return agent === "claude" || agent === "codex";
}

export async function askInstallAgent(
  input: {
    agent: InstallAgentId;
    prompt: string;
    /** Supplied to continue the same conversation, e.g. for the one repair retry. */
    sessionId?: string | null;
  },
  onPartial?: (text: string) => void,
  signal?: AbortSignal,
): Promise<AskResult> {
  if (!isWorkbenchAgent(input.agent)) {
    throw new InstallTransportError(
      input.agent,
      "Hermes עדיין לא מחובר ל-Workbench, ולכן אי אפשר להריץ אותו ב-Windows.",
    );
  }

  let text = "";
  const snapshot = await executeWorkbenchRun(
    {
      agentId: input.agent,
      prompt: input.prompt,
      projectId: INSTALL_PROJECT_ID,
      sessionId: input.sessionId ?? null,
      panel: "transcript",
    },
    {
      onOutput: (chunk) => {
        text += chunk;
        onPartial?.(text);
      },
    },
    signal,
  );

  return {
    text,
    sessionId: snapshot.run.context.sessionId ?? null,
    runId: snapshot.run.id,
    agent: input.agent,
  };
}
