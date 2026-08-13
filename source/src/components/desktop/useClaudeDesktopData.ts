"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ClaudeSession {
  id: string;
  nativeId?: string;
  name: string;
  path: string;
  mtime: number;
  bytes: number;
  preview?: string;
  resumable?: boolean;
  source?: "native" | "local";
  nativeStarted?: boolean;
}

export interface ClaudeProjectGroup {
  id: string;
  label: string;
  root: string;
  sessions: ClaudeSession[];
}

export interface ClaudeMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

export interface ClaudeProject {
  name: string;
  root: string;
  mtime: number;
  fileCount: number;
}

export interface ClaudeWorkspaceFile {
  name: string;
  relPath: string;
  bytes: number;
  mtime: number;
  isText: boolean;
  kind: "text" | "image" | "video" | "audio" | "pdf" | "binary";
}

export interface ClaudeRunSummary {
  id: string;
  prompt: string;
  headline?: string;
  status: "running" | "completed" | "failed" | "stopped";
  subagentCount: number;
  costUsd?: number;
  durationMs?: number;
  startedAt: number;
}

export interface ClaudeArtifact {
  id?: string;
  slug?: string;
  title?: string;
  name?: string;
  url?: string;
  status?: string;
  updatedAt?: number;
  [key: string]: unknown;
}

type LoadState = "loading" | "ready" | "empty" | "error" | "offline";

const PINS_KEY = "agentic-os:claude:pins:v1";
const chatStorageKey = (path: string) => `agentic-os-chat-v3:claude:${path}`;

function readPins(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PINS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function makeUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

async function jsonResponse<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String((payload as { error?: unknown }).error ?? `${response.status} ${response.statusText}`));
  return payload as T;
}

