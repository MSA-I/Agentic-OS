import "server-only";

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AGENT_OS_FOLDERS_ROOT } from "@/lib/workspaceRoot";
import {
  runForegroundCommand,
  runSetupAction,
  SetupRuntimeError,
} from "@/lib/setupRuntime";
import { DEFAULT_TIMEOUT_SECONDS } from "./commandPolicy";
import type { PlanStep } from "./planSchema";

/**
 * Runs one approved step.
 *
 * Two kinds reach here. A catalog step goes straight back through
 * `runSetupAction`, so it carries exactly the risk the Setup Center already
 * had — a pinned command a person wrote and Git reviewed. A command step is the
 * new thing: the *set* of commands is chosen by a model at runtime, bounded by
 * the closed program allowlist in commandPolicy and executed through the same
 * `runForegroundCommand` the fixed commands use, so there is one spawn site,
 * one timeout and one output cap in the whole feature.
 */

export interface StepOutcome {
  ok: boolean;
  message: string;
  /** Present when the step actually spawned something. */
  cwdLabel?: string;
}

/**
 * Where a clone lands. `git clone` is the one command whose result depends on
 * the working directory, so it gets a server-created folder under the workspace
 * root, named after the service. Everything else runs where the fixed commands
 * run; package managers install globally and ignore cwd anyway.
 */
async function cloneDirectory(route: string): Promise<{ absolutePath: string; label: string }> {
  const slug = route.replace(/^\/+/u, "").replace(/[^A-Za-z0-9._-]+/gu, "-") || "service";
  const absolutePath = path.join(AGENT_OS_FOLDERS_ROOT, "agent-install", slug);
  if (!existsSync(absolutePath)) await mkdir(absolutePath, { recursive: true });
  return { absolutePath, label: path.join("agent-install", slug) };
}

export async function runPlanStep(route: string, step: PlanStep): Promise<StepOutcome> {
  if (step.kind === "manual") {
    // Never reached: the plan store refuses to claim a manual step. Kept so the
    // switch is total and a future caller cannot silently execute one.
    return { ok: false, message: "צעד ידני אינו רץ אוטומטית." };
  }

  if (step.kind === "catalog") {
    const result = await runSetupAction({
      route,
      actionId: step.actionId,
      confirm: true,
      values: {},
    });
    return {
      ok: result.ok !== false,
      message: result.message ?? "הפעולה הסתיימה.",
    };
  }

  const isClone = step.program === "git" && step.args[0] === "clone";
  const directory = isClone ? await cloneDirectory(route) : null;
  const timeoutMs = Math.round((step.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000);

  const message = await runForegroundCommand(
    {
      executable: step.program,
      args: step.args,
      mode: "foreground",
      timeoutMs,
    },
    {
      cwd: directory?.absolutePath,
      // A wider window than the fixed commands get: this output is the only
      // thing the user has to judge a step they approved sight-unseen.
      tail: { lines: 60, chars: 8000 },
    },
  );
  return { ok: true, message, cwdLabel: directory?.label };
}

export { SetupRuntimeError };
