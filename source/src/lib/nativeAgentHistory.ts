import { open, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { hermesHome } from "@/lib/config";
import { readSession as readCodexSession } from "@/lib/codexWorkspace";

export type NativeHistoryAgent = "codex" | "claude" | "hermes" | "openclaw" | "antigravity";

export interface NativeSessionRow {
  id: string;
  name: string;
  path: string;
  mtime: number;
  bytes: number;
  nativeId?: string;
  sessionKey?: string;
  resumable?: boolean;
  /** Storage provenance. Keep this native/local contract stable for resume. */
  source?: "native" | "local";
  /** Runtime/channel provenance, kept separate from storage provenance. */
  channelSource?: string;
  platform?: string;
  channel?: string;
  chatType?: string;
  chatId?: string;
  threadId?: string;
  /** Hidden native ids/keys represented by this canonical conversation row. */
  aliases?: string[];
  lineageRootId?: string;
  pinned?: boolean;
  preview?: string;
}
export interface NativeHistoryGroup { id: string; label: string; root: string; scope?: string; sessions: NativeSessionRow[]; }
export interface NativeTranscriptTurn { role: "user" | "assistant" | "system" | "tool" | "reasoning"; text: string; }
export interface NativeHistoryDetail {
  path: string;
  turns: NativeTranscriptTurn[];
  raw: string;
  bytes: number;
  truncated: boolean;
  cwd?: string;
  model?: string | null;
  source?: "native" | "local";
  channelSource?: string;
  platform?: string;
  channel?: string;
  chatType?: string;
  chatId?: string;
  threadId?: string;
  sessionKey?: string;
  toolCalls?: unknown[];
  referencedFiles?: string[];
  cwdFiles?: unknown[];
}

export interface NativeHistoryIndex {
  agent: NativeHistoryAgent;
  source: string;
  groups: NativeHistoryGroup[];
  sessionCount: number;
}

export type NativeHistoryReadResult =
  | { ok: true; kind: "index"; value: NativeHistoryIndex }
  | { ok: true; kind: "detail"; value: NativeHistoryDetail }
  | { ok: false; code: "not_found"; message: string };

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => typeof v === "string" ? v : textOf((v as { text?: unknown })?.text ?? v)).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return textOf(v.text ?? v.content ?? v.message ?? v.output ?? "");
  }
  return "";
}

