"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive, Bot, Box, ChevronDown, ChevronRight, Command, FileStack,
  FolderKanban, GitBranch, Home, MessageSquare, Orbit, Pin, Plus, Search,
  PanelLeftOpen, Settings2, Sparkles, Wifi, WifiOff, Wrench, X,
} from "lucide-react";
import Link from "next/link";
import ScrollArea from "./ScrollArea";

export type WorkspaceAgent = "claude" | "openclaw" | "hermes" | "antigravity" | "codex" | "glm" | "kimi" | "freeclaude";
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
  target?: string;
  project?: WorkspaceProjectRef;
  session?: WorkspaceSessionRef;
}

interface Group extends WorkspaceProjectRef { sessions: WorkspaceSessionRef[]; }
interface LocalSession extends WorkspaceSessionRef { projectId: string; source: "local"; }
interface HermesProfileSummary {
  name: string;
  model: string;
  provider: string;
  active: boolean;
}
interface HermesMcpSummary {
  profile: string;
  installed: number;
  enabled: number;
  names: string[];
}
interface HermesMcpEntry {
  name: string;
  enabled?: boolean;
}
interface OpenClawSummary {
  ok: boolean;
  gateway: string;
  agents: string[];
  sessions: number;
  latencyMs: number;
}

const meta: Record<WorkspaceAgent, {
  accent: string;
  shell: string;
  product: string;
  newLabel: string;
  search: string;
  projectLabel: string;
  emptyPinned: string;
  controls: { target: string; section: WorkspaceSection; label: string; icon: React.ReactNode }[];
}> = {
  codex: {
    accent: "#A7A7AD", shell: "#121212", product: "CODEX",
    newLabel: "New task", search: "Search tasks", projectLabel: "Projects",
    emptyPinned: "Shift-click a task to pin",
    controls: [
      { target: "chat", section: "messages", label: "Tasks", icon: <MessageSquare size={14} /> },
      { target: "goal", section: "tools", label: "Goal mode", icon: <Command size={14} /> },
      { target: "sessions", section: "history", label: "All tasks", icon: <Archive size={14} /> },
      { target: "workspace", section: "projects", label: "Changes", icon: <FileStack size={14} /> },
    ],
  },
  claude: {
    accent: "#943E28", shell: "#F4F1EB", product: "CLAUDE",
    newLabel: "New chat", search: "Search conversations", projectLabel: "Projects",
    emptyPinned: "Starred chats appear here",
    controls: [
      { target: "chat", section: "messages", label: "Chats", icon: <MessageSquare size={14} /> },
      { target: "history", section: "history", label: "History", icon: <Archive size={14} /> },
      { target: "workspace", section: "projects", label: "Projects", icon: <FolderKanban size={14} /> },
      { target: "artifacts", section: "artifacts", label: "Artifacts", icon: <Sparkles size={14} /> },
      { target: "ultracode", section: "tools", label: "Ultracode", icon: <Command size={14} /> },
      { target: "ant", section: "tools", label: "Ant CLI", icon: <Wrench size={14} /> },
      { target: "agents", section: "tools", label: "Agents", icon: <Bot size={14} /> },
    ],
  },
  hermes: {
    accent: "#4055FF", shell: "#EEF1FF", product: "HERMES AGENT",
    newLabel: "New session", search: "Search session memory", projectLabel: "Profiles",
    emptyPinned: "Pin an active mission",
    controls: [
      { target: "chat", section: "messages", label: "Agent console", icon: <Command size={14} /> },
      { target: "profiles", section: "tools", label: "Profiles", icon: <Bot size={14} /> },
      { target: "sessions", section: "history", label: "Sessions", icon: <Archive size={14} /> },
      { target: "radar", section: "tools", label: "Oracle", icon: <Orbit size={14} /> },
      { target: "muse", section: "tools", label: "Muse", icon: <Sparkles size={14} /> },
      { target: "astros", section: "tools", label: "Astros", icon: <Orbit size={14} /> },
      { target: "apollo", section: "tools", label: "Apollo", icon: <Command size={14} /> },
      { target: "studio", section: "artifacts", label: "Studio", icon: <Sparkles size={14} /> },
      { target: "goals", section: "tools", label: "Goals", icon: <FolderKanban size={14} /> },
      { target: "outreach", section: "tools", label: "Outreach", icon: <MessageSquare size={14} /> },
      { target: "moa", section: "tools", label: "MoA", icon: <Bot size={14} /> },
      { target: "workspace", section: "projects", label: "Workspace", icon: <FileStack size={14} /> },
      { target: "mcps", section: "tools", label: "Skills, tools & MCPs", icon: <Wrench size={14} /> },
      { target: "control", section: "tools", label: "Control room", icon: <Command size={14} /> },
      { target: "manage", section: "tools", label: "Settings", icon: <Settings2 size={14} /> },
    ],
  },
  openclaw: {
    accent: "#F5654A", shell: "#101012", product: "OPENCLAW GATEWAY",
    newLabel: "New thread", search: "Search agent threads", projectLabel: "Agents",
    emptyPinned: "Pin a gateway thread",
    controls: [
      { target: "chat", section: "messages", label: "Threads", icon: <MessageSquare size={14} /> },
      { target: "sessions", section: "history", label: "Session store", icon: <Archive size={14} /> },
      { target: "studio", section: "artifacts", label: "Studio", icon: <Sparkles size={14} /> },
      { target: "workspace", section: "projects", label: "Workspace", icon: <FileStack size={14} /> },
      { target: "control", section: "tools", label: "Gateway control", icon: <Settings2 size={14} /> },
    ],
  },
  antigravity: {
    accent: "#FF4E45", shell: "#1F2853", product: "ANTIGRAVITY",
    newLabel: "New mission", search: "Search missions", projectLabel: "Workspaces",
    emptyPinned: "Pin a mission or workspace",
    controls: [
      { target: "chat", section: "messages", label: "Mission chat", icon: <Orbit size={14} /> },
      { target: "history", section: "history", label: "Conversation library", icon: <Archive size={14} /> },
      { target: "workspace", section: "projects", label: "Workspace files", icon: <FolderKanban size={14} /> },
    ],
  },
  glm: {
    accent: "#34E5B0", shell: "#0C2423", product: "GLM",
    newLabel: "New GLM chat", search: "Search GLM history", projectLabel: "Workspace",
    emptyPinned: "Pin a GLM conversation",
    controls: [
      { target: "chat", section: "messages", label: "Chat", icon: <MessageSquare size={14} /> },
      { target: "workspace", section: "projects", label: "Workspace", icon: <FileStack size={14} /> },
    ],
  },
  kimi: {
    accent: "#46C7FF", shell: "#0A1830", product: "KIMI",
    newLabel: "New Kimi chat", search: "Search Kimi history", projectLabel: "Projects",
    emptyPinned: "Pin a Kimi conversation",
    controls: [
      { target: "chat", section: "messages", label: "Chat", icon: <MessageSquare size={14} /> },
      { target: "workspace", section: "projects", label: "Workspace", icon: <FolderKanban size={14} /> },
    ],
  },
  freeclaude: {
    accent: "#34D399", shell: "#10251F", product: "FREE CLAUDE CODE",
    newLabel: "New free chat", search: "Search free sessions", projectLabel: "Projects",
    emptyPinned: "Pin a free Claude session",
    controls: [
      { target: "chat", section: "messages", label: "Chat", icon: <MessageSquare size={14} /> },
      { target: "workspace", section: "projects", label: "Workspace", icon: <FolderKanban size={14} /> },
      { target: "factory", section: "tools", label: "Agent Factory", icon: <Wrench size={14} /> },
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

function safeArrayParse<T>(raw: string | null): T[] {
  const parsed = safeParse<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed as T[] : [];
}

function safeRecordParse(raw: string | null): Record<string, boolean> {
  const parsed = safeParse<unknown>(raw, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
  );
}

export default function AgentWorkspaceShell({
  agent,
  active,
  activeTarget,
  children,
}: {
  agent: WorkspaceAgent;
  active: WorkspaceSection;
  activeTarget?: string;
  children: React.ReactNode;
}) {
  const ui = meta[agent];
  const immersiveAgent = true;
  const hasNativeHistory = agent !== "glm" && agent !== "kimi" && agent !== "freeclaude";
  const projectOptional = !hasNativeHistory;
  const sidebarRef = useRef<HTMLElement | null>(null);
  const sidebarTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [nativeGroups, setNativeGroups] = useState<Group[]>([]);
  const [localSessions, setLocalSessions] = useState<LocalSession[]>([]);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionPath, setActiveSessionPath] = useState<string | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<string | undefined>(activeTarget);
  const [pinned, setPinned] = useState<string[]>([]);
  const [navGroupsOpen, setNavGroupsOpen] = useState<Record<string, boolean>>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [hermesProfiles, setHermesProfiles] = useState<HermesProfileSummary[]>([]);
  const [hermesMcpSummary, setHermesMcpSummary] = useState<HermesMcpSummary | null>(null);
  const [hermesMcpState, setHermesMcpState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [hermesMcpError, setHermesMcpError] = useState<string | null>(null);
  const [openClawStatus, setOpenClawStatus] = useState<OpenClawSummary | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const initialWorkspaceContextDispatchedRef = useRef(false);

  useEffect(() => {
    if (!sidebarOpen || window.matchMedia("(min-width: 768px)").matches) return;
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : sidebarTriggerRef.current;
    const selector = "a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusable = () => Array.from(sidebar.querySelectorAll<HTMLElement>(selector))
      .filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSidebarOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [sidebarOpen]);

  const pinKey = `agentic-os:${agent}:pinned-sessions:v2`;
  const localKey = `agentic-os:${agent}:local-sessions:v2`;
  const projectKey = `agentic-os:${agent}:active-project:v2`;
  const sessionKey = `agentic-os:${agent}:active-session:v2`;
  const navGroupsKey = `agentic-os:${agent}:navigation-groups:v2`;

  const syncUrl = useCallback((
    projectId: string | null,
    sessionPath: string | null,
    target: string | undefined,
    mode: "push" | "replace",
  ) => {
    const url = new URL(window.location.href);
    if (projectId) url.searchParams.set("project", projectId);
    else url.searchParams.delete("project");
    if (sessionPath) url.searchParams.set("session", sessionPath);
    else url.searchParams.delete("session");
    if (target) url.searchParams.set("workspaceTarget", target);
    else url.searchParams.delete("workspaceTarget");
    const state = { ...window.history.state, agentWorkspace: { agent, projectId, sessionPath, target } };
    if (mode === "push") window.history.pushState(state, "", url);
    else window.history.replaceState(state, "", url);
  }, [agent]);

  const emit = useCallback((detail: Omit<WorkspaceNavDetail, "agent">) => {
    window.dispatchEvent(new CustomEvent<WorkspaceNavDetail>("agent-workspace-nav", { detail: { agent, ...detail } }));
  }, [agent]);

  const load = useCallback(() => {
    if (!hasNativeHistory) {
      setNativeGroups([]);
      setHistoryLoaded(true);
      return;
    }
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
        const localProjectIds = new Set(
          safeArrayParse<LocalSession>(localStorage.getItem(localKey)).map((session) => session.projectId),
        );
        const chosen = remembered && (next.some((group) => group.id === remembered) || localProjectIds.has(remembered))
          ? remembered
          : null;
        setActiveProjectId((current) => {
          const candidate = current ?? chosen;
          return candidate && (next.some((group) => group.id === candidate) || localProjectIds.has(candidate)) ? candidate : null;
        });
        setExpanded((current) => {
          const candidate = current ?? chosen;
          return candidate && (next.some((group) => group.id === candidate) || localProjectIds.has(candidate)) ? candidate : null;
        });
        setHistoryLoaded(true);
      })
      .catch(() => {
        setNativeGroups([]);
        setHistoryLoaded(true);
      });
  }, [agent, hasNativeHistory, localKey, projectKey]);

  const loadHermesRuntime = useCallback(async (requestedProfile: string) => {
    setHermesMcpState("loading");
    setHermesMcpError(null);
    try {
      const profilesResponse = await fetch("/api/hermes/profiles", { cache: "no-store" });
      const profilesPayload = await profilesResponse.json() as { profiles?: HermesProfileSummary[]; error?: string };
      if (!profilesResponse.ok) throw new Error(profilesPayload.error || `Profiles HTTP ${profilesResponse.status}`);
      const profiles = Array.isArray(profilesPayload.profiles) ? profilesPayload.profiles : [];
      setHermesProfiles(profiles);
      const selectedProfile = profiles.some((profile) => profile.name === requestedProfile) ? requestedProfile : "default";

      const query = new URLSearchParams({ profile: selectedProfile });
      const mcpResponse = await fetch(`/api/hermes/mcp?${query.toString()}`, { cache: "no-store" });
      const mcpPayload = await mcpResponse.json() as { ok?: boolean; profile?: string; installed?: HermesMcpEntry[]; error?: string };
      if (!mcpResponse.ok || mcpPayload.ok === false) throw new Error(mcpPayload.error || `MCP HTTP ${mcpResponse.status}`);
      const installed = Array.isArray(mcpPayload.installed) ? mcpPayload.installed : [];
      setHermesMcpSummary({
        profile: mcpPayload.profile || selectedProfile,
        installed: installed.length,
        enabled: installed.filter((entry) => entry.enabled !== false).length,
        names: installed.slice(0, 4).map((entry) => entry.name),
      });
      setHermesMcpState("ready");
    } catch (error) {
      setHermesMcpSummary(null);
      setHermesMcpError(error instanceof Error ? error.message : String(error));
      setHermesMcpState("error");
    }
  }, []);

  useEffect(() => {
    setPinned(safeArrayParse<string>(localStorage.getItem(pinKey)));
    setLocalSessions(safeArrayParse<LocalSession>(localStorage.getItem(localKey)));
    setNavGroupsOpen(safeRecordParse(localStorage.getItem(navGroupsKey)));
    const url = new URL(window.location.href);
    setActiveSessionPath(url.searchParams.get("session") || localStorage.getItem(sessionKey));
    setSelectedTarget(url.searchParams.get("workspaceTarget") || activeTarget);
    load();
  }, [activeTarget, load, localKey, navGroupsKey, pinKey, sessionKey]);

  useEffect(() => {
    if (agent === "openclaw") {
      fetch("/api/vitals", { cache: "no-store" })
        .then((response) => response.ok ? response.json() : {})
        .then((payload: { openclaw?: OpenClawSummary }) => setOpenClawStatus(payload.openclaw ?? null))
        .catch(() => setOpenClawStatus(null));
    }
  }, [agent]);

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
  useEffect(() => { localStorage.setItem(navGroupsKey, JSON.stringify(navGroupsOpen)); }, [navGroupsKey, navGroupsOpen]);
  useEffect(() => {
    const urlTarget = new URL(window.location.href).searchParams.get("workspaceTarget");
    if (!urlTarget && activeTarget) setSelectedTarget(activeTarget);
  }, [activeTarget]);

  useEffect(() => {
    if (!activeProjectId) return;
    localStorage.setItem(projectKey, activeProjectId);
    syncUrl(activeProjectId, activeSessionPath, selectedTarget, "replace");
  }, [activeProjectId, activeSessionPath, projectKey, selectedTarget, syncUrl]);

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
  const groupsRef = useRef(groups);
  const controlsRef = useRef(ui.controls);
  groupsRef.current = groups;
  controlsRef.current = ui.controls;

  const activeProject = groups.find((group) => group.id === activeProjectId) ?? null;
  const selectedHermesProfileName = agent === "hermes" ? activeProject?.scope ?? "default" : "default";
  const allSessions = groups.flatMap((group) => group.sessions.map((session) => ({ ...session, project: group })));
  const pinnedRows = pinned.map((path) => allSessions.find((session) => session.path === path)).filter(Boolean) as (WorkspaceSessionRef & { project: Group })[];

  useEffect(() => {
    if (initialWorkspaceContextDispatchedRef.current || !historyLoaded || !activeProject) return;
    const session = activeSessionPath
      ? activeProject.sessions.find((item) => item.path === activeSessionPath)
      : undefined;
    if (activeSessionPath && !session) return;
    const control = selectedTarget ? ui.controls.find((item) => item.target === selectedTarget) : undefined;
    initialWorkspaceContextDispatchedRef.current = true;
    const timer = window.setTimeout(() => {
      if (session) {
        emit({ action: "select", section: "messages", target: "chat", project: projectRef(activeProject), session });
      } else if (control && control.target !== "chat") {
        emit({ action: "navigate", section: control.section, target: control.target, project: projectRef(activeProject) });
      } else {
        emit({ action: "project", section: "messages", target: "chat", project: projectRef(activeProject) });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeProject, activeSessionPath, emit, historyLoaded, selectedTarget, ui.controls]);

  useEffect(() => {
    if (!historyLoaded || activeProject) return;
    const control = selectedTarget ? ui.controls.find((item) => item.target === selectedTarget) : undefined;
    if (control) emit({ action: "navigate", section: control.section, target: control.target });
    else emit({ action: "project", section: "messages", target: "chat" });
  }, [activeProject, emit, historyLoaded, selectedTarget, ui.controls]);

  useEffect(() => {
    if (!activeProject || !activeSessionPath) return;
    if (activeProject.sessions.some((session) => session.path === activeSessionPath)) return;
    setActiveSessionPath(null);
  }, [activeProject, activeSessionPath]);

  useEffect(() => {
    if (agent !== "hermes") return;
    const refreshMcp = () => { void loadHermesRuntime(selectedHermesProfileName); };
    refreshMcp();
    window.addEventListener("hermes-mcp-updated", refreshMcp);
    return () => window.removeEventListener("hermes-mcp-updated", refreshMcp);
  }, [agent, loadHermesRuntime, selectedHermesProfileName]);

  useEffect(() => {
    const onPopState = () => {
      const url = new URL(window.location.href);
      const projectId = url.searchParams.get("project");
      const sessionPath = url.searchParams.get("session");
      const target = url.searchParams.get("workspaceTarget") || undefined;
      const group = projectId ? groupsRef.current.find((item) => item.id === projectId) : undefined;
      const session = group && sessionPath ? group.sessions.find((item) => item.path === sessionPath) : undefined;
      const targetControl = target ? controlsRef.current.find((item) => item.target === target) : undefined;

      setActiveProjectId(group?.id ?? null);
      setExpanded(group?.id ?? null);
      setActiveSessionPath(session?.path ?? null);
      setSelectedTarget(targetControl?.target ?? (session ? "chat" : undefined));
      if (group) localStorage.setItem(projectKey, group.id);
      else localStorage.removeItem(projectKey);
      if (session) localStorage.setItem(sessionKey, session.path);
      else localStorage.removeItem(sessionKey);

      if (group && session) {
        emit({ action: "select", section: "messages", target: "chat", project: projectRef(group), session });
      } else if (targetControl) {
        emit({ action: "navigate", section: targetControl.section, target: targetControl.target, project: group ? projectRef(group) : undefined });
      } else if (group) {
        emit({ action: "project", section: "messages", project: projectRef(group) });
      } else {
        emit({ action: "project", section: "messages", target: "chat" });
      }
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("pageshow", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("pageshow", onPopState);
    };
  }, [emit, projectKey, sessionKey]);

  useEffect(() => {
    const contextKey = `agentic-os:${agent}:conversation-context:v2`;
    if (!activeProject) {
      if (historyLoaded) localStorage.removeItem(contextKey);
      return;
    }
    const session = allSessions.find((item) => item.path === activeSessionPath);
    localStorage.setItem(contextKey, JSON.stringify({
      project: { id: activeProject.id, label: activeProject.label, root: activeProject.root, scope: activeProject.scope },
      session: session ? { id: session.id, name: session.name, path: session.path, mtime: session.mtime, bytes: session.bytes, nativeId: session.nativeId, nativeStarted: session.nativeStarted, sessionKey: session.sessionKey, resumable: session.resumable, source: session.source } : null,
    }));
  }, [activeProject, activeSessionPath, agent, allSessions, historyLoaded]);

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
    syncUrl(group.id, null, "chat", "push");
    setActiveProjectId(group.id);
    setExpanded(group.id);
    setActiveSessionPath(null);
    setSelectedTarget("chat");
    emit({ action: "project", section: "messages", project: projectRef(group) });
  }

  function startNewSession() {
    if (!activeProject && projectOptional) {
      syncUrl(null, null, "chat", "push");
      setSelectedTarget("chat");
      setSidebarOpen(false);
      emit({ action: "new", section: "new", target: "chat" });
      return;
    }
    if (!activeProject) return;
    const project = activeProject;
    const id = crypto.randomUUID();
    const session: LocalSession = {
      id, name: agent === "codex" ? "New task" : agent === "antigravity" ? "New mission" : "New conversation",
      path: `local:${id}`, mtime: Date.now(), bytes: 0, projectId: project.id,
      nativeId: id, nativeStarted: false, resumable: true, source: "local",
    };
    syncUrl(project.id, session.path, "chat", "push");
    setLocalSessions((current) => [session, ...current]);
    setActiveProjectId(project.id);
    setExpanded(project.id);
    setActiveSessionPath(session.path);
    setSelectedTarget("chat");
    setSidebarOpen(false);
    emit({ action: "new", section: "new", project: projectRef(project), session });
  }

  function openSession(group: Group, session: WorkspaceSessionRef) {
    syncUrl(group.id, session.path, "chat", "push");
    setActiveProjectId(group.id);
    setExpanded(group.id);
    setActiveSessionPath(session.path);
    setSelectedTarget("chat");
    setSidebarOpen(false);
    emit({ action: "select", section: "messages", project: projectRef(group), session });
  }

  function navigate(section: WorkspaceSection, target: string) {
    syncUrl(activeProject?.id ?? null, activeSessionPath, target, "push");
    setSelectedTarget(target);
    setSidebarOpen(false);
    emit({ action: "navigate", section, target, project: activeProject ? projectRef(activeProject) : undefined });
  }

  function togglePin(path: string) {
    setPinned((current) => current.includes(path) ? current.filter((item) => item !== path) : [path, ...current]);
  }

  const agentIcon = agent === "openclaw" ? <Box size={13} /> : agent === "antigravity" ? <Orbit size={13} /> : agent === "codex" ? <Command size={13} /> : <Bot size={13} />;
  const effectiveSection: WorkspaceSection = active === "new" ? "messages" : active;
  const targetBelongsToSection = ui.controls.some((item) => item.target === selectedTarget && item.section === effectiveSection);
  const resolvedTarget = targetBelongsToSection ? selectedTarget : ui.controls.find((item) => item.section === effectiveSection)?.target;

  const control = (item: (typeof ui.controls)[number], variant: "row" | "tile" | "terminal" | "gateway" | "mission" = "row") => {
    const selected = item.target === resolvedTarget;
    const variantClass = variant === "tile"
      ? "min-h-11 flex-col justify-between rounded-lg border p-2"
      : variant === "terminal"
        ? "w-full items-center gap-2 rounded px-2 py-1.5 font-[var(--font-geist-mono)] text-[10.5px]"
        : variant === "gateway"
          ? "w-full items-center gap-2.5 border-l-2 px-2.5 py-2 text-[11px]"
          : variant === "mission"
            ? "w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-[11px]"
            : "w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[11.5px]";
    return <button key={item.target} onClick={() => navigate(item.section, item.target)}
      data-workspace-target={item.target}
      aria-current={selected ? "page" : undefined}
      className={`group flex text-left transition ${variantClass} hover:bg-white/[0.045]`}
      style={{
        color: selected ? "var(--fg)" : "var(--fg-dim)",
        background: selected ? `${ui.accent}15` : undefined,
        borderColor: variant === "gateway" ? (selected ? ui.accent : `${ui.accent}22`) : `${ui.accent}${selected ? "50" : "24"}`,
      }}>
      <span style={{ color: selected ? ui.accent : "var(--fg-dimmer)" }}>{item.icon}</span>
      <span className={variant === "tile" ? "text-[10.5px] font-medium" : "flex-1"}>{variant === "terminal" ? `> ${item.label}` : item.label}</span>
      {variant === "gateway" && <span className="h-1.5 w-1.5 rounded-full" style={{ background: selected ? ui.accent : `${ui.accent}55` }} />}
    </button>;
  };

  const searchBox = (label = ui.search) => <label className="flex items-center gap-2 border-b px-1 py-2.5" style={{ borderColor: `${ui.accent}25`, color: "var(--fg-dimmer)" }}>
    <Search size={12} />
    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={label}
      className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--fg)] outline-none placeholder:text-[var(--fg-dimmer)]" />
  </label>;

  const sessionRow = (group: Group, session: WorkspaceSessionRef, flavor: "chat" | "task" | "terminal" | "thread" | "mission") => {
    const selected = activeSessionPath === session.path;
    const icon = pinned.includes(session.path)
      ? <Pin size={8} style={{ color: ui.accent }} />
      : flavor === "task" ? <Command size={8} />
      : flavor === "thread" ? <GitBranch size={8} />
      : flavor === "mission" ? <Orbit size={8} />
      : session.source === "local" ? <MessageSquare size={8} style={{ color: ui.accent }} /> : <GitBranch size={8} />;
    return <button key={session.path}
      onClick={(event) => event.shiftKey ? togglePin(session.path) : openSession(group, session)}
      data-session-path={session.path}
      className={`flex w-full items-center gap-2 rounded px-2 text-left transition hover:bg-white/[0.05] ${flavor === "terminal" ? "py-1 font-[var(--font-geist-mono)] text-[9.5px]" : "py-1.5 text-[10px]"}`}
      style={{ color: selected ? "var(--fg)" : "var(--fg-dim)", background: selected ? `${ui.accent}18` : undefined }}
      title={session.resumable === false ? "Open history · native resume unavailable" : "Open conversation · Shift-click to pin"}>
      {icon}<span className="truncate">{session.name}</span>
      {session.resumable === false
        ? <span className="ml-auto shrink-0 text-[8px] uppercase tracking-[0.08em] text-[var(--fg-dimmer)]">Read only</span>
        : flavor === "thread" && <span className="ml-auto text-[8px] text-[var(--fg-dimmer)]">{session.source === "local" ? "draft" : "stored"}</span>}
    </button>;
  };

  const projectGroups = (flavor: "chat" | "task" | "terminal" | "thread" | "mission") => <div className="space-y-1">
    {filtered.map((group) => {
      const isOpen = expanded === group.id;
      const isActive = activeProjectId === group.id;
      const projectIcon = flavor === "thread" ? <Bot size={10} /> : flavor === "mission" ? <Orbit size={10} /> : flavor === "terminal" ? <Command size={10} /> : <FolderKanban size={10} />;
      return <section key={group.id} className={flavor === "task" ? "border-b pb-1" : undefined} style={{ borderColor: `${ui.accent}16` }}>
        <button onClick={() => isActive ? setExpanded(isOpen ? null : group.id) : selectProject(group)}
          data-project-id={group.id}
          className={`flex w-full items-center gap-2 rounded-md px-2 text-left transition hover:bg-white/[0.04] ${flavor === "terminal" ? "py-1.5 font-[var(--font-geist-mono)]" : "py-2"}`}
          style={{ background: isActive ? `${ui.accent}10` : undefined }}>
          {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <span style={{ color: isActive ? ui.accent : "var(--fg-dimmer)" }}>{projectIcon}</span>
          <span className="min-w-0 flex-1 truncate text-[10.5px]" style={{ color: isActive ? "var(--fg)" : "var(--fg-dim)" }} title={group.label}>{shortLabel(group.label)}</span>
          <span className="text-[9px] text-[var(--fg-dimmer)]">{group.sessions.length}</span>
        </button>
        {isOpen && <div className={flavor === "terminal" ? "ml-2 border-l pl-1" : "ml-5 border-l pl-1.5"} style={{ borderColor: `${ui.accent}28` }}>
          {group.sessions.slice(0, 18).map((session) => sessionRow(group, session, flavor))}
          {group.sessions.length === 0 && <div className="px-2 py-2 text-[9.5px] text-[var(--fg-dimmer)]">No {flavor === "thread" ? "threads" : flavor === "task" ? "tasks" : flavor === "mission" ? "missions" : "conversations"} yet</div>}
        </div>}
      </section>;
    })}
  </div>;

  const pinnedBlock = (title: string, flavor: "chat" | "task" | "terminal" | "thread" | "mission") => <div>
    <div className="px-1 pb-1 pt-3 text-[8px] font-semibold uppercase tracking-[0.22em] text-[var(--fg-dimmer)]">{title}</div>
    {pinnedRows.length === 0 && <div className="flex items-center gap-2 px-1 py-1.5 text-[9.5px] text-[var(--fg-dimmer)]"><Pin size={9} /> {ui.emptyPinned}</div>}
    {pinnedRows.map((row) => sessionRow(row.project, row, flavor))}
  </div>;

  const navGroup = (key: string, title: string, children: React.ReactNode) => {
    const defaultOpen = agent === "claude"
      ? key === "conversations"
      : agent === "hermes"
        ? key === "core"
        : agent === "openclaw"
          ? key === "threads"
          : agent === "antigravity"
            ? key === "missions"
            : true;
    const isOpen = navGroupsOpen[key] ?? defaultOpen;
    return <section data-navigation-group={`${agent}:${key}`} className="rounded-lg border" style={{ borderColor: `${ui.accent}20` }}>
      <button
        type="button"
        data-navigation-group-toggle={key}
        aria-expanded={isOpen}
        onClick={() => setNavGroupsOpen((current) => ({ ...current, [key]: !isOpen }))}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-[8px] font-semibold uppercase tracking-[0.18em] text-[var(--fg-dimmer)] transition hover:text-[var(--fg-dim)]"
      >
        {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span>{title}</span>
      </button>
      {isOpen && <div data-navigation-group-content={key} className="space-y-1 border-t p-1.5" style={{ borderColor: `${ui.accent}18` }}>{children}</div>}
    </section>;
  };

  const activeHermesProfile = hermesProfiles.find((profile) => profile.name === selectedHermesProfileName) ?? null;

  const hermesMcpCard = () => {
    const selected = resolvedTarget === "mcps";
    return <button
      type="button"
      onClick={() => {
        try { localStorage.setItem("agentic-os-hermes-mcp-profile", selectedHermesProfileName); } catch { /* ignore */ }
        navigate("tools", "mcps");
      }}
      data-hermes-mcp-summary={hermesMcpState}
      data-workspace-target="mcps"
      aria-current={selected ? "page" : undefined}
      title={hermesMcpError ?? "Open the MCP catalogue for the active Hermes profile"}
      className="w-full rounded border px-2.5 py-2 text-left transition hover:bg-white/[0.045]"
      style={{ borderColor: selected ? ui.accent : `${ui.accent}30`, background: selected ? `${ui.accent}15` : "rgba(0,0,0,.2)" }}
    >
      <div className="flex items-center gap-2 text-[9px] uppercase tracking-[0.14em]" style={{ color: selected ? ui.accent : "var(--fg-dim)" }}>
        <Wrench size={11} />
        <span>MCP connections</span>
        {hermesMcpState === "loading" && <span className="ml-auto text-[var(--fg-dimmer)]">Loading...</span>}
        {hermesMcpState === "error" && <span className="ml-auto text-[var(--plum)]">Unavailable</span>}
        {hermesMcpState === "ready" && <span className="ml-auto text-[var(--fg-dimmer)]">{hermesMcpSummary?.enabled ?? 0}/{hermesMcpSummary?.installed ?? 0} on</span>}
      </div>
      {hermesMcpState === "ready" && hermesMcpSummary && (
        <div className="mt-1.5 space-y-1 text-[9px] text-[var(--fg-dimmer)]">
          <div className="truncate">profile: <span style={{ color: ui.accent }}>{hermesMcpSummary.profile}</span></div>
          <div className="truncate">{hermesMcpSummary.names.length ? hermesMcpSummary.names.join(" · ") : "No MCP servers installed"}</div>
        </div>
      )}
      {hermesMcpState === "error" && <div className="mt-1.5 truncate text-[9px] text-[var(--fg-dimmer)]">{hermesMcpError}</div>}
    </button>;
  };

  const agentNavigation = () => {
    if (agent === "claude") return <div data-agent-layout="warm-project-chats" className="space-y-4 px-3 py-3">
      {navGroup("conversations", "Conversations", <div data-section="controls" className="space-y-1">{ui.controls.slice(0, 4).map((item) => control(item))}</div>)}
      {navGroup("code-modes", "Code modes", <div data-section="controls" className="space-y-1">{ui.controls.slice(4).map((item) => control(item))}</div>)}
      {searchBox("Search project chats")}
      {pinnedBlock("Starred chats", "chat")}
      <div data-section="projects"><div className="flex items-center justify-between px-1 pb-1 text-[8px] uppercase tracking-[0.2em] text-[var(--fg-dimmer)]"><span>Project chats</span><span>{groups.length}</span></div>{projectGroups("chat")}</div>
    </div>;

    if (agent === "codex") return <div data-agent-layout="compact-task-workspace" className="space-y-3 px-3 py-3">
      {navGroup("tasks", "Tasks", <div data-section="controls" className="space-y-0.5">{[ui.controls[0], ui.controls[2]].map((item) => control(item))}</div>)}
      {navGroup("workspaces", "Workspace tools", <div data-section="controls" className="space-y-0.5">{[ui.controls[1], ui.controls[3]].map((item) => control(item))}</div>)}
      {searchBox("Filter tasks / workspaces")}
      {pinnedBlock("Pinned tasks", "task")}
      <div data-section="projects" className="rounded-lg border px-1.5 py-1" style={{ borderColor: `${ui.accent}20` }}>
        <div className="flex items-center justify-between px-1.5 py-1 text-[8px] uppercase tracking-[0.18em] text-[var(--fg-dimmer)]"><span>Task workspaces</span><span>{groups.length}</span></div>
        {projectGroups("task")}
      </div>
    </div>;

    if (agent === "hermes") return <div data-agent-layout="terminal-profile-tools" className="space-y-3 px-3 py-3 font-[var(--font-geist-mono)]">
      <div data-hermes-profile-status={activeHermesProfile ? "ready" : "unavailable"} className="rounded border px-2 py-2 text-[9px]" style={{ borderColor: `${ui.accent}32`, background: "rgba(0,0,0,.28)", color: ui.accent }}>
        <div className="truncate">$ hermes --profile {activeHermesProfile?.name ?? "unavailable"}</div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[var(--fg-dimmer)]">
          <span className="truncate">{activeHermesProfile?.provider || "provider unset"}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{activeHermesProfile?.model || "model unset"}</span>
        </div>
      </div>
      {navGroup("core", "Core", <div data-section="controls">{ui.controls.slice(0, 3).map((item) => control(item, "terminal"))}</div>)}
      {navGroup("field-agents", "Field agents", <div data-section="controls" className="grid grid-cols-2 gap-1">{ui.controls.slice(3, 7).map((item) => control(item, "tile"))}</div>)}
      {navGroup("production", "Production", <div data-section="controls" className="grid grid-cols-2 gap-1">{ui.controls.slice(7, 11).map((item) => control(item, "tile"))}</div>)}
      {navGroup("system", "System", <div data-section="controls" className="space-y-1">{ui.controls.slice(11).filter((item) => item.target !== "mcps").map((item) => control(item, "terminal"))}{hermesMcpCard()}</div>)}
      {searchBox("grep session memory")}
      {pinnedBlock("Active missions", "terminal")}
      <div data-section="projects"><div className="flex items-center justify-between px-1 pb-1 text-[8px] uppercase tracking-[0.2em] text-[var(--fg-dimmer)]"><span>Profiles / sessions</span><span>{groups.length}</span></div>{projectGroups("terminal")}</div>
    </div>;

    if (agent === "openclaw") return <div data-agent-layout="gateway-agents-threads" className="space-y-4 px-3 py-3">
      <div
        data-openclaw-gateway={openClawStatus?.ok ? "ready" : openClawStatus ? "offline" : "checking"}
        className="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[9px]"
        style={{ borderColor: `${ui.accent}2e`, background: "rgba(0,0,0,.22)", color: openClawStatus?.ok ? ui.accent : "var(--fg-dimmer)" }}
      >
        {openClawStatus?.ok ? <Wifi size={11} /> : <WifiOff size={11} />}
        <span className="font-semibold uppercase tracking-[0.14em]">Gateway {openClawStatus?.gateway ?? "checking"}</span>
        <span className="ml-auto text-[var(--fg-dimmer)]">{openClawStatus?.agents?.length ?? 0} agents · {openClawStatus ? `${openClawStatus.latencyMs}ms` : "—"}</span>
      </div>
      {navGroup("threads", "Threads", <div data-section="controls">{ui.controls.slice(0, 2).map((item) => control(item, "gateway"))}</div>)}
      {navGroup("gateway-operations", "Gateway operations", <div data-section="controls">{ui.controls.slice(2).map((item) => control(item, "gateway"))}</div>)}
      {searchBox("Search agents and threads")}
      {pinnedBlock("Pinned threads", "thread")}
      <div data-section="projects"><div className="flex items-center justify-between px-1 pb-1 text-[8px] uppercase tracking-[0.2em] text-[var(--fg-dimmer)]"><span>Gateway agents</span><span>{groups.length}</span></div>{projectGroups("thread")}</div>
    </div>;

    if (agent === "glm" || agent === "kimi" || agent === "freeclaude") return <div data-agent-layout="model-workspace" className="space-y-4 px-3 py-3">
      {navGroup("workspace", agent === "freeclaude" ? "Free Claude" : "Workspace", <div data-section="controls" className="space-y-1">{ui.controls.map((item) => control(item, "mission"))}</div>)}
      <div className="rounded-lg border px-3 py-3 text-[10px] leading-relaxed text-[var(--fg-dimmer)]" style={{ borderColor: `${ui.accent}25`, background: `${ui.accent}0a` }}>
        <div className="mb-1 font-semibold uppercase tracking-[0.16em]" style={{ color: ui.accent }}>Local continuity</div>
        Chat history, model settings and workspace state stay on this device and keep their existing storage keys.
      </div>
    </div>;

    return <div data-agent-layout="mission-workspace" className="space-y-4 px-3 py-3">
      {navGroup("missions", "Missions", <div data-section="controls">{ui.controls.slice(0, 2).map((item) => control(item, "mission"))}</div>)}
      {navGroup("workspace", "Workspace", <div data-section="controls">{ui.controls.slice(2).map((item) => control(item, "mission"))}</div>)}
      {searchBox("Locate missions / workspaces")}
      {pinnedBlock("Mission anchors", "mission")}
      <div data-section="projects"><div className="flex items-center justify-between px-1 pb-1 text-[8px] uppercase tracking-[0.2em] text-[var(--fg-dimmer)]"><span>Workspace orbit</span><span>{groups.length}</span></div>{projectGroups("mission")}</div>
    </div>;
  };

  const gridClass = immersiveAgent
    ? "md:grid-cols-[236px_minmax(0,1fr)]"
    : "xl:grid-cols-[276px_minmax(0,1fr)]";
  const activeSession = allSessions.find((session) => session.path === activeSessionPath);
  const activeContextLabel = activeProject
    ? agent === "hermes"
      ? activeProject.scope || activeHermesProfile?.name || shortLabel(activeProject.label)
      : shortLabel(activeProject.label)
    : null;
  const gatewayUnavailable = agent === "openclaw" && openClawStatus !== null && !openClawStatus.ok;
  const canStartSession = (projectOptional || Boolean(activeProject)) && !gatewayUnavailable;
  const missingContextLabel = projectOptional ? "Local workspace" : agent === "hermes" ? "Choose profile" : agent === "openclaw" ? "Choose agent" : "Choose project";
  const newSessionLabel = !activeContextLabel
    ? projectOptional ? ui.newLabel : missingContextLabel
    : agent === "hermes"
      ? `${ui.newLabel} as ${activeContextLabel}`
      : agent === "openclaw"
        ? `${ui.newLabel} with ${activeContextLabel}`
        : `${ui.newLabel} in ${activeContextLabel}`;
  const newSessionTitle = !activeProject && !projectOptional
    ? missingContextLabel
    : gatewayUnavailable
      ? "OpenClaw gateway is offline"
      : newSessionLabel;

  return (
    <div
      data-agent-workspace={agent}
      data-agent-experience={immersiveAgent ? "immersive" : "embedded"}
      className={immersiveAgent
        ? `flex h-dvh min-h-0 flex-col md:grid ${gridClass}`
        : `grid min-h-[calc(100vh-190px)] grid-cols-1 gap-4 ${gridClass}`}
    >
      <div className={immersiveAgent ? "min-w-0 flex-none md:h-dvh" : "min-w-0"}>
        <div data-agent-mobile-bar={immersiveAgent ? agent : undefined} className={immersiveAgent ? "flex min-h-12 items-center border-b px-2 md:hidden" : "contents"}>
        <button
          ref={sidebarTriggerRef}
          type="button"
          data-agent-sidebar-toggle={agent}
          data-active-context={activeProject?.id ?? ""}
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}
          className={immersiveAgent
            ? "flex min-h-11 min-w-0 flex-1 items-center gap-3 px-2 py-1.5 text-left md:hidden"
            : "flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left md:max-w-[560px] xl:hidden"}
          style={{ borderColor: `${ui.accent}32`, background: `${ui.accent}0d` }}
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg" style={{ color: ui.accent, background: `${ui.accent}18` }}>{agentIcon}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[9px] font-semibold uppercase tracking-[0.18em]" style={{ color: ui.accent }}>{ui.product}</span>
            <span className="block truncate text-[10.5px] text-[var(--fg-dim)]">
              {activeContextLabel ?? missingContextLabel}{activeSession ? ` · ${activeSession.name}` : ""}
            </span>
          </span>
          <PanelLeftOpen size={15} style={{ color: "var(--fg-dimmer)" }} />
        </button>
        {immersiveAgent && (
          <Link
            href="/"
            aria-label="Back to Agentic OS"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-[var(--fg-dim)] transition hover:bg-black/5 hover:text-[var(--fg)] md:hidden"
          >
            <Home size={16} />
          </Link>
        )}
        </div>

        {sidebarOpen && <button type="button" aria-label="Close agent navigation" onClick={() => setSidebarOpen(false)} className="fixed inset-0 z-40 bg-black/60 md:hidden" />}

        <aside
          ref={sidebarRef}
          data-agent-sidebar={agent}
          data-agent-variant={agent}
          data-agent-sidebar-sheet={sidebarOpen ? "open" : "closed"}
          role={sidebarOpen ? "dialog" : undefined}
          aria-modal={sidebarOpen ? true : undefined}
          aria-label={`${ui.product} navigation`}
          className={immersiveAgent
            ? `${sidebarOpen ? "flex" : "hidden"} fixed inset-y-0 left-0 z-50 w-[min(86vw,320px)] flex-col overflow-hidden border-r md:static md:flex md:h-dvh md:w-full md:rounded-none md:border-y-0 md:border-l-0`
            : `${sidebarOpen ? "flex" : "hidden"} fixed inset-x-3 bottom-20 z-50 max-h-[min(68dvh,560px)] w-auto flex-col overflow-hidden rounded-xl border md:static md:mt-2 md:max-h-[min(62dvh,560px)] md:w-full md:max-w-[560px] xl:sticky xl:top-4 xl:mt-0 xl:flex xl:max-h-[calc(100dvh-224px)] xl:max-w-none`}
          style={{ background: ui.shell, borderColor: `${ui.accent}2f`, boxShadow: `0 18px 60px -42px ${ui.accent}` }}
        >
          <div className="flex-none border-b px-3.5 pb-3 pt-3" style={{ borderColor: `${ui.accent}22` }}>
            <div className="flex items-center justify-between text-[9px] font-semibold tracking-[0.22em]" style={{ color: ui.accent }}>
              <span className="flex items-center gap-1.5">{agentIcon}{ui.product}</span>
              <span className="ml-auto rounded-full border px-1.5 py-0.5" style={{ borderColor: `${ui.accent}35`, color: `${ui.accent}cc` }}>LOCAL</span>
              <button type="button" onClick={() => setSidebarOpen(false)} aria-label="Close agent navigation" className={`ml-2 h-7 w-7 place-items-center rounded-md text-[var(--fg-dimmer)] ${immersiveAgent ? "grid md:hidden" : "grid xl:hidden"}`}>
                <X size={13} />
              </button>
            </div>
            <button
              onClick={startNewSession}
              disabled={!canStartSession}
              data-new-session={agent}
              data-active-context={activeProject?.id ?? ""}
              title={newSessionTitle}
              className="mt-3 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-[12px] font-semibold transition hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
              style={{ color: "var(--fg)", borderColor: `${ui.accent}45`, background: `${ui.accent}16` }}
            >
              <Plus size={14} style={{ color: ui.accent }} />
              <span className="min-w-0 flex-1 truncate">{newSessionLabel}</span>
              <kbd className="rounded border px-1.5 py-0.5 text-[8px]" style={{ borderColor: `${ui.accent}33`, color: "var(--fg-dimmer)" }}>Ctrl N</kbd>
            </button>
          </div>

          <ScrollArea
            ariaLabel={`${ui.product} navigation`}
            className="min-h-0 flex-1"
            viewportClassName={immersiveAgent ? "h-full" : "h-full max-h-[calc(68dvh-132px)] md:max-h-[calc(62dvh-132px)] xl:max-h-[calc(100dvh-344px)]"}
            scrollbar="hover"
            fades={false}
            overscroll="contain"
            style={{ "--scroll-area-fade-color": ui.shell } as React.CSSProperties}
          >
            {agentNavigation()}
          </ScrollArea>

          <div className="flex-none border-t" style={{ borderColor: `${ui.accent}20` }}>
            {hasNativeHistory && <button onClick={load} className="flex w-full items-center gap-2 px-4 py-2.5 text-[9.5px] text-[var(--fg-dimmer)] hover:text-[var(--fg-dim)]">
              <Archive size={10} /> Refresh native history
            </button>}
            {immersiveAgent && (
              <Link
                href="/"
                data-agent-os-home
                className="flex min-h-11 w-full items-center gap-2 border-t px-4 py-3 text-[11px] font-medium text-[var(--fg-dim)] transition hover:text-[var(--fg)]"
                style={{ borderColor: `${ui.accent}20` }}
              >
                <Home size={13} /> Agentic OS
              </Link>
            )}
          </div>
        </aside>
      </div>
      <div data-agent-primary-content className={immersiveAgent ? "min-h-0 min-w-0 flex-1 overflow-hidden" : "min-h-0 min-w-0 overflow-hidden"}>{children}</div>
    </div>
  );
}
