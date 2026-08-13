"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  ExternalLink,
  FileDiff,
  Files,
  Folder,
  Globe2,
  ListTodo,
  Loader2,
  LockKeyhole,
  Menu,
  MessageSquare,
  Package,
  PanelRightClose,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Square,
  Terminal,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./ClaudeDesktop.module.css";
import {
  type ClaudeProjectGroup,
  type ClaudeSession,
  type ClaudeWorkspaceFile,
  useClaudeDesktopData,
} from "./useClaudeDesktopData";

type ClaudeView = "code" | "tasks" | "files" | "artifacts";
type ClaudePane = "diff" | "terminal" | "browser" | "files" | "tasks" | "artifacts";
type TimeFilter = "all" | "today" | "week" | "pinned";

const PANE_LABELS: Record<ClaudePane, string> = {
  diff: "Diff",
  terminal: "Terminal",
  browser: "Browser",
  files: "Files",
  tasks: "Tasks",
  artifacts: "Artifacts",
};

function ago(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 14 ? `${days}d` : new Date(ms).toLocaleDateString();
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isRtl(value: string): boolean {
  const rtl = (value.match(/[\u0590-\u08ff]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  return rtl > latin;
}

function StatusSurface({
  state,
  error,
  onRetry,
}: {
  state: "loading" | "ready" | "empty" | "error" | "offline";
  error?: string;
  onRetry?: () => void;
}) {
  if (state === "ready") return null;
  const icon = state === "loading" ? <Loader2 className={styles.spin} size={18} /> : state === "error" ? <AlertTriangle size={18} /> : state === "offline" ? <Archive size={18} /> : <Folder size={18} />;
  const title = state === "loading" ? "Loading Claude data" : state === "error" ? "Claude data could not be loaded" : state === "offline" ? "Agent OS is offline" : "Claude is ready for its first task";
  const detail = state === "error" ? (error || "The local API returned an error.") : state === "offline" ? "Reconnect to this local Agent OS server, then retry." : state === "empty" ? "Create a task to start a native Claude Code session." : "Reading native projects and sessions…";
  return (
    <div className={styles.statusSurface} role={state === "error" ? "alert" : "status"}>
      <span className={styles.statusIcon}>{icon}</span>
      <strong>{title}</strong>
      <span>{detail}</span>
      {onRetry && state !== "loading" && <button type="button" onClick={onRetry}><RefreshCw size={15} />Retry</button>}
    </div>
  );
}

export default function ClaudeDesktop() {
  const data = useClaudeDesktopData();
  const [view, setView] = useState<ClaudeView>("code");
  const [pane, setPane] = useState<ClaudePane | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [visibleLimit, setVisibleLimit] = useState(80);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [input, setInput] = useState("");
  const [transcriptMode, setTranscriptMode] = useState<"conversation" | "activity">("conversation");
  const [selectedFile, setSelectedFile] = useState<ClaudeWorkspaceFile | null>(null);
  const [fileText, setFileText] = useState("");
  const [fileError, setFileError] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const paneTriggerRef = useRef<HTMLButtonElement | null>(null);
  const hydratingUrlRef = useRef(false);

  useFocusContainment(drawerOpen, drawerRef, () => setDrawerOpen(false), drawerTriggerRef);
  useFocusContainment(Boolean(pane), paneRef, () => setPane(null), paneTriggerRef, true);

  useEffect(() => {
    const hydrate = () => {
      hydratingUrlRef.current = true;
      const params = new URLSearchParams(window.location.search);
      const requestedView = params.get("view") as ClaudeView | null;
      const requestedPane = params.get("pane") as ClaudePane | null;
      setView(requestedView && ["code", "tasks", "files", "artifacts"].includes(requestedView) ? requestedView : "code");
      setPane(requestedPane && Object.keys(PANE_LABELS).includes(requestedPane) ? requestedPane : null);
    };
    hydrate();
    window.addEventListener("popstate", hydrate);
    return () => window.removeEventListener("popstate", hydrate);
  }, []);

  useEffect(() => {
    const onNavigation = (event: Event) => {
      const detail = (event as CustomEvent<{ agent?: string; target?: string; section?: string }>).detail;
      if (detail?.agent !== "claude") return;
      const target = detail.target ?? detail.section;
      if (target === "new") data.createSession();
      else if (target === "workspace" || target === "projects") setView("files");
      else if (target === "artifacts") setView("artifacts");
      else if (target === "ultracode" || target === "agents" || target === "tools") setView("tasks");
      else setView("code");
    };
    window.addEventListener("agent-workspace-nav", onNavigation);
    return () => window.removeEventListener("agent-workspace-nav", onNavigation);
  }, [data]);

  useEffect(() => {
    if (hydratingUrlRef.current) {
      hydratingUrlRef.current = false;
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    if (pane) url.searchParams.set("pane", pane); else url.searchParams.delete("pane");
    if (url.href !== window.location.href) window.history.pushState(window.history.state, "", url);
  }, [pane, view]);

  useEffect(() => {
    if (data.activeGroup) setExpandedGroups((current) => new Set(current).add(data.activeGroup!.id));
  }, [data.activeGroup]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [data.messages, data.partial]);

  const filteredGroups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const now = Date.now();
    let remaining = visibleLimit;
    return data.groups.flatMap((group) => {
      const sessions = group.sessions
        .filter((session) => {
          const matchesQuery = !normalized || `${session.name} ${session.preview ?? ""} ${group.label} ${group.root} ${session.resumable === false ? "read only" : "resumable"}`.toLowerCase().includes(normalized);
          if (!matchesQuery) return false;
          if (timeFilter === "pinned") return data.pins.includes(session.path);
          if (timeFilter === "today") return now - session.mtime < 86_400_000;
          if (timeFilter === "week") return now - session.mtime < 604_800_000;
          return true;
        })
        .sort((a, b) => Number(data.pins.includes(b.path)) - Number(data.pins.includes(a.path)) || b.mtime - a.mtime);
      if (!sessions.length || remaining <= 0) return [];
      const visible = sessions.slice(0, remaining);
      remaining -= visible.length;
      return [{ ...group, sessions: visible }];
    });
  }, [data.groups, data.pins, query, timeFilter, visibleLimit]);

  const filteredTotal = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const now = Date.now();
    return data.groups.reduce((count, group) => count + group.sessions.filter((session) => {
      if (normalized && !`${session.name} ${session.preview ?? ""} ${group.label} ${group.root} ${session.resumable === false ? "read only" : "resumable"}`.toLowerCase().includes(normalized)) return false;
      if (timeFilter === "pinned") return data.pins.includes(session.path);
      if (timeFilter === "today") return now - session.mtime < 86_400_000;
      if (timeFilter === "week") return now - session.mtime < 604_800_000;
      return true;
    }).length, 0);
  }, [data.groups, data.pins, query, timeFilter]);

  function chooseView(next: ClaudeView) {
    setView(next);
    if (next === "files") setPane("files");
    if (next === "tasks") setPane("tasks");
    if (next === "artifacts") setPane("artifacts");
  }

  function chooseSession(session: ClaudeSession, group: ClaudeProjectGroup) {
    void data.openSession(session, group);
    setView("code");
    setDrawerOpen(false);
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const prompt = input.trim();
    if (!prompt || data.sending || !data.activeSession) return;
    setInput("");
    void data.sendMessage(prompt);
  }

  function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  async function openFile(file: ClaudeWorkspaceFile) {
    if (!data.workspaceProject) return;
    setSelectedFile(file);
    setFileText("");
    setFileError("");
    if (!file.isText) return;
    setFileLoading(true);
    try {
      const response = await fetch(`/api/claude/workspace/file?project=${encodeURIComponent(data.workspaceProject.name)}&path=${encodeURIComponent(file.relPath)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(String(payload.error ?? response.statusText));
      setFileText(payload.content ?? "");
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setFileLoading(false);
    }
  }

  const filePreviewUrl = selectedFile && data.workspaceProject
    ? `/api/claude/preview/${encodeURIComponent(data.workspaceProject.name)}/${selectedFile.relPath.split(/[\\/]/).map(encodeURIComponent).join("/")}`
    : "";

  return (
    <div data-agent-page="claude" data-agent-experience="immersive" data-pane-open={Boolean(pane)} className={styles.shell}>
      <header className={styles.mobileHeader}>
        <button ref={drawerTriggerRef} type="button" aria-label="Open sessions" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}><Menu size={20} /></button>
        <div className={styles.mobileIdentity}><span className={styles.claudeMark}>AI</span><strong>Claude Code</strong></div>
        <button type="button" aria-label="New Claude task" onClick={() => data.createSession()}><Plus size={20} /></button>
      </header>

      {drawerOpen && <button type="button" aria-label="Close sessions" className={styles.backdrop} onClick={() => setDrawerOpen(false)} />}
      <aside ref={drawerRef} className={`${styles.sidebar} ${drawerOpen ? styles.sidebarOpen : ""}`} aria-label="Claude projects and sessions" aria-modal={drawerOpen || undefined} role={drawerOpen ? "dialog" : undefined} tabIndex={-1}>
        <div className={styles.sidebarHead}>
          <div className={styles.brand}><span className={styles.claudeMark}>AI</span><div><strong>Claude</strong><span>Code desktop</span></div></div>
          <button type="button" className={styles.iconButton} aria-label="Close sessions" onClick={() => setDrawerOpen(false)}><X size={18} /></button>
        </div>

        <button type="button" className={styles.newTask} onClick={() => data.createSession()}><Plus size={17} />New task</button>

        <nav className={styles.primaryNav} aria-label="Claude workspace">
          <button type="button" data-active={view === "code"} onClick={() => chooseView("code")}><MessageSquare size={17} />Code</button>
          <button type="button" data-active={view === "tasks"} onClick={() => chooseView("tasks")}><ListTodo size={17} />Tasks<span>{data.runs.filter((run) => run.status === "running").length}</span></button>
          <button type="button" data-active={view === "files"} onClick={() => chooseView("files")}><Files size={17} />Files</button>
          <button type="button" data-active={view === "artifacts"} onClick={() => chooseView("artifacts")}><Package size={17} />Artifacts</button>
        </nav>

        <div className={styles.sessionTools}>
          <label className={styles.search}><Search size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleLimit(80); }} placeholder="Search sessions" aria-label="Search sessions" /></label>
          <select value={timeFilter} onChange={(event) => { setTimeFilter(event.target.value as TimeFilter); setVisibleLimit(80); }} aria-label="Filter sessions">
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="week">Last 7 days</option>
            <option value="pinned">Pinned</option>
          </select>
        </div>

        <div className={styles.sessionHeading}><span>Projects</span><span>{filteredTotal} / {data.totalSessions}</span></div>
        <div className={styles.sessionList}>
          <StatusSurface state={data.historyState} error={data.historyError} onRetry={() => void data.loadHistory()} />
          {filteredGroups.map((group) => {
            const expanded = expandedGroups.has(group.id);
            return (
              <section key={group.id} className={styles.projectGroup}>
                <button type="button" className={styles.projectButton} onClick={() => setExpandedGroups((current) => {
                  const next = new Set(current);
                  if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                  return next;
                })}>
                  {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  <Folder size={15} />
                  <span title={group.root}>{group.label}</span>
                  <small>{group.sessions.length}</small>
                </button>
                {expanded && <div className={styles.projectSessions}>
                  {group.sessions.map((session) => {
                    const pinned = data.pins.includes(session.path);
                    return (
                      <div key={session.path} className={styles.sessionRow} data-active={data.activeSession?.path === session.path}>
                        <button type="button" className={styles.sessionMain} onClick={() => chooseSession(session, group)}>
                          <span>{session.name}</span>
                          <small><Clock3 size={12} />{ago(session.mtime)} · {session.resumable === false ? "Read only" : "Resume"}</small>
                        </button>
                        <button type="button" className={styles.pinButton} data-pinned={pinned} aria-label={pinned ? `Unpin ${session.name}` : `Pin ${session.name}`} onClick={() => data.togglePin(session.path)}><Pin size={14} fill={pinned ? "currentColor" : "none"} /></button>
                      </div>
                    );
                  })}
                </div>}
              </section>
            );
          })}
          {filteredTotal > visibleLimit && <button type="button" className={styles.loadMore} onClick={() => setVisibleLimit((limit) => limit + 80)}>Load {Math.min(80, filteredTotal - visibleLimit)} more · {filteredTotal - visibleLimit} remaining</button>}
          {data.historyState === "ready" && filteredTotal === 0 && <div className={styles.noResults}>No sessions match this search.</div>}
        </div>

        <div className={styles.sidebarFoot}>
          <span data-online={data.online && data.runtimeReady === true} />
          <div><strong>{data.runtimeReady === null ? "Checking runtime" : data.runtimeReady ? "Claude connected" : data.online ? "Setup required" : "Offline"}</strong><small>{data.runtimeVersion || data.source || "Local CLI"}</small></div>
          <button type="button" className={styles.iconButton} aria-label="Refresh Claude" onClick={() => void Promise.all([data.loadHistory(), data.loadWorkspace()])}><RefreshCw size={16} /></button>
        </div>
      </aside>

      <main className={styles.main}>
        <div className={styles.titlebar}>
          <div className={styles.contextTitle}>
            <span>{data.activeGroup?.label ?? data.workspaceProject?.name ?? "Claude Code"}</span>
            <ChevronRight size={14} />
            <strong>{data.activeSession?.name ?? (view === "code" ? "New task" : PANE_LABELS[(view === "files" ? "files" : view === "tasks" ? "tasks" : "artifacts")])}</strong>
          </div>
          <div className={styles.contextBadges}>
            <span title="Model is controlled by the Claude CLI"><Bot size={14} />{data.model || "Claude CLI model"}</span>
            <span title="Permissions are enforced by the native Claude runtime"><ShieldCheck size={14} />Runtime permissions</span>
          </div>
        </div>

        {view === "code" ? (
          <>
            <div className={styles.transcriptToolbar}>
              <div role="tablist" aria-label="Transcript mode">
                <button type="button" role="tab" aria-selected={transcriptMode === "conversation"} onClick={() => setTranscriptMode("conversation")}>Conversation</button>
                <button type="button" role="tab" aria-selected={transcriptMode === "activity"} onClick={() => setTranscriptMode("activity")}>Activity</button>
              </div>
              {data.activeSession?.resumable === false && <span className={styles.readOnly}><LockKeyhole size={14} />Read only</span>}
            </div>
            <div ref={transcriptRef} className={styles.transcript} tabIndex={0} aria-label="Claude conversation transcript">
              {!data.activeSession && <div className={styles.welcome}>
                <span className={styles.largeMark}>AI</span>
                <h1>What are we building?</h1>
                <p>Choose a native session, or start a task in one of your Claude projects.</p>
                <button type="button" onClick={() => data.createSession()}><Plus size={17} />Start a Claude Code task</button>
              </div>}
              {data.activeSession && <StatusSurface state={data.transcriptState} error={data.transcriptError} />}
              {data.activeSession && transcriptMode === "conversation" && <div className={styles.turns}>
                {data.messages.map((message, index) => (
                  <article key={`${message.ts}-${index}`} className={styles.message} data-role={message.role} dir={isRtl(message.text) ? "rtl" : "auto"}>
                    <div className={styles.messageMeta}><span>{message.role === "user" ? "You" : "Claude"}</span><time>{new Date(message.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
                    <div className={styles.markdown}><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown></div>
                  </article>
                ))}
                {data.partial && <article className={styles.message} data-role="assistant" dir={isRtl(data.partial) ? "rtl" : "auto"}><div className={styles.messageMeta}><span>Claude</span><span className={styles.streamingDot}>Working</span></div><div className={styles.markdown}><ReactMarkdown remarkPlugins={[remarkGfm]}>{data.partial}</ReactMarkdown></div></article>}
              </div>}
              {data.activeSession && transcriptMode === "activity" && <div className={styles.activityList}>
                <div><CheckCircle2 size={17} /><span>Session loaded</span><time>{ago(data.activeSession.mtime)} ago</time></div>
                {data.messages.map((message, index) => <div key={`${message.ts}-activity-${index}`}><span className={styles.activityIndex}>{index + 1}</span><span>{message.role === "user" ? "Prompt submitted" : "Claude response received"}</span><time>{new Date(message.ts).toLocaleTimeString()}</time></div>)}
                {data.sending && <div><Loader2 className={styles.spin} size={17} /><span>Claude is running</span><time>Live</time></div>}
              </div>}
              {data.sendError && <div className={styles.inlineError} role="alert"><AlertTriangle size={17} /><span>{data.sendError}</span></div>}
            </div>
            <form className={styles.composerWrap} onSubmit={submit}>
              <div className={styles.composer} data-disabled={!data.activeSession || data.activeSession.resumable === false}>
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={composerKeyDown}
                  placeholder={!data.activeSession ? "Start or select a task first" : data.activeSession.resumable === false ? "This native transcript is read only" : "Ask Claude to work in this project…"}
                  disabled={!data.activeSession || data.activeSession.resumable === false || data.sending}
                  rows={2}
                  dir="auto"
                  aria-label="Message Claude"
                />
                <div className={styles.composerFoot}>
                  <span><Code2 size={14} />{data.activeGroup?.root || data.workspaceProject?.root || "Claude-managed working directory"}</span>
                  {data.sending ? <button type="button" className={styles.stopButton} onClick={data.stopRun}><Square size={15} fill="currentColor" />Stop</button> : <button type="submit" className={styles.sendButton} disabled={!input.trim() || !data.activeSession}><Send size={16} />Send</button>}
                </div>
              </div>
              <p>Claude can inspect and change files according to native runtime permissions.</p>
            </form>
          </>
        ) : (
          <div className={styles.workspaceLanding}>
            <div>
              {view === "tasks" ? <ListTodo size={24} /> : view === "files" ? <Files size={24} /> : <Package size={24} />}
              <h1>{view === "tasks" ? "Tasks and subagents" : view === "files" ? "Project files" : "Artifacts"}</h1>
              <p>{view === "tasks" ? "Real Ultracode runs captured by Claude Code." : view === "files" ? "Files from Claude scratch projects, rendered through the local workspace API." : "Publishable and published builds reported by Claude’s artifact service."}</p>
              <button type="button" onClick={() => setPane(view === "tasks" ? "tasks" : view === "files" ? "files" : "artifacts")}><PanelRightClose size={17} />Open {view} pane</button>
            </div>
          </div>
        )}
      </main>

      <aside className={styles.paneRail} aria-label="Claude tools">
        {([
          ["diff", FileDiff],
          ["terminal", Terminal],
          ["browser", Globe2],
          ["files", Files],
          ["tasks", ListTodo],
          ["artifacts", Package],
        ] as const).map(([key, Icon]) => <button type="button" key={key} data-active={pane === key} onClick={(event) => { paneTriggerRef.current = event.currentTarget; setPane((current) => current === key ? null : key); }} aria-label={PANE_LABELS[key]} title={PANE_LABELS[key]}><Icon size={19} /></button>)}
      </aside>

      {pane && <section ref={paneRef} className={styles.pane} aria-label={`${PANE_LABELS[pane]} pane`} role="dialog" aria-modal="true" tabIndex={-1}>
        <div className={styles.paneHeader}><div><span>Claude Code</span><strong>{PANE_LABELS[pane]}</strong></div><button type="button" aria-label="Close pane" onClick={() => setPane(null)}><X size={18} /></button></div>
        <div className={styles.paneBody}>
          {(pane === "diff" || pane === "terminal" || pane === "browser") && <div className={styles.unsupported}>
            {pane === "diff" ? <FileDiff size={24} /> : pane === "terminal" ? <Terminal size={24} /> : <Globe2 size={24} />}
            <h2>{PANE_LABELS[pane]} is not exposed by this runtime</h2>
            <p>Agent OS has no verified {pane} endpoint for this Claude session. No simulated control is shown.</p>
            <span>Unsupported</span>
          </div>}
          {pane === "tasks" && <div className={styles.dataList}>
            <div className={styles.listTitle}><strong>Ultracode runs</strong><button type="button" onClick={() => void data.loadSecondaryData()}><RefreshCw size={15} />Refresh</button></div>
            {data.runs.length === 0 ? <div className={styles.emptyPane}>No captured runs yet.</div> : data.runs.map((run) => <article key={run.id} className={styles.runCard} data-status={run.status}>
              <div><span>{run.status}</span><time>{ago(run.startedAt)}</time></div>
              <strong>{run.headline || run.prompt}</strong>
              <p>{run.prompt}</p>
              <small>{run.subagentCount} subagents{typeof run.costUsd === "number" ? ` · $${run.costUsd.toFixed(3)}` : ""}</small>
            </article>)}
          </div>}
          {pane === "artifacts" && <div className={styles.dataList}>
            <div className={styles.listTitle}><strong>Artifacts</strong>{data.artifacts.site && <a href={data.artifacts.site} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open site</a>}</div>
            <h3>Published · {data.artifacts.published.length}</h3>
            {data.artifacts.published.map((item, index) => <article key={String(item.id ?? item.slug ?? index)} className={styles.simpleCard}><strong>{String(item.title ?? item.name ?? item.slug ?? "Published artifact")}</strong><span>{String(item.status ?? "Published")}</span></article>)}
            {data.artifacts.published.length === 0 && <div className={styles.emptyPane}>No published artifacts.</div>}
            <h3>Ready to publish · {data.artifacts.publishable.length}</h3>
            {data.artifacts.publishable.map((item, index) => <article key={String(item.id ?? item.slug ?? index)} className={styles.simpleCard}><strong>{String(item.title ?? item.name ?? item.id ?? "Artifact")}</strong><span>{String(item.status ?? "Publishable")}</span></article>)}
          </div>}
          {pane === "files" && <div className={styles.filesPane}>
            <div className={styles.listTitle}><select value={data.workspaceProject?.name ?? ""} onChange={(event) => data.selectWorkspaceProject(data.projects.find((project) => project.name === event.target.value) ?? null)} aria-label="Claude project">{data.projects.map((project) => <option key={project.name} value={project.name}>{project.name} · {project.fileCount}</option>)}</select><button type="button" onClick={() => void data.loadWorkspace()}><RefreshCw size={15} />Refresh</button></div>
            <StatusSurface state={data.workspaceState} error={data.workspaceError} onRetry={() => void data.loadWorkspace()} />
            {data.workspaceFiles.length > 0 && <div className={styles.fileGrid}>
              <div className={styles.fileList}>{data.workspaceFiles.map((file) => <button type="button" key={file.relPath} data-active={selectedFile?.relPath === file.relPath} onClick={() => void openFile(file)}><FileIcon file={file} /><span>{file.relPath}</span><small>{fileSize(file.bytes)}</small></button>)}</div>
              <div className={styles.filePreview}>
                {!selectedFile && <div className={styles.emptyPane}>Select a file to preview.</div>}
                {selectedFile && <>
                  <div className={styles.previewHead}><strong>{selectedFile.relPath}</strong>{filePreviewUrl && <a href={filePreviewUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a>}</div>
                  {fileLoading && <div className={styles.emptyPane}><Loader2 className={styles.spin} size={18} />Loading file…</div>}
                  {fileError && <div className={styles.inlineError}><AlertTriangle size={17} />{fileError}</div>}
                  {!fileLoading && !fileError && selectedFile.kind === "text" && <pre dir="auto">{fileText}</pre>}
                  {!fileLoading && selectedFile.kind === "image" && <img src={filePreviewUrl} alt={selectedFile.name} />}
                  {!fileLoading && selectedFile.kind === "video" && <video src={filePreviewUrl} controls />}
                  {!fileLoading && selectedFile.kind === "audio" && <audio src={filePreviewUrl} controls />}
                  {!fileLoading && (selectedFile.kind === "pdf" || selectedFile.kind === "binary") && <a className={styles.downloadLink} href={filePreviewUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />Open file</a>}
                </>}
              </div>
            </div>}
          </div>}
        </div>
      </section>}
    </div>
  );
}

function FileIcon({ file }: { file: ClaudeWorkspaceFile }) {
  if (file.kind === "text") return <Code2 size={15} />;
  if (file.kind === "image" || file.kind === "video") return <Globe2 size={15} />;
  return <Files size={15} />;
}

function useFocusContainment(
  open: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  close: () => void,
  returnRef: React.RefObject<HTMLElement | null>,
  mobileOnly = false,
) {
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    if (!open || (mobileOnly && !window.matchMedia("(max-width: 900px)").matches)) return;
    const container = containerRef.current;
    if (!container) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : returnRef.current;
    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    (focusables()[0] ?? container).focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        container.focus();
        return;
      }
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
      requestAnimationFrame(() => (returnRef.current ?? previouslyFocused)?.focus());
    };
  }, [containerRef, mobileOnly, open, returnRef]);
}
