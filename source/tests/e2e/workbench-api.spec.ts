import { expect, test } from "@playwright/test";

test.describe("Workbench API contract", () => {
  test("creates, queues, replays events, and cancels without claiming unsupported native work", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const headers = { Origin: origin, "Content-Type": "application/json" };

    const listResponse = await request.get("/api/workbench/runs?agentId=codex&limit=5");
    expect(listResponse.status()).toBe(200);
    const list = await listResponse.json();
    expect(list.agents).toHaveLength(5);
    expect(list.agents.find((agent: { id: string }) => agent.id === "codex").capabilities.start.status).toBe("unsupported");

    const createResponse = await request.post("/api/workbench/runs", {
      headers,
      data: {
        agentId: "codex",
        title: "Workbench contract test",
        context: {
          actorId: "codex",
          projectId: "qa-project",
          environment: "local",
          panel: "transcript",
        },
      },
    });
    expect(createResponse.status()).toBe(201);
    const created = await createResponse.json();
    expect(created.run.status).toBe("queued");
    expect(created.start).toMatchObject({ ok: false, code: "unsupported" });
    const runId = created.run.id as string;

    const queueResponse = await request.post(`/api/workbench/runs/${runId}/messages`, {
      headers,
      data: { mode: "queue", content: "Safe queued QA message" },
    });
    expect(queueResponse.status()).toBe(202);
    expect(await queueResponse.json()).toMatchObject({ delivery: "queued" });

    const steerResponse = await request.post(`/api/workbench/runs/${runId}/messages`, {
      headers,
      data: { mode: "steer", content: "Must not steer a queued run" },
    });
    expect(steerResponse.status()).toBe(409);

    const cancelResponse = await request.post(`/api/workbench/runs/${runId}/cancel`, { headers, data: {} });
    expect(cancelResponse.status()).toBe(200);
    expect((await cancelResponse.json()).run.status).toBe("cancelled");

    const eventResponse = await request.get(`/api/workbench/runs/${runId}/events?after=0`);
    expect(eventResponse.status()).toBe(200);
    expect(eventResponse.headers()["content-type"]).toContain("text/event-stream");
    const events = await eventResponse.text();
    expect(events).toContain("event: status");
    expect(events).toContain('"status":"cancelled"');
  });

  test("rejects cross-origin mutations", async ({ request }) => {
    const response = await request.post("/api/workbench/runs", {
      headers: { Origin: "https://example.com", "Content-Type": "application/json" },
      data: { agentId: "codex" },
    });
    expect(response.status()).toBe(403);
  });

  for (const agentId of ["hermes", "openclaw"] as const) {
    test(`${agentId} refuses to mix actors inside one native session`, async ({ request, baseURL }) => {
      const origin = new URL(baseURL!).origin;
      const headers = { Origin: origin, "Content-Type": "application/json" };
      const sessionId = `qa-${agentId}-${Date.now()}`;
      const firstActor = agentId === "hermes" ? "profile-alpha" : "agent-alpha";
      const secondActor = agentId === "hermes" ? "profile-beta" : "agent-beta";

      const first = await request.post("/api/workbench/runs", {
        headers,
        data: {
          agentId,
          context: {
            agentId,
            actorId: firstActor,
            projectId: "qa-project",
            sessionId,
            environment: "local",
            panel: "transcript",
          },
        },
      });
      expect(first.status()).toBe(201);

      const conflicting = await request.post("/api/workbench/runs", {
        headers,
        data: {
          agentId,
          context: {
            agentId,
            actorId: secondActor,
            projectId: "qa-project",
            sessionId,
            environment: "local",
            panel: "transcript",
          },
        },
      });
      expect(conflicting.status()).toBe(409);
      expect(await conflicting.json()).toMatchObject({
        error: "This native session is already bound to a different actor.",
      });
    });
  }
});
