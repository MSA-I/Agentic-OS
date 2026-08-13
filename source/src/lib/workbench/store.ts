import "server-only";

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { ensureWorkspaceRootSync, workspacePath } from "@/lib/workspaceRoot";
import { redactRecord, redactText } from "./redaction";
import type {
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
  WorkbenchDraft,
  WorkbenchProvider,
  WorkContext,
} from "./types";

type Row = Record<string, unknown>;

export interface CreateRunInput {
  adapterId: string;
  provider: WorkbenchProvider;
  context: WorkContext;
  title?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListRunsInput {
  agentId?: string | null;
  status?: RunStatus | null;
  before?: string | null;
  limit?: number;
}

function now(): string {
  return new Date().toISOString();
}

function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function runFromRow(row: Row): Run {
  return {
    id: String(row.id),
    adapterId: String(row.adapter_id),
    provider: String(row.provider) as WorkbenchProvider,
    context: {
      agentId: String(row.agent_id),
      actorId: asNullableString(row.actor_id),
      projectId: asNullableString(row.project_id),
      sessionId: asNullableString(row.session_id),
      environment: row.environment === "worktree" ? "worktree" : "local",
      panel: String(row.panel) as WorkContext["panel"],
    },
    title: asNullableString(row.title),
    status: String(row.status) as RunStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: asNullableString(row.started_at),
    finishedAt: asNullableString(row.finished_at),
    pid: typeof row.pid === "number" ? row.pid : null,
    error: row.error_code
      ? { code: String(row.error_code), message: String(row.error_message ?? "") }
      : null,
    metadata: parseObject(row.metadata_json),
  };
}

function eventFromRow(row: Row): RunEvent {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    runId: String(row.run_id),
    type: String(row.type) as RunEventType,
    createdAt: String(row.created_at),
    payload: parseObject(row.payload_json),
  };
}

function approvalFromRow(row: Row): ApprovalRequest {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    risk: String(row.risk) as ApprovalRisk,
    summary: String(row.summary),
    redactedAction: String(row.redacted_action),
    status: String(row.status) as ApprovalRequest["status"],
    createdAt: String(row.created_at),
    resolvedAt: asNullableString(row.resolved_at),
  };
}

function messageFromRow(row: Row): QueuedMessage {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    mode: String(row.mode) as MessageMode,
    content: String(row.content),
    createdAt: String(row.created_at),
    deliveredAt: asNullableString(row.delivered_at),
  };
}

export function workbenchDatabasePath(): string {
  ensureWorkspaceRootSync();
  const dataDirectory = workspacePath("AGENT_OS", "data");
  const relativeToRepository = path.relative(process.cwd(), dataDirectory);
  if (!relativeToRepository.startsWith("..") && !path.isAbsolute(relativeToRepository)) {
    throw new Error("Workbench data must resolve outside the source repository.");
  }
  mkdirSync(dataDirectory, { recursive: true });
  return path.join(dataDirectory, "workbench.sqlite3");
}

export class WorkbenchStore {
  private readonly db: DatabaseSync;

