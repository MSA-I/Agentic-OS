import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = process.cwd();

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

const { createControlPlaneIdentity } = await import("../control-plane/identity.ts");
const { ControlPlaneCommandDeniedError } = await import("../control-plane/executionFreeze.ts");
const { RunSupervisor } = await import("./supervisor.ts");

function commandIdentity(overrides = {}) {
  return createControlPlaneIdentity({
    callerSessionId: "browser-session",
    actorId: "codex",
    projectId: "project-alpha",
    worktreeId: "local",
    provider: "codex",
    profileId: null,
    nativeSessionId: null,
    runId: "pending-run",
    ...overrides,
  });
}

function createInput() {
  return {
    adapterId: "codex",
    provider: "codex",
    context: {
      agentId: "codex",
      actorId: "codex",
      projectId: "project-alpha",
      sessionId: null,
      environment: "local",
      panel: "transcript",
    },
    title: null,
    metadata: {},
  };
}

test("create denies before store.createRun or adapter execution", async () => {
  let createRunCalls = 0;
  const store = {
    orphanActiveRuns: () => [],
    createRun: () => { createRunCalls += 1; throw new Error("side effect reached"); },
  };
  const supervisor = new RunSupervisor(store);
  await assert.rejects(
    supervisor.create(createInput(), commandIdentity()),
    (error) => error instanceof ControlPlaneCommandDeniedError
      && error.code === "control_plane_execution_unavailable",
  );
  assert.equal(createRunCalls, 0);
});

test("actor or project mismatch denies with no run created", async () => {
  let createRunCalls = 0;
  const store = {
    orphanActiveRuns: () => [],
    createRun: () => { createRunCalls += 1; throw new Error("side effect reached"); },
  };
  const supervisor = new RunSupervisor(store);
  for (const identity of [commandIdentity({ actorId: "other" }), commandIdentity({ projectId: "other" })]) {
    await assert.rejects(
      supervisor.create(createInput(), identity),
      (error) => error instanceof ControlPlaneCommandDeniedError
        && error.code === "identity_mismatch",
    );
  }
  assert.equal(createRunCalls, 0);
});

test("steer, approval, cancel, tool request, and process registration deny before side effects", async () => {
  let enqueueCalls = 0;
  let approvalCalls = 0;
  let updateCalls = 0;
  const run = {
    id: "run-1",
    adapterId: "codex",
    provider: "codex",
    context: { agentId: "codex", actorId: "codex", projectId: "project-alpha", sessionId: null, environment: "local", panel: "transcript" },
    title: null,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    pid: null,
    error: null,
    metadata: {},
  };
  const store = {
    orphanActiveRuns: () => [],
    getRun: () => run,
    enqueueMessage: () => { enqueueCalls += 1; throw new Error("side effect reached"); },
    createApproval: () => { approvalCalls += 1; throw new Error("side effect reached"); },
    updateRun: () => { updateCalls += 1; throw new Error("side effect reached"); },
  };
  const supervisor = new RunSupervisor(store);
  const identity = commandIdentity({ runId: run.id });
  await assert.rejects(supervisor.message(run.id, "steer", "hello", identity), ControlPlaneCommandDeniedError);
  await assert.rejects(supervisor.cancel(run.id, identity), ControlPlaneCommandDeniedError);
  await assert.rejects(supervisor.decideApproval(run.id, "approval-1", "deny", identity), ControlPlaneCommandDeniedError);
  assert.throws(() => supervisor.requestApproval(run.id, "high", "summary", "redacted", identity), ControlPlaneCommandDeniedError);
  assert.throws(() => supervisor.registerProcess(run.id, { pid: 1234 }, identity), ControlPlaneCommandDeniedError);
  assert.equal(enqueueCalls, 0);
  assert.equal(approvalCalls, 0);
  assert.equal(updateCalls, 0);
});

test("blocked uses the shared terminal contract and clears process state", () => {
  const timestamp = new Date().toISOString();
  let run = {
    id: "blocked-run",
    adapterId: "codex",
    provider: "codex",
    context: { agentId: "codex", actorId: "codex", projectId: "project-alpha", sessionId: null, environment: "local", panel: "transcript" },
    title: null,
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: null,
    pid: 12_345,
    error: null,
    metadata: {},
  };
  const events = [];
  const store = {
    orphanActiveRuns: () => [],
    getRun: () => run,
    updateRun: (_id, patch) => {
      run = { ...run, ...patch };
      return run;
    },
    appendEvent: (runId, type, payload) => {
      const event = { id: `event-${events.length + 1}`, sequence: events.length + 1, runId, type, createdAt: timestamp, payload };
      events.push(event);
      return event;
    },
  };
  const supervisor = new RunSupervisor(store);
  const blocked = supervisor.setStatus("blocked-run", "blocked", {
    code: "provider_quota",
    message: "Provider quota blocked execution.",
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.pid, null);
  assert.ok(blocked.finishedAt);
  assert.ok(events.some((event) => event.type === "status" && event.payload.status === "blocked"));
});

test("orphaned is resumable and does not close SSE before a real terminal event", async () => {
  const timestamp = new Date().toISOString();
  const run = {
    id: "orphaned-stream-run",
    adapterId: "codex",
    provider: "codex",
    context: { agentId: "codex", actorId: "codex", projectId: "project-alpha", sessionId: null, environment: "local", panel: "transcript" },
    title: null,
    status: "orphaned",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: null,
    pid: null,
    error: { code: "supervisor_restarted", message: "Restarted" },
    metadata: {},
  };
  const pageEvents = [
    { id: "event-1", sequence: 1, runId: run.id, type: "status", createdAt: timestamp, payload: { status: "orphaned" } },
    { id: "event-2", sequence: 2, runId: run.id, type: "status", createdAt: timestamp, payload: { status: "succeeded" } },
  ];
  const store = {
    orphanActiveRuns: () => [],
    getRun: () => run,
    eventPage: () => ({
      events: pageEvents,
      nextCursor: 2,
      hasMore: false,
      gap: null,
      bounds: {
        firstSequence: 1,
        lastSequence: 2,
        compactedThroughSequence: 0,
        snapshotSequence: 0,
        snapshot: {},
        retainedCount: 2,
      },
    }),
  };
  const supervisor = new RunSupervisor(store);
  const reader = supervisor.subscribe(run.id, 0).getReader();
  const first = await reader.read();
  const second = await reader.read();
  const done = await reader.read();
  const decoder = new TextDecoder();
  assert.equal(first.done, false);
  assert.match(decoder.decode(first.value), /"status":"orphaned"/u);
  assert.equal(second.done, false);
  assert.match(decoder.decode(second.value), /"status":"succeeded"/u);
  assert.equal(done.done, true);
});
