"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  ChevronLeft,
  ChevronRight,
  Clock,
  Code2,
  FileText,
  FolderOpen,
  Key,
  Languages,
  ListTodo,
  Menu,
  MessageCircle,
  Package,
  Palette,
  PanelRightOpen,
  Pin,
  PinOff,
  Plug,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  ServerCog,
  Settings,
  Shield,
  Smartphone,
  Square,
  Users,
  Wrench,
  X,
} from "lucide-react";
import styles from "./OpenClawOfficialView.module.css";
import { EXECUTION_FROZEN_COPY, isFrozenExecutionPath } from "@/lib/executionAvailability";

type Page = "chat" | "threads" | "groups" | "coding" | "gateway" | "automations" | "activity" | "extensions" | "settings";
type MessageRole = "user" | "assistant" | "system" | "tool";

interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  durationMs?: number;
}

interface SessionRow {
  id: string;
  name: string;
  path: string;
  mtime: number;
  bytes: number;
  nativeId?: string;
  sessionKey?: string;
  preview?: string;
}

interface HistoryGroup {
  id: string;
  label: string;
  root: string;
  scope?: string;
  sessions: SessionRow[];
}

interface Vitals {
  ok: boolean;
  gateway: string;
  degraded: boolean;
  busy?: boolean;
  loopMaxMs?: number;
  loopP99Ms?: number;
  agents: string[];
  sessions: number;
  latencyMs?: number;
}

interface Bucket {
  id: string;
  label: string;
  description: string;
  mtime: number;
  fileCount: number;
  roots: string[];
}

type FileKind = "text" | "image" | "video" | "audio" | "pdf" | "binary";

interface WorkspaceFile {
  name: string;
  relPath: string;
  bytes: number;
  mtime: number;
  isText: boolean;
  kind: FileKind;
}

interface OpenFile {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
  kind: FileKind;
}

const timeAgo = (value: number) => {
  if (!value) return "No activity";
  const delta = Math.max(0, Date.now() - value);
  if (delta < 60_000) return "Just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
};

const fileSize = (value: number) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
};

const id = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const THREAD_PAGE_SIZE = 40;
const THREAD_PINS_KEY = "agentic-os:openclaw:thread-pins:v1";
type UrlHistoryMode = "push" | "replace" | "none";

function writeOpenClawUrl(values: Record<string, string | null | undefined>, mode: UrlHistoryMode = "push") {
  if (mode === "none") return;
  const url = new URL(window.location.href);
  url.searchParams.set("agent", "openclaw");
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (url.href === window.location.href) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"](window.history.state, "", url);
}

