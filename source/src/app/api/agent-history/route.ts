import { NextResponse } from "next/server";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { hermesHome } from "@/lib/config";
import { readSession as readCodexSession } from "@/lib/codexWorkspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SessionRow { id: string; name: string; path: string; mtime: number; bytes: number; nativeId?: string; sessionKey?: string; resumable?: boolean; source?: "native" | "local"; pinned?: boolean; preview?: string; }
interface HistoryGroup { id: string; label: string; root: string; scope?: string; sessions: SessionRow[]; }
interface TranscriptTurn { role: "user" | "assistant" | "system" | "tool"; text: string; }

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => typeof v === "string" ? v : textOf((v as { text?: unknown })?.text ?? v)).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return textOf(v.text ?? v.content ?? v.message ?? v.output ?? "");
  }
  return "";
}

function collectTurns(value: unknown, out: TranscriptTurn[] = []): TranscriptTurn[] {
  if (!value || out.length >= 250) return out;
  if (Array.isArray(value)) { for (const item of value) collectTurns(item, out); return out; }
  if (typeof value !== "object") return out;
  const row = value as Record<string, unknown>;
  const message = row.message && typeof row.message === "object" ? row.message as Record<string, unknown> : null;
  const rawRole = String(message?.role ?? row.role ?? row.source ?? row.type ?? "").toLowerCase();
  const role: TranscriptTurn["role"] | null = rawRole.includes("assistant") || rawRole === "model" ? "assistant" : rawRole.includes("user") ? "user" : rawRole.includes("system") ? "system" : rawRole.includes("tool") ? "tool" : null;
  const text = textOf(message?.content ?? row.content ?? row.text ?? row.prompt ?? row.response);
  if (role && text.trim()) out.push({ role, text: text.trim().slice(0, 80_000) });
  for (const key of ["messages", "turns", "history", "conversation", "events", "payloads"]) if (row[key]) collectTurns(row[key], out);
  return out;
}

async function readPrefix(file: string, max = 2_000_000) {
  const handle = await open(file, "r");
  try {
    const s = await handle.stat();
    const buf = Buffer.alloc(Math.min(max, s.size));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return { text: buf.subarray(0, bytesRead).toString("utf8"), bytes: s.size, truncated: s.size > max };
  } finally { await handle.close(); }
}

async function fileDetail(file: string, root: string) {
  const resolved = path.resolve(file);
  const safeRoot = path.resolve(root);
  if (resolved !== safeRoot && !resolved.startsWith(safeRoot + path.sep)) return null;
  const s = await stat(resolved).catch(() => null);
  if (!s?.isFile()) return null;
  const data = await readPrefix(resolved);
  let turns: TranscriptTurn[] = [];
  try { turns = collectTurns(JSON.parse(data.text)); }
  catch {
    for (const line of data.text.split(/\r?\n/)) {
      try { collectTurns(JSON.parse(line), turns); } catch { /* non-json/partial line */ }
    }
  }
  return { path: resolved, turns, raw: turns.length ? "" : data.text.slice(0, 200_000), bytes: data.bytes, truncated: data.truncated };
}

async function directoryDetail(dir: string, root: string) {
  const resolved = path.resolve(dir);
  const safeRoot = path.resolve(root);
  if (resolved !== safeRoot && !resolved.startsWith(safeRoot + path.sep)) return null;
  const rootStat = await stat(resolved).catch(() => null);
  if (!rootStat?.isDirectory()) return null;

  const candidates: { file: string; mtime: number; bytes: number }[] = [];
  async function walk(current: string, depth: number) {
    if (depth > 4 || candidates.length >= 120) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (candidates.length >= 120) break;
      if ([".git", ".next", "node_modules", "dist", "build"].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && /\.(jsonl?|md|markdown|txt|log|ya?ml)$/i.test(entry.name)) {
        const s = await stat(full).catch(() => null);
        if (s) candidates.push({ file: full, mtime: s.mtimeMs, bytes: s.size });
      }
    }
  }
  await walk(resolved, 0);
  candidates.sort((a, b) => b.mtime - a.mtime);

  const turns: TranscriptTurn[] = [];
  const rawSections: string[] = [];
  let bytes = 0;
  let readBytes = 0;
  let truncated = candidates.length > 40;
  for (const candidate of candidates.slice(0, 40)) {
    bytes += candidate.bytes;
    if (readBytes >= 2_000_000) { truncated = true; break; }
    const data = await readPrefix(candidate.file, Math.min(250_000, 2_000_000 - readBytes));
    readBytes += Buffer.byteLength(data.text);
    truncated ||= data.truncated;
    const before = turns.length;
    try { collectTurns(JSON.parse(data.text), turns); }
    catch {
      for (const line of data.text.split(/\r?\n/)) {
        try { collectTurns(JSON.parse(line), turns); } catch { /* non-json line */ }
      }
    }
    if (turns.length === before && rawSections.join("\n").length < 200_000) {
      rawSections.push(`# ${path.relative(resolved, candidate.file)}\n${data.text}`);
    }
  }
  return { path: resolved, turns, raw: turns.length ? "" : rawSections.join("\n\n").slice(0, 200_000), bytes, truncated };
}

