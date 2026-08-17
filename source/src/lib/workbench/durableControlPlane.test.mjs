import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const sourceRoot = process.cwd();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript," };
    if (
      (specifier.startsWith("./") || specifier.startsWith("../"))
      && context.parentURL?.startsWith("file:")
    ) {
      const url = new URL(specifier, context.parentURL);
      const candidate = decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:\/)/u, "");
      const target = existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : existsSync(`${candidate}.ts`)
          ? `${candidate}.ts`
          : path.join(candidate, "index.ts");
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
      const target = existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : existsSync(`${candidate}.ts`)
          ? `${candidate}.ts`
          : path.join(candidate, "index.ts");
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const { createControlPlaneIdentity } = await import("../control-plane/identity.ts");
const { DurableWorkbenchControlPlane } = await import("./durableControlPlane.ts");
const { WorkbenchStore } = await import("./store.ts");

const NOW = Date.now();

function scratchStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-os-wave3-control-plane-"));
  return {
    root,
    store: new WorkbenchStore(path.join(root, "workbench.sqlite")),
  };
}

function input(provider = "codex", overrides = {}) {
  const idempotencyKey = overrides.idempotencyKey ?? `${provider}-idem-1`;
  const sessionId = overrides.sessionId ?? null;
  return {
    adapterId: provider,
    provider,
    context: {
      agentId: provider,
      actorId: provider,
      projectId: "agent-os/project-a",
      sessionId,
      environment: "local",
      panel: "transcript",
    },
    title: null,
    metadata: {},
    prompt: "Return the integration sentinel only.",
    idempotencyKey,
    operation: sessionId ? "resume" : "start",
    options: { model: null, engine: null, effort: null },
  };
}

function identityFor(runInput, callerSessionId = "caller-session-1") {
  return createControlPlaneIdentity({
    callerSessionId,
    actorId: runInput.provider,
    projectId: runInput.context.projectId,
    worktreeId: runInput.context.environment,
    provider: runInput.provider,
    profileId: null,
    nativeSessionId: runInput.context.sessionId,
    runId: runInput.idempotencyKey,
  });
}

function attestationFor(command, overrides = {}) {
  const identity = command.payload.commandIdentity;
  const observedAt = new Date(NOW).toISOString();
  const attestation = {
    schemaVersion: 1,
    provider: command.provider,
    operation: command.operation,
    observedAt,
    validUntil: new Date(NOW + 30_000).toISOString(),
    command: {
      callerSessionId: identity.callerSessionId,
      actorId: identity.actorId,
      projectId: identity.projectId,
      worktreeId: identity.worktreeId,
      nativeSessionId: identity.nativeSessionId,
      runId: identity.runId,
      explicitUserMutation: true,
    },
    containment: {
      approvedLaunchDirectory: true,
      windowsJobObjectRequired: true,
      directoryIdentity: "1:2:3",
    },
    secretControls: {
      promptTransport: "stdin",
      minimalEnvironment: true,
      streamRedactionRequired: true,
    },
    approval: {
      kind: "explicit-run-request",
      commandBound: true,
      providerApprovalSurface: "disabled",
      toolPolicy: command.provider === "claude" ? "disabled" : "provider-native-restricted",
    },
    executable: {
      schemaVersion: 2,
      provider: command.provider,
      sha256: "a".repeat(64),
      version: command.provider === "claude" ? "2.1.227" : "codex-cli 0.144.6",
      observedAt,
    },
    capability: {
      adapterApiVersion: "2.0.0",
      capabilitySchemaVersion: 1,
      providerRestrictionsVerified: true,
      runtimeIdentityVerified: true,
    },
  };
  return {
    ...attestation,
    ...overrides,
  };
}

function harness(store, mutateAttestation = (value) => value) {
  const runtime = { ensureCount: 0, kickCount: 0 };
  const plane = new DurableWorkbenchControlPlane(store, {
    preflight: async (command) => ({
      spec: {},
      attestation: mutateAttestation(attestationFor(command)),
    }),
    runtimeController: {
      ensureReady() { runtime.ensureCount += 1; },
      kick() { runtime.kickCount += 1; },
    },
  });
  return { plane, runtime };
}

test("each preflight attestation guard denies before run, outbox, or runtime side effects", async (t) => {
  const cases = [
    ["identity", (value) => ({ ...value, command: { ...value.command, callerSessionId: "tampered" } })],
    ["containment", (value) => ({ ...value, containment: { ...value.containment, approvedLaunchDirectory: false } })],
    ["secrets", (value) => ({ ...value, secretControls: { ...value.secretControls, promptTransport: "argv" } })],
    ["approval", (value) => ({ ...value, approval: { ...value.approval, commandBound: false } })],
    ["executable", (value) => ({ ...value, executable: { ...value.executable, sha256: "invalid" } })],
    ["capability", (value) => ({ ...value, capability: { ...value.capability, adapterApiVersion: "1.0.0" } })],
    ["freshness", (value) => ({ ...value, validUntil: new Date(NOW - 1).toISOString() })],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const { root, store } = scratchStore();
      try {
        const { plane, runtime } = harness(store, mutate);
        const runInput = input();
        await assert.rejects(
          plane.create(runInput, identityFor(runInput)),
          (error) => error?.category === "policy" && error?.runCreated === false,
        );
        assert.equal(store.listRuns().length, 0);
        assert.equal(runtime.ensureCount, 0);
        assert.equal(runtime.kickCount, 0);
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("Claude start binds one deterministic session and idempotent retry survives caller-token rotation", async () => {
  const { root, store } = scratchStore();
  try {
    const { plane, runtime } = harness(store);
    const runInput = input("claude", { idempotencyKey: "claude-stable-idem" });
    const first = await plane.create(runInput, identityFor(runInput, "caller-session-before-rotation"));
    const second = await plane.create(runInput, identityFor(runInput, "caller-session-after-rotation"));

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.run.id, first.run.id);
    assert.match(first.run.context.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.equal(second.run.context.sessionId, first.run.context.sessionId);
    assert.equal(store.listRuns().length, 1);
    assert.equal(runtime.ensureCount, 2);
    assert.equal(runtime.kickCount, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
