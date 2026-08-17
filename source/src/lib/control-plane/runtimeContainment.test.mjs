import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProviderChildEnvironment } from "./childEnvironment.ts";
import {
  assertExecutableIdentityBindingSync,
  assertPinnedExecutableIdentity,
  assertProviderLaunch,
  assertProviderExecutionArguments,
  resetExecutableIdentityPinsForTests,
} from "./executableIdentity.ts";
import {
  approveLaunchDirectory,
  assertLaunchDirectoryBindingSync,
  assertRuntimeContainmentAvailable,
  RuntimeContainmentError,
} from "./runtimeContainment.ts";

const providers = ["codex", "claude", "hermes", "openclaw", "antigravity"];

test("provider child environments omit parent and Workbench sentinel secrets", () => {
  const parent = {
    PATH: process.env.PATH,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET: "SENTINEL_BOOTSTRAP_9f2b",
    AGENT_OS_WORKBENCH_SESSION_TOKEN: "SENTINEL_SESSION_75cc",
    UNRELATED_PARENT_SECRET: "SENTINEL_PARENT_24aa",
    OPENAI_API_KEY: "provider-key",
  };
  for (const provider of providers) {
    const environment = buildProviderChildEnvironment(provider, parent);
    const serialized = JSON.stringify(environment);
    assert.doesNotMatch(serialized, /SENTINEL_/);
    assert.equal(environment.AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET, undefined);
    assert.equal(environment.AGENT_OS_WORKBENCH_SESSION_TOKEN, undefined);
    assert.equal(environment.UNRELATED_PARENT_SECRET, undefined);
  }
});

test("non-allowlisted explicit child environment keys fail closed", () => {
  assert.throws(
    () => buildProviderChildEnvironment("codex", {}, { AGENT_OS_WORKBENCH_SESSION_TOKEN: "sentinel" }),
    { code: "forbidden_provider_environment" },
  );
  assert.throws(
    () => buildProviderChildEnvironment("claude", {}, { NODE_OPTIONS: "--require attacker.js" }),
    { code: "forbidden_provider_environment" },
  );
});

test("provider version probe receives the minimal child environment", async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-version-env-${process.pid}-${Date.now()}`);
  const probe = path.join(scratch, "probe.mjs");
  await mkdir(scratch, { recursive: true });
  await writeFile(probe, "console.log(process.env.AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET ? 'LEAKED' : 'provider-clean-1.0.0')\n", "utf8");
  resetExecutableIdentityPinsForTests();
  try {
    const environment = buildProviderChildEnvironment("claude", {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET: "SENTINEL_VERSION_PROBE",
    });
    const identity = await assertProviderLaunch("claude", process.execPath, [], environment, { versionArgs: [probe] });
    assert.equal(identity.version, "provider-clean-1.0.0");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Claude and Antigravity permission bypass flags fail closed", () => {
  assert.throws(() => assertProviderExecutionArguments("claude", ["--dangerously-skip-permissions"]), { code: "forbidden_provider_flag" });
  assert.throws(() => assertProviderExecutionArguments("antigravity", ["--dangerously-skip-permissions=true"]), { code: "forbidden_provider_flag" });
});

test("executable identity binds Windows shim runtime and payload", { skip: process.platform !== "win32" }, async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-shim-chain-${process.pid}-${Date.now()}`);
  const payload = path.join(scratch, "node_modules", "provider", "cli.mjs");
  const shim = path.join(scratch, "provider.cmd");
  await mkdir(path.dirname(payload), { recursive: true });
  await writeFile(payload, "console.log('provider 1.0.0')\n", "utf8");
  await writeFile(shim, '@echo off\n"node" "%dp0%\\node_modules\\provider\\cli.mjs" %*\n', "utf8");
  resetExecutableIdentityPinsForTests();
  try {
    const identity = await assertPinnedExecutableIdentity("openclaw", shim, { versionReader: async () => "provider 1.0.0" });
    assert.deepEqual(identity.files.map((file) => file.role), ["configured", "runtime", "payload"]);
    assert.equal(identity.launchPath, process.execPath);
    assert.equal(identity.launchArgsPrefix[0], payload);
    assertExecutableIdentityBindingSync(identity);
    await writeFile(payload, "console.log('provider changed')\n", "utf8");
    assert.throws(() => assertExecutableIdentityBindingSync(identity), { code: "executable_identity_changed" });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("launch cwd binding rejects reparse directories and replacement", async () => {
  const scratch = path.join(os.tmpdir(), `agent-os-cwd-binding-${process.pid}-${Date.now()}`);
  const project = path.join(scratch, "project");
  const target = path.join(scratch, "target");
  const link = path.join(scratch, "link");
  await mkdir(project, { recursive: true });
  await mkdir(target, { recursive: true });
  try {
    const approved = approveLaunchDirectory("claude", "project", project);
    assertLaunchDirectoryBindingSync(approved);
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => approveLaunchDirectory("claude", "link", link), { code: "launch_cwd_invalid" });
    await rm(project, { recursive: true, force: true });
    await mkdir(project, { recursive: true });
    assert.throws(() => assertLaunchDirectoryBindingSync(approved), { code: "launch_cwd_changed" });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Windows starts remain blocked until Job Object launcher exists", () => {
  if (process.platform === "win32") {
    assert.throws(
      () => assertRuntimeContainmentAvailable("codex"),
      (error) => error instanceof RuntimeContainmentError
        && error.code === "runtime_containment_unavailable"
        && error.blocker === "windows_job_object_launcher_unavailable",
    );
  } else {
    assert.doesNotThrow(() => assertRuntimeContainmentAvailable("codex"));
  }
});
