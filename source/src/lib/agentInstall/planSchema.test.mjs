import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = process.cwd();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export default undefined" };
    }
    let candidate = null;
    if (specifier.startsWith("@/")) {
      candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
    } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      candidate = new URL(specifier, context.parentURL);
      candidate = decodeURIComponent(candidate.pathname).replace(/^\/(?=[A-Za-z]:\/)/u, "");
    }
    if (candidate) {
      for (const target of [`${candidate}.ts`, candidate, path.join(candidate, "index.ts")]) {
        if (existsSync(target) && statSync(target).isFile()) {
          return { shortCircuit: true, url: pathToFileURL(target).href };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  parseInstallPlan,
  extractPlanJson,
  buildRepairPrompt,
  PLAN_OPEN_MARKER,
  PLAN_CLOSE_MARKER,
} = await import("./planSchema.ts");

const ENTRY = {
  route: "/opencode",
  actions: [
    { id: "test", label: "בדיקה בטוחה", kind: "test", availability: "automatic" },
    { id: "install-opencode", label: "התקנת OpenCode", kind: "install", availability: "automatic" },
    { id: "connect-cli-path", label: "חיבור קובץ CLI קיים", kind: "connect", availability: "automatic", fields: [{ id: "cliPath" }] },
    { id: "auth-manual", label: "חיבור ספק", kind: "connect", availability: "manual" },
  ],
};

function plan(steps, overrides = {}) {
  return JSON.stringify({
    version: 1,
    service: "/opencode",
    summary: "מתקין את OpenCode ומחבר ספק",
    risks: [],
    steps,
    ...overrides,
  });
}

function wrap(json) {
  return `${PLAN_OPEN_MARKER}\n${json}\n${PLAN_CLOSE_MARKER}`;
}

test("a well-formed plan parses and every step is runnable", () => {
  const parsed = parseInstallPlan(wrap(plan([
    { kind: "catalog", actionId: "install-opencode", why: "מתקין את ה-CLI" },
    { kind: "command", program: "npm", args: ["install", "-g", "x@1.0.0"], why: "תלות" },
  ])), ENTRY);
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.steps.map((s) => s.runnable), [true, true]);
  assert.equal(parsed.plan.service, "/opencode");
});

test("the extractor finds the JSON inside every realistic wrapper", () => {
  const body = plan([{ kind: "manual", instruction: "התחבר בדפדפן", why: "OAuth" }]);
  const wrappers = [
    wrap(body),
    `I looked at the checks.\n\n${wrap(body)}`,
    `${wrap(body)}\n\nLet me know if you want changes.`,
    "```json\n" + body + "\n```",
    "Here is the plan:\n```\n" + body + "\n```\nDone.",
    body,
  ];
  for (const [index, reply] of wrappers.entries()) {
    const parsed = parseInstallPlan(reply, ENTRY);
    assert.equal(parsed.ok, true, `wrapper ${index} failed: ${parsed.errors.join("; ")}`);
  }
});

test("a brace inside a string does not confuse the extractor", () => {
  const parsed = parseInstallPlan(wrap(plan([
    { kind: "manual", instruction: 'ערוך את הקובץ ל-{"mcpServers": {}}', why: "config" },
  ])), ENTRY);
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  assert.match(parsed.plan.steps[0].instruction, /mcpServers/);
});

test("a catalog step naming an action that does not exist is refused", () => {
  const parsed = parseInstallPlan(wrap(plan([{ kind: "catalog", actionId: "install-everything", why: "x" }])), ENTRY);
  assert.equal(parsed.steps[0].runnable, false);
  assert.equal(parsed.steps[0].rejection.code, "action_unknown");
});

test("a catalog step naming a manual action becomes a manual step", () => {
  const parsed = parseInstallPlan(wrap(plan([{ kind: "catalog", actionId: "auth-manual", why: "x" }])), ENTRY);
  assert.equal(parsed.steps[0].runnable, false);
  assert.equal(parsed.steps[0].rejection.code, "action_manual");
  assert.equal(parsed.steps[0].step.kind, "manual");
});

test("a catalog step needing a user-supplied value becomes a manual step", () => {
  const parsed = parseInstallPlan(wrap(plan([{ kind: "catalog", actionId: "connect-cli-path", why: "x" }])), ENTRY);
  assert.equal(parsed.steps[0].runnable, false);
  assert.equal(parsed.steps[0].rejection.code, "action_needs_input");
  assert.equal(parsed.steps[0].step.kind, "manual");
});

test("a hostile command is refused with the policy's own code", () => {
  const hostile = [
    [{ kind: "command", program: "bash", args: ["-c", "x"], why: "" }, "program_not_allowed"],
    [{ kind: "command", program: "npm", args: ["install", "a && b"], why: "" }, "argument_characters"],
    [{ kind: "command", program: "npm", args: ["run", "postinstall"], why: "" }, "subcommand_not_allowed"],
    [{ kind: "command", program: "git", args: ["clone", "ssh://git@h/x"], why: "" }, "git_url_invalid"],
    [{ kind: "command", program: "npm", args: ["install", "C:/x"], why: "" }, "absolute_path"],
    [{ kind: "command", program: "npm", args: ["install", "x"], why: "", timeoutSeconds: 1 }, "timeout_out_of_range"],
  ];
  for (const [step, code] of hostile) {
    const parsed = parseInstallPlan(wrap(plan([step])), ENTRY);
    assert.equal(parsed.steps[0].runnable, false, `${code} was accepted`);
    assert.equal(parsed.steps[0].rejection.code, code);
  }
});

test("a manual step is parsed but never runnable", () => {
  const parsed = parseInstallPlan(wrap(plan([{ kind: "manual", instruction: "התחבר לחשבון", why: "OAuth" }])), ENTRY);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.steps[0].runnable, false);
  assert.equal(parsed.steps[0].rejection, null);
});

