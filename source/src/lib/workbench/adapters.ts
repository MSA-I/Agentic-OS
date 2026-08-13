import "server-only";

import {
  listNativeAgentHistory,
  loadNativeAgentSession,
  type NativeHistoryGroup,
  type NativeLoadedSession,
  type NativeSessionRow,
} from "@/lib/nativeAgentHistory";
import { listNativeArtifacts } from "./nativeArtifacts";
import type {
  AdapterResult,
  AdapterRuntime,
  AgentCapabilities,
  AgentDescriptor,
  ApprovalDecision,
  ApprovalRequest,
  NativeArtifact,
  NativeSessionSummary,
  QueuedMessage,
  Run,
  WorkbenchAdapter,
  WorkbenchProvider,
  WorkContext,
} from "./types";

const EXECUTION_BRIDGE_REASON = "The native route still owns this runtime lifecycle; it has not been extracted into a shared supervisor service.";
const APPROVAL_BRIDGE_REASON = "This runtime does not expose an interactive approval bridge to Workbench.";

function capabilities(): AgentCapabilities {
  return {
    list: { status: "supported", detail: "Reads the provider's native session index in place." },
    load: { status: "supported", detail: "Reads the native transcript in place without copying it to Workbench SQLite." },
    start: { status: "unsupported", reason: EXECUTION_BRIDGE_REASON },
    resume: { status: "unsupported", reason: EXECUTION_BRIDGE_REASON },
    queue: {
      status: "supported",
      detail: "Messages are held durably until a native runtime bridge claims them.",
    },
    cancel: {
      status: "supported",
      detail: "Queued work and any registered local process can be cancelled.",
    },
    approval: { status: "unsupported", reason: APPROVAL_BRIDGE_REASON },
    artifacts: { status: "supported", detail: "Reads native workspace artifacts through the provider's existing filesystem service." },
  };
}

function unsupported<T>(operation: string, reason = EXECUTION_BRIDGE_REASON): AdapterResult<T> {
  return { ok: false, code: "unsupported", message: `${operation}: ${reason}` };
}

function identityActor(provider: WorkbenchProvider, group: NativeHistoryGroup, fallback: string | null): string | null {
  return provider === "hermes" || provider === "openclaw" ? group.scope ?? null : fallback;
}

function projectIdForGroup(provider: WorkbenchProvider, group: NativeHistoryGroup): string {
  if (/^[A-Za-z0-9_.:@/-]{1,240}$/.test(group.id)) return group.id;
  return `${provider}-native-${Buffer.from(group.id).toString("base64url").slice(0, 180)}`;
}

function groupMatchesProject(provider: WorkbenchProvider, group: NativeHistoryGroup, projectId: string): boolean {
  return [projectIdForGroup(provider, group), group.id, group.root, group.label].includes(projectId);
}

function summaryFromNative(
  provider: WorkbenchProvider,
  group: NativeHistoryGroup,
  session: NativeSessionRow,
  fallbackActor: string | null,
  loaded?: NativeLoadedSession,
): NativeSessionSummary {
  const updatedAt = session.mtime > 0 ? new Date(session.mtime).toISOString() : null;
  return {
    id: session.nativeId ?? session.id,
    actorId: identityActor(provider, group, fallbackActor),
    projectId: projectIdForGroup(provider, group),
    title: session.name || null,
    updatedAt,
    metadata: {
      nativePath: session.path,
      projectRoot: group.root,
      projectLabel: group.label,
      sessionKey: session.sessionKey,
      bytes: session.bytes,
      resumable: Boolean(session.resumable),
      source: session.source ?? "native",
      pinned: Boolean(session.pinned),
      preview: session.preview ?? null,
      ...(loaded ? { detail: loaded.detail } : {}),
    },
  };
}

/** Read-through adapter: native content stays in each provider's own store. */
class NativeReadThroughAdapter implements WorkbenchAdapter {
  readonly descriptor: AgentDescriptor;

  constructor(provider: WorkbenchProvider, label: string, runtime: string) {
    this.descriptor = {
      id: provider,
      provider,
      label,
      runtime,
      capabilities: capabilities(),
    };
  }

