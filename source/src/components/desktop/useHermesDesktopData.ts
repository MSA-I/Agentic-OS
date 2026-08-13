"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface HermesSession {
  id: string;
  nativeId?: string;
  name: string;
  path: string;
  mtime: number;
  bytes: number;
  preview?: string;
  resumable?: boolean;
  /** Transport identity remains in `source`; platform metadata is presentation-only. */
  source?: string;
  platform?: string;
  channelSource?: string;
  channel?: string;
  chatType?: string;
  nativeStarted?: boolean;
}

export interface HermesSessionGroup {
  id: string;
  label: string;
  root: string;
  scope?: string;
  sessions: HermesSession[];
}

export interface HermesMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

export interface HermesProfile {
  name: string;
  description: string;
  model: string;
  provider: string;
  soul: string;
  sessions: number;
  lastActive: number;
  active: boolean;
}

export interface HermesBucket {
  id: string;
  label: string;
  roots: string[];
  description: string;
  fileCount: number;
  mtime: number;
}

export interface HermesFile {
  name: string;
  relPath: string;
  bytes: number;
  mtime: number;
  kind: "text" | "image" | "video" | "audio" | "pdf" | "binary";
  isText?: boolean;
}

export interface HermesMcp {
  name: string;
  profile: string;
  enabled: boolean;
  transport: string;
  command?: string;
  url?: string;
  toolCount?: number;
  authType?: string;
}

export interface HermesCatalogEntry {
  name: string;
  status: string;
  description: string;
  source?: string;
  authType?: string;
  transportType?: string;
}

export interface HermesQueueItem {
  id: string;
  text: string;
  profile: string;
  queuedAt: number;
}

type LoadState = "loading" | "ready" | "empty" | "error" | "offline";

