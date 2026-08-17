import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlaneIdentity } from "./identity.ts";
import { FailClosedPolicyEngine } from "./policy.ts";

const identity = createControlPlaneIdentity({
  callerSessionId: "caller-session-1",
  actorId: "actor-1",
  projectId: "project-1",
  worktreeId: "worktree-1",
  provider: "codex",
  profileId: null,
  nativeSessionId: null,
  runId: "run-1",
});

function context(overrides = {}) {
  return {
    operation: "start",
    identity,
    guards: {
      identityVerified: true,
      containmentVerified: true,
      secretControlsVerified: true,
      approvalEnforced: true,
      executableVerified: true,
      capabilityVerified: true,
    },
    risk: "low",
    ...overrides,
  };
}

test("policy defaults to deny even when all execution guards pass", () => {
  const result = new FailClosedPolicyEngine().decide(context());
  assert.deepEqual(result, {
    allowed: false,
    code: "default_deny",
    reason: "No policy rule allowed the operation.",
    matchedRuleIds: [],
    missingGuards: [],
  });
});

test("malformed runtime context fails closed", () => {
  const result = new FailClosedPolicyEngine().decide(null);
  assert.equal(result.allowed, false);
  assert.equal(result.code, "invalid_identity");
});

test("start remains denied when any mandatory execution guard is not verified", () => {
  const engine = new FailClosedPolicyEngine([
    { id: "allow-start", effect: "allow", operations: ["start"], matches: () => true },
  ]);
  const guards = { ...context().guards, containmentVerified: false };
  const result = engine.decide(context({ guards }));
  assert.equal(result.allowed, false);
  assert.equal(result.code, "guard_missing");
  assert.deepEqual(result.missingGuards, ["containmentVerified"]);
});

test("non-start mutations still require their operation-specific identity and safety guards", () => {
  const engine = new FailClosedPolicyEngine([
    { id: "allow-mutations", effect: "allow", matches: () => true },
  ]);
  const cancel = engine.decide(context({
    operation: "cancel",
    guards: { ...context().guards, identityVerified: false },
  }));
  assert.equal(cancel.code, "guard_missing");
  assert.deepEqual(cancel.missingGuards, ["identityVerified"]);

  const artifact = engine.decide(context({
    operation: "artifact.persist",
    guards: { ...context().guards, secretControlsVerified: false },
  }));
  assert.equal(artifact.code, "guard_missing");
  assert.deepEqual(artifact.missingGuards, ["secretControlsVerified"]);
});

test("explicit deny wins over allow and matching rule order is deterministic", () => {
  const engine = new FailClosedPolicyEngine([
    { id: "z-allow", effect: "allow", matches: () => true },
    { id: "a-deny", effect: "deny", matches: () => true },
  ]);
  const result = engine.decide(context());
  assert.equal(result.allowed, false);
  assert.equal(result.code, "explicit_deny");
  assert.deepEqual(result.matchedRuleIds, ["a-deny", "z-allow"]);
});

test("policy allows start only after guards and an explicit rule pass", () => {
  const engine = new FailClosedPolicyEngine([
    { id: "allow-project", effect: "allow", operations: ["start"], matches: (value) => value.identity.projectId === "project-1" },
  ]);
  assert.equal(engine.decide(context()).allowed, true);
});

test("matcher errors fail closed", () => {
  const engine = new FailClosedPolicyEngine([
    { id: "broken", effect: "allow", matches: () => { throw new Error("do not leak"); } },
  ]);
  const result = engine.decide(context());
  assert.equal(result.allowed, false);
  assert.equal(result.code, "policy_error");
  assert.doesNotMatch(result.reason, /do not leak/);
});

test("runtime getter errors fail closed and caller mutation cannot rewrite a loaded rule", () => {
  const rule = { id: "stable", effect: "allow", matches: () => true };
  const engine = new FailClosedPolicyEngine([rule]);
  rule.effect = "deny";
  assert.equal(engine.decide(context()).allowed, true);

  const hostile = { get operation() { throw new Error("do not leak"); } };
  const result = engine.decide(hostile);
  assert.equal(result.allowed, false);
  assert.equal(result.code, "policy_error");
});
