import "server-only";

import { assertControlPlaneIdentity, type ControlPlaneIdentity } from "../../control-plane/identity";
import { CLAUDE_MODEL, config } from "../../config";
import {
  WORKBENCH_ADAPTER_API_VERSION,
  WORKBENCH_CAPABILITY_SCHEMA_VERSION,
} from "../adapterContract";
import {
  DurableExecutionError,
  type DurableCommand,
} from "../durableWorker";
import { createRunIdempotencyBinding } from "../idempotency";
import type {
  WindowsJobExecutionSpec,
  WindowsJobExecutionSpecResolver,
} from "../windowsJobExecutionDriver";
import type { WorkbenchProvider } from "../types";
import {
  CODEX_RESTRICTED_EXECUTION_CONTRACT,
  createCodexRestrictedExecutionSpecResolver,
} from "./codex";
import { createClaudeRestrictedExecutionSpecResolver } from "./claude";

const CANONICAL_PAYLOAD_KEYS = new Set([
  "schemaVersion",
  "operation",
  "prompt",
  "context",
  "options",
  "commandIdentity",
  "toolPolicy",
  "resources",
  "maxAttempts",
]);
const PREFLIGHT_VALIDITY_MS = 30_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const FORBIDDEN_PROVIDER_ENVIRONMENT = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|WORKBENCH|OPENAI|ANTHROPIC|AZURE|OPENROUTER)/iu;

interface CanonicalRestrictedPayload {
  operation: "start" | "resume";
  prompt: string;
  context: {
    agentId: string;
    actorId: string | null;
    projectId: string;
    sessionId: string | null;
    environment: string;
  };
  commandIdentity: ControlPlaneIdentity;
  toolPolicy: "disabled" | "provider-native-restricted";
}

let codexResolver: WindowsJobExecutionSpecResolver | null = null;
let claudeResolver: WindowsJobExecutionSpecResolver | null = null;

