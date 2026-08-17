import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const sourceRoot = process.cwd();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript," };
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../"))
      && context.parentURL?.startsWith("file:")
    ) {
      const url = new URL(specifier, context.parentURL);
      const candidate = decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:\/)/u, "");
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const {
  createRestrictedPilotExecutionSpecResolver,
  createRestrictedPilotPreflightResolver,
} = await import("./index.ts");
const { CODEX_RESTRICTED_EXECUTION_CONTRACT } = await import("./codex.ts");
const { createRunIdempotencyBinding } = await import("../idempotency.ts");
const { validateCreateRun, WorkbenchValidationError } = await import("../http.ts");

const NATIVE_SESSION_ID = "22222222-2222-4222-8222-222222222222";

function canonicalCommand(provider = "codex", operation = "start") {
  const sessionId = operation === "resume" || provider === "claude"
    ? NATIVE_SESSION_ID
    : null;
  const idempotencyKey = `${provider}-idem-1`;
  const payload = {
    schemaVersion: 1,
    operation,
    prompt: "Return the pilot sentinel only.",
    context: {
      agentId: provider,
      actorId: provider,
      projectId: "agent-os/project-a",
      sessionId,
      environment: "local",
      panel: "transcript",
    },
    options: { model: null, engine: null, effort: null },
    commandIdentity: {
      callerSessionId: "caller-session-1",
      actorId: provider,
      projectId: "agent-os/project-a",
      worktreeId: "local",
      provider,
      profileId: null,
      nativeSessionId: sessionId,
      runId: idempotencyKey,
    },
    toolPolicy: provider === "claude" ? "disabled" : "provider-native-restricted",
    resources: {},
    maxAttempts: 3,
  };
  const durableBinding = createRunIdempotencyBinding({
    actorId: provider,
    projectId: "agent-os/project-a",
    operation,
    callerKey: idempotencyKey,
    payload: {
      ...payload,
      commandIdentity: {
        actorId: payload.commandIdentity.actorId,
        projectId: payload.commandIdentity.projectId,
        worktreeId: payload.commandIdentity.worktreeId,
        provider: payload.commandIdentity.provider,
        profileId: payload.commandIdentity.profileId,
        nativeSessionId: payload.commandIdentity.nativeSessionId,
        runId: payload.commandIdentity.runId,
      },
    },
  });
  return {
    id: "command-1",
    runId: "durable-run-1",
    provider,
    operation,
    payload,
    payloadHash: "a".repeat(64),
    idempotencyKey: durableBinding.key,
    runGeneration: 1,
    runStateVersion: 1,
    executionId: "execution-1",
    attempt: 1,
    deliveryAttempts: 1,
    maxAttempts: 3,
    checkpoint: "dequeued",
    availableAt: new Date(0).toISOString(),
    resources: {},
  };
}

function harness() {
  const calls = [];
  const providerResolver = (provider) => async (command) => {
    calls.push({ provider, command });
    return { provider };
  };
  return {
    calls,
    resolver: createRestrictedPilotExecutionSpecResolver({
      codex: () => providerResolver("codex"),
      claude: () => providerResolver("claude"),
    }),
  };
}

test("translates canonical Codex resume without forwarding control-plane fields", async () => {
  const { calls, resolver } = harness();
  const command = canonicalCommand("codex", "resume");
  await resolver(command, AbortSignal.timeout(1_000));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "codex");
  assert.deepEqual(calls[0].command.payload, {
    schemaVersion: 1,
    provider: "codex",
    operation: "resume",
    prompt: "Return the pilot sentinel only.",
    projectId: "agent-os/project-a",
    nativeSessionId: NATIVE_SESSION_ID,
  });
});

test("translates canonical Claude start with the server-assigned session", async () => {
  const { calls, resolver } = harness();
  const command = canonicalCommand("claude", "start");
  await resolver(command, AbortSignal.timeout(1_000));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "claude");
  assert.deepEqual(calls[0].command.payload, {
    schemaVersion: 1,
    provider: "claude",
    operation: "start",
    prompt: "Return the pilot sentinel only.",
    projectId: "agent-os/project-a",
    newSessionId: NATIVE_SESSION_ID,
  });
});

