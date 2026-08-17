import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import path from "node:path";

const liveEnabled = process.env.AGENT_OS_RUN_LIVE_PROVIDER_TESTS === "1";
const providerFilter = process.env.WAVE3_LIVE_PROVIDER_FILTER || null;
const port = Number(process.env.WAVE3_RESTART_PORT ?? "3113");
const origin = `http://127.0.0.1:${port}`;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "orphaned", "blocked"]);

type Provider = "codex" | "claude";
type LiveRun = {
  id: string;
  provider: Provider;
  status: string;
  pid: number | null;
  context: { projectId: string; sessionId: string | null; environment: "local" | "worktree" };
  error: { code: string; message: string } | null;
};

function bootstrapSecret(): string {
  const secret = process.env.AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET;
  if (!secret) throw new Error("Live restart pilot requires an ephemeral Workbench bootstrap secret.");
  return secret;
}

function portOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function waitForPort(expectedOpen: boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await portOpen() === expectedOpen) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${origin} to become ${expectedOpen ? "available" : "closed"}.`);
}

async function startServer(): Promise<ChildProcessWithoutNullStreams> {
  if (await portOpen()) throw new Error(`Restart pilot refuses to reuse occupied port ${port}.`);
  const nextCli = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const server = spawn(process.execPath, [nextCli, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let recentOutput = "";
  const retain = (chunk: Buffer | string) => {
    recentOutput = `${recentOutput}${String(chunk)}`.slice(-16_384);
  };
  server.stdout.on("data", retain);
  server.stderr.on("data", retain);
  try {
    await waitForPort(true);
  } catch (error) {
    throw new Error(`${String(error)} Server exit=${server.exitCode ?? "running"}. Output=${recentOutput}`);
  }
  return server;
}

async function stopServer(server: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!server) return;
  if (server.exitCode === null) server.kill();
  const deadline = Date.now() + 15_000;
  while (server.exitCode === null && Date.now() <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (server.exitCode === null) server.kill("SIGKILL");
  await waitForPort(false);
}

async function bootstrap(client: APIRequestContext): Promise<void> {
  const response = await client.post("/api/workbench/session", {
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Agent-OS-Bootstrap-Token": bootstrapSecret(),
    },
    data: {},
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function openClient(): Promise<APIRequestContext> {
  const client = await playwrightRequest.newContext({ baseURL: origin });
  await bootstrap(client);
  return client;
}

async function rotate(client: APIRequestContext): Promise<void> {
  const response = await client.get("/api/workbench/session", { headers: { Origin: origin } });
  expect(response.status(), await response.text()).toBe(200);
}

function startBody(provider: Provider, prompt: string, idempotencyKey: string, sessionId: string | null) {
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
  client: APIRequestContext,
  provider: Provider,
  prompt: string,
  sessionId: string | null,
): Promise<LiveRun> {
  await rotate(client);
  const idempotencyKey = `wave3-restart-${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await client.post("/api/workbench/runs", {
    headers: { Origin: origin, "Content-Type": "application/json" },
    data: startBody(provider, prompt, idempotencyKey, sessionId),
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).run as LiveRun;
}

async function snapshot(client: APIRequestContext, runId: string) {
  const response = await client.get(`/api/workbench/runs/${encodeURIComponent(runId)}`);
  expect(response.status(), await response.text()).toBe(200);
  return await response.json() as {
    run: LiveRun;
    stop: { state: string; verified: boolean };
  };
}

async function waitFor(
  client: APIRequestContext,
  runId: string,
  predicate: (value: Awaited<ReturnType<typeof snapshot>>) => boolean,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last = await snapshot(client, runId);
  while (Date.now() <= deadline) {
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
    last = await snapshot(client, runId);
  }
  throw new Error(`Timed out waiting for live run ${runId}; last status=${last.run.status}; code=${last.run.error?.code ?? "none"}`);
}

type StreamedEvent = {
  sequence?: number;
  type?: string;
  payload?: { role?: string; text?: string };
};

/**
 * The assistant transcript as a reader would see it: assistant message chunks
 * concatenated in sequence order. A provider streams one event per chunk, so a
 * marker legitimately arrives split across frames; joining the raw SSE frames
 * with newlines would fail on the framing rather than on the provider's answer.
 */
async function assistantTranscript(client: APIRequestContext, runId: string): Promise<string> {
  const response = await client.get(`/api/workbench/runs/${encodeURIComponent(runId)}/events?after=0`, {
    headers: { Origin: origin },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.text())
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "))
    .flatMap((line) => {
      try {
        return [JSON.parse(line.slice(6)) as StreamedEvent];
      } catch {
        return [];
      }
    })
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
    .filter((event) => event.type === "message" && event.payload?.role === "assistant")
    .map((event) => event.payload?.text ?? "")
    .join("");
}

async function cancelRun(client: APIRequestContext, provider: Provider, run: LiveRun): Promise<void> {
  await rotate(client);
  const response = await client.post(`/api/workbench/runs/${encodeURIComponent(run.id)}/cancel`, {
    headers: { Origin: origin, "Content-Type": "application/json" },
    data: {
      identity: {
        actorId: provider,
        projectId: run.context.projectId,
        worktreeId: run.context.environment,
        provider,
        profileId: null,
        nativeSessionId: run.context.sessionId,
        runId: run.id,
      },
    },
  });
  expect([200, 202]).toContain(response.status());
}

test.describe("Wave 3 live provider restart pilot", () => {
  test.skip(!liveEnabled, "Explicit live-provider gate is required.");
  test.setTimeout(12 * 60_000);

  for (const provider of ["codex", "claude"] as const) {
    test(`${provider}: live restart preserves native resume and verified active-process cancel`, async () => {
      test.skip(providerFilter !== null && providerFilter !== provider, `Filtered to ${providerFilter}.`);
      let server: ChildProcessWithoutNullStreams | null = null;
      let client: APIRequestContext | null = null;
      let activeRun: LiveRun | null = null;
      try {
        server = await startServer();
        client = await openClient();

        const startMarker = `${provider.toUpperCase()}_LIVE_RESTART_START_OK`;
        const start = await createRun(client, provider, `Reply with exactly ${startMarker} and nothing else.`, null);
        const startTerminal = await waitFor(client, start.id, (value) => TERMINAL.has(value.run.status));
        expect(startTerminal.run.error?.message ?? "", JSON.stringify(startTerminal.run.error)).toBe("");
        expect(startTerminal.run.status).toBe("succeeded");
        expect(startTerminal.run.context.sessionId).toBeTruthy();
        expect(await assistantTranscript(client, start.id)).toContain(startMarker);

        await client.dispose();
        client = null;
        await stopServer(server);
        server = await startServer();
        client = await openClient();

        const resumeMarker = `${provider.toUpperCase()}_LIVE_RESTART_RESUME_OK`;
        const resume = await createRun(
          client,
          provider,
          `Reply with exactly ${resumeMarker} and nothing else.`,
          startTerminal.run.context.sessionId,
        );
        const resumeTerminal = await waitFor(client, resume.id, (value) => TERMINAL.has(value.run.status));
        expect(resumeTerminal.run.error?.message ?? "", JSON.stringify(resumeTerminal.run.error)).toBe("");
        expect(resumeTerminal.run.status).toBe("succeeded");
        expect(resumeTerminal.run.context.sessionId).toBe(startTerminal.run.context.sessionId);
        expect(await assistantTranscript(client, resume.id)).toContain(resumeMarker);

        activeRun = await createRun(
          client,
          provider,
          "Without using tools, emit the integers from 1 through 100000 one per line, and do not summarize.",
          null,
        );
        const active = await waitFor(client, activeRun.id, (value) => value.run.status === "running" && value.run.pid !== null, 60_000);
        expect(active.run.pid).not.toBeNull();

        await client.dispose();
        client = null;
        await stopServer(server);
        server = await startServer();
        client = await openClient();

        const interrupted = await waitFor(
          client,
          activeRun.id,
          (value) => TERMINAL.has(value.run.status),
          60_000,
        );
        expect(interrupted.run.status).toBe("blocked");
        expect(interrupted.run.error).toEqual({
          code: "windows_job_blocked",
          message: "Control-plane parent exited before Windows Job completion.",
        });
        expect(interrupted.run.pid).toBeNull();
        expect(interrupted.stop).toEqual({ state: "not_requested", verified: false });
        activeRun = null;

        activeRun = await createRun(
          client,
          provider,
          "Without using tools, emit the integers from 1 through 100000 one per line, and do not summarize.",
          null,
        );
        const cancelTarget = await waitFor(
          client,
          activeRun.id,
          (value) => value.run.status === "running" && value.run.pid !== null,
          60_000,
        );
        expect(cancelTarget.run.pid).not.toBeNull();
        await cancelRun(client, provider, activeRun);
        const cancelled = await waitFor(client, activeRun.id, (value) => value.run.status === "cancelled", 60_000);
        expect(cancelled.run.pid).toBeNull();
        expect(cancelled.stop).toEqual({ state: "stopped_and_verified", verified: true });
        activeRun = null;
      } finally {
        if (activeRun && client) {
          try {
            const current = await snapshot(client, activeRun.id);
            if (!TERMINAL.has(current.run.status)) {
              await cancelRun(client, provider, activeRun);
              await waitFor(client, activeRun.id, (value) => TERMINAL.has(value.run.status), 60_000);
            }
          } catch {
            // Preserve original test failure; durable startup recovery handles any unresolved run.
          }
        }
        await client?.dispose();
        await stopServer(server);
      }
    });
  }
});
