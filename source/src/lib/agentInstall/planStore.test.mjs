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

const { storeApprovedPlan, claimPlanStep, resetPlanStoreForTests } = await import("./planStore.ts");

const CATALOG = { kind: "catalog", actionId: "install-opencode", why: "צריך" };
const COMMAND = { kind: "command", program: "npm", args: ["install", "-g", "x@1.0.0"], why: "צריך", timeoutSeconds: 900 };
const MANUAL = { kind: "manual", instruction: "התחבר בדפדפן", why: "OAuth" };

test.beforeEach(() => resetPlanStoreForTests());

test("an approved plan returns a token and counts only runnable steps", () => {
  const stored = storeApprovedPlan("/opencode", [CATALOG, COMMAND, MANUAL]);
  assert.ok(stored.planId);
  assert.equal(stored.runnable, 2);
  assert.match(stored.planId, /^[A-Za-z0-9_-]{16,64}$/);
});

// The point of the store: the step request carries an index, so what runs is
// what the server recorded, not what a later request claims.
test("a claimed step returns the server's own copy of the command", () => {
  const { planId } = storeApprovedPlan("/opencode", [COMMAND]);
  const claim = claimPlanStep(planId, 0);
  assert.equal(claim.step.program, "npm");
  assert.deepEqual(claim.step.args, ["install", "-g", "x@1.0.0"]);
  assert.equal(claim.plan.route, "/opencode");
});

test("a step index is single use, so an approval cannot be replayed", () => {
  const { planId } = storeApprovedPlan("/opencode", [COMMAND]);
  assert.ok(!("error" in claimPlanStep(planId, 0)));
  assert.equal(claimPlanStep(planId, 0).error, "step_already_run");
});

test("a manual step can never be claimed for execution", () => {
  const { planId } = storeApprovedPlan("/opencode", [MANUAL]);
  assert.equal(claimPlanStep(planId, 0).error, "step_not_runnable");
});

test("an unknown or out-of-range claim is refused with its own code", () => {
  const { planId } = storeApprovedPlan("/opencode", [COMMAND]);
  assert.equal(claimPlanStep("not-a-plan", 0).error, "plan_unknown");
  assert.equal(claimPlanStep(planId, 5).error, "step_out_of_range");
  assert.equal(claimPlanStep(planId, -1).error, "step_out_of_range");
  assert.equal(claimPlanStep(planId, 1.5).error, "step_out_of_range");
});

test("a plan expires, and an expired claim says so rather than running", () => {
  const start = 1_000_000;
  const { planId } = storeApprovedPlan("/opencode", [COMMAND], start);
  assert.ok(!("error" in claimPlanStep(planId, 0, start + 60_000)));
  const { planId: second } = storeApprovedPlan("/opencode", [COMMAND], start);
  assert.equal(claimPlanStep(second, 0, start + 31 * 60_000).error, "plan_unknown");
});

// The browser has already filtered the list, but that is UX. This is the control.
test("a hostile command is refused at approval time, not at execution time", () => {
  const hostile = [
    { ...COMMAND, program: "bash", args: ["-c", "x"] },
    { ...COMMAND, args: ["install", "a && b"] },
    { ...COMMAND, args: ["run", "postinstall"] },
    { ...COMMAND, args: ["install", "C:/windows"] },
    { kind: "command", program: "git", args: ["clone", "ssh://git@h/x"], why: "", timeoutSeconds: 900 },
  ];
  for (const step of hostile) {
    const stored = storeApprovedPlan("/opencode", [step]);
    assert.ok("error" in stored, `accepted: ${JSON.stringify(step)}`);
    assert.match(stored.error, /Step 1/);
  }
});

test("a catalog step with no action id is refused", () => {
  const stored = storeApprovedPlan("/opencode", [{ kind: "catalog", actionId: "  ", why: "" }]);
  assert.ok("error" in stored);
});

test("plans are bounded, so a page left open cannot grow the store forever", () => {
  const start = Date.now();
  const ids = [];
  for (let index = 0; index < 40; index += 1) {
    ids.push(storeApprovedPlan("/opencode", [COMMAND], start + index).planId);
  }
  // The oldest were evicted; the newest still resolve.
  assert.equal(claimPlanStep(ids[0], 0, start + 40).error, "plan_unknown");
  assert.ok(!("error" in claimPlanStep(ids.at(-1), 0, start + 40)));
});