function fail(
  failureClass: ConstructorParameters<typeof DurableExecutionError>[0]["failureClass"],
  message: string,
): never {
  throw new DurableExecutionError({ failureClass, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function parseCanonicalPayload(command: DurableCommand): CanonicalRestrictedPayload {
  if (command.provider !== "codex" && command.provider !== "claude") {
    fail("unsupported", "Only Codex and Claude are supported by the restricted pilot resolver.");
  }
  if (command.operation !== "start" && command.operation !== "resume") {
    fail("unsupported", "Restricted pilot provider resolvers accept only start and resume commands.");
  }
  if (!isRecord(command.payload) || Object.keys(command.payload).some((key) => !CANONICAL_PAYLOAD_KEYS.has(key))) {
    fail("invalid_request", "Restricted pilot command payload is not canonical.");
  }
  if (command.payload.schemaVersion !== 1 || command.payload.operation !== command.operation) {
    fail("identity", "Restricted pilot command operation does not match its durable envelope.");
  }
  if (typeof command.payload.prompt !== "string" || !command.payload.prompt.trim()) {
    fail("invalid_request", "Restricted pilot command prompt is missing.");
  }
  if (!isRecord(command.payload.context) || !isRecord(command.payload.commandIdentity)) {
    fail("identity", "Restricted pilot command identity context is missing.");
  }

  try {
    assertControlPlaneIdentity(command.payload.commandIdentity);
  } catch {
    fail("identity", "Restricted pilot command identity is not canonical.");
  }
  const identity = command.payload.commandIdentity as unknown as ControlPlaneIdentity;
  const context = command.payload.context;
  const options = command.payload.options;
  if (
    !isRecord(options)
    || Object.keys(options).length !== 3
    || options.model !== null
    || options.engine !== null
    || options.effort !== null
  ) {
    fail("policy", "Restricted pilot provider options must be the server-owned canonical defaults.");
  }
  const sessionId = nullableString(context.sessionId);
  if (
    typeof context.agentId !== "string"
    || nullableString(context.actorId) === undefined
    || nullableString(context.projectId) === undefined
    || sessionId === undefined
    || typeof context.environment !== "string"
  ) {
    fail("identity", "Restricted pilot command context is not canonical.");
  }
  const actorId = context.actorId as string | null;
  const projectId = context.projectId as string | null;
  const idempotencyPayload = {
    ...command.payload,
    commandIdentity: {
      actorId: identity.actorId,
      projectId: identity.projectId,
      worktreeId: identity.worktreeId,
      provider: identity.provider,
      profileId: identity.profileId,
      nativeSessionId: identity.nativeSessionId,
      runId: identity.runId,
    },
  };
  const durableBinding = createRunIdempotencyBinding({
    actorId,
    projectId,
    operation: command.operation,
    callerKey: identity.runId,
    payload: idempotencyPayload,
  });
  if (
    command.provider !== context.agentId
    || command.provider !== actorId
    || command.provider !== identity.provider
    || command.provider !== identity.actorId
    || !projectId
    || projectId !== identity.projectId
    || context.environment !== identity.worktreeId
    || sessionId !== identity.nativeSessionId
    || identity.profileId !== null
    || durableBinding.key !== command.idempotencyKey
  ) {
    fail("identity", "Restricted pilot provider, actor, project, worktree, session, profile, or admission-run binding does not match.");
  }
  const requiredPolicy = command.provider === "claude" ? "disabled" : "provider-native-restricted";
  if (command.payload.toolPolicy !== requiredPolicy) {
    fail("policy", "Restricted pilot command tool policy does not match its provider.");
  }
  if (command.operation === "resume" && !sessionId) {
    fail("identity", "Restricted pilot resume command is missing its native session binding.");
  }
  if (command.operation === "start" && command.provider === "codex" && sessionId !== null) {
    fail("identity", "Codex start cannot claim an existing native session.");
  }
  if (command.operation === "start" && command.provider === "claude" && !sessionId) {
    fail("identity", "Claude start is missing its server-assigned native session binding.");
  }

  return {
    operation: command.operation,
    prompt: command.payload.prompt,
    context: {
      agentId: context.agentId,
      actorId,
      projectId,
      sessionId,
      environment: context.environment,
    },
    commandIdentity: identity,
    toolPolicy: requiredPolicy,
  };
}

function providerCommand(command: DurableCommand, payload: Record<string, unknown>): DurableCommand {
  return { ...command, payload };
}

function configuredCodexResolver(): WindowsJobExecutionSpecResolver {
  if (!config.codex) fail("provider_unavailable", "Codex executable is not configured in Setup Center.");
  codexResolver ??= createCodexRestrictedExecutionSpecResolver({ configuredExecutable: config.codex });
  return codexResolver;
}

function configuredClaudeResolver(): WindowsJobExecutionSpecResolver {
  if (!config.claude) fail("provider_unavailable", "Claude executable is not configured in Setup Center.");
  claudeResolver ??= createClaudeRestrictedExecutionSpecResolver({
    configuredExecutable: config.claude,
    model: CLAUDE_MODEL,
  });
  return claudeResolver;
}

export interface RestrictedPilotResolverDependencies {
  codex: () => WindowsJobExecutionSpecResolver;
  claude: () => WindowsJobExecutionSpecResolver;
}

export interface RestrictedPilotAdmissionAttestation {
  schemaVersion: 1;
  provider: "codex" | "claude";
  operation: "start" | "resume";
  observedAt: string;
  validUntil: string;
  command: {
    callerSessionId: string;
    actorId: string;
    projectId: string;
    worktreeId: string;
    nativeSessionId: string | null;
    runId: string;
    explicitUserMutation: true;
  };
  containment: {
    approvedLaunchDirectory: true;
    windowsJobObjectRequired: true;
    directoryIdentity: string;
  };
  secretControls: {
    promptTransport: "stdin";
    minimalEnvironment: true;
    streamRedactionRequired: true;
  };
  approval: {
    kind: "explicit-run-request";
    commandBound: true;
    providerApprovalSurface: "disabled";
    toolPolicy: "disabled" | "provider-native-restricted";
  };
  executable: {
    schemaVersion: 2;
    provider: "codex" | "claude";
    sha256: string;
    version: string;
    observedAt: string;
  };
  capability: {
    adapterApiVersion: typeof WORKBENCH_ADAPTER_API_VERSION;
    capabilitySchemaVersion: typeof WORKBENCH_CAPABILITY_SCHEMA_VERSION;
    providerRestrictionsVerified: true;
    runtimeIdentityVerified: true;
  };
}

export interface RestrictedPilotPreflight {
  spec: WindowsJobExecutionSpec;
  attestation: RestrictedPilotAdmissionAttestation;
}

export type RestrictedPilotPreflightResolver = (
  command: DurableCommand,
  signal: AbortSignal,
) => Promise<RestrictedPilotPreflight>;

function hasArgument(args: readonly string[], value: string): boolean {
  return args.some((argument) => argument === value);
}

function hasPair(args: readonly string[], key: string, value: string): boolean {
  return args.some((argument, index) => argument === key && args[index + 1] === value);
}

export function assertRestrictedPilotExecutionSpec(
  provider: WorkbenchProvider,
  spec: WindowsJobExecutionSpec,
): void {
  if (
    !isRecord(spec)
    || !isRecord(spec.executableIdentity)
    || !isRecord(spec.cwd)
    || !isRecord(spec.env)
    || !Array.isArray(spec.args)
  ) {
    fail("identity", "Restricted pilot execution specification is incomplete.");
  }
  if (
    spec.provider !== provider
    || spec.executableIdentity.provider !== provider
    || spec.executableIdentity.schemaVersion !== 2
    || !SHA256_PATTERN.test(String(spec.executableIdentity.sha256))
    || typeof spec.executableIdentity.version !== "string"
    || !spec.executableIdentity.version.trim()
    || !Number.isFinite(Date.parse(String(spec.executableIdentity.observedAt)))
    || spec.cwd.provider !== provider
    || spec.cwd.schemaVersion !== 1
    || typeof spec.cwd.projectId !== "string"
    || !spec.cwd.projectId
    || typeof spec.cwd.absolutePath !== "string"
    || !spec.cwd.absolutePath
    || !Number.isFinite(spec.cwd.device)
    || !Number.isFinite(spec.cwd.inode)
    || !Number.isFinite(spec.cwd.modifiedMs)
  ) {
    fail("identity", "Restricted pilot execution identity does not match its provider.");
  }
  if (
    Object.entries(spec.env).some(([key, value]) => (
      FORBIDDEN_PROVIDER_ENVIRONMENT.test(key)
      || (value !== undefined && (typeof value !== "string" || value.includes("\0")))
    ))
  ) {
    fail("policy", "Restricted pilot child environment is not the verified minimal environment.");
  }
  if (provider === "claude") {
    if (
      !hasArgument(spec.args, "--safe-mode")
      || !hasArgument(spec.args, "--disable-slash-commands")
      || !hasArgument(spec.args, "--no-chrome")
      || !hasArgument(spec.args, "--strict-mcp-config")
      || !hasPair(spec.args, "--mcp-config", "{\"mcpServers\":{}}")
      || !hasPair(spec.args, "--tools", "")
      || !hasPair(spec.args, "--permission-mode", "dontAsk")
    ) {
      fail("policy", "Claude execution does not prove its no-tools policy.");
    }
    return;
  }
  if (provider === "codex") {
    const requiredFlags = ["--ignore-user-config", "--ignore-rules", "--strict-config", "--json", "--skip-git-repo-check"];
    if (
      requiredFlags.some((flag) => !hasArgument(spec.args, flag))
      || CODEX_RESTRICTED_EXECUTION_CONTRACT.requiredConfigOverrides.some(
        (override) => !hasPair(spec.args, "-c", override),
      )
    ) {
      fail("policy", "Codex execution does not prove its restricted native-tool allowlist.");
    }
    return;
  }
  fail("unsupported", "Only Codex and Claude are supported by the restricted pilot resolver.");
}

function createAdmissionAttestation(
  command: DurableCommand,
  canonical: CanonicalRestrictedPayload,
  spec: WindowsJobExecutionSpec,
  now: number,
): RestrictedPilotAdmissionAttestation {
  assertRestrictedPilotExecutionSpec(command.provider as WorkbenchProvider, spec);
  if (spec.input !== canonical.prompt || spec.cwd.projectId !== canonical.context.projectId) {
    fail("identity", "Restricted pilot execution specification is not bound to its admitted prompt and project.");
  }
  const observedAt = new Date(now).toISOString();
  const validUntil = new Date(now + PREFLIGHT_VALIDITY_MS).toISOString();
  const provider = command.provider as "codex" | "claude";
  return Object.freeze({
    schemaVersion: 1,
    provider,
    operation: canonical.operation,
    observedAt,
    validUntil,
    command: Object.freeze({
      callerSessionId: canonical.commandIdentity.callerSessionId,
      actorId: canonical.commandIdentity.actorId,
      projectId: canonical.commandIdentity.projectId,
      worktreeId: canonical.commandIdentity.worktreeId,
      nativeSessionId: canonical.commandIdentity.nativeSessionId,
      runId: canonical.commandIdentity.runId,
      explicitUserMutation: true,
    }),
    containment: Object.freeze({
      approvedLaunchDirectory: true,
      windowsJobObjectRequired: true,
      directoryIdentity: `${spec.cwd.device}:${spec.cwd.inode}:${spec.cwd.modifiedMs}`,
    }),
    secretControls: Object.freeze({
      promptTransport: "stdin",
      minimalEnvironment: true,
      streamRedactionRequired: true,
    }),
    approval: Object.freeze({
      kind: "explicit-run-request",
      commandBound: true,
      providerApprovalSurface: "disabled",
      toolPolicy: canonical.toolPolicy,
    }),
    executable: Object.freeze({
      schemaVersion: 2,
      provider,
      sha256: spec.executableIdentity.sha256,
      version: spec.executableIdentity.version,
      observedAt: spec.executableIdentity.observedAt,
    }),
    capability: Object.freeze({
      adapterApiVersion: WORKBENCH_ADAPTER_API_VERSION,
      capabilitySchemaVersion: WORKBENCH_CAPABILITY_SCHEMA_VERSION,
      providerRestrictionsVerified: true,
      runtimeIdentityVerified: true,
    }),
  });
}

export function createRestrictedPilotExecutionSpecResolver(
  dependencies: RestrictedPilotResolverDependencies,
): WindowsJobExecutionSpecResolver {
  return async (command: DurableCommand, signal: AbortSignal) => {
    const canonical = parseCanonicalPayload(command);
    if (command.provider === "codex") {
      const payload: Record<string, unknown> = {
        schemaVersion: 1,
        provider: "codex",
        operation: canonical.operation,
        prompt: canonical.prompt,
        projectId: canonical.context.projectId,
        ...(canonical.operation === "resume" ? { nativeSessionId: canonical.context.sessionId } : {}),
      };
      return dependencies.codex()(providerCommand(command, payload), signal);
    }
    const payload: Record<string, unknown> = canonical.operation === "start"
      ? {
          schemaVersion: 1,
          provider: "claude",
          operation: "start",
          prompt: canonical.prompt,
          projectId: canonical.context.projectId,
          newSessionId: canonical.context.sessionId,
        }
      : {
          schemaVersion: 1,
          provider: "claude",
          operation: "resume",
          prompt: canonical.prompt,
          projectId: canonical.context.projectId,
          nativeSessionId: canonical.context.sessionId,
        };
    return dependencies.claude()(providerCommand(command, payload), signal);
  };
}

export const resolveRestrictedPilotExecutionSpec = createRestrictedPilotExecutionSpecResolver({
  codex: configuredCodexResolver,
  claude: configuredClaudeResolver,
});

export function createRestrictedPilotPreflightResolver(
  executionResolver: WindowsJobExecutionSpecResolver,
  now: () => number = Date.now,
): RestrictedPilotPreflightResolver {
  return async (command: DurableCommand, signal: AbortSignal) => {
    const canonical = parseCanonicalPayload(command);
    const spec = await executionResolver(command, signal);
    return {
      spec,
      attestation: createAdmissionAttestation(command, canonical, spec, now()),
    };
  };
}

export const resolveRestrictedPilotPreflight = createRestrictedPilotPreflightResolver(
  resolveRestrictedPilotExecutionSpec,
);
