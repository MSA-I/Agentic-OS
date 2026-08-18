import "server-only";

import { randomBytes } from "node:crypto";
import { checkCommand, DEFAULT_TIMEOUT_SECONDS } from "./commandPolicy";
import type { PlanStep } from "./planSchema";

/**
 * Holds the plan the user approved, so approval is a server-side fact rather
 * than a UI state.
 *
 * Without this, the step route would have to accept `{program, args}` from the
 * browser. It could re-validate them, but it could not know they are the ones
 * the user actually read before clicking approve. Storing the plan once and
 * executing by index closes that gap, and it also keeps program names and
 * arguments out of the execution request entirely.
 *
 * In memory on purpose: a plan is only meaningful for the few minutes a person
 * is watching it run, and a server restart should not resurrect an approval
 * nobody remembers giving.
 */

const PLAN_TTL_MS = 30 * 60_000;
const MAX_PLANS = 32;

export interface StoredPlan {
  planId: string;
  route: string;
  steps: readonly PlanStep[];
  /** Marks a step consumed, so an approved plan cannot be replayed step by step. */
  consumed: Set<number>;
  createdAt: number;
  expiresAt: number;
}

export type PlanStoreError =
  | "plan_unknown"
  | "plan_expired"
  | "step_out_of_range"
  | "step_already_run"
  | "step_not_runnable";

const plans = new Map<string, StoredPlan>();

function sweep(now: number): void {
  for (const [planId, plan] of plans) {
    if (plan.expiresAt <= now) plans.delete(planId);
  }
  // A bounded map so a page left open for a day cannot grow this without limit.
  while (plans.size > MAX_PLANS) {
    const oldest = [...plans.values()].reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
    plans.delete(oldest.planId);
  }
}

/**
 * Validates every runnable step once more on the server, then stores the plan.
 * The browser has already filtered the list, but that filtering is UX; this is
 * the control.
 */
export function storeApprovedPlan(
  route: string,
  steps: readonly PlanStep[],
  now = Date.now(),
): { planId: string; runnable: number } | { error: string } {
  for (const [index, step] of steps.entries()) {
    if (step.kind === "manual") continue;
    if (step.kind === "catalog") {
      if (typeof step.actionId !== "string" || !step.actionId.trim()) {
        return { error: `Step ${index + 1} names no catalog action.` };
      }
      continue;
    }
    const check = checkCommand(step.program, step.args, step.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
    if (!check.ok) return { error: `Step ${index + 1}: ${check.reason}` };
  }

  sweep(now);
  const planId = randomBytes(18).toString("base64url");
  plans.set(planId, {
    planId,
    route,
    steps,
    consumed: new Set(),
    createdAt: now,
    expiresAt: now + PLAN_TTL_MS,
  });
  return { planId, runnable: steps.filter((step) => step.kind !== "manual").length };
}

export function claimPlanStep(
  planId: string,
  stepIndex: number,
  now = Date.now(),
): { plan: StoredPlan; step: PlanStep } | { error: PlanStoreError } {
  sweep(now);
  const plan = plans.get(planId);
  if (!plan) return { error: "plan_unknown" };
  if (plan.expiresAt <= now) {
    plans.delete(planId);
    return { error: "plan_expired" };
  }
  if (!Number.isSafeInteger(stepIndex) || stepIndex < 0 || stepIndex >= plan.steps.length) {
    return { error: "step_out_of_range" };
  }
  if (plan.consumed.has(stepIndex)) return { error: "step_already_run" };
  const step = plan.steps[stepIndex];
  if (step.kind === "manual") return { error: "step_not_runnable" };
  plan.consumed.add(stepIndex);
  return { plan, step };
}

/** Test seam. Never called by the application. */
export function resetPlanStoreForTests(): void {
  plans.clear();
}