  async list(context: WorkContext): Promise<AdapterResult<NativeSessionSummary[]>> {
    try {
      const index = await listNativeAgentHistory(this.descriptor.provider);
      const summaries = index.groups.flatMap((group) => {
        const actorId = identityActor(this.descriptor.provider, group, context.actorId);
        if (context.actorId && (this.descriptor.provider === "hermes" || this.descriptor.provider === "openclaw") && actorId !== context.actorId) {
          return [];
        }
        if (context.projectId && !groupMatchesProject(this.descriptor.provider, group, context.projectId)) return [];
        return group.sessions.map((session) => summaryFromNative(
          this.descriptor.provider,
          group,
          session,
          context.actorId,
        ));
      });
      return { ok: true, value: summaries };
    } catch {
      return { ok: false, code: "failed", message: "Unable to read the native session index." };
    }
  }

  async load(sessionId: string, context: WorkContext): Promise<AdapterResult<NativeSessionSummary>> {
    try {
      const identityScoped = this.descriptor.provider === "hermes" || this.descriptor.provider === "openclaw";
      const loaded = await loadNativeAgentSession(this.descriptor.provider, sessionId, {
        actorId: identityScoped ? context.actorId : null,
      });
      if (!loaded) return { ok: false, code: "not_found", message: "Native session not found for the active actor." };
      if (context.projectId && !groupMatchesProject(this.descriptor.provider, loaded.group, context.projectId)) {
        return { ok: false, code: "not_found", message: "Native session not found for the active project." };
      }
      return {
        ok: true,
        value: summaryFromNative(
          this.descriptor.provider,
          loaded.group,
          loaded.session,
          context.actorId,
          loaded,
        ),
      };
    } catch {
      return { ok: false, code: "failed", message: "Unable to read the native session." };
    }
  }

  async start(_run: Run, _runtime: AdapterRuntime): Promise<AdapterResult<void>> {
    return unsupported("start");
  }

  async resume(_run: Run, _runtime: AdapterRuntime): Promise<AdapterResult<void>> {
    return unsupported("resume");
  }

  async queue(
    _run: Run,
    _message: QueuedMessage,
    _runtime: AdapterRuntime,
  ): Promise<AdapterResult<{ delivered: boolean }>> {
    return { ok: true, value: { delivered: false } };
  }

  async cancel(_run: Run, _runtime: AdapterRuntime): Promise<AdapterResult<void>> {
    return { ok: true, value: undefined };
  }

  async approve(
    _run: Run,
    _request: ApprovalRequest,
    _decision: ApprovalDecision,
    _runtime: AdapterRuntime,
  ): Promise<AdapterResult<void>> {
    return unsupported("approval", APPROVAL_BRIDGE_REASON);
  }

  async artifacts(run: Run): Promise<AdapterResult<NativeArtifact[]>> {
    try {
      return { ok: true, value: await listNativeArtifacts(this.descriptor.provider, run) };
    } catch {
      return { ok: false, code: "failed", message: "Unable to read native artifacts." };
    }
  }
}

const adapters = new Map<string, WorkbenchAdapter>([
  ["codex", new NativeReadThroughAdapter("codex", "Codex", "codex-cli")],
  ["claude", new NativeReadThroughAdapter("claude", "Claude", "claude-code")],
  ["hermes", new NativeReadThroughAdapter("hermes", "Hermes", "hermes-agent")],
  ["openclaw", new NativeReadThroughAdapter("openclaw", "OpenClaw", "openclaw")],
  ["antigravity", new NativeReadThroughAdapter("antigravity", "Antigravity", "antigravity")],
]);

export function registerWorkbenchAdapter(adapter: WorkbenchAdapter): void {
  adapters.set(adapter.descriptor.id, adapter);
}

export function getWorkbenchAdapter(id: string): WorkbenchAdapter | null {
  return adapters.get(id) ?? null;
}

export function listWorkbenchAgents(): AgentDescriptor[] {
  return [...adapters.values()].map((adapter) => adapter.descriptor);
}
