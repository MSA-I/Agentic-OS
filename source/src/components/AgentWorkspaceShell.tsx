"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive, Bot, Box, ChevronDown, ChevronRight, Command, FileStack,
  FolderKanban, GitBranch, MessageSquare, Orbit, Pin, Plus, Search,
  Settings2, Sparkles, Wrench,
} from "lucide-react";

export type WorkspaceAgent = "claude" | "openclaw" | "hermes" | "antigravity" | "codex";
export type WorkspaceSection = "new" | "tools" | "messages" | "artifacts" | "projects" | "history";
export type WorkspaceAction = "new" | "select" | "project" | "navigate";

export interface WorkspaceSessionRef {
  id: string;
  name: string;
  path: string;
  mtime: number;
  bytes: number;
  nativeId?: string;
  nativeStarted?: boolean;
  sessionKey?: string;
  resumable?: boolean;
  source?: "native" | "local";
  pinned?: boolean;
  preview?: string;
}

export interface WorkspaceProjectRef {
  id: string;
  label: string;
  root: string;
  scope?: string;
}

export interface WorkspaceNavDetail {
  agent: WorkspaceAgent;
  action: WorkspaceAction;
  section: WorkspaceSection;
  project?: WorkspaceProjectRef;
  session?: WorkspaceSessionRef;
}

interface Group extends WorkspaceProjectRef { sessions: WorkspaceSessionRef[]; }
interface LocalSession extends WorkspaceSessionRef { projectId: string; source: "local"; }

const meta: Record<WorkspaceAgent, {
  accent: string;
  shell: string;
  product: string;
  newLabel: string;
  search: string;
  projectLabel: string;
  emptyPinned: string;
  controls: { section: WorkspaceSection; label: string; icon: React.ReactNode }[];
}> = {
  codex: {
    accent: "#6867AA", shell: "#10101A", product: "CODEX",
    newLabel: "New task", search: "Search tasks", projectLabel: "Projects",
    emptyPinned: "Shift-click a task to pin",
    controls: [
      { section: "tools", label: "Skills & tools", icon: <Wrench size={14} /> },
      { section: "messages", label: "Tasks", icon: <MessageSquare size={14} /> },
      { section: "artifacts", label: "Changes & artifacts", icon: <FileStack size={14} /> },
    ],
  },
  claude: {
    accent: "#D97757", shell: "#F1ECE4", product: "CLAUDE CODE",
    newLabel: "New chat", search: "Search conversations", projectLabel: "Projects",
    emptyPinned: "Starred chats appear here",
    controls: [
      { section: "messages", label: "Chats", icon: <MessageSquare size={14} /> },
      { section: "projects", label: "Projects", icon: <FolderKanban size={14} /> },
      { section: "artifacts", label: "Artifacts", icon: <Sparkles size={14} /> },
    ],
  },
  hermes: {
    accent: "#EDFF45", shell: "#0000F2", product: "HERMES",
    newLabel: "New session", search: "Search session memory", projectLabel: "Profiles",
    emptyPinned: "Pin an active mission",
    controls: [
      { section: "messages", label: "Agent console", icon: <Command size={14} /> },
      { section: "tools", label: "Skills, tools & MCPs", icon: <Wrench size={14} /> },
      { section: "artifacts", label: "Workspace", icon: <FileStack size={14} /> },
    ],
  },
  openclaw: {
    accent: "#F5654A", shell: "#101012", product: "OPENCLAW GATEWAY",
    newLabel: "New thread", search: "Search agent threads", projectLabel: "Agents",
    emptyPinned: "Pin a gateway thread",
    controls: [
      { section: "messages", label: "Threads", icon: <MessageSquare size={14} /> },
      { section: "tools", label: "Gateway control", icon: <Settings2 size={14} /> },
      { section: "artifacts", label: "Studio", icon: <Sparkles size={14} /> },
    ],
  },
  antigravity: {
    accent: "#FF4E45", shell: "#1F2853", product: "ANTIGRAVITY",
    newLabel: "New mission", search: "Search missions", projectLabel: "Workspaces",
    emptyPinned: "Pin a mission or workspace",
    controls: [
      { section: "messages", label: "Mission chat", icon: <Orbit size={14} /> },
      { section: "projects", label: "Workspace files", icon: <FolderKanban size={14} /> },
      { section: "artifacts", label: "Brain & artifacts", icon: <FileStack size={14} /> },
    ],
  },
};

