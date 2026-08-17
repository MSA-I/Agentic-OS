import { expect, test } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertPinnedExecutableIdentity,
  assertProviderExecutionArguments,
  ExecutableIdentityError,
  invalidateExecutableIdentity,
  resetExecutableIdentityPinsForTests,
  resolveExecutablePath,
} from "../../src/lib/control-plane/executableIdentity";
import { codexApprovalArgs, codexResumeApprovalArgs } from "../../src/lib/codexWorkspace";

function expectIdentityError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutableIdentityError);
    expect((error as ExecutableIdentityError).code).toBe(code);
  }
}

test.describe("provider execution safety contract", () => {
  test.beforeEach(() => resetExecutableIdentityPinsForTests());

  test("Hermes rejects argument and environment approval bypasses", () => {
    expectIdentityError(
      () => assertProviderExecutionArguments("hermes", ["chat", "--yolo"]),
      "forbidden_provider_flag",
    );
    expectIdentityError(
      () => assertProviderExecutionArguments("hermes", ["chat", "--accept-hooks=true"]),
      "forbidden_provider_flag",
    );
    expectIdentityError(
      () => assertProviderExecutionArguments("hermes", ["chat"], { HERMES_ACCEPT_HOOKS: "1" }),
      "forbidden_provider_environment",
    );
  });

  test("Codex rejects permission and containment bypasses", () => {
    expectIdentityError(
      () => assertProviderExecutionArguments("codex", ["--dangerously-bypass-approvals-and-sandbox"]),
      "forbidden_provider_flag",
    );
    expectIdentityError(
      () => assertProviderExecutionArguments("codex", ["--sandbox", "danger-full-access"]),
      "forbidden_provider_flag",
    );
    expectIdentityError(
      () => assertProviderExecutionArguments("codex", ["-c", "sandbox_mode=danger-full-access"]),
      "forbidden_provider_flag",
    );
  });

  test("legacy or arbitrary Codex approval values cannot increase authority", () => {
    for (const value of ["yolo", "danger-full-access", "bypass", true, null]) {
      const fresh = codexApprovalArgs(value);
      const resumed = codexResumeApprovalArgs(value);
      expect(fresh).toContain("workspace-write");
      expect(resumed.join(" ")).toContain("workspace-write");
      expect(`${fresh.join(" ")} ${resumed.join(" ")}`).not.toContain("danger-full-access");
      expect(`${fresh.join(" ")} ${resumed.join(" ")}`).not.toContain("bypass-approvals");
    }
    expect(codexApprovalArgs("readonly")).toContain("read-only");
  });

  test("Codex chat rejects client cwd and the legacy goal route is GET-only", async () => {
    const chatSource = await readFile(
      path.join(process.cwd(), "src/app/api/codex/chat/route.ts"),
      "utf8",
    );
    expect(chatSource).toContain("if (body.cwd !== undefined)");
    expect(chatSource).toContain("client-supplied cwd is not accepted");
    expect(chatSource).not.toMatch(/cwd\s*=\s*body\.cwd/);

    const goalsSource = await readFile(
      path.join(process.cwd(), "src/app/api/codex/goals/route.ts"),
      "utf8",
    );
    expect(goalsSource).toContain("export async function GET");
    expect(goalsSource).toContain("readOnly: true");
    expect(goalsSource).not.toMatch(/export async function (?:POST|PATCH|DELETE)/u);
  });

  test("Codex clients expose no full-access mode and send project identity instead of cwd", async () => {
    for (const relativePath of [
      "src/components/CodexView.tsx",
      "src/components/CodexDesktop.tsx",
    ]) {
      const source = await readFile(path.join(process.cwd(), relativePath), "utf8");
      expect(source).not.toMatch(/value=["']yolo["']/i);
      expect(source).not.toMatch(/cwd:\s*activeProject/i);
      expect(source).toMatch(/projectId:/);
    }
    const hermesGoals = await readFile(path.join(process.cwd(), "src/components/HermesGoals.tsx"), "utf8");
    expect(hermesGoals).not.toMatch(/--yolo|HERMES_ACCEPT_HOOKS/i);
  });

  test("all five provider chat routes reject client cwd and use server project identity", async () => {
    for (const provider of ["codex", "claude", "hermes", "openclaw", "antigravity"]) {
      const source = await readFile(path.join(process.cwd(), `src/app/api/${provider}/chat/route.ts`), "utf8");
      expect(source).toContain("client-supplied cwd is not accepted");
      expect(source).toContain("resolveRegisteredProjectLaunchDirectory");
      expect(source).not.toMatch(/runCwd\s*=\s*typeof cwd|cwd\s*=\s*body\.cwd/);
    }
  });

  test("provider clients send project ids instead of absolute cwd", async () => {
    for (const relativePath of [
      "src/components/UnifiedChat.tsx",
      "src/components/desktop/useClaudeDesktopData.ts",
      "src/components/desktop/useHermesDesktopData.ts",
      "src/components/official-agent-ui/OpenClawOfficialView.tsx",
      "src/components/official-agent-ui/AntigravityOfficialView.tsx",
    ]) {
      const source = await readFile(path.join(process.cwd(), relativePath), "utf8");
      expect(source).not.toMatch(/cwd:\s*(workspaceProject|activeGroup|group\?|activeRoot|selectedProject)/);
    }
  });

  test("Claude and Antigravity bypasses are denied", async () => {
    expectIdentityError(
      () => assertProviderExecutionArguments("claude", ["--dangerously-skip-permissions"]),
      "forbidden_provider_flag",
    );
    expectIdentityError(
      () => assertProviderExecutionArguments("antigravity", ["--dangerously-skip-permissions=true"]),
      "forbidden_provider_flag",
    );
    const antigravityRoute = await readFile(path.join(process.cwd(), "src/app/api/antigravity/chat/route.ts"), "utf8");
    expect(antigravityRoute).not.toMatch(/args\.push\(["']--dangerously-skip-permissions/);
  });

  test("ambiguous PATH resolution fails closed", async () => {
    const scratch = path.join(os.tmpdir(), `agent-os-executable-collision-${process.pid}-${Date.now()}`);
    const first = path.join(scratch, "first");
    const second = path.join(scratch, "second");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const executableName = process.platform === "win32" ? "hermes.cmd" : "hermes";
    await writeFile(path.join(first, executableName), "first", "utf8");
    await writeFile(path.join(second, executableName), "second", "utf8");
    try {
      await expect(resolveExecutablePath("hermes", {
        pathValue: `${first}${path.delimiter}${second}`,
        pathExtensions: ".CMD",
        platform: process.platform,
      })).rejects.toMatchObject({ code: "executable_collision" });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("a pinned executable change invalidates subsequent launches", async () => {
    const scratch = path.join(os.tmpdir(), `agent-os-executable-change-${process.pid}-${Date.now()}`);
    const executable = path.join(scratch, process.platform === "win32" ? "provider.exe" : "provider");
    await mkdir(scratch, { recursive: true });
    await writeFile(executable, "version one", "utf8");
    const options = { versionReader: async () => "provider 1.0.0" };
    try {
      const pinned = await assertPinnedExecutableIdentity("hermes", executable, options);
      expect(pinned.absolutePath).toBe(path.resolve(executable));
      expect(pinned.version).toBe("provider 1.0.0");
      expect(pinned.sha256).toMatch(/^[a-f0-9]{64}$/);

      await writeFile(executable, "version two changed", "utf8");
      await expect(assertPinnedExecutableIdentity("hermes", executable, options))
        .rejects.toMatchObject({ code: "executable_identity_changed" });
      await expect(assertPinnedExecutableIdentity("hermes", executable, options))
        .rejects.toMatchObject({ code: "executable_identity_invalidated" });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("manual invalidation denies a previously verified provider", async () => {
    const scratch = path.join(os.tmpdir(), `agent-os-executable-invalidate-${process.pid}-${Date.now()}`);
    const executable = path.join(scratch, process.platform === "win32" ? "provider.exe" : "provider");
    await mkdir(scratch, { recursive: true });
    await writeFile(executable, "provider", "utf8");
    try {
      await assertPinnedExecutableIdentity("codex", executable, { versionReader: async () => "provider 1.0.0" });
      invalidateExecutableIdentity("codex");
      await expect(assertPinnedExecutableIdentity("codex", executable, { versionReader: async () => "provider 1.0.0" }))
        .rejects.toMatchObject({ code: "executable_identity_invalidated" });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
