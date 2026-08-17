import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const sourceRoot = process.cwd();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
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
  CLAUDE_RESTRICTED_EXECUTION_CONTRACT,
  createClaudeRestrictedExecutionSpecResolver,
} = await import("./claude.ts");

const NEW_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const NATIVE_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const PROMPT_SENTINEL = "PROMPT_SENTINEL_must_only_travel_over_stdin";
const WORKBENCH_SECRET = "WORKBENCH_SESSION_SECRET_must_not_reach_child";
const PROVIDER_SECRET = "provider-auth-secret";

function startPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "claude",
    operation: "start",
    prompt: PROMPT_SENTINEL,
    projectId: "agent-os/project-a",
    newSessionId: NEW_SESSION_ID,
    ...overrides,
  };
}

function resumePayload(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "claude",
    operation: "resume",
    prompt: PROMPT_SENTINEL,
    projectId: "agent-os/project-a",
    nativeSessionId: NATIVE_SESSION_ID,
    ...overrides,
  };
}

function command(payload = startPayload(), overrides = {}) {
  return {
    id: "command-1",
    runId: "run-1",
    provider: "claude",
    operation: payload?.operation ?? "start",
    payload,
    payloadHash: "a".repeat(64),
    idempotencyKey: "idem-1",
    runGeneration: 1,
    runStateVersion: 1,
    executionId: "execution-1",
    attempt: 1,
    deliveryAttempts: 1,
    maxAttempts: 3,
    checkpoint: "dequeued",
    availableAt: new Date(0).toISOString(),
    resources: {
      cpuTimeMs: 10_000,
      residentMemoryBytes: 128 * 1024 * 1024,
      processCount: 4,
      outputBytes: 1024 * 1024,
    },
    ...overrides,
  };
}

function approvedCwd(projectId = "agent-os/project-a", provider = "claude") {
  return {
    schemaVersion: 1,
    provider,
    projectId,
    absolutePath: "C:\\approved\\agent-os-project-a",
    device: 1,
    inode: 2,
    modifiedMs: 3,
  };
}

function executableIdentity(provider = "claude") {
  return {
    schemaVersion: 2,
    provider,
    absolutePath: "C:\\tools\\claude.cmd",
    launchPath: "C:\\Windows\\System32\\cmd.exe",
    launchArgsPrefix: ["/d", "/s", "/c", "C:\\tools\\claude.cmd"],
    version: "2.1.227",
    sha256: "b".repeat(64),
    sizeBytes: 123,
    modifiedAt: new Date(0).toISOString(),
    observedAt: new Date(0).toISOString(),
    files: [{
      role: "configured",
      absolutePath: "C:\\tools\\claude.cmd",
      sha256: "b".repeat(64),
      sizeBytes: 123,
      modifiedAt: new Date(0).toISOString(),
    }],
  };
}

function createHarness(overrides = {}) {
  const calls = {
    projects: [],
    verifications: [],
    environments: 0,
  };
  const resolver = createClaudeRestrictedExecutionSpecResolver({
    configuredExecutable: "claude",
    model: "claude-opus-4-1-20250805",
    baseEnvironment: {
      PATH: "C:\\Windows\\System32",
      HOME: "C:\\Users\\tester",
      ANTHROPIC_API_KEY: PROVIDER_SECRET,
      AGENT_OS_WORKBENCH_SESSION_TOKEN: WORKBENCH_SECRET,
      SESSION_TOKEN: WORKBENCH_SECRET,
      COOKIE: WORKBENCH_SECRET,
    },
    dependencies: {
      resolveProjectLaunchDirectory: async (provider, projectId) => {
        calls.projects.push({ provider, projectId });
        if (overrides.resolveProjectLaunchDirectory) {
          return overrides.resolveProjectLaunchDirectory(provider, projectId);
        }
        return approvedCwd(projectId, provider);
      },
      verifyExecutableIdentity: async (provider, configuredExecutable, args, environment) => {
        calls.verifications.push({ provider, configuredExecutable, args, environment });
        if (overrides.verifyExecutableIdentity) {
          return overrides.verifyExecutableIdentity(provider, configuredExecutable, args, environment);
        }
        return executableIdentity(provider);
      },
      ...(overrides.buildChildEnvironment
        ? {
            buildChildEnvironment(provider, base) {
              calls.environments += 1;
              return overrides.buildChildEnvironment(provider, base);
            },
          }
        : {}),
    },
  });
  return { calls, resolver };
}