function shortLabel(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.split("/").pop() || value;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export default function AgentWorkspaceShell({
  agent,
  active,
  children,
}: {
  agent: WorkspaceAgent;
  active: WorkspaceSection;
  children: React.ReactNode;
}) {
  const ui = meta[agent];
  const [nativeGroups, setNativeGroups] = useState<Group[]>([]);
  const [localSessions, setLocalSessions] = useState<LocalSession[]>([]);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionPath, setActiveSessionPath] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string[]>([]);

  const pinKey = `agentic-os:${agent}:pinned-sessions:v2`;
  const localKey = `agentic-os:${agent}:local-sessions:v2`;
  const projectKey = `agentic-os:${agent}:active-project:v2`;
  const sessionKey = `agentic-os:${agent}:active-session:v2`;

  const emit = useCallback((detail: Omit<WorkspaceNavDetail, "agent">) => {
    window.dispatchEvent(new CustomEvent<WorkspaceNavDetail>("agent-workspace-nav", { detail: { agent, ...detail } }));
  }, [agent]);

  const load = useCallback(() => {
    fetch(`/api/agent-history?agent=${agent}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : { groups: [] })
      .then((payload) => {
        const next = Array.isArray(payload.groups) ? (payload.groups as Group[]).map((group) => ({
          ...group,
          sessions: group.sessions.map((session) => ({
            ...session,
            nativeId: session.nativeId ?? session.id,
            nativeStarted: session.nativeStarted ?? true,
            resumable: session.resumable ?? agent !== "antigravity",
            source: session.source ?? "native",
          })),
        })) : [];
        setNativeGroups(next);
        const nativePinned = next.flatMap((group) => group.sessions.filter((session) => session.pinned).map((session) => session.path));
        if (nativePinned.length) setPinned((current) => [...new Set([...nativePinned, ...current])]);
        const url = new URL(window.location.href);
        const remembered = url.searchParams.get("project") || localStorage.getItem(projectKey);
        const chosen = next.find((group) => group.id === remembered)?.id ?? next[0]?.id ?? null;
        setActiveProjectId((current) => current ?? chosen);
        setExpanded((current) => current ?? chosen);
      })
      .catch(() => setNativeGroups([]));
  }, [agent, projectKey]);

  useEffect(() => {
    setPinned(safeParse(localStorage.getItem(pinKey), []));
    setLocalSessions(safeParse(localStorage.getItem(localKey), []));
    const url = new URL(window.location.href);
    setActiveSessionPath(url.searchParams.get("session") || localStorage.getItem(sessionKey));
    load();
  }, [load, localKey, pinKey, sessionKey]);

  useEffect(() => {
    const onRename = (event: Event) => {
      const detail = (event as CustomEvent<{ agent?: WorkspaceAgent; sessionPath?: string; title?: string }>).detail;
      if (detail?.agent !== agent || !detail.sessionPath || !detail.title?.trim()) return;
      setLocalSessions((current) => current.map((session) => session.path === detail.sessionPath
        ? { ...session, name: detail.title!.trim().slice(0, 80), mtime: Date.now() }
        : session));
    };
    window.addEventListener("agent-conversation-renamed", onRename);
    const onNativeId = (event: Event) => {
      const detail = (event as CustomEvent<{ agent?: WorkspaceAgent; sessionPath?: string; nativeId?: string }>).detail;
      if (detail?.agent !== agent || !detail.sessionPath || !detail.nativeId) return;
      setLocalSessions((current) => current.map((session) => session.path === detail.sessionPath
        ? { ...session, nativeId: detail.nativeId, nativeStarted: true, resumable: true }
        : session));
    };
    window.addEventListener("agent-conversation-native-id", onNativeId);
    return () => {
      window.removeEventListener("agent-conversation-renamed", onRename);
      window.removeEventListener("agent-conversation-native-id", onNativeId);
    };
  }, [agent]);

  useEffect(() => { localStorage.setItem(localKey, JSON.stringify(localSessions)); }, [localKey, localSessions]);
  useEffect(() => { localStorage.setItem(pinKey, JSON.stringify(pinned)); }, [pinKey, pinned]);

  useEffect(() => {
    if (!activeProjectId) return;
    localStorage.setItem(projectKey, activeProjectId);
    const url = new URL(window.location.href);
    url.searchParams.set("project", activeProjectId);
    if (activeSessionPath) url.searchParams.set("session", activeSessionPath);
    else url.searchParams.delete("session");
    window.history.replaceState(window.history.state, "", url);
  }, [activeProjectId, activeSessionPath, projectKey]);

  useEffect(() => {
    if (activeSessionPath) localStorage.setItem(sessionKey, activeSessionPath);
    else localStorage.removeItem(sessionKey);
  }, [activeSessionPath, sessionKey]);

  const groups = useMemo(() => {
    const next = nativeGroups.map((group) => ({ ...group, sessions: [...group.sessions] }));
    for (const session of localSessions) {
      let group = next.find((item) => item.id === session.projectId);
      if (!group) {
        group = { id: session.projectId, label: session.projectId, root: "", sessions: [] };
        next.push(group);
      }
      if (!group.sessions.some((item) => item.path === session.path)) group.sessions.unshift(session);
    }
    return next;
  }, [localSessions, nativeGroups]);

  const activeProject = groups.find((group) => group.id === activeProjectId) ?? groups[0] ?? null;
  const allSessions = groups.flatMap((group) => group.sessions.map((session) => ({ ...session, project: group })));
  const pinnedRows = pinned.map((path) => allSessions.find((session) => session.path === path)).filter(Boolean) as (WorkspaceSessionRef & { project: Group })[];

  useEffect(() => {
    if (!activeProject) return;
    const session = allSessions.find((item) => item.path === activeSessionPath);
    localStorage.setItem(`agentic-os:${agent}:conversation-context:v2`, JSON.stringify({
      project: { id: activeProject.id, label: activeProject.label, root: activeProject.root, scope: activeProject.scope },
      session: session ? { id: session.id, name: session.name, path: session.path, mtime: session.mtime, bytes: session.bytes, nativeId: session.nativeId, nativeStarted: session.nativeStarted, sessionKey: session.sessionKey, resumable: session.resumable, source: session.source } : null,
    }));
  }, [activeProject, activeSessionPath, agent, allSessions]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups.map((group) => ({
      ...group,
      sessions: group.sessions.filter((session) => `${session.name} ${session.id}`.toLowerCase().includes(needle)),
    })).filter((group) => group.label.toLowerCase().includes(needle) || group.sessions.length > 0);
  }, [groups, query]);

  function projectRef(group: Group): WorkspaceProjectRef {
    return { id: group.id, label: group.label, root: group.root, scope: group.scope };
  }

  function selectProject(group: Group) {
    setActiveProjectId(group.id);
    setExpanded(group.id);
    setActiveSessionPath(null);
    emit({ action: "project", section: "messages", project: projectRef(group) });
  }

  function startNewSession() {
    const project = activeProject ?? { id: `${agent}:inbox`, label: "Inbox", root: "", sessions: [] };
    const id = crypto.randomUUID();
    const session: LocalSession = {
      id, name: agent === "codex" ? "New task" : agent === "antigravity" ? "New mission" : "New conversation",
      path: `local:${id}`, mtime: Date.now(), bytes: 0, projectId: project.id,
      nativeId: id, nativeStarted: false, resumable: true, source: "local",
    };
    setLocalSessions((current) => [session, ...current]);
    setActiveProjectId(project.id);
    setExpanded(project.id);
    setActiveSessionPath(session.path);
    emit({ action: "new", section: "new", project: projectRef(project), session });
  }

  function openSession(group: Group, session: WorkspaceSessionRef) {
    setActiveProjectId(group.id);
    setExpanded(group.id);
    setActiveSessionPath(session.path);
    emit({ action: "select", section: "messages", project: projectRef(group), session });
  }

  function navigate(section: WorkspaceSection) {
    emit({ action: "navigate", section, project: activeProject ? projectRef(activeProject) : undefined });
  }

  function togglePin(path: string) {
    setPinned((current) => current.includes(path) ? current.filter((item) => item !== path) : [path, ...current]);
  }

  const agentIcon = agent === "openclaw" ? <Box size={13} /> : agent === "antigravity" ? <Orbit size={13} /> : agent === "codex" ? <Command size={13} /> : <Bot size={13} />;

  return (
    <div data-agent-workspace={agent} className="grid min-h-[calc(100vh-190px)] grid-cols-1 gap-4 lg:grid-cols-[276px_minmax(0,1fr)]">
      <aside
        data-agent-sidebar={agent}
        className="overflow-hidden rounded-xl border lg:sticky lg:top-4 lg:max-h-[calc(100vh-150px)] lg:overflow-y-auto"
        style={{ background: ui.shell, borderColor: `${ui.accent}2f`, boxShadow: `0 18px 60px -42px ${ui.accent}` }}
      >
        <div className="border-b px-3.5 pb-3 pt-3" style={{ borderColor: `${ui.accent}22` }}>
          <div className="flex items-center justify-between text-[9px] font-semibold tracking-[0.22em]" style={{ color: ui.accent }}>
            <span className="flex items-center gap-1.5">{agentIcon}{ui.product}</span>
            <span className="rounded-full border px-1.5 py-0.5" style={{ borderColor: `${ui.accent}35`, color: `${ui.accent}cc` }}>LOCAL</span>
          </div>
          <button
            onClick={startNewSession}
            className="mt-3 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-[12px] font-semibold transition hover:brightness-125"
            style={{ color: "var(--fg)", borderColor: `${ui.accent}45`, background: `${ui.accent}16` }}
          >
            <Plus size={14} style={{ color: ui.accent }} />
            <span className="flex-1">{ui.newLabel}</span>
            <kbd className="rounded border px-1.5 py-0.5 text-[8px]" style={{ borderColor: `${ui.accent}33`, color: "var(--fg-dimmer)" }}>Ctrl N</kbd>
          </button>
        </div>

        <div className="space-y-0.5 px-2.5 py-2.5">
          {ui.controls.map((item) => {
            const selected = active === item.section || (item.section === "messages" && active === "new");
            return <button key={item.section} onClick={() => navigate(item.section)}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[11.5px] transition hover:bg-white/[0.035]"
              style={{ color: selected ? "var(--fg)" : "var(--fg-dim)", background: selected ? `${ui.accent}12` : undefined }}>
              <span style={{ color: selected ? ui.accent : "var(--fg-dimmer)" }}>{item.icon}</span>
              <span className="flex-1">{item.label}</span>
            </button>;
          })}
        </div>

        <label className="mx-3 mt-1 flex items-center gap-2 border-b px-1 py-2.5" style={{ borderColor: `${ui.accent}25`, color: "var(--fg-dimmer)" }}>
          <Search size={12} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={ui.search}
            className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--fg)] outline-none placeholder:text-[var(--fg-dimmer)]" />
        </label>

        <div className="px-3 pb-1 pt-4 text-[8.5px] font-semibold uppercase tracking-[0.22em] text-[var(--fg-dimmer)]">Pinned</div>
        <div className="space-y-0.5 px-2.5">
          {pinnedRows.length === 0 && <div className="flex items-center gap-2 px-2 py-1.5 text-[10px] text-[var(--fg-dimmer)]"><Pin size={10} /> {ui.emptyPinned}</div>}
          {pinnedRows.map((row) => <button key={row.path} onClick={() => openSession(row.project, row)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[10.5px] text-[var(--fg-dim)] hover:bg-white/[0.04]">
            <Pin size={9} style={{ color: ui.accent }} /><span className="truncate">{row.name}</span>
          </button>)}
        </div>

        <div className="mt-3 flex items-center justify-between px-4 py-2 text-[8.5px] font-semibold uppercase tracking-[0.2em] text-[var(--fg-dimmer)]">
          <span>{ui.projectLabel}</span><span>{groups.length}</span>
        </div>

        <div className="space-y-0.5 px-2.5 pb-3">
          {filtered.map((group) => {
            const isOpen = expanded === group.id;
            const isActive = activeProjectId === group.id;
            return <section key={group.id}>
              <button onClick={() => isActive ? setExpanded(isOpen ? null : group.id) : selectProject(group)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition hover:bg-white/[0.04]"
                style={{ background: isActive ? `${ui.accent}10` : undefined }}>
                {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                <FolderKanban size={10} style={{ color: isActive ? ui.accent : "var(--fg-dimmer)" }} />
                <span className="min-w-0 flex-1 truncate text-[10.5px]" style={{ color: isActive ? "var(--fg)" : "var(--fg-dim)" }} title={group.label}>{shortLabel(group.label)}</span>
                <span className="text-[9px] text-[var(--fg-dimmer)]">{group.sessions.length}</span>
              </button>
              {isOpen && <div className="ml-5 border-l pl-1.5" style={{ borderColor: `${ui.accent}28` }}>
                {group.sessions.slice(0, 18).map((session) => {
                  const selected = activeSessionPath === session.path;
                  return <button key={session.path}
                    onClick={(event) => event.shiftKey ? togglePin(session.path) : openSession(group, session)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[10px] transition hover:bg-white/[0.045]"
                    style={{ color: selected ? "var(--fg)" : "var(--fg-dim)", background: selected ? `${ui.accent}18` : undefined }}
                    title={session.resumable === false ? "Open history · native resume unavailable" : "Open conversation · Shift-click to pin"}>
                    {pinned.includes(session.path) ? <Pin size={8} style={{ color: ui.accent }} /> : session.source === "local" ? <MessageSquare size={8} style={{ color: ui.accent }} /> : <GitBranch size={8} />}
                    <span className="truncate">{session.name}</span>
                  </button>;
                })}
                {group.sessions.length === 0 && <div className="px-2 py-2 text-[9.5px] text-[var(--fg-dimmer)]">No conversations yet</div>}
              </div>}
            </section>;
          })}
        </div>

        <button onClick={load} className="flex w-full items-center gap-2 border-t px-4 py-3 text-[9.5px] text-[var(--fg-dimmer)] hover:text-[var(--fg-dim)]" style={{ borderColor: `${ui.accent}20` }}>
          <Archive size={10} /> Refresh native history
        </button>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
