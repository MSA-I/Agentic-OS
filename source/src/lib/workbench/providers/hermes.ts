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
import { HERMES_SESSION_ID_PATTERN } from "./hermesStream";

const HERMES_PROVIDER = "hermes" as const;
const PAYLOAD_KEYS = new Set([
  "schemaVersion",
  "provider",
  "operation",
  "prompt",
  "projectId",
  "nativeSessionId",
]);
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_.:@/-]{1,240}$/u;
const MIN_PROMPT_BYTES = 1;

/**
 * Hermes takes its prompt as an argv value, and Windows caps a command line at
 * 32,767 characters. 24 KiB leaves room for the flags and for multi-byte text
 * without ever reaching that ceiling.
 */
const MAX_PROMPT_BYTES = 24 * 1024;

/**
 * The single toolset Hermes runs with.
 *
 * This is the load-bearing restriction. Hermes ships with `terminal`, `file`,
 * `code_execution` and `computer_use` enabled, and neither `--safe-mode` nor an
 * empty `-t` turns them off — both were measured against the installed CLI, and
 * in both cases it happily ran `echo` and reported the output. Naming exactly
 * one harmless toolset does work: asked to run a shell command under `-t
 * clarify`, it answers that no execution tool is connected.
 *
 * `clarify` is the least capable toolset available (it only lets the model ask
 * a clarifying question), and the planner needs no tools at all — it reads the
 * context it was given and writes a plan.
 */
const RESTRICTED_TOOLSET = "clarify";

/**
 * `--safe-mode` and `--ignore-user-config` are deliberately absent: both drop
 * the user's model configuration, and Hermes then fails with
 * `HTTP 400: No models provided`. `--ignore-rules` gives the isolation that
 * matters here — no AGENTS.md, no memory injection, no preloaded skills.
 */
export const HERMES_RESTRICTED_ARGS = Object.freeze([
  "chat",
  "-Q",
  "--ignore-rules",
  "-t",
  RESTRICTED_TOOLSET,
  "--max-turns",
  "1",
  "--source",
  "agent-os",
] as const);

export type HermesRestrictedOperation = "start" | "resume";

export interface HermesRestrictedExecutionPayload {
  schemaVersion: 1;
  provider: "hermes";
  operation: HermesRestrictedOperation;
  prompt: string;
  projectId: string;
  nativeSessionId?: string;
}

