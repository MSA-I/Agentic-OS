import { describeCommandPolicy, ARGUMENT_PATTERN, MAX_ARGS } from "./commandPolicy";
import { MAX_STEPS, PLAN_CLOSE_MARKER, PLAN_OPEN_MARKER, type KnownAction } from "./planSchema";

/**
 * Builds the one message the agent gets.
 *
 * The restricted pilot has no system prompt, no tool calling and no filesystem
 * access, so everything the agent could possibly need has to be in here — and
 * it has to fit. `validateCreateRun` caps the prompt at 16 KiB of UTF-8 after
 * redaction, so the builder measures bytes and trims the one section that can
 * afford it.
 *
 * Written in English deliberately: Hebrew costs two bytes per character against
 * that cap. The agent is asked to write its explanations in Hebrew, which is
 * where the user actually reads them.
 */

const MAX_PROMPT_BYTES = 15 * 1024;
const GUIDE_RESERVE_BYTES = 512;
const MAX_ACTION_DESCRIPTION = 200;
const MAX_DIAGNOSTIC_DETAIL = 160;

export interface PromptDiagnostic {
  id?: string;
  label?: string;
  status?: string;
  detail?: string;
  message?: string;
  impact?: string;
}

export interface PromptEntry {
  route: string;
  title: string;
  summary: string;
  actions: readonly (KnownAction & { description?: string; copyCommand?: string })[];
  diagnostics?: readonly PromptDiagnostic[];
  guideMarkdown?: string | null;
}

export interface PromptHost {
  platform: string;
  /** A label, never an absolute path — the agent has no business knowing where it runs. */
  cwdLabel: string;
}

