import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const sourceRoot = process.cwd();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:")
    ) {
      const url = new URL(specifier, context.parentURL);
      const candidate = decodeURIComponent(url.pathname).replace(
        /^\/(?=[A-Za-z]:\/)/u,
        "",
      );
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target))
        return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target))
        return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const {
  CODEX_RESTRICTED_EXECUTION_CONTRACT,
  CODEX_VERIFIED_RUNTIME_VERSION,
  createCodexRestrictedExecutionSpecResolver,
} = await import("./codex.ts");

const NATIVE_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const PROMPT_SENTINEL = "PROMPT_SENTINEL_must_only_travel_over_stdin";
const WORKBENCH_SECRET = "WORKBENCH_SESSION_SECRET_must_not_reach_child";
const PROVIDER_SECRET = "provider-auth-secret";
const ROUTER_SENTINEL = "https://omniroute.invalid/v1";

function startPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "codex",
    operation: "start",
    prompt: PROMPT_SENTINEL,
    projectId: "agent-os/project-a",
    ...overrides,
  };
}

function resumePayload(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "codex",
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
    provider: "codex",
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

function approvedCwd(projectId = "agent-os/project-a", provider = "codex") {
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

function executableIdentity(overrides = {}) {
  return {
    schemaVersion: 2,
    provider: "codex",
    absolutePath: "C:\\tools\\codex.cmd",
    launchPath: "C:\\Program Files\\nodejs\\node.exe",
    launchArgsPrefix: ["C:\\tools\\codex.js"],
    version: CODEX_VERIFIED_RUNTIME_VERSION,
    sha256: "b".repeat(64),
    sizeBytes: 123,
    modifiedAt: new Date(0).toISOString(),
    observedAt: new Date(0).toISOString(),
    files: [
      {
        role: "configured",
        absolutePath: "C:\\tools\\codex.cmd",
        sha256: "b".repeat(64),
        sizeBytes: 123,
        modifiedAt: new Date(0).toISOString(),
      },
    ],
    ...overrides,
  };
}

function createHarness(overrides = {}) {
  const calls = {
    projects: [],
    verifications: [],
    environments: 0,
  };
  const resolver = createCodexRestrictedExecutionSpecResolver({
    configuredExecutable: "codex",
    baseEnvironment: {
      PATH: "C:\\Windows\\System32",
      HOME: "C:\\Users\\tester",
      CODEX_HOME: "C:\\Users\\tester\\.codex",
      OPENAI_API_KEY: PROVIDER_SECRET,
      OPENAI_BASE_URL: ROUTER_SENTINEL,
      OPENROUTER_API_KEY: WORKBENCH_SECRET,
      OMNIROUTE_API_KEY: WORKBENCH_SECRET,
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
      verifyExecutableIdentity: async (
        provider,
        configuredExecutable,
        args,
        environment,
      ) => {
        calls.verifications.push({
          provider,
          configuredExecutable,
          args,
          environment,
        });
        if (overrides.verifyExecutableIdentity) {
          return overrides.verifyExecutableIdentity(
            provider,
            configuredExecutable,
            args,
            environment,
          );
        }
        return executableIdentity();
      },
      buildChildEnvironment(provider, base) {
        calls.environments += 1;
        if (overrides.buildChildEnvironment) {
          return overrides.buildChildEnvironment(provider, base);
        }
        return { ...base, NO_COLOR: "1", FORCE_COLOR: "0" };
      },
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

function configValues(args) {
  return args.flatMap((argument, index) =>
    argument === "-c" ? [args[index + 1]] : [],
  );
}

test("Codex restricted contract reports fake-runtime evidence and provider-native restriction", () => {
  assert.equal(
    CODEX_RESTRICTED_EXECUTION_CONTRACT.evidenceLevel,
    "fake-runtime",
  );
  assert.equal(CODEX_RESTRICTED_EXECUTION_CONTRACT.promptTransport, "stdin");
  assert.equal(
    CODEX_RESTRICTED_EXECUTION_CONTRACT.toolPolicy,
    "provider-native-restricted",
  );
  assert.equal(
    CODEX_RESTRICTED_EXECUTION_CONTRACT.verifiedRuntimeVersion,
    "codex-cli 0.144.6",
  );
  assert.deepEqual(CODEX_RESTRICTED_EXECUTION_CONTRACT.operations, [
    "start",
    "resume",
  ]);
  assert.deepEqual(CODEX_RESTRICTED_EXECUTION_CONTRACT.cancellation, {
    owner: "WindowsJobExecutionDriver",
    resolverAcceptsControlOperations: false,
    completionRequirement: "ACTIVE_PROCESS_ZERO",
  });
});

test("start pins Codex identity and sends prompt only through stdin", async () => {
  const { calls, resolver } = createHarness();
  const spec = await resolver(
    command(startPayload()),
    new AbortController().signal,
  );

  assert.equal(spec.provider, "codex");
  assert.equal(spec.cwd.provider, "codex");
  assert.equal(spec.cwd.projectId, "agent-os/project-a");
  assert.equal(spec.executableIdentity.provider, "codex");
  assert.equal(spec.executableIdentity.version, CODEX_VERIFIED_RUNTIME_VERSION);
  assert.equal(spec.input, PROMPT_SENTINEL);
  assert.equal(calls.projects.length, 1);
  assert.deepEqual(calls.projects[0], {
    provider: "codex",
    projectId: "agent-os/project-a",
  });
  assert.equal(calls.verifications.length, 1);
  assert.equal(calls.verifications[0].provider, "codex");
  assert.equal(calls.verifications[0].configuredExecutable, "codex");
  assert.deepEqual(calls.verifications[0].args, spec.args);

  assert.equal(spec.args[0], "exec");
  assert.equal(spec.args.at(-1), "-");
  assert.equal(argumentCount(spec.args, "resume"), 0);
  assert.equal(JSON.stringify(spec.args).includes(PROMPT_SENTINEL), false);
  assert.equal(JSON.stringify(spec.args).includes(WORKBENCH_SECRET), false);
  assert.equal(JSON.stringify(spec.args).includes(PROVIDER_SECRET), false);
});

test("resume targets one explicit UUID and still reads the prompt from stdin", async () => {
  const { resolver } = createHarness();
  const spec = await resolver(
    command(resumePayload()),
    new AbortController().signal,
  );

  assert.deepEqual(spec.args.slice(0, 2), ["exec", "resume"]);
  assert.equal(spec.args.at(-2), NATIVE_SESSION_ID);
  assert.equal(spec.args.at(-1), "-");
  assert.equal(argumentCount(spec.args, NATIVE_SESSION_ID), 1);
  assert.equal(argumentCount(spec.args, "--last"), 0);
  assert.equal(argumentCount(spec.args, "--all"), 0);
  assert.equal(spec.input, PROMPT_SENTINEL);
  assert.equal(JSON.stringify(spec.args).includes(PROMPT_SENTINEL), false);
});

test("every verified Codex restriction is represented as one immutable CLI override", async () => {
  const { resolver } = createHarness();
  const spec = await resolver(
    command(startPayload()),
    new AbortController().signal,
  );
  const values = configValues(spec.args);

  for (const flag of [
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--json",
    "--skip-git-repo-check",
  ]) {
    assert.equal(
      argumentCount(spec.args, flag),
      1,
      `${flag} must appear exactly once`,
    );
  }

  for (const expected of [
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    'web_search="disabled"',
    "mcp_servers={}",
    "skills.config=[]",
    "apps._default.enabled=false",
    "features.shell_tool=false",
    "features.shell_snapshot=false",
    "features.apps=false",
    "features.hooks=false",
    "features.multi_agent=false",
    "features.remote_plugin=false",
    "features.plugins=false",
    "features.plugin_sharing=false",
    "features.browser_use=false",
    "features.browser_use_external=false",
    "features.browser_use_full_cdp_access=false",
    "features.computer_use=false",
    "features.image_generation=false",
    "features.in_app_browser=false",
    "features.workspace_dependencies=false",
    "features.goals=false",
    "features.tool_suggest=false",
    "features.code_mode_host=false",
    "features.auth_elicitation=false",
    "features.tool_call_mcp_elicitation=false",
    "features.skill_mcp_dependency_install=false",
  ]) {
    assert.equal(
      values.filter((value) => value === expected).length,
      1,
      `${expected} must appear exactly once`,
    );
  }
  assert.equal(
    values.some((value) => value.startsWith("agents.enabled=")),
    false,
  );
  assert.equal(
    argumentCount(spec.args, "--dangerously-bypass-approvals-and-sandbox"),
    0,
  );
  assert.equal(argumentCount(spec.args, "--dangerously-bypass-hook-trust"), 0);
  assert.equal(argumentCount(spec.args, "--add-dir"), 0);
  assert.equal(argumentCount(spec.args, "--enable"), 0);
});

test("minimal child environment excludes Workbench, router, OpenRouter and Azure routing state", async () => {
  const { calls, resolver } = createHarness({
    buildChildEnvironment(_provider, base) {
      return {
        ...base,
        AZURE_OPENAI_API_KEY: WORKBENCH_SECRET,
        AZURE_OPENAI_ENDPOINT: ROUTER_SENTINEL,
        UNRELATED_SENTINEL: WORKBENCH_SECRET,
      };
    },
  });
  const spec = await resolver(
    command(startPayload()),
    new AbortController().signal,
  );

  assert.equal(calls.environments, 1);
  assert.equal(spec.env.CODEX_HOME, "C:\\Users\\tester\\.codex");
  assert.equal(spec.env.OPENAI_API_KEY, PROVIDER_SECRET);
  assert.equal(spec.env.PATH, "C:\\Windows\\System32");
  for (const key of [
    "OPENAI_BASE_URL",
    "OPENROUTER_API_KEY",
    "OMNIROUTE_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AGENT_OS_WORKBENCH_SESSION_TOKEN",
    "SESSION_TOKEN",
    "COOKIE",
    "UNRELATED_SENTINEL",
  ]) {
    assert.equal(spec.env[key], undefined, `${key} must not reach Codex`);
    assert.equal(
      calls.verifications[0].environment[key],
      undefined,
      `${key} must not reach identity probe`,
    );
  }
});

test("malformed, mismatched, override, and control commands fail before dependency side effects", async (t) => {
  const invalidCases = [
    [
      "provider mismatch",
      command(startPayload(), { provider: "claude" }),
      "identity",
    ],
    [
      "cancel control operation",
      command(startPayload(), { operation: "cancel" }),
      "unsupported",
    ],
    [
      "queue control operation",
      command(startPayload(), { operation: "queue" }),
      "unsupported",
    ],
    [
      "steer control operation",
      command(startPayload(), { operation: "steer" }),
      "unsupported",
    ],
    ["payload is not an object", command(null), "invalid_request"],
    [
      "unknown argv field",
      command(startPayload({ args: ["--dangerous"] })),
      "invalid_request",
    ],
    [
      "unknown cwd field",
      command(startPayload({ cwd: "C:\\unapproved" })),
      "invalid_request",
    ],
    [
      "unknown env field",
      command(startPayload({ env: { SENTINEL: WORKBENCH_SECRET } })),
      "invalid_request",
    ],
    [
      "unknown tools field",
      command(startPayload({ tools: ["shell"] })),
      "invalid_request",
    ],
    [
      "unknown MCP field",
      command(startPayload({ mcpServers: { unsafe: {} } })),
      "invalid_request",
    ],
    [
      "client model override",
      command(startPayload({ model: "gpt-unsafe" })),
      "invalid_request",
    ],
    [
      "client engine override",
      command(startPayload({ engine: "omniroute" })),
      "invalid_request",
    ],
    [
      "client effort override",
      command(startPayload({ effort: "xhigh" })),
      "invalid_request",
    ],
    [
      "client options override",
      command(startPayload({ options: {} })),
      "invalid_request",
    ],
    [
      "schema mismatch",
      command(startPayload({ schemaVersion: 2 })),
      "invalid_request",
    ],
    [
      "payload provider mismatch",
      command(startPayload({ provider: "claude" })),
      "identity",
    ],
    [
      "payload operation mismatch",
      command(startPayload({ operation: "resume" }), { operation: "start" }),
      "identity",
    ],
    [
      "empty prompt",
      command(startPayload({ prompt: "   " })),
      "invalid_request",
    ],
    [
      "NUL prompt",
      command(startPayload({ prompt: `safe\0${PROMPT_SENTINEL}` })),
      "invalid_request",
    ],
    [
      "oversized UTF-8 prompt",
      command(startPayload({ prompt: "א".repeat(17_000) })),
      "invalid_request",
    ],
    [
      "invalid project",
      command(startPayload({ projectId: "project with spaces" })),
      "invalid_request",
    ],
    [
      "start with native session",
      command(startPayload({ nativeSessionId: NATIVE_SESSION_ID })),
      "invalid_request",
    ],
    [
      "resume missing native session",
      command(resumePayload({ nativeSessionId: undefined })),
      "invalid_request",
    ],
    [
      "resume invalid UUID",
      command(resumePayload({ nativeSessionId: "not-a-uuid" })),
      "invalid_request",
    ],
  ];

  for (const [name, invalidCommand, failureClass] of invalidCases) {
    await t.test(name, async () => {
      const { calls, resolver } = createHarness();
      const error = await captureError(() =>
        resolver(invalidCommand, new AbortController().signal),
      );
      assertFailure(error, failureClass);
      assert.equal(calls.projects.length, 0);
      assert.equal(calls.verifications.length, 0);
      assert.equal(error.message.includes(PROMPT_SENTINEL), false);
      assert.equal(error.message.includes(WORKBENCH_SECRET), false);
    });
  }
});

test("abort at each resolver boundary fails as cancelled without leaking its reason", async (t) => {
  await t.test("before resolution", async () => {
    const controller = new AbortController();
    controller.abort(new Error(PROMPT_SENTINEL));
    const { calls, resolver } = createHarness();
    const error = await captureError(() =>
      resolver(command(startPayload()), controller.signal),
    );
    assertFailure(error, "cancelled");
    assert.equal(calls.projects.length, 0);
    assert.equal(calls.verifications.length, 0);
    assert.equal(error.message.includes(PROMPT_SENTINEL), false);
  });

  await t.test("after project resolution", async () => {
    const controller = new AbortController();
    const { calls, resolver } = createHarness({
      resolveProjectLaunchDirectory(provider, projectId) {
        controller.abort(new Error(WORKBENCH_SECRET));
        return approvedCwd(projectId, provider);
      },
    });
    const error = await captureError(() =>
      resolver(command(startPayload()), controller.signal),
    );
    assertFailure(error, "cancelled");
    assert.equal(calls.projects.length, 1);
    assert.equal(calls.environments, 0);
    assert.equal(calls.verifications.length, 0);
    assert.equal(error.message.includes(WORKBENCH_SECRET), false);
  });

  await t.test("during executable verification", async () => {
    const controller = new AbortController();
    const { calls, resolver } = createHarness({
      verifyExecutableIdentity() {
        controller.abort(new Error(PROMPT_SENTINEL));
        return executableIdentity();
      },
    });
    const error = await captureError(() =>
      resolver(command(startPayload()), controller.signal),
    );
    assertFailure(error, "cancelled");
    assert.equal(calls.verifications.length, 1);
    assert.equal(error.message.includes(PROMPT_SENTINEL), false);
  });
});

test("dependency errors, cwd mismatches, executable mismatches, and version drift fail closed", async (t) => {
  await t.test("project resolver error is sanitized", async () => {
    const { resolver } = createHarness({
      resolveProjectLaunchDirectory() {
        throw new Error(PROMPT_SENTINEL);
      },
    });
    const error = await captureError(() =>
      resolver(command(startPayload()), new AbortController().signal),
    );
    assertFailure(error, "containment");
    assert.equal(error.message.includes(PROMPT_SENTINEL), false);
  });

  await t.test(
    "mismatched cwd provider fails before executable verification",
    async () => {
      const { calls, resolver } = createHarness({
        resolveProjectLaunchDirectory(_provider, projectId) {
          return approvedCwd(projectId, "claude");
        },
      });
      const error = await captureError(() =>
        resolver(command(startPayload()), new AbortController().signal),
      );
      assertFailure(error, "identity");
      assert.equal(calls.verifications.length, 0);
    },
  );

  await t.test(
    "mismatched cwd project fails before executable verification",
    async () => {
      const { calls, resolver } = createHarness({
        resolveProjectLaunchDirectory(provider) {
          return approvedCwd("different-project", provider);
        },
      });
      const error = await captureError(() =>
        resolver(command(startPayload()), new AbortController().signal),
      );
      assertFailure(error, "identity");
      assert.equal(calls.verifications.length, 0);
    },
  );

  await t.test("executable verifier error is sanitized", async () => {
    const { resolver } = createHarness({
      verifyExecutableIdentity() {
        throw new Error(WORKBENCH_SECRET);
      },
    });
    const error = await captureError(() =>
      resolver(command(startPayload()), new AbortController().signal),
    );
    assertFailure(error, "identity");
    assert.equal(error.message.includes(WORKBENCH_SECRET), false);
  });

  await t.test("mismatched executable provider fails closed", async () => {
    const { resolver } = createHarness({
      verifyExecutableIdentity() {
        return executableIdentity({ provider: "claude" });
      },
    });
    const error = await captureError(() =>
      resolver(command(startPayload()), new AbortController().signal),
    );
    assertFailure(error, "identity");
  });

  await t.test(
    "runtime version drift invalidates the verified policy",
    async () => {
      const { resolver } = createHarness({
        verifyExecutableIdentity() {
          return executableIdentity({ version: "codex-cli 0.144.7" });
        },
      });
      const error = await captureError(() =>
        resolver(command(startPayload()), new AbortController().signal),
      );
      assertFailure(error, "identity");
      assert.match(error.message, /codex-cli 0\.144\.6/u);
    },
  );

  await t.test("malformed executable identity fails closed", async () => {
    const { resolver } = createHarness({
      verifyExecutableIdentity() {
        return executableIdentity({ absolutePath: "", files: [] });
      },
    });
    const error = await captureError(() =>
      resolver(command(startPayload()), new AbortController().signal),
    );
    assertFailure(error, "identity");
  });
});

test("invalid server-owned executable configuration fails closed", () => {
  for (const configuredExecutable of ["", "   ", "codex\0evil"]) {
    assert.throws(
      () =>
        createCodexRestrictedExecutionSpecResolver({ configuredExecutable }),
      (error) => error?.failure?.failureClass === "identity",
    );
  }
});
