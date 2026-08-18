import { expect, test } from "@playwright/test";

// Every mutation route that is not frozen and not served by the Workbench now
// shares one local HTTP boundary. A hostile page can still issue a simple
// cross-origin POST at loopback, so the boundary has to refuse before the
// handler touches state. These probes are refused before any body is read, so
// they create no side effects.
const GUARDED_MUTATIONS = [
  { method: "POST", path: "/api/agent-kanban/state" },
  { method: "DELETE", path: "/api/agent-kanban/workspace" },
  { method: "POST", path: "/api/astros/config" },
  { method: "DELETE", path: "/api/claude/artifacts" },
  { method: "POST", path: "/api/claude/artifacts" },
  { method: "POST", path: "/api/content/pin" },
  { method: "POST", path: "/api/dscoder/workspace" },
  { method: "POST", path: "/api/fcc" },
  { method: "POST", path: "/api/freeclaude/builds" },
  { method: "POST", path: "/api/freeclaude/workspace" },
  { method: "POST", path: "/api/fusion/history" },
  { method: "DELETE", path: "/api/goals" },
  { method: "PATCH", path: "/api/goals" },
  { method: "POST", path: "/api/goals" },
  { method: "POST", path: "/api/graphify/run" },
  { method: "POST", path: "/api/hermes/apollo-log" },
  { method: "POST", path: "/api/hermes/apollo-memory" },
  { method: "POST", path: "/api/hy3coder/workspace" },
  { method: "POST", path: "/api/journal" },
  { method: "POST", path: "/api/kimi/workspace" },
  { method: "POST", path: "/api/leads/export" },
  { method: "POST", path: "/api/leads/keys" },
  { method: "DELETE", path: "/api/local/builds" },
  { method: "POST", path: "/api/local/builds" },
  { method: "POST", path: "/api/media/rehydrate" },
  { method: "POST", path: "/api/memory/log" },
  { method: "POST", path: "/api/musecoder/workspace" },
  { method: "POST", path: "/api/music/save" },
  { method: "POST", path: "/api/omniroute/workspace" },
  { method: "DELETE", path: "/api/openclaw/studio/searches" },
  { method: "DELETE", path: "/api/openclaw/studio/talks" },
  { method: "POST", path: "/api/openclaw/studio/talks" },
  { method: "POST", path: "/api/outreach" },
  { method: "POST", path: "/api/outreach/settings" },
  { method: "POST", path: "/api/pipeline/capture" },
  { method: "POST", path: "/api/pipeline/delete" },
  { method: "POST", path: "/api/pipeline/pin" },
  { method: "DELETE", path: "/api/room/history" },
  { method: "POST", path: "/api/room/history" },
  { method: "POST", path: "/api/sakana/history" },
  { method: "POST", path: "/api/seo/transcript/save" },
  { method: "POST", path: "/api/setup/action" },
  { method: "POST", path: "/api/setup/agent-install/plan" },
  { method: "POST", path: "/api/setup/agent-install/step" },
  { method: "POST", path: "/api/todos" },
  { method: "POST", path: "/api/videouse/jobs" },
] as const;

async function probe(
  request: import("@playwright/test").APIRequestContext,
  entry: { method: string; path: string },
  headers: Record<string, string>,
) {
  const options = { headers: { "Content-Type": "application/json", ...headers }, data: {} };
  if (entry.method === "DELETE") return request.delete(entry.path, options);
  if (entry.method === "PATCH") return request.patch(entry.path, options);
  return request.post(entry.path, options);
}

test.describe("local mutation boundary", () => {
  test("every guarded mutation refuses a cross-origin caller", async ({ request }) => {
    for (const entry of GUARDED_MUTATIONS) {
      const response = await probe(request, entry, { Origin: "https://attacker.example" });
      expect(response.status(), `${entry.method} ${entry.path}: ${await response.text()}`).toBe(403);
      expect(await response.json()).toMatchObject({ code: "origin_mismatch" });
    }
  });

  test("every guarded mutation refuses a caller with no Origin", async ({ request }) => {
    for (const entry of GUARDED_MUTATIONS) {
      const response = await probe(request, entry, {});
      expect(response.status(), `${entry.method} ${entry.path}: ${await response.text()}`).toBe(403);
      expect(await response.json()).toMatchObject({ code: "origin_required" });
    }
  });

  test("a same-origin caller still reaches the handler", async ({ request, baseURL }) => {
    // Chosen because its validation rejects an empty payload before writing, so
    // passing the boundary is observable without changing any state.
    const response = await request.post("/api/goals", {
      headers: { Origin: new URL(baseURL!).origin, "Content-Type": "application/json" },
      data: {},
    });
    expect(response.status(), await response.text()).toBe(400);
    expect(await response.json()).toMatchObject({ error: "empty text" });
  });
});
