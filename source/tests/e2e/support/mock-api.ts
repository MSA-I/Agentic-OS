import type { Page, Route } from "@playwright/test";

export interface MockApiLog {
  mutations: string[];
  reads: string[];
}

const now = Date.now();
const today = new Date(now).toISOString().slice(0, 10);

const genericPayload = {
  ok: true,
  ready: true,
  healthy: true,
  enabled: true,
  reachable: true,
  connected: true,
  state: "ready",
  status: "ready",
  version: "qa-mock",
  generatedAt: now,
  entries: [],
  recent: [],
  groups: [],
  agents: [],
  sessions: [],
  chats: [],
  projects: [],
  builds: [],
  files: [],
  artifacts: [],
  history: [],
  days: [],
  todos: [],
  items: [],
  jobs: [],
  runs: [],
  goals: [],
  cards: [],
  boards: [],
  columns: [],
  notebooks: [],
  voices: [],
  avatars: [],
  transcripts: [],
  sites: [],
  profiles: [],
  tools: [],
  skills: [],
  plugins: [],
  nodes: [],
  links: [],
  content: "",
  stdout: "Mocked locally for browser QA.",
  stderr: "",
};

function agentHistory(url: URL) {
  const agent = url.searchParams.get("agent") ?? "agent";
  const requestedPath = url.searchParams.get("path");
  if (requestedPath) {
    return {
      ...genericPayload,
      detail: {
        path: requestedPath,
        turns: [
          { role: "user", text: "Continue Work transcript request" },
          { role: "assistant", text: "Continue Work transcript restored" },
        ],
        raw: "",
        bytes: 128,
        truncated: false,
      },
    };
  }
  return {
    ...genericPayload,
    groups: [
      {
        id: `${agent}-qa-project`,
        label: "QA Project",
        root: "mock://qa-project",
        sessions: [
          {
            id: `${agent}-qa-session`,
            name: "Mocked QA session",
            path: `mock:${agent}:session`,
            mtime: now,
            bytes: 128,
            nativeId: `${agent}-native-session`,
            nativeStarted: true,
            resumable: true,
            source: "native",
          },
        ],
      },
    ],
  };
}

