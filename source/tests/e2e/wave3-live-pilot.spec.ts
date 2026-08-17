import { expect, test, type APIRequestContext } from "@playwright/test";

const liveEnabled = process.env.AGENT_OS_RUN_LIVE_PROVIDER_TESTS === "1";
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "orphaned", "blocked"]);

function bootstrapSecret(): string {
  const secret = process.env.AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET;
  if (!secret) throw new Error("Live pilot requires an ephemeral Workbench bootstrap secret.");
  return secret;
}

async function bootstrap(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.post("/api/workbench/session", {
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Agent-OS-Bootstrap-Token": bootstrapSecret(),
    },
    data: {},
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function rotate(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.get("/api/workbench/session", { headers: { Origin: origin } });
  expect(response.status(), await response.text()).toBe(200);
}

function startBody(provider: "codex" | "claude", prompt: string, idempotencyKey: string, sessionId: string | null) {
  const projectId = `${provider}-default`;
  return {
    agentId: provider,
    prompt,
    idempotencyKey,
    context: {
      actorId: provider,
      projectId,
      sessionId,
      environment: "local",
      panel: "transcript",
    },
    identity: {
      actorId: provider,
      projectId,
      worktreeId: "local",
      provider,
      profileId: null,
      nativeSessionId: sessionId,
      runId: idempotencyKey,
    },
  };
}

async function createRun(
  request: APIRequestContext,
  origin: string,
  provider: "codex" | "claude",
  prompt: string,
  sessionId: string | null,
) {
  const idempotencyKey = `wave3-live-${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await request.post("/api/workbench/runs", {
    headers: { Origin: origin, "Content-Type": "application/json" },
    data: startBody(provider, prompt, idempotencyKey, sessionId),
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).run as {
    id: string;
    provider: string;
    status: string;
    pid: number | null;
    context: { projectId: string; sessionId: string | null; environment: "local" | "worktree" };
    error: { code: string; message: string } | null;
  };
}

async function snapshot(request: APIRequestContext, runId: string) {
  const response = await request.get(`/api/workbench/runs/${encodeURIComponent(runId)}`);
  expect(response.status(), await response.text()).toBe(200);
  return await response.json() as {
    run: {
      id: string;
      provider: "codex" | "claude";
      status: string;
      pid: number | null;
      context: { projectId: string; sessionId: string | null; environment: "local" | "worktree" };
      error: { code: string; message: string } | null;
    };
    stop: { state: string; verified: boolean };
  };
}

async function waitFor(
  request: APIRequestContext,
  runId: string,
  predicate: (value: Awaited<ReturnType<typeof snapshot>>) => boolean,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last = await snapshot(request, runId);
  while (Date.now() <= deadline) {
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
    last = await snapshot(request, runId);
  }
  throw new Error(`Timed out waiting for live run ${runId}; last status=${last.run.status}; code=${last.run.error?.code ?? "none"}`);
}

async function terminalOutput(request: APIRequestContext, origin: string, runId: string): Promise<string> {
  const response = await request.get(`/api/workbench/runs/${encodeURIComponent(runId)}/events?after=0`, {
    headers: { Origin: origin },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.text())
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .join("\n");
}

test.describe("Wave 3 current live provider pilot", () => {
  test.skip(!liveEnabled, "Explicit live-provider gate is required.");
  test.setTimeout(8 * 60_000);

  for (const provider of ["codex", "claude"] as const) {
    test(`${provider}: live start, native resume, and verified active-process cancel`, async ({ request, baseURL }) => {
      const origin = new URL(baseURL!).origin;
      await bootstrap(request, origin);

      const startMarker = `${provider.toUpperCase()}_LIVE_START_OK`;
      const start = await createRun(request, origin, provider, `Reply with exactly ${startMarker} and nothing else.`, null);
      const startTerminal = await waitFor(request, start.id, (value) => TERMINAL.has(value.run.status));
      expect(startTerminal.run.error?.message ?? "", JSON.stringify(startTerminal.run.error)).toBe("");
      expect(startTerminal.run.status).toBe("succeeded");
      expect(startTerminal.run.context.sessionId).toBeTruthy();
      expect(await terminalOutput(request, origin, start.id)).toContain(startMarker);

      await rotate(request, origin);
      const resumeMarker = `${provider.toUpperCase()}_LIVE_RESUME_OK`;
      const resume = await createRun(
        request,
        origin,
        provider,
        `Reply with exactly ${resumeMarker} and nothing else.`,
        startTerminal.run.context.sessionId,
      );
      const resumeTerminal = await waitFor(request, resume.id, (value) => TERMINAL.has(value.run.status));
      expect(resumeTerminal.run.error?.message ?? "", JSON.stringify(resumeTerminal.run.error)).toBe("");
      expect(resumeTerminal.run.status).toBe("succeeded");
      expect(resumeTerminal.run.context.sessionId).toBe(startTerminal.run.context.sessionId);
      expect(await terminalOutput(request, origin, resume.id)).toContain(resumeMarker);

      await rotate(request, origin);
      const cancelRun = await createRun(
        request,
        origin,
        provider,
        "Without using tools, emit the integers from 1 through 100000 one per line, and do not summarize.",
        null,
      );
      const active = await waitFor(request, cancelRun.id, (value) => value.run.status === "running" && value.run.pid !== null, 60_000);
      expect(active.run.pid).not.toBeNull();

      await rotate(request, origin);
      const cancel = await request.post(`/api/workbench/runs/${encodeURIComponent(cancelRun.id)}/cancel`, {
        headers: { Origin: origin, "Content-Type": "application/json" },
        data: {
          identity: {
            actorId: provider,
            projectId: cancelRun.context.projectId,
            worktreeId: cancelRun.context.environment,
            provider,
            profileId: null,
            nativeSessionId: cancelRun.context.sessionId,
            runId: cancelRun.id,
          },
        },
      });
      expect([200, 202]).toContain(cancel.status());
      const cancelled = await waitFor(request, cancelRun.id, (value) => value.run.status === "cancelled", 60_000);
      expect(cancelled.run.pid).toBeNull();
      expect(cancelled.stop).toEqual({ state: "stopped_and_verified", verified: true });
    });
  }
});