async function captureError(operation) {
  let caught;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "operation must reject");
  return caught;
}

function assertFailure(error, failureClass) {
  assert.equal(error.name, "DurableExecutionError");
  assert.equal(error.failure?.failureClass, failureClass);
}

function argumentCount(args, value) {
  return args.filter((argument) => argument === value).length;
}

test("Claude restricted contract reports fake-runtime evidence and Windows Job cancellation ownership", () => {
  assert.equal(CLAUDE_RESTRICTED_EXECUTION_CONTRACT.evidenceLevel, "fake-runtime");
  assert.equal(CLAUDE_RESTRICTED_EXECUTION_CONTRACT.promptTransport, "stdin");
  assert.equal(CLAUDE_RESTRICTED_EXECUTION_CONTRACT.providerNativeTools, "disabled");
  assert.deepEqual(CLAUDE_RESTRICTED_EXECUTION_CONTRACT.operations, ["start", "resume"]);
  assert.deepEqual(CLAUDE_RESTRICTED_EXECUTION_CONTRACT.cancellation, {
    owner: "WindowsJobExecutionDriver",
    resolverAcceptsControlOperations: false,
    completionRequirement: "ACTIVE_PROCESS_ZERO",
  });
});

test("start pins Claude identity and sends prompt only through stdin", async () => {
  const { calls, resolver } = createHarness();
  const spec = await resolver(command(startPayload()), new AbortController().signal);

  assert.equal(spec.provider, "claude");
  assert.equal(spec.cwd.provider, "claude");
  assert.equal(spec.cwd.projectId, "agent-os/project-a");
  assert.equal(spec.executableIdentity.provider, "claude");
  assert.equal(spec.input, PROMPT_SENTINEL);
  assert.equal(calls.projects.length, 1);
  assert.deepEqual(calls.projects[0], { provider: "claude", projectId: "agent-os/project-a" });
  assert.equal(calls.verifications.length, 1);
  assert.equal(calls.verifications[0].provider, "claude");
  assert.equal(calls.verifications[0].configuredExecutable, "claude");
  assert.deepEqual(calls.verifications[0].args, spec.args);

  assert.equal(argumentCount(spec.args, "--session-id"), 1);
  assert.equal(argumentCount(spec.args, "--resume"), 0);
  assert.equal(spec.args[spec.args.indexOf("--session-id") + 1], NEW_SESSION_ID);
  assert.equal(JSON.stringify(spec.args).includes(PROMPT_SENTINEL), false);
  assert.equal(JSON.stringify(spec.args).includes(WORKBENCH_SECRET), false);
  assert.equal(JSON.stringify(spec.args).includes(PROVIDER_SECRET), false);

  for (const flag of [
    "--safe-mode",
    "--disable-slash-commands",
    "--no-chrome",
    "--strict-mcp-config",
    "--mcp-config",
    "--tools",
    "--permission-mode",
  ]) {
    assert.equal(argumentCount(spec.args, flag), 1, `${flag} must appear exactly once`);
  }
  assert.equal(spec.args[spec.args.indexOf("--mcp-config") + 1], "{\"mcpServers\":{}}");
  assert.equal(spec.args[spec.args.indexOf("--tools") + 1], "");
  assert.equal(spec.args[spec.args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(argumentCount(spec.args, "--input-format=text"), 1);
  assert.equal(argumentCount(spec.args, "--output-format=stream-json"), 1);
  assert.equal(argumentCount(spec.args, "--include-partial-messages"), 1);
  assert.equal(argumentCount(spec.args, "--verbose"), 1);
  assert.equal(Object.isFrozen(spec.args), true);
  for (const forbiddenFlag of [
    "--add-dir",
    "--agent",
    "--agents",
    "--allowedTools",
    "--allowed-tools",
    "--append-system-prompt",
    "--chrome",
    "--dangerously-skip-permissions",
    "--disallowedTools",
    "--disallowed-tools",
    "--plugin-dir",
    "--plugin-url",
    "--settings",
    "--system-prompt",
  ]) {
    assert.equal(argumentCount(spec.args, forbiddenFlag), 0, `${forbiddenFlag} must remain unavailable`);
  }

  assert.equal(spec.env.ANTHROPIC_API_KEY, PROVIDER_SECRET);
  assert.equal(spec.env.AGENT_OS_WORKBENCH_SESSION_TOKEN, undefined);
  assert.equal(spec.env.SESSION_TOKEN, undefined);
  assert.equal(spec.env.COOKIE, undefined);
});

test("resume targets the existing native session without allocating a new one", async () => {
  const { resolver } = createHarness();
  const spec = await resolver(command(resumePayload()), new AbortController().signal);

  assert.equal(argumentCount(spec.args, "--resume"), 1);
  assert.equal(argumentCount(spec.args, "--session-id"), 0);
  assert.equal(spec.args[spec.args.indexOf("--resume") + 1], NATIVE_SESSION_ID);
  assert.equal(spec.input, PROMPT_SENTINEL);
  assert.equal(JSON.stringify(spec.args).includes(PROMPT_SENTINEL), false);
});

test("malformed, mismatched, and control commands fail before dependency side effects", async (t) => {
  const invalidCases = [
    ["provider mismatch", command(startPayload(), { provider: "codex" }), "identity"],
    ["cancel control operation", command(startPayload(), { operation: "cancel" }), "unsupported"],
    ["queue control operation", command(startPayload(), { operation: "queue" }), "unsupported"],
    ["steer control operation", command(startPayload(), { operation: "steer" }), "unsupported"],
    ["payload is not an object", command(null), "invalid_request"],
    ["unknown field", command(startPayload({ unexpected: true })), "invalid_request"],
    ["client model override", command(startPayload({ model: "attacker-model" })), "invalid_request"],
    ["client executable override", command(startPayload({ executable: "attacker.exe" })), "invalid_request"],
    ["client cwd override", command(startPayload({ cwd: "C:\\attacker" })), "invalid_request"],
    ["client tool override", command(startPayload({ tools: "default" })), "invalid_request"],
    ["client permission override", command(startPayload({ permissionMode: "bypassPermissions" })), "invalid_request"],
    ["schema mismatch", command(startPayload({ schemaVersion: 2 })), "invalid_request"],
    ["payload provider mismatch", command(startPayload({ provider: "codex" })), "identity"],
    ["payload operation mismatch", command(startPayload({ operation: "resume" }), { operation: "start" }), "identity"],
    ["empty prompt", command(startPayload({ prompt: "   " })), "invalid_request"],
    ["NUL prompt", command(startPayload({ prompt: `safe\0${PROMPT_SENTINEL}` })), "invalid_request"],
    ["oversized UTF-8 prompt", command(startPayload({ prompt: "א".repeat(17_000) })), "invalid_request"],
    ["invalid project", command(startPayload({ projectId: "project with spaces" })), "invalid_request"],
    ["start missing new session", command(startPayload({ newSessionId: undefined })), "invalid_request"],
    ["start with native session", command(startPayload({ nativeSessionId: NATIVE_SESSION_ID })), "invalid_request"],
    ["resume missing native session", command(resumePayload({ nativeSessionId: undefined })), "invalid_request"],
    ["resume with new session", command(resumePayload({ newSessionId: NEW_SESSION_ID })), "invalid_request"],
    ["invalid UUID", command(startPayload({ newSessionId: "not-a-uuid" })), "invalid_request"],
  ];

  for (const [name, invalidCommand, failureClass] of invalidCases) {
    await t.test(name, async () => {
      const { calls, resolver } = createHarness();
      const error = await captureError(() => resolver(invalidCommand, new AbortController().signal));
      assertFailure(error, failureClass);
      assert.equal(calls.projects.length, 0);
      assert.equal(calls.verifications.length, 0);
      assert.equal(error.message.includes(PROMPT_SENTINEL), false);
      assert.equal(error.message.includes(WORKBENCH_SECRET), false);
    });
  }
});

test("prompt limit is enforced by UTF-8 bytes rather than JavaScript code units", async () => {
  const { resolver } = createHarness();
  const accepted = "א".repeat(16 * 1024);
  const spec = await resolver(
    command(startPayload({ prompt: accepted })),
    new AbortController().signal,
  );
  assert.equal(Buffer.byteLength(spec.input, "utf8"), 32 * 1024);

  const rejected = await captureError(() => resolver(
    command(startPayload({ prompt: `${accepted}א` })),
    new AbortController().signal,
  ));
  assertFailure(rejected, "invalid_request");
});

test("abort before resolution fails as cancelled without dependency side effects", async () => {
  const controller = new AbortController();
  controller.abort(new Error(PROMPT_SENTINEL));
  const { calls, resolver } = createHarness();
  const error = await captureError(() => resolver(command(startPayload()), controller.signal));

  assertFailure(error, "cancelled");
  assert.equal(calls.projects.length, 0);
  assert.equal(calls.verifications.length, 0);
  assert.equal(error.message.includes(PROMPT_SENTINEL), false);
});

test("abort after project resolution stops before environment and executable verification", async () => {
  const controller = new AbortController();
  const { calls, resolver } = createHarness({
    resolveProjectLaunchDirectory(provider, projectId) {
      controller.abort(new Error(PROMPT_SENTINEL));
      return approvedCwd(projectId, provider);
    },
    buildChildEnvironment() {
      assert.fail("environment builder must not run after abort");
    },
  });
  const error = await captureError(() => resolver(command(startPayload()), controller.signal));

  assertFailure(error, "cancelled");
  assert.equal(calls.projects.length, 1);
  assert.equal(calls.verifications.length, 0);
  assert.equal(calls.environments, 0);
  assert.equal(error.message.includes(PROMPT_SENTINEL), false);
});

test("abort during executable verification fails as cancelled without exposing its reason", async () => {
  const controller = new AbortController();
  const { calls, resolver } = createHarness({
    verifyExecutableIdentity(provider) {
      controller.abort(new Error(PROMPT_SENTINEL));
      return executableIdentity(provider);
    },
  });
  const error = await captureError(() => resolver(command(startPayload()), controller.signal));

  assertFailure(error, "cancelled");
  assert.equal(calls.verifications.length, 1);
  assert.equal(error.message.includes(PROMPT_SENTINEL), false);
});

test("dependency errors and returned identities cannot expose or misbind execution", async (t) => {
  await t.test("project resolver error is sanitized", async () => {
    const { resolver } = createHarness({
      resolveProjectLaunchDirectory() {
        throw new Error(PROMPT_SENTINEL);
      },
    });
    const error = await captureError(() => resolver(command(startPayload()), new AbortController().signal));
    assertFailure(error, "containment");
    assert.equal(error.message.includes(PROMPT_SENTINEL), false);
  });

  await t.test("executable verifier error is sanitized", async () => {
    const { resolver } = createHarness({
      verifyExecutableIdentity() {
        throw new Error(WORKBENCH_SECRET);
      },
    });
    const error = await captureError(() => resolver(command(startPayload()), new AbortController().signal));
    assertFailure(error, "identity");
    assert.equal(error.message.includes(WORKBENCH_SECRET), false);
  });

  await t.test("environment builder error is sanitized", async () => {
    const { calls, resolver } = createHarness({
      buildChildEnvironment() {
        throw new Error(WORKBENCH_SECRET);
      },
    });
    const error = await captureError(() => resolver(command(startPayload()), new AbortController().signal));
    assertFailure(error, "policy");
    assert.equal(calls.verifications.length, 0);
    assert.equal(error.message.includes(WORKBENCH_SECRET), false);
  });

  await t.test("custom environment builder cannot bypass the canonical allowlist", async () => {
    const { calls, resolver } = createHarness({
      buildChildEnvironment() {
        return {
          PATH: "C:\\Windows\\System32",
          AGENT_OS_WORKBENCH_SESSION_TOKEN: WORKBENCH_SECRET,
        };
      },
    });
    const error = await captureError(() => resolver(command(startPayload()), new AbortController().signal));
    assertFailure(error, "policy");
    assert.equal(calls.verifications.length, 0);
    assert.equal(error.message.includes(WORKBENCH_SECRET), false);
  });

  await t.test("mismatched cwd provider fails before executable verification", async () => {
    const { calls, resolver } = createHarness({
      resolveProjectLaunchDirectory(_provider, projectId) {
        return approvedCwd(projectId, "codex");
      },
    });
    const error = await captureError(() => resolver(command(startPayload()), new AbortController().signal));
    assertFailure(error, "identity");
    assert.equal(calls.verifications.length, 0);
  });

  await t.test("mismatched executable provider fails closed", async () => {
    const { resolver } = createHarness({
      verifyExecutableIdentity() {
        return executableIdentity("codex");
      },
    });
    const error = await captureError(() => resolver(command(startPayload()), new AbortController().signal));
    assertFailure(error, "identity");
  });
});

test("server-owned executable and model configuration fail closed", () => {
  for (const options of [
    { configuredExecutable: "", model: "claude-opus-4-1-20250805" },
    { configuredExecutable: "claude", model: "-dangerous-model-argument" },
    { configuredExecutable: "claude", model: "model with spaces" },
  ]) {
    assert.throws(
      () => createClaudeRestrictedExecutionSpecResolver(options),
      (error) => error?.failure?.failureClass === "identity",
    );
  }
});