async function fileRows(dir: string): Promise<SessionRow[]> {
  if (!existsSync(dir)) return [];
  const rows: SessionRow[] = [];
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(jsonl?|db|pb)$/i.test(entry.name) || /-(?:shm|wal)$/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const s = await stat(full).catch(() => null);
      if (s) rows.push({ id: entry.name.replace(/\.[^.]+$/, ""), name: entry.name, path: full, mtime: s.mtimeMs, bytes: s.size });
    }
  } catch { /* missing/unreadable source */ }
  return rows.sort((a, b) => b.mtime - a.mtime);
}

async function grouped(root: string, nestedSessions: boolean): Promise<HistoryGroup[]> {
  if (!existsSync(root)) return [];
  const groups: HistoryGroup[] = [];
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const groupRoot = path.join(root, entry.name);
      const sessionRoot = nestedSessions ? path.join(groupRoot, "sessions") : groupRoot;
      const sessions = await fileRows(sessionRoot);
      groups.push({ id: entry.name, label: entry.name, root: groupRoot, sessions });
    }
  } catch { /* source unavailable */ }
  return groups.sort((a, b) => (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0));
}

async function claudeCwd(file: string | undefined): Promise<string | null> {
  if (!file) return null;
  let handle;
  try {
    handle = await open(file, "r");
    const buf = Buffer.alloc(128_000);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, bytesRead).toString("utf8").split(/\r?\n/)) {
      try {
        const row = JSON.parse(line);
        if (typeof row?.cwd === "string" && row.cwd) return row.cwd;
      } catch { /* partial/non-json line */ }
    }
  } catch { /* unreadable transcript */ }
  finally { await handle?.close().catch(() => {}); }
  return null;
}

async function claudeTranscriptTitle(file: string): Promise<string | null> {
  try {
    const data = await readPrefix(file, 256_000);
    let customTitle = "";
    let aiTitle = "";
    let slug = "";
    let firstUser = "";
    for (const line of data.text.split(/\r?\n/)) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (!customTitle && typeof row.customTitle === "string") customTitle = row.customTitle.trim();
        if (!aiTitle && typeof row.aiTitle === "string") aiTitle = row.aiTitle.trim();
        if (!slug && typeof row.slug === "string") slug = row.slug.trim();
        const message = row.message && typeof row.message === "object" ? row.message as Record<string, unknown> : null;
        const role = String(message?.role ?? row.role ?? row.type ?? "").toLowerCase();
        if (!firstUser && role === "user") firstUser = textOf(message?.content ?? row.content ?? row.text).replace(/\s+/g, " ").trim();
      } catch { /* partial/non-json line */ }
    }
    return (customTitle || aiTitle || slug || firstUser || "").slice(0, 120) || null;
  } catch { return null; }
}

async function claudeHistory(home: string) {
  const titles = new Map<string, { title: string; project?: string; timestamp: number }>();
  try {
    const raw = await readFile(path.join(home, ".claude", "history.jsonl"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      try {
        const row = JSON.parse(line) as { sessionId?: string; display?: string; project?: string; timestamp?: number };
        if (!row.sessionId || !row.display?.trim()) continue;
        const previous = titles.get(row.sessionId);
        const timestamp = Number(row.timestamp ?? 0);
        if (!previous || timestamp >= previous.timestamp) titles.set(row.sessionId, { title: row.display.trim().slice(0, 120), project: row.project, timestamp });
      } catch { /* ignore malformed history rows */ }
    }
  } catch { /* Claude history is optional */ }
  return titles;
}

function sqliteAll(file: string, sql: string, ...params: (string | number | null)[]): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  } catch { return []; }
  finally { try { db?.close(); } catch { /* read-only close */ } }
}

function timeMs(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n > 0 && n < 10_000_000_000 ? n * 1000 : n;
}

