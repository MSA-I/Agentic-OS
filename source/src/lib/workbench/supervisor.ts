import "server-only";

import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { getWorkbenchAdapter, listWorkbenchAgents } from "./adapters";
import { WorkbenchStore, type CreateRunInput, type ListRunsInput } from "./store";
import type {
  AdapterResult,
  AdapterRuntime,
  AgentDescriptor,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRisk,
  MessageMode,
  QueuedMessage,
  Run,
  RunError,
  RunEvent,
  RunEventType,
  RunStatus,
} from "./types";

const TERMINAL_STATUSES = new Set<RunStatus>(["succeeded", "failed", "cancelled", "orphaned"]);

export class WorkbenchConflictError extends Error {}
export class WorkbenchNotFoundError extends Error {}
export class WorkbenchUnsupportedError extends Error {}

interface ManagedProcess {
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout> | null;
}

async function terminateProcessTree(pid: number, child?: ChildProcess): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { child?.kill("SIGTERM"); } catch { /* process already exited */ }
  }
}

export class RunSupervisor {
  private readonly events = new EventEmitter();
  private readonly processes = new Map<string, ManagedProcess>();

  constructor(readonly store = new WorkbenchStore()) {
    this.events.setMaxListeners(0);
    for (const run of this.store.orphanActiveRuns()) {
      this.publish(run.id, "error", {
        code: "supervisor_restarted",
        message: "The server restarted while this run was active; native state was not guessed.",
      });
      this.publish(run.id, "status", { status: "orphaned" });
    }
  }

  agents(): AgentDescriptor[] {
    return listWorkbenchAgents();
  }

  get(runId: string): Run | null {
    return this.store.getRun(runId);
  }

  list(input: ListRunsInput = {}): Run[] {
    return this.store.listRuns(input);
  }

  async create(input: CreateRunInput): Promise<{ run: Run; start: AdapterResult<void> }> {
    const adapter = getWorkbenchAdapter(input.adapterId);
    if (!adapter || adapter.descriptor.provider !== input.provider) {
      throw new WorkbenchNotFoundError("Unknown or mismatched Workbench adapter.");
    }

    if ((input.provider === "hermes" || input.provider === "openclaw") && input.context.sessionId) {
      const boundActor = this.store.sessionActor(input.provider, input.context.sessionId);
      if (boundActor !== undefined && boundActor !== input.context.actorId) {
        throw new WorkbenchConflictError("This native session is already bound to a different actor.");
      }
    }

    let run = this.store.createRun(input);
    this.publish(run.id, "status", { status: "queued", adapterId: adapter.descriptor.id });
    const runtime = this.runtimeFor(run.id);
    const result = input.context.sessionId
      ? await adapter.resume(run, runtime)
      : await adapter.start(run, runtime);
    if (!result.ok) {
      this.publish(run.id, "status", {
        status: "queued",
        operation: input.context.sessionId ? "resume" : "start",
        availability: result.code,
        detail: result.message,
      });
    }
    run = this.requireRun(run.id);
    return { run, start: result };
  }

  async message(runId: string, mode: MessageMode, content: string): Promise<{
    run: Run;
    message: QueuedMessage;
    delivery: "queued" | "delivered";
  }> {
    const run = this.requireRun(runId);
    if (TERMINAL_STATUSES.has(run.status)) throw new WorkbenchConflictError("Cannot message a finished run.");
    if (mode === "steer" && run.status !== "running" && run.status !== "awaiting_approval") {
      throw new WorkbenchConflictError("Steer is available only while a run is active.");
    }
    const adapter = this.requireAdapter(run.adapterId);
    const message = this.store.enqueueMessage(run.id, mode, content);
    const result = await adapter.queue(run, message, this.runtimeFor(run.id));
    if (!result.ok) {
      throw new WorkbenchUnsupportedError(result.message);
    }
    const delivered = result.value.delivered;
    const persisted = delivered ? this.store.markMessageDelivered(message.id) ?? message : message;
    this.publish(run.id, "message", {
      messageId: message.id,
      role: "user",
      mode,
      characterCount: message.content.length,
      delivery: delivered ? "delivered" : "queued",
    });
    return { run: this.requireRun(run.id), message: persisted, delivery: delivered ? "delivered" : "queued" };
  }

  async cancel(runId: string): Promise<Run> {
    const run = this.requireRun(runId);
    if (TERMINAL_STATUSES.has(run.status)) return run;
    const managed = this.processes.get(run.id);
    const pid = managed?.child.pid ?? run.pid;
    if (managed?.timer) clearTimeout(managed.timer);
    if (pid) await terminateProcessTree(pid, managed?.child);
    this.processes.delete(run.id);

    const adapter = this.requireAdapter(run.adapterId);
    const result = await adapter.cancel(run, this.runtimeFor(run.id));
    if (!result.ok && result.code !== "unsupported") throw new WorkbenchConflictError(result.message);
    return this.setStatus(run.id, "cancelled", null);
  }

  requestApproval(runId: string, risk: ApprovalRisk, summary: string, redactedAction: string): ApprovalRequest {
    const run = this.requireRun(runId);
    if (TERMINAL_STATUSES.has(run.status)) throw new WorkbenchConflictError("Cannot approve a finished run.");
    const approval = this.store.createApproval(run.id, risk, summary, redactedAction);
    this.setStatus(run.id, "awaiting_approval");
    this.publish(run.id, "tool", {
      approvalId: approval.id,
      state: "attention",
      risk: approval.risk,
      summary: approval.summary,
      redactedAction: approval.redactedAction,
    });
    return approval;
  }

