import {
  DEFAULT_TIMEOUT_SECONDS,
  checkCommand,
  type CommandRejectionCode,
} from "./commandPolicy";

/**
 * The contract between the agent's reply and the app.
 *
 * There is no system prompt and no tool calling on the restricted pilot, so the
 * contract is in-band: the agent is asked to answer with one JSON object between
 * two markers. Markers rather than markdown fences, because both providers emit
 * fences unprompted and a fence is ambiguous once the JSON contains backticks.
 *
 * Nothing here executes. Validation only decides what the user is shown and
 * what may later be sent to the executor.
 */

export const PLAN_OPEN_MARKER = "<<<AGENTOS_PLAN";
export const PLAN_CLOSE_MARKER = "AGENTOS_PLAN>>>";
export const MAX_STEPS = 12;
export const MAX_WHY_LENGTH = 200;
export const MAX_SUMMARY_LENGTH = 240;
export const MAX_INSTRUCTION_LENGTH = 400;

export interface CatalogStep {
  kind: "catalog";
  actionId: string;
  why: string;
}

export interface CommandStep {
  kind: "command";
  program: string;
  args: string[];
  why: string;
  timeoutSeconds: number;
}

export interface ManualStep {
  kind: "manual";
  instruction: string;
  why: string;
}

export type PlanStep = CatalogStep | CommandStep | ManualStep;

export interface InstallPlan {
  version: 1;
  service: string;
  summary: string;
  risks: string[];
  steps: PlanStep[];
}

/** A step the agent proposed, plus what the app decided about it. */
export interface ReviewedStep {
  step: PlanStep;
  /** Runnable steps are the ones a single approval will execute. */
  runnable: boolean;
  /** Present when the proposal was downgraded or refused, always with a reason. */
  rejection: { code: CommandRejectionCode | "action_unknown" | "action_manual" | "action_needs_input" | "step_invalid"; reason: string } | null;
}

export interface ParsedPlan {
  ok: boolean;
  plan: InstallPlan | null;
  steps: ReviewedStep[];
  errors: string[];
  /** The exact text the extractor worked on, so a failure can be shown honestly. */
  raw: string;
}

/** The action shape the parser needs. Structural, so both SetupCatalogEntry and the API payload fit. */
export interface KnownAction {
  id: string;
  label: string;
  kind: string;
  availability: "automatic" | "manual";
  fields?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Finds the JSON in a reply that may be wrapped in narration, fences, or both.
 * Scans from the end: agents put the prose first and the answer last, so the
 * last balanced object is the answer far more often than the first one is.
 */
export function extractPlanJson(reply: string): string | null {
  const open = reply.lastIndexOf(PLAN_OPEN_MARKER);
  if (open >= 0) {
    const after = reply.slice(open + PLAN_OPEN_MARKER.length);
    const close = after.indexOf(PLAN_CLOSE_MARKER);
    const body = close >= 0 ? after.slice(0, close) : after;
    const balanced = lastBalancedObject(body);
    if (balanced) return balanced;
  }
  const fenced = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/gu)].pop();
  if (fenced) {
    const balanced = lastBalancedObject(fenced[1]);
    if (balanced) return balanced;
  }
  return lastBalancedObject(reply);
}

/** Walks backwards from the last `}` to its matching `{`, ignoring braces inside strings. */
function lastBalancedObject(source: string): string | null {
  const end = source.lastIndexOf("}");
  if (end < 0) return null;
  let depth = 0;
  let inString = false;
  for (let index = end; index >= 0; index -= 1) {
    const char = source[index];
    if (inString) {
      // Walking backwards, a quote closes the string unless it is escaped by an
      // odd number of preceding backslashes.
      if (char === '"') {
        let slashes = 0;
        for (let back = index - 1; back >= 0 && source[back] === "\\"; back -= 1) slashes += 1;
        if (slashes % 2 === 0) inString = false;
      }
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "}") depth += 1;
    else if (char === "{") {
      depth -= 1;
      if (depth === 0) return source.slice(index, end + 1);
    }
  }
  return null;
}

/** One mechanical repair pass. Never an LLM repair — that belongs to the caller's retry. */
function repairJson(source: string): string {
  return source
    .replace(/^\s*json\s*/iu, "")
    .replace(/,(\s*[}\]])/gu, "$1");
}

function parseObject(source: string): { value: Record<string, unknown> | null; error: string | null } {
  for (const candidate of [source, repairJson(source)]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) return { value: parsed, error: null };
      return { value: null, error: "התשובה אינה אובייקט JSON." };
    } catch (cause) {
      if (candidate !== source) {
        return { value: null, error: cause instanceof Error ? cause.message : "JSON לא תקין." };
      }
    }
  }
  return { value: null, error: "JSON לא תקין." };
}

function reviewCatalogStep(
  raw: Record<string, unknown>,
  actions: readonly KnownAction[],
): ReviewedStep {
  const why = text(raw.why, MAX_WHY_LENGTH) ?? "";
  const actionId = typeof raw.actionId === "string" ? raw.actionId.trim() : "";
  const action = actions.find((candidate) => candidate.id === actionId);
  const step: CatalogStep = { kind: "catalog", actionId, why };

  if (!action) {
    return {
      step,
      runnable: false,
      rejection: { code: "action_unknown", reason: `אין פעולה בשם "${actionId}" בשירות הזה.` },
    };
  }
  if (action.availability !== "automatic") {
    // Running it would do nothing: runSetupAction short-circuits manual actions
    // and returns ok:true without executing. Show it as the manual step it is.
    return {
      step: { kind: "manual", instruction: action.label, why },
      runnable: false,
      rejection: { code: "action_manual", reason: `"${action.label}" היא פעולה ידנית ואינה מריצה דבר.` },
    };
  }
  if (Array.isArray(action.fields) && action.fields.length > 0) {
    // A connect action needs a key or a path only the owner has. The agent
    // cannot supply it, and running it with an empty value would just fail.
    return {
      step: { kind: "manual", instruction: action.label, why },
      runnable: false,
      rejection: { code: "action_needs_input", reason: `"${action.label}" דורשת ערך שרק אתה יודע — מלא אותה בכרטיס הפעולה.` },
    };
  }
  return { step, runnable: true, rejection: null };
}