export default function OpenClawOfficialView() {
  const [page, setPage] = useState<Page>("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [vitals, setVitals] = useState<Vitals | null>(null);
  const [groups, setGroups] = useState<HistoryGroup[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [activeAgent, setActiveAgent] = useState("main");
  const [activeSession, setActiveSession] = useState<SessionRow | null>(null);
  const [activeRoot, setActiveRoot] = useState<string | undefined>();
  const [threadLoading, setThreadLoading] = useState(false);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [bucket, setBucket] = useState<Bucket | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");
  const [threadPins, setThreadPins] = useState<string[]>([]);
  const [threadLimit, setThreadLimit] = useState(THREAD_PAGE_SIZE);
  const abortRef = useRef<AbortController | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const navigationRef = useRef<HTMLElement | null>(null);
  const threadsRef = useRef<HTMLElement | null>(null);

  const refreshVitals = useCallback(async () => {
    try {
      const response = await fetch("/api/vitals", { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setVitals(data.openclaw ?? null);
    } catch {
      setVitals(null);
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const response = await fetch("/api/agent-history?agent=openclaw", { cache: "no-store" });
      const data = await response.json();
      if (response.ok) {
        const next = Array.isArray(data.groups) ? data.groups : [];
        setGroups(next);
        setActiveAgent((current) => {
          const actors = next.map((group: HistoryGroup) => group.scope ?? group.label);
          return actors.includes(current) ? current : actors[0] ?? current;
        });
      }
    } catch {
      setGroups([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const refreshBuckets = useCallback(async () => {
    setWorkspaceLoading(true);
    try {
      const response = await fetch("/api/openclaw/workspace", { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setBuckets(Array.isArray(data.buckets) ? data.buckets : []);
    } catch {
      setBuckets([]);
    } finally {
      setWorkspaceLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([refreshVitals(), refreshHistory(), refreshBuckets()]);
    const timer = window.setInterval(refreshVitals, 10_000);
    return () => window.clearInterval(timer);
  }, [refreshBuckets, refreshHistory, refreshVitals]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(THREAD_PINS_KEY) ?? "[]");
      if (Array.isArray(stored)) setThreadPins(stored.filter((value): value is string => typeof value === "string"));
    } catch {
      setThreadPins([]);
    }
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  useEffect(() => {
    if ((!navigationOpen && !threadsOpen) || !window.matchMedia("(max-width: 900px)").matches) return;
    const panel = navigationOpen ? navigationRef.current : threadsRef.current;
    if (!panel) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], textarea, select, [tabindex]:not([tabindex="-1"])')];
    window.requestAnimationFrame(() => (focusable()[0] ?? panel).focus());
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobilePanels();
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
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      returnFocus?.focus();
    };
  }, [navigationOpen, threadsOpen]);

  const visibleGroups = useMemo(() => {
    const exact = groups.filter((group) => (group.scope ?? group.label) === activeAgent);
    return exact.length ? exact : groups;
  }, [activeAgent, groups]);

  const sessions = useMemo(() => {
    const query = threadQuery.trim().toLocaleLowerCase();
    return visibleGroups
      .flatMap((group) => group.sessions.map((session) => ({ session, group })))
      .filter(({ session, group }) => !query || [session.name, session.preview, group.label, group.scope, timeAgo(session.mtime)]
        .some((value) => value?.toLocaleLowerCase().includes(query)))
      .sort((a, b) => {
        const aPinned = threadPins.includes(a.session.path);
        const bPinned = threadPins.includes(b.session.path);
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        return b.session.mtime - a.session.mtime;
      });
  }, [threadPins, threadQuery, visibleGroups]);

  const visibleSessions = useMemo(() => sessions.slice(0, threadLimit), [sessions, threadLimit]);

  const agents = useMemo(() => {
    const values = new Set<string>(vitals?.agents ?? []);
    groups.forEach((group) => values.add(group.scope ?? group.label));
    if (!values.size) values.add("main");
    return [...values];
  }, [groups, vitals?.agents]);

  const choosePage = (next: Page, mode: UrlHistoryMode = "push") => {
    setPage(next);
    setNavigationOpen(false);
    if (next === "threads" && window.matchMedia("(max-width: 900px)").matches) setThreadsOpen(true);
    writeOpenClawUrl({ view: next, pane: next === "threads" ? "threads" : null }, mode);
  };

  const unsupported = (label: string) => <span className={styles.unsupported} aria-label={`${label}: Unsupported`}>Unsupported</span>;

  // The private chat route is fail-closed, so no composer is offered here.
  const executionFrozen = isFrozenExecutionPath("/api/openclaw/chat");

  const newThread = () => {
    setActiveSession(null);
    setActiveRoot(visibleGroups[0]?.root);
    setMessages([]);
    setError("");
    setPage("chat");
    setNavigationOpen(false);
    setThreadsOpen(false);
    writeOpenClawUrl({ view: "chat", actor: activeAgent, session: null, pane: null });
  };

  const openThread = async (session: SessionRow, group: HistoryGroup, mode: UrlHistoryMode = "push") => {
    const sessionActor = group.scope ?? group.label;
    setActiveAgent(sessionActor);
    setActiveSession(session);
    setActiveRoot(group.root);
    setThreadLoading(true);
    setError("");
    setPage("chat");
    writeOpenClawUrl({ view: "chat", actor: sessionActor, session: session.sessionKey ?? session.nativeId ?? session.id, pane: null }, mode);
    try {
      const response = await fetch(`/api/agent-history?agent=openclaw&path=${encodeURIComponent(session.path)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Thread could not be opened");
      const turns = Array.isArray(data.detail?.turns) ? data.detail.turns : [];
      setMessages(turns.map((turn: { role?: MessageRole; text?: string }) => ({
        id: id(),
        role: turn.role ?? "assistant",
        text: String(turn.text ?? ""),
      })).filter((message: ChatMessage) => message.text.trim()));
    } catch (cause) {
      setMessages([]);
      setError(cause instanceof Error ? cause.message : "Thread could not be opened");
    } finally {
      setThreadLoading(false);
      setThreadsOpen(false);
    }
  };

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = input.trim();
    if (!prompt || sending) return;
    const prior = messages.filter((message) => message.role === "user" || message.role === "assistant");
    setMessages((current) => [...current, { id: id(), role: "user", text: prompt }]);
    setInput("");
    setError("");
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/openclaw/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          agent: activeAgent,
          projectId: groups.find((group) => group.root === activeRoot)?.id,
          history: prior.slice(-24).map(({ role, text }) => ({ role, text })),
          sessionId: activeSession?.sessionKey ? undefined : activeSession?.nativeId ?? activeSession?.id,
          sessionKey: activeSession?.sessionKey,
        }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error ?? data.stderr ?? "OpenClaw did not return a response");
      setMessages((current) => [...current, {
        id: id(),
        role: "assistant",
        text: String(data.text ?? "(no response)"),
        durationMs: Number(data.durationMs ?? 0),
      }]);
      if (!activeSession && typeof data.sessionId === "string") {
        setActiveSession({ id: data.sessionId, nativeId: data.sessionId, sessionKey: data.sessionKey ?? undefined, name: prompt.slice(0, 80), path: "", mtime: Date.now(), bytes: 0 });
        writeOpenClawUrl({ view: "chat", actor: activeAgent, session: data.sessionKey ?? data.sessionId }, "replace");
      }
      void refreshHistory();
    } catch (cause) {
      if ((cause as Error)?.name !== "AbortError") setError(cause instanceof Error ? cause.message : "OpenClaw request failed");
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  };

  const handleComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const selectBucket = async (next: Bucket, mode: UrlHistoryMode = "push") => {
    setBucket(next);
    setOpenFile(null);
    setWorkspaceLoading(true);
    writeOpenClawUrl({ view: "coding", project: next.id, artifact: null, pane: null }, mode);
    try {
      const response = await fetch(`/api/openclaw/workspace?bucket=${encodeURIComponent(next.id)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Bucket could not be opened");
      setFiles(Array.isArray(data.files) ? data.files : []);
    } catch (cause) {
      setFiles([]);
      setError(cause instanceof Error ? cause.message : "Bucket could not be opened");
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const loadFile = async (file: WorkspaceFile, mode: UrlHistoryMode = "push") => {
    if (!bucket) return;
    writeOpenClawUrl({ view: "coding", project: bucket.id, artifact: file.relPath, pane: "artifact" }, mode);
    if (file.kind !== "text") {
      setOpenFile({ path: file.relPath, content: "", bytes: file.bytes, truncated: false, kind: file.kind });
      return;
    }
    try {
      const response = await fetch(`/api/openclaw/workspace/file?bucket=${encodeURIComponent(bucket.id)}&path=${encodeURIComponent(file.relPath)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "File could not be opened");
      setOpenFile({ path: file.relPath, content: String(data.content ?? ""), bytes: Number(data.bytes ?? file.bytes), truncated: Boolean(data.truncated), kind: "text" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "File could not be opened");
    }
  };

  const previewUrl = (path: string) => {
    if (!bucket) return "";
    const segments = path.split(/[\\/]/).map(encodeURIComponent).join("/");
    return `/api/openclaw/preview/${encodeURIComponent(bucket.id)}/${segments}`;
  };

  const closeMobilePanels = () => {
    setNavigationOpen(false);
    setThreadsOpen(false);
    writeOpenClawUrl({ pane: openFile ? "artifact" : null }, "replace");
  };

  const toggleThreadPin = (path: string) => {
    setThreadPins((current) => {
      const next = current.includes(path) ? current.filter((item) => item !== path) : [path, ...current];
      try { localStorage.setItem(THREAD_PINS_KEY, JSON.stringify(next)); } catch { /* local metadata is optional */ }
      return next;
    });
  };

  useEffect(() => {
    const hydrate = () => {
      const params = new URLSearchParams(window.location.search);
      const requestedView = params.get("view");
      const nextPage: Page = requestedView === "threads" || requestedView === "groups" || requestedView === "coding" || requestedView === "gateway" || requestedView === "automations" || requestedView === "activity" || requestedView === "extensions" || requestedView === "settings" ? requestedView : "chat";
      setPage(nextPage);

      const requestedActor = params.get("actor");
      if (requestedActor) setActiveAgent(requestedActor);

      const pane = params.get("pane");
      setNavigationOpen(pane === "navigation");
      setThreadsOpen(pane === "threads");

      const requestedSession = params.get("session");
      if (!requestedSession) {
        if (activeSession) { setActiveSession(null); setMessages([]); }
      } else {
        const currentToken = activeSession?.sessionKey ?? activeSession?.nativeId ?? activeSession?.id;
        if (currentToken !== requestedSession) {
          const match = groups.flatMap((group) => group.sessions.map((session) => ({ group, session })))
            .find(({ session }) => [session.sessionKey, session.nativeId, session.id].includes(requestedSession));
          if (match) void openThread(match.session, match.group, "none");
        }
      }

      const requestedProject = params.get("project");
      if (!requestedProject) {
        if (bucket) { setBucket(null); setFiles([]); setOpenFile(null); }
      } else if (bucket?.id !== requestedProject) {
        const match = buckets.find((item) => item.id === requestedProject);
        if (match) void selectBucket(match, "none");
      }

      const requestedArtifact = params.get("artifact");
      if (!requestedArtifact) {
        if (openFile) setOpenFile(null);
      } else if (openFile?.path !== requestedArtifact) {
        const match = files.find((file) => file.relPath === requestedArtifact);
        if (match) void loadFile(match, "none");
      }

      if (!params.get("agent") || !params.get("view")) writeOpenClawUrl({ view: nextPage, actor: requestedActor ?? activeAgent }, "replace");
    };
    hydrate();
    window.addEventListener("popstate", hydrate);
    return () => window.removeEventListener("popstate", hydrate);
  }, [activeAgent, activeSession, bucket, buckets, files, groups, openFile]);

  return (
    <div className={styles.app} data-agent-page="openclaw" data-active-tab={page}>
      <header className={styles.mobileHeader}>
        <button type="button" onClick={() => { setNavigationOpen(true); writeOpenClawUrl({ pane: "navigation" }); }} aria-label="Open OpenClaw navigation"><Menu size={20} /></button>
        <div className={styles.mobileIdentity}><span className={styles.logo}>OC</span><strong>OpenClaw</strong></div>
        <button type="button" onClick={() => { setThreadsOpen(true); writeOpenClawUrl({ pane: "threads" }); }} aria-label="Open threads"><PanelRightOpen size={20} /></button>
      </header>

      {(navigationOpen || threadsOpen) && <button type="button" className={styles.backdrop} onClick={closeMobilePanels} aria-label="Close mobile panels" />}

      <aside ref={navigationRef} tabIndex={-1} className={`${styles.navigation} ${navigationOpen ? styles.sheetOpen : ""}`} aria-label="OpenClaw navigation">
        <div className={styles.identityRow}>
          <div className={styles.logo}>OC</div>
          <div className={styles.identityCopy}><strong>OpenClaw</strong><span>Local control UI</span></div>
          <button type="button" className={styles.mobileClose} onClick={closeMobilePanels} aria-label="Close navigation"><X size={18} /></button>
        </div>

        <button type="button" className={styles.newThread} onClick={newThread}><Plus size={18} /> New thread</button>

        <nav className={styles.navGroups}>
          <section>
            <p>Pages</p>
            <button type="button" className={page === "chat" ? styles.activeNav : ""} onClick={() => choosePage("chat")}><MessageCircle size={17} /> Chat</button>
            <button type="button" className={page === "coding" ? styles.activeNav : ""} onClick={() => choosePage("coding")}><Code2 size={17} /> Coding</button>
            <button type="button" className={page === "gateway" ? styles.activeNav : ""} onClick={() => choosePage("gateway")}><ServerCog size={17} /> Gateway</button>
          </section>
          <section>
            <p>Workspace</p>
            <button type="button" className={page === "threads" ? styles.activeNav : ""} onClick={() => choosePage("threads")} aria-label="Conversations for selected actor"><MessageCircle size={17} /> Conversations <span>{sessions.length}</span></button>
            <button type="button" className={page === "groups" ? styles.activeNav : ""} onClick={() => choosePage("groups")} aria-label="Actors"><Users size={17} /> Actors <span>{agents.length}</span></button>
          </section>
          <section>
            <p>Operate</p>
            <button type="button" className={page === "automations" ? styles.activeNav : ""} onClick={() => choosePage("automations")}><Clock size={17} /> Automations</button>
            <button type="button" className={page === "activity" ? styles.activeNav : ""} onClick={() => choosePage("activity")}><Activity size={17} /> Activity</button>
            <button type="button" className={page === "extensions" ? styles.activeNav : ""} onClick={() => choosePage("extensions")}><Package size={17} /> Extensions</button>
            <button type="button" className={page === "settings" ? styles.activeNav : ""} onClick={() => choosePage("settings")}><Settings size={17} /> Settings</button>
          </section>
        </nav>

        <button type="button" className={styles.gatewayBadge} onClick={() => choosePage("gateway")}>
          <span className={`${styles.statusDot} ${vitals?.ok ? styles.online : styles.offline}`} />
          <span><strong>{vitals?.ok ? "Gateway online" : "Gateway unavailable"}</strong><small>{vitals?.busy ? "Busy" : vitals?.degraded ? "Degraded" : vitals?.gateway ?? "Checking"}</small></span>
        </button>
      </aside>

      <aside ref={threadsRef} tabIndex={-1} className={`${styles.threadRail} ${threadsOpen ? styles.sheetOpen : ""}`} aria-label="OpenClaw actor conversations">
        <div className={styles.railHeader}>
          <div><strong>Conversations</strong><span>{activeAgent}</span></div>
          <button type="button" onClick={() => void refreshHistory()} aria-label="Refresh conversations"><RefreshCw size={17} className={historyLoading ? styles.spinning : ""} /></button>
          <button type="button" className={styles.mobileClose} onClick={closeMobilePanels} aria-label="Close conversations"><X size={18} /></button>
        </div>
        <label className={styles.threadSearch}>
          <Search size={15} aria-hidden="true" />
          <span className={styles.srOnly}>Search conversations</span>
          <input value={threadQuery} onChange={(event) => { setThreadQuery(event.target.value); setThreadLimit(THREAD_PAGE_SIZE); }} placeholder="Search title, preview, actor or time" aria-label="Search OpenClaw conversations" />
        </label>
        <div className={styles.threadList}>
          {historyLoading && sessions.length === 0 && <p className={styles.emptyRail}>Loading conversations…</p>}
          {!historyLoading && sessions.length === 0 && <p className={styles.emptyRail}>No local conversations for this actor.</p>}
          {visibleSessions.map(({ session, group }) => (
            <article key={`${group.id}-${session.path}`} className={`${styles.threadRow} ${activeSession?.path && activeSession.path === session.path ? styles.activeThread : ""}`}>
              <button type="button" className={styles.threadOpen} onClick={() => void openThread(session, group)}>
                <span>{session.name}</span>
                <small>{timeAgo(session.mtime)} · {group.label}</small>
                {session.preview && <em dir="auto">{session.preview}</em>}
              </button>
              <button type="button" className={styles.pinButton} data-pinned={threadPins.includes(session.path)} aria-label={threadPins.includes(session.path) ? `Unpin ${session.name}` : `Pin ${session.name}`} title={threadPins.includes(session.path) ? "Unpin thread" : "Pin thread locally"} onClick={() => toggleThreadPin(session.path)}>
                {threadPins.includes(session.path) ? <PinOff size={14} /> : <Pin size={14} />}
              </button>
            </article>
          ))}
          {visibleSessions.length < sessions.length && <button type="button" className={styles.loadMore} onClick={() => setThreadLimit((current) => current + THREAD_PAGE_SIZE)}>Load {Math.min(THREAD_PAGE_SIZE, sessions.length - visibleSessions.length)} more</button>}
          {!historyLoading && sessions.length === 0 && threadQuery && <p className={styles.emptyRail}>No conversations match “{threadQuery}”.</p>}
        </div>
      </aside>

      <main className={styles.main}>
        {page === "chat" || page === "threads" ? (
          <section className={styles.chatPage} aria-label="OpenClaw conversation">
            <div className={styles.chatHeader}>
              <div>
                <span className={styles.eyebrow}>{activeAgent}</span>
                <h1 dir="auto">{activeSession?.name ?? "New thread"}</h1>
              </div>
              <button type="button" className={styles.threadToggle} onClick={() => setThreadsOpen(true)} aria-label="Open conversations"><MessageCircle size={17} /> Conversations</button>
            </div>

            <div className={styles.messages} aria-live="polite">
              {threadLoading && <div className={styles.centerState}><RefreshCw size={22} className={styles.spinning} /> Opening thread</div>}
              {!threadLoading && messages.length === 0 && (
                <div className={styles.welcome}>
                  <div className={styles.welcomeMark}><Bot size={28} /></div>
                  <h2>What should OpenClaw handle?</h2>
                  <p>Start a focused thread. Agent, workspace and prior context stay visible without leaving this screen.</p>
                </div>
              )}
              {!threadLoading && messages.map((message) => (
                <article key={message.id} className={`${styles.message} ${styles[message.role]}`}>
                  <div className={styles.messageAvatar}>{message.role === "user" ? "You" : message.role === "assistant" ? "OC" : message.role.slice(0, 1).toUpperCase()}</div>
                  <div className={styles.messageBody}>
                    <div className={styles.messageMeta}><strong>{message.role === "user" ? "You" : message.role === "assistant" ? "OpenClaw" : message.role}</strong>{message.durationMs ? <span>{(message.durationMs / 1000).toFixed(1)}s</span> : null}</div>
                    <div className={styles.messageText} dir="auto">{message.text}</div>
                  </div>
                </article>
              ))}
              {sending && <article className={`${styles.message} ${styles.assistant}`}><div className={styles.messageAvatar}>OC</div><div className={styles.messageBody}><div className={styles.messageMeta}><strong>OpenClaw</strong><span>Running</span></div><div className={styles.runCard}><span className={styles.pulse} /> Agent is working in {activeRoot ?? "the default workspace"}</div></div></article>}
              <div ref={messageEndRef} />
            </div>

            {executionFrozen ? (
              <div className={styles.operatorNotice} aria-label="OpenClaw send unavailable">
                <Square size={20} />
                <div><strong>Sending from AGENT-OS is disabled</strong><p>{EXECUTION_FROZEN_COPY.body} OpenClaw lifecycle parity is a later wave of the repair; until it lands, use the OpenClaw CLI directly and read its history here.</p></div>
                {unsupported("Send")}
              </div>
            ) : (
              <form className={styles.composer} onSubmit={sendMessage}>
                {error && <div className={styles.error} role="alert">{error}</div>}
                <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleComposerKey} placeholder={`Message ${activeAgent}`} aria-label={`Message ${activeAgent}`} rows={3} />
                <div className={styles.composerBar}>
                  <span>{activeRoot ? activeRoot.split(/[\\/]/).filter(Boolean).pop() : "Default workspace"}</span>
                  {sending ? (
                    <button type="button" className={styles.stopButton} onClick={() => abortRef.current?.abort()}><Square size={15} /> Stop</button>
                  ) : (
                    <button type="submit" className={styles.sendButton} disabled={!input.trim()}><Send size={16} /> Send</button>
                  )}
                </div>
              </form>
            )}
          </section>
        ) : null}

        {page === "groups" && (
          <section className={styles.contentPage} tabIndex={0}>
            <div className={styles.pageHeading}><div><span className={styles.eyebrow}>OpenClaw workspace</span><h1>Actors</h1><p>Each local actor keeps its own conversation list and workspace context.</p></div><Users size={28} /></div>
            <div className={styles.groupGrid}>
              {agents.map((agent) => {
                const group = groups.find((item) => (item.scope ?? item.label) === agent);
                const count = group?.sessions.length ?? 0;
                return <button type="button" key={agent} className={activeAgent === agent ? styles.activeGroup : ""} onClick={() => { setActiveAgent(agent); setPage("chat"); setActiveSession(null); setMessages([]); writeOpenClawUrl({ view: "chat", actor: agent, session: null }); }}>
                  <span className={styles.agentAvatar}>{agent.slice(0, 2).toUpperCase()}</span>
                  <span><strong>{agent}</strong><small>{count} conversation{count === 1 ? "" : "s"}</small></span>
                  <ChevronRight size={18} />
                </button>;
              })}
            </div>
          </section>
        )}

        {page === "gateway" && (
          <section className={styles.contentPage} tabIndex={0}>
            <div className={styles.pageHeading}><div><span className={styles.eyebrow}>Local runtime</span><h1>Gateway</h1><p>Live health from the installed OpenClaw gateway.</p></div><button type="button" className={styles.secondaryButton} onClick={() => void refreshVitals()}><RefreshCw size={16} /> Refresh</button></div>
            <div className={styles.metricGrid}>
              <article><span>Status</span><strong>{vitals?.ok ? "Online" : "Unavailable"}</strong><small>{vitals?.busy ? "Busy" : vitals?.degraded ? "Degraded" : vitals?.gateway ?? "Checking"}</small></article>
              <article><span>Agents</span><strong>{vitals?.agents.length ?? "—"}</strong><small>{vitals?.agents.join(", ") || "No agents reported"}</small></article>
              <article><span>Sessions</span><strong>{vitals?.sessions ?? "—"}</strong><small>Native OpenClaw sessions</small></article>
              <article><span>Loop p99</span><strong>{vitals?.loopP99Ms ?? "—"}<i>{typeof vitals?.loopP99Ms === "number" ? " ms" : ""}</i></strong><small>Max {vitals?.loopMaxMs ?? "—"} ms</small></article>
            </div>
          </section>
        )}

        {page === "automations" && (
          <section className={styles.contentPage} tabIndex={0}>
            <div className={styles.pageHeading}><div><span className={styles.eyebrow}>OpenClaw scheduler</span><h1>Automations</h1><p>Scheduled work belongs here when the local gateway exposes a task ledger.</p></div><Clock size={28} /></div>
            <div className={styles.operatorNotice}><ListTodo size={20} /><div><strong>No automation bridge detected</strong><p>Agentic OS will not invent schedules or mutate OpenClaw configuration. Native task discovery and controls stay unavailable until a real backend exists.</p></div>{unsupported("Automation task ledger")}</div>
            <div className={styles.operatorGrid}>
              <article><div className={styles.operatorIcon}><Clock size={18} /></div><div><strong>Scheduled tasks</strong><p>Recurring prompts, cron expressions and next-run state.</p></div>{unsupported("Scheduled tasks")}</article>
              <article><div className={styles.operatorIcon}><Activity size={18} /></div><div><strong>Run history</strong><p>Per-task execution result, duration and failure trace.</p></div>{unsupported("Automation run history")}</article>
              <article><div className={styles.operatorIcon}><Shield size={18} /></div><div><strong>Approval policy</strong><p>Explicit approval rules for unattended actions.</p></div>{unsupported("Automation approvals")}</article>
            </div>
          </section>
        )}

        {page === "activity" && (
          <section className={styles.contentPage} tabIndex={0}>
            <div className={styles.pageHeading}><div><span className={styles.eyebrow}>Local evidence</span><h1>Activity</h1><p>Read-only activity derived from native OpenClaw threads already visible to this app.</p></div><Activity size={28} /></div>
            <div className={styles.activityLedger}>
              {sessions.slice(0, 24).map(({ session, group }) => <article key={`${group.id}-${session.path}`}><span className={styles.ledgerDot} /><div><strong dir="auto">{session.name}</strong><p dir="auto">{session.preview || `Thread in ${group.label}`}</p></div><time>{timeAgo(session.mtime)}</time></article>)}
              {!historyLoading && sessions.length === 0 && <div className={styles.operatorNotice}><Activity size={20} /><div><strong>No activity reported</strong><p>Native OpenClaw threads will appear here when available.</p></div></div>}
            </div>
          </section>
        )}

        {page === "extensions" && (
          <section className={styles.contentPage} tabIndex={0}>
            <div className={styles.pageHeading}><div><span className={styles.eyebrow}>Runtime capabilities</span><h1>Extensions</h1><p>Provider-native inventory for OpenClaw integrations. Missing bridges are shown honestly.</p></div><Package size={28} /></div>
            <div className={styles.operatorGrid}>
              <article><div className={styles.operatorIcon}><Package size={18} /></div><div><strong>Plugins</strong><p>Installed extension packages and runtime state.</p></div>{unsupported("Plugins")}</article>
              <article><div className={styles.operatorIcon}><Wrench size={18} /></div><div><strong>Skills</strong><p>Available skills, sources and activation policy.</p></div>{unsupported("Skills")}</article>
              <article><div className={styles.operatorIcon}><Plug size={18} /></div><div><strong>MCP servers</strong><p>Connected tool servers and health checks.</p></div>{unsupported("MCP servers")}</article>
              <article><div className={styles.operatorIcon}><Radio size={18} /></div><div><strong>Channels</strong><p>Messaging channels, identities and delivery health.</p></div>{unsupported("Channels")}</article>
            </div>
          </section>
        )}

        {page === "settings" && (
          <section className={styles.contentPage} tabIndex={0}>
            <div className={styles.pageHeading}><div><span className={styles.eyebrow}>Operator settings</span><h1>Settings</h1><p>Connection and policy state from the local runtime. Unsupported controls remain inactive.</p></div><Settings size={28} /></div>
            <div className={styles.settingsStack}>
              <section><div className={styles.settingsHeading}><ServerCog size={19} /><div><strong>Connection</strong><p>Local gateway status and active actor inventory.</p></div><span className={`${styles.supported} ${!vitals?.ok ? styles.degradedStatus : ""}`}>{vitals?.ok ? "Connected" : "Unavailable"}</span></div><dl><div><dt>Gateway</dt><dd>{vitals?.gateway ?? "Not reported"}</dd></div><div><dt>Actors</dt><dd>{agents.join(", ") || "None"}</dd></div></dl></section>
              <section><div className={styles.settingsHeading}><Smartphone size={19} /><div><strong>Devices and pairing</strong><p>Trusted devices, pairing codes and revocation.</p></div>{unsupported("Device pairing")}</div></section>
              <section><div className={styles.settingsHeading}><Shield size={19} /><div><strong>Approvals</strong><p>Action confirmation and unattended-run policy.</p></div>{unsupported("Approval settings")}</div></section>
              <section><div className={styles.settingsHeading}><Key size={19} /><div><strong>Secrets</strong><p>Credential inventory without exposing secret values.</p></div>{unsupported("Secret management")}</div></section>
              <section><div className={styles.settingsHeading}><Palette size={19} /><div><strong>Appearance</strong><p>Theme follows Agentic OS. OpenClaw-specific appearance bridge not detected.</p></div>{unsupported("Appearance settings")}</div></section>
              <section><div className={styles.settingsHeading}><Languages size={19} /><div><strong>Language</strong><p>Interface language is currently English.</p></div>{unsupported("Language settings")}</div></section>
            </div>
          </section>
        )}

        {page === "coding" && (
          <section className={styles.codingPage}>
            <div className={styles.codingHeader}><div><span className={styles.eyebrow}>Coding workspace</span><h1>{bucket?.label ?? "Choose a workspace"}</h1></div><button type="button" className={styles.secondaryButton} onClick={() => void refreshBuckets()}><RefreshCw size={16} /> Refresh</button></div>
            <div className={styles.codingGrid}>
              <aside className={styles.bucketList}>
                {buckets.map((item) => <button type="button" key={item.id} className={bucket?.id === item.id ? styles.activeBucket : ""} onClick={() => void selectBucket(item)}><FolderOpen size={17} /><span><strong>{item.label}</strong><small>{item.fileCount} files · {timeAgo(item.mtime)}</small></span></button>)}
                {!workspaceLoading && buckets.length === 0 && <p>No OpenClaw workspaces found.</p>}
              </aside>
              <div className={styles.fileList}>
                {workspaceLoading && <div className={styles.centerState}><RefreshCw size={22} className={styles.spinning} /> Loading workspace</div>}
                {!workspaceLoading && bucket && files.length === 0 && <div className={styles.centerState}>This workspace has no files.</div>}
                {!workspaceLoading && !bucket && <div className={styles.centerState}>Choose a workspace from the left.</div>}
                {!workspaceLoading && files.map((file) => <button type="button" key={file.relPath} className={openFile?.path === file.relPath ? styles.activeFile : ""} onClick={() => void loadFile(file)}><FileText size={17} /><span><strong>{file.relPath}</strong><small>{file.kind} · {fileSize(file.bytes)} · {timeAgo(file.mtime)}</small></span><ChevronRight size={17} /></button>)}
              </div>
              {openFile && <aside className={styles.previewPane}>
                <div className={styles.previewHeader}><div><strong>{openFile.path}</strong><small>{fileSize(openFile.bytes)}{openFile.truncated ? " · Preview truncated" : ""}</small></div><button type="button" onClick={() => { setOpenFile(null); writeOpenClawUrl({ artifact: null, pane: null }); }} aria-label="Close preview"><X size={18} /></button></div>
                <div className={styles.previewBody}>
                  {openFile.kind === "text" && <pre dir="auto">{openFile.content}</pre>}
                  {openFile.kind === "image" && <img src={previewUrl(openFile.path)} alt={openFile.path} />}
                  {openFile.kind === "video" && <video src={previewUrl(openFile.path)} controls />}
                  {openFile.kind === "audio" && <audio src={previewUrl(openFile.path)} controls />}
                  {openFile.kind === "pdf" && <iframe src={previewUrl(openFile.path)} title={openFile.path} />}
                  {openFile.kind === "binary" && <a href={previewUrl(openFile.path)} download>Download binary file</a>}
                </div>
              </aside>}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