export interface BuiltPrompt {
  prompt: string;
  bytes: number;
  /** What had to be dropped to fit, so the UI can say so instead of hiding it. */
  trimmed: string[];
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Secret-shaped lines are replaced before the prompt is sent, not after.
 * `validateCreateRun` runs redactText over the prompt server-side, and the
 * install guides are full of `export ANTHROPIC_API_KEY=sk-…` and `--api-key <v>`
 * examples. Left alone they would come out as [REDACTED_*] mid-sentence and the
 * agent would read a mangled guide. Replacing them with a named placeholder
 * keeps the instruction readable and still sends no secret.
 */
export function placeholderSecrets(source: string): string {
  return source
    .replace(/\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*\S+/gu, "$1=<your value>")
    .replace(/(--(?:api-)?(?:key|token|secret|password))(\s+|=)\S+/giu, "$1$2<your value>")
    .replace(/\b(Bearer)\s+\S+/gu, "$1 <your value>");
}

function roleSection(): string {
  return [
    "You are planning a software installation on someone else's Windows computer.",
    "",
    "You have no tools. You cannot read files, browse, or run anything. Everything you",
    "know about this machine is written below. The application executes the steps you",
    "propose, and only after the user approves the whole list in one click. So propose",
    "the shortest plan that actually works, and never propose a step you are guessing at.",
  ].join("\n");
}

function contractSection(): string {
  return [
    "RESPONSE CONTRACT",
    `Reply with one JSON object between ${PLAN_OPEN_MARKER} and ${PLAN_CLOSE_MARKER}.`,
    "No prose before it, no markdown fences, nothing after it.",
    "",
    "Schema:",
    "{",
    '  "version": 1,',
    '  "service": "<the service route given below, copied exactly>",',
    '  "summary": "<one sentence in Hebrew describing what the plan does>",',
    '  "risks": ["<at most three short Hebrew notes, or an empty array>"],',
    '  "steps": [',
    '    {"kind": "catalog", "actionId": "<an automatic action id from the list below>", "why": "<Hebrew>"},',
    '    {"kind": "command", "program": "<an allowed program>", "args": ["<arg>", "<arg>"], "why": "<Hebrew>", "timeoutSeconds": 900},',
    '    {"kind": "manual", "instruction": "<what the user must do themselves, Hebrew>", "why": "<Hebrew>"}',
    "  ]",
    "}",
    "",
    `At most ${MAX_STEPS} steps, ordered so each one can succeed when it runs.`,
    "Prefer a catalog action over a command whenever one exists: it is version-pinned and already reviewed.",
    'Use "manual" for anything needing a browser, an account, a password or a paid signup.',
  ].join("\n");
}

function hostSection(host: PromptHost, allowedPrograms: string): string {
  return [
    "THIS MACHINE",
    `Platform: ${host.platform}. Commands run from ${host.cwdLabel}.`,
    "There is NO shell. Each command is spawned directly, so no pipes, no redirection,",
    "no && chaining, no environment-variable expansion, no quoting.",
    `Allowed programs and their allowed subcommands: ${allowedPrograms}.`,
    `Every argument must match ${ARGUMENT_PATTERN.source} and be at most ${MAX_ARGS} arguments per command.`,
    "That means NO ARGUMENT MAY CONTAIN A SPACE. A path or name with a space cannot be expressed;",
    "choose one without, or make it a manual step.",
    "A URL is only allowed as the https clone URL of `git clone`. Nowhere else.",
  ].join("\n");
}

function serviceSection(entry: PromptEntry): string {
  const lines = [
    "THE SERVICE",
    `route: ${entry.route}`,
    `name: ${entry.title}`,
    `summary: ${entry.summary}`,
    "",
    "Checks that are failing right now (turn every failing required check into a passing one):",
  ];
  const diagnostics = entry.diagnostics ?? [];
  if (diagnostics.length === 0) lines.push("  (none reported)");
  for (const diagnostic of diagnostics) {
    const detail = (diagnostic.detail || diagnostic.message || "").slice(0, MAX_DIAGNOSTIC_DETAIL);
    lines.push(`  - [${diagnostic.status ?? "?"}] ${diagnostic.label ?? diagnostic.id ?? "check"}${diagnostic.impact && diagnostic.impact !== "required" ? ` (${diagnostic.impact})` : ""}: ${detail}`);
  }

  lines.push("", "Catalog actions this application can run for you:");
  const automatic = entry.actions.filter((action) => action.availability === "automatic");
  if (automatic.length === 0) lines.push("  (none — every step must be a command or manual)");
  for (const action of automatic) {
    const needsInput = Array.isArray(action.fields) && action.fields.length > 0;
    const description = (action.description ?? "").slice(0, MAX_ACTION_DESCRIPTION);
    lines.push(
      `  - id: ${action.id} | ${action.kind}${needsInput ? " | NEEDS A VALUE FROM THE USER, do not choose it" : ""}`,
      `      ${description}${action.copyCommand ? ` [runs: ${action.copyCommand}]` : ""}`,
    );
  }
  return lines.join("\n");
}

function taskSection(): string {
  return [
    "YOUR TASK",
    "Produce the plan now. Order matters: install before start, and install a runtime before",
    "anything that needs it. If a failing check cannot be fixed from this machine without the",
    "user, say so in a manual step rather than inventing a command.",
  ].join("\n");
}

function guideSection(guide: string): string {
  return [
    "THE PROJECT'S OWN GUIDE FOR THIS SERVICE",
    "It was mostly written for macOS and predates the Windows actions above. Translate it;",
    "do not copy its commands verbatim. Where it disagrees with the checks above, the checks win.",
    "",
    guide,
  ].join("\n");
}

/** Trims whole paragraphs off the end until the guide fits its budget. */
function fitGuide(guide: string, budget: number): { text: string; trimmedParagraphs: number } {
  if (bytes(guide) <= budget) return { text: guide, trimmedParagraphs: 0 };
  const paragraphs = guide.split(/\n{2,}/u);
  let trimmed = 0;
  while (paragraphs.length > 1) {
    paragraphs.pop();
    trimmed += 1;
    const candidate = `${paragraphs.join("\n\n")}\n\n…[guide trimmed to fit]`;
    if (bytes(candidate) <= budget) return { text: candidate, trimmedParagraphs: trimmed };
  }
  // A single paragraph larger than the budget: cut it on a character boundary.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const slice = encoder.encode(paragraphs[0] ?? "").slice(0, Math.max(0, budget - 32));
  return { text: `${decoder.decode(slice).replace(/�+$/u, "")}\n\n…[guide trimmed to fit]`, trimmedParagraphs: trimmed + 1 };
}

export function buildInstallPlanPrompt(entry: PromptEntry, host: PromptHost): BuiltPrompt {
  const trimmed: string[] = [];
  const allowedPrograms = describeCommandPolicy();

  const fixed = [
    roleSection(),
    contractSection(),
    hostSection(host, allowedPrograms),
    serviceSection(entry),
    taskSection(),
  ];
  // The prompt ends with the opening marker and the first key already written.
  // Both providers continue a prefill far more reliably than they start one cold.
  const prefill = `${PLAN_OPEN_MARKER}\n{"version": 1,`;

  const guide = placeholderSecrets(entry.guideMarkdown ?? "").trim();
  const fixedText = fixed.join("\n\n");
  const overhead = bytes(`${fixedText}\n\n\n\n${prefill}`);
  const budget = MAX_PROMPT_BYTES - overhead - GUIDE_RESERVE_BYTES;

  let guideText = "";
  if (guide && budget > 256) {
    const fitted = fitGuide(guide, budget);
    guideText = guideSection(fitted.text);
    if (fitted.trimmedParagraphs > 0) {
      trimmed.push(`המדריך קוצר ב-${fitted.trimmedParagraphs} פסקאות כדי להיכנס למגבלת הפרומפט`);
    }
  } else if (guide) {
    trimmed.push("המדריך הושמט לגמרי: פרטי השירות לבדם מילאו את מגבלת הפרומפט");
  }

  const prompt = [...(guideText ? [...fixed, guideText] : fixed), prefill].join("\n\n");
  return { prompt, bytes: bytes(prompt), trimmed };
}

export const PROMPT_BYTE_CAP = MAX_PROMPT_BYTES;
