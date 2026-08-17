"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  cancelWorkbenchRun,
  createWorkbenchIdempotencyKey,
  describeWorkbenchError,
  executeWorkbenchRun,
  isVerifiedCancellation,
  workbenchRunLabel,
  type WorkbenchStopState,
} from "@/lib/workbench/uiClient";
import type { Run, RunEvent } from "@/lib/workbench/types";
import { purgeLegacySensitiveBrowserState, readVolatileText, writeVolatileText } from "@/lib/workbench/volatileClientState";
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  CircleDot,
  Code2,
  FileCode2,
  FileDiff,
  FileText,
  FolderGit2,
  GitBranch,
  Globe2,
  LoaderCircle,
  Menu,
  MessageSquareText,
  PanelRightOpen,
  Pin,
  PinOff,
  Plus,
  Search,
  Send,
  Settings2,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";

type Panel = "chat" | "review" | "terminal" | "browser" | "files";
type TranscriptRole = "user" | "assistant" | "system" | "tool" | "reasoning";

interface SessionRow {
  id: string;
  nativeId?: string;
  name: string;
  path: string;
  preview?: string;
  mtime: number;
  pinned?: boolean;
  resumable?: boolean;
  source?: "native" | "local";
}

interface ProjectGroup {
  id: string;
  label: string;
  root: string;
  sessions: SessionRow[];
}

interface TranscriptTurn {
  role: TranscriptRole;
  text: string;
}

interface SessionDetail {
  id?: string;
  cwd?: string;
  model?: string | null;
  turns?: TranscriptTurn[];
  toolCalls?: { name: string; args: string; output?: string }[];
  referencedFiles?: string[];
  cwdFiles?: { relPath: string; bytes: number; kind: string }[];
}

interface TimelineEvent {
  id: string;
  kind: "reasoning" | "tool" | "status" | "error";
  title: string;
  detail?: string;
}

const CHANGE_TOOL = /(?:apply[_-]?patch|edit|write|create[_-]?file|delete[_-]?file|move[_-]?file|replace)/i;
const TERMINAL_TOOL = /(?:shell|command|exec|terminal|powershell|bash|cmd)/i;

function isChangeTool(name: string) {
  return CHANGE_TOOL.test(name);
}

function isTerminalTool(name: string) {
  return TERMINAL_TOOL.test(name);
}

const PAGE_SIZE = 50;
const PIN_KEY = "agentic-os:codex:pinned-sessions:v3";
const DRAFT_PREFIX = "draft:codex:";