function payloadFor(url: URL) {
  const pathname = url.pathname;

  if (pathname === "/api/capabilities") {
    return {
      capabilities: [
        { id: "agent.claude", state: "ready", updatedAt: new Date(now).toISOString() },
        { id: "agent.codex", state: "ready", updatedAt: new Date(now).toISOString() },
        { id: "agent.hermes", state: "offline", reason: "Mocked offline state", updatedAt: new Date(now).toISOString() },
        { id: "agent.openclaw", state: "ready", updatedAt: new Date(now).toISOString() },
        {
          id: "agent.antigravity",
          state: "needs_setup",
          reason: "Mocked setup is required",
          configureHref: "/?panel=integrations",
          updatedAt: new Date(now).toISOString(),
        },
      ],
      generatedAt: new Date(now).toISOString(),
    };
  }

  if (pathname === "/api/mission-control") {
    return {
      activeRuns: [
        {
          id: "qa-run-1",
          title: "Design system verification",
          agentId: "codex",
          status: "running",
          startedAt: new Date(now - 120_000).toISOString(),
          updatedAt: new Date(now - 15_000).toISOString(),
          href: "/codex?view=runs",
          progress: 64,
        },
        {
          id: "qa-run-2",
          title: "Accessibility audit",
          agentId: "claude",
          status: "running",
          startedAt: new Date(now - 60_000).toISOString(),
          updatedAt: new Date(now - 10_000).toISOString(),
          href: "/claude?view=runs",
        },
      ],
      recentWork: [
        {
          id: "qa-recent-1",
          title: "Mission Control shell",
          agentId: "claude",
          href: "/claude?view=chat&session=claude-native-session",
          updatedAt: new Date(now - 300_000).toISOString(),
        },
      ],
      health: [
        { id: "claude", label: "Claude", state: "healthy", detail: "Local runtime ready", updatedAt: new Date(now).toISOString() },
        { id: "codex", label: "Codex", state: "healthy", detail: "Local runtime ready", updatedAt: new Date(now).toISOString() },
        { id: "hermes", label: "Hermes", state: "offline", detail: "Mocked offline state", updatedAt: new Date(now).toISOString() },
      ],
      generatedAt: new Date(now).toISOString(),
    };
  }

  if (pathname === "/api/vitals") {
    return {
      ts: now,
      claude: { ok: true, version: "2.0.0 (qa)", latencyMs: 18 },
      openclaw: { ok: true, gateway: "live", degraded: false, busy: false, agents: ["main"], sessions: 2, latencyMs: 22 },
      hermes: { ok: true, model: "nous/hermes-4", provider: "local", latencyMs: 26 },
      antigravity: { ok: false, version: "not configured", latencyMs: 0 },
    };
  }

  if (pathname === "/api/fcc") {
    return { enabled: true, reachable: true, model: "qa/free-claude", provider: "local" };
  }

  if (pathname === "/api/activity") {
    return {
      entries: [
        { ts: now - 30_000, agent: "claude", text: "Completed a mocked local check", level: "info" },
        { ts: now - 15_000, agent: "hermes", text: "Waiting for a local runtime", level: "warn" },
      ],
    };
  }

  if (pathname === "/api/todos") {
    return {
      date: today,
      today,
      todos: [
        { id: "qa-task", text: "Verify Mission Control", done: false, ts: now, status: "doing", kind: "task", indent: 0 },
      ],
      days: [{ date: today, total: 1, done: 0 }],
    };
  }

  if (pathname === "/api/memory/graph") {
    return {
      nodes: [
        { id: "Agentic OS/QA note.md", title: "QA note", group: "Agentic OS", degree: 2, mtime: now },
        { id: "02 Projects/Redesign.md", title: "Redesign", group: "02 Projects", degree: 2, mtime: now - 60_000 },
        { id: "05 Memories/Layout lock.md", title: "Layout lock", group: "05 Memories", degree: 2, mtime: now - 120_000 },
      ],
      links: [
        { source: "Agentic OS/QA note.md", target: "02 Projects/Redesign.md" },
        { source: "02 Projects/Redesign.md", target: "05 Memories/Layout lock.md" },
        { source: "05 Memories/Layout lock.md", target: "Agentic OS/QA note.md" },
      ],
    };
  }

  if (pathname === "/api/tokens") {
    return {
      agents: [
        { agent: "claude", calls: 2, promptTokens: 700, completionTokens: 300, totalTokens: 1_000, costUsd: 0, todayTokens: 1_000, models: ["qa"], lastTs: now },
      ],
      grand: { calls: 2, promptTokens: 700, completionTokens: 300, totalTokens: 1_000, costUsd: 0, todayTokens: 1_000 },
      generatedAt: now,
    };
  }

  if (pathname === "/api/hermes/kanban/board") {
    return {
      board: url.searchParams.get("board") ?? "default",
      boards: [],
      tasks: [],
      stats: {
        by_status: {},
        by_assignee: {},
        oldest_ready_age_seconds: null,
        now: Math.floor(now / 1_000),
      },
      assignees: [],
      ok: true,
    };
  }

  if (pathname === "/api/agent-history") return agentHistory(url);
  if (pathname === "/api/memory/recent") return { recent: [{ id: "qa-memory", title: "QA memory", ts: now }] };
  if (pathname === "/api/version") return { version: "qa-mock" };
  if (pathname.endsWith("/status")) return { ...genericPayload, ready: true, state: "ready" };
  if (pathname === "/api/claude/workspace/file") {
    return {
      path: url.searchParams.get("path"),
      content: "Scoped workspace file search fixture",
      bytes: 36,
      mtime: now,
      truncated: false,
    };
  }
  if (pathname === "/api/claude/workspace") {
    if (url.searchParams.get("project") === "qa-project") {
      return {
        project: { name: "qa-project", root: "mock://qa-project", mtime: now, fileCount: 1 },
        files: [{
          name: "workspace-notes.md",
          relPath: "docs/workspace-notes.md",
          bytes: 36,
          mtime: now,
          isText: true,
          kind: "text",
        }],
      };
    }
    return {
      projects: [{ name: "qa-project", root: "mock://qa-project", mtime: now, fileCount: 1 }],
    };
  }
  if (pathname.includes("/workspace")) {
    return {
      ...genericPayload,
      projects: [{ id: "qa-project", name: "QA Project", path: "mock://qa-project", files: [] }],
      builds: [],
      sessions: [],
      files: [],
    };
  }

  return genericPayload;
}

async function handleApiRoute(route: Route, log: MockApiLog) {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method().toUpperCase();
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  const descriptor = `${method} ${url.pathname}${url.search}`;
  if (mutation) log.mutations.push(descriptor);
  else log.reads.push(descriptor);

  const payload = mutation
    ? { ...genericPayload, mocked: true, mutationBlocked: true, reply: "Mocked response", text: "Mocked response" }
    : payloadFor(url);

  await route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    headers: {
      "cache-control": "no-store",
      "x-agent-os-qa-mock": mutation ? "mutation-blocked" : "read-fixture",
    },
    body: JSON.stringify(payload),
  });
}

export async function installApiMocks(page: Page): Promise<MockApiLog> {
  const log: MockApiLog = { mutations: [], reads: [] };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/**", (route) => handleApiRoute(route, log));
  return log;
}