const PINS_KEY = "agentic-os:hermes:pins:v1";
const QUEUE_KEY = "agentic-os:hermes:queue:v1";
const PROFILE_KEY = "agentic-os-hermes-profile";
const chatStorageKey = (path: string) => `agentic-os-chat-v3:hermes:${path}`;

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `hermes-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readArray<T>(key: string): T[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function jsonResponse<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String((payload as { error?: unknown }).error ?? `${response.status} ${response.statusText}`));
  return payload as T;
}

export function useHermesDesktopData() {
  const [groups, setGroups] = useState<HermesSessionGroup[]>([]);
  const [historyState, setHistoryState] = useState<LoadState>("loading");
  const [historyError, setHistoryError] = useState("");
  const [source, setSource] = useState("");
  const [activeGroup, setActiveGroup] = useState<HermesSessionGroup | null>(null);
  const [activeSession, setActiveSession] = useState<HermesSession | null>(null);
  const activeSessionRef = useRef<HermesSession | null>(null);
  const activeGroupRef = useRef<HermesSessionGroup | null>(null);
  const [messages, setMessages] = useState<HermesMessage[]>([]);
  const messagesRef = useRef<HermesMessage[]>([]);
  const [transcriptState, setTranscriptState] = useState<LoadState>("empty");
  const [transcriptError, setTranscriptError] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [profilesState, setProfilesState] = useState<LoadState>("loading");
  const [selectedProfile, setSelectedProfileState] = useState("default");
  const selectedProfileRef = useRef("default");
  const [pins, setPins] = useState<string[]>([]);
  const [queue, setQueue] = useState<HermesQueueItem[]>([]);
  const [online, setOnline] = useState(true);
  const [vitals, setVitals] = useState<{ ok: boolean; model: string; provider: string; latencyMs?: number; raw?: string } | null>(null);
  const [buckets, setBuckets] = useState<HermesBucket[]>([]);
  const [workspaceState, setWorkspaceState] = useState<LoadState>("loading");
  const [workspaceError, setWorkspaceError] = useState("");
  const [activeBucket, setActiveBucket] = useState<HermesBucket | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<HermesFile[]>([]);
  const [skillsOutput, setSkillsOutput] = useState("");
  const [skillsState, setSkillsState] = useState<LoadState>("loading");
  const [mcps, setMcps] = useState<HermesMcp[]>([]);
  const [mcpCatalog, setMcpCatalog] = useState<HermesCatalogEntry[]>([]);
  const [mcpState, setMcpState] = useState<LoadState>("loading");
  const [mcpError, setMcpError] = useState("");
  const [dashboard, setDashboard] = useState<{ running: boolean; url?: string; error?: string } | null>(null);

  const workspaceFromUrl = useCallback(() => new URLSearchParams(window.location.search).get("workspace"), []);

  const syncWorkspaceUrl = useCallback((bucket: HermesBucket | null, mode: "push" | "replace" = "push") => {
    const url = new URL(window.location.href);
    if (bucket) url.searchParams.set("workspace", bucket.id);
    else url.searchParams.delete("workspace");
    if (url.href !== window.location.href) window.history[mode === "replace" ? "replaceState" : "pushState"](window.history.state, "", url);
  }, []);

  useEffect(() => { activeSessionRef.current = activeSession; }, [activeSession]);
  useEffect(() => { activeGroupRef.current = activeGroup; }, [activeGroup]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { selectedProfileRef.current = selectedProfile; }, [selectedProfile]);

  useEffect(() => {
    const storedProfile = localStorage.getItem(PROFILE_KEY);
    if (storedProfile) setSelectedProfileState(storedProfile);
    setPins(readArray<string>(PINS_KEY));
    setQueue(readArray<HermesQueueItem>(QUEUE_KEY).filter((item) => item && typeof item.text === "string" && typeof item.profile === "string"));
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch { /* storage is optional */ }
  }, [queue]);

  const loadHistory = useCallback(async () => {
    setHistoryState(navigator.onLine ? "loading" : "offline");
    setHistoryError("");
    try {
      const payload = await jsonResponse<{ groups?: HermesSessionGroup[]; source?: string }>("/api/agent-history?agent=hermes");
      const next = payload.groups ?? [];
      setGroups(next);
      setSource(payload.source ?? "");
      setHistoryState(next.some((group) => group.sessions.length) ? "ready" : "empty");
      setActiveGroup((current) => next.find((group) => group.id === current?.id) ?? next[0] ?? null);
      return next;
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
      setHistoryState(navigator.onLine ? "error" : "offline");
      return [];
    }
  }, []);

  const loadProfiles = useCallback(async () => {
    setProfilesState("loading");
    try {
      const payload = await jsonResponse<{ profiles?: HermesProfile[]; error?: string }>("/api/hermes/profiles");
      const next = payload.profiles ?? [];
      setProfiles(next);
      setProfilesState(next.length ? "ready" : "empty");
      setSelectedProfileState((current) => next.some((profile) => profile.name === current) ? current : (next.find((profile) => profile.active)?.name ?? next[0]?.name ?? "default"));
    } catch {
      setProfiles([]);
      setProfilesState(navigator.onLine ? "error" : "offline");
    }
  }, []);

  const loadVitals = useCallback(async () => {
    try {
      const payload = await jsonResponse<{ hermes?: { ok: boolean; model: string; provider: string; latencyMs?: number; raw?: string } }>("/api/vitals");
      setVitals(payload.hermes ?? null);
    } catch {
      setVitals({ ok: false, model: "unknown", provider: "unavailable" });
    }
  }, []);

  const loadWorkspace = useCallback(async () => {
    setWorkspaceState("loading");
    setWorkspaceError("");
    try {
      const payload = await jsonResponse<{ buckets?: HermesBucket[] }>("/api/hermes/workspace");
      const next = payload.buckets ?? [];
      setBuckets(next);
      const requestedWorkspace = workspaceFromUrl();
      setActiveBucket((current) => next.find((bucket) => bucket.id === requestedWorkspace) ?? next.find((bucket) => bucket.id === current?.id) ?? next[0] ?? null);
      setWorkspaceState(next.length ? "ready" : "empty");
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
      setWorkspaceState(navigator.onLine ? "error" : "offline");
    }
  }, [workspaceFromUrl]);

  const selectWorkspaceBucket = useCallback((bucket: HermesBucket | null, mode: "push" | "replace" = "push") => {
    setActiveBucket(bucket);
    syncWorkspaceUrl(bucket, mode);
  }, [syncWorkspaceUrl]);

  useEffect(() => {
    const hydrateWorkspace = () => {
      const requestedWorkspace = workspaceFromUrl();
      if (!requestedWorkspace) return;
      const match = buckets.find((bucket) => bucket.id === requestedWorkspace);
      if (match) setActiveBucket(match);
    };
    hydrateWorkspace();
    window.addEventListener("popstate", hydrateWorkspace);
    return () => window.removeEventListener("popstate", hydrateWorkspace);
  }, [buckets, workspaceFromUrl]);

  const loadSkills = useCallback(async () => {
    setSkillsState("loading");
    try {
      const payload = await jsonResponse<{ ok?: boolean; stdout?: string; stderr?: string }>("/api/hermes?action=skills");
      const output = (payload.stdout || payload.stderr || "").trim();
      setSkillsOutput(output);
      setSkillsState(output ? "ready" : "empty");
    } catch (error) {
      setSkillsOutput(error instanceof Error ? error.message : String(error));
      setSkillsState(navigator.onLine ? "error" : "offline");
    }
  }, []);

  const loadMcps = useCallback(async () => {
    setMcpState("loading");
    setMcpError("");
    try {
      const profile = selectedProfileRef.current === "default" ? "" : `?profile=${encodeURIComponent(selectedProfileRef.current)}`;
      const payload = await jsonResponse<{ installed?: HermesMcp[]; catalog?: HermesCatalogEntry[]; error?: string }>(`/api/hermes/mcp${profile}`);
      setMcps(payload.installed ?? []);
      setMcpCatalog(payload.catalog ?? []);
      setMcpState((payload.installed?.length || payload.catalog?.length) ? "ready" : "empty");
    } catch (error) {
      setMcpError(error instanceof Error ? error.message : String(error));
      setMcpState(navigator.onLine ? "error" : "offline");
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    try { setDashboard(await jsonResponse<{ running: boolean; url?: string; error?: string }>("/api/hermes/dashboard")); }
    catch (error) { setDashboard({ running: false, error: error instanceof Error ? error.message : String(error) }); }
  }, []);

  useEffect(() => {
    void Promise.all([loadHistory(), loadProfiles(), loadVitals(), loadWorkspace(), loadSkills(), loadMcps(), loadDashboard()]);
  }, [loadDashboard, loadHistory, loadMcps, loadProfiles, loadSkills, loadVitals, loadWorkspace]);

  useEffect(() => {
    if (!activeBucket) {
      setWorkspaceFiles([]);
      return;
    }
    let cancelled = false;
    void jsonResponse<{ files?: HermesFile[] }>(`/api/hermes/workspace?bucket=${encodeURIComponent(activeBucket.id)}`)
      .then((payload) => { if (!cancelled) setWorkspaceFiles(payload.files ?? []); })
      .catch((error) => {
        if (!cancelled) {
          setWorkspaceFiles([]);
          setWorkspaceError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => { cancelled = true; };
  }, [activeBucket]);

  const syncUrl = useCallback((group: HermesSessionGroup | null, session: HermesSession | null, profile: string) => {
    const url = new URL(window.location.href);
    if (group) url.searchParams.set("project", group.id); else url.searchParams.delete("project");
    if (session) url.searchParams.set("session", session.path); else url.searchParams.delete("session");
    url.searchParams.set("profile", profile);
    window.history.pushState(window.history.state, "", url);
  }, []);

  const openSession = useCallback(async (session: HermesSession, group: HermesSessionGroup, updateUrl = true) => {
    const sessionProfile = group.scope || "default";
    setActiveGroup(group);
    setActiveSession(session);
    setSelectedProfileState(sessionProfile);
    try { localStorage.setItem(PROFILE_KEY, sessionProfile); } catch { /* storage is optional */ }
    setMessages([]);
    setTranscriptState("loading");
    setTranscriptError("");
    setSendError("");
    if (updateUrl) syncUrl(group, session, sessionProfile);
    try {
      if (session.source === "local" || session.path.startsWith("local:")) {
        const stored = localStorage.getItem(chatStorageKey(session.path));
        const parsed = stored ? JSON.parse(stored) : [];
        const next = Array.isArray(parsed) ? parsed : [];
        setMessages(next);
        setTranscriptState(next.length ? "ready" : "empty");
      } else {
        const payload = await jsonResponse<{ detail?: { turns?: { role?: string; text?: string }[] } }>(`/api/agent-history?agent=hermes&path=${encodeURIComponent(session.path)}`);
        const next = (payload.detail?.turns ?? [])
          .filter((turn): turn is { role: "user" | "assistant"; text: string } => (turn.role === "user" || turn.role === "assistant") && typeof turn.text === "string" && Boolean(turn.text.trim()))
          .map((turn) => ({ role: turn.role, text: turn.text, ts: session.mtime }));
        setMessages(next);
        setTranscriptState(next.length ? "ready" : "empty");
      }
    } catch (error) {
      setTranscriptError(error instanceof Error ? error.message : String(error));
      setTranscriptState(navigator.onLine ? "error" : "offline");
    }
  }, [syncUrl]);

  useEffect(() => {
    if (historyState === "loading") return;
    const hydrate = () => {
      const params = new URLSearchParams(window.location.search);
      const requestedSession = params.get("session");
      const requestedProject = params.get("project");
      const requestedProfile = params.get("profile") || "default";
      if (requestedSession) {
        for (const group of groups) {
          const session = group.sessions.find((item) => item.path === requestedSession || item.id === requestedSession);
          if (session) {
            if (activeSession?.path !== session.path) void openSession(session, group, false);
            return;
          }
        }
        if (requestedSession.startsWith("local:hermes:")) {
          const parts = requestedSession.split(":");
          const profile = parts[2] || requestedProfile;
          const id = parts.slice(3).join(":") || makeId();
          const group: HermesSessionGroup = { id: requestedProject || `draft:${profile}`, label: profile, root: "", scope: profile, sessions: [] };
          const session: HermesSession = { id, nativeId: id, name: "Hermes draft", path: requestedSession, mtime: Date.now(), bytes: 0, source: "local", resumable: true };
          if (activeSession?.path !== requestedSession) void openSession(session, group, false);
          return;
        }
      }
      setActiveSession(null);
      setMessages([]);
      setTranscriptState("empty");
      setSelectedProfileState(requestedProfile);
      selectedProfileRef.current = requestedProfile;
      setActiveGroup(requestedProject ? groups.find((group) => group.id === requestedProject) ?? null : groups[0] ?? null);
    };
    hydrate();
    window.addEventListener("popstate", hydrate);
    return () => window.removeEventListener("popstate", hydrate);
  }, [activeSession?.path, groups, historyState, openSession]);

  useEffect(() => {
    if (!activeSession?.path || activeSession.source !== "local") return;
    try { localStorage.setItem(chatStorageKey(activeSession.path), JSON.stringify(messages.slice(-200))); } catch { /* storage is optional */ }
  }, [activeSession?.path, activeSession?.source, messages]);

  const createSession = useCallback((profileName?: string) => {
    const profile = profileName || selectedProfileRef.current || "default";
    const matchingGroup = groups.find((group) => (group.scope || "default") === profile);
    const group: HermesSessionGroup = matchingGroup ?? { id: `draft:${profile}`, label: profile, root: "", scope: profile, sessions: [] };
    const id = makeId();
    const session: HermesSession = {
      id,
      nativeId: id,
      name: "New Hermes message",
      path: `local:hermes:${profile}:${id}`,
      mtime: Date.now(),
      bytes: 0,
      source: "local",
      resumable: true,
      nativeStarted: false,
    };
    setActiveGroup(group);
    setActiveSession(session);
    setSelectedProfileState(profile);
    selectedProfileRef.current = profile;
    setMessages([]);
    setTranscriptState("empty");
    setTranscriptError("");
    setSendError("");
    syncUrl(group, session, profile);
    try { localStorage.setItem(PROFILE_KEY, profile); } catch { /* storage is optional */ }
  }, [groups, syncUrl]);

  const setSelectedProfile = useCallback((profile: string) => {
    if (activeSessionRef.current) return false;
    setSelectedProfileState(profile);
    selectedProfileRef.current = profile;
    try { localStorage.setItem(PROFILE_KEY, profile); } catch { /* storage is optional */ }
    syncUrl(activeGroupRef.current, null, profile);
    void loadMcps();
    return true;
  }, [loadMcps, syncUrl]);

  const runPrompt = useCallback(async (prompt: string, queuedProfile?: string) => {
    const session = activeSessionRef.current;
    const group = activeGroupRef.current;
    if (!session || sending) return;
    const lockedProfile = group?.scope || queuedProfile || selectedProfileRef.current || "default";
    const before = messagesRef.current;
    const userMessage: HermesMessage = { role: "user", text: prompt, ts: Date.now() };
    setMessages([...before, userMessage]);
    setTranscriptState("ready");
    setSending(true);
    setSendError("");
    try {
      const response = await fetch("/api/hermes/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          ...(lockedProfile !== "default" ? { profile: lockedProfile } : {}),
          cwd: group?.root || undefined,
          sessionId: session.source === "native" || session.nativeStarted ? (session.nativeId || session.id) : undefined,
          history: before.slice(-24).map((message) => ({ role: message.role, text: message.text })),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload.error ?? `${response.status} ${response.statusText}`));
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text.trim()) throw new Error("Hermes finished without readable output.");
      if (typeof payload.sessionId === "string") {
        setActiveSession((current) => current ? { ...current, nativeId: payload.sessionId, nativeStarted: true } : current);
      }
      setMessages((current) => [...current, { role: "assistant", text, ts: Date.now() }]);
      void Promise.all([loadHistory(), loadVitals(), loadWorkspace()]);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }, [loadHistory, loadVitals, loadWorkspace, sending]);

  const submitMessage = useCallback((raw: string) => {
    const text = raw.trim();
    const session = activeSessionRef.current;
    if (!text || !session) return { queued: false, accepted: false };
    const profile = activeGroupRef.current?.scope || selectedProfileRef.current || "default";
    if (sending) {
      setQueue((current) => [...current, { id: makeId(), text, profile, queuedAt: Date.now() }]);
      return { queued: true, accepted: true };
    }
    void runPrompt(text, profile);
    return { queued: false, accepted: true };
  }, [runPrompt, sending]);

  useEffect(() => {
    if (sending || queue.length === 0 || !activeSession) return;
    const next = queue[0];
    const sessionProfile = activeGroup?.scope || selectedProfile;
    if (next.profile !== sessionProfile) return;
    setQueue((current) => current.slice(1));
    void runPrompt(next.text, next.profile);
  }, [activeGroup?.scope, activeSession, queue, runPrompt, selectedProfile, sending]);

  const removeQueued = useCallback((id: string) => setQueue((current) => current.filter((item) => item.id !== id)), []);

  const togglePin = useCallback((path: string) => {
    setPins((current) => {
      const next = current.includes(path) ? current.filter((item) => item !== path) : [path, ...current];
      try { localStorage.setItem(PINS_KEY, JSON.stringify(next)); } catch { /* storage is optional */ }
      return next;
    });
  }, []);

  const toggleMcp = useCallback(async (item: HermesMcp) => {
    const payload = await jsonResponse<{ ok?: boolean; error?: string }>("/api/hermes/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "toggle", name: item.name, enabled: !item.enabled, profile: selectedProfileRef.current === "default" ? undefined : selectedProfileRef.current }),
    });
    if (!payload.ok) throw new Error(payload.error || "MCP update failed");
    await loadMcps();
  }, [loadMcps]);

  const totalSessions = useMemo(() => groups.reduce((count, group) => count + group.sessions.length, 0), [groups]);
  const profileLocked = Boolean(activeSession);

  return {
    groups, historyState, historyError, source, totalSessions, activeGroup, activeSession,
    messages, transcriptState, transcriptError, sending, sendError, profiles, profilesState,
    selectedProfile, profileLocked, pins, queue, online, vitals, buckets, workspaceState,
    workspaceError, activeBucket, selectWorkspaceBucket, workspaceFiles, skillsOutput, skillsState,
    mcps, mcpCatalog, mcpState, mcpError, dashboard,
    loadHistory, loadProfiles, loadVitals, loadWorkspace, loadSkills, loadMcps, loadDashboard,
    openSession, createSession, setSelectedProfile, submitMessage, removeQueued, togglePin, toggleMcp,
  };
}