test("envelope errors are collected together, not one at a time", () => {
  const parsed = parseInstallPlan(wrap(JSON.stringify({
    version: 2,
    service: "/wrong",
    steps: [],
  })), ENTRY);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.length >= 4, parsed.errors.join("; "));
  assert.ok(parsed.errors.some((e) => e.includes("version")));
  assert.ok(parsed.errors.some((e) => e.includes("/opencode")));
  assert.ok(parsed.errors.some((e) => e.includes("summary")));
  assert.ok(parsed.errors.some((e) => e.includes("steps")));
});

test("more than twelve steps is refused and the extras are dropped", () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ kind: "manual", instruction: `שלב ${i}`, why: "x" }));
  const parsed = parseInstallPlan(wrap(plan(many)), ENTRY);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some((e) => e.includes("12")));
  assert.ok(parsed.steps.length <= 12);
});

test("a trailing comma is repaired mechanically", () => {
  const broken = '{"version":1,"service":"/opencode","summary":"תקציר","risks":[],"steps":[{"kind":"manual","instruction":"א","why":"ב"},]}';
  const parsed = parseInstallPlan(wrap(broken), ENTRY);
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
});

test("unparseable output fails honestly and keeps the raw text", () => {
  const parsed = parseInstallPlan("I cannot help with that.", ENTRY);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.plan, null);
  assert.ok(parsed.errors.length > 0);
  assert.equal(parsed.raw, "I cannot help with that.");
});

test("a duplicated consecutive step is collapsed", () => {
  const step = { kind: "manual", instruction: "אותו דבר", why: "x" };
  const parsed = parseInstallPlan(wrap(plan([step, step])), ENTRY);
  assert.equal(parsed.steps.length, 1);
});

test("the repair prompt names every problem and demands the markers", () => {
  const parsed = parseInstallPlan(wrap(JSON.stringify({ version: 2, service: "/wrong", steps: [] })), ENTRY);
  const repair = buildRepairPrompt(parsed);
  for (const problem of parsed.errors) assert.ok(repair.includes(problem), `missing: ${problem}`);
  assert.ok(repair.includes(PLAN_OPEN_MARKER));
  assert.ok(repair.includes(PLAN_CLOSE_MARKER));
});

test("extractPlanJson returns null when there is no object at all", () => {
  assert.equal(extractPlanJson("no json here"), null);
  assert.equal(extractPlanJson(""), null);
});
