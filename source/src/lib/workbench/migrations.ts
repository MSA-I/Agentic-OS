import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface WorkbenchMigration {
  version: number;
  name: string;
  sql: string;
}

export interface AppliedWorkbenchMigration {
  version: number;
  name: string;
  checksumSha256: string;
  appliedAt: string;
}

export class WorkbenchMigrationError extends Error {
  readonly version: number | null;

  constructor(message: string, options: { version?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkbenchMigrationError";
    this.version = options.version ?? null;
  }
}

export const WORKBENCH_MIGRATIONS: readonly WorkbenchMigration[] = [
  {
    version: 1,
    name: "baseline_workbench_schema",
    sql: `
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
      CREATE INDEX IF NOT EXISTS workbench_runs_session_actor_idx
        ON workbench_runs(provider, session_id, actor_id);

      CREATE TABLE IF NOT EXISTS workbench_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES workbench_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workbench_events_run_idx
        ON workbench_events(run_id, sequence);

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
      CREATE INDEX IF NOT EXISTS workbench_approvals_run_idx
        ON workbench_approvals(run_id, created_at);

      CREATE TABLE IF NOT EXISTS workbench_queued_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workbench_runs(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS workbench_queue_run_idx
        ON workbench_queued_messages(run_id, delivered_at, created_at);

      CREATE TABLE IF NOT EXISTS workbench_drafts (
        id TEXT PRIMARY KEY,
        context_json TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "durable_run_state_outbox_and_event_retention",
    sql: `
      ALTER TABLE workbench_runs ADD COLUMN operation TEXT;
      ALTER TABLE workbench_runs ADD COLUMN idempotency_scope TEXT;
      ALTER TABLE workbench_runs ADD COLUMN idempotency_key TEXT;
      ALTER TABLE workbench_runs ADD COLUMN payload_hash TEXT;
      ALTER TABLE workbench_runs ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX workbench_runs_idempotency_scope_idx
        ON workbench_runs(idempotency_scope) WHERE idempotency_scope IS NOT NULL;
      CREATE UNIQUE INDEX workbench_runs_idempotency_key_idx
        ON workbench_runs(idempotency_key) WHERE idempotency_key IS NOT NULL;

      CREATE TABLE workbench_outbox (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workbench_runs(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES workbench_events(id) ON DELETE SET NULL,
        command_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        target_status TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'claimed', 'completed', 'dead')),
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        claimed_by TEXT,
        lease_expires_at TEXT,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        last_error TEXT
      );
      CREATE INDEX workbench_outbox_claim_idx
        ON workbench_outbox(state, available_at, lease_expires_at, created_at);
      CREATE INDEX workbench_outbox_run_idx
        ON workbench_outbox(run_id, created_at);

      CREATE TABLE workbench_event_retention (
        run_id TEXT PRIMARY KEY REFERENCES workbench_runs(id) ON DELETE CASCADE,
        compacted_through_sequence INTEGER NOT NULL DEFAULT 0,
        snapshot_sequence INTEGER NOT NULL DEFAULT 0,
        snapshot_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE TRIGGER workbench_runs_transition_guard
      BEFORE UPDATE OF status ON workbench_runs
      WHEN OLD.status <> NEW.status AND NOT (
        (OLD.status = 'requested' AND NEW.status IN ('queued', 'blocked', 'failed', 'cancelled')) OR
        (OLD.status = 'queued' AND NEW.status IN ('claimed', 'starting', 'running', 'stopping', 'blocked', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'claimed' AND NEW.status IN ('queued', 'starting', 'stopping', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'starting' AND NEW.status IN ('running', 'stopping', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'running' AND NEW.status IN ('awaiting_approval', 'stopping', 'succeeded', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'awaiting_approval' AND NEW.status IN ('running', 'stopping', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'stopping' AND NEW.status IN ('cancelled', 'failed', 'orphaned')) OR
        (OLD.status = 'orphaned' AND NEW.status IN ('queued', 'blocked', 'failed', 'cancelled'))
      )
      BEGIN
        SELECT RAISE(ABORT, 'illegal_run_transition');
      END;
    `,
  },
  {
    version: 3,
    name: "durable_worker_execution_and_resource_reservations",
    sql: `
      ALTER TABLE workbench_outbox ADD COLUMN execution_id TEXT;
      ALTER TABLE workbench_outbox ADD COLUMN checkpoint TEXT NOT NULL DEFAULT 'pending'
        CHECK (checkpoint IN ('pending', 'dequeued', 'spawn_intent', 'spawned', 'registered', 'completed'));
      ALTER TABLE workbench_outbox ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3
        CHECK (max_attempts BETWEEN 1 AND 20);
      ALTER TABLE workbench_outbox ADD COLUMN resources_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE workbench_outbox ADD COLUMN execution_identity_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE workbench_outbox ADD COLUMN process_identity_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE workbench_outbox ADD COLUMN outcome_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE workbench_outbox ADD COLUMN reservation_active INTEGER NOT NULL DEFAULT 0
        CHECK (reservation_active IN (0, 1));
      CREATE UNIQUE INDEX workbench_outbox_execution_id_idx
        ON workbench_outbox(execution_id) WHERE execution_id IS NOT NULL;
      CREATE INDEX workbench_outbox_reservation_idx
        ON workbench_outbox(reservation_active, state);
    `,
  },
  {
    version: 4,
    name: "durable_execution_recovery_identity_and_terminal_checkpoint",
    sql: `
      CREATE TABLE workbench_execution_recovery (
        execution_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE REFERENCES workbench_outbox(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES workbench_runs(id) ON DELETE CASCADE,
        job_object_id TEXT NOT NULL,
        checkpoint TEXT NOT NULL
          CHECK (checkpoint IN ('spawn_intent', 'spawned', 'registered', 'completed')),
        pid INTEGER,
        root_process_started_at_file_time TEXT,
        job_name TEXT,
        helper_pid INTEGER,
        helper_process_started_at_file_time TEXT,
        executable_path TEXT,
        executable_hash TEXT,
        process_started_at TEXT,
        process_identity_json TEXT NOT NULL DEFAULT '{}',
        terminal_status TEXT
          CHECK (terminal_status IS NULL OR terminal_status IN ('succeeded', 'failed', 'cancelled', 'blocked')),
        terminal_exit_code INTEGER,
        terminal_error_code TEXT,
        terminal_error_message TEXT,
        terminal_metadata_json TEXT NOT NULL DEFAULT '{}',
        terminal_observed_at TEXT,
        termination_verified INTEGER NOT NULL DEFAULT 0
          CHECK (termination_verified IN (0, 1)),
        terminal_source TEXT
          CHECK (terminal_source IS NULL OR terminal_source IN ('worker', 'windows_job_helper')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (terminal_status IS NULL AND terminal_observed_at IS NULL AND terminal_source IS NULL AND termination_verified = 0)
          OR
          (terminal_status IS NOT NULL AND terminal_observed_at IS NOT NULL AND terminal_source IS NOT NULL AND termination_verified = 1)
        )
      );
      CREATE UNIQUE INDEX workbench_execution_recovery_job_idx
        ON workbench_execution_recovery(job_object_id);
      CREATE INDEX workbench_execution_recovery_unresolved_idx
        ON workbench_execution_recovery(checkpoint, terminal_status, updated_at);

      INSERT INTO workbench_execution_recovery (
        execution_id, command_id, run_id, job_object_id, checkpoint,
        pid, root_process_started_at_file_time, job_name, helper_pid,
        helper_process_started_at_file_time, executable_path, executable_hash,
        process_started_at, process_identity_json, terminal_status,
        terminal_exit_code, terminal_error_code, terminal_error_message,
        terminal_metadata_json, terminal_observed_at, termination_verified,
        terminal_source, created_at, updated_at
      )
      SELECT
        execution_id,
        id,
        run_id,
        COALESCE(json_extract(execution_identity_json, '$.jobObjectId'), 'agent-os-' || execution_id),
        CASE
          WHEN checkpoint = 'completed' THEN 'completed'
          WHEN checkpoint = 'registered' THEN 'registered'
          WHEN checkpoint = 'spawned' THEN 'spawned'
          ELSE 'spawn_intent'
        END,
        json_extract(process_identity_json, '$.pid'),
        json_extract(process_identity_json, '$.rootProcessStartedAtFileTime'),
        json_extract(process_identity_json, '$.jobName'),
        COALESCE(
          json_extract(process_identity_json, '$.helperPid'),
          json_extract(process_identity_json, '$.helperProcessId')
        ),
        json_extract(process_identity_json, '$.helperProcessStartedAtFileTime'),
        json_extract(process_identity_json, '$.executablePath'),
        json_extract(process_identity_json, '$.executableHash'),
        json_extract(process_identity_json, '$.startedAt'),
        process_identity_json,
        CASE WHEN checkpoint = 'completed' THEN json_extract(outcome_json, '$.status') ELSE NULL END,
        CASE WHEN checkpoint = 'completed' THEN json_extract(outcome_json, '$.exitCode') ELSE NULL END,
        CASE WHEN checkpoint = 'completed' THEN json_extract(outcome_json, '$.errorCode') ELSE NULL END,
        CASE WHEN checkpoint = 'completed' THEN json_extract(outcome_json, '$.errorMessage') ELSE NULL END,
        CASE WHEN checkpoint = 'completed'
          THEN COALESCE(json_extract(outcome_json, '$.metadata'), '{}')
          ELSE '{}'
        END,
        CASE WHEN checkpoint = 'completed' THEN completed_at ELSE NULL END,
        CASE WHEN checkpoint = 'completed' THEN 1 ELSE 0 END,
        CASE WHEN checkpoint = 'completed' THEN 'worker' ELSE NULL END,
        created_at,
        COALESCE(completed_at, claimed_at, created_at)
      FROM workbench_outbox
      WHERE execution_id IS NOT NULL;
    `,
  },
  {
    version: 5,
    name: "align_transition_guard_with_blocked_terminal_outcomes",
    sql: `
      DROP TRIGGER workbench_runs_transition_guard;
      CREATE TRIGGER workbench_runs_transition_guard
      BEFORE UPDATE OF status ON workbench_runs
      WHEN OLD.status <> NEW.status AND NOT (
        (OLD.status = 'requested' AND NEW.status IN ('queued', 'blocked', 'failed', 'cancelled')) OR
        (OLD.status = 'queued' AND NEW.status IN ('claimed', 'starting', 'running', 'stopping', 'blocked', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'claimed' AND NEW.status IN ('queued', 'starting', 'stopping', 'blocked', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'starting' AND NEW.status IN ('running', 'stopping', 'blocked', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'running' AND NEW.status IN ('awaiting_approval', 'stopping', 'succeeded', 'blocked', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'awaiting_approval' AND NEW.status IN ('running', 'stopping', 'blocked', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'stopping' AND NEW.status IN ('blocked', 'cancelled', 'failed', 'orphaned')) OR
        (OLD.status = 'orphaned' AND NEW.status IN ('queued', 'blocked', 'failed', 'cancelled'))
      )
      BEGIN
        SELECT RAISE(ABORT, 'illegal_run_transition');
      END;
    `,
  },
  {
    version: 6,
    name: "durable_control_plane_generation_recovery_and_quota",
    sql: `
      ALTER TABLE workbench_runs ADD COLUMN run_generation INTEGER NOT NULL DEFAULT 0
        CHECK (run_generation >= 0);

      ALTER TABLE workbench_outbox ADD COLUMN operation TEXT NOT NULL DEFAULT 'unknown'
        CHECK (operation IN ('start', 'resume', 'steer', 'queue', 'cancel', 'unknown'));
      ALTER TABLE workbench_outbox ADD COLUMN run_generation INTEGER NOT NULL DEFAULT 0
        CHECK (run_generation >= 0);
      ALTER TABLE workbench_outbox ADD COLUMN run_state_version INTEGER NOT NULL DEFAULT 0
        CHECK (run_state_version >= 0);
      ALTER TABLE workbench_outbox ADD COLUMN delivery_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (delivery_attempt_count >= 0);
      ALTER TABLE workbench_outbox ADD COLUMN provider_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (provider_attempt_count >= 0);
      ALTER TABLE workbench_outbox ADD COLUMN provider_attempt_fencing_token INTEGER;

      UPDATE workbench_outbox
      SET
        operation = CASE
          WHEN lower(json_extract(payload_json, '$.operation')) IN ('start', 'resume', 'steer', 'queue', 'cancel')
            THEN lower(json_extract(payload_json, '$.operation'))
          WHEN (SELECT lower(operation) FROM workbench_runs WHERE id = workbench_outbox.run_id)
            IN ('start', 'resume', 'steer', 'queue', 'cancel')
            THEN (SELECT lower(operation) FROM workbench_runs WHERE id = workbench_outbox.run_id)
          WHEN lower(command_type) IN ('start', 'resume', 'steer', 'queue', 'cancel')
            THEN lower(command_type)
          WHEN lower(command_type) LIKE '%.start' THEN 'start'
          WHEN lower(command_type) LIKE '%.resume' THEN 'resume'
          WHEN lower(command_type) LIKE '%.steer' THEN 'steer'
          WHEN lower(command_type) LIKE '%.queue' THEN 'queue'
          WHEN lower(command_type) LIKE '%.cancel' THEN 'cancel'
          ELSE 'unknown'
        END,
        run_generation = COALESCE(
          (SELECT run_generation FROM workbench_runs WHERE id = workbench_outbox.run_id),
          0
        ),
        run_state_version = COALESCE(
          (SELECT state_version FROM workbench_runs WHERE id = workbench_outbox.run_id),
          0
        ),
        delivery_attempt_count = attempt_count,
        provider_attempt_count = attempt_count;

      CREATE INDEX workbench_outbox_generation_claim_idx
        ON workbench_outbox(state, run_generation, available_at, lease_expires_at, created_at);

      CREATE TABLE workbench_create_receipts (
        idempotency_scope TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES workbench_runs(id) ON DELETE CASCADE,
        command_id TEXT NOT NULL UNIQUE REFERENCES workbench_outbox(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
        event_type TEXT NOT NULL,
        event_created_at TEXT NOT NULL,
        event_payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      INSERT INTO workbench_create_receipts (
        idempotency_scope, run_id, command_id, event_id, event_sequence,
        event_type, event_created_at, event_payload_json, created_at
      )
      SELECT
        r.idempotency_scope,
        r.id,
        o.id,
        COALESCE(e.id, 'receipt-' || r.id),
        COALESCE(e.sequence, 0),
        COALESCE(e.type, 'status'),
        COALESCE(e.created_at, r.created_at),
        COALESCE(
          e.payload_json,
          json_object(
            'status', r.status,
            'operation', COALESCE(r.operation, 'unknown'),
            'stateVersion', r.state_version
          )
        ),
        r.created_at
      FROM workbench_runs r
      JOIN workbench_outbox o ON o.idempotency_key = r.idempotency_key
      LEFT JOIN workbench_events e ON e.id = o.event_id
      WHERE r.idempotency_scope IS NOT NULL;

      DROP INDEX workbench_execution_recovery_job_idx;
      DROP INDEX workbench_execution_recovery_unresolved_idx;
      ALTER TABLE workbench_execution_recovery RENAME TO workbench_execution_recovery_v5;
      CREATE TABLE workbench_execution_recovery (
        execution_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE REFERENCES workbench_outbox(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES workbench_runs(id) ON DELETE CASCADE,
        job_object_id TEXT NOT NULL,
        checkpoint TEXT NOT NULL
          CHECK (checkpoint IN ('dequeued', 'spawn_intent', 'spawned', 'registered', 'completed')),
        pid INTEGER,
        root_process_started_at_file_time TEXT,
        job_name TEXT,
        helper_pid INTEGER,
        helper_process_started_at_file_time TEXT,
        executable_path TEXT,
        executable_hash TEXT,
        process_started_at TEXT,
        process_identity_json TEXT NOT NULL DEFAULT '{}',
        terminal_status TEXT
          CHECK (terminal_status IS NULL OR terminal_status IN ('succeeded', 'failed', 'cancelled', 'blocked')),
        terminal_exit_code INTEGER,
        terminal_error_code TEXT,
        terminal_error_message TEXT,
        terminal_metadata_json TEXT NOT NULL DEFAULT '{}',
        terminal_observed_at TEXT,
        termination_verified INTEGER NOT NULL DEFAULT 0
          CHECK (termination_verified IN (0, 1)),
        terminal_source TEXT
          CHECK (terminal_source IS NULL OR terminal_source IN ('worker', 'windows_job_helper')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (terminal_status IS NULL AND terminal_observed_at IS NULL AND terminal_source IS NULL AND termination_verified = 0)
          OR
          (terminal_status IS NOT NULL AND terminal_observed_at IS NOT NULL AND terminal_source IS NOT NULL AND termination_verified = 1)
        )
      );
      INSERT INTO workbench_execution_recovery SELECT * FROM workbench_execution_recovery_v5;
      DROP TABLE workbench_execution_recovery_v5;
      CREATE UNIQUE INDEX workbench_execution_recovery_job_idx
        ON workbench_execution_recovery(job_object_id);
      CREATE UNIQUE INDEX workbench_execution_recovery_identity_idx
        ON workbench_execution_recovery(execution_id, command_id, run_id, job_object_id);
      CREATE INDEX workbench_execution_recovery_unresolved_idx
        ON workbench_execution_recovery(checkpoint, terminal_status, updated_at);

      CREATE TABLE workbench_external_status_high_water (
        execution_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        job_object_id TEXT NOT NULL,
        journal_generation TEXT NOT NULL
          CHECK (length(journal_generation) BETWEEN 22 AND 128
            AND journal_generation NOT GLOB '*[^A-Za-z0-9_-]*'),
        status_sequence INTEGER NOT NULL CHECK (status_sequence >= 1),
        terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
        snapshot_digest_sha256 TEXT NOT NULL
          CHECK (length(snapshot_digest_sha256) = 64
            AND snapshot_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
        journal_digest_sha256 TEXT NOT NULL
          CHECK (length(journal_digest_sha256) = 64
            AND journal_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (execution_id, command_id, run_id, job_object_id)
          REFERENCES workbench_execution_recovery(
            execution_id, command_id, run_id, job_object_id
          ) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX workbench_external_status_high_water_job_idx
        ON workbench_external_status_high_water(job_object_id);
      CREATE TRIGGER workbench_external_status_high_water_monotonic_guard
      BEFORE UPDATE ON workbench_external_status_high_water
      BEGIN
        SELECT CASE WHEN
          NEW.execution_id <> OLD.execution_id
          OR NEW.command_id <> OLD.command_id
          OR NEW.run_id <> OLD.run_id
          OR NEW.job_object_id <> OLD.job_object_id
          OR NEW.journal_generation <> OLD.journal_generation
          OR NEW.status_sequence < OLD.status_sequence
          OR (NEW.status_sequence = OLD.status_sequence AND (
            NEW.terminal <> OLD.terminal
            OR NEW.snapshot_digest_sha256 <> OLD.snapshot_digest_sha256
            OR NEW.journal_digest_sha256 <> OLD.journal_digest_sha256
          ))
          OR (OLD.terminal = 1 AND (
            NEW.status_sequence <> OLD.status_sequence
            OR NEW.terminal <> OLD.terminal
            OR NEW.snapshot_digest_sha256 <> OLD.snapshot_digest_sha256
            OR NEW.journal_digest_sha256 <> OLD.journal_digest_sha256
          ))
        THEN RAISE(ABORT, 'external_status_high_water_conflict') END;
      END;

      CREATE TABLE workbench_event_quota_policy (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        max_payload_bytes_per_event INTEGER NOT NULL CHECK (max_payload_bytes_per_event > 0),
        max_retained_events_per_run INTEGER NOT NULL CHECK (max_retained_events_per_run > 0),
        max_store_bytes INTEGER NOT NULL CHECK (max_store_bytes > 0),
        max_snapshot_bytes INTEGER NOT NULL CHECK (max_snapshot_bytes > 0),
        created_at TEXT NOT NULL
      );

      CREATE TRIGGER workbench_events_quota_guard
      BEFORE INSERT ON workbench_events
      BEGIN
        SELECT CASE WHEN (SELECT COUNT(*) FROM workbench_event_quota_policy WHERE singleton = 1) <> 1
          THEN RAISE(ABORT, 'event_quota_policy_missing') END;
        SELECT CASE WHEN length(CAST(NEW.payload_json AS BLOB)) >
          (SELECT max_payload_bytes_per_event FROM workbench_event_quota_policy WHERE singleton = 1)
          THEN RAISE(ABORT, 'event_too_large') END;
        SELECT CASE WHEN (SELECT COUNT(*) FROM workbench_events WHERE run_id = NEW.run_id) >=
          (SELECT max_retained_events_per_run FROM workbench_event_quota_policy WHERE singleton = 1)
          THEN RAISE(ABORT, 'event_store_full') END;
        SELECT CASE WHEN (
          COALESCE((SELECT SUM(length(CAST(payload_json AS BLOB))) FROM workbench_events), 0)
          + COALESCE((SELECT SUM(length(CAST(snapshot_json AS BLOB))) FROM workbench_event_retention), 0)
          + length(CAST(NEW.payload_json AS BLOB))
        ) > (SELECT max_store_bytes FROM workbench_event_quota_policy WHERE singleton = 1)
          THEN RAISE(ABORT, 'event_store_full') END;
      END;

      CREATE TRIGGER workbench_event_retention_insert_quota_guard
      BEFORE INSERT ON workbench_event_retention
      BEGIN
        SELECT CASE WHEN (SELECT COUNT(*) FROM workbench_event_quota_policy WHERE singleton = 1) <> 1
          THEN RAISE(ABORT, 'event_quota_policy_missing') END;
        SELECT CASE WHEN length(CAST(NEW.snapshot_json AS BLOB)) >
          (SELECT max_snapshot_bytes FROM workbench_event_quota_policy WHERE singleton = 1)
          THEN RAISE(ABORT, 'event_snapshot_too_large') END;
        SELECT CASE WHEN (
          COALESCE((SELECT SUM(length(CAST(payload_json AS BLOB))) FROM workbench_events), 0)
          + COALESCE((SELECT SUM(length(CAST(snapshot_json AS BLOB))) FROM workbench_event_retention), 0)
          + length(CAST(NEW.snapshot_json AS BLOB))
        ) > (SELECT max_store_bytes FROM workbench_event_quota_policy WHERE singleton = 1)
          THEN RAISE(ABORT, 'event_store_full') END;
      END;

      CREATE TRIGGER workbench_event_retention_update_quota_guard
      BEFORE UPDATE OF snapshot_json ON workbench_event_retention
      BEGIN
        SELECT CASE WHEN (SELECT COUNT(*) FROM workbench_event_quota_policy WHERE singleton = 1) <> 1
          THEN RAISE(ABORT, 'event_quota_policy_missing') END;
        SELECT CASE WHEN length(CAST(NEW.snapshot_json AS BLOB)) >
          (SELECT max_snapshot_bytes FROM workbench_event_quota_policy WHERE singleton = 1)
          THEN RAISE(ABORT, 'event_snapshot_too_large') END;
        SELECT CASE WHEN (
          COALESCE((SELECT SUM(length(CAST(payload_json AS BLOB))) FROM workbench_events), 0)
          + COALESCE((SELECT SUM(length(CAST(snapshot_json AS BLOB)))
            FROM workbench_event_retention WHERE run_id <> OLD.run_id), 0)
          + length(CAST(NEW.snapshot_json AS BLOB))
        ) > (SELECT max_store_bytes FROM workbench_event_quota_policy WHERE singleton = 1)
          THEN RAISE(ABORT, 'event_store_full') END;
      END;

      CREATE TABLE workbench_provider_circuits (
        provider TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'closed'
          CHECK (state IN ('closed', 'open', 'half_open')),
        fencing_token INTEGER NOT NULL DEFAULT 0
          CHECK (fencing_token >= 0),
        consecutive_failures INTEGER NOT NULL DEFAULT 0
          CHECK (consecutive_failures >= 0),
        open_until TEXT,
        half_open_owner TEXT,
        half_open_lease_expires_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (
          (state = 'closed' AND open_until IS NULL
            AND half_open_owner IS NULL AND half_open_lease_expires_at IS NULL)
          OR
          (state = 'open' AND open_until IS NOT NULL
            AND half_open_owner IS NULL AND half_open_lease_expires_at IS NULL)
          OR
          (state = 'half_open' AND open_until IS NULL
            AND ((half_open_owner IS NULL AND half_open_lease_expires_at IS NULL)
              OR (half_open_owner IS NOT NULL AND half_open_lease_expires_at IS NOT NULL)))
        )
      );
      CREATE INDEX workbench_provider_circuits_availability_idx
        ON workbench_provider_circuits(state, open_until, half_open_lease_expires_at, provider);
    `,
  },
  {
    version: 7,
    name: "authenticated_status_chain_terminal_binding_and_command_semantics",
    sql: `
      ALTER TABLE workbench_external_status_high_water ADD COLUMN chain_version INTEGER NOT NULL DEFAULT 1
        CHECK (chain_version IN (1, 2));
      ALTER TABLE workbench_external_status_high_water ADD COLUMN previous_status_sequence INTEGER;
      ALTER TABLE workbench_external_status_high_water ADD COLUMN previous_snapshot_digest_sha256 TEXT;
      ALTER TABLE workbench_external_status_high_water ADD COLUMN previous_journal_digest_sha256 TEXT;
      ALTER TABLE workbench_external_status_high_water ADD COLUMN authenticated_payload_digest_sha256 TEXT;
      ALTER TABLE workbench_external_status_high_water ADD COLUMN native_terminal_digest_sha256 TEXT;
      ALTER TABLE workbench_external_status_high_water ADD COLUMN native_terminal_status TEXT;
      ALTER TABLE workbench_external_status_high_water ADD COLUMN native_exit_code INTEGER;
      ALTER TABLE workbench_external_status_high_water ADD COLUMN termination_verified INTEGER NOT NULL DEFAULT 0
        CHECK (termination_verified IN (0, 1));
      ALTER TABLE workbench_external_status_high_water ADD COLUMN controller_outcome_digest_sha256 TEXT;

      ALTER TABLE workbench_execution_recovery ADD COLUMN terminal_native_digest_sha256 TEXT;
      ALTER TABLE workbench_execution_recovery ADD COLUMN terminal_controller_outcome_digest_sha256 TEXT;

      CREATE TABLE workbench_command_semantics (
        command_id TEXT PRIMARY KEY REFERENCES workbench_outbox(id) ON DELETE CASCADE,
        semantics TEXT NOT NULL CHECK (semantics IN ('orphan_reconciliation')),
        created_at TEXT NOT NULL
      );
      INSERT INTO workbench_command_semantics (command_id, semantics, created_at)
      SELECT id, 'orphan_reconciliation', created_at
      FROM workbench_outbox
      WHERE lower(command_type) = 'run.reconcile_orphan'
        AND json_type(payload_json, '$.operation') IS NULL;

      UPDATE workbench_outbox
      SET operation = 'unknown'
      WHERE (
        json_type(payload_json, '$.operation') IS NOT NULL
        AND (
          json_type(payload_json, '$.operation') <> 'text'
          OR lower(json_extract(payload_json, '$.operation'))
            NOT IN ('start', 'resume', 'steer', 'queue', 'cancel')
        )
      ) OR EXISTS (
        SELECT 1 FROM workbench_runs run
        WHERE run.id = workbench_outbox.run_id
          AND run.idempotency_key = workbench_outbox.idempotency_key
          AND lower(run.operation) NOT IN ('start', 'resume', 'steer', 'queue', 'cancel')
      );

      CREATE TRIGGER workbench_external_status_chain_v2_insert_guard
      BEFORE INSERT ON workbench_external_status_high_water
      BEGIN
        SELECT CASE WHEN
          NEW.chain_version <> 2
          OR NEW.status_sequence <> 1
          OR NEW.previous_status_sequence <> 0
          OR NEW.previous_snapshot_digest_sha256 IS NULL
          OR NEW.previous_snapshot_digest_sha256 <> lower(hex(zeroblob(32)))
          OR NEW.previous_journal_digest_sha256 IS NULL
          OR NEW.previous_journal_digest_sha256 <> lower(hex(zeroblob(32)))
          OR NEW.authenticated_payload_digest_sha256 IS NULL
          OR length(NEW.authenticated_payload_digest_sha256) <> 64
          OR NEW.authenticated_payload_digest_sha256 GLOB '*[^0-9a-f]*'
          OR (
            NEW.terminal = 0 AND (
              NEW.native_terminal_digest_sha256 IS NOT NULL
              OR NEW.native_terminal_status IS NOT NULL
              OR NEW.native_exit_code IS NOT NULL
              OR NEW.termination_verified <> 0
              OR NEW.controller_outcome_digest_sha256 IS NOT NULL
            )
          )
          OR (
            NEW.terminal = 1 AND (
              NEW.native_terminal_digest_sha256 IS NULL
              OR length(NEW.native_terminal_digest_sha256) <> 64
              OR NEW.native_terminal_digest_sha256 GLOB '*[^0-9a-f]*'
              OR NEW.native_terminal_status IS NULL
              OR NEW.native_terminal_status NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')
              OR NEW.termination_verified <> 1
              OR NEW.controller_outcome_digest_sha256 IS NULL
              OR length(NEW.controller_outcome_digest_sha256) <> 64
              OR NEW.controller_outcome_digest_sha256 GLOB '*[^0-9a-f]*'
            )
          )
        THEN RAISE(ABORT, 'external_status_chain_v2_invalid') END;
      END;

      CREATE TRIGGER workbench_external_status_chain_v2_update_guard
      BEFORE UPDATE ON workbench_external_status_high_water
      BEGIN
        SELECT CASE WHEN
          OLD.chain_version <> 2
          OR NEW.chain_version <> 2
          OR NEW.status_sequence <> OLD.status_sequence + 1
          OR NEW.previous_status_sequence <> OLD.status_sequence
          OR NEW.previous_snapshot_digest_sha256 IS NULL
          OR NEW.previous_snapshot_digest_sha256 <> OLD.snapshot_digest_sha256
          OR NEW.previous_journal_digest_sha256 IS NULL
          OR NEW.previous_journal_digest_sha256 <> OLD.journal_digest_sha256
          OR OLD.terminal <> 0
          OR NEW.authenticated_payload_digest_sha256 IS NULL
          OR length(NEW.authenticated_payload_digest_sha256) <> 64
          OR NEW.authenticated_payload_digest_sha256 GLOB '*[^0-9a-f]*'
          OR (
            NEW.terminal = 0 AND (
              NEW.native_terminal_digest_sha256 IS NOT NULL
              OR NEW.native_terminal_status IS NOT NULL
              OR NEW.native_exit_code IS NOT NULL
              OR NEW.termination_verified <> 0
              OR NEW.controller_outcome_digest_sha256 IS NOT NULL
            )
          )
          OR (
            NEW.terminal = 1 AND (
              NEW.native_terminal_digest_sha256 IS NULL
              OR length(NEW.native_terminal_digest_sha256) <> 64
              OR NEW.native_terminal_digest_sha256 GLOB '*[^0-9a-f]*'
              OR NEW.native_terminal_status IS NULL
              OR NEW.native_terminal_status NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')
              OR NEW.termination_verified <> 1
              OR NEW.controller_outcome_digest_sha256 IS NULL
              OR length(NEW.controller_outcome_digest_sha256) <> 64
              OR NEW.controller_outcome_digest_sha256 GLOB '*[^0-9a-f]*'
            )
          )
        THEN RAISE(ABORT, 'external_status_chain_v2_conflict') END;
      END;
    `,
  },
  {
    version: 8,
    name: "align_transition_guard_with_canonical_state_machine",
    sql: `
      DROP TRIGGER workbench_runs_transition_guard;
      CREATE TRIGGER workbench_runs_transition_guard
      BEFORE UPDATE OF status ON workbench_runs
      WHEN OLD.status <> NEW.status AND NOT (
        (OLD.status = 'requested' AND NEW.status IN ('queued', 'blocked', 'failed', 'cancelled')) OR
        (OLD.status = 'queued' AND NEW.status IN ('claimed', 'starting', 'running', 'stopping', 'blocked', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'claimed' AND NEW.status IN ('queued', 'starting', 'stopping', 'blocked', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'starting' AND NEW.status IN ('running', 'stopping', 'blocked', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'running' AND NEW.status IN ('awaiting_approval', 'stopping', 'succeeded', 'blocked', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'awaiting_approval' AND NEW.status IN ('running', 'stopping', 'blocked', 'failed', 'cancelled', 'orphaned')) OR
        (OLD.status = 'stopping' AND NEW.status IN ('succeeded', 'blocked', 'cancelled', 'failed', 'orphaned')) OR
        (OLD.status = 'orphaned' AND NEW.status IN ('queued', 'blocked', 'failed', 'cancelled'))
      )
      BEGIN
        SELECT RAISE(ABORT, 'illegal_run_transition');
      END;
    `,
  },
  {
    version: 9,
    name: "durable_verified_execution_cleanup",
    sql: `
      CREATE TABLE workbench_execution_cleanup_intents (
        execution_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        job_object_id TEXT NOT NULL UNIQUE,
        run_generation INTEGER NOT NULL CHECK (run_generation >= 0),
        chain_version INTEGER NOT NULL CHECK (chain_version = 2),
        journal_generation TEXT NOT NULL
          CHECK (length(journal_generation) BETWEEN 22 AND 128
            AND journal_generation NOT GLOB '*[^A-Za-z0-9_-]*'),
        status_sequence INTEGER NOT NULL CHECK (status_sequence >= 1),
        previous_status_sequence INTEGER NOT NULL CHECK (previous_status_sequence >= 0),
        previous_snapshot_digest_sha256 TEXT NOT NULL
          CHECK (length(previous_snapshot_digest_sha256) = 64
            AND previous_snapshot_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
        previous_journal_digest_sha256 TEXT NOT NULL
          CHECK (length(previous_journal_digest_sha256) = 64
            AND previous_journal_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
        snapshot_digest_sha256 TEXT NOT NULL
          CHECK (length(snapshot_digest_sha256) = 64
            AND snapshot_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
        journal_digest_sha256 TEXT NOT NULL
          CHECK (length(journal_digest_sha256) = 64
            AND journal_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
        authenticated_payload_digest_sha256 TEXT NOT NULL
          CHECK (length(authenticated_payload_digest_sha256) = 64
            AND authenticated_payload_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
        native_terminal_digest_sha256 TEXT NOT NULL
          CHECK (length(native_terminal_digest_sha256) = 64
            AND native_terminal_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
        controller_outcome_digest_sha256 TEXT NOT NULL
          CHECK (length(controller_outcome_digest_sha256) = 64
            AND controller_outcome_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
        native_terminal_status TEXT NOT NULL
          CHECK (native_terminal_status IN ('succeeded', 'failed', 'cancelled', 'blocked')),
        native_exit_code INTEGER,
        terminal INTEGER NOT NULL CHECK (terminal = 1),
        termination_verified INTEGER NOT NULL CHECK (termination_verified = 1),
        terminal_status TEXT NOT NULL
          CHECK (terminal_status IN ('succeeded', 'failed', 'cancelled', 'blocked')),
        terminal_observed_at TEXT NOT NULL,
        root_process_id INTEGER,
        root_process_started_at_file_time TEXT,
        job_name TEXT,
        helper_process_id INTEGER,
        helper_process_started_at_file_time TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'claimed', 'completed', 'quarantined')),
        available_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        claimed_at TEXT,
        claimed_by TEXT,
        fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
        lease_expires_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        last_error_at TEXT,
        cleanup_result TEXT
          CHECK (cleanup_result IS NULL OR cleanup_result IN ('removed', 'already_absent')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (execution_id, command_id, run_id, job_object_id)
          REFERENCES workbench_execution_recovery(
            execution_id, command_id, run_id, job_object_id
          ) ON DELETE CASCADE,
        CHECK (
          (last_error_code IS NULL AND last_error_message IS NULL AND last_error_at IS NULL)
          OR
          (last_error_code IS NOT NULL AND last_error_message IS NOT NULL AND last_error_at IS NOT NULL)
        ),
        CHECK (
          (state = 'pending' AND claimed_at IS NULL AND claimed_by IS NULL
            AND lease_expires_at IS NULL AND cleanup_result IS NULL AND completed_at IS NULL)
          OR
          (state = 'claimed' AND claimed_at IS NOT NULL AND claimed_by IS NOT NULL
            AND lease_expires_at IS NOT NULL AND cleanup_result IS NULL AND completed_at IS NULL)
          OR
          (state = 'completed' AND claimed_at IS NULL AND claimed_by IS NULL
            AND lease_expires_at IS NULL AND cleanup_result IS NOT NULL AND completed_at IS NOT NULL)
          OR
          (state = 'quarantined' AND claimed_at IS NULL AND claimed_by IS NULL
            AND lease_expires_at IS NULL AND cleanup_result IS NULL AND completed_at IS NULL
            AND last_error_code IS NOT NULL)
        )
      );
      CREATE INDEX workbench_execution_cleanup_claim_idx
        ON workbench_execution_cleanup_intents(state, available_at, lease_expires_at, created_at);

      CREATE TRIGGER workbench_execution_cleanup_insert_guard
      BEFORE INSERT ON workbench_execution_cleanup_intents
      BEGIN
        SELECT CASE WHEN
          NEW.state <> 'pending'
          OR NEW.attempt_count <> 0
          OR NEW.fencing_token <> 0
          OR NEW.claimed_at IS NOT NULL
          OR NEW.claimed_by IS NOT NULL
          OR NEW.lease_expires_at IS NOT NULL
          OR NEW.cleanup_result IS NOT NULL
          OR NEW.completed_at IS NOT NULL
          OR (
            SELECT COUNT(*)
            FROM workbench_outbox command
            JOIN workbench_execution_recovery recovery
              ON recovery.execution_id = command.execution_id
              AND recovery.command_id = command.id
              AND recovery.run_id = command.run_id
            JOIN workbench_external_status_high_water high_water
              ON high_water.execution_id = recovery.execution_id
              AND high_water.command_id = recovery.command_id
              AND high_water.run_id = recovery.run_id
              AND high_water.job_object_id = recovery.job_object_id
            WHERE command.execution_id = NEW.execution_id
              AND command.id = NEW.command_id
              AND command.run_id = NEW.run_id
              AND recovery.job_object_id = NEW.job_object_id
              AND command.run_generation = NEW.run_generation
              AND command.operation IN ('start', 'resume')
              AND command.state = 'completed'
              AND command.checkpoint = 'completed'
              AND command.reservation_active = 0
              AND recovery.checkpoint = 'completed'
              AND recovery.terminal_source = 'windows_job_helper'
              AND recovery.termination_verified = 1
              AND recovery.terminal_status = NEW.terminal_status
              AND recovery.terminal_observed_at = NEW.terminal_observed_at
              AND recovery.pid IS NEW.root_process_id
              AND recovery.root_process_started_at_file_time IS NEW.root_process_started_at_file_time
              AND recovery.job_name IS NEW.job_name
              AND recovery.helper_pid IS NEW.helper_process_id
              AND recovery.helper_process_started_at_file_time
                IS NEW.helper_process_started_at_file_time
              AND recovery.terminal_native_digest_sha256 = NEW.native_terminal_digest_sha256
              AND recovery.terminal_controller_outcome_digest_sha256 = NEW.controller_outcome_digest_sha256
              AND high_water.chain_version = 2
              AND NEW.chain_version = high_water.chain_version
              AND high_water.terminal = 1
              AND NEW.terminal = high_water.terminal
              AND high_water.termination_verified = 1
              AND NEW.termination_verified = high_water.termination_verified
              AND high_water.journal_generation = NEW.journal_generation
              AND high_water.status_sequence = NEW.status_sequence
              AND high_water.previous_status_sequence = NEW.previous_status_sequence
              AND high_water.previous_snapshot_digest_sha256 = NEW.previous_snapshot_digest_sha256
              AND high_water.previous_journal_digest_sha256 = NEW.previous_journal_digest_sha256
              AND high_water.snapshot_digest_sha256 = NEW.snapshot_digest_sha256
              AND high_water.journal_digest_sha256 = NEW.journal_digest_sha256
              AND high_water.authenticated_payload_digest_sha256 = NEW.authenticated_payload_digest_sha256
              AND high_water.native_terminal_digest_sha256 = NEW.native_terminal_digest_sha256
              AND high_water.controller_outcome_digest_sha256 = NEW.controller_outcome_digest_sha256
              AND high_water.native_terminal_status = NEW.native_terminal_status
              AND high_water.native_exit_code IS NEW.native_exit_code
              AND high_water.observed_at = NEW.terminal_observed_at
              AND high_water.native_terminal_status = recovery.terminal_status
              AND high_water.native_terminal_digest_sha256 = recovery.terminal_native_digest_sha256
              AND high_water.controller_outcome_digest_sha256
                = recovery.terminal_controller_outcome_digest_sha256
          ) <> 1
        THEN RAISE(ABORT, 'execution_cleanup_terminal_proof_conflict') END;
      END;

      CREATE TRIGGER workbench_execution_cleanup_update_guard
      BEFORE UPDATE ON workbench_execution_cleanup_intents
      BEGIN
        SELECT CASE WHEN
          NEW.execution_id <> OLD.execution_id
          OR NEW.command_id <> OLD.command_id
          OR NEW.run_id <> OLD.run_id
          OR NEW.job_object_id <> OLD.job_object_id
          OR NEW.run_generation <> OLD.run_generation
          OR NEW.chain_version <> OLD.chain_version
          OR NEW.journal_generation <> OLD.journal_generation
          OR NEW.status_sequence <> OLD.status_sequence
          OR NEW.previous_status_sequence <> OLD.previous_status_sequence
          OR NEW.previous_snapshot_digest_sha256 <> OLD.previous_snapshot_digest_sha256
          OR NEW.previous_journal_digest_sha256 <> OLD.previous_journal_digest_sha256
          OR NEW.snapshot_digest_sha256 <> OLD.snapshot_digest_sha256
          OR NEW.journal_digest_sha256 <> OLD.journal_digest_sha256
          OR NEW.authenticated_payload_digest_sha256 <> OLD.authenticated_payload_digest_sha256
          OR NEW.native_terminal_digest_sha256 <> OLD.native_terminal_digest_sha256
          OR NEW.controller_outcome_digest_sha256 <> OLD.controller_outcome_digest_sha256
          OR NEW.native_terminal_status <> OLD.native_terminal_status
          OR NEW.native_exit_code IS NOT OLD.native_exit_code
          OR NEW.terminal <> OLD.terminal
          OR NEW.termination_verified <> OLD.termination_verified
          OR NEW.terminal_status <> OLD.terminal_status
          OR NEW.terminal_observed_at <> OLD.terminal_observed_at
          OR NEW.root_process_id IS NOT OLD.root_process_id
          OR NEW.root_process_started_at_file_time IS NOT OLD.root_process_started_at_file_time
          OR NEW.job_name IS NOT OLD.job_name
          OR NEW.helper_process_id IS NOT OLD.helper_process_id
          OR NEW.helper_process_started_at_file_time IS NOT OLD.helper_process_started_at_file_time
          OR NEW.created_at <> OLD.created_at
          OR OLD.state = 'completed'
          OR NOT (
            (OLD.state = 'pending' AND NEW.state IN ('pending', 'claimed'))
            OR (OLD.state = 'claimed' AND NEW.state IN ('claimed', 'pending', 'completed', 'quarantined'))
            OR (OLD.state = 'quarantined' AND NEW.state = 'quarantined')
          )
        THEN RAISE(ABORT, 'execution_cleanup_intent_conflict') END;
      END;

      CREATE TRIGGER workbench_execution_cleanup_delete_guard
      BEFORE DELETE ON workbench_execution_cleanup_intents
      WHEN OLD.state <> 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'execution_cleanup_debt_delete_denied');
      END;

      CREATE TRIGGER workbench_execution_recovery_cleanup_delete_guard
      BEFORE DELETE ON workbench_execution_recovery
      WHEN EXISTS (
        SELECT 1 FROM workbench_execution_cleanup_intents cleanup
        WHERE cleanup.execution_id = OLD.execution_id
          AND cleanup.state <> 'completed'
      )
      BEGIN
        SELECT RAISE(ABORT, 'execution_cleanup_debt_delete_denied');
      END;
    `,
  },
  {
    version: 10,
    name: "durable_provider_launch_authorization_receipts",
    sql: `
      CREATE TABLE workbench_launch_authorizations (
        execution_id TEXT NOT NULL,
        launch_generation INTEGER NOT NULL CHECK (launch_generation > 0),
        authorization_id TEXT NOT NULL UNIQUE
          CHECK (length(authorization_id) BETWEEN 16 AND 128
            AND authorization_id NOT GLOB '*[^A-Za-z0-9_.-]*'),
        command_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        job_object_id TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        journal_generation TEXT NOT NULL
          CHECK (length(journal_generation) BETWEEN 22 AND 128
            AND journal_generation NOT GLOB '*[^A-Za-z0-9_-]*'),
        descriptor_hmac_sha256 TEXT NOT NULL
          CHECK (length(descriptor_hmac_sha256) = 64
            AND descriptor_hmac_sha256 NOT GLOB '*[^0-9a-f]*'),
        authorized_at TEXT NOT NULL,
        PRIMARY KEY (execution_id, launch_generation),
        UNIQUE (execution_id, attempt),
        FOREIGN KEY (execution_id, command_id, run_id, job_object_id)
          REFERENCES workbench_execution_recovery(
            execution_id, command_id, run_id, job_object_id
          ) ON DELETE CASCADE
      );

      CREATE INDEX workbench_launch_authorizations_recovery_idx
        ON workbench_launch_authorizations(execution_id, launch_generation DESC);

      CREATE TRIGGER workbench_launch_authorizations_update_guard
      BEFORE UPDATE ON workbench_launch_authorizations
      BEGIN
        SELECT RAISE(ABORT, 'launch_authorization_receipt_immutable');
      END;
    `,
  },
] as const;

export function migrationChecksum(migration: WorkbenchMigration): string {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`, "utf8")
    .digest("hex");
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // A failed BEGIN or auto-rollback leaves no active transaction.
  }
}

function assertMigrationSequence(migrations: readonly WorkbenchMigration[]): void {
  let expected = 1;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version !== expected) {
      throw new WorkbenchMigrationError(
        `Workbench migrations must be contiguous from version 1; expected ${expected}, received ${migration.version}.`,
        { version: migration.version },
      );
    }
    expected += 1;
  }
}

export function applyWorkbenchMigrations(
  db: DatabaseSync,
  migrations: readonly WorkbenchMigration[] = WORKBENCH_MIGRATIONS,
): AppliedWorkbenchMigration[] {
  assertMigrationSequence(migrations);
  let activeMigration: WorkbenchMigration | null = null;
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum_sha256 TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    // Reconciliation is one locked transaction. Concurrent first-open
    // processes therefore reread the committed ledger after waiting instead
    // of applying from a stale snapshot between per-migration transactions.
    const appliedRows = db.prepare(`
      SELECT version, name, checksum_sha256, applied_at
      FROM workbench_schema_migrations ORDER BY version ASC
    `).all() as Array<Record<string, unknown>>;
    const knownVersions = new Set(migrations.map((migration) => migration.version));
    for (const row of appliedRows) {
      const version = Number(row.version);
      if (!knownVersions.has(version)) {
        throw new WorkbenchMigrationError(
          `Database contains unknown Workbench migration version ${version}; refusing to open with older code.`,
          { version },
        );
      }
    }

    const userVersion = Number(
      (db.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version ?? 0,
    );
    const ledgerVersion = appliedRows.length ? Number(appliedRows[appliedRows.length - 1].version) : 0;
    if (userVersion !== ledgerVersion) {
      throw new WorkbenchMigrationError(
        `Workbench schema ledger mismatch: user_version=${userVersion}, ledger=${ledgerVersion}.`,
        { version: ledgerVersion },
      );
    }

    const appliedByVersion = new Map(appliedRows.map((row) => [Number(row.version), row]));
    for (const migration of migrations) {
      activeMigration = migration;
      const checksum = migrationChecksum(migration);
      const applied = appliedByVersion.get(migration.version);
      if (applied) {
        if (String(applied.name) !== migration.name || String(applied.checksum_sha256) !== checksum) {
          throw new WorkbenchMigrationError(
            `Workbench migration ${migration.version} (${migration.name}) checksum drift detected.`,
            { version: migration.version },
          );
        }
        continue;
      }

      const appliedAt = new Date().toISOString();
      db.exec(migration.sql);
      db.prepare(`
        INSERT INTO workbench_schema_migrations (version, name, checksum_sha256, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(migration.version, migration.name, checksum, appliedAt);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }

    const result = db.prepare(`
      SELECT version, name, checksum_sha256 AS checksumSha256, applied_at AS appliedAt
      FROM workbench_schema_migrations ORDER BY version ASC
    `).all() as unknown as AppliedWorkbenchMigration[];
    db.exec("COMMIT");
    return result;
  } catch (error) {
    rollbackQuietly(db);
    if (error instanceof WorkbenchMigrationError) throw error;
    if (activeMigration) {
      throw new WorkbenchMigrationError(
        `Workbench migration ${activeMigration.version} (${activeMigration.name}) failed; database transaction rolled back.`,
        { version: activeMigration.version, cause: error },
      );
    }
    throw new WorkbenchMigrationError("Failed to reconcile Workbench migration ledger.", { cause: error });
  }
}