function collectTurns(value: unknown, out: NativeTranscriptTurn[] = []): NativeTranscriptTurn[] {
  if (!value || out.length >= 250) return out;
  if (Array.isArray(value)) { for (const item of value) collectTurns(item, out); return out; }
  if (typeof value !== "object") return out;
  const row = value as Record<string, unknown>;
  const message = row.message && typeof row.message === "object" ? row.message as Record<string, unknown> : null;
  const rawRole = String(message?.role ?? row.role ?? row.source ?? row.type ?? "").toLowerCase();
  const role: NativeTranscriptTurn["role"] | null = rawRole.includes("assistant") || rawRole === "model" ? "assistant" : rawRole.includes("user") ? "user" : rawRole.includes("system") ? "system" : rawRole.includes("tool") ? "tool" : null;
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
  let turns: NativeTranscriptTurn[] = [];
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

  const turns: NativeTranscriptTurn[] = [];
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

async function fileRows(dir: string): Promise<NativeSessionRow[]> {
  if (!existsSync(dir)) return [];
  const rows: NativeSessionRow[] = [];
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

async function grouped(root: string, nestedSessions: boolean): Promise<NativeHistoryGroup[]> {
  if (!existsSync(root)) return [];
  const groups: NativeHistoryGroup[] = [];
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

function canonicalFsPath(value: string): string {
  return value
    .replace(/^\\\\\?\\/, "")
    .replace(/[\\/]+$/, "")
    .toLocaleLowerCase();
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = canonicalFsPath(candidate);
  const normalizedRoot = canonicalFsPath(root);
  return Boolean(normalizedCandidate && normalizedRoot)
    && (normalizedCandidate === normalizedRoot
      || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
      || normalizedCandidate.startsWith(`${normalizedRoot}/`));
}

function canonicalizeSessionGroups(
  agent: NativeHistoryAgent,
  groups: NativeHistoryGroup[],
): NativeHistoryGroup[] {
  const actorScoped = agent === "hermes" || agent === "openclaw";
  const winners = new Map<string, { groupId: string; session: NativeSessionRow }>();
  for (const group of groups) {
    for (const session of group.sessions) {
      const nativeId = session.nativeId || session.id;
      const identity = `${actorScoped ? group.scope ?? group.id : agent}:${nativeId}`;
      const existing = winners.get(identity);
      if (!existing || session.mtime > existing.session.mtime) {
        session.aliases = [...new Set([...(existing?.session.aliases ?? []), ...(session.aliases ?? [])])];
        winners.set(identity, { groupId: group.id, session });
      } else {
        existing.session.aliases = [...new Set([...(existing.session.aliases ?? []), ...(session.aliases ?? [])])];
      }
    }
  }
  return groups.map((group) => ({
    ...group,
    sessions: group.sessions
      .filter((session) => {
        const nativeId = session.nativeId || session.id;
        const identity = `${actorScoped ? group.scope ?? group.id : agent}:${nativeId}`;
        const winner = winners.get(identity);
        return winner?.groupId === group.id && winner.session === session;
      })
      .sort((a, b) => b.mtime - a.mtime),
  }));
}

interface HermesRoutingMetadata {
  sessionId: string;
  sessionKey: string;
  platform: string;
  chatType: string;
  displayName: string;
  chatName: string;
  chatId: string;
  threadId: string;
}

interface HermesRoutingIndex {
  bySessionId: Map<string, HermesRoutingMetadata>;
  bySessionKey: Map<string, HermesRoutingMetadata>;
}

function routingText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

async function hermesRoutingIndex(home: string): Promise<HermesRoutingIndex> {
  const bySessionId = new Map<string, HermesRoutingMetadata>();
  const bySessionKey = new Map<string, HermesRoutingMetadata>();
  const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
  const sessionsFile = path.join(localAppData, "hermes", "sessions", "sessions.json");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(sessionsFile, "utf8")); }
  catch { return { bySessionId, bySessionKey }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { bySessionId, bySessionKey };

  for (const [indexKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (indexKey === "_README" || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const origin = row.origin && typeof row.origin === "object" && !Array.isArray(row.origin)
      ? row.origin as Record<string, unknown>
      : {};
    const sessionId = routingText(row.session_id);
    const sessionKey = routingText(row.session_key) || indexKey;
    const metadata: HermesRoutingMetadata = {
      sessionId,
      sessionKey,
      platform: (routingText(row.platform) || routingText(origin.platform)).toLowerCase(),
      chatType: (routingText(row.chat_type) || routingText(origin.chat_type)).toLowerCase(),
      displayName: routingText(row.display_name),
      chatName: routingText(origin.chat_name) || routingText(origin.user_name),
      chatId: routingText(origin.chat_id) || routingText(row.chat_id),
      threadId: routingText(origin.thread_id) || routingText(row.thread_id),
    };
    if (sessionId) bySessionId.set(sessionId, metadata);
    if (sessionKey) bySessionKey.set(sessionKey, metadata);
  }
  return { bySessionId, bySessionKey };
}

function hermesRoutingFor(
  index: HermesRoutingIndex,
  sessionId: string,
  sessionKey: string,
): HermesRoutingMetadata | null {
  return index.bySessionId.get(sessionId) ?? (sessionKey ? index.bySessionKey.get(sessionKey) : null) ?? null;
}

function hermesSessionSelect(dbFile: string): Record<string, unknown>[] {
  const available = hermesSessionColumns(dbFile);
  const optional = (column: string) => available.has(column) ? `s.${column}` : `NULL AS ${column}`;
  const archivedWhere = available.has("archived") ? "COALESCE(s.archived, 0) = 0" : "1 = 1";
  return sqliteAll(dbFile, `
    SELECT s.id, s.title, s.cwd, s.started_at, s.ended_at, s.message_count, s.model,
      ${optional("source")}, ${optional("session_key")}, ${optional("chat_id")},
      ${optional("chat_type")}, ${optional("thread_id")}, ${optional("parent_session_id")},
      ${optional("model_config")}, ${optional("end_reason")},
      (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' AND m.active = 1 ORDER BY m.timestamp ASC LIMIT 1) AS preview
    FROM sessions s WHERE ${archivedWhere}
    ORDER BY COALESCE(s.ended_at, s.started_at) DESC
  `);
}

function hermesSessionColumns(dbFile: string): Set<string> {
  return new Set(sqliteAll(dbFile, "PRAGMA table_info(sessions)").map((row) => String(row.name)));
}

function hermesModelConfig(row: Record<string, unknown>): Record<string, unknown> {
  if (row.model_config && typeof row.model_config === "object" && !Array.isArray(row.model_config)) {
    return row.model_config as Record<string, unknown>;
  }
  if (typeof row.model_config !== "string" || !row.model_config.trim()) return {};
  try {
    const value = JSON.parse(row.model_config) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function hermesActivity(row: Record<string, unknown>): number {
  return timeMs(row.ended_at ?? row.started_at);
}

/** Mirror Hermes Desktop's native picker contract: roots + real branches. */
function canonicalHermesSessions(rows: Record<string, unknown>[]): Array<{
  row: Record<string, unknown>;
  lineageRootId: string | null;
  aliases: string[];
}> {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const children = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const parentId = routingText(row.parent_session_id);
    if (!parentId) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(row);
    children.set(parentId, siblings);
  }

  const isBranch = (row: Record<string, unknown>) => {
    const config = hermesModelConfig(row);
    if (routingText(config._branched_from)) return true;
    const parent = byId.get(routingText(row.parent_session_id));
    return Boolean(parent
      && routingText(parent.end_reason) === "branched"
      && Number(row.started_at ?? 0) >= Number(parent.ended_at ?? Number.POSITIVE_INFINITY));
  };
  const isDelegate = (row: Record<string, unknown>) => Boolean(routingText(hermesModelConfig(row)._delegate_from));
  const isConversation = (row: Record<string, unknown>) => {
    const source = routingText(row.source).toLowerCase();
    return Number(row.message_count ?? 0) > 0 && source !== "cron" && source !== "subagent" && source !== "tool";
  };

  const tipFor = (root: Record<string, unknown>) => {
    let current = root;
    const aliases = [String(root.id)];
    const seen = new Set(aliases);
    for (let depth = 0; depth < 100 && routingText(current.end_reason) === "compression"; depth++) {
      const candidates = (children.get(String(current.id)) ?? [])
        .filter((child) => !isBranch(child) && !isDelegate(child) && routingText(child.source) !== "tool")
        .sort((left, right) => {
          const rank = (row: Record<string, unknown>) => routingText(row.end_reason) === "compression" ? 0 : row.ended_at == null ? 1 : 2;
          return rank(left) - rank(right)
            || hermesActivity(right) - hermesActivity(left)
            || Number(right.started_at ?? 0) - Number(left.started_at ?? 0)
            || String(right.id).localeCompare(String(left.id));
        });
      const next = candidates[0];
      if (!next || seen.has(String(next.id))) break;
      current = next;
      aliases.push(String(next.id));
      seen.add(String(next.id));
    }
    return { row: current, lineageRootId: current === root ? null : String(root.id), aliases };
  };

  return rows
    .filter((row) => (!routingText(row.parent_session_id) || isBranch(row)) && !isDelegate(row) && isConversation(row))
    .map(tipFor);
}

async function hermesGroups(home: string): Promise<NativeHistoryGroup[]> {
  const root = hermesHome();
  const profiles: { name: string; dir: string; db: string }[] = [{ name: "default", dir: root, db: path.join(root, "state.db") }];
  try {
    for (const entry of await readdir(path.join(root, "profiles"), { withFileTypes: true })) {
      if (entry.isDirectory()) profiles.push({ name: entry.name, dir: path.join(root, "profiles", entry.name), db: path.join(root, "profiles", entry.name, "state.db") });
    }
  } catch { /* profiles optional */ }

  const routingIndex = await hermesRoutingIndex(home);
  const groups = new Map<string, NativeHistoryGroup>();
  for (const profile of profiles) {
    const candidates = canonicalHermesSessions(hermesSessionSelect(profile.db));
    const conversations = new Map<string, (typeof candidates)[number] & { routing: HermesRoutingMetadata | null }>();
    for (const candidate of candidates) {
      const row = candidate.row;
      const id = String(row.id);
      const sessionKey = routingText(row.session_key);
      // Messaging routing belongs to the default Hermes actor only. Never use
      // the global sessions.json index to relabel another profile's session.
      const routing = profile.name === "default" ? hermesRoutingFor(routingIndex, id, sessionKey) : null;
      const platform = (routing?.platform || routingText(row.source)).toLowerCase();
      const effectiveSessionKey = routing?.sessionKey || sessionKey;
      // Gateway restarts and context resets can create many storage rows for
      // one native channel. Only the routing ledger's exact session key is a
      // safe conversation identity; unkeyed Discord rows may be distinct DMs,
      // groups or threads and must remain separate.
      const canonicalKey = effectiveSessionKey
        ? `${platform || "session"}:${effectiveSessionKey}`
        : id;
      const existing = conversations.get(canonicalKey);
      if (!existing || hermesActivity(row) > hermesActivity(existing.row)) {
        conversations.set(canonicalKey, {
          ...candidate,
          aliases: [...new Set([...(existing?.aliases ?? []), ...candidate.aliases])],
          routing,
        });
      } else {
        existing.aliases = [...new Set([...existing.aliases, ...candidate.aliases])];
      }
    }

    for (const candidate of conversations.values()) {
      const row = candidate.row;
      const id = String(row.id);
      const sessionKey = routingText(row.session_key);
      const routing = candidate.routing;
      const nativeSource = routingText(row.source).toLowerCase();
      const platform = (routing?.platform || nativeSource).toLowerCase();
      const chatType = (routing?.chatType || routingText(row.chat_type)).toLowerCase();
      const chatId = routing?.chatId || routingText(row.chat_id);
      const threadId = routing?.threadId || routingText(row.thread_id);
      const isDiscord = platform === "discord";
      const channel = isDiscord ? (routing?.displayName || routing?.chatName || "history") : "";
      const cwd = typeof row.cwd === "string" && row.cwd ? row.cwd : "";
      const groupId = isDiscord
        ? `${profile.name}:discord:${chatId || routing?.sessionKey || "history"}`
        : `${profile.name}:${cwd || "no-project"}`;
      if (!groups.has(groupId)) groups.set(groupId, {
        id: groupId,
        label: isDiscord ? `Discord · ${channel}` : cwd ? `${profile.name} · ${path.basename(cwd)}` : profile.name,
        root: cwd || profile.dir,
        scope: profile.name,
        sessions: [],
      });
      const preview = typeof row.preview === "string" ? row.preview.replace(/\s+/g, " ").trim() : "";
      const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : preview || `Session ${id.slice(0, 8)}`;
      groups.get(groupId)!.sessions.push({
        id, nativeId: id, sessionKey: routing?.sessionKey || sessionKey || undefined,
        name: title.slice(0, 120), path: `hermesdb:${profile.name}:${id}`,
        mtime: timeMs(row.ended_at ?? row.started_at), bytes: Number(row.message_count ?? 0),
        resumable: true,
        aliases: candidate.aliases.filter((alias) => alias !== id),
        lineageRootId: candidate.lineageRootId ?? undefined,
        source: "native",
        channelSource: platform || undefined,
        platform: platform || undefined,
        channel: channel || undefined,
        chatType: chatType || undefined,
        chatId: chatId || undefined,
        threadId: threadId || undefined,
        preview: preview.slice(0, 220),
      });
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    sessions: group.sessions.sort((a, b) => b.mtime - a.mtime),
  })).sort((a, b) => {
    if (a.scope === "default" && b.scope !== "default") return -1;
    if (b.scope === "default" && a.scope !== "default") return 1;
    return (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0);
  });
}

async function hermesDetail(token: string) {
  const match = /^hermesdb:([^:]+):(.+)$/.exec(token);
  if (!match) return null;
  const [, profile, id] = match;
  if (!/^[A-Za-z0-9_.-]+$/.test(profile) || !/^[A-Za-z0-9_.:-]+$/.test(id)) return null;
  const root = hermesHome();
  const dbFile = profile === "default" ? path.join(root, "state.db") : path.join(root, "profiles", profile, "state.db");
  const available = hermesSessionColumns(dbFile);
  const optional = (column: string) => available.has(column) ? column : `NULL AS ${column}`;
  const session = sqliteAll(dbFile, `
    SELECT id, cwd, model, message_count, ${optional("source")}, ${optional("session_key")},
      ${optional("chat_id")}, ${optional("chat_type")}, ${optional("thread_id")}
    FROM sessions WHERE id = ? LIMIT 1
  `, id)[0];
  if (!session) return null;
  const rows = sqliteAll(dbFile, "SELECT role, content, reasoning FROM messages WHERE session_id = ? AND active = 1 ORDER BY timestamp ASC", id);
  const turns = rows.flatMap((row): NativeTranscriptTurn[] => {
    const rawRole = String(row.role ?? "").toLowerCase();
    const role: NativeTranscriptTurn["role"] | null = rawRole === "user" ? "user" : rawRole === "assistant" ? "assistant" : rawRole.includes("tool") ? "tool" : rawRole === "system" ? "system" : null;
    const text = String(row.content ?? row.reasoning ?? "").trim();
    return role && text ? [{ role, text: text.slice(0, 80_000) }] : [];
  });
  const sessionKey = routingText(session.session_key);
  const routing = profile === "default"
    ? hermesRoutingFor(await hermesRoutingIndex(os.homedir()), id, sessionKey)
    : null;
  const nativeSource = routingText(session.source).toLowerCase();
  const platform = (routing?.platform || nativeSource).toLowerCase();
  const chatType = (routing?.chatType || routingText(session.chat_type)).toLowerCase();
  const chatId = routing?.chatId || routingText(session.chat_id);
  const threadId = routing?.threadId || routingText(session.thread_id);
  const channel = platform === "discord" ? (routing?.displayName || routing?.chatName || "history") : "";
  return {
    path: token,
    turns,
    raw: "",
    bytes: Number(session.message_count ?? rows.length),
    truncated: false,
    cwd: String(session.cwd ?? ""),
    model: session.model ? String(session.model) : null,
    source: "native" as const,
    channelSource: platform || undefined,
    platform: platform || undefined,
    channel: channel || undefined,
    chatType: chatType || undefined,
    chatId: chatId || undefined,
    threadId: threadId || undefined,
    sessionKey: routing?.sessionKey || sessionKey || undefined,
  };
}

async function openClawGroups(home: string): Promise<NativeHistoryGroup[]> {
  const agentsRoot = path.join(home, ".openclaw", "agents");
  const groups: NativeHistoryGroup[] = [];
  let agents;
  try { agents = await readdir(agentsRoot, { withFileTypes: true }); }
  catch { return []; }
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const indexFile = path.join(agentsRoot, agent.name, "sessions", "sessions.json");
    let index: Record<string, Record<string, unknown>> = {};
    try { index = JSON.parse(await readFile(indexFile, "utf8")); } catch { /* empty agent */ }
    const bySessionId = new Map<string, NativeSessionRow>();
    let workspace = path.join(home, ".openclaw", "workspace");
    for (const [sessionKey, value] of Object.entries(index)) {
      if (/(^|:)agent-os-(?:e2e-)?[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sessionKey)) continue;
      const sessionId = String(value.sessionId ?? "");
      const sessionFile = typeof value.sessionFile === "string" ? value.sessionFile : path.join(agentsRoot, agent.name, "sessions", `${sessionId}.jsonl`);
      if (!sessionId || !existsSync(sessionFile)) continue;
      const s = await stat(sessionFile).catch(() => null);
      const report = value.systemPromptReport as { workspaceDir?: unknown } | undefined;
      if (typeof report?.workspaceDir === "string") workspace = report.workspaceDir;
      let preview = "";
      try {
        const data = await readPrefix(sessionFile, 180_000);
        const turns: NativeTranscriptTurn[] = [];
        for (const line of data.text.split(/\r?\n/)) { try { collectTurns(JSON.parse(line), turns); } catch { /* jsonl */ } }
        preview = turns.find((turn) => turn.role === "user")?.text.replace(/\s+/g, " ").slice(0, 180) ?? "";
      } catch { /* transcript optional */ }
      const session: NativeSessionRow = {
        id: sessionId, nativeId: sessionId, sessionKey, path: sessionFile,
        name: preview || sessionKey.split(":").pop() || `Thread ${sessionId.slice(0, 8)}`,
        mtime: Number(value.updatedAt ?? value.lastActivityAt ?? s?.mtimeMs ?? 0), bytes: s?.size ?? 0,
        resumable: true, source: "native", preview,
      };
      const previous = bySessionId.get(sessionId);
      if (!previous || session.mtime > previous.mtime) {
        session.aliases = previous ? [previous.sessionKey ?? previous.id, ...(previous.aliases ?? [])] : [];
        bySessionId.set(sessionId, session);
      } else {
        previous.aliases = [...new Set([...(previous.aliases ?? []), sessionKey])];
      }
    }
    const sessions = [...bySessionId.values()].sort((a, b) => b.mtime - a.mtime);
    groups.push({ id: `agent:${agent.name}`, label: agent.name, root: workspace, scope: agent.name, sessions: sessions.sort((a, b) => b.mtime - a.mtime) });
  }
  return groups.sort((a, b) => (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0));
}

async function codexGroups(home: string): Promise<NativeHistoryGroup[]> {
  type Project = { id: string; name: string; rootPaths?: string[] };
  type Assignment = { projectId?: string; cwd?: string };
  let state: { "local-projects"?: Record<string, Project>; "project-order"?: string[]; "thread-project-assignments"?: Record<string, Assignment>; "projectless-thread-ids"?: string[] } = {};
  try { state = JSON.parse(await readFile(path.join(home, ".codex", ".codex-global-state.json"), "utf8")); } catch { /* fallback below */ }
  const projects = state["local-projects"] ?? {};
  const order = state["project-order"] ?? Object.keys(projects);
  const assignments = state["thread-project-assignments"] ?? {};
  const groups = new Map<string, NativeHistoryGroup>();
  for (const id of order) {
    const project = projects[id];
    if (!project) continue;
    groups.set(id, { id, label: project.name, root: project.rootPaths?.[0] ?? "", scope: id, sessions: [] });
  }
  const codexDb = path.join(home, ".codex", "state_5.sqlite");
  const threadColumns = new Set(sqliteAll(codexDb, "PRAGMA table_info(threads)").map((row) => String(row.name)));
  const rootThreadWhere = threadColumns.has("agent_path")
    ? "AND (agent_path IS NULL OR agent_path = '' OR agent_path = '/root')"
    : threadColumns.has("source") ? "AND source NOT LIKE '{%subagent%'" : "";
  const rows = sqliteAll(codexDb, `
    SELECT id, title, name, preview, cwd, updated_at_ms, updated_at, recency_at_ms, is_pinned
    FROM threads WHERE archived = 0 ${rootThreadWhere}
    ORDER BY COALESCE(NULLIF(recency_at_ms, 0), NULLIF(updated_at_ms, 0), updated_at) DESC
  `);
  for (const row of rows) {
    const id = String(row.id);
    const cwd = String(row.cwd ?? "");
    let projectId = assignments[id]?.projectId;
    if (!projectId || !groups.has(projectId)) {
      projectId = [...groups.values()]
        .filter((group) => group.root && isPathInside(cwd, group.root))
        .sort((a, b) => canonicalFsPath(b.root).length - canonicalFsPath(a.root).length)[0]?.id;
    }
    if (!projectId) {
      projectId = "projectless";
      if (!groups.has(projectId)) groups.set(projectId, { id: projectId, label: "No project", root: cwd, scope: projectId, sessions: [] });
    }
    const title = [row.name, row.title, row.preview].find((value) => typeof value === "string" && value.trim()) as string | undefined;
    groups.get(projectId)!.sessions.push({
      id, nativeId: id, name: title?.trim().slice(0, 120) || `Session ${id.slice(0, 8)}`,
      path: `codex:${id}`, mtime: timeMs(row.recency_at_ms ?? row.updated_at_ms ?? row.updated_at), bytes: 0,
      resumable: true, source: "native", pinned: Boolean(row.is_pinned), preview: String(row.preview ?? "").slice(0, 220),
    });
  }
  return [...groups.values()].filter((group) => group.sessions.length > 0 || group.id !== "projectless");
}

async function antigravityGroups(home: string): Promise<NativeHistoryGroup[]> {
  const root = path.join(home, ".gemini", "antigravity");
  const conversationsRoot = path.join(root, "conversations");
  const brainRoot = path.join(root, "brain");
  let files;
  try { files = await readdir(conversationsRoot, { withFileTypes: true }); }
  catch { return []; }
  const groups = new Map<string, NativeHistoryGroup>();
  const canonicalFiles = new Map<string, { sourceFile: string; bytes: number; mtime: number }>();
  for (const entry of files) {
    if (!entry.isFile() || !/\.(?:db|pb)$/i.test(entry.name)) continue;
    const id = entry.name.replace(/\.(?:db|pb)$/i, "");
    const sourceFile = path.join(conversationsRoot, entry.name);
    const s = await stat(sourceFile).catch(() => null);
    if (!s) continue;
    const previous = canonicalFiles.get(id);
    if (!previous || s.mtimeMs > previous.mtime) {
      canonicalFiles.set(id, { sourceFile, bytes: s.size, mtime: s.mtimeMs });
    }
  }
  for (const [id, canonicalFile] of canonicalFiles) {
    const transcript = path.join(brainRoot, id, ".system_generated", "logs", "transcript.jsonl");
    const sourceFile = canonicalFile.sourceFile;
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
      mtime: canonicalFile.mtime, bytes: canonicalFile.bytes, resumable: false, source: "native",
    });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    sessions: group.sessions.sort((a, b) => b.mtime - a.mtime),
  })).sort((a, b) => (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0));
}

