"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Blocks,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Code2,
  Download,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Menu,
  Network,
  PanelRightOpen,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Square,
  Webhook,
  X,
} from "lucide-react";
import styles from "./AntigravityOfficialView.module.css";

interface Project {
  name: string;
  root?: string;
  mtime: number;
  fileCount: number;
  kind: "scratch" | "brain";
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

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  durationMs?: number;
}

interface AntigravityVitals {
  ok: boolean;
  version: string;
  latencyMs?: number;
}

const MODELS = ["Gemini 3.6 Flash (High)", "Gemini 3.1 Pro (High)"];
const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const PROJECT_PAGE_SIZE = 36;
const PROJECT_PINS_KEY = "agentic-os:antigravity:project-pins:v1";
type UrlHistoryMode = "push" | "replace" | "none";
type WorkspaceView = "agent" | "subagents" | "tasks" | "capabilities";

function writeAntigravityUrl(values: Record<string, string | null | undefined>, mode: UrlHistoryMode = "push") {
  if (mode === "none") return;
  const url = new URL(window.location.href);
  url.searchParams.set("agent", "antigravity");
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (url.href === window.location.href) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"](window.history.state, "", url);
}

const timeAgo = (value: number) => {
  if (!value) return "No activity";
  const delta = Math.max(0, Date.now() - value);
  if (delta < 60_000) return "Just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
};

const fileSize = (value: number) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
};