function reviewCommandStep(raw: Record<string, unknown>): ReviewedStep {
  const why = text(raw.why, MAX_WHY_LENGTH) ?? "";
  const program = typeof raw.program === "string" ? raw.program.trim() : "";
  const args = Array.isArray(raw.args) ? raw.args.map((value) => (typeof value === "string" ? value : String(value))) : [];
  const timeoutSeconds = raw.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(raw.timeoutSeconds);
  const step: CommandStep = { kind: "command", program, args, why, timeoutSeconds };

  const check = checkCommand(program, args, timeoutSeconds);
  if (!check.ok) return { step, runnable: false, rejection: { code: check.code!, reason: check.reason } };
  return { step, runnable: true, rejection: null };
}

function reviewManualStep(raw: Record<string, unknown>): ReviewedStep {
  const instruction = text(raw.instruction, MAX_INSTRUCTION_LENGTH);
  const why = text(raw.why, MAX_WHY_LENGTH) ?? "";
  if (!instruction) {
    return {
      step: { kind: "manual", instruction: "", why },
      runnable: false,
      rejection: { code: "step_invalid", reason: "צעד ידני בלי הוראה." },
    };
  }
  // Manual steps are never runnable by design; they are shown, not executed.
  return { step: { kind: "manual", instruction, why }, runnable: false, rejection: null };
}

export function parseInstallPlan(
  reply: string,
  entry: { route: string; actions: readonly KnownAction[] },
): ParsedPlan {
  const raw = extractPlanJson(reply ?? "") ?? "";
  if (!raw) {
    return { ok: false, plan: null, steps: [], errors: ["לא נמצא בלוק JSON בתשובת הסוכן."], raw: reply ?? "" };
  }

  const { value, error } = parseObject(raw);
  if (!value) return { ok: false, plan: null, steps: [], errors: [error ?? "JSON לא תקין."], raw };

  const errors: string[] = [];
  if (value.version !== 1) errors.push('שדה "version" חייב להיות 1.');

  const service = typeof value.service === "string" ? value.service.trim() : "";
  if (service !== entry.route) {
    errors.push(`שדה "service" הוא "${service}" ולא "${entry.route}".`);
  }

  const summary = text(value.summary, MAX_SUMMARY_LENGTH) ?? "";
  if (!summary) errors.push('שדה "summary" חסר או ארוך מדי.');

  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  if (rawSteps.length === 0) errors.push('שדה "steps" ריק.');
  if (rawSteps.length > MAX_STEPS) errors.push(`יותר מ-${MAX_STEPS} צעדים.`);

  const risks = Array.isArray(value.risks)
    ? value.risks.filter((risk): risk is string => typeof risk === "string").slice(0, 3).map((risk) => risk.trim())
    : [];

  const steps: ReviewedStep[] = [];
  for (const rawStep of rawSteps.slice(0, MAX_STEPS)) {
    if (!isRecord(rawStep)) {
      steps.push({
        step: { kind: "manual", instruction: "", why: "" },
        runnable: false,
        rejection: { code: "step_invalid", reason: "צעד שאינו אובייקט." },
      });
      continue;
    }
    if (rawStep.kind === "catalog") steps.push(reviewCatalogStep(rawStep, entry.actions));
    else if (rawStep.kind === "command") steps.push(reviewCommandStep(rawStep));
    else if (rawStep.kind === "manual") steps.push(reviewManualStep(rawStep));
    else {
      steps.push({
        step: { kind: "manual", instruction: "", why: "" },
        runnable: false,
        rejection: { code: "step_invalid", reason: `סוג צעד לא מוכר: "${String(rawStep.kind)}".` },
      });
    }
  }

  // Drop a step that repeats the one before it verbatim; agents sometimes
  // restate a step when they list it and then plan it.
  const deduped: ReviewedStep[] = [];
  for (const reviewed of steps) {
    const previous = deduped.at(-1);
    if (previous && JSON.stringify(previous.step) === JSON.stringify(reviewed.step)) continue;
    deduped.push(reviewed);
  }

  const ok = errors.length === 0 && deduped.length > 0;
  const plan: InstallPlan | null = ok
    ? { version: 1, service: entry.route, summary, risks, steps: deduped.map((reviewed) => reviewed.step) }
    : null;
  return { ok, plan, steps: deduped, errors, raw };
}

/** The follow-up sent on the same session when the first reply did not parse. */
export function buildRepairPrompt(parsed: ParsedPlan): string {
  const problems = parsed.errors.length > 0
    ? parsed.errors
    : parsed.steps.filter((step) => step.rejection).map((step) => step.rejection!.reason);
  const lines = [
    "Your previous reply could not be used. Fix exactly these problems:",
    ...problems.map((problem, index) => `${index + 1}. ${problem}`),
    "",
    `Reply with the corrected JSON object only, between ${PLAN_OPEN_MARKER} and ${PLAN_CLOSE_MARKER}.`,
    "No explanation, no markdown, no other text.",
  ];
  return lines.join("\n");
}