  constructor(databasePath = workbenchDatabasePath()) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_runs (
        id TEXT PRIMARY KEY,
        adapter_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        actor_id TEXT,
        project_id TEXT,
        session_id TEXT,
        environment TEXT NOT NULL,
        panel TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        pid INTEGER,
        error_code TEXT,
        error_message TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS workbench_runs_updated_idx ON workbench_runs(updated_at DESC);
      CREATE INDEX IF NOT EXISTS workbench_runs_agent_idx ON workbench_runs(agent_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS workbench_runs_session_actor_idx ON workbench_runs(provider, session_id, actor_id);

      CREATE TABLE IF NOT EXISTS workbench_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES workbench_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workbench_events_run_idx ON workbench_events(run_id, sequence);

      CREATE TABLE IF NOT EXISTS workbench_approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workbench_runs(id) ON DELETE CASCADE,
        risk TEXT NOT NULL,
        summary TEXT NOT NULL,
        redacted_action TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS workbench_approvals_run_idx ON workbench_approvals(run_id, created_at);

      CREATE TABLE IF NOT EXISTS workbench_queued_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workbench_runs(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS workbench_queue_run_idx ON workbench_queued_messages(run_id, delivered_at, created_at);

      CREATE TABLE IF NOT EXISTS workbench_drafts (
        id TEXT PRIMARY KEY,
        context_json TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  createRun(input: CreateRunInput): Run {
    const id = randomUUID();
    const timestamp = now();
    const metadata = redactRecord(input.metadata ?? {}) as Record<string, unknown>;
    this.db.prepare(`
      INSERT INTO workbench_runs (
        id, adapter_id, provider, agent_id, actor_id, project_id, session_id,
        environment, panel, title, status, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(
      id, input.adapterId, input.provider, input.context.agentId, input.context.actorId,
      input.context.projectId, input.context.sessionId, input.context.environment,
      input.context.panel, input.title ? redactText(input.title, 200) : null,
      timestamp, timestamp, JSON.stringify(metadata),
    );
    return this.getRun(id)!;
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM workbench_runs WHERE id = ?").get(id) as Row | undefined;
    return row ? runFromRow(row) : null;
  }

  listRuns(input: ListRunsInput = {}): Run[] {
    const clauses: string[] = [];
    const values: SQLInputValue[] = [];
    if (input.agentId) { clauses.push("agent_id = ?"); values.push(input.agentId); }
    if (input.status) { clauses.push("status = ?"); values.push(input.status); }
    if (input.before) { clauses.push("updated_at < ?"); values.push(input.before); }
    const limit = Math.max(1, Math.min(200, input.limit ?? 50));
    values.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT * FROM workbench_runs ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(...values) as Row[];
    return rows.map(runFromRow);
  }

  sessionActor(provider: WorkbenchProvider, sessionId: string): string | null | undefined {
    const row = this.db.prepare(`
      SELECT actor_id FROM workbench_runs
      WHERE provider = ? AND session_id = ? ORDER BY created_at ASC LIMIT 1
    `).get(provider, sessionId) as Row | undefined;
    return row ? asNullableString(row.actor_id) : undefined;
  }

  updateRun(
    id: string,
    patch: Partial<Pick<Run, "status" | "startedAt" | "finishedAt" | "pid">> & { error?: RunError | null },
  ): Run | null {
    const current = this.getRun(id);
    if (!current) return null;
    const status = patch.status ?? current.status;
    const timestamp = now();
    const error = patch.error === undefined ? current.error : patch.error;
    this.db.prepare(`
      UPDATE workbench_runs SET status = ?, updated_at = ?, started_at = ?, finished_at = ?,
        pid = ?, error_code = ?, error_message = ? WHERE id = ?
    `).run(
      status,
      timestamp,
      patch.startedAt === undefined ? current.startedAt : patch.startedAt,
      patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
      patch.pid === undefined ? current.pid : patch.pid,
      error?.code ?? null,
      error ? redactText(error.message, 2_000) : null,
      id,
    );
    return this.getRun(id);
  }

  appendEvent(runId: string, type: RunEventType, payload: Record<string, unknown>): RunEvent {
    const id = randomUUID();
    const createdAt = now();
    const safePayload = redactRecord(payload) as Record<string, unknown>;
    const result = this.db.prepare(`
      INSERT INTO workbench_events (id, run_id, type, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, runId, type, createdAt, JSON.stringify(safePayload));
    return {
      id,
      sequence: Number(result.lastInsertRowid),
      runId,
      type,
      createdAt,
      payload: safePayload,
    };
  }

  eventsAfter(runId: string, after = 0, limit = 500): RunEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM workbench_events WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ASC LIMIT ?
    `).all(runId, Math.max(0, after), Math.max(1, Math.min(1_000, limit))) as Row[];
    return rows.map(eventFromRow);
  }

  createApproval(runId: string, risk: ApprovalRisk, summary: string, action: string): ApprovalRequest {
    const id = randomUUID();
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO workbench_approvals
        (id, run_id, risk, summary, redacted_action, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, runId, risk, redactText(summary, 500), redactText(action, 2_000), createdAt);
    return this.getApproval(id)!;
  }

  getApproval(id: string): ApprovalRequest | null {
    const row = this.db.prepare("SELECT * FROM workbench_approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? approvalFromRow(row) : null;
  }

  resolveApproval(id: string, decision: ApprovalDecision): ApprovalRequest | null {
    const resolvedAt = now();
    const result = this.db.prepare(`
      UPDATE workbench_approvals SET status = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(decision, resolvedAt, id);
    return Number(result.changes) ? this.getApproval(id) : null;
  }

  enqueueMessage(runId: string, mode: MessageMode, content: string): QueuedMessage {
    const id = randomUUID();
    const createdAt = now();
    const safeContent = redactText(content, 32_000);
    this.db.prepare(`
      INSERT INTO workbench_queued_messages (id, run_id, mode, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, runId, mode, safeContent, createdAt);
    return { id, runId, mode, content: safeContent, createdAt, deliveredAt: null };
  }

  pendingMessages(runId: string, limit = 100): QueuedMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM workbench_queued_messages WHERE run_id = ? AND delivered_at IS NULL
      ORDER BY created_at ASC LIMIT ?
    `).all(runId, Math.max(1, Math.min(500, limit))) as Row[];
    return rows.map(messageFromRow);
  }

  markMessageDelivered(id: string): QueuedMessage | null {
    this.db.prepare(`
      UPDATE workbench_queued_messages SET delivered_at = ?
      WHERE id = ? AND delivered_at IS NULL
    `).run(now(), id);
    const row = this.db.prepare("SELECT * FROM workbench_queued_messages WHERE id = ?").get(id) as Row | undefined;
    return row ? messageFromRow(row) : null;
  }

  saveDraft(id: string, context: WorkContext, content: string): WorkbenchDraft {
    const updatedAt = now();
    const safeContent = redactText(content, 32_000);
    this.db.prepare(`
      INSERT INTO workbench_drafts (id, context_json, content, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET context_json = excluded.context_json,
        content = excluded.content, updated_at = excluded.updated_at
    `).run(id, JSON.stringify(context), safeContent, updatedAt);
    return { id, context, content: safeContent, updatedAt };
  }

  getDraft(id: string): WorkbenchDraft | null {
    const row = this.db.prepare("SELECT * FROM workbench_drafts WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      context: parseObject(row.context_json) as unknown as WorkContext,
      content: String(row.content),
      updatedAt: String(row.updated_at),
    };
  }

  deleteDraft(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM workbench_drafts WHERE id = ?").run(id).changes) > 0;
  }

  orphanActiveRuns(): Run[] {
    const active = this.db.prepare(`
      SELECT * FROM workbench_runs WHERE status IN ('running', 'awaiting_approval')
    `).all() as Row[];
    const timestamp = now();
    this.db.prepare(`
      UPDATE workbench_runs SET status = 'orphaned', updated_at = ?, finished_at = ?, pid = NULL,
        error_code = 'supervisor_restarted',
        error_message = 'The server restarted while this run was active.'
      WHERE status IN ('running', 'awaiting_approval')
    `).run(timestamp, timestamp);
    return active.map((row) => this.getRun(String(row.id))!).filter(Boolean);
  }
}
