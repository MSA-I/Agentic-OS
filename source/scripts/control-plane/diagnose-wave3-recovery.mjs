import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = process.cwd();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript," };
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
  captureWindowsJobLauncherIdentitySync,
  prepareWindowsJobRecoveryDescriptor,
} = await import("../../src/lib/control-plane/windowsJobProcess.ts");
const envFile = readFileSync(path.join(sourceRoot, ".env.local"), "utf8");
const rootMatch = envFile.match(/^AGENTIC_OS_FOLDERS_ROOT=(.*)$/mu);
const foldersRoot = rootMatch
  ? rootMatch[1].trim().replace(/^['"]|['"]$/gu, "")
  : path.join(process.env.USERPROFILE ?? "", ".agentic-os", "folders");
const recoveryRoot = path.join(foldersRoot, "AGENT_OS", "control-plane", "windows-job-recovery");
mkdirSync(recoveryRoot, { recursive: true });

function safeCause(error) {
  if (!error || typeof error !== "object") return { name: typeof error, message: String(error) };
  return {
    name: error.name,
    code: error.code,
    message: error.message,
    cause: error.cause ? safeCause(error.cause) : undefined,
  };
}

function helperEnvironment(extra = {}) {
  const keys = ["COMSPEC", "PATH", "PATHEXT", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR"];
  const result = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return { ...result, ...extra };
}

function safeSpawnResult(result) {
  return {
    status: result.status,
    signal: result.signal,
    error: result.error ? { code: result.error.code, message: result.error.message } : undefined,
    stdout: String(result.stdout ?? "").slice(0, 8_192),
    stderr: String(result.stderr ?? "").slice(0, 8_192),
  };
}

function aclProbe() {
  const launcher = captureWindowsJobLauncherIdentitySync();
  const directory = mkdtempSync(path.join(recoveryRoot, "acl-probe-"));
  const aclScript = [
    "$ErrorActionPreference = 'Stop'",
    "$directory = [Environment]::GetEnvironmentVariable('AGENT_OS_RECOVERY_DIRECTORY')",
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$security = [Security.AccessControl.DirectorySecurity]::new()",
    "$security.SetOwner($identity)",
    "$security.SetAccessRuleProtection($true, $false)",
    "$rights = [Security.AccessControl.FileSystemRights]::FullControl",
    "$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
    "$rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)",
    "$null = $security.AddAccessRule($rule)",
    "[IO.Directory]::SetAccessControl($directory, $security)",
  ].join(";");
  const daclOnlyScript = [
    "$ErrorActionPreference = 'Stop'",
    "$directory = [Environment]::GetEnvironmentVariable('AGENT_OS_RECOVERY_DIRECTORY')",
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$security = [IO.Directory]::GetAccessControl($directory)",
    "$owner = ([Security.Principal.NTAccount] $security.Owner).Translate([Security.Principal.SecurityIdentifier])",
    "if ($owner.Value -ne $identity.Value) { throw 'Recovery directory owner does not match the current identity.' }",
    "$security.SetAccessRuleProtection($true, $false)",
    "$rules = @($security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
    "foreach ($existing in $rules) { $null = $security.RemoveAccessRuleSpecific($existing) }",
    "$rights = [Security.AccessControl.FileSystemRights]::FullControl",
    "$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
    "$rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)",
    "$null = $security.AddAccessRule($rule)",
    "[IO.Directory]::SetAccessControl($directory, $security)",
  ].join(";");
  const verifyScript = [
    "$ErrorActionPreference = 'Stop'",
    "$directory = [Environment]::GetEnvironmentVariable('AGENT_OS_RECOVERY_DIRECTORY')",
    "$acl = [IO.Directory]::GetAccessControl($directory)",
    "$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])",
    "[Console]::Out.Write((ConvertTo-Json -Compress -Depth 4 ([ordered]@{ Owner = $acl.Owner; Protected = $acl.AreAccessRulesProtected; Rules = @($rules | ForEach-Object { [ordered]@{ Identity = $_.IdentityReference.Value; Type = $_.AccessControlType.ToString(); Rights = $_.FileSystemRights.ToString(); Inherited = $_.IsInherited } }) })))",
  ].join(";");
  const env = helperEnvironment({ AGENT_OS_RECOVERY_DIRECTORY: directory });
  try {
    const harden = spawnSync(
      launcher.powershellPath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", aclScript],
      { env, encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    const daclOnly = spawnSync(
      launcher.powershellPath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", daclOnlyScript],
      { env, encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    const verify = spawnSync(
      launcher.powershellPath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", verifyScript],
      { env, encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    return {
      directory,
      launcher: launcher.powershellPath,
      harden: safeSpawnResult(harden),
      daclOnly: safeSpawnResult(daclOnly),
      verify: safeSpawnResult(verify),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const acl = aclProbe();

try {
  const descriptor = await prepareWindowsJobRecoveryDescriptor({
    runId: `diagnostic-${process.pid}`,
    jobId: `agent-os-diagnostic-${process.pid}`,
    recoveryRoot,
    outputLimitBytes: 1024,
    recoverySecret: randomBytes(32).toString("base64url"),
  });
  const descriptorPath = descriptor.descriptorPath;
  rmSync(descriptor.controlDirectory, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ ok: true, descriptorPath, cleaned: true, acl }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: safeCause(error), acl }));
  process.exitCode = 1;
}
