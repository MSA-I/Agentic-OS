import { expect, test, type APIRequestContext } from "@playwright/test";

function bootstrapSecret(): string {
  const secret = process.env.AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET;
  if (!secret) throw new Error("AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET is required for Workbench API tests.");
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

async function runCount(request: APIRequestContext): Promise<number> {
  const response = await request.get("/api/workbench/runs?limit=100");
  expect(response.status()).toBe(200);
  return ((await response.json()).runs ?? []).length;
}

async function rotate(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.get("/api/workbench/session", { headers: { Origin: origin } });
  expect(response.status(), await response.text()).toBe(200);
}

test.describe("Wave 3 Workbench HTTP contract", () => {
  test("advertises only the restricted pilot and rejects option/identity overrides before a run", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const headers = { Origin: origin, "Content-Type": "application/json" };
    await bootstrap(request, origin);

    const listResponse = await request.get("/api/workbench/runs?limit=5");
    expect(listResponse.status()).toBe(200);
    const list = await listResponse.json();
    for (const provider of ["codex", "claude"] as const) {
      const descriptor = list.agents.find((agent: { id: string }) => agent.id === provider);
      expect(descriptor.capabilities.start.status).toBe("supported");
      expect(descriptor.capabilities.resume.status).toBe("supported");
      expect(descriptor.capabilities.cancel.status).toBe("supported");
      expect(descriptor.capabilities.queue.status).toBe("unsupported");
    }
    for (const provider of ["hermes", "openclaw", "antigravity"] as const) {
      expect(list.agents.find((agent: { id: string }) => agent.id === provider).capabilities.start.status).toBe("unsupported");
    }

    const before = await runCount(request);
    const overrideKey = `http-options-${Date.now()}`;
    const override = await request.post("/api/workbench/runs", {
      headers,
      data: {
        agentId: "codex",
        prompt: "must not execute",
        idempotencyKey: overrideKey,
        options: { model: "caller-owned-model" },
        context: { actorId: "codex", projectId: "agent-os/project-a", environment: "local" },
      },
    });
    expect(override.status()).toBe(400);
    await rotate(request, origin);

    const mismatchKey = `http-identity-${Date.now()}`;
    const mismatch = await request.post("/api/workbench/runs", {
      headers,
      data: {
        agentId: "codex",
        prompt: "must not execute",
        idempotencyKey: mismatchKey,
        context: { actorId: "codex", projectId: "agent-os/project-a", environment: "local" },
        identity: {
          actorId: "different-actor",
          projectId: "agent-os/project-a",
          worktreeId: "local",
          provider: "codex",
          profileId: null,
          nativeSessionId: null,
          runId: mismatchKey,
        },
      },
    });
    expect(mismatch.status()).toBe(409);
    expect(await runCount(request)).toBe(before);
  });

  test("legacy content and lifecycle routes are read-only", async ({ request }) => {
    for (const route of [
      "/api/codex/chats",
      "/api/codex/goals",
      "/api/codex/workspace",
      "/api/claude/workspace",
      "/api/claude/ultracode",
    ]) {
      const response = await request.post(route, {
        headers: { "Content-Type": "application/json" },
        data: { prompt: "must-not-persist", name: "must-not-create", action: "stop", id: "missing" },
      });
      expect(response.status(), `${route}: ${await response.text()}`).toBe(405);
    }

    const chats = await request.get("/api/codex/chats");
    expect(chats.status()).toBe(200);
    for (const session of (await chats.json()).sessions ?? []) {
      expect(session).not.toHaveProperty("messages");
      expect(session).not.toHaveProperty("title");
      expect(session).not.toHaveProperty("project");
      expect(session).not.toHaveProperty("root");
      expect(session.legacyContentWithheld).toBe(true);
    }
  });

  test("rejects cross-origin mutations", async ({ request }) => {
    const response = await request.post("/api/workbench/runs", {
      headers: { Origin: "https://example.com", "Content-Type": "application/json" },
      data: { agentId: "codex" },
    });
    expect(response.status()).toBe(403);
  });
});
