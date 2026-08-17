import {
  assertProviderLaunch,
  type ExecutableIdentity,
} from "../../control-plane/executableIdentity";
import { buildProviderChildEnvironment } from "../../control-plane/childEnvironment";
import type { ApprovedLaunchDirectory } from "../../control-plane/runtimeContainment";
import type { DurableCommand } from "../durableWorker";
import { DurableExecutionError, type RetryFailureClass } from "../retryPolicy";
import type {
  WindowsJobExecutionSpec,
  WindowsJobExecutionSpecResolver,
} from "../windowsJobExecutionDriver";

const CODEX_PROVIDER = "codex" as const;
const PAYLOAD_KEYS = new Set([
  "schemaVersion",
  "provider",
  "operation",
  "prompt",
  "projectId",
  "nativeSessionId",
]);
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_.:@/-]{1,240}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MIN_PROMPT_BYTES = 1;
const MAX_PROMPT_BYTES = 32 * 1024;

export const CODEX_VERIFIED_RUNTIME_VERSION = "codex-cli 0.144.6" as const;

const REQUIRED_CONFIG_OVERRIDES = Object.freeze([
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
] as const);

const REQUIRED_RESTRICTION_ARGS = Object.freeze([
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
  "--json",
  "--skip-git-repo-check",
  ...REQUIRED_CONFIG_OVERRIDES.flatMap((value) => ["-c", value]),
] as const);

const CODEX_CHILD_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NUMBER_OF_PROCESSORS",
  "NODE_ENV",
  "NO_COLOR",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "FORCE_COLOR",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "CODEX_HOME",
  "OPENAI_API_KEY",
]);

export type CodexRestrictedOperation = "start" | "resume";

export interface CodexRestrictedExecutionPayload {
  schemaVersion: 1;
  provider: "codex";
  operation: CodexRestrictedOperation;
  prompt: string;
  projectId: string;
  nativeSessionId?: string;
}