async function hermesGroups(home: string): Promise<HistoryGroup[]> {
  const root = hermesHome();
  const profiles: { name: string; dir: string; db: string }[] = [{ name: "default", dir: root, db: path.join(root, "state.db") }];
  try {
    for (const entry of await readdir(path.join(root, "profiles"), { withFileTypes: true })) {
      if (entry.isDirectory()) profiles.push({ name: entry.name, dir: path.join(root, "profiles", entry.name), db: path.join(root, "profiles", entry.name, "state.db") });
    }
  } catch { /* profiles optional */ }

  const groups = new Map<string, HistoryGroup>();
  for (const profile of profiles) {
    const sessions = sqliteAll(profile.db, `
      SELECT s.id, s.title, s.cwd, s.started_at, s.ended_at, s.message_count, s.model,
        (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' AND m.active = 1 ORDER BY m.timestamp ASC LIMIT 1) AS preview
      FROM sessions s WHERE COALESCE(s.archived, 0) = 0
      ORDER BY COALESCE(s.ended_at, s.started_at) DESC LIMIT 300
    `);
    for (const row of sessions) {
      const cwd = typeof row.cwd === "string" && row.cwd ? row.cwd : "";
      const groupId = `${profile.name}:${cwd || "no-project"}`;
      if (!groups.has(groupId)) groups.set(groupId, {
        id: groupId,
        label: cwd ? `${profile.name} · ${path.basename(cwd)}` : profile.name,
        root: cwd || profile.dir,
        scope: profile.name,
        sessions: [],
      });
      const id = String(row.id);
      const preview = typeof row.preview === "string" ? row.preview.replace(/\s+/g, " ").trim() : "";
      const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : preview || `Session ${id.slice(0, 8)}`;
      groups.get(groupId)!.sessions.push({
        id, nativeId: id, name: title.slice(0, 120), path: `hermesdb:${profile.name}:${id}`,
        mtime: timeMs(row.ended_at ?? row.started_at), bytes: Number(row.message_count ?? 0),
        resumable: true, source: "native", preview: preview.slice(0, 220),
      });
    }
  }
  return [...groups.values()].sort((a, b) => {
    if (a.scope === "default" && b.scope !== "default") return -1;
    if (b.scope === "default" && a.scope !== "default") return 1;
    return (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0);
  });
}

function hermesDetail(token: string) {
  const match = /^hermesdb:([^:]+):(.+)$/.exec(token);
  if (!match) return null;
  const [, profile, id] = match;
  if (!/^[A-Za-z0-9_.-]+$/.test(profile) || !/^[A-Za-z0-9_.:-]+$/.test(id)) return null;
  const root = hermesHome();
  const dbFile = profile === "default" ? path.join(root, "state.db") : path.join(root, "profiles", profile, "state.db");
  const session = sqliteAll(dbFile, "SELECT id, cwd, model, message_count FROM sessions WHERE id = ? LIMIT 1", id)[0];
  if (!session) return null;
  const rows = sqliteAll(dbFile, "SELECT role, content, reasoning FROM messages WHERE session_id = ? AND active = 1 ORDER BY timestamp ASC", id);
  const turns = rows.flatMap((row): TranscriptTurn[] => {
    const rawRole = String(row.role ?? "").toLowerCase();
    const role: TranscriptTurn["role"] | null = rawRole === "user" ? "user" : rawRole === "assistant" ? "assistant" : rawRole.includes("tool") ? "tool" : rawRole === "system" ? "system" : null;
    const text = String(row.content ?? row.reasoning ?? "").trim();
    return role && text ? [{ role, text: text.slice(0, 80_000) }] : [];
  });
  return { path: token, turns, raw: "", bytes: Number(session.message_count ?? rows.length), truncated: false, cwd: String(session.cwd ?? ""), model: session.model ? String(session.model) : null };
}

