import assert from "node:assert/strict";
import test from "node:test";

import {
  createCanonicalApprovalKey,
  InMemoryApprovalGrantStore,
} from "./approval.ts";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const APPROVAL_EXPIRY = "2030-01-01T01:00:00.000Z";

function approvalKey(overrides = {}) {
  return createCanonicalApprovalKey({
    namespacedToolId: "hermes:computer-use:ping",
    schemaVersion: "1.0.0",
    args: { target: "desktop", options: { retries: 1, quiet: true } },
    cwd: "D:\\Projects\\Agent-OS\\source\\",
    safeEnv: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    callerSessionId: "caller-session-1",
    actorId: "actor-1",
    projectId: "project-1",
    runId: "run-1",
    expiresAt: APPROVAL_EXPIRY,
    ...overrides,
  }, NOW);
}

test("approval key is canonical across object, environment, and path ordering", () => {
  const first = approvalKey();
  const second = approvalKey({
    args: { options: { quiet: true, retries: 1 }, target: "desktop" },
    cwd: "d:/projects/agent-os/source",
    safeEnv: { LANG: "en_US.UTF-8", TERM: "xterm-256color" },
  });
  assert.equal(first.digest, second.digest);
  assert.equal(first.canonicalPayload, second.canonicalPayload);
});

test("changed arguments or execution identity require a new approval", () => {
  const baseline = approvalKey();
  assert.notEqual(baseline.digest, approvalKey({ args: { target: "desktop", options: { retries: 2, quiet: true } } }).digest);
  assert.notEqual(baseline.digest, approvalKey({ actorId: "actor-2" }).digest);
  assert.notEqual(baseline.digest, approvalKey({ projectId: "project-2" }).digest);
  assert.notEqual(baseline.digest, approvalKey({ runId: "run-2" }).digest);
});

test("approval key rejects non-namespaced tools, secret environment keys, and unsafe cwd", () => {
  assert.throws(() => approvalKey({ namespacedToolId: "ping" }), /at least three valid namespace segments/);
  assert.throws(() => approvalKey({ safeEnv: { API_KEY: "secret" } }), /safeEnv key is not allowed/);
  assert.throws(() => approvalKey({ cwd: "\\\\server\\share" }), /must not be a UNC or device path/);
  assert.throws(() => approvalKey({ cwd: "relative\\path" }), /absolute local Windows path/);
});

test("allow_once is consumed atomically", async () => {
  const key = approvalKey();
  const store = new InMemoryApprovalGrantStore();
  store.recordDecision(key, "allow_once", { now: NOW });
  const results = await Promise.all([
    Promise.resolve().then(() => store.authorizeAndConsume(key, NOW)),
    Promise.resolve().then(() => store.authorizeAndConsume(key, NOW)),
  ]);
  assert.equal(results.filter((result) => result.allowed).length, 1);
  assert.equal(results.filter((result) => result.code === "missing").length, 1);
});

test("allow_session is time-bound and revocable", () => {
  const key = approvalKey();
  const store = new InMemoryApprovalGrantStore();
  store.recordDecision(key, "allow_session", {
    now: NOW,
    sessionExpiresAt: "2030-01-01T00:10:00.000Z",
  });
  assert.deepEqual(store.authorizeAndConsume(key, new Date("2030-01-01T00:05:00.000Z")), {
    allowed: true,
    code: "allowed_session",
  });
  assert.equal(store.revokeSession("caller-session-1"), 1);
  assert.deepEqual(store.authorizeAndConsume(key, new Date("2030-01-01T00:06:00.000Z")), {
    allowed: false,
    code: "revoked",
  });
});

test("allow_session expires at its session deadline", () => {
  const key = approvalKey();
  const store = new InMemoryApprovalGrantStore();
  store.recordDecision(key, "allow_session", {
    now: NOW,
    sessionExpiresAt: "2030-01-01T00:10:00.000Z",
  });
  assert.deepEqual(store.authorizeAndConsume(key, new Date("2030-01-01T00:10:00.000Z")), {
    allowed: false,
    code: "expired",
  });
});

test("tampered canonical key is rejected", () => {
  const key = approvalKey();
  const tampered = { ...key, canonicalPayload: key.canonicalPayload.replace("actor-1", "actor-2") };
  const store = new InMemoryApprovalGrantStore();
  assert.throws(() => store.recordDecision(tampered, "allow_once", { now: NOW }), /digest does not match/);
});