export interface CodexRestrictedAdapterDependencies {
  resolveProjectLaunchDirectory(
    provider: "codex",
    projectId: string,
  ): Promise<ApprovedLaunchDirectory>;
  verifyExecutableIdentity(
    provider: "codex",
    configuredExecutable: string,
    args: readonly string[],
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<ExecutableIdentity>;
  buildChildEnvironment(
    provider: "codex",
    base: Readonly<Record<string, string | undefined>>,
  ): NodeJS.ProcessEnv;
}

export interface CodexRestrictedExecutionAdapterOptions {
  /** Server-owned executable configuration. Client payloads never select it. */
  configuredExecutable: string;
  baseEnvironment?: Readonly<Record<string, string | undefined>>;
  dependencies?: Partial<CodexRestrictedAdapterDependencies>;
}

export const CODEX_RESTRICTED_EXECUTION_CONTRACT = Object.freeze({
  schemaVersion: 1,
  provider: CODEX_PROVIDER,
  evidenceLevel: "fake-runtime",
  operations: Object.freeze(["start", "resume"] as const),
  promptTransport: "stdin",
  toolPolicy: "provider-native-restricted",
  toolGateway: "blocked-until-wave-4",
  verifiedRuntimeVersion: CODEX_VERIFIED_RUNTIME_VERSION,
  requiredRestrictionArgs: REQUIRED_RESTRICTION_ARGS,
  requiredConfigOverrides: REQUIRED_CONFIG_OVERRIDES,
  cancellation: Object.freeze({
    owner: "WindowsJobExecutionDriver",
    resolverAcceptsControlOperations: false,
    completionRequirement: "ACTIVE_PROCESS_ZERO",
  }),
} as const);

function fail(failureClass: RetryFailureClass, message: string): never {
  throw new DurableExecutionError({ failureClass, message });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    fail(
      "cancelled",
      "Codex execution specification resolution was cancelled.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string") fail("invalid_request", message);
  return value;
}

function validateSessionId(value: unknown): string {
  const sessionId = requiredString(
    value,
    "Codex resume requires a valid native session identifier.",
  );
  if (!UUID_PATTERN.test(sessionId)) {
    fail(
      "invalid_request",
      "Codex resume requires a valid native session identifier.",
    );
  }
  return sessionId;
}

function parsePayload(
  command: DurableCommand,
): CodexRestrictedExecutionPayload {
  if (command.provider !== CODEX_PROVIDER) {
    fail(
      "identity",
      "Codex execution resolver received a command for a different provider.",
    );
  }
  if (command.operation !== "start" && command.operation !== "resume") {
    fail(
      "unsupported",
      "Codex restricted execution supports only start and resume commands.",
    );
  }
  if (!isRecord(command.payload)) {
    fail("invalid_request", "Codex execution payload must be a JSON object.");
  }
  if (Object.keys(command.payload).some((key) => !PAYLOAD_KEYS.has(key))) {
    fail(
      "invalid_request",
      "Codex execution payload contains unsupported fields.",
    );
  }
  if (command.payload.schemaVersion !== 1) {
    fail("invalid_request", "Codex execution payload schema is unsupported.");
  }
  if (command.payload.provider !== CODEX_PROVIDER) {
    fail(
      "identity",
      "Codex execution payload provider does not match the resolver.",
    );
  }
  if (command.payload.operation !== command.operation) {
    fail(
      "identity",
      "Codex execution payload operation does not match the durable command.",
    );
  }

  const prompt = requiredString(
    command.payload.prompt,
    "Codex execution requires a non-empty prompt within the configured byte limit.",
  );
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (
    prompt.trim().length === 0 ||
    prompt.includes("\0") ||
    promptBytes < MIN_PROMPT_BYTES ||
    promptBytes > MAX_PROMPT_BYTES
  ) {
    fail(
      "invalid_request",
      "Codex execution requires a non-empty prompt within the configured byte limit.",
    );
  }

  const projectId = requiredString(
    command.payload.projectId,
    "Codex execution requires a valid registered project identifier.",
  );
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    fail(
      "invalid_request",
      "Codex execution requires a valid registered project identifier.",
    );
  }

  if (command.operation === "start") {
    if (command.payload.nativeSessionId !== undefined) {
      fail(
        "invalid_request",
        "Codex start cannot target an existing native session.",
      );
    }
    return {
      schemaVersion: 1,
      provider: CODEX_PROVIDER,
      operation: "start",
      prompt,
      projectId,
    };
  }

  return {
    schemaVersion: 1,
    provider: CODEX_PROVIDER,
    operation: "resume",
    prompt,
    projectId,
    nativeSessionId: validateSessionId(command.payload.nativeSessionId),
  };
}

function buildArguments(
  payload: CodexRestrictedExecutionPayload,
): readonly string[] {
  const prefix = payload.operation === "start" ? ["exec"] : ["exec", "resume"];
  const suffix =
    payload.operation === "start" ? ["-"] : [payload.nativeSessionId!, "-"];
  return Object.freeze([...prefix, ...REQUIRED_RESTRICTION_ARGS, ...suffix]);
}

function restrictChildEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(environment)) {
    const key = rawKey.toUpperCase();
    if (!CODEX_CHILD_ENVIRONMENT_KEYS.has(key) || rawValue === undefined)
      continue;
    if (rawValue.includes("\0")) {
      fail(
        "policy",
        "Codex child environment contains an invalid allowlisted value.",
      );
    }
    result[key] = rawValue;
  }
  return result as NodeJS.ProcessEnv;
}

function validExecutableIdentity(identity: ExecutableIdentity): boolean {
  return (
    identity.schemaVersion === 2 &&
    identity.provider === CODEX_PROVIDER &&
    identity.version === CODEX_VERIFIED_RUNTIME_VERSION &&
    identity.absolutePath.trim().length > 0 &&
    identity.launchPath.trim().length > 0 &&
    SHA256_PATTERN.test(identity.sha256) &&
    identity.files.length > 0
  );
}

