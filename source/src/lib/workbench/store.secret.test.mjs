import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const sourceRoot = process.cwd();
const scratchRoot = path.resolve(sourceRoot, ".tmp", "wave1-secret-store-tests");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export default undefined" };
    }
    let candidate = null;
    if (specifier.startsWith("@/")) {
      candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
    } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      candidate = new URL(specifier, context.parentURL);
      candidate = decodeURIComponent(candidate.pathname).replace(/^\/(?=[A-Za-z]:\/)/u, "");
    }
    if (candidate) {
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const { WorkbenchStore } = await import("./store.ts");
const { serializeRedactedJson } = await import("./redaction.ts");

const SENTINELS = [
  "WAVE1_META_8kQ2mN7vR4xP9zL6",
  "WAVE1_EVENT_4pL8nQ2vX7zK9mR5",
  "WAVE1_MESSAGE_7vN3qR9xK2mT8zP4",
  "WAVE1_DRAFT_5mQ9xL2vR7kN4zT8",
  "WAVE1_APPROVAL_6zK2pN8vR4xQ9mL7",
  "WAVE1_ERROR_9xR3mK7vQ2pL8zN4",
];

function context() {
  return {
    agentId: "codex",
    actorId: "codex",
    projectId: "wave1-scratch",
    sessionId: null,
    environment: "local",
    panel: "transcript",
  };
}

function rawDatabaseText(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = [
      "workbench_runs",
      "workbench_events",
      "workbench_approvals",
      "workbench_queued_messages",
      "workbench_drafts",
    ];
    return tables.map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).join("\n");
  } finally {
    db.close();
  }
}

test("Workbench scratch storage and response/export DTOs never retain sentinel secrets", () => {
  mkdirSync(scratchRoot, { recursive: true });
  const databasePath = path.join(scratchRoot, `workbench-secrets-${process.pid}-${Date.now()}.sqlite3`);
  const store = new WorkbenchStore(databasePath);
  try {
    const run = store.createRun({
      adapterId: "codex",
      provider: "codex",
      context: context(),
      title: `metadata secret=${SENTINELS[0]}`,
      metadata: {
        env: { UNKNOWN_RUNTIME_BLOB: SENTINELS[0], LANG: "he_IL.UTF-8" },
        argv: ["codex", "--token", SENTINELS[0], "--profile", "safe"],
        output: `https://user:${SENTINELS[0]}@example.test/run?token=${SENTINELS[0]}`,
        toolArgs: { password: SENTINELS[0], target: "desktop" },
        artifact: { uri: `https://example.test/file?signature=${SENTINELS[0]}` },
      },
    });
    const event = store.appendEvent(run.id, "tool", {
      stdout: `Cookie: session=${SENTINELS[1]}`,
      stderr: `OPAQUE_EVENT_BLOB=${SENTINELS[1]}`,
      args: ["--client-secret", SENTINELS[1], "--mode", "safe"],
    });
    const message = store.enqueueMessage(run.id, "queue", `password=${SENTINELS[2]}`);
    const draft = store.saveDraft("wave1-draft", context(), `api_key=\n${SENTINELS[3]}`);
    const approval = store.createApproval(
      run.id,
      "high",
      `authorization=Bearer ${SENTINELS[4]}`,
      `tool --token ${SENTINELS[4]} --target safe`,
    );
    const failed = store.updateRun(run.id, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: { code: "provider_failed", message: `credential=${SENTINELS[5]}` },
    });

    const readModels = {
      run: store.getRun(run.id),
      event: store.eventsAfter(run.id),
      message: store.pendingMessages(run.id),
      draft: store.getDraft(draft.id),
      approval: store.getApproval(approval.id),
      failed,
      directReturns: { event, message, draft, approval },
    };
    const responseAndExport = serializeRedactedJson(readModels, 2);
    const stored = rawDatabaseText(databasePath);
    for (const sentinel of SENTINELS) {
      assert.equal(stored.includes(sentinel), false, `raw SQLite storage leaked ${sentinel}`);
      assert.equal(responseAndExport.includes(sentinel), false, `response/export DTO leaked ${sentinel}`);
    }
    assert.match(stored, /he_IL\.UTF-8/u);
    assert.match(stored, /desktop/u);
    assert.match(responseAndExport, /safe/u);
  } finally {
    store.close();
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
  }
});