export interface HermesRestrictedAdapterDependencies {
  resolveProjectLaunchDirectory(
    provider: "hermes",
    projectId: string,
  ): Promise<ApprovedLaunchDirectory>;
  verifyExecutableIdentity(
    provider: "hermes",
    configuredExecutable: string,
    args: readonly string[],
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<ExecutableIdentity>;
  buildChildEnvironment(
    provider: "hermes",
    base: Readonly<Record<string, string | undefined>>,
  ): NodeJS.ProcessEnv;
}

export interface HermesRestrictedExecutionAdapterOptions {
  /** Server-owned executable configuration. Client payloads never select it. */
  configuredExecutable: string;
  baseEnvironment?: Readonly<Record<string, string | undefined>>;
  dependencies?: Partial<HermesRestrictedAdapterDependencies>;
}

export const HERMES_RESTRICTED_EXECUTION_CONTRACT = Object.freeze({
  schemaVersion: 1,
  provider: HERMES_PROVIDER,
  evidenceLevel: "fake-runtime",
  operations: Object.freeze(["start", "resume"] as const),
  /**
   * Unlike Claude and Codex, the prompt travels in argv. `hermes chat` has no
   * stdin prompt mode: without `-q` it opens an interactive session and exits
   * non-zero when stdin closes. The cost is that the prompt is visible in the
   * process list to anything already running as this user, so a Hermes prompt
   * must carry no secret — the Setup Center planner placeholders secret-shaped
   * lines before sending for exactly this reason.
   */
  promptTransport: "argv",
  providerNativeTools: "single-toolset",
  restrictedToolset: RESTRICTED_TOOLSET,
  toolGateway: "blocked-until-wave-4",
  requiredRestrictionArgs: HERMES_RESTRICTED_ARGS,
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
    fail("cancelled", "Hermes execution specification resolution was cancelled.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string") fail("invalid_request", message);
  return value;
}

function validateSessionId(value: unknown): string {
  const sessionId = requiredString(value, "Hermes execution requires a valid native session identifier.");
  if (!HERMES_SESSION_ID_PATTERN.test(sessionId)) {
    fail("invalid_request", "Hermes execution requires a valid native session identifier.");
  }
  return sessionId;
}

function parsePayload(command: DurableCommand): HermesRestrictedExecutionPayload {
  if (command.provider !== HERMES_PROVIDER) {
    fail("identity", "Hermes execution resolver received a command for a different provider.");
  }
  if (command.operation !== "start" && command.operation !== "resume") {
    fail("unsupported", "Hermes restricted execution supports only start and resume commands.");
  }
  if (!isRecord(command.payload)) {
    fail("invalid_request", "Hermes execution payload must be a JSON object.");
  }
  if (Object.keys(command.payload).some((key) => !PAYLOAD_KEYS.has(key))) {
    fail("invalid_request", "Hermes execution payload contains unsupported fields.");
  }
  if (command.payload.schemaVersion !== 1) {
    fail("invalid_request", "Hermes execution payload schema is unsupported.");
  }
  if (command.payload.provider !== HERMES_PROVIDER) {
    fail("identity", "Hermes execution payload provider does not match the resolver.");
  }
  if (command.payload.operation !== command.operation) {
    fail("identity", "Hermes execution payload operation does not match the durable command.");
  }

  const prompt = requiredString(
    command.payload.prompt,
    "Hermes execution requires a non-empty prompt within the configured byte limit.",
  );
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (
    prompt.trim().length === 0
    || prompt.includes("\0")
    || promptBytes < MIN_PROMPT_BYTES
    || promptBytes > MAX_PROMPT_BYTES
  ) {
    fail("invalid_request", "Hermes execution requires a non-empty prompt within the configured byte limit.");
  }

  const projectId = requiredString(
    command.payload.projectId,
    "Hermes execution requires a valid registered project identifier.",
  );
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    fail("invalid_request", "Hermes execution requires a valid registered project identifier.");
  }

  if (command.operation === "start") {
    if (command.payload.nativeSessionId !== undefined) {
      fail("invalid_request", "Hermes start cannot target an existing native session.");
    }
    // Hermes allocates its own session id and prints it on stderr, so start
    // carries none: the control plane binds what the process announces.
    return { schemaVersion: 1, provider: HERMES_PROVIDER, operation: "start", prompt, projectId };
  }

  return {
    schemaVersion: 1,
    provider: HERMES_PROVIDER,
    operation: "resume",
    prompt,
    projectId,
    nativeSessionId: validateSessionId(command.payload.nativeSessionId),
  };
}

function buildArguments(payload: HermesRestrictedExecutionPayload): readonly string[] {
  const resume = payload.operation === "resume" && payload.nativeSessionId
    ? ["--resume", payload.nativeSessionId]
    : [];
  // `-q` must come last so the prompt is unambiguously its value.
  return Object.freeze([...HERMES_RESTRICTED_ARGS, ...resume, "-q", payload.prompt]);
}

async function defaultProjectResolver(
  provider: "hermes",
  projectId: string,
): Promise<ApprovedLaunchDirectory> {
  const { resolveRegisteredProjectLaunchDirectory } = await import("../../control-plane/projectRegistry");
  return resolveRegisteredProjectLaunchDirectory(provider, projectId);
}

function validateServerConfiguration(options: HermesRestrictedExecutionAdapterOptions): void {
  if (
    typeof options.configuredExecutable !== "string"
    || options.configuredExecutable.trim().length === 0
    || options.configuredExecutable.includes("\0")
  ) {
    fail("identity", "Hermes executable configuration is missing or invalid.");
  }
}

/**
 * Wave 5 start/resume resolver for WindowsJobExecutionDriver.
 *
 * The model is not passed on the command line: it comes from the user's own
 * Hermes configuration, which is also why `--ignore-user-config` cannot be used
 * here. Cancellation stays owned by the driver's verified Windows Job path.
 */
export function createHermesRestrictedExecutionSpecResolver(
  options: HermesRestrictedExecutionAdapterOptions,
): WindowsJobExecutionSpecResolver {
  validateServerConfiguration(options);
  const dependencies: HermesRestrictedAdapterDependencies = {
    resolveProjectLaunchDirectory:
      options.dependencies?.resolveProjectLaunchDirectory ?? defaultProjectResolver,
    verifyExecutableIdentity:
      options.dependencies?.verifyExecutableIdentity ?? assertProviderLaunch,
    buildChildEnvironment:
      options.dependencies?.buildChildEnvironment ?? buildProviderChildEnvironment,
  };
  const baseEnvironment = options.baseEnvironment ?? process.env;

  return async function resolveHermesRestrictedExecutionSpec(
    command: DurableCommand,
    signal: AbortSignal,
  ): Promise<WindowsJobExecutionSpec> {
    throwIfAborted(signal);
    const payload = parsePayload(command);
    const args = buildArguments(payload);

    let cwd: ApprovedLaunchDirectory;
    try {
      cwd = await dependencies.resolveProjectLaunchDirectory(HERMES_PROVIDER, payload.projectId);
    } catch {
      throwIfAborted(signal);
      fail("containment", "Hermes project is not an approved launch target.");
    }
    throwIfAborted(signal);
    if (cwd.provider !== HERMES_PROVIDER || cwd.projectId !== payload.projectId) {
      fail("identity", "Hermes project resolution returned a mismatched launch identity.");
    }

    let environment: NodeJS.ProcessEnv;
    try {
      const candidateEnvironment = dependencies.buildChildEnvironment(HERMES_PROVIDER, baseEnvironment);
      environment = buildProviderChildEnvironment(HERMES_PROVIDER, {}, candidateEnvironment);
    } catch {
      fail("policy", "Hermes child environment could not be constructed from the provider allowlist.");
    }

    let executableIdentity: ExecutableIdentity;
    try {
      executableIdentity = await dependencies.verifyExecutableIdentity(
        HERMES_PROVIDER,
        options.configuredExecutable,
        args,
        environment,
      );
    } catch {
      throwIfAborted(signal);
      fail("identity", "Hermes executable identity could not be verified.");
    }
    throwIfAborted(signal);
    if (executableIdentity.provider !== HERMES_PROVIDER) {
      fail("identity", "Hermes executable verification returned a mismatched provider identity.");
    }

    return {
      provider: HERMES_PROVIDER,
      executableIdentity,
      args,
      cwd,
      env: environment,
      // The prompt is in argv; stdin stays empty so the process sees EOF at once
      // rather than waiting on a channel Hermes never reads in this mode.
      input: "",
    };
  };
}