export function useClaudeDesktopData() {
  const [groups, setGroups] = useState<ClaudeProjectGroup[]>([]);
  const [historyState, setHistoryState] = useState<LoadState>("loading");
  const [historyError, setHistoryError] = useState("");
  const [source, setSource] = useState("");
  const [activeGroup, setActiveGroup] = useState<ClaudeProjectGroup | null>(null);
  const [activeSession, setActiveSession] = useState<ClaudeSession | null>(null);
  const [messages, setMessages] = useState<ClaudeMessage[]>([]);
  const messagesRef = useRef<ClaudeMessage[]>([]);
  const [transcriptState, setTranscriptState] = useState<LoadState>("empty");
  const [transcriptError, setTranscriptError] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [partial, setPartial] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [pins, setPins] = useState<string[]>([]);
  const [online, setOnline] = useState(true);
  const [runtimeReady, setRuntimeReady] = useState<boolean | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState("");
  const [projects, setProjects] = useState<ClaudeProject[]>([]);
  const [workspaceState, setWorkspaceState] = useState<LoadState>("loading");
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceProject, setWorkspaceProject] = useState<ClaudeProject | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<ClaudeWorkspaceFile[]>([]);
  const [runs, setRuns] = useState<ClaudeRunSummary[]>([]);
  const [artifacts, setArtifacts] = useState<{ publishable: ClaudeArtifact[]; published: ClaudeArtifact[]; site?: string }>({ publishable: [], published: [] });
  const abortRef = useRef<AbortController | null>(null);

  const workspaceFromUrl = useCallback(() => new URLSearchParams(window.location.search).get("workspace"), []);

  const syncWorkspaceUrl = useCallback((project: ClaudeProject | null, mode: "push" | "replace" = "push") => {
    const url = new URL(window.location.href);
    if (project) url.searchParams.set("workspace", project.name);
    else url.searchParams.delete("workspace");
    if (url.href !== window.location.href) window.history[mode === "replace" ? "replaceState" : "pushState"](window.history.state, "", url);
  }, []);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    setPins(readPins());
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const loadRuntime = useCallback(async () => {
    try {
      const payload = await jsonResponse<{ claude?: { ok?: boolean; version?: string } }>("/api/vitals");
      setRuntimeReady(Boolean(payload.claude?.ok));
      setRuntimeVersion(payload.claude?.version ?? "");
    } catch {
      setRuntimeReady(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryState(navigator.onLine ? "loading" : "offline");
    setHistoryError("");
    try {
      const payload = await jsonResponse<{ groups?: ClaudeProjectGroup[]; source?: string }>("/api/agent-history?agent=claude");
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

  const loadWorkspace = useCallback(async () => {
    setWorkspaceState("loading");
    setWorkspaceError("");
    try {
      const payload = await jsonResponse<{ projects?: ClaudeProject[] }>("/api/claude/workspace");
      const next = payload.projects ?? [];
      setProjects(next);
      const requestedWorkspace = workspaceFromUrl();
      setWorkspaceProject((current) => next.find((project) => project.name === requestedWorkspace) ?? next.find((project) => project.name === current?.name) ?? next[0] ?? null);
      setWorkspaceState(next.length ? "ready" : "empty");
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
      setWorkspaceState(navigator.onLine ? "error" : "offline");
    }
  }, [workspaceFromUrl]);

  const selectWorkspaceProject = useCallback((project: ClaudeProject | null, mode: "push" | "replace" = "push") => {
    setWorkspaceProject(project);
    syncWorkspaceUrl(project, mode);
  }, [syncWorkspaceUrl]);

  useEffect(() => {
    const hydrateWorkspace = () => {
      const requestedWorkspace = workspaceFromUrl();
      if (!requestedWorkspace) return;
      const match = projects.find((project) => project.name === requestedWorkspace);
      if (match) setWorkspaceProject(match);
    };
    hydrateWorkspace();
    window.addEventListener("popstate", hydrateWorkspace);
    return () => window.removeEventListener("popstate", hydrateWorkspace);
  }, [projects, workspaceFromUrl]);

  const loadSecondaryData = useCallback(async () => {
    const [runResult, artifactResult] = await Promise.allSettled([
      jsonResponse<{ runs?: ClaudeRunSummary[] }>("/api/claude/ultracode"),
      jsonResponse<{ publishable?: ClaudeArtifact[]; published?: ClaudeArtifact[]; site?: string }>("/api/claude/artifacts"),
    ]);
    if (runResult.status === "fulfilled") setRuns(runResult.value.runs ?? []);
    if (artifactResult.status === "fulfilled") {
      setArtifacts({
        publishable: artifactResult.value.publishable ?? [],
        published: artifactResult.value.published ?? [],
        site: artifactResult.value.site,
      });
    }
  }, []);

  useEffect(() => {
    void Promise.all([loadHistory(), loadWorkspace(), loadRuntime(), loadSecondaryData()]);
  }, [loadHistory, loadRuntime, loadSecondaryData, loadWorkspace]);

  useEffect(() => {
    if (!workspaceProject) {
      setWorkspaceFiles([]);
      return;
    }
    let cancelled = false;
    void jsonResponse<{ files?: ClaudeWorkspaceFile[] }>(`/api/claude/workspace?project=${encodeURIComponent(workspaceProject.name)}`)
      .then((payload) => { if (!cancelled) setWorkspaceFiles(payload.files ?? []); })
      .catch((error) => {
        if (!cancelled) {
          setWorkspaceFiles([]);
          setWorkspaceError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => { cancelled = true; };
  }, [workspaceProject]);

  const syncUrl = useCallback((group: ClaudeProjectGroup | null, session: ClaudeSession | null) => {
    const url = new URL(window.location.href);
    if (group) url.searchParams.set("project", group.id); else url.searchParams.delete("project");
    if (session) url.searchParams.set("session", session.path); else url.searchParams.delete("session");
    window.history.pushState(window.history.state, "", url);
  }, []);

  const openSession = useCallback(async (session: ClaudeSession, group: ClaudeProjectGroup, updateUrl = true) => {
    setActiveGroup(group);
    setActiveSession(session);
    setMessages([]);
    setPartial("");
    setModel(null);
    setTranscriptError("");
    setTranscriptState("loading");
    if (updateUrl) syncUrl(group, session);
    try {
      if (session.source === "local" || session.path.startsWith("local:")) {
        const stored = localStorage.getItem(chatStorageKey(session.path));
        const parsed = stored ? JSON.parse(stored) : [];
        const next = Array.isArray(parsed) ? parsed : [];
        setMessages(next);
        setTranscriptState(next.length ? "ready" : "empty");
      } else {
        const payload = await jsonResponse<{ detail?: { turns?: { role?: string; text?: string }[]; model?: string | null } }>(`/api/agent-history?agent=claude&path=${encodeURIComponent(session.path)}`);
        const next = (payload.detail?.turns ?? [])
          .filter((turn): turn is { role: "user" | "assistant"; text: string } => (turn.role === "user" || turn.role === "assistant") && typeof turn.text === "string" && Boolean(turn.text.trim()))
          .map((turn) => ({ role: turn.role, text: turn.text, ts: session.mtime }));
        setMessages(next);
        setModel(payload.detail?.model ?? null);
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
      if (requestedSession) {
        for (const group of groups) {
          const session = group.sessions.find((item) => item.path === requestedSession || item.id === requestedSession);
          if (session) {
            if (activeSession?.path !== session.path) void openSession(session, group, false);
            return;
          }
        }
        if (requestedSession.startsWith("local:claude:")) {
          const id = requestedSession.slice("local:claude:".length);
          const projectName = requestedProject?.replace(/^draft:/, "") || "claude-default";
          const project = projects.find((item) => item.name === projectName);
          const group: ClaudeProjectGroup = { id: requestedProject || `draft:${projectName}`, label: projectName, root: project?.root || "", sessions: [] };
          const session: ClaudeSession = { id, nativeId: id, name: "Claude draft", path: requestedSession, mtime: Date.now(), bytes: 0, source: "local", resumable: true };
          if (activeSession?.path !== requestedSession) void openSession(session, group, false);
          return;
        }
      }
      const group = requestedProject ? groups.find((item) => item.id === requestedProject) ?? null : null;
      setActiveGroup(group ?? groups[0] ?? null);
      setActiveSession(null);
      setMessages([]);
      setTranscriptState("empty");
    };
    hydrate();
    window.addEventListener("popstate", hydrate);
    return () => window.removeEventListener("popstate", hydrate);
  }, [activeSession?.path, groups, historyState, openSession, projects]);

  useEffect(() => {
    if (!activeSession?.path || activeSession.source !== "local") return;
    try { localStorage.setItem(chatStorageKey(activeSession.path), JSON.stringify(messages.slice(-200))); } catch { /* storage is optional */ }
  }, [activeSession?.path, activeSession?.source, messages]);

  const createSession = useCallback((project?: ClaudeProject) => {
    const id = makeUuid();
    const selectedProject = project ?? workspaceProject ?? projects[0] ?? null;
    const group: ClaudeProjectGroup = selectedProject
      ? { id: `draft:${selectedProject.name}`, label: selectedProject.name, root: selectedProject.root, sessions: [] }
      : { id: "draft:claude-default", label: "claude-default", root: "", sessions: [] };
    const session: ClaudeSession = {
      id,
      nativeId: id,
      name: "New Claude task",
      path: `local:claude:${id}`,
      mtime: Date.now(),
      bytes: 0,
      resumable: true,
      source: "local",
      nativeStarted: false,
    };
    setActiveGroup(group);
    setActiveSession(session);
    setMessages([]);
    setPartial("");
    setModel(null);
    setTranscriptState("empty");
    setSendError("");
    syncUrl(group, session);
  }, [projects, syncUrl, workspaceProject]);

  const rememberNativeId = useCallback((nativeId: string) => {
    setActiveSession((current) => current ? { ...current, nativeId, nativeStarted: true } : current);
  }, []);

  const sendMessage = useCallback(async (raw: string) => {
    const prompt = raw.trim();
    if (!prompt || sending || !activeSession) return;
    const before = messagesRef.current;
    const userMessage: ClaudeMessage = { role: "user", text: prompt, ts: Date.now() };
    setMessages([...before, userMessage]);
    setTranscriptState("ready");
    setSendError("");
    setPartial("");
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let accumulated = "";
    try {
      const response = await fetch("/api/claude/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          cwd: activeGroup?.root || workspaceProject?.root || undefined,
          project: workspaceProject?.name,
          sessionId: activeSession.source === "native" || activeSession.nativeStarted ? (activeSession.nativeId || activeSession.id) : undefined,
          newSessionId: activeSession.source === "local" && !activeSession.nativeStarted ? activeSession.nativeId : undefined,
          sessionName: activeSession.name,
          history: before.slice(-24).map((message) => ({ role: message.role, text: message.text })),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error((await response.text()) || `${response.status} ${response.statusText}`);
      if (!response.body) throw new Error("Claude returned no response stream.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            const streamEvent = event.event as { delta?: { text?: unknown } } | undefined;
            if (event.type === "stream_event" && typeof streamEvent?.delta?.text === "string") {
              accumulated += streamEvent.delta.text;
              setPartial(accumulated);
            } else if (event.type === "result" && typeof event.result === "string" && !accumulated) {
              accumulated = event.result;
              setPartial(accumulated);
            }
            const nativeId = typeof event.session_id === "string" ? event.session_id : typeof event.sessionId === "string" ? event.sessionId : null;
            if (nativeId) rememberNativeId(nativeId);
          } catch { /* stream can contain non-json diagnostic lines */ }
        }
      }
      if (!accumulated.trim()) throw new Error("Claude finished without readable output.");
      setMessages((current) => [...current, { role: "assistant", text: accumulated, ts: Date.now() }]);
      setPartial("");
      void Promise.all([loadHistory(), loadSecondaryData(), loadWorkspace()]);
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        setSendError("Run stopped. Claude process received a cancellation request.");
      } else {
        setSendError(error instanceof Error ? error.message : String(error));
      }
      if (accumulated.trim()) setMessages((current) => [...current, { role: "assistant", text: accumulated, ts: Date.now() }]);
      setPartial("");
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  }, [activeGroup?.root, activeSession, loadHistory, loadSecondaryData, loadWorkspace, rememberNativeId, sending, workspaceProject?.name, workspaceProject?.root]);

  const stopRun = useCallback(() => abortRef.current?.abort(), []);

  const togglePin = useCallback((path: string) => {
    setPins((current) => {
      const next = current.includes(path) ? current.filter((item) => item !== path) : [path, ...current];
      try { localStorage.setItem(PINS_KEY, JSON.stringify(next)); } catch { /* storage is optional */ }
      return next;
    });
  }, []);

  const totalSessions = useMemo(() => groups.reduce((count, group) => count + group.sessions.length, 0), [groups]);

  return {
    groups, historyState, historyError, source, totalSessions, activeGroup, setActiveGroup,
    activeSession, messages, transcriptState, transcriptError, model, partial, sending, sendError,
    pins, online, runtimeReady, runtimeVersion, projects, workspaceState, workspaceError,
    workspaceProject, selectWorkspaceProject, workspaceFiles, runs, artifacts,
    loadHistory, loadWorkspace, loadSecondaryData, openSession, createSession, sendMessage, stopRun, togglePin,
  };
}
