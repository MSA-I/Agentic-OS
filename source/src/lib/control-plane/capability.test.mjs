import assert from "node:assert/strict";
import test from "node:test";

import {
  assessCapability,
  createCapabilityEvidence,
  createCapabilityStatus,
} from "./capability.ts";

function inputs(overrides = {}) {
  return {
    executableHash: "exe-sha256-a",
    runtimeHash: "runtime-sha256-a",
    configHash: "config-sha256-a",
    toolHash: "tool-sha256-a",
    credentialRevision: "credentials-revision-a",
    policyHash: "policy-sha256-a",
    manifestHash: "manifest-sha256-a",
    ...overrides,
  };
}

function evidence(level = "live-runtime", overrides = {}) {
  return createCapabilityEvidence({
    level,
    source: "live-smoke",
    observedAt: "2030-01-01T00:00:00.000Z",
    validUntil: "2030-01-01T01:00:00.000Z",
    inputs: inputs(),
    blockedReason: level === "blocked" ? "runtime unavailable" : null,
    ...overrides,
  });
}

function capability(overrides = {}) {
  return createCapabilityStatus({
    id: "hermes:computer-use:ping",
    category: "invokable-tool",
    stage: "verified",
    securityCritical: true,
    preExecutionApprovalEnforced: true,
    evidence: evidence(),
    ...overrides,
  });
}

test("only fresh live verification plus pre-execution approval is invokable", () => {
  const result = assessCapability(capability(), inputs(), new Date("2030-01-01T00:30:00.000Z"));
  assert.deepEqual(result, {
    verification: "current",
    invokable: true,
    reason: "Live verification is current and pre-execution approval is enforceable.",
    changedInputs: [],
  });
});

test("any executable, runtime, config, tool, credential, policy, or manifest change invalidates evidence", () => {
  for (const field of Object.keys(inputs())) {
    const result = assessCapability(
      capability(),
      inputs({ [field]: `${field}-changed` }),
      new Date("2030-01-01T00:30:00.000Z"),
    );
    assert.equal(result.verification, "invalidated", field);
    assert.equal(result.invokable, false, field);
    assert.deepEqual(result.changedInputs, [field], field);
  }
});

test("stale security capability is never invokable", () => {
  const result = assessCapability(capability(), inputs(), new Date("2030-01-01T01:00:00.000Z"));
  assert.equal(result.verification, "stale");
  assert.equal(result.invokable, false);
});

test("static, fake, and blocked evidence never become usable runtime proof", () => {
  for (const level of ["static-contract", "fake-runtime", "blocked"]) {
    const result = assessCapability(
      capability({ evidence: evidence(level) }),
      inputs(),
      new Date("2030-01-01T00:30:00.000Z"),
    );
    assert.equal(result.invokable, false, level);
    assert.equal(result.verification, level === "blocked" ? "blocked" : "unverified", level);
  }
});

test("configured is not verified and missing approval enforcement restricts invocation", () => {
  const configured = assessCapability(
    capability({ stage: "configured" }),
    inputs(),
    new Date("2030-01-01T00:30:00.000Z"),
  );
  assert.equal(configured.verification, "unverified");
  assert.equal(configured.invokable, false);

  const unenforced = assessCapability(
    capability({ preExecutionApprovalEnforced: false }),
    inputs(),
    new Date("2030-01-01T00:30:00.000Z"),
  );
  assert.equal(unenforced.verification, "restricted");
  assert.equal(unenforced.invokable, false);
});

test("non-tool taxonomy entries can be current but are not invokable", () => {
  const result = assessCapability(
    capability({ id: "hermes:mcp:computer-use", category: "mcp-server" }),
    inputs(),
    new Date("2030-01-01T00:30:00.000Z"),
  );
  assert.equal(result.verification, "current");
  assert.equal(result.invokable, false);
});
