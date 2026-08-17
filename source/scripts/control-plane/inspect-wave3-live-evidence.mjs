import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const sourceRoot = process.cwd();
const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
const limit = Number(limitArgument?.slice("--limit=".length) ?? "32");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
  throw new Error("--limit must be an integer from 1 through 100.");
}
const envPath = path.join(sourceRoot, ".env.local");
const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const configuredRoot = envText.match(/^AGENTIC_OS_FOLDERS_ROOT=(.*)$/mu)?.[1]
  ?.trim()
  .replace(/^['"]|['"]$/gu, "");
const foldersRoot = path.resolve(
  configuredRoot || path.join(os.homedir(), ".agentic-os", "folders"),
);
const databasePath = path.join(foldersRoot, "AGENT_OS", "data", "workbench.sqlite3");

if (!existsSync(databasePath)) {
  throw new Error("Workbench database is unavailable at the configured server-owned folders root.");
}

const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const runs = database.prepare(`
    SELECT
      id,
      provider,
      status,
      project_id AS projectId,
      session_id AS nativeSessionId,
      pid,
      error_code AS errorCode,
      error_message AS errorMessage,
      created_at AS createdAt,
      started_at AS startedAt,
      finished_at AS finishedAt
    FROM workbench_runs
    WHERE provider IN ('codex', 'claude')
      AND json_extract(metadata_json, '$.pilotWave') = 3
    ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);

  const commandStatement = database.prepare(`
    SELECT
      command_type AS commandType,
      state,
      checkpoint,
      provider_attempt_count AS providerAttemptCount,
      json_extract(outcome_json, '$.status') AS outcomeStatus,
      json_extract(outcome_json, '$.metadata.terminationVerified') AS terminationVerified
    FROM workbench_outbox
    WHERE run_id = ?
    ORDER BY created_at ASC
  `);
  const eventStatement = database.prepare(`
    SELECT COUNT(*) AS eventCount, MAX(sequence) AS maximumSequence
    FROM workbench_events
    WHERE run_id = ?
  `);

  const evidence = runs.map((run) => ({
    ...run,
    commands: commandStatement.all(run.id),
    events: eventStatement.get(run.id),
  }));
  const databaseStat = statSync(databasePath);
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    evidenceLevel: "live-runtime",
    observedAt: new Date().toISOString(),
    database: {
      bytes: databaseStat.size,
      modifiedAt: databaseStat.mtime.toISOString(),
    },
    runs: evidence,
  }, null, 2));
} finally {
  database.close();
}
