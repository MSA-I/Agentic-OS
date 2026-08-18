/**
 * What an install plan is allowed to ask for.
 *
 * Isomorphic on purpose: the browser copy is UX (it shows a rejected step and
 * why), the server copy is the control. Nothing here executes anything.
 *
 * The argument character class is not a free choice. `spawnInvocation` in
 * setupRuntime.ts throws on any argument outside /^[A-Za-z0-9@._:/=+-]+$/ when
 * the executable is a .cmd or .bat wrapper, which every npm-installed CLI on
 * Windows is. Widening it here would produce plans that pass review and then
 * fail at spawn time, so the two must stay identical — commandPolicy.test.mjs
 * cross-checks them against a generated corpus.
 *
 * A practical consequence worth stating in the prompt: no argument may contain
 * a space, so `git clone <url> "My Folder"` is unreachable. That is a feature.
 */

export const ARGUMENT_PATTERN = /^[A-Za-z0-9@._:/=+-]+$/;

export const MAX_ARGS = 24;
export const MAX_ARG_LENGTH = 200;
export const MIN_TIMEOUT_SECONDS = 10;
export const MAX_TIMEOUT_SECONDS = 1800;
export const DEFAULT_TIMEOUT_SECONDS = 900;

/**
 * Every entry is a package manager. The worst directly reachable outcome is an
 * unwanted package install — which is the bound this feature rests on, and the
 * reason no general-purpose interpreter appears here.
 */
export const ALLOWED_PROGRAMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  npm: ["install", "ci"],
  npx: ["--yes"],
  pnpm: ["install", "add"],
  uv: ["tool", "pip"],
  py: ["-m"],
  pip: ["install"],
  winget: ["install"],
  git: ["clone", "-C"],
  ollama: ["pull", "list"],
});

/** Second-level allowlist for the programs whose first argument is a namespace. */
const SECOND_LEVEL: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  uv: { tool: ["install"], pip: ["install"] },
  py: { "-m": ["pip"] },
  git: { "-C": [] },
});

/**
 * The one deliberate hole in the "no URLs" rule. https only, no credentials in
 * the authority, no IP-literal host, so a plan cannot smuggle a fetch through a
 * scheme git happens to support (git://, ssh://, file://).
 */
export const GIT_CLONE_URL_PATTERN = /^https:\/\/[A-Za-z][A-Za-z0-9.-]*\.[A-Za-z]{2,}\/[A-Za-z0-9._/-]+?(?:\.git)?$/;

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/|\/)/;

export type CommandRejectionCode =
  | "program_not_allowed"
  | "too_many_args"
  | "argument_too_long"
  | "argument_characters"
  | "subcommand_not_allowed"
  | "absolute_path"
  | "url_not_allowed"
  | "git_url_invalid"
  | "timeout_out_of_range";

export interface CommandCheck {
  ok: boolean;
  code: CommandRejectionCode | null;
  reason: string;
}

const OK: CommandCheck = Object.freeze({ ok: true, code: null, reason: "" });

function reject(code: CommandRejectionCode, reason: string): CommandCheck {
  return { ok: false, code, reason };
}

/** True when this exact command is a `git clone` of an https repository URL. */
function isGitClone(program: string, args: readonly string[]): boolean {
  return program === "git" && args[0] === "clone";
}

export function checkCommand(
  program: unknown,
  args: unknown,
  timeoutSeconds: unknown = DEFAULT_TIMEOUT_SECONDS,
): CommandCheck {
  if (typeof program !== "string" || !Object.hasOwn(ALLOWED_PROGRAMS, program)) {
    return reject("program_not_allowed", `התוכנית "${String(program)}" אינה ברשימת המותרות.`);
  }
  if (!Array.isArray(args)) return reject("too_many_args", "רשימת הארגומנטים אינה תקינה.");
  if (args.length > MAX_ARGS) return reject("too_many_args", `יותר מ-${MAX_ARGS} ארגומנטים.`);

  for (const arg of args) {
    if (typeof arg !== "string") return reject("argument_characters", "ארגומנט שאינו מחרוזת.");
    if (arg.length > MAX_ARG_LENGTH) return reject("argument_too_long", `ארגומנט ארוך מ-${MAX_ARG_LENGTH} תווים.`);
    if (!ARGUMENT_PATTERN.test(arg)) {
      return reject("argument_characters", `הארגומנט "${arg}" מכיל תו שאינו מותר (רווח, מרכאה או תו מיוחד).`);
    }
  }

  const first = args[0] as string | undefined;
  const allowedFirst = ALLOWED_PROGRAMS[program];
  if (allowedFirst.length > 0 && (first === undefined || !allowedFirst.includes(first))) {
    return reject("subcommand_not_allowed", `"${program} ${first ?? ""}" אינה תת-פקודה מותרת.`);
  }
  const second = SECOND_LEVEL[program]?.[first ?? ""];
  if (second && second.length > 0 && !second.includes(String(args[1]))) {
    return reject("subcommand_not_allowed", `"${program} ${first} ${String(args[1])}" אינה תת-פקודה מותרת.`);
  }

  const gitClone = isGitClone(program, args as string[]);
  for (const arg of args as string[]) {
    if (ABSOLUTE_PATH.test(arg)) return reject("absolute_path", `נתיב מוחלט אינו מותר: "${arg}".`);
    if (!arg.includes("://")) continue;
    if (!gitClone) return reject("url_not_allowed", `כתובת אינה מותרת בפקודה הזאת: "${arg}".`);
    if (!GIT_CLONE_URL_PATTERN.test(arg)) {
      return reject("git_url_invalid", `רק כתובת https ציבורית מותרת ל-git clone: "${arg}".`);
    }
  }

  if (timeoutSeconds !== undefined) {
    const seconds = Number(timeoutSeconds);
    if (!Number.isFinite(seconds) || seconds < MIN_TIMEOUT_SECONDS || seconds > MAX_TIMEOUT_SECONDS) {
      return reject("timeout_out_of_range", `מגבלת הזמן חייבת להיות בין ${MIN_TIMEOUT_SECONDS} ל-${MAX_TIMEOUT_SECONDS} שניות.`);
    }
  }

  return OK;
}

/** One line describing the whole surface, for the prompt. Kept here so it cannot drift. */
export function describeCommandPolicy(): string {
  const programs = Object.entries(ALLOWED_PROGRAMS)
    .map(([program, subcommands]) => (subcommands.length ? `${program} (${subcommands.join(" | ")})` : program))
    .join(", ");
  return programs;
}
