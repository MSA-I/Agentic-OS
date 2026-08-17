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

const CLAUDE_PROVIDER = "claude" as const;
const PAYLOAD_KEYS = new Set([
  "schemaVersion",
  "provider",
  "operation",
  "prompt",
  "projectId",
  "newSessionId",
  "nativeSessionId",
]);
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_.:@/-]{1,240}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MIN_PROMPT_BYTES = 1;
const MAX_PROMPT_BYTES = 32 * 1024;

const REQUIRED_RESTRICTION_ARGS = Object.freeze([
  "--safe-mode",
  "--disable-slash-commands",
  "--no-chrome",
  "--strict-mcp-config",
  "--mcp-config",
  "{\"mcpServers\":{}}",
  "--tools",
  "",
  "--permission-mode",
  "dontAsk",
] as const);

export type ClaudeRestrictedOperation = "start" | "resume";

export interface ClaudeRestrictedExecutionPayload {
  schemaVersion: 1;
  provider: "claude";
  operation: ClaudeRestrictedOperation;
  prompt: string;
  projectId: string;
  newSessionId?: string;
  nativeSessionId?: string;
}

export interface ClaudeRestrictedAdapterDependencies {
  resolveProjectLaunchDirectory(
    provider: "claude",
    projectId: string,
  ): Promise<ApprovedLaunchDirectory>;
  verifyExecutableIdentity(
    provider: "claude",
    configuredExecutable: string,
    args: readonly string[],
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<ExecutableIdentity>;
  buildChildEnvironment(
    provider: "claude",
    base: Readonly<Record<string, string | undefined>>,
  ): NodeJS.ProcessEnv;
}

export interface ClaudeRestrictedExecutionAdapterOptions {
  /** Server-owned executable configuration. Client payloads never select it. */
  configuredExecutable: string;
  /** Server-owned model configuration. Client payloads never select it. */
  model: string;
  baseEnvironment?: Readonly<Record<string, string | undefined>>;
  dependencies?: Partial<ClaudeRestrictedAdapterDependencies>;
}

export const CLAUDE_RESTRICTED_EXECUTION_CONTRACT = Object.freeze({
  schemaVersion: 1,
  provider: CLAUDE_PROVIDER,
  evidenceLevel: "fake-runtime",
  operations: Object.freeze(["start", "resume"] as const),
  promptTransport: "stdin",
  providerNativeTools: "disabled",
  toolGateway: "blocked-until-wave-4",
  requiredRestrictionArgs: REQUIRED_RESTRICTION_ARGS,
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
    fail("cancelled", "Claude execution specification resolution was cancelled.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(
  value: unknown,
  message: string,
): string {
  if (typeof value !== "string") fail("invalid_request", message);
  return value;
}

function validateSessionId(value: unknown): string {
  const sessionId = requiredString(value, "Claude execution requires a valid native session identifier.");
  if (!UUID_PATTERN.test(sessionId)) {
    fail("invalid_request", "Claude execution requires a valid native session identifier.");
  }
  return sessionId;
}

function parsePayload(command: DurableCommand): ClaudeRestrictedExecutionPayload {
  if (command.provider !== CLAUDE_PROVIDER) {
    fail("identity", "Claude execution resolver received a command for a different provider.");
  }
  if (command.operation !== "start" && command.operation !== "resume") {
    fail("unsupported", "Claude restricted execution supports only start and resume commands.");
  }
  if (!isRecord(command.payload)) {
    fail("invalid_request", "Claude execution payload must be a JSON object.");
  }
  if (Object.keys(command.payload).some((key) => !PAYLOAD_KEYS.has(key))) {
    fail("invalid_request", "Claude execution payload contains unsupported fields.");
  }
  if (command.payload.schemaVersion !== 1) {
    fail("invalid_request", "Claude execution payload schema is unsupported.");
  }
  if (command.payload.provider !== CLAUDE_PROVIDER) {
    fail("identity", "Claude execution payload provider does not match the resolver.");
  }
  if (command.payload.operation !== command.operation) {
    fail("identity", "Claude execution payload operation does not match the durable command.");
  }

  const prompt = requiredString(
    command.payload.prompt,
    "Claude execution requires a non-empty prompt within the configured byte limit.",
  );
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (
    prompt.trim().length === 0
    || prompt.includes("\0")
    || promptBytes < MIN_PROMPT_BYTES
    || promptBytes > MAX_PROMPT_BYTES
  ) {
    fail("invalid_request", "Claude execution requires a non-empty prompt within the configured byte limit.");
  }

  const projectId = requiredString(
    command.payload.projectId,
    "Claude execution requires a valid registered project identifier.",
  );
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    fail("invalid_request", "Claude execution requires a valid registered project identifier.");
  }

  if (command.operation === "start") {
    if (command.payload.nativeSessionId !== undefined) {
      fail("invalid_request", "Claude start cannot target an existing native session.");
    }
    return {
      schemaVersion: 1,
      provider: CLAUDE_PROVIDER,
      operation: "start",
      prompt,
      projectId,
      newSessionId: validateSessionId(command.payload.newSessionId),
    };
  }

  if (command.payload.newSessionId !== undefined) {
    fail("invalid_request", "Claude resume cannot allocate a new native session.");
  }
  return {
    schemaVersion: 1,
    provider: CLAUDE_PROVIDER,
    operation: "resume",
    prompt,
    projectId,
    nativeSessionId: validateSessionId(command.payload.nativeSessionId),
  };
}

function buildArguments(payload: ClaudeRestrictedExecutionPayload, model: string): readonly string[] {
  const sessionId = payload.operation === "start"
    ? payload.newSessionId
    : payload.nativeSessionId;
  if (!sessionId) {
    fail("invalid_request", "Claude execution requires a valid native session identifier.");
  }
  const sessionFlag = payload.operation === "start" ? "--session-id" : "--resume";
  return Object.freeze([
    "-p",
    "--model",
    model,
    "--safe-mode",
    "--disable-slash-commands",
    "--no-chrome",
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    sessionFlag,
    sessionId,
    "--input-format=text",
    "--output-format=stream-json",
    "--include-partial-messages",
    "--verbose",
  ]);
}

async function defaultProjectResolver(
  provider: "claude",
  projectId: string,
): Promise<ApprovedLaunchDirectory> {
  const { resolveRegisteredProjectLaunchDirectory } = await import("../../control-plane/projectRegistry");
  return resolveRegisteredProjectLaunchDirectory(provider, projectId);
}

function validateServerConfiguration(options: ClaudeRestrictedExecutionAdapterOptions): void {
  if (
    typeof options.configuredExecutable !== "string"
    || options.configuredExecutable.trim().length === 0
    || options.configuredExecutable.includes("\0")
  ) {
    fail("identity", "Claude executable configuration is missing or invalid.");
  }
  if (typeof options.model !== "string" || !MODEL_PATTERN.test(options.model)) {
    fail("identity", "Claude model configuration is missing or invalid.");
  }
}

/**
 * Wave 3 start/resume resolver for WindowsJobExecutionDriver.
 *
 * Prompt bytes travel only through WindowsJobExecutionSpec.input. The resolver
 * rejects control operations; cancellation remains owned by the driver's
 * verified Windows Job Object path.
 */
export function createClaudeRestrictedExecutionSpecResolver(
  options: ClaudeRestrictedExecutionAdapterOptions,
): WindowsJobExecutionSpecResolver {
  validateServerConfiguration(options);
  const dependencies: ClaudeRestrictedAdapterDependencies = {
    resolveProjectLaunchDirectory:
      options.dependencies?.resolveProjectLaunchDirectory ?? defaultProjectResolver,
    verifyExecutableIdentity:
      options.dependencies?.verifyExecutableIdentity ?? assertProviderLaunch,
    buildChildEnvironment:
      options.dependencies?.buildChildEnvironment ?? buildProviderChildEnvironment,
  };
  const baseEnvironment = options.baseEnvironment ?? process.env;

  return async function resolveClaudeRestrictedExecutionSpec(
    command: DurableCommand,
    signal: AbortSignal,
  ): Promise<WindowsJobExecutionSpec> {
    throwIfAborted(signal);
    const payload = parsePayload(command);
    const args = buildArguments(payload, options.model);

    let cwd: ApprovedLaunchDirectory;
    try {
      cwd = await dependencies.resolveProjectLaunchDirectory(CLAUDE_PROVIDER, payload.projectId);
    } catch {
      throwIfAborted(signal);
      fail("containment", "Claude project is not an approved launch target.");
    }
    throwIfAborted(signal);
    if (cwd.provider !== CLAUDE_PROVIDER || cwd.projectId !== payload.projectId) {
      fail("identity", "Claude project resolution returned a mismatched launch identity.");
    }

    let environment: NodeJS.ProcessEnv;
    try {
      const candidateEnvironment = dependencies.buildChildEnvironment(
        CLAUDE_PROVIDER,
        baseEnvironment,
      );
      environment = buildProviderChildEnvironment(
        CLAUDE_PROVIDER,
        {},
        candidateEnvironment,
      );
    } catch {
      fail("policy", "Claude child environment could not be constructed from the provider allowlist.");
    }

    let executableIdentity: ExecutableIdentity;
    try {
      executableIdentity = await dependencies.verifyExecutableIdentity(
        CLAUDE_PROVIDER,
        options.configuredExecutable,
        args,
        environment,
      );
    } catch {
      throwIfAborted(signal);
      fail("identity", "Claude executable identity could not be verified.");
    }
    throwIfAborted(signal);
    if (executableIdentity.provider !== CLAUDE_PROVIDER) {
      fail("identity", "Claude executable verification returned a mismatched provider identity.");
    }

    return {
      provider: CLAUDE_PROVIDER,
      executableIdentity,
      args,
      cwd,
      env: environment,
      input: payload.prompt,
    };
  };
}