export interface NativeLoadedSession {
  group: NativeHistoryGroup;
  session: NativeSessionRow;
  detail: NativeHistoryDetail;
}

/** Read the native indexes without copying transcript content into Workbench storage. */
export async function listNativeAgentHistory(agent: NativeHistoryAgent): Promise<NativeHistoryIndex> {
  const home = os.homedir();
  let groups: NativeHistoryGroup[] = [];
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
      // Label with the folder name, the way the Codex grouping below does, and keep
      // the absolute path in `root` for the row's secondary line. Claude encodes the
      // project path into its directory name, so the untouched label read as a path.
      return { ...group, label: cwd ? path.basename(cwd) : group.label, root: cwd ?? group.root, sessions };
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
  }
  groups = canonicalizeSessionGroups(agent, groups);
  const sessionCount = groups.reduce((n, g) => n + g.sessions.length, 0);
  return { agent, source, groups, sessionCount };
}

/** Compatibility read for the existing deep-link API. Safe-root checks stay in the readers. */
export async function readNativeHistoryPath(
  agent: NativeHistoryAgent,
  requestedPath: string,
): Promise<NativeHistoryDetail | null> {
  if (agent === "hermes" && requestedPath.startsWith("hermesdb:")) {
    return hermesDetail(requestedPath);
  }
  if (agent === "codex" && requestedPath.startsWith("codex:")) {
    const detail = await readCodexSession(requestedPath.slice(6));
    return detail ? {
      path: requestedPath,
      turns: detail.turns,
      raw: "",
      bytes: 0,
      truncated: false,
      cwd: detail.cwd,
      model: detail.model,
      toolCalls: detail.toolCalls,
      referencedFiles: detail.referencedFiles,
      cwdFiles: detail.cwdFiles,
    } : null;
  }

  const index = await listNativeAgentHistory(agent);
  return fileDetail(requestedPath, index.source);
}

/** Resolve by native id first, so adapters never accept an arbitrary filesystem path. */
export async function loadNativeAgentSession(
  agent: NativeHistoryAgent,
  sessionId: string,
  constraints: { actorId?: string | null; projectId?: string | null } = {},
): Promise<NativeLoadedSession | null> {
  const index = await listNativeAgentHistory(agent);
  for (const group of index.groups) {
    if (constraints.actorId && group.scope !== constraints.actorId) continue;
    if (constraints.projectId && ![group.id, group.root, group.label].includes(constraints.projectId)) continue;
    const session = group.sessions.find((candidate) =>
      candidate.id === sessionId
      || candidate.nativeId === sessionId
      || candidate.sessionKey === sessionId
      || candidate.aliases?.includes(sessionId)
    );
    if (!session) continue;
    const detail = await readNativeHistoryPath(agent, session.path);
    return detail ? { group, session, detail } : null;
  }
  return null;
}
