"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
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
const DRAFT_PREFIX = "agentic-os:codex:draft:v3:";

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
  const [nativeSessionId, setNativeSessionId] = useState<string | null>(null);
  const [approvalMode, setApprovalMode] = useState<"readonly" | "auto" | "yolo">("auto");
  const [engine, setEngine] = useState<"gpt56" | "omniroute" | "hy3">("gpt56");

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
        startTask();
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
    try { setDraft(localStorage.getItem(draftKey) || ""); } catch { setDraft(""); }
  }, [draftKey]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        if (draft) localStorage.setItem(draftKey, draft);
        else localStorage.removeItem(draftKey);
      } catch { /* local drafts are best effort */ }
    }, 180);
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

  const allSessions = useMemo(() => groups.flatMap((group) => group.sessions.map((session) => ({ ...session, projectId: group.id }))), [groups]);
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

  function startTask() {
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
    setEvents([{ id: `queued-${Date.now()}`, kind: "status", title: "Queued", detail: "Waiting for Codex" }]);
    setDraft("");
    setRunning(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    let assistant = "";

    try {
      const response = await fetch("/api/codex/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          history: previousTurns.filter((turn) => turn.role === "user" || turn.role === "assistant"),
          cwd: activeProject.root || undefined,
          sessionId: nativeSessionId || undefined,
          approvalMode,
          engine,
        }),
        signal: controller.signal,
      });
      if (!response.body) throw new Error(`Codex HTTP ${response.status}`);
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Codex HTTP ${response.status}`);
      }
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
          let event: Record<string, unknown>;
          try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          const type = String(event.type ?? "");
          const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : null;
          if (type === "thread.started" && typeof event.thread_id === "string") setNativeSessionId(event.thread_id);
          if ((type === "item.delta" || type === "item.completed") && item?.type === "agent_message") {
            const text = eventText(item);
            if (type === "item.delta") assistant += text;
            else if (!assistant) assistant = text;
            setTurns([...previousTurns, { role: "user", text: prompt }, { role: "assistant", text: assistant }]);
          } else if (type === "item.completed" && item?.type === "reasoning") {
            setEvents((current) => [...current, { id: `reason-${current.length}`, kind: "reasoning", title: "Reasoned", detail: eventText(item).slice(0, 480) }]);
          } else if ((type === "item.started" || type === "item.completed") && typeof item?.type === "string" && item.type !== "agent_message") {
            setEvents((current) => [...current, { id: `tool-${current.length}`, kind: "tool", title: String(item.type).replaceAll("_", " "), detail: eventText(item).slice(0, 800) }]);
          } else if (type === "error") {
            setEvents((current) => [...current, { id: `error-${current.length}`, kind: "error", title: "Run failed", detail: String(event.message ?? "Unknown error") }]);
          }
        }
      }
      if (!assistant) assistant = "Run completed without a text response.";
      setTurns([...previousTurns, { role: "user", text: prompt }, { role: "assistant", text: assistant }]);
      setEvents((current) => [...current, { id: `done-${Date.now()}`, kind: "status", title: "Completed" }]);
      try { localStorage.removeItem(draftKey); } catch { /* draft already cleared in memory */ }
      void loadHistory();
    } catch (error) {
      if (controller.signal.aborted) {
        setEvents((current) => [...current, { id: `cancelled-${Date.now()}`, kind: "status", title: "Cancelled" }]);
      } else {
        setEvents((current) => [...current, { id: `error-${Date.now()}`, kind: "error", title: "Run failed", detail: error instanceof Error ? error.message : String(error) }]);
      }
    } finally {
      setRunning(false);
      controllerRef.current = null;
    }
  }

  function stopRun() {
    controllerRef.current?.abort();
  }

  const activeTitle = activeSession?.name || "New task";
  const modelLabel = engine === "gpt56" ? "GPT-5.6" : engine === "hy3" ? "HY3" : "OmniRoute";
  const changeTools = detail?.toolCalls?.filter((tool) => isChangeTool(tool.name)) ?? [];
  const terminalTools = detail?.toolCalls?.filter((tool) => isTerminalTool(tool.name)) ?? [];

  return (
    <div className="codex-desktop" data-agent-desktop="codex" dir="ltr">
      <button ref={drawerTriggerRef} className="workbench-mobile-menu" type="button" aria-label="Open tasks" onClick={() => setDrawerOpen(true)}>
        <Menu size={18} />
      </button>
      {drawerOpen && <button className="workbench-drawer-backdrop" type="button" aria-label="Close tasks" onClick={() => setDrawerOpen(false)} />}

      <aside
        ref={drawerRef}
        className="codex-sidebar"
        data-open={drawerOpen ? "true" : "false"}
        aria-label="Codex projects and tasks"
        role={drawerOpen ? "dialog" : undefined}
        aria-modal={drawerOpen ? "true" : undefined}
      >
        <div className="codex-product-row">
          <span className="codex-product-mark" aria-hidden="true"><Code2 size={15} /></span>
          <strong>Codex</strong>
          <button type="button" aria-label="Close tasks" className="workbench-mobile-close" onClick={() => setDrawerOpen(false)}><X size={16} /></button>
        </div>
        <button className="codex-new-task" type="button" onClick={startTask} disabled={!activeProject}>
          <Plus size={15} /> New task <span>Ctrl N</span>
        </button>
        <label className="codex-search">
          <Search size={14} aria-hidden="true" />
          <span className="sr-only">Search tasks</span>
          <input value={query} onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} placeholder="Search tasks" />
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
        <div className="codex-task-heading">
          <span>Tasks</span><span>{allSessions.length}</span>
        </div>
        <div className="codex-task-list" role="list">
          {historyState === "loading" && <div className="workbench-state"><LoaderCircle className="spin" size={17} /> Loading native history</div>}
          {historyState === "offline" && <div className="workbench-state"><CircleDot size={16} /> Offline. Native history remains unchanged.</div>}
          {historyState === "error" && <div className="workbench-state"><CircleDot size={16} /> History unavailable. <button onClick={() => void loadHistory()}>Retry</button></div>}
          {historyState === "ready" && visibleSessions.length === 0 && <div className="workbench-state"><Archive size={16} /> No matching tasks</div>}
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
            <span>{activeProject?.label || "No project"}</span>
            <span>/</span>
            <strong>{activeTitle}</strong>
          </div>
          <div className="codex-context-badges">
            <span><GitBranch size={13} /> Local</span>
            <span>{modelLabel}</span>
            <span data-running={running ? "true" : "false"}>{running ? "Running" : activeSession ? "Ready" : "Draft"}</span>
          </div>
        </header>

        <nav className="codex-panel-tabs" aria-label="Task workspace">
          <button type="button" data-active={panel === "chat"} onClick={() => choosePanel("chat")}><MessageSquareText size={14} /> Chat</button>
          <button type="button" data-active={panel === "review"} onClick={() => choosePanel("review")}><FileDiff size={14} /> Review</button>
          <button type="button" data-active={panel === "terminal"} onClick={() => choosePanel("terminal")}><TerminalSquare size={14} /> Terminal</button>
          <button type="button" data-active={panel === "browser"} onClick={() => choosePanel("browser")}><Globe2 size={14} /> Browser</button>
          <button type="button" data-active={panel === "files"} onClick={() => choosePanel("files")}><FileCode2 size={14} /> Files</button>
        </nav>

        {panel === "chat" && (
          <div className="codex-chat-layout">
            <section ref={scrollRef} className="codex-transcript" aria-label="Task transcript">
              {turns.length === 0 && (
                <div className="codex-empty">
                  <span className="codex-empty-mark"><Code2 size={24} /></span>
                  <h1>What should Codex work on?</h1>
                  <p>Start a task in <strong>{activeProject?.label || "a local project"}</strong>. Changes, commands, and review stay attached to this task.</p>
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
            <aside className="codex-activity" aria-label="Task activity">
              <div className="codex-activity-title"><PanelRightOpen size={14} /> Activity</div>
              {events.length === 0 && <p>Commands, reasoning, and approvals appear here while Codex works.</p>}
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
            <div className="work-panel-heading"><div><span>Review</span><h1>Task changes</h1></div><span>{changeTools.length} file operations</span></div>
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
            <pre>{terminalTools.map((tool) => `$ ${tool.name}\n${tool.args}${tool.output ? `\n${tool.output}` : ""}`).join("\n\n") || "$ No terminal commands were recorded for this task"}</pre>
          </section>
        )}

        {panel === "browser" && (
          <section className="codex-work-panel" aria-label="Browser preview">
            <div className="work-panel-heading"><div><span>Browser</span><h1>Task browser</h1></div><span>Unsupported by current Codex CLI bridge</span></div>
            <div className="workbench-empty-panel"><Globe2 size={22} /><strong>Browser preview unavailable</strong><span>This runtime does not expose a browser session. No inactive browser control is simulated.</span></div>
          </section>
        )}

        {panel === "files" && (
          <section className="codex-work-panel" aria-label="Task files">
            <div className="work-panel-heading"><div><span>Files</span><h1>Referenced by this task</h1></div><span>{(detail?.cwdFiles?.length ?? 0) + (detail?.referencedFiles?.length ?? 0)} files</span></div>
            <div className="codex-file-list">
              {detail?.cwdFiles?.map((file) => <div key={file.relPath}><FileText size={15} /><span dir="auto">{file.relPath}</span><small>{Math.ceil(file.bytes / 1024)} KB</small></div>)}
              {detail?.referencedFiles?.map((file) => <div key={file}><FileCode2 size={15} /><span dir="auto">{file}</span><small>Referenced</small></div>)}
              {!detail?.cwdFiles?.length && !detail?.referencedFiles?.length && <div className="workbench-empty-panel"><FileCode2 size={22} /><strong>No task files</strong><span>Select a completed native task to inspect its files.</span></div>}
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
                <select value={engine} onChange={(event) => setEngine(event.target.value as typeof engine)} aria-label="Model runtime">
                  <option value="gpt56">GPT-5.6</option><option value="omniroute">OmniRoute</option><option value="hy3">HY3</option>
                </select>
                <select value={approvalMode} onChange={(event) => setApprovalMode(event.target.value as typeof approvalMode)} aria-label="Permission mode">
                  <option value="readonly">Read-only</option><option value="auto">Workspace write</option><option value="yolo">Full access</option>
                </select>
              </div>
              {running ? (
                <button type="button" className="codex-stop" onClick={stopRun}><Square size={14} /> Stop</button>
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