async function openClawGroups(home: string): Promise<HistoryGroup[]> {
  const agentsRoot = path.join(home, ".openclaw", "agents");
  const groups: HistoryGroup[] = [];
  let agents;
  try { agents = await readdir(agentsRoot, { withFileTypes: true }); }
  catch { return []; }
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const indexFile = path.join(agentsRoot, agent.name, "sessions", "sessions.json");
    let index: Record<string, Record<string, unknown>> = {};
    try { index = JSON.parse(await readFile(indexFile, "utf8")); } catch { /* empty agent */ }
    const sessions: SessionRow[] = [];
    let workspace = path.join(home, ".openclaw", "workspace");
    for (const [sessionKey, value] of Object.entries(index)) {
      const sessionId = String(value.sessionId ?? "");
      const sessionFile = typeof value.sessionFile === "string" ? value.sessionFile : path.join(agentsRoot, agent.name, "sessions", `${sessionId}.jsonl`);
      if (!sessionId || !existsSync(sessionFile)) continue;
      const s = await stat(sessionFile).catch(() => null);
      const report = value.systemPromptReport as { workspaceDir?: unknown } | undefined;
      if (typeof report?.workspaceDir === "string") workspace = report.workspaceDir;
      let preview = "";
      try {
        const data = await readPrefix(sessionFile, 180_000);
        const turns: TranscriptTurn[] = [];
        for (const line of data.text.split(/\r?\n/)) { try { collectTurns(JSON.parse(line), turns); } catch { /* jsonl */ } }
        preview = turns.find((turn) => turn.role === "user")?.text.replace(/\s+/g, " ").slice(0, 180) ?? "";
      } catch { /* transcript optional */ }
      sessions.push({
        id: sessionId, nativeId: sessionId, sessionKey, path: sessionFile,
        name: preview || sessionKey.split(":").pop() || `Thread ${sessionId.slice(0, 8)}`,
        mtime: Number(value.updatedAt ?? value.lastActivityAt ?? s?.mtimeMs ?? 0), bytes: s?.size ?? 0,
        resumable: true, source: "native", preview,
      });
    }
    groups.push({ id: `agent:${agent.name}`, label: agent.name, root: workspace, scope: agent.name, sessions: sessions.sort((a, b) => b.mtime - a.mtime) });
  }
  return groups.sort((a, b) => (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0));
}

async function codexGroups(home: string): Promise<HistoryGroup[]> {
  type Project = { id: string; name: string; rootPaths?: string[] };
  type Assignment = { projectId?: string; cwd?: string };
  let state: { "local-projects"?: Record<string, Project>; "project-order"?: string[]; "thread-project-assignments"?: Record<string, Assignment>; "projectless-thread-ids"?: string[] } = {};
  try { state = JSON.parse(await readFile(path.join(home, ".codex", ".codex-global-state.json"), "utf8")); } catch { /* fallback below */ }
  const projects = state["local-projects"] ?? {};
  const order = state["project-order"] ?? Object.keys(projects);
  const assignments = state["thread-project-assignments"] ?? {};
  const groups = new Map<string, HistoryGroup>();
  for (const id of order) {
    const project = projects[id];
    if (!project) continue;
    groups.set(id, { id, label: project.name, root: project.rootPaths?.[0] ?? "", scope: id, sessions: [] });
  }
  const rows = sqliteAll(path.join(home, ".codex", "state_5.sqlite"), `
    SELECT id, title, name, preview, cwd, updated_at_ms, updated_at, recency_at_ms, is_pinned
    FROM threads WHERE archived = 0 ORDER BY COALESCE(NULLIF(recency_at_ms, 0), NULLIF(updated_at_ms, 0), updated_at) DESC LIMIT 700
  `);
  for (const row of rows) {
    const id = String(row.id);
    const cwd = String(row.cwd ?? "");
    let projectId = assignments[id]?.projectId;
    if (!projectId || !groups.has(projectId)) {
      projectId = [...groups.values()].filter((group) => group.root && cwd.toLowerCase().startsWith(group.root.toLowerCase())).sort((a, b) => b.root.length - a.root.length)[0]?.id;
    }
    if (!projectId) {
      projectId = "projectless";
      if (!groups.has(projectId)) groups.set(projectId, { id: projectId, label: "No project", root: cwd, scope: projectId, sessions: [] });
    }
    const title = [row.name, row.title, row.preview].find((value) => typeof value === "string" && value.trim()) as string | undefined;
    groups.get(projectId)!.sessions.push({
      id, nativeId: id, name: title?.trim().slice(0, 120) || `Task ${id.slice(0, 8)}`,
      path: `codex:${id}`, mtime: timeMs(row.recency_at_ms ?? row.updated_at_ms ?? row.updated_at), bytes: 0,
      resumable: true, source: "native", pinned: Boolean(row.is_pinned), preview: String(row.preview ?? "").slice(0, 220),
    });
  }
  return [...groups.values()].filter((group) => group.sessions.length > 0 || group.id !== "projectless");
}

