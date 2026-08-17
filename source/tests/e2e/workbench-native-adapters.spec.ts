import { expect, test } from "@playwright/test";

const PROVIDERS = ["codex", "claude", "hermes", "openclaw", "antigravity"] as const;

type NativeSession = {
  id: string;
  actorId: string | null;
  projectId: string | null;
  title: string | null;
  updatedAt: string | null;
  metadata?: Record<string, unknown>;
};

type NativeHistorySession = {
  id: string;
  nativeId?: string;
  sessionKey?: string;
  aliases?: string[];
  channelSource?: string;
};

type NativeHistoryGroup = {
  scope?: string;
  sessions: NativeHistorySession[];
};

test.describe("Workbench native read-through adapters", () => {
  for (const provider of PROVIDERS) {
    test(`${provider} lists and loads its native sessions without Workbench writes`, async ({ request }) => {
      const listResponse = await request.get(`/api/workbench/agents/${provider}/sessions`);
      expect(listResponse.status()).toBe(200);
      const list = await listResponse.json() as {
        agent: { id: string; capabilities: Record<string, { status: string }> };
        sessions: NativeSession[];
        sessionCount: number;
        returnedCount: number;
        nextOffset: number | null;
      };

      expect(list.agent.id).toBe(provider);
      expect(list.agent.capabilities.list.status).toBe("supported");
      expect(list.agent.capabilities.load.status).toBe("supported");
      expect(list.agent.capabilities.artifacts.status).toBe("supported");
      // Wave 3 cut Codex and Claude over to the durable control plane, so their
      // start and resume are real. Every other provider must still report the
      // truth: unsupported until its own wave lands. Approvals stay unsupported
      // for all five until the Tool Gateway can enforce them.
      const lifecycleStatus = provider === "codex" || provider === "claude" ? "supported" : "unsupported";
      expect(list.agent.capabilities.start.status).toBe(lifecycleStatus);
      expect(list.agent.capabilities.resume.status).toBe(lifecycleStatus);
      expect(list.agent.capabilities.approval.status).toBe("unsupported");
      expect(list.returnedCount).toBe(list.sessions.length);
      expect(list.sessionCount).toBeGreaterThanOrEqual(list.sessions.length);
      expect(list.sessions.length).toBeLessThanOrEqual(50);
      if (list.nextOffset !== null) expect(list.nextOffset).toBe(list.sessions.length);

      const session = list.sessions[0];
      if (!session) return;
      const params = new URLSearchParams({ sessionId: session.id });
      if ((provider === "hermes" || provider === "openclaw") && session.actorId) {
        params.set("actorId", session.actorId);
      }
      const loadResponse = await request.get(`/api/workbench/agents/${provider}/sessions?${params}`);
      expect(loadResponse.status()).toBe(200);
      const loaded = await loadResponse.json() as { session: NativeSession };
      expect(loaded.session.id).toBe(session.id);
      expect(loaded.session.actorId).toBe(session.actorId);
      expect(loaded.session.metadata?.detail).toBeTruthy();
    });
  }

  test("Hermes and OpenClaw actor filters never return another identity", async ({ request }) => {
    for (const provider of ["hermes", "openclaw"] as const) {
      const allResponse = await request.get(`/api/workbench/agents/${provider}/sessions`);
      expect(allResponse.status()).toBe(200);
      const all = await allResponse.json() as { sessions: NativeSession[] };
      const actorId = all.sessions.find((session) => session.actorId)?.actorId;
      if (!actorId) continue;

      const filteredResponse = await request.get(
        `/api/workbench/agents/${provider}/sessions?actorId=${encodeURIComponent(actorId)}`,
      );
      expect(filteredResponse.status()).toBe(200);
      const filtered = await filteredResponse.json() as { sessions: NativeSession[] };
      expect(filtered.sessions.every((session) => session.actorId === actorId)).toBe(true);
    }
  });

  test("native indexes expose one canonical row per provider identity", async ({ request }) => {
    for (const provider of PROVIDERS) {
      const response = await request.get(`/api/agent-history?agent=${provider}`);
      expect(response.status()).toBe(200);
      const index = await response.json() as { groups: NativeHistoryGroup[] };
      const identities = index.groups.flatMap((group) => group.sessions.map((session) =>
        `${provider}:${provider === "hermes" || provider === "openclaw" ? group.scope ?? "" : ""}:${session.nativeId ?? session.id}`,
      ));
      expect(new Set(identities).size).toBe(identities.length);
    }
  });

  test("Hermes hides internal runs and resolves canonical aliases within the same profile", async ({ request }) => {
    const response = await request.get("/api/agent-history?agent=hermes");
    expect(response.status()).toBe(200);
    const index = await response.json() as { groups: NativeHistoryGroup[] };
    const rows = index.groups.flatMap((group) => group.sessions.map((session) => ({ group, session })));
    expect(rows.every(({ session }) => !["cron", "subagent", "tool"].includes(session.channelSource ?? ""))).toBe(true);

    const aliased = rows.find(({ session }) => session.aliases?.length);
    if (!aliased) return;
    const alias = aliased.session.aliases![0];
    const params = new URLSearchParams({ sessionId: alias });
    if (aliased.group.scope) params.set("actorId", aliased.group.scope);
    const loadedResponse = await request.get(`/api/workbench/agents/hermes/sessions?${params}`);
    expect(loadedResponse.status()).toBe(200);
    const loaded = await loadedResponse.json() as { session: NativeSession };
    expect(loaded.session.id).toBe(aliased.session.nativeId ?? aliased.session.id);
    expect(loaded.session.actorId).toBe(aliased.group.scope ?? null);
  });

  test("OpenClaw omits Agent OS probe sessions", async ({ request }) => {
    const response = await request.get("/api/agent-history?agent=openclaw");
    expect(response.status()).toBe(200);
    const index = await response.json() as { groups: NativeHistoryGroup[] };
    const keys = index.groups.flatMap((group) => group.sessions.map((session) => session.sessionKey ?? ""));
    expect(keys.every((key) => !/(^|:)agent-os-(?:e2e-)?[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(key))).toBe(true);
  });

  test("native session lookup rejects arbitrary path-shaped ids", async ({ request }) => {
    const response = await request.get("/api/workbench/agents/codex/sessions?sessionId=../../outside");
    expect(response.status()).toBe(404);
  });
});
