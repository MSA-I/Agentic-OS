import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const { createControlPlaneIdentity } = await import("./identity.ts");
const {
  assertWave1ControlPlaneCommandUnavailable,
  ControlPlaneCommandDeniedError,
  denyFrozenExecutionMutation,
  WAVE1_FROZEN_EXECUTION_ROUTES,
} = await import("./executionFreeze.ts");

function identity(overrides = {}) {
  return createControlPlaneIdentity({
    callerSessionId: "browser-session",
    actorId: "codex",
    projectId: "project-alpha",
    worktreeId: "local",
    provider: "codex",
    profileId: null,
    nativeSessionId: null,
    runId: "pending-run",
    ...overrides,
  });
}

test("matching command stays unavailable while real execution guards do not exist", () => {
  assert.throws(
    () => assertWave1ControlPlaneCommandUnavailable({
      operation: "start",
      expectedIdentity: identity(),
      actualIdentity: identity(),
    }),
    (error) => error instanceof ControlPlaneCommandDeniedError
      && error.code === "control_plane_execution_unavailable"
      && error.status === 503,
  );
});

test("actor and project mismatch deny before execution availability is evaluated", () => {
  for (const changed of [identity({ actorId: "other" }), identity({ projectId: "other-project" })]) {
    assert.throws(
      () => assertWave1ControlPlaneCommandUnavailable({
        operation: "steer",
        expectedIdentity: identity(),
        actualIdentity: changed,
      }),
      (error) => error instanceof ControlPlaneCommandDeniedError
        && error.code === "identity_mismatch"
        && error.status === 403,
    );
  }
});

test("frozen route rejects direct API bypass before original handler side effects", async () => {
  const route = "POST /api/opencode/build";
  assert.ok(WAVE1_FROZEN_EXECUTION_ROUTES.includes(route));
  const request = new Request("http://127.0.0.1:3000/api/opencode/build", {
    method: "POST",
    headers: {
      Host: "127.0.0.1:3000",
      Origin: "http://127.0.0.1:3000",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "must never execute" }),
  });
  const response = await denyFrozenExecutionMutation(request, route);
  assert.ok(response);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    code: "control_plane_execution_unavailable",
    error: "Execution is disabled until canonical identity, policy, containment, durable approval, secret, executable, and capability gates are live.",
    policy: "invalid_identity",
    capability: "restricted",
    approval: "durable_store_unavailable",
    runCreated: false,
  });
});

test("frozen route enforces Host, Origin, JSON, size, and route identity before freeze response", async () => {
  const route = "POST /api/codex/chat";
  const base = { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000" } };
  const crossOrigin = await denyFrozenExecutionMutation(new Request("http://127.0.0.1:3000/api/codex/chat", {
    ...base,
    headers: { ...base.headers, Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: "{}",
  }), route);
  assert.equal(crossOrigin?.status, 403);

  const wrongType = await denyFrozenExecutionMutation(new Request("http://127.0.0.1:3000/api/codex/chat", {
    ...base,
    headers: base.headers,
    body: "{}",
  }), route);
  assert.equal(wrongType?.status, 415);

  const oversized = await denyFrozenExecutionMutation(new Request("http://127.0.0.1:3000/api/codex/chat", {
    ...base,
    headers: { ...base.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "x".repeat(70 * 1024) }),
  }), route);
  assert.equal(oversized?.status, 413);

  const mismatch = await denyFrozenExecutionMutation(new Request("http://127.0.0.1:3000/api/claude/chat", {
    ...base,
    headers: { ...base.headers, "Content-Type": "application/json" },
    body: "{}",
  }), route);
  assert.equal(mismatch?.status, 403);
});