  async decideApproval(runId: string, approvalId: string, decision: ApprovalDecision): Promise<ApprovalRequest> {
    const run = this.requireRun(runId);
    const approval = this.store.getApproval(approvalId);
    if (!approval || approval.runId !== run.id) throw new WorkbenchNotFoundError("Approval request not found.");
    if (approval.status !== "pending") throw new WorkbenchConflictError("Approval request was already resolved.");
    const adapter = this.requireAdapter(run.adapterId);
    const result = await adapter.approve(run, approval, decision, this.runtimeFor(run.id));
    if (!result.ok) throw new WorkbenchUnsupportedError(result.message);
    const resolved = this.store.resolveApproval(approval.id, decision);
    if (!resolved) throw new WorkbenchConflictError("Approval request was already resolved.");
    this.publish(run.id, "tool", { approvalId, state: "resolved", decision });
    return resolved;
  }

  registerProcess(runId: string, child: ChildProcess, timeoutMs = 10 * 60_000): Run {
    const run = this.requireRun(runId);
    if (!child.pid) throw new WorkbenchConflictError("Cannot supervise a process without a PID.");
    if (this.processes.has(runId)) throw new WorkbenchConflictError("A process is already registered for this run.");

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          this.publish(runId, "error", { code: "timeout", message: "The run exceeded its time limit." });
          void terminateProcessTree(child.pid!, child).finally(() => {
            if (!TERMINAL_STATUSES.has(this.requireRun(runId).status)) {
              this.setStatus(runId, "failed", { code: "timeout", message: "The run exceeded its time limit." });
            }
          });
        }, timeoutMs)
      : null;
    timer?.unref?.();
    this.processes.set(runId, { child, timer });
    child.once("error", (error) => this.finishProcess(runId, "failed", {
      code: "process_error",
      message: error.message,
    }));
    child.once("close", (code, signal) => {
      const current = this.get(runId);
      if (!current || TERMINAL_STATUSES.has(current.status)) return this.clearProcess(runId);
      this.finishProcess(runId, code === 0 ? "succeeded" : "failed", code === 0 ? null : {
        code: "process_exit",
        message: `Native process exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`,
      });
    });
    return this.setRunProcess(run, child.pid);
  }

  subscribe(runId: string, after: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
    this.requireRun(runId);
    const encoder = new TextEncoder();
    const eventName = `run:${runId}`;
    let cleanup: (() => void) | null = null;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        let cursor = Math.max(0, after);
        const close = () => {
          if (closed) return;
          closed = true;
          cleanup?.();
          try { controller.close(); } catch { /* client disconnected */ }
        };
        const send = (event: RunEvent) => {
          if (closed || event.sequence <= cursor) return;
          cursor = event.sequence;
          controller.enqueue(encoder.encode(
            `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ));
          const status = event.type === "status" ? event.payload.status : null;
          if (typeof status === "string" && TERMINAL_STATUSES.has(status as RunStatus)) close();
        };
        const heartbeat = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
        }, 15_000);
        heartbeat.unref?.();
        const onAbort = () => close();
        cleanup = () => {
          clearInterval(heartbeat);
          this.events.off(eventName, send);
          signal?.removeEventListener("abort", onAbort);
        };
        this.events.on(eventName, send);
        signal?.addEventListener("abort", onAbort, { once: true });
        for (const event of this.store.eventsAfter(runId, cursor)) send(event);
      },
      cancel: () => cleanup?.(),
    });
  }

  private runtimeFor(runId: string): AdapterRuntime {
    return {
      emit: (type, payload) => this.publish(runId, type, payload),
      setStatus: (status, error) => this.setStatus(runId, status, error),
    };
  }

  private publish(runId: string, type: RunEventType, payload: Record<string, unknown>): RunEvent {
    const event = this.store.appendEvent(runId, type, payload);
    this.events.emit(`run:${runId}`, event);
    return event;
  }

  private setRunProcess(run: Run, pid: number): Run {
    const startedAt = run.startedAt ?? new Date().toISOString();
    const updated = this.store.updateRun(run.id, { status: "running", pid, startedAt, error: null })!;
    this.publish(run.id, "status", { status: "running", pid });
    return updated;
  }

  private setStatus(runId: string, status: RunStatus, error?: RunError | null): Run {
    const current = this.requireRun(runId);
    const terminal = TERMINAL_STATUSES.has(status);
    const updated = this.store.updateRun(runId, {
      status,
      startedAt: status === "running" ? current.startedAt ?? new Date().toISOString() : current.startedAt,
      finishedAt: terminal ? new Date().toISOString() : null,
      pid: terminal ? null : current.pid,
      error,
    })!;
    this.publish(runId, error ? "error" : "status", error ? { ...error, status } : { status });
    if (error) this.publish(runId, "status", { status });
    return updated;
  }

  private finishProcess(runId: string, status: "succeeded" | "failed", error: RunError | null): void {
    this.clearProcess(runId);
    this.setStatus(runId, status, error);
  }

  private clearProcess(runId: string): void {
    const managed = this.processes.get(runId);
    if (managed?.timer) clearTimeout(managed.timer);
    this.processes.delete(runId);
  }

  private requireRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new WorkbenchNotFoundError("Run not found.");
    return run;
  }

  private requireAdapter(adapterId: string) {
    const adapter = getWorkbenchAdapter(adapterId);
    if (!adapter) throw new WorkbenchNotFoundError("Workbench adapter not found.");
    return adapter;
  }
}

declare global {
  // Preserve the supervisor and its process handles across development hot reloads.
  // eslint-disable-next-line no-var
  var __agentOsRunSupervisor: RunSupervisor | undefined;
}

export function getRunSupervisor(): RunSupervisor {
  if (!globalThis.__agentOsRunSupervisor) globalThis.__agentOsRunSupervisor = new RunSupervisor();
  return globalThis.__agentOsRunSupervisor;
}