const compactPath = (value?: string) => (value ?? "")
  .replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~")
  .replace(/^[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+(?=[\\/]|$)/i, "~");

const isPlanFile = (file: WorkspaceFile) => /(?:implementation|project|task)[-_ ]?plan|plan\.md$/i.test(file.relPath);

export default function AntigravityOfficialView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(MODELS[0]);
  const [sending, setSending] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [error, setError] = useState("");
  const [vitals, setVitals] = useState<AntigravityVitals | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [htmlMode, setHtmlMode] = useState<"preview" | "source">("preview");
  const [projectQuery, setProjectQuery] = useState("");
  const [projectPins, setProjectPins] = useState<string[]>([]);
  const [projectLimit, setProjectLimit] = useState(PROJECT_PAGE_SIZE);
  const [view, setView] = useState<WorkspaceView>("agent");
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const projectsRef = useRef<HTMLElement | null>(null);
  const artifactsRef = useRef<HTMLElement | null>(null);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const response = await fetch("/api/antigravity/workspace", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Projects could not be loaded");
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Projects could not be loaded");
      setProjects([]);
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  const loadVitals = useCallback(async () => {
    try {
      const response = await fetch("/api/vitals", { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setVitals(data.antigravity ?? null);
    } catch {
      setVitals(null);
    }
  }, []);

  const selectProject = useCallback(async (project: Project, mode: UrlHistoryMode = "push") => {
    setSelectedProject(project);
    setOpenFile(null);
    setLoadingFiles(true);
    setError("");
    writeAntigravityUrl({ view: "agent", project: project.kind === "scratch" ? project.name : null, session: project.kind === "brain" ? project.name : null, kind: project.kind, artifact: null, pane: null }, mode);
    try {
      const response = await fetch(`/api/antigravity/workspace?kind=${project.kind}&project=${encodeURIComponent(project.name)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Project could not be opened");
      setFiles(Array.isArray(data.files) ? data.files : []);
    } catch (cause) {
      setFiles([]);
      setError(cause instanceof Error ? cause.message : "Project could not be opened");
    } finally {
      setLoadingFiles(false);
      setProjectsOpen(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([loadProjects(), loadVitals()]);
  }, [loadProjects, loadVitals]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(PROJECT_PINS_KEY) ?? "[]");
      if (Array.isArray(stored)) setProjectPins(stored.filter((value): value is string => typeof value === "string"));
    } catch {
      setProjectPins([]);
    }
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  useEffect(() => {
    if ((!projectsOpen && !artifactsOpen) || !window.matchMedia("(max-width: 980px)").matches) return;
    const panel = projectsOpen ? projectsRef.current : artifactsRef.current;
    if (!panel) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], textarea, select, [tabindex]:not([tabindex="-1"])')];
    window.requestAnimationFrame(() => (focusable()[0] ?? panel).focus());
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanels();
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
  }, [artifactsOpen, projectsOpen]);

  const filteredProjects = useMemo(() => {
    const query = projectQuery.trim().toLocaleLowerCase();
    return projects
      .filter((project) => !query || [project.name, compactPath(project.root), project.kind, timeAgo(project.mtime), `${project.fileCount} artifacts`]
        .some((value) => value.toLocaleLowerCase().includes(query)))
      .sort((a, b) => {
        const aPinned = projectPins.includes(a.root ?? a.name);
        const bPinned = projectPins.includes(b.root ?? b.name);
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        return b.mtime - a.mtime;
      });
  }, [projectPins, projectQuery, projects]);

  const visibleProjects = useMemo(() => filteredProjects.slice(0, projectLimit), [filteredProjects, projectLimit]);

  const projectGroups = useMemo(() => ({
    scratch: visibleProjects.filter((project) => project.kind === "scratch"),
    brain: visibleProjects.filter((project) => project.kind === "brain"),
  }), [visibleProjects]);

  const planFiles = useMemo(() => files.filter(isPlanFile), [files]);

  const rawUrl = (path: string) => {
    if (!selectedProject) return "";
    return `/api/antigravity/workspace/raw?kind=${selectedProject.kind}&project=${encodeURIComponent(selectedProject.name)}&path=${encodeURIComponent(path)}`;
  };

  const previewUrl = (path: string) => {
    if (!selectedProject) return "";
    const segments = path.split(/[\\/]/).map(encodeURIComponent).join("/");
    return `/api/antigravity/preview/${selectedProject.kind}/${encodeURIComponent(selectedProject.name)}/${segments}`;
  };

  const loadFile = async (file: WorkspaceFile, mode: UrlHistoryMode = "push") => {
    if (!selectedProject) return;
    setHtmlMode("preview");
    writeAntigravityUrl({ view: "artifact", artifact: file.relPath, pane: "artifacts" }, mode);
    if (file.kind !== "text") {
      setOpenFile({ path: file.relPath, content: "", bytes: file.bytes, truncated: false, kind: file.kind });
      setArtifactsOpen(true);
      return;
    }
    try {
      const response = await fetch(`/api/antigravity/workspace/file?kind=${selectedProject.kind}&project=${encodeURIComponent(selectedProject.name)}&path=${encodeURIComponent(file.relPath)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Artifact could not be opened");
      setOpenFile({ path: file.relPath, content: String(data.content ?? ""), bytes: Number(data.bytes ?? file.bytes), truncated: Boolean(data.truncated), kind: "text" });
      setArtifactsOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Artifact could not be opened");
    }
  };

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = input.trim();
    if (!prompt || sending) return;
    const previous = messages;
    setMessages((current) => [...current, { id: makeId(), role: "user", text: prompt }]);
    setInput("");
    setError("");
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const watchdog = window.setTimeout(() => controller.abort(), 5.5 * 60 * 1000);
    try {
      const response = await fetch("/api/antigravity/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          model,
          cwd: selectedProject?.root,
          history: previous.slice(-24).map(({ role, text }) => ({ role, text })),
        }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error ?? data.text ?? data.stderr ?? "Antigravity did not return a response");
      setMessages((current) => [...current, { id: makeId(), role: "assistant", text: String(data.text ?? "(no response)"), durationMs: Number(data.durationMs ?? 0) }]);
      void loadProjects();
      if (selectedProject) void selectProject(selectedProject);
    } catch (cause) {
      if ((cause as Error)?.name !== "AbortError") setError(cause instanceof Error ? cause.message : "Antigravity request failed");
    } finally {
      window.clearTimeout(watchdog);
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

  const closePanels = () => {
    setProjectsOpen(false);
    setArtifactsOpen(false);
    writeAntigravityUrl({ pane: openFile ? "artifacts" : null }, "replace");
  };

  const chooseView = (next: WorkspaceView, mode: UrlHistoryMode = "push") => {
    setView(next);
    setOpenFile(null);
    setArtifactsOpen(false);
    writeAntigravityUrl({ view: next, artifact: null, pane: null }, mode);
  };

  const unsupported = (label: string) => <span className={styles.unsupported} aria-label={`${label}: Unsupported`}>Unsupported</span>;

  const toggleProjectPin = (root: string) => {
    setProjectPins((current) => {
      const next = current.includes(root) ? current.filter((item) => item !== root) : [root, ...current];
      try { localStorage.setItem(PROJECT_PINS_KEY, JSON.stringify(next)); } catch { /* local metadata is optional */ }
      return next;
    });
  };

  useEffect(() => {
    const hydrate = () => {
      const params = new URLSearchParams(window.location.search);
      const requestedProject = params.get("project");
      const requestedSession = params.get("session");
      const requestedKind = params.get("kind");
      const requestedView = params.get("view");
      const requestedName = requestedKind === "brain" ? requestedSession : requestedProject;
      const desired = requestedName
        ? projects.find((project) => project.name === requestedName && project.kind === (requestedKind === "brain" ? "brain" : "scratch"))
        : projects[0];
      if (desired && (selectedProject?.name !== desired.name || selectedProject.kind !== desired.kind)) {
        void selectProject(desired, "none");
      }

      const pane = params.get("pane");
      setProjectsOpen(pane === "projects");
      setArtifactsOpen(pane === "artifacts");

      const requestedArtifact = params.get("artifact");
      if (!requestedArtifact) {
        if (openFile) setOpenFile(null);
      } else if (openFile?.path !== requestedArtifact) {
        const match = files.find((file) => file.relPath === requestedArtifact);
        if (match) void loadFile(match, "none");
      }

      if (!requestedArtifact && (requestedView === "agent" || requestedView === "subagents" || requestedView === "tasks" || requestedView === "capabilities")) setView(requestedView);

      if (!params.get("agent") || !params.get("view") || (!requestedName && desired)) writeAntigravityUrl({
        view: requestedArtifact ? "artifact" : requestedView === "subagents" || requestedView === "tasks" || requestedView === "capabilities" ? requestedView : "agent",
        project: desired?.kind === "scratch" ? desired.name : null,
        session: desired?.kind === "brain" ? desired.name : null,
        kind: desired?.kind,
      }, "replace");
    };
    hydrate();
    window.addEventListener("popstate", hydrate);
    return () => window.removeEventListener("popstate", hydrate);
  }, [files, openFile, projects, selectProject, selectedProject]);

  const projectList = (kind: "scratch" | "brain", label: string) => (
    <section className={styles.projectGroup}>
      <div className={styles.projectGroupLabel}><span>{label}</span><small>{projectGroups[kind].length}</small></div>
      {projectGroups[kind].map((project) => (
        <article key={`${project.kind}-${project.root}`} className={`${styles.projectRow} ${selectedProject?.root === project.root ? styles.activeProject : ""}`}>
          <button type="button" className={styles.projectOpen} onClick={() => void selectProject(project)}>
            <Folder size={17} />
            <span><strong dir="auto">{project.name}</strong><small>{project.fileCount} artifacts · {timeAgo(project.mtime)}</small></span>
            <ChevronRight size={16} />
          </button>
          <button type="button" className={styles.pinButton} data-pinned={projectPins.includes(project.root ?? project.name)} aria-label={projectPins.includes(project.root ?? project.name) ? `Unpin ${project.name}` : `Pin ${project.name}`} title={projectPins.includes(project.root ?? project.name) ? "Unpin project" : "Pin project locally"} onClick={() => toggleProjectPin(project.root ?? project.name)}>
            {projectPins.includes(project.root ?? project.name) ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        </article>
      ))}
    </section>
  );

  return (
    <div className={styles.app} data-agent-page="antigravity" data-active-tab={openFile ? "artifact" : view}>
      <header className={styles.topbar}>
        <button type="button" className={styles.mobileButton} onClick={() => { setProjectsOpen(true); writeAntigravityUrl({ pane: "projects" }); }} aria-label="Open projects"><Menu size={20} /></button>
        <div className={styles.brand}><span><Sparkles size={17} /></span><strong>Antigravity</strong></div>
        <div className={styles.projectCrumb}>
          <span>Project</span><ChevronRight size={14} /><strong dir="auto">{selectedProject?.name ?? "No project selected"}</strong>
        </div>
        <div className={styles.runtimeStatus}><span className={vitals?.ok ? styles.online : styles.offline} /><strong>{vitals?.ok ? "Ready" : "Offline"}</strong><small>{vitals?.version || "Checking runtime"}</small></div>
        <button type="button" className={styles.mobileButton} onClick={() => { setArtifactsOpen(true); writeAntigravityUrl({ pane: "artifacts" }); }} aria-label="Open artifacts"><PanelRightOpen size={20} /></button>
      </header>

      {(projectsOpen || artifactsOpen) && <button type="button" className={styles.backdrop} onClick={closePanels} aria-label="Close mobile panels" />}

      <aside ref={projectsRef} tabIndex={-1} className={`${styles.projects} ${projectsOpen ? styles.sheetOpen : ""}`} aria-label="Antigravity projects">
        <div className={styles.panelHeader}>
          <div><strong>Projects</strong><span>Local Antigravity work</span></div>
          <button type="button" onClick={() => void loadProjects()} aria-label="Refresh projects"><RefreshCw size={17} className={loadingProjects ? styles.spinning : ""} /></button>
          <button type="button" className={styles.mobileClose} onClick={closePanels} aria-label="Close projects"><X size={18} /></button>
        </div>
        <label className={styles.projectSearch}>
          <Search size={15} aria-hidden="true" />
          <span className={styles.srOnly}>Search projects and conversation sessions</span>
          <input value={projectQuery} onChange={(event) => { setProjectQuery(event.target.value); setProjectLimit(PROJECT_PAGE_SIZE); }} placeholder="Search name, path, type or activity" aria-label="Search Antigravity projects and conversation sessions" />
        </label>
        <div className={styles.projectList}>
          {projectList("scratch", "Projects")}
          {projectList("brain", "Conversation sessions")}
          {!loadingProjects && projects.length === 0 && <p className={styles.emptyPanel}>No Antigravity projects found yet.</p>}
          {!loadingProjects && projects.length > 0 && filteredProjects.length === 0 && <p className={styles.emptyPanel}>No projects or conversation sessions match “{projectQuery}”.</p>}
          {visibleProjects.length < filteredProjects.length && <button type="button" className={styles.loadMore} onClick={() => setProjectLimit((current) => current + PROJECT_PAGE_SIZE)}>Load {Math.min(PROJECT_PAGE_SIZE, filteredProjects.length - visibleProjects.length)} more</button>}
        </div>
      </aside>

      <main className={styles.workspace}>
        <div className={styles.workspaceToolbar}>
          <div className={styles.agentTitle}><span className={styles.agentMark}><Bot size={18} /></span><div><strong>Agent Manager</strong><small>{selectedProject ? compactPath(selectedProject.root) : "Choose a project to ground the agent"}</small></div></div>
          <label className={styles.modelSelect}><span>Model</span><select value={model} onChange={(event) => setModel(event.target.value)}>{MODELS.map((item) => <option key={item} value={item}>{item}</option>)}</select><ChevronDown size={15} /></label>
          <nav className={styles.modeNav} aria-label="Antigravity work modes">
            <button type="button" className={view === "agent" ? styles.activeMode : ""} onClick={() => chooseView("agent")}><Bot size={15} /> Agent</button>
            <button type="button" className={view === "subagents" ? styles.activeMode : ""} onClick={() => chooseView("subagents")}><Network size={15} /> Subagents</button>
            <button type="button" className={view === "tasks" ? styles.activeMode : ""} onClick={() => chooseView("tasks")}><CalendarClock size={15} /> Scheduled tasks</button>
            <button type="button" className={view === "capabilities" ? styles.activeMode : ""} onClick={() => chooseView("capabilities")}><Blocks size={15} /> Capabilities</button>
          </nav>
        </div>

        {view === "agent" && <div className={styles.conversation} aria-live="polite">
          {messages.length === 0 && !sending && (
            <section className={styles.emptyConversation}>
              <div className={styles.orbitMark}><Sparkles size={28} /></div>
              <h1>Build inside a project</h1>
              <p>Antigravity keeps the conversation, implementation plan and generated artifacts in one review surface.</p>
              {selectedProject && <div className={styles.projectContext}><FolderOpen size={17} /><span><strong dir="auto">{selectedProject.name}</strong><small>{selectedProject.fileCount} artifacts available</small></span><CheckCircle2 size={17} /></div>}
            </section>
          )}

          {messages.map((message) => (
            <article key={message.id} className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.agentMessage}`}>
              <div className={styles.messageIdentity}>{message.role === "user" ? "You" : <Sparkles size={17} />}</div>
              <div className={styles.messageContent}>
                <div className={styles.messageMeta}><strong>{message.role === "user" ? "You" : "Agent Manager"}</strong>{message.durationMs ? <span>{(message.durationMs / 1000).toFixed(1)}s</span> : null}</div>
                <div className={styles.messageText} dir="auto">{message.text}</div>
              </div>
            </article>
          ))}

          {sending && (
            <article className={`${styles.message} ${styles.agentMessage}`}>
              <div className={styles.messageIdentity}><Sparkles size={17} /></div>
              <div className={styles.messageContent}>
                <div className={styles.messageMeta}><strong>Agent Manager</strong><span>Working</span></div>
                <div className={styles.executionCard}><span className={styles.activityDot} /><div><strong>Executing in project</strong><small dir="auto">{selectedProject?.name ?? "Default Antigravity workspace"}</small></div></div>
              </div>
            </article>
          )}
          <div ref={endRef} />
        </div>}

        {view === "agent" && <form className={styles.composer} onSubmit={sendMessage}>
          {error && <div className={styles.error} role="alert">{error}</div>}
          <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleComposerKey} rows={3} placeholder="Describe what you want Antigravity to build" aria-label="Message Antigravity" />
          <div className={styles.composerFooter}>
            <span><Folder size={14} /> {selectedProject?.name ?? "Default workspace"}</span>
            {sending ? <button type="button" className={styles.stopButton} onClick={() => abortRef.current?.abort()}><Square size={15} /> Stop</button> : <button type="submit" className={styles.sendButton} disabled={!input.trim()}><Send size={16} /> Run</button>}
          </div>
        </form>}

        {view === "subagents" && <section className={styles.operationPage} aria-label="Antigravity dynamic subagents">
          <div className={styles.operationHeading}><div><span>Agent orchestration</span><h1>Dynamic subagents</h1><p>Delegation and execution traces remain visible only when Antigravity exposes native runtime data.</p></div><Network size={28} /></div>
          <div className={styles.runtimeStrip}><span className={vitals?.ok ? styles.readyDot : styles.offlineDot} /><div><strong>Agent Manager</strong><p>{vitals?.ok ? `Runtime ${vitals.version || "ready"}` : "Runtime unavailable"}</p></div><b>{vitals?.ok ? "Ready" : "Offline"}</b></div>
          <div className={styles.capabilityGrid}>
            <article><Network size={19} /><div><strong>Dynamic delegation</strong><p>Create scoped subagents and assign project work.</p></div>{unsupported("Dynamic delegation")}</article>
            <article><Sparkles size={19} /><div><strong>Subagent trace</strong><p>Inspect prompts, handoffs, results and duration.</p></div>{unsupported("Subagent trace")}</article>
            <article><CheckCircle2 size={19} /><div><strong>Approval checkpoints</strong><p>Review delegated changes before they reach the project.</p></div>{unsupported("Subagent approvals")}</article>
          </div>
        </section>}

        {view === "tasks" && <section className={styles.operationPage} aria-label="Antigravity scheduled tasks">
          <div className={styles.operationHeading}><div><span>Background work</span><h1>Scheduled tasks</h1><p>Recurring tasks require a native scheduler and durable task ledger.</p></div><CalendarClock size={28} /></div>
          <div className={styles.unsupportedNotice}><CalendarClock size={20} /><div><strong>No scheduler bridge detected</strong><p>No schedule can be created, edited or run safely from this surface yet.</p></div>{unsupported("Scheduled tasks")}</div>
          <div className={styles.taskLedger}><div><span>Task</span><span>Schedule</span><span>Last run</span><span>Status</span></div><p>No native Antigravity tasks reported.</p></div>
        </section>}

        {view === "capabilities" && <section className={styles.operationPage} aria-label="Antigravity capabilities">
          <div className={styles.operationHeading}><div><span>Runtime capabilities</span><h1>Skills, MCP and hooks</h1><p>Installed capability inventory belongs beside project work, never hidden in another tool.</p></div><Blocks size={28} /></div>
          <div className={styles.capabilityGrid}>
            <article><Sparkles size={19} /><div><strong>Skills</strong><p>Installed Antigravity skills and activation sources.</p></div>{unsupported("Skills")}</article>
            <article><Blocks size={19} /><div><strong>MCP servers</strong><p>Connected servers, exposed tools and health.</p></div>{unsupported("MCP servers")}</article>
            <article><Webhook size={19} /><div><strong>Hooks</strong><p>Lifecycle hooks, policies and last execution.</p></div>{unsupported("Hooks")}</article>
          </div>
        </section>}
      </main>

      <aside ref={artifactsRef} tabIndex={-1} className={`${styles.artifacts} ${artifactsOpen ? styles.sheetOpen : ""}`} aria-label="Antigravity artifacts">
        <div className={styles.panelHeader}>
          <div><strong>Artifacts</strong><span>{files.length} in this project</span></div>
          {selectedProject && <button type="button" onClick={() => void selectProject(selectedProject)} aria-label="Refresh artifacts"><RefreshCw size={17} className={loadingFiles ? styles.spinning : ""} /></button>}
          <button type="button" className={styles.mobileClose} onClick={closePanels} aria-label="Close artifacts"><X size={18} /></button>
        </div>

        {!openFile ? (
          <div className={styles.artifactList}>
            {planFiles.length > 0 && <section><div className={styles.artifactLabel}><Clipboard size={15} /> Implementation plan</div>{planFiles.map((file) => <button type="button" key={file.relPath} onClick={() => void loadFile(file)}><FileText size={17} /><span><strong>{file.relPath}</strong><small>{fileSize(file.bytes)} · {timeAgo(file.mtime)}</small></span><ChevronRight size={16} /></button>)}</section>}
            <section><div className={styles.artifactLabel}><Code2 size={15} /> Project files</div>{files.filter((file) => !isPlanFile(file)).map((file) => <button type="button" key={file.relPath} onClick={() => void loadFile(file)}><FileCode2 size={17} /><span><strong>{file.relPath}</strong><small>{file.kind} · {fileSize(file.bytes)}</small></span><ChevronRight size={16} /></button>)}</section>
            {!loadingFiles && files.length === 0 && <p className={styles.emptyPanel}>{selectedProject ? "No artifacts in this project." : "Choose a project to review its artifacts."}</p>}
            {loadingFiles && <div className={styles.loadingState}><RefreshCw size={20} className={styles.spinning} /> Loading artifacts</div>}
          </div>
        ) : (
          <div className={styles.artifactPreview}>
            <div className={styles.previewHeader}>
              <button type="button" onClick={() => { setOpenFile(null); writeAntigravityUrl({ view: "agent", artifact: null, pane: "artifacts" }); }} aria-label="Back to artifacts"><ChevronLeftIcon /></button>
              <div><strong>{openFile.path}</strong><small>{fileSize(openFile.bytes)}{openFile.truncated ? " · Preview truncated" : ""}</small></div>
              {openFile.kind === "text" && <button type="button" onClick={() => void navigator.clipboard?.writeText(openFile.content)} aria-label="Copy artifact"><Clipboard size={17} /></button>}
              <a href={rawUrl(openFile.path)} download aria-label="Download artifact"><Download size={17} /></a>
            </div>
            {openFile.kind === "text" && /\.html?$/i.test(openFile.path) && <div className={styles.previewTabs}><button type="button" className={htmlMode === "preview" ? styles.activePreviewTab : ""} onClick={() => setHtmlMode("preview")}>Preview</button><button type="button" className={htmlMode === "source" ? styles.activePreviewTab : ""} onClick={() => setHtmlMode("source")}>Source</button></div>}
            <div className={styles.previewBody}>
              {openFile.kind === "text" && (!/\.html?$/i.test(openFile.path) || htmlMode === "source") && <pre dir="auto">{openFile.content}</pre>}
              {openFile.kind === "text" && /\.html?$/i.test(openFile.path) && htmlMode === "preview" && <iframe src={previewUrl(openFile.path)} title={openFile.path} />}
              {openFile.kind === "image" && <img src={rawUrl(openFile.path)} alt={openFile.path} />}
              {openFile.kind === "video" && <video src={rawUrl(openFile.path)} controls />}
              {openFile.kind === "audio" && <audio src={rawUrl(openFile.path)} controls />}
              {openFile.kind === "pdf" && <iframe src={rawUrl(openFile.path)} title={openFile.path} />}
              {openFile.kind === "binary" && <a className={styles.downloadCard} href={rawUrl(openFile.path)} download><Download size={20} /> Download binary artifact</a>}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function ChevronLeftIcon() {
  return <ChevronRight size={18} style={{ transform: "rotate(180deg)" }} />;
}