async function antigravityGroups(home: string): Promise<HistoryGroup[]> {
  const root = path.join(home, ".gemini", "antigravity");
  const conversationsRoot = path.join(root, "conversations");
  const brainRoot = path.join(root, "brain");
  let files;
  try { files = await readdir(conversationsRoot, { withFileTypes: true }); }
  catch { return []; }
  const groups = new Map<string, HistoryGroup>();
  for (const entry of files) {
    if (!entry.isFile() || !/\.(?:db|pb)$/i.test(entry.name)) continue;
    const id = entry.name.replace(/\.(?:db|pb)$/i, "");
    const transcript = path.join(brainRoot, id, ".system_generated", "logs", "transcript.jsonl");
    const sourceFile = path.join(conversationsRoot, entry.name);
    const s = await stat(sourceFile).catch(() => null);
    let workspace = "";
    let title = `Mission ${id.slice(0, 8)}`;
    if (existsSync(transcript)) {
      try {
        const data = await readPrefix(transcript, 500_000);
        for (const line of data.text.split(/\r?\n/)) {
          try {
            const row = JSON.parse(line) as { source?: string; type?: string; content?: string; tool_calls?: { args?: Record<string, unknown> }[] };
            if (row.source === "USER_EXPLICIT" && row.content) {
              title = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(row.content)?.[1]?.trim().slice(0, 100) || title;
            }
            for (const call of row.tool_calls ?? []) {
              for (const value of Object.values(call.args ?? {})) {
                if (typeof value !== "string") continue;
                const clean = value.replace(/^"|"$/g, "").replace(/\\\\/g, "\\");
                if (/^[A-Za-z]:\\/.test(clean)) { workspace = clean; break; }
              }
              if (workspace) break;
            }
          } catch { /* jsonl */ }
          if (workspace && title !== `Mission ${id.slice(0, 8)}`) break;
        }
      } catch { /* transcript optional */ }
    }
    const projectRoot = workspace && path.extname(workspace) ? path.dirname(workspace) : workspace;
    const groupId = projectRoot || "unassigned";
    if (!groups.has(groupId)) groups.set(groupId, { id: groupId, label: projectRoot ? path.basename(projectRoot) : "Unassigned missions", root: projectRoot, scope: projectRoot, sessions: [] });
    groups.get(groupId)!.sessions.push({
      id, nativeId: id, name: title, path: existsSync(transcript) ? transcript : sourceFile,
      mtime: s?.mtimeMs ?? 0, bytes: s?.size ?? 0, resumable: false, source: "native",
    });
  }
  return [...groups.values()].sort((a, b) => (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const agent = url.searchParams.get("agent");
  const requestedPath = url.searchParams.get("path");
  const home = os.homedir();
  let groups: HistoryGroup[] = [];
  let source = "";
  if (agent === "claude") {
    source = path.join(home, ".claude", "projects");
    const titles = await claudeHistory(home);
    groups = await grouped(source, false);
    groups = await Promise.all(groups.map(async (group) => {
      const cwd = await claudeCwd(group.sessions[0]?.path);
      const sessions = await Promise.all(group.sessions.map(async (session) => ({
        ...session,
        name: titles.get(session.id)?.title ?? await claudeTranscriptTitle(session.path) ?? session.name,
        nativeId: session.id,
        resumable: true,
        source: "native" as const,
      })));
      return { ...group, label: cwd ?? group.label, root: cwd ?? group.root, sessions };
    }));
  } else if (agent === "openclaw") {
    source = path.join(home, ".openclaw", "agents");
    groups = await openClawGroups(home);
  } else if (agent === "hermes") {
    source = hermesHome();
    groups = await hermesGroups(home);
  } else if (agent === "antigravity") {
    source = path.join(home, ".gemini", "antigravity");
    groups = await antigravityGroups(home);
  } else if (agent === "codex") {
    source = path.join(home, ".codex", "sessions");
    groups = await codexGroups(home);
  } else {
    return NextResponse.json({ error: "unsupported agent" }, { status: 400 });
  }
  if (requestedPath) {
    if (agent === "hermes" && requestedPath.startsWith("hermesdb:")) {
      const detail = hermesDetail(requestedPath);
      return detail ? NextResponse.json({ detail }) : NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    if (agent === "codex" && requestedPath.startsWith("codex:")) {
      const detail = await readCodexSession(requestedPath.slice(6));
      return detail ? NextResponse.json({ detail: { path: requestedPath, turns: detail.turns, raw: "", bytes: 0, truncated: false, cwd: detail.cwd, model: detail.model } }) : NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    const detail = await fileDetail(requestedPath, source);
    return detail ? NextResponse.json({ detail }) : NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const sessionCount = groups.reduce((n, g) => n + g.sessions.length, 0);
  return NextResponse.json({ agent, source, groups, sessionCount });
}