async function defaultProjectResolver(
  provider: "codex",
  projectId: string,
): Promise<ApprovedLaunchDirectory> {
  const { resolveRegisteredProjectLaunchDirectory } =
    await import("../../control-plane/projectRegistry");
  return resolveRegisteredProjectLaunchDirectory(provider, projectId);
}

function validateServerConfiguration(
  options: CodexRestrictedExecutionAdapterOptions,
): void {
  if (
    typeof options.configuredExecutable !== "string" ||
    options.configuredExecutable.trim().length === 0 ||
    options.configuredExecutable.includes("\0")
  ) {
    fail("identity", "Codex executable configuration is missing or invalid.");
  }
}

/**
 * Wave 3 start/resume resolver for WindowsJobExecutionDriver.
 *
 * Prompt bytes travel only through WindowsJobExecutionSpec.input. Client
 * payloads cannot select argv, cwd, environment, model, effort, tools, apps,
 * MCP servers or provider configuration. Cancellation remains owned by the
 * driver's verified Windows Job Object path.
 */
export function createCodexRestrictedExecutionSpecResolver(
  options: CodexRestrictedExecutionAdapterOptions,
): WindowsJobExecutionSpecResolver {
  validateServerConfiguration(options);
  const dependencies: CodexRestrictedAdapterDependencies = {
    resolveProjectLaunchDirectory:
      options.dependencies?.resolveProjectLaunchDirectory ??
      defaultProjectResolver,
    verifyExecutableIdentity:
      options.dependencies?.verifyExecutableIdentity ?? assertProviderLaunch,
    buildChildEnvironment:
      options.dependencies?.buildChildEnvironment ??
      buildProviderChildEnvironment,
  };
  const baseEnvironment = options.baseEnvironment ?? process.env;

  return async function resolveCodexRestrictedExecutionSpec(
    command: DurableCommand,
    signal: AbortSignal,
  ): Promise<WindowsJobExecutionSpec> {
    throwIfAborted(signal);
    const payload = parsePayload(command);
    const args = buildArguments(payload);

    let cwd: ApprovedLaunchDirectory;
    try {
      cwd = await dependencies.resolveProjectLaunchDirectory(
        CODEX_PROVIDER,
        payload.projectId,
      );
    } catch {
      throwIfAborted(signal);
      fail("containment", "Codex project is not an approved launch target.");
    }
    throwIfAborted(signal);
    if (
      cwd.schemaVersion !== 1 ||
      cwd.provider !== CODEX_PROVIDER ||
      cwd.projectId !== payload.projectId ||
      typeof cwd.absolutePath !== "string" ||
      cwd.absolutePath.trim().length === 0
    ) {
      fail(
        "identity",
        "Codex project resolution returned a mismatched launch identity.",
      );
    }

    let environment: NodeJS.ProcessEnv;
    try {
      environment = restrictChildEnvironment(
        dependencies.buildChildEnvironment(CODEX_PROVIDER, baseEnvironment),
      );
    } catch (error) {
      if (error instanceof DurableExecutionError) throw error;
      fail(
        "policy",
        "Codex child environment could not be constructed from the provider allowlist.",
      );
    }
    throwIfAborted(signal);

    let executableIdentity: ExecutableIdentity;
    try {
      executableIdentity = await dependencies.verifyExecutableIdentity(
        CODEX_PROVIDER,
        options.configuredExecutable,
        args,
        environment,
      );
    } catch {
      throwIfAborted(signal);
      fail("identity", "Codex executable identity could not be verified.");
    }
    throwIfAborted(signal);
    if (!validExecutableIdentity(executableIdentity)) {
      fail(
        "identity",
        `Codex runtime must match the verified ${CODEX_VERIFIED_RUNTIME_VERSION} execution policy.`,
      );
    }

    return {
      provider: CODEX_PROVIDER,
      executableIdentity,
      args,
      cwd,
      env: environment,
      input: payload.prompt,
    };
  };
}
