import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const sourceRoot = process.cwd();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      const candidate = decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:\/)/u, "");
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const {
  WorkbenchClientError,
  buildWorkbenchStartPayload,
  cancelWorkbenchRun,
  describeWorkbenchError,
  isVerifiedCancellation,
  startWorkbenchRun,
  watchWorkbenchRun,
  workbenchProjectId,
  workbenchRunLabel,
} = await import("./uiClient.ts");

function run(overrides = {}) {
  return {
    id: "run-12345678",
    adapterId: "codex",
    provider: "codex",
    context: {
      agentId: "codex",
      actorId: "codex",
      projectId: "project-1",
      sessionId: null,
      environment: "local",
      panel: "transcript",
    },
    title: null,
    status: "running",
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    startedAt: "2026-08-14T00:00:00.000Z",
    finishedAt: null,
    pid: 123,
    error: null,
    metadata: {},
    ...overrides,
  };
}

test("builds canonical start identity for Codex", () => {
  const payload = buildWorkbenchStartPayload({
    agentId: "codex",
    prompt: "  inspect VERSION  ",
    projectId: "agent-os",
    // JavaScript callers cannot smuggle provider choices into the restricted pilot.
    options: { engine: "gpt56", effort: "high" },
  }, { randomUUID: () => "fixed-id" });

  assert.deepEqual(payload, {
    agentId: "codex",
    prompt: "inspect VERSION",
    idempotencyKey: "codex-fixed-id",
    context: {
      agentId: "codex",
      actorId: "codex",
      projectId: "agent-os",
      sessionId: null,
      environment: "local",
      panel: "transcript",
    },
    identity: {
      actorId: "codex",
      projectId: "agent-os",
      worktreeId: "local",
      provider: "codex",
      profileId: null,
      nativeSessionId: null,
      runId: "codex-fixed-id",
    },
  });
});

test("uses server-owned default project and binds resume identity", () => {
  const payload = buildWorkbenchStartPayload({
    agentId: "claude",
    prompt: "continue",
    sessionId: "native-session",
    idempotencyKey: "claude-command",
  });

  assert.equal(workbenchProjectId("claude", null), "claude-default");
  assert.equal(payload.context.projectId, "claude-default");
  assert.equal(payload.context.sessionId, "native-session");
  assert.equal(payload.identity.nativeSessionId, "native-session");
  assert.equal(payload.identity.runId, "claude-command");
});

test("rotates session before every start mutation", async () => {
  const calls = [];
  const fakeRun = run();
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url === "/api/workbench/session") {
      return new Response(JSON.stringify({ session: { mutationTokenReady: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      run: fakeRun,
      commandId: "command-1",
      created: true,
      operation: "start",
    }), { status: 201, headers: { "content-type": "application/json" } });
  };

  await startWorkbenchRun({
    agentId: "codex",
    prompt: "hello",
    projectId: "project-1",
    idempotencyKey: "command-1",
  }, undefined, { fetch: fetcher });

  assert.deepEqual(calls.map((call) => [call.url, call.init.method]), [
    ["/api/workbench/session", "GET"],
    ["/api/workbench/runs", "POST"],
  ]);
  assert.equal(calls[1].init.credentials, "same-origin");
  assert.equal(JSON.parse(calls[1].init.body).identity.actorId, "codex");
});

test("streams output and resolves only after terminal run refresh", async () => {
  const listeners = new Map();
  let closed = false;
  const outputs = [];
  const finalRun = run({ status: "succeeded", finishedAt: "2026-08-14T00:00:01.000Z" });
  const source = {
    close() { closed = true; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    onerror: null,
  };
  const promise = watchWorkbenchRun(run(), {
    onOutput(text) { outputs.push(text); },
  }, undefined, {
    eventSource: () => source,
    fetch: async () => new Response(JSON.stringify({
      run: finalRun,
      stop: { state: "not_requested", verified: false },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  listeners.get("terminal")({ data: JSON.stringify({
    id: "event-1",
    sequence: 1,
    runId: finalRun.id,
    type: "terminal",
    createdAt: finalRun.updatedAt,
    payload: { channel: "stdout", text: "answer", executionId: "exec-1" },
  }) });
  listeners.get("status")({ data: JSON.stringify({
    id: "event-2",
    sequence: 2,
    runId: finalRun.id,
    type: "status",
    createdAt: finalRun.updatedAt,
    payload: { status: "succeeded" },
  }) });

  const snapshot = await promise;
  assert.deepEqual(outputs, ["answer"]);
  assert.equal(snapshot.run.status, "succeeded");
  assert.equal(closed, true);
});

test("cancel waits for cancelled and verified process-tree termination", async () => {
  const running = run();
  const stopping = {
    run: { ...running, status: "stopping" },
    stop: { state: "stopping", verified: false },
  };
  const verified = {
    run: { ...running, status: "cancelled", finishedAt: "2026-08-14T00:00:02.000Z" },
    stop: { state: "stopped_and_verified", verified: true },
  };
  let getCount = 0;
  const snapshots = [];
  const fetcher = async (url, init) => {
    if (url === "/api/workbench/session") {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).endsWith("/cancel")) {
      const identity = JSON.parse(init.body).identity;
      assert.equal(identity.runId, running.id);
      assert.equal(identity.actorId, "codex");
      return new Response(JSON.stringify({ run: stopping.run }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
    getCount += 1;
    const body = getCount === 1 ? stopping : verified;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await cancelWorkbenchRun(running, (snapshot) => snapshots.push(snapshot), undefined, {
    fetch: fetcher,
    now: () => 0,
    wait: async () => {},
  });

  assert.equal(snapshots.length, 2);
  assert.equal(isVerifiedCancellation(result), true);
  assert.equal(workbenchRunLabel(result.run, result.stop.state), "Stopped · verified");
});

test("classified errors keep next action and draft state visible", () => {
  const error = new WorkbenchClientError({
    error: "Weekly quota reached.",
    code: "provider_quota",
    category: "quota",
    runCreated: false,
    retrySafe: false,
    nextAction: "Wait for quota reset.",
  });
  const text = describeWorkbenchError(error);
  assert.match(text, /\[quota\]/u);
  assert.match(text, /Wait for quota reset/u);
  assert.match(text, /draft was kept/u);
});