function formatAge(value: number) {
  const delta = Date.now() - value;
  if (delta < 60_000) return "Now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

function readPinned() {
  try {
    const value = JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function eventText(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const row = item as Record<string, unknown>;
  for (const value of [row.text, row.delta, row.output, row.message]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export default function CodexDesktop() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "offline" | "error">("loading");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [pins, setPins] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(() => {
    const value = searchParams.get("panel");
    return value === "review" || value === "terminal" || value === "browser" || value === "files" ? value : "chat";
  });
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const activeRunRef = useRef<Run | null>(null);
  const [stopState, setStopState] = useState<WorkbenchStopState>("not_requested");
  const [nativeSessionId, setNativeSessionId] = useState<string | null>(null);

  const projectParam = searchParams.get("project");
  const sessionParam = searchParams.get("session");
  const sessionContext = groups
    .flatMap((group) => group.sessions.map((session) => ({ group, session })))
    .find(({ session }) => session.path === sessionParam || session.id === sessionParam)
    ?? null;
  const activeProject = sessionContext?.group ?? groups.find((group) => group.id === projectParam) ?? groups[0] ?? null;
  const activeSession = sessionContext?.session ?? null;
  const draftKey = `${DRAFT_PREFIX}${activeProject?.id ?? "unscoped"}:${activeSession?.id ?? "new"}`;

  const writeContextUrl = useCallback((next: { project?: string | null; session?: string | null; panel?: Panel }, mode: "push" | "replace" = "push") => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("agent", "codex");
    params.set("environment", "local");
    if (next.project === null) params.delete("project");
    else if (next.project) params.set("project", next.project);
    if (next.session === null) params.delete("session");
    else if (next.session) params.set("session", next.session);
    if (next.panel) params.set("panel", next.panel);
    const href = `/codex?${params.toString()}`;
    if (mode === "replace") router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  }, [router, searchParams]);

  useEffect(() => {
    if (!sessionContext || sessionContext.group.id === projectParam) return;
    writeContextUrl({ project: sessionContext.group.id, session: sessionParam }, "replace");
  }, [projectParam, sessionContext, sessionParam, writeContextUrl]);

  const loadHistory = useCallback(async () => {
    setHistoryState("loading");
    try {
      const response = await fetch("/api/agent-history?agent=codex", { cache: "no-store" });
      if (!response.ok) throw new Error(`History HTTP ${response.status}`);
      const payload = await response.json() as { groups?: ProjectGroup[] };
      const nextGroups = Array.isArray(payload.groups) ? payload.groups : [];
      setGroups(nextGroups);
      setHistoryState("ready");
      const urlProject = searchParams.get("project");
      if (!urlProject && nextGroups[0]) {
        writeContextUrl({ project: nextGroups[0].id }, "replace");
      }
    } catch (error) {
      setGroups([]);
      setHistoryState(navigator.onLine ? "error" : "offline");
    }
  }, [searchParams, writeContextUrl]);

  useEffect(() => {
    setPins(readPinned());
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        startConversation();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  });

  useEffect(() => {
    if (!drawerOpen || window.matchMedia("(min-width: 761px)").matches) return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : drawerTriggerRef.current;
    const focusable = () => Array.from(drawer.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"))
      .filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1)!;
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
  }, [drawerOpen]);

  useEffect(() => {
    const next = searchParams.get("panel");
    setPanel(next === "review" || next === "terminal" || next === "browser" || next === "files" ? next : "chat");
  }, [searchParams]);

  useEffect(() => {
    purgeLegacySensitiveBrowserState();
    setDraft(readVolatileText(draftKey));
  }, [draftKey]);

  useEffect(() => {
    const timeout = window.setTimeout(() => writeVolatileText(draftKey, draft), 180);
    return () => window.clearTimeout(timeout);
  }, [draft, draftKey]);

  useEffect(() => {
    if (!activeSession) {
      setDetail(null);
      setTurns([]);
      setEvents([]);
      setNativeSessionId(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/agent-history?agent=codex&path=${encodeURIComponent(activeSession.path)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Session unavailable")))
      .then((payload: { detail?: SessionDetail }) => {
        if (cancelled) return;
        const next = payload.detail ?? null;
        setDetail(next);
        setTurns(Array.isArray(next?.turns) ? next!.turns! : []);
        setEvents((next?.toolCalls ?? []).map((tool, index) => ({
          id: `native-tool-${index}`,
          kind: "tool",
          title: tool.name.replaceAll("_", " "),
          detail: `${tool.args}${tool.output ? `\n\n${tool.output}` : ""}`.slice(0, 1_600),
        })));
        setNativeSessionId(activeSession.nativeId || activeSession.id);
      })
      .catch(() => {
        if (!cancelled) setEvents([{ id: "load-error", kind: "error", title: "Session could not be loaded" }]);
      });
    return () => { cancelled = true; };
  }, [activeSession]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, events]);

  const allSessions = useMemo(() => activeProject?.sessions.map((session) => ({ ...session, projectId: activeProject.id })) ?? [], [activeProject]);
  const visibleSessions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return allSessions
      .filter((session) => !normalized || `${session.name} ${session.preview ?? ""} ${session.source ?? ""}`.toLocaleLowerCase().includes(normalized))
      .sort((a, b) => Number(pins.includes(b.path) || b.pinned) - Number(pins.includes(a.path) || a.pinned) || b.mtime - a.mtime)
      .slice(0, limit);
  }, [allSessions, limit, pins, query]);

  function selectSession(session: SessionRow & { projectId: string }) {
    setDrawerOpen(false);
    writeContextUrl({ project: session.projectId, session: session.path, panel: "chat" });
  }

  function startConversation() {
    if (!activeProject) return;
    setDrawerOpen(false);
    setDetail(null);
    setTurns([]);
    setEvents([]);
    setNativeSessionId(null);
    setDraft("");
    writeContextUrl({ project: activeProject.id, session: null, panel: "chat" });
  }

  function togglePin(path: string) {
    setPins((current) => {
      const next = current.includes(path) ? current.filter((item) => item !== path) : [...current, path];
      try { localStorage.setItem(PIN_KEY, JSON.stringify(next)); } catch { /* visible pin remains for this session */ }
      return next;
    });
  }

  function choosePanel(next: Panel) {
    setPanel(next);
    writeContextUrl({ panel: next }, "replace");
  }

  async function sendMessage() {
    const prompt = draft.trim();
    if (!prompt || running || !activeProject) return;
    const previousTurns = turns;
    setTurns((current) => [...current, { role: "user", text: prompt }]);
    setEvents([{ id: `requested-${Date.now()}`, kind: "status", title: "Requesting run", detail: "Codex · Workbench control plane" }]);
    setDraft("");
    setRunning(true);
    setStopState("not_requested");
    const controller = new AbortController();
    controllerRef.current = controller;
    let assistant = "";

    try {
      const result = await executeWorkbenchRun({
        agentId: "codex",
        prompt,
        projectId: activeProject.id,
        sessionId: nativeSessionId,
        idempotencyKey: createWorkbenchIdempotencyKey("codex"),
      }, {
        onStarted: ({ run }) => {
          activeRunRef.current = run;
          setActiveRun(run);
          setEvents((current) => [...current, {
            id: `run-${run.id}`,
            kind: "status",
            title: run.status,
            detail: `Run ${run.id} · ${run.context.projectId ?? activeProject.id}`,
          }]);
        },
        onOutput: (text) => {
          assistant += text;
          setTurns([...previousTurns, { role: "user", text: prompt }, { role: "assistant", text: assistant }]);
        },
        onEvent: (event: RunEvent) => {
          if (event.type === "reasoning") {
            setEvents((current) => [...current, { id: event.id, kind: "reasoning", title: "Reasoning", detail: String(event.payload.text ?? event.payload.message ?? "").slice(0, 480) }]);
          } else if (event.type === "tool") {
            setEvents((current) => [...current, { id: event.id, kind: "tool", title: String(event.payload.name ?? "Restricted tool event"), detail: String(event.payload.text ?? event.payload.message ?? "").slice(0, 800) }]);
          } else if (event.type === "error") {
            setEvents((current) => [...current, { id: event.id, kind: "error", title: "Run error", detail: String(event.payload.message ?? event.payload.code ?? "Unknown error") }]);
          }
        },
        onStatus: (status, event) => {
          setEvents((current) => [...current, { id: event.id, kind: "status", title: status }]);
        },
      }, controller.signal);
      activeRunRef.current = result.run;
      setActiveRun(result.run);
      setStopState(result.stop.state);
      if (result.run.context.sessionId) setNativeSessionId(result.run.context.sessionId);
      if (result.run.status === "succeeded") {
        if (!assistant.trim()) assistant = "Run completed without a text response.";
        setTurns([...previousTurns, { role: "user", text: prompt }, { role: "assistant", text: assistant }]);
        writeVolatileText(draftKey, "");
        void loadHistory();
      } else if (isVerifiedCancellation(result)) {
        setEvents((current) => [...current, { id: `cancelled-${Date.now()}`, kind: "status", title: "Stopped and verified" }]);
      } else {
        setDraft(prompt);
        writeVolatileText(draftKey, prompt);
        setEvents((current) => [...current, {
          id: `terminal-${Date.now()}`,
          kind: "error",
          title: result.run.status,
          detail: result.run.error?.message ?? "The run did not complete. Your draft was kept.",
        }]);
      }
    } catch (error) {
      setDraft(prompt);
      writeVolatileText(draftKey, prompt);
      setEvents((current) => [...current, { id: `error-${Date.now()}`, kind: "error", title: "Run failed", detail: describeWorkbenchError(error) }]);
    } finally {
      setRunning(false);
      controllerRef.current = null;
    }
  }

  async function stopRun() {
    const run = activeRunRef.current;
    if (!run || stopState === "stopping") return;
    setStopState("stopping");
    setEvents((current) => [...current, { id: `stop-${Date.now()}`, kind: "status", title: "Stop requested", detail: `Run ${run.id}` }]);
    try {
      const snapshot = await cancelWorkbenchRun(run, (next) => {
        activeRunRef.current = next.run;
        setActiveRun(next.run);
        setStopState(next.stop.state);
      });
      activeRunRef.current = snapshot.run;
      setActiveRun(snapshot.run);
      setStopState(snapshot.stop.state);
      if (isVerifiedCancellation(snapshot)) {
        setEvents((current) => [...current, { id: `stopped-${Date.now()}`, kind: "status", title: "Stopped and verified" }]);
      }
    } catch (error) {
      setStopState("failed_to_stop");
      setEvents((current) => [...current, { id: `stop-failed-${Date.now()}`, kind: "error", title: "Failed to stop", detail: describeWorkbenchError(error, false) }]);
    }
  }

  const activeTitle = activeSession?.name || "New conversation";
  const modelLabel = "Server-managed Codex pilot";
  const changeTools = detail?.toolCalls?.filter((tool) => isChangeTool(tool.name)) ?? [];
  const terminalTools = detail?.toolCalls?.filter((tool) => isTerminalTool(tool.name)) ?? [];

  return (
    <div className="codex-desktop" data-agent-desktop="codex" dir="ltr">
      <button ref={drawerTriggerRef} className="workbench-mobile-menu" type="button" aria-label="Open sessions" onClick={() => setDrawerOpen(true)}>
        <Menu size={18} />
      </button>
      {drawerOpen && <button className="workbench-drawer-backdrop" type="button" aria-label="Close sessions" onClick={() => setDrawerOpen(false)} />}

      <aside
        ref={drawerRef}
        className="codex-sidebar"
        data-open={drawerOpen ? "true" : "false"}
        aria-label="Codex projects and sessions"
        role={drawerOpen ? "dialog" : undefined}
        aria-modal={drawerOpen ? "true" : undefined}
      >
        <div className="codex-product-row">
          <span className="codex-product-mark" aria-hidden="true"><Code2 size={15} /></span>
          <strong>Codex</strong>
          <button type="button" aria-label="Close sessions" className="workbench-mobile-close" onClick={() => setDrawerOpen(false)}><X size={16} /></button>
        </div>
        <button className="codex-new-task" type="button" onClick={startConversation} disabled={!activeProject}>
          <Plus size={15} /> New conversation <span>Ctrl N</span>
        </button>
        <label className="codex-search">
          <Search size={14} aria-hidden="true" />
          <span className="sr-only">Search sessions</span>
          <input value={query} onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} placeholder="Search sessions" aria-label="Search Codex sessions" />
        </label>
        <div className="codex-project-picker">
          <FolderGit2 size={14} />
          <select
            aria-label="Active project"
            value={activeProject?.id ?? ""}
            onChange={(event) => writeContextUrl({ project: event.target.value, session: null })}
          >
            {groups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
          </select>
          <ChevronDown size={13} aria-hidden="true" />
        </div>
        <div className="codex-task-heading" aria-label={`${activeProject?.label || "Selected project"}: ${allSessions.length} sessions`}>
          <span>Sessions</span><span>{allSessions.length}</span>
        </div>
        <div className="codex-task-list" role="list">
          {historyState === "loading" && <div className="workbench-state"><LoaderCircle className="spin" size={17} /> Loading native history</div>}
          {historyState === "offline" && <div className="workbench-state"><CircleDot size={16} /> Offline. Native history remains unchanged.</div>}
          {historyState === "error" && <div className="workbench-state"><CircleDot size={16} /> History unavailable. <button onClick={() => void loadHistory()}>Retry</button></div>}
          {historyState === "ready" && visibleSessions.length === 0 && <div className="workbench-state"><Archive size={16} /> No matching sessions</div>}
          {visibleSessions.map((session) => {
            const selected = activeSession?.path === session.path;
            const pinned = pins.includes(session.path) || session.pinned;
            return (
              <div key={session.path} className="codex-task-row" data-selected={selected ? "true" : "false"} role="listitem">
                <button type="button" className="codex-task-select" onClick={() => selectSession(session)}>
                  <span className="codex-task-title">{session.name}</span>
                  <span className="codex-task-meta"><span>{formatAge(session.mtime)}</span><span>{session.resumable === false ? "Read only" : "Local"}</span></span>
                </button>
                <button type="button" className="codex-pin" aria-label={pinned ? `Unpin ${session.name}` : `Pin ${session.name}`} onClick={() => togglePin(session.path)}>
                  {pinned ? <PinOff size={13} /> : <Pin size={13} />}
                </button>
              </div>
            );
          })}
          {visibleSessions.length < allSessions.filter((session) => !query || `${session.name} ${session.preview ?? ""}`.toLowerCase().includes(query.toLowerCase())).length && (
            <button className="codex-load-more" type="button" onClick={() => setLimit((value) => value + PAGE_SIZE)}>Load 50 more</button>
          )}
        </div>
        <div className="codex-sidebar-footer">
          <div><Settings2 size={14} /> Native history · read-through</div>
        </div>
      </aside>

      <main className="codex-main">
        <header className="codex-topbar">
          <div className="codex-breadcrumb">
            <a className="codex-mission-link" href="/" aria-label="Return to Mission Control"><ArrowLeft size={14} /> Mission Control</a>
            <span>Codex</span>
            <span>/</span>
            <span>{activeProject?.label || "No project"}</span>
            <span>/</span>
            <strong>{activeTitle}</strong>
          </div>
          <div className="codex-context-badges">
            <span><GitBranch size={13} /> Local</span>
            <span>{modelLabel}</span>
            <span>Read-only · tools restricted</span>
            <span data-running={running ? "true" : "false"}>{activeRun ? workbenchRunLabel(activeRun, stopState) : activeSession ? "Ready" : "Draft"}</span>
          </div>
        </header>

        <nav className="codex-panel-tabs" aria-label="Session workspace">
          <button type="button" data-active={panel === "chat"} onClick={() => choosePanel("chat")}><MessageSquareText size={14} /> Chat</button>
          <button type="button" data-active={panel === "review"} onClick={() => choosePanel("review")}><FileDiff size={14} /> Review</button>
          <button type="button" data-active={panel === "terminal"} onClick={() => choosePanel("terminal")}><TerminalSquare size={14} /> Terminal</button>
          <button type="button" data-active={panel === "browser"} onClick={() => choosePanel("browser")}><Globe2 size={14} /> Browser</button>
          <button type="button" data-active={panel === "files"} onClick={() => choosePanel("files")}><FileCode2 size={14} /> Files</button>
        </nav>

        {panel === "chat" && (
          <div className="codex-chat-layout">
            <section ref={scrollRef} className="codex-transcript" aria-label="Codex conversation transcript">
              {turns.length === 0 && (
                <div className="codex-empty">
                  <span className="codex-empty-mark"><Code2 size={24} /></span>
                  <h1>What should Codex work on?</h1>
                  <p>Start a restricted conversation in <strong>{activeProject?.label || "a local project"}</strong>. The Workbench keeps the run, target, and lifecycle attached to this session.</p>
                </div>
              )}
              {turns.map((turn, index) => (
                <article key={`${turn.role}-${index}`} className="codex-message" data-role={turn.role} dir="auto">
                  <div className="codex-message-label">{turn.role === "user" ? "You" : turn.role === "assistant" ? "Codex" : turn.role}</div>
                  <div className="workbench-markdown">
                    {turn.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.text}</ReactMarkdown> : <p>{turn.text}</p>}
                  </div>
                </article>
              ))}
            </section>
            <aside className="codex-activity" aria-label="Session activity">
              <div className="codex-activity-title"><PanelRightOpen size={14} /> Activity</div>
              {events.length === 0 && <p>Run status, reasoning, and restricted output appear here while Codex works.</p>}
              {events.map((event) => (
                <details key={event.id} className="codex-event" open={event.kind === "error"}>
                  <summary><span data-kind={event.kind} />{event.title}</summary>
                  {event.detail && <pre dir="auto">{event.detail}</pre>}
                </details>
              ))}
            </aside>
          </div>
        )}

        {panel === "review" && (
          <section className="codex-work-panel" aria-label="Review changes">
            <div className="work-panel-heading"><div><span>Review</span><h1>Session changes</h1></div><span>{changeTools.length} file operations</span></div>
            {changeTools.length ? changeTools.map((tool, index) => (
              <details className="codex-review-item" key={`${tool.name}-${index}`}>
                <summary><FileDiff size={15} /><strong>{tool.name}</strong><span>Inspect</span></summary>
                <pre dir="auto">{tool.args}{tool.output ? `\n\n${tool.output}` : ""}</pre>
              </details>
            )) : <div className="workbench-empty-panel"><FileDiff size={22} /><strong>No recorded file changes</strong><span>Native tool activity remains available in the Activity rail.</span></div>}
          </section>
        )}

        {panel === "terminal" && (
          <section className="codex-work-panel codex-terminal" aria-label="Integrated terminal output">
            <div className="work-panel-heading"><div><span>Terminal</span><h1>{detail?.cwd || activeProject?.root || "Project shell"}</h1></div><span>Read-only transcript</span></div>
            <pre>{terminalTools.map((tool) => `$ ${tool.name}\n${tool.args}${tool.output ? `\n${tool.output}` : ""}`).join("\n\n") || "$ No terminal commands were recorded for this session"}</pre>
          </section>
        )}

        {panel === "browser" && (
          <section className="codex-work-panel" aria-label="Browser preview">
            <div className="work-panel-heading"><div><span>Browser</span><h1>Session browser</h1></div><span>Unsupported by current Codex CLI bridge</span></div>
            <div className="workbench-empty-panel"><Globe2 size={22} /><strong>Browser preview unavailable</strong><span>This runtime does not expose a browser session. No inactive browser control is simulated.</span></div>
          </section>
        )}

        {panel === "files" && (
          <section className="codex-work-panel" aria-label="Session files">
            <div className="work-panel-heading"><div><span>Files</span><h1>Referenced by this session</h1></div><span>{(detail?.cwdFiles?.length ?? 0) + (detail?.referencedFiles?.length ?? 0)} files</span></div>
            <div className="codex-file-list">
              {detail?.cwdFiles?.map((file) => <div key={file.relPath}><FileText size={15} /><span dir="auto">{file.relPath}</span><small>{Math.ceil(file.bytes / 1024)} KB</small></div>)}
              {detail?.referencedFiles?.map((file) => <div key={file}><FileCode2 size={15} /><span dir="auto">{file}</span><small>Referenced</small></div>)}
              {!detail?.cwdFiles?.length && !detail?.referencedFiles?.length && <div className="workbench-empty-panel"><FileCode2 size={22} /><strong>No session files</strong><span>Select a completed native session to inspect its files.</span></div>}
            </div>
          </section>
        )}

        <footer className="codex-composer">
          <div className="codex-composer-box">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder={activeProject ? `Message Codex in ${activeProject.label}` : "Select a project to start"}
              disabled={!activeProject}
              dir="auto"
              aria-label="Message Codex"
            />
            <div className="codex-composer-controls">
              <div>
                <span title="The restricted pilot runtime and model are selected by the server.">Server-managed Codex pilot</span>
                <span title="Workbench enforces the server-side read-only sandbox and denies tool approvals.">Read-only · tools restricted</span>
              </div>
              {running ? (
                <button type="button" className="codex-stop" onClick={() => void stopRun()} disabled={stopState === "stopping"}><Square size={14} /> {stopState === "stopping" ? "Stopping…" : "Stop"}</button>
              ) : (
                <button type="button" className="codex-send" onClick={() => void sendMessage()} disabled={!draft.trim() || !activeProject}><Send size={14} /> Send</button>
              )}
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
