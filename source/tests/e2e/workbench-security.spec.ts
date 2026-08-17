import {
  expect,
  test,
  type APIRequestContext,
} from "@playwright/test";

function configuredBootstrapSecret(): string {
  const secret = process.env.AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET;
  if (!secret) {
    throw new Error("AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET is required for Workbench security tests.");
  }
  return secret;
}

async function bootstrap(request: APIRequestContext, origin: string) {
  return request.post("/api/workbench/session", {
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Agent-OS-Bootstrap-Token": configuredBootstrapSecret(),
    },
    data: {},
  });
}

async function expectBootstrap(request: APIRequestContext, origin: string): Promise<void> {
  const response = await bootstrap(request, origin);
  expect(response.status(), await response.text()).toBe(200);
}

test.describe("Workbench local HTTP and session boundary", () => {
  test("bootstrap fails closed and never reflects the bootstrap secret", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const missing = await request.post("/api/workbench/session", {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: {},
    });
    expect(missing.status(), await missing.text()).toBe(401);

    const sentinel = "SENTINEL_BOOTSTRAP_SECRET_MUST_NOT_LEAK_123456";
    const incorrect = await request.post("/api/workbench/session", {
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Agent-OS-Bootstrap-Token": sentinel,
      },
      data: {},
    });
    expect(incorrect.status()).toBe(401);
    expect(await incorrect.text()).not.toContain(sentinel);
    expect(incorrect.headers()["set-cookie"]).toBeUndefined();

    const issued = await bootstrap(request, origin);
    expect(issued.status()).toBe(200);
    const body = await issued.text();
    expect(body).not.toContain(configuredBootstrapSecret());
    const cookies = issued.headersArray()
      .filter((header) => header.name.toLowerCase() === "set-cookie")
      .map((header) => header.value);
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toContain(configuredBootstrapSecret());
    }
  });

  test("rejects DNS rebinding and cross-origin POST and SSE", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const rebound = await request.post("/api/workbench/session", {
      headers: {
        Host: "attacker.example",
        Origin: origin,
        "Content-Type": "application/json",
        "X-Agent-OS-Bootstrap-Token": configuredBootstrapSecret(),
      },
      data: {},
    });
    expect(rebound.status()).toBe(403);

    const alternateLoopbackOrigin = await request.post("/api/workbench/session", {
      headers: {
        Origin: `http://localhost:${new URL(baseURL!).port}`,
        "Content-Type": "application/json",
        "X-Agent-OS-Bootstrap-Token": configuredBootstrapSecret(),
      },
      data: {},
    });
    expect(alternateLoopbackOrigin.status()).toBe(403);

    await expectBootstrap(request, origin);
    const crossOriginPost = await request.post("/api/workbench/runs/missing-run/cancel", {
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      data: {},
    });
    expect(crossOriginPost.status()).toBe(403);

    const crossOriginStream = await request.get("/api/workbench/runs/missing-run/events", {
      headers: { Origin: "https://attacker.example" },
    });
    expect(crossOriginStream.status()).toBe(403);
  });

  test("requires tokens for mutations and event streams", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const mutation = await request.post("/api/workbench/runs/missing-run/cancel", {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: {},
    });
    expect(mutation.status()).toBe(401);

    const stream = await request.get("/api/workbench/runs/missing-run/events", {
      headers: { Origin: origin },
    });
    expect(stream.status()).toBe(401);
  });

  test("atomically rejects replay of a consumed mutation token", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await expectBootstrap(request, origin);
    const options = {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: {
        identity: {
          actorId: "codex",
          projectId: "wave1-http",
          worktreeId: "local",
          provider: "codex",
          profileId: null,
          nativeSessionId: null,
          runId: "missing-run",
        },
      },
    };
    const first = await request.post("/api/workbench/runs/missing-run/cancel", options);
    expect(first.status()).toBe(404);
    const replay = await request.post("/api/workbench/runs/missing-run/cancel", options);
    expect(replay.status()).toBe(401);
  });

  test("requires JSON even for a cancel request with no payload", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await expectBootstrap(request, origin);
    const response = await request.post("/api/workbench/runs/missing-run/cancel", {
      headers: { Origin: origin },
    });
    expect(response.status()).toBe(415);
  });

  test("invalidates old session cookies when rotating", async ({ request, baseURL, playwright }) => {
    const origin = new URL(baseURL!).origin;
    await expectBootstrap(request, origin);
    const staleState = await request.storageState();

    const rotated = await request.get("/api/workbench/session", {
      headers: { Origin: origin },
    });
    expect(rotated.status()).toBe(200);

    const staleClient = await playwright.request.newContext({
      baseURL,
      storageState: staleState,
    });
    try {
      const staleStream = await staleClient.get("/api/workbench/runs/missing-run/events", {
        headers: { Origin: origin },
      });
      expect(staleStream.status()).toBe(401);
    } finally {
      await staleClient.dispose();
    }

    const currentStream = await request.get("/api/workbench/runs/missing-run/events", {
      headers: { Origin: origin },
    });
    expect(currentStream.status()).toBe(404);
  });

  test("rejects oversized JSON before route logic", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await expectBootstrap(request, origin);
    const oversizedCancel = await request.post("/api/workbench/runs/missing-run/cancel", {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: { padding: "x".repeat(70 * 1024) },
    });
    expect(oversizedCancel.status()).toBe(413);

    const rotated = await request.get("/api/workbench/session", {
      headers: { Origin: origin },
    });
    expect(rotated.status()).toBe(200);
    const oversized = await request.post("/api/workbench/runs", {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: { padding: "x".repeat(70 * 1024) },
    });
    expect(oversized.status()).toBe(413);
  });
});
