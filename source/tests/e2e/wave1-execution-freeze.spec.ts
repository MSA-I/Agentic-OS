import { expect, test, type APIRequestContext } from "@playwright/test";

const DIRECT_EXECUTION_ROUTES = [
  "/api/codex/chat",
  "/api/claude/chat",
  "/api/hermes/chat",
  "/api/openclaw/chat",
  "/api/antigravity/chat",
  "/api/dscoder/chat",
  "/api/notebooklm/research",
  "/api/opencode/build",
  "/api/room",
  "/api/ruflo/swarm",
  "/api/seo/generate",
  "/api/videouse/run",
] as const;

function bootstrapSecret(): string {
  const secret = process.env.AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET;
  if (!secret) throw new Error("AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET is required.");
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

test.describe("Wave 1 execution freeze", () => {
  test("direct execution routes fail closed before their native handler", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    for (const route of DIRECT_EXECUTION_ROUTES) {
      const response = await request.post(route, {
        headers: { Origin: origin, "Content-Type": "application/json" },
        data: {},
      });
      expect(response.status(), `${route}: ${await response.text()}`).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "control_plane_execution_unavailable",
        runCreated: false,
      });
    }
  });

  test("direct bypass rejects origin, content type, and oversized bodies", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const crossOrigin = await request.post("/api/codex/chat", {
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      data: {},
    });
    expect(crossOrigin.status()).toBe(403);

    const nonJson = await request.post("/api/codex/chat", {
      headers: { Origin: origin, "Content-Type": "text/plain" },
      data: "prompt",
    });
    expect(nonJson.status()).toBe(415);

    const oversized = await request.post("/api/codex/chat", {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: { padding: "x".repeat(70 * 1024) },
    });
    expect(oversized.status()).toBe(413);
  });

  test("Workbench unsupported-provider and mismatched identity create no run", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await bootstrap(request, origin);
    const beforeResponse = await request.get("/api/workbench/runs?limit=200", { headers: { Origin: origin } });
    expect(beforeResponse.status(), await beforeResponse.text()).toBe(200);
    const beforeIds = (await beforeResponse.json()).runs.map((run: { id: string }) => run.id).sort();
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const requestBody = {
      agentId: "hermes",
      prompt: "Wave 1 freeze probe",
      idempotencyKey: "wave1-http-hermes-no-run",
      context: {
        actorId: "hermes",
        projectId: "wave1-http",
        environment: "local",
        panel: "transcript",
      },
      identity: {
        actorId: "hermes",
        projectId: "wave1-http",
        worktreeId: "local",
        provider: "hermes",
        profileId: null,
        nativeSessionId: null,
        runId: "wave1-http-hermes-no-run",
      },
    };

    const unsupported = await request.post("/api/workbench/runs", { headers, data: requestBody });
    expect(unsupported.status(), await unsupported.text()).toBe(501);
    expect(await unsupported.json()).toMatchObject({ code: "unsupported" });

    await rotate(request, origin);
    const mismatched = await request.post("/api/workbench/runs", {
      headers,
      data: {
        ...requestBody,
        agentId: "codex",
        idempotencyKey: "wave1-http-codex-mismatch",
        context: { ...requestBody.context, actorId: "codex" },
        identity: {
          ...requestBody.identity,
          actorId: "other-actor",
          provider: "codex",
          runId: "wave1-http-codex-mismatch",
        },
      },
    });
    expect(mismatched.status(), await mismatched.text()).toBe(409);
    expect(await mismatched.json()).toMatchObject({ code: "identity_mismatch" });

    const afterResponse = await request.get("/api/workbench/runs?limit=200", { headers: { Origin: origin } });
    expect(afterResponse.status(), await afterResponse.text()).toBe(200);
    const afterIds = (await afterResponse.json()).runs.map((run: { id: string }) => run.id).sort();
    expect(afterIds).toEqual(beforeIds);
  });
});
