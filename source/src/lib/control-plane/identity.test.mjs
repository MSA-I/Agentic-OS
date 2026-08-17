import assert from "node:assert/strict";
import test from "node:test";

import {
  assertControlPlaneIdentity,
  assertIdentityMatch,
  createControlPlaneIdentity,
  identityFingerprint,
  identityMismatchFields,
} from "./identity.ts";

function identity(overrides = {}) {
  return createControlPlaneIdentity({
    callerSessionId: "caller-session-1",
    actorId: "actor-1",
    projectId: "project-1",
    worktreeId: "worktree-1",
    provider: "codex",
    profileId: "profile-1",
    nativeSessionId: "native-session-1",
    runId: "run-1",
    ...overrides,
  });
}

test("identity binds every command dimension and produces a stable fingerprint", () => {
  const first = identity();
  const second = identity();
  assert.equal(identityFingerprint(first), identityFingerprint(second));
  assert.deepEqual(identityMismatchFields(first, second), []);
  assert.doesNotThrow(() => assertIdentityMatch(first, second));
});

test("identity mismatch fails before a side effect can be authorized", () => {
  const expected = identity();
  const actual = identity({ actorId: "actor-2", nativeSessionId: "native-session-2" });
  assert.deepEqual(identityMismatchFields(expected, actual), ["actorId", "nativeSessionId"]);
  assert.throws(() => assertIdentityMatch(expected, actual), /identity mismatch: actorId, nativeSessionId/);
});

test("identity rejects missing, unsupported, or control-character values", () => {
  assert.throws(() => identity({ projectId: "" }), /projectId is invalid/);
  assert.throws(() => identity({ provider: "unknown" }), /provider is not supported/);
  assert.throws(() => identity({ runId: "run\n2" }), /runId is invalid/);
  assert.throws(() => assertControlPlaneIdentity({ ...identity(), actorId: " actor-1 " }), /actorId is not canonical/);
});