test("rejects every provider option override before resolver side effects", async (t) => {
  for (const [field, value] of [["model", "custom"], ["engine", "hy3"], ["effort", "high"]]) {
    await t.test(field, async () => {
      const { calls, resolver } = harness();
      const command = canonicalCommand();
      command.payload.options[field] = value;
      await assert.rejects(
        resolver(command, AbortSignal.timeout(1_000)),
        (error) => error?.failure?.failureClass === "policy",
      );
      assert.equal(calls.length, 0);
    });
  }
});

test("rejects profile and admission-run identity mismatches before resolver side effects", async (t) => {
  for (const [field, value] of [["profileId", "unexpected-profile"], ["runId", "wrong-idempotency-key"]]) {
    await t.test(field, async () => {
      const { calls, resolver } = harness();
      const command = canonicalCommand();
      command.payload.commandIdentity[field] = value;
      await assert.rejects(
        resolver(command, AbortSignal.timeout(1_000)),
        (error) => error?.failure?.failureClass === "identity",
      );
      assert.equal(calls.length, 0);
    });
  }
});

test("rejects a durable idempotency binding mismatch before resolver side effects", async () => {
  const { calls, resolver } = harness();
  const command = canonicalCommand();
  command.idempotencyKey = "0".repeat(64);
  await assert.rejects(
    resolver(command, AbortSignal.timeout(1_000)),
    (error) => error?.failure?.failureClass === "identity",
  );
  assert.equal(calls.length, 0);
});

test("HTTP validation permits only server-owned null options for the restricted pilot", () => {
  const body = {
    agentId: "codex",
    prompt: "pilot",
    idempotencyKey: "codex-idem-1",
    context: {
      actorId: "codex",
      projectId: "agent-os/project-a",
      sessionId: null,
      environment: "local",
    },
  };
  assert.deepEqual(validateCreateRun(body).options, {
    model: null,
    engine: null,
    effort: null,
  });

  for (const options of [{ model: "custom" }, { engine: "hy3" }, { effort: "high" }]) {
    assert.throws(
      () => validateCreateRun({ ...body, options }),
      (error) => error instanceof WorkbenchValidationError && /server-managed/u.test(error.message),
    );
  }
});

test("production preflight derives a complete command-bound admission attestation", async () => {
  const command = canonicalCommand("codex", "start");
  const now = Date.parse("2026-08-14T12:00:00.000Z");
  const executableObservedAt = "2026-08-14T11:59:59.000Z";
  const spec = {
    provider: "codex",
    executableIdentity: {
      schemaVersion: 2,
      provider: "codex",
      sha256: "b".repeat(64),
      version: "codex-test",
      observedAt: executableObservedAt,
    },
    args: [
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--json",
      "--skip-git-repo-check",
      ...CODEX_RESTRICTED_EXECUTION_CONTRACT.requiredConfigOverrides.flatMap((override) => ["-c", override]),
    ],
    cwd: {
      schemaVersion: 1,
      provider: "codex",
      projectId: "agent-os/project-a",
      absolutePath: "C:\\agent-os\\project-a",
      device: 11,
      inode: 22,
      modifiedMs: 33,
    },
    env: { NO_COLOR: "1", FORCE_COLOR: "0" },
    input: command.payload.prompt,
  };
  let resolverCalls = 0;
  const preflight = createRestrictedPilotPreflightResolver(async () => {
    resolverCalls += 1;
    return spec;
  }, () => now);

  const result = await preflight(command, AbortSignal.timeout(1_000));

  assert.equal(resolverCalls, 1);
  assert.equal(result.spec, spec);
  assert.deepEqual(result.attestation, {
    schemaVersion: 1,
    provider: "codex",
    operation: "start",
    observedAt: "2026-08-14T12:00:00.000Z",
    validUntil: "2026-08-14T12:00:30.000Z",
    command: {
      callerSessionId: "caller-session-1",
      actorId: "codex",
      projectId: "agent-os/project-a",
      worktreeId: "local",
      nativeSessionId: null,
      runId: "codex-idem-1",
      explicitUserMutation: true,
    },
    containment: {
      approvedLaunchDirectory: true,
      windowsJobObjectRequired: true,
      directoryIdentity: "11:22:33",
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
      toolPolicy: "provider-native-restricted",
    },
    executable: {
      schemaVersion: 2,
      provider: "codex",
      sha256: "b".repeat(64),
      version: "codex-test",
      observedAt: executableObservedAt,
    },
    capability: {
      adapterApiVersion: "2.0.0",
      capabilitySchemaVersion: 1,
      providerRestrictionsVerified: true,
      runtimeIdentityVerified: true,
    },
  });
});
