"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import VoiceButton, { useVoiceToInput } from "./VoiceButton";
import { motion, AnimatePresence } from "framer-motion";
import {
  ListChecks,
  Send, Square, Play, Trash2, RefreshCw, FolderOpen, FileText,
  Copy, Download, X, Eye, ExternalLink, FilePlus, Layers, MessageSquare, Target,
} from "lucide-react";
import GoalLogStream from "./GoalLogStream";
import AgentWorkspaceShell, { type WorkspaceNavDetail, type WorkspaceSection, type WorkspaceSessionRef } from "./AgentWorkspaceShell";
import {
  cancelWorkbenchRun,
  createWorkbenchIdempotencyKey,
  describeWorkbenchError,
  executeWorkbenchRun,
  isVerifiedCancellation,
  workbenchRunLabel,
  type WorkbenchStopState,
} from "@/lib/workbench/uiClient";
import type { Run } from "@/lib/workbench/types";
import {
  clearVolatileValue,
  purgeLegacySensitiveBrowserState,
  readVolatileValue,
  writeVolatileValue,
} from "@/lib/workbench/volatileClientState";

// Codex agent surface — four tabs (same shape as Antigravity):
//   Chat       — canonical Workbench lifecycle over the native Codex runtime
//   Goal Mode  — long-running goals tracked in ~/.agentic-os/codex-goals.json
//   Sessions   — past Codex sessions (read from ~/.codex/session_index.jsonl)
//   Workspace  — artefacts created by goals (text/image/video/audio/HTML preview)

type Tab = "chat" | "goal" | "sessions" | "workspace";

interface CodexSession { id: string; threadName: string; updatedAt: number; }
interface Goal {
  id: string;
  title: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed" | "stopped";
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  pid?: number;
  cwd: string;
  lastOutput?: string;
  logFile: string;
  exitCode?: number | null;
}
interface CdxProject { name: string; root: string; mtime: number; fileCount: number; }
type CdxFileKind = "text" | "image" | "video" | "audio" | "pdf" | "binary";
interface CdxFile { name: string; relPath: string; bytes: number; mtime: number; kind: CdxFileKind; }
interface Msg { role: "user" | "assistant" | "system"; text: string; files?: { name: string; relPath: string; kind: CdxFileKind }[]; }

// ── Session detail types (returned from /api/codex/session) ──
interface SessionTurn { role: "user" | "assistant" | "reasoning"; text: string; ts?: number; }
interface SessionToolCall { name: string; args: string; output?: string; }
interface SessionDetail {
  id: string;
  threadName: string;
  cwd: string;
  cwdExists: boolean;
  startedAt: number;
  model: string | null;
  turns: SessionTurn[];
  toolCalls: SessionToolCall[];
  referencedFiles: string[];
  cwdFiles: CdxFile[];
}

// Convert an absolute path under $HOME into the path-segment list our session-file
// endpoint expects. Returns null when the file isn't under HOME (we never serve those).
function sessionFileUrl(absPath: string, home: string): string | null {
  if (!absPath || !absPath.startsWith(home + "/")) return null;
  const rel = absPath.slice(home.length + 1);
  return `/api/codex/session-file/${rel.split("/").map(encodeURIComponent).join("/")}`;
}
function kindFromExt(name: string): CdxFileKind {
  const e = (name.split(".").pop() || "").toLowerCase();
  if (["png","jpg","jpeg","webp","gif","svg","avif"].includes(e)) return "image";
  if (["mp4","webm","mov","m4v","mkv"].includes(e)) return "video";
  if (["mp3","wav","m4a","ogg","aac","flac"].includes(e)) return "audio";
  if (e === "pdf") return "pdf";
  if (["html","htm","css","js","jsx","ts","tsx","json","md","txt","csv","py","sh"].includes(e)) return "text";
  return "binary";
}

// The provider's #6867AA remains the structural accent in the shared theme.
// This lighter companion is used where the accent carries small text on dark UI.
const ACCENT = "#A9A8DD";
const SESSION_ID_KEY = "agentic-os/codex/session-id/v1";
const ACTIVE_PROJECT_KEY = "agentic-os/codex/active-project/v1";
const conversationMemoryKey = (id: string) => `conversation:codex:${id}`;

function fmtAgo(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}
function statusColor(s: Goal["status"]): string {
  if (s === "running") return "var(--gold)";
  if (s === "completed") return "var(--emerald)";
  if (s === "failed") return "var(--plum)";
  return "var(--cream-mute)";
}

export default function CodexView() {
  const [tab, setTab] = useState<Tab>("chat");

  // ─── Chat state ───
  const [input, setInput] = useState("");
  const handleVoice = useVoiceToInput(setInput);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const activeRunRef = useRef<Run | null>(null);
  const [stopState, setStopState] = useState<WorkbenchStopState>("not_requested");
  // The non-sensitive session id may persist; transcript content is memory-only.
  const sidRef = useRef<string>("");
  // Inline preview of files a turn just built: message-index → open relPath
  const [inlinePreview, setInlinePreview] = useState<Record<number, string | null>>({});

  // Goal Mode still uses its legacy engine selector until its own Workbench cutover.
  const [engine, setEngine] = useState<"omniroute" | "hy3" | "gpt56">("gpt56");
  useEffect(() => {
    try { const v = localStorage.getItem("agentic-os/codex/engine"); if (v === "omniroute" || v === "hy3" || v === "gpt56") setEngine(v); } catch {}
  }, []);
  const changeEngine = (v: "omniroute" | "hy3" | "gpt56") => { setEngine(v); try { localStorage.setItem("agentic-os/codex/engine", v); } catch {} };
  const scrollRef = useRef<HTMLDivElement>(null);

  // ─── Goal state ───
  const [goals, setGoals] = useState<Goal[]>([]);
  const [goalTitle, setGoalTitle] = useState("");
  const [goalPrompt, setGoalPrompt] = useState("");
  const [openGoalId, setOpenGoalId] = useState<string | null>(null);
  const [openGoalLog, setOpenGoalLog] = useState<string>("");

  // ─── Sessions state ───
  const [sessions, setSessions] = useState<CodexSession[]>([]);
  const [openSession, setOpenSession] = useState<SessionDetail | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionFile, setSessionFile] = useState<{ absPath: string; url: string | null; kind: CdxFileKind } | null>(null);
  // Server $HOME is needed to convert absolute paths → preview URLs. Cached on first use.
  const [homeDir, setHomeDir] = useState<string>("");

  // ─── Workspace state ───
  const [projects, setProjects] = useState<CdxProject[]>([]);
  const [selected, setSelected] = useState<CdxProject | null>(null);
  const [files, setFiles] = useState<CdxFile[]>([]);
  const [open, setOpen] = useState<{ path: string; content: string; bytes: number; truncated: boolean; kind: CdxFileKind } | null>(null);
  const [htmlMode, setHtmlMode] = useState<"source" | "preview">("preview");
  const [newProjectName, setNewProjectName] = useState("");

  // Active project — every chat (and every codex spawn) lands here.
  const [activeProject, setActiveProject] = useState<string>("codex-default");
  const [activeProjectRoot, setActiveProjectRoot] = useState<string>("");
  const [nativeResumeId, setNativeResumeId] = useState<string | null>(null);
  const [sidebarSessionPath, setSidebarSessionPath] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const p = window.localStorage.getItem(ACTIVE_PROJECT_KEY);
      if (p) setActiveProject(p);
    } catch {}
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(ACTIVE_PROJECT_KEY, activeProject); } catch {}
  }, [activeProject]);

  // Restore only the non-sensitive session id. Raw chat content never leaves
  // the current browser document except for the provider's own native history.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      purgeLegacySensitiveBrowserState();
      sidRef.current = window.localStorage.getItem(SESSION_ID_KEY) || `c-${Date.now()}`;
      window.localStorage.setItem(SESSION_ID_KEY, sidRef.current);
      setMsgs(readVolatileValue<Msg[]>(conversationMemoryKey(sidRef.current)) ?? []);
    } catch {}
  }, []);
  async function loadChatSession(id: string) {
    setMsgs(readVolatileValue<Msg[]>(conversationMemoryKey(id)) ?? []);
    sidRef.current = id;
    setInlinePreview({});
    try { window.localStorage.setItem(SESSION_ID_KEY, id); } catch {}
  }
  function newChat(session?: WorkspaceSessionRef) {
    if (streaming) return;
    setMsgs([]); setPartial(""); setInlinePreview({});
    setNativeResumeId(null);
    setSidebarSessionPath(session?.path ?? null);
    sidRef.current = session?.nativeId || session?.id || `c-${Date.now()}`;
    clearVolatileValue(conversationMemoryKey(sidRef.current));
    try { window.localStorage.setItem(SESSION_ID_KEY, sidRef.current); } catch {}
  }

  async function loadNativeSession(session: WorkspaceSessionRef) {
    const id = session.nativeId || session.id;
    try {
      const response = await fetch(`/api/codex/session?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!payload.session) return;
      const next: Msg[] = (payload.session.turns ?? [])
        .filter((turn: { role?: string; text?: string }) => (turn.role === "user" || turn.role === "assistant" || turn.role === "system") && turn.text)
        .map((turn: { role: "user" | "assistant" | "system"; text: string }) => ({ role: turn.role, text: turn.text }));
      setMsgs(next);
      setPartial("");
      setInlinePreview({});
      setNativeResumeId(id);
      setSidebarSessionPath(session.path);
      sidRef.current = id;
    } catch { /* keep current chat on read failure */ }
  }

  async function loadSidebarSession(session: WorkspaceSessionRef) {
    if (session.source === "local" || session.path.startsWith("local:")) {
      await loadChatSession(session.id);
      setSidebarSessionPath(session.path);
      setNativeResumeId(session.nativeId && session.nativeId !== session.id ? session.nativeId : null);
      return;
    }
    await loadNativeSession(session);
  }

  useEffect(() => {
    const onNav = (event: Event) => {
      const d = (event as CustomEvent<WorkspaceNavDetail>).detail;
      if (d?.agent !== "codex") return;
      if (d.project) {
        setActiveProject(d.project.label || "codex-default");
        setActiveProjectRoot(d.project.root || "");
      } else if (d.action === "project") {
        setActiveProject("");
        setActiveProjectRoot("");
      }
      if (d.action === "project") {
        // Project selection is a conversation boundary. Never let a native
        // resume id or local draft from the previous project leak into the new
        // cwd; the user must start or select a task in this project explicitly.
        setSidebarSessionPath(null);
        setNativeResumeId(null);
        setMsgs([]);
        setPartial("");
        setInlinePreview({});
        sidRef.current = "";
        try {
          window.localStorage.removeItem(SESSION_ID_KEY);
        } catch {}
        setTab("chat");
        return;
      }
      if (d.action === "new") { newChat(d.session); setTab("chat"); }
      else if (d.action === "select" && d.session) { void loadSidebarSession(d.session); setTab("chat"); }
      else if (d.target === "chat" || d.target === "goal" || d.target === "sessions" || d.target === "workspace") setTab(d.target);
      else if (d.section === "messages") setTab("chat");
      else if (d.section === "history") setTab("sessions");
      else if (d.section === "projects" || d.section === "artifacts") setTab("workspace");
      else if (d.section === "tools") setTab("goal");
    };
    window.addEventListener("agent-workspace-nav", onNav);
    return () => window.removeEventListener("agent-workspace-nav", onNav);
  }, [streaming]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, partial]);

  useEffect(() => {
    if (!streaming) { setElapsed(0); return; }
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250);
    return () => clearInterval(t);
  }, [streaming]);

  // ─── API loaders ───
  async function refreshGoals() {
    try {
      const r = await fetch("/api/codex/goals", { cache: "no-store" });
      const j = await r.json();
      setGoals(Array.isArray(j.goals) ? j.goals : []);
    } catch {}
  }
  async function refreshSessions() {
    try {
      const r = await fetch("/api/codex/sessions?limit=80", { cache: "no-store" });
      const j = await r.json();
      setSessions(Array.isArray(j.sessions) ? j.sessions : []);
    } catch {}
  }

  // Open a session — fetch its full transcript + cwd file listing.
  async function openSessionById(id: string) {
    setSessionLoading(true);
    setOpenSession(null);
    setSessionFile(null);
    try {
      const r = await fetch(`/api/codex/session?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const j = await r.json();
      if (j.session) {
        setOpenSession(j.session);
        // Infer $HOME from the cwd (first 3 segments: /Users/<user>)
        if (j.session.cwd && !homeDir) {
          const m = /^(\/(?:Users|home)\/[^/]+)(?:\/|$)/.exec(j.session.cwd);
          if (m) setHomeDir(m[1]);
        }
      }
    } catch {}
    setSessionLoading(false);
  }
  function openSessionFile(absPath: string) {
    if (!homeDir) return;
    const url = sessionFileUrl(absPath, homeDir);
    if (!url) return;
    setSessionFile({ absPath, url, kind: kindFromExt(absPath) });
  }
  async function refreshProjects() {
    try {
      const r = await fetch("/api/codex/workspace", { cache: "no-store" });
      const j = await r.json();
      setProjects(Array.isArray(j.projects) ? j.projects : []);
    } catch {}
  }
  useEffect(() => { refreshGoals(); refreshSessions(); refreshProjects(); }, []);
  // Live-poll the active tab so the user sees status updates on goals
  useEffect(() => {
    if (tab === "goal") {
      const t = setInterval(refreshGoals, 4000);
      return () => clearInterval(t);
    }
    if (tab === "workspace") {
      const t = setInterval(refreshProjects, 5000);
      return () => clearInterval(t);
    }
  }, [tab]);

  // Fetch the active project's file list (for before/after diffing around a turn).
  async function projectFiles(): Promise<CdxFile[]> {
    try {
      const r = await fetch(`/api/codex/workspace?project=${encodeURIComponent(activeProject)}`, { cache: "no-store" });
      const j = await r.json();
      return Array.isArray(j.files) ? j.files : [];
    } catch { return []; }
  }

  // ─── Chat: send ───
  async function sendChat() {
    const prompt = input.trim();
    if (!prompt || streaming || !sidebarSessionPath || !activeProjectRoot) return;
    const history = msgs;
    setMsgs((m) => [...m, { role: "user", text: prompt }]);
    setInput("");
    setPartial("");
    setStreaming(true);
    // Snapshot files BEFORE the turn so we can show what Codex just built.
    const before = new Map((await projectFiles()).map((f) => [f.relPath, f.mtime]));

    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    let acc = "";

    try {
      const result = await executeWorkbenchRun({
        agentId: "codex",
        prompt,
        projectId: activeProject,
        sessionId: nativeResumeId,
        idempotencyKey: createWorkbenchIdempotencyKey("codex"),
      }, {
        onStarted: ({ run }) => {
          activeRunRef.current = run;
          setActiveRun(run);
          setStopState("not_requested");
        },
        onOutput: (text) => {
          acc += text;
          setPartial(acc);
        },
      }, ctrl.signal);
      activeRunRef.current = result.run;
      setActiveRun(result.run);
      setStopState(result.stop.state);
      const nextNativeId = result.run.context.sessionId;
      if (nextNativeId) {
        setNativeResumeId(nextNativeId);
        if (sidebarSessionPath) window.dispatchEvent(new CustomEvent("agent-conversation-native-id", { detail: {
          agent: "codex", sessionPath: sidebarSessionPath, nativeId: nextNativeId,
        } }));
      }
      if (result.run.status !== "succeeded") {
        if (!isVerifiedCancellation(result)) setInput(prompt);
        acc += `\n\n[${result.run.status}: ${result.run.error?.message ?? "Run did not complete"}]`;
      }
    } catch (error) {
      setInput(prompt);
      acc += `\n\n[error: ${describeWorkbenchError(error)}]`;
    }

    // Diff files AFTER the turn — anything new or touched is what Codex built.
    const after = await projectFiles();
    const built = after.filter((f) => !before.has(f.relPath) || (before.get(f.relPath) ?? 0) < f.mtime)
      .map((f) => ({ name: f.name, relPath: f.relPath, kind: f.kind }));
    const msgIndex = history.length + 1; // index this assistant msg will land at
    const completedMessages: Msg[] = [
      ...history,
      { role: "user", text: prompt },
      { role: "assistant", text: acc || "(no output)", files: built.length ? built : undefined },
    ];
    setMsgs(completedMessages);
    writeVolatileValue(conversationMemoryKey(sidRef.current), completedMessages.slice(-200));
    // Auto-open the inline preview for the first previewable HTML build.
    const firstHtml = built.find((f) => /\.html?$/i.test(f.name));
    if (firstHtml) setInlinePreview((p) => ({ ...p, [msgIndex]: firstHtml.relPath }));
    setPartial(""); setStreaming(false);
    // Refresh project list — Codex may have written files into the active project
    refreshProjects();
  }
  async function stopChat() {
    const run = activeRunRef.current;
    if (!run || stopState === "stopping") return;
    setStopState("stopping");
    try {
      const snapshot = await cancelWorkbenchRun(run, (next) => {
        activeRunRef.current = next.run;
        setActiveRun(next.run);
        setStopState(next.stop.state);
      });
      activeRunRef.current = snapshot.run;
      setActiveRun(snapshot.run);
      setStopState(snapshot.stop.state);
    } catch (error) {
      setStopState("failed_to_stop");
      setPartial(describeWorkbenchError(error, false));
    }
  }
  function clearChat() {
    if (streaming) return;
    setMsgs([]); setPartial("");
    clearVolatileValue(conversationMemoryKey(sidRef.current));
  }

  // ─── Goals: read-only history until Workbench owns the lifecycle ───
  async function openGoal(id: string) {
    setOpenGoalId(id);
    try {
      const r = await fetch(`/api/codex/goals?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const j = await r.json();
      setOpenGoalLog(j.log ?? "");
    } catch { setOpenGoalLog(""); }
  }
  // Live-tail the open goal's log while it's running
  useEffect(() => {
    if (!openGoalId) return;
    const goal = goals.find((g) => g.id === openGoalId);
    if (!goal || goal.status !== "running") return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/codex/goals?id=${encodeURIComponent(openGoalId)}`, { cache: "no-store" });
        const j = await r.json();
        setOpenGoalLog(j.log ?? "");
      } catch {}
    }, 2500);
    return () => clearInterval(t);
  }, [openGoalId, goals]);

  // ─── Workspace: read-only project and artifact browser ───
  async function selectProject(p: CdxProject) {
    setSelected(p); setOpen(null);
    try {
      const r = await fetch(`/api/codex/workspace?project=${encodeURIComponent(p.name)}`, { cache: "no-store" });
      const j = await r.json();
      setFiles(j.files ?? []);
    } catch { setFiles([]); }
  }
  async function loadFile(f: CdxFile) {
    if (!selected) return;
    if (f.kind !== "text") {
      setOpen({ path: f.relPath, content: "", bytes: f.bytes, truncated: false, kind: f.kind });
      return;
    }
    try {
      const r = await fetch(`/api/codex/workspace/file?project=${encodeURIComponent(selected.name)}&path=${encodeURIComponent(f.relPath)}`, { cache: "no-store" });
      const j = await r.json();
      if (j.content !== undefined) setOpen({ path: f.relPath, content: j.content, bytes: j.bytes, truncated: j.truncated, kind: "text" });
    } catch {}
  }
  function rawUrl(relPath: string): string {
    if (!selected) return "";
    const segs = relPath.split("/").map(encodeURIComponent).join("/");
    return `/api/codex/preview/${encodeURIComponent(selected.name)}/${segs}`;
  }

  const workspaceSection: WorkspaceSection = tab === "chat" ? "messages" : tab === "sessions" ? "history" : tab === "workspace" ? "projects" : "tools";
  const hasConversationContext = Boolean(sidebarSessionPath && activeProjectRoot);
  return (
    <AgentWorkspaceShell agent="codex" active={workspaceSection} activeTarget={tab}><div data-codex-view className="flex h-full min-h-0 flex-col">
      <div className="hidden">
        <span className="pill self-start lg:self-auto" title="Active scratch project — Codex chats write files here"
              style={{ background: `${ACCENT}18`, borderColor: `${ACCENT}40`, color: ACCENT }}>
          <FolderOpen size={10} className="inline mr-1" />{activeProject || "Choose workspace"}
        </span>
      </div>

      <div className="flex-1 min-h-0 surface-card p-0 overflow-hidden flex flex-col" style={{ borderColor: `${ACCENT}30` }}>
        {/* ─── CHAT TAB ─── */}
        {tab === "chat" && (
          <>
            {(msgs.length > 0 || streaming) && <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-4 py-2.5 border-b" style={{ borderColor: "var(--line-soft)" }}>
              <div className="flex items-center gap-2 scroll-rail" tabIndex={0} aria-label="Codex connection details">
                <span className="action-tag" style={{ color: ACCENT }}>Codex · Workbench</span>
                <span className="pill" style={{ color: ACCENT, borderColor: `${ACCENT}30`, background: `${ACCENT}0c` }}>durable restricted pilot</span>
                <span className="pill" style={{ color: "#cdd3f7", borderColor: "rgba(205,211,247,.5)", background: "rgba(255,255,255,0.02)" }}>Server-managed runtime</span>
              </div>
              <div className="flex items-center gap-1 relative shrink-0">
                {msgs.length > 0 && !streaming && (
                  <button onClick={clearChat} className="text-[11px] flex items-center gap-1 px-2 py-1 rounded-md hover:bg-[rgba(255,255,255,0.04)]" style={{ color: "var(--cream-mute)" }}>
                    <Trash2 size={11} /> clear
                  </button>
                )}
              </div>
            </div>}
            <div
              ref={scrollRef}
              className="scroll relative flex-1 min-h-0 overflow-y-auto p-4 space-y-3"
              tabIndex={0}
              aria-label="Codex conversation messages"
            >
              <AnimatePresence initial={false}>
                {msgs.length === 0 && !streaming && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} data-codex-empty-state className="grid h-full place-items-center text-center text-[var(--cream-soft)]">
                    <div className="absolute inset-0 grid place-items-center px-6">
                      <div>
                        <div className="mx-auto mb-5 h-8 w-8 rounded-full border border-white/20" aria-hidden="true" />
                        <p className="text-[22px] font-medium tracking-[-0.02em] text-[var(--cream)]">What should we build in {activeProject || "this workspace"}?</p>
                      </div>
                    </div>
                    <div className="sr-only">
                    <p className="text-base text-[var(--cream)]">Codex — project-scoped native task.</p>
                    <p className="mt-2">The first message starts the server-managed restricted Codex runtime; later messages resume the verified native Codex thread.</p>
                    <ul className="mt-3 text-xs text-[var(--cream-mute)] space-y-1">
                      <li>• Native multi-turn memory: the active Codex thread id is resumed</li>
                      <li>• Runtime and model selection are owned and verified by the server in this pilot</li>
                      <li>• For long-running work, switch to <strong>Goal Mode</strong></li>
                      <li>• Esc to abort an in-flight call</li>
                    </ul>
                    </div>
                  </motion.div>
                )}
                {msgs.map((m, i) => (
                  <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                    className={`rounded-xl px-4 py-3 text-sm leading-relaxed border ${
                      m.role === "user"
                        ? "bg-[rgba(34,197,94,0.06)] border-[rgba(34,197,94,0.22)] text-[var(--cream)]"
                        : "bg-[rgba(255,255,255,0.02)] border-[rgba(255,255,255,0.06)] text-[var(--cream)]"
                    }`}>
                    <div className="text-[10px] tracking-widest uppercase mb-1 opacity-60 flex items-center gap-2">
                      {m.role === "user" ? "you" : "codex"}
                      {m.role === "assistant" && <span className="normal-case tracking-normal text-emerald-400/70">via server-managed restricted pilot</span>}
                    </div>
                    <div className="whitespace-pre-wrap font-[var(--font-geist-mono)]">{m.text}</div>
                    {m.role === "assistant" && m.files && m.files.length > 0 && (
                      <div className="mt-3 pt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
                        <div className="text-[10px] tracking-widest uppercase opacity-60 mb-1.5">built this turn — click to preview</div>
                        <div className="flex flex-wrap gap-1.5">
                          {m.files.map((f) => {
                            const url = `/api/codex/preview/${encodeURIComponent(activeProject)}/${f.relPath.split("/").map(encodeURIComponent).join("/")}`;
                            const isHtml = /\.html?$/i.test(f.name);
                            return (
                              <span key={f.relPath} className="inline-flex items-center gap-1">
                                {isHtml && (
                                  <button onClick={() => setInlinePreview((p) => ({ ...p, [i]: p[i] === f.relPath ? null : f.relPath }))}
                                    className="text-[11px] px-2 py-1 rounded-md border font-medium"
                                    style={{ borderColor: `${ACCENT}44`, color: ACCENT, background: inlinePreview[i] === f.relPath ? `${ACCENT}14` : "transparent" }}>
                                    ▶ {f.name}
                                  </button>
                                )}
                                <a href={url} target="_blank" rel="noopener"
                                  className="text-[11px] px-2 py-1 rounded-md border hover:bg-[rgba(255,255,255,0.05)]"
                                  style={{ borderColor: "var(--line-soft)", color: "var(--cream-soft)" }}>
                                  {isHtml ? "open ↗" : `${f.name} ↗`}
                                </a>
                              </span>
                            );
                          })}
                        </div>
                        {inlinePreview[i] && (
                          <iframe title={`preview-${i}`}
                            src={`/api/codex/preview/${encodeURIComponent(activeProject)}/${inlinePreview[i]!.split("/").map(encodeURIComponent).join("/")}`}
                            className="mt-2 w-full rounded-lg border" style={{ height: 340, background: "#0b0b12", borderColor: "var(--line-soft)" }}
                            sandbox="allow-scripts allow-same-origin" />
                        )}
                      </div>
                    )}
                  </motion.div>
                ))}
                {streaming && (
                  <motion.div key="partial" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="rounded-xl px-4 py-3 text-sm leading-relaxed border bg-[rgba(255,255,255,0.02)] border-[rgba(255,255,255,0.06)]">
                    <div className="text-[10px] tracking-widest uppercase mb-1 opacity-60 flex items-center gap-2">
                      codex
                      <span className="inline-flex">
                        <span className="tick live" style={{ color: ACCENT }} />
                        <span className="tick live" style={{ color: ACCENT, animationDelay: ".2s" }} />
                        <span className="tick live" style={{ color: ACCENT, animationDelay: ".4s" }} />
                      </span>
                      <span className="text-emerald-400/70 normal-case tracking-normal metric">{elapsed}s</span>
                    </div>
                    <div className="whitespace-pre-wrap font-[var(--font-geist-mono)]">{partial || "thinking…"}</div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div className="border-t p-2 flex items-end gap-2" style={{ borderColor: "var(--line-soft)" }}>
              <span className="self-stretch border rounded-lg px-2 text-xs text-[var(--cream-mute)] flex items-center" style={{ borderColor: "var(--line-soft)" }} title="Workbench enforces a read-only sandbox and denies tool approvals.">Tools restricted · {workbenchRunLabel(activeRun, stopState)}</span>
              <span
                title="The restricted pilot runtime and model are selected and verified by the server."
                className="self-stretch border rounded-lg px-2 text-xs text-[var(--cream-mute)] flex items-center"
                style={{ borderColor: "var(--line-soft)" }}>
                Server-managed Codex pilot
              </span>
              <VoiceButton onTranscript={handleVoice} size={34} className="self-end" />
              <textarea value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendChat(); }
                  if (e.key === "Escape" && streaming) void stopChat();
                }}
                rows={2}
                disabled={!hasConversationContext}
                placeholder={hasConversationContext ? "Ask Codex…  (⌘+Enter to send)" : "Choose a workspace and start a new task"}
                className="flex-1 bg-transparent outline-none resize-none px-3 py-2 text-sm text-[var(--cream)] placeholder:text-[var(--cream-mute)]" />
              {streaming ? (
                <button onClick={() => void stopChat()} disabled={stopState === "stopping"}
                  className="px-3 py-2 rounded-lg bg-[rgba(248,113,113,0.15)] border border-[rgba(248,113,113,0.4)] text-rose-300 text-sm flex items-center gap-1.5 hover:bg-[rgba(248,113,113,0.22)]">
                  <Square size={14} /> {stopState === "stopping" ? "Stopping…" : "Stop"}
                </button>
              ) : (
                <button onClick={sendChat} disabled={!input.trim() || !hasConversationContext}
                  className="px-3 py-2 rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  style={{ background: `${ACCENT}28`, border: `1px solid ${ACCENT}66`, color: ACCENT }}>
                  <Send size={14} /> Send
                </button>
              )}
            </div>
          </>
        )}

        {/* ─── GOAL MODE TAB ─── */}
        {tab === "goal" && (
          <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-0 h-full min-h-0">
            <aside className="border-r p-4 space-y-3 overflow-y-auto scroll" style={{ borderColor: "var(--line-soft)" }}>
              <div>
                <div className="action-tag mb-2" style={{ color: ACCENT }}>New goal</div>
                <input value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)}
                  placeholder="Title (optional)"
                  className="w-full bg-transparent border rounded-md px-3 py-2 text-sm text-[var(--cream)] outline-none mb-2"
                  style={{ borderColor: "var(--line-soft)" }} />
                <textarea value={goalPrompt} onChange={(e) => setGoalPrompt(e.target.value)}
                  rows={6}
                  placeholder="What should Codex achieve? Be specific. It runs in the selected project's sandbox until the goal is met or stopped."
                  className="w-full bg-transparent border rounded-md px-3 py-2 text-sm text-[var(--cream)] outline-none mb-2"
                  style={{ borderColor: "var(--line-soft)" }} />
                <div title="Long-running goals remain read-only until their own Workbench cutover."
                  className="w-full bg-transparent border rounded-md px-3 py-2 text-sm text-[var(--cream-mute)] mb-2"
                  style={{ borderColor: "var(--line-soft)" }}>Read-only · goal execution restricted</div>
                <select value={engine} onChange={(e) => changeEngine(e.target.value as "omniroute" | "hy3" | "gpt56")}
                  disabled
                  title="Goal runtime selection is unavailable until Goal Mode is owned by Workbench."
                  className="w-full bg-transparent border rounded-md px-3 py-2 text-sm text-[var(--cream-mute)] outline-none mb-2 cursor-not-allowed opacity-50"
                  style={{ borderColor: "var(--line-soft)" }}>
                  <option value="omniroute">OmniRoute gateway</option>
                  <option value="hy3">HY3 via OpenRouter</option>
                  <option value="gpt56">GPT 5.6 via OpenAI OAuth</option>
                </select>
                <div className="mb-2 truncate text-[10px] text-[var(--cream-mute)]" title={activeProjectRoot || "Choose a workspace from the Codex sidebar"}>
                  Workspace: {activeProjectRoot || "Choose a workspace first"}
                </div>
                <div role="status" className="mb-2 rounded-md border px-2.5 py-2 text-[10px] text-amber-200" style={{ borderColor: "rgba(251,191,36,0.35)", background: "rgba(251,191,36,0.08)" }}>
                  Read-only: existing goal history is visible. Launch, Stop, and Delete are unavailable until Goal Mode uses the verified Workbench lifecycle.
                </div>
                <button disabled
                  title="Unavailable until Goal Mode is owned by Workbench"
                  className="w-full px-3 py-2 rounded-md text-sm flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: `${ACCENT}28`, border: `1px solid ${ACCENT}66`, color: ACCENT }}>
                  <Play size={14} /> Launch unavailable
                </button>
              </div>
              <div className="pt-3 border-t" style={{ borderColor: "var(--line-soft)" }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="action-tag" style={{ color: "var(--cream-dim)" }}>All goals · {goals.length}</div>
                  <button onClick={refreshGoals} className="text-[var(--cream-mute)] hover:text-[var(--cream-dim)]"><RefreshCw size={11} /></button>
                </div>
                <div className="space-y-1.5">
                  {goals.length === 0 && <div className="text-[11px] text-[var(--cream-mute)] italic">No goals yet. Set one above.</div>}
                  {goals.map((g) => (
                    <button key={g.id} onClick={() => openGoal(g.id)}
                      className="block w-full text-left p-3 rounded-md border transition"
                      style={{
                        borderColor: openGoalId === g.id ? `${ACCENT}66` : "var(--line-soft)",
                        background: openGoalId === g.id ? `${ACCENT}10` : "transparent",
                      }}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[12px] text-[var(--cream)] truncate flex-1">{g.title}</span>
                        <span className="action-tag ml-2 shrink-0" style={{ color: statusColor(g.status) }}>{g.status}</span>
                      </div>
                      <div className="text-[10px] text-[var(--cream-mute)] truncate mono">{fmtAgo(g.createdAt)}</div>
                    </button>
                  ))}
                </div>
              </div>
            </aside>
            <main className="flex flex-col min-h-0 overflow-hidden">
              {openGoalId ? (() => {
                const goal = goals.find((g) => g.id === openGoalId);
                if (!goal) return <div className="p-6 text-[var(--cream-mute)] text-sm">Goal not found.</div>;
                return (
                  <>
                    <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: "var(--line-soft)" }}>
                      <div className="min-w-0">
                        <div className="action-title truncate">{goal.title}</div>
                        <div className="text-[11px] text-[var(--cream-mute)] mono mt-0.5 truncate">{goal.cwd}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="action-tag" style={{ color: statusColor(goal.status) }}>● {goal.status}</span>
                        {goal.status === "running" && (
                          <button disabled title="Stop unavailable until ACTIVE_PROCESS_ZERO can be verified" className="px-2 py-1 rounded-md text-[11px] flex items-center gap-1 opacity-40 cursor-not-allowed"
                            style={{ background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.35)", color: "#fca5a5" }}>
                            <Square size={10} /> Stop unavailable
                          </button>
                        )}
                        <button disabled title="Delete unavailable while Goal Mode is read-only" className="px-2 py-1 rounded-md text-[11px] flex items-center gap-1 opacity-40 cursor-not-allowed"
                          style={{ color: "var(--cream-mute)" }}>
                          <Trash2 size={10} /> Delete unavailable
                        </button>
                      </div>
                    </div>
                    <div className="px-5 py-3 border-b" style={{ borderColor: "var(--line-soft)" }}>
                      <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: "var(--cream-mute)" }}>Prompt</div>
                      <div className="text-[13px] text-[var(--cream-soft)] whitespace-pre-wrap leading-relaxed">{goal.prompt}</div>
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto scroll p-5">
                      <div className="text-[10px] uppercase tracking-widest mb-3 flex items-center gap-1.5" style={{ color: "var(--cream-mute)" }}>
                        <span>Live timeline</span>
                        {goal.status === "running" && (
                          <span className="inline-block w-1.5 h-1.5 rounded-full"
                                style={{ background: ACCENT, boxShadow: `0 0 8px ${ACCENT}`, animation: "pulse 1.6s ease-in-out infinite" }} />
                        )}
                      </div>
                      <GoalLogStream log={openGoalLog} running={goal.status === "running"} />
                    </div>
                  </>
                );
              })() : (
                <div className="p-8 text-[var(--cream-soft)] text-sm leading-relaxed max-w-prose">
                  <div className="action-title mb-2">Goal Mode</div>
                  <p className="mb-3">Existing native goal records are available for inspection. New goal execution is unavailable until this surface uses the same durable Workbench start, resume, and verified Stop contract as Chat.</p>
                  <p className="text-[var(--cream-mute)]">Pick an existing goal on the left to inspect its historical record.</p>
                </div>
              )}
            </main>
          </div>
        )}

        {/* ─── SESSIONS TAB ─── split-view: list ◀── transcript + files + preview */}
        {tab === "sessions" && (
          <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-0 h-full min-h-0">
            {/* Sessions list */}
            <aside className="border-r p-3 overflow-y-auto scroll space-y-1" style={{ borderColor: "var(--line-soft)" }}>
              <div className="flex items-center justify-between mb-2">
                <div className="action-tag" style={{ color: ACCENT }}>
                  <ListChecks size={11} className="inline mr-1" /> Sessions · {sessions.length}
                </div>
                <button onClick={refreshSessions} className="text-[var(--cream-mute)] hover:text-[var(--cream-dim)]">
                  <RefreshCw size={11} />
                </button>
              </div>
              <div className="text-[10.5px] leading-relaxed mb-2" style={{ color: "var(--cream-mute)" }}>
                Click any past Codex session → see the transcript + every file it touched. Images, videos, HTML pages preview inline.
              </div>
              {sessions.length === 0 && (
                <div className="text-[11px] text-[var(--cream-mute)] italic p-2">No sessions yet.</div>
              )}
              {sessions.map((s) => (
                <button key={s.id} onClick={() => openSessionById(s.id)}
                  className="block w-full text-left p-2.5 rounded-md border transition"
                  style={{
                    borderColor: openSession?.id === s.id ? `${ACCENT}66` : "var(--line-soft)",
                    background: openSession?.id === s.id ? `${ACCENT}10` : "transparent",
                  }}>
                  <div className="text-[12px] text-[var(--cream)] truncate">{s.threadName}</div>
                  <div className="text-[10px] text-[var(--cream-mute)] mono mt-0.5 truncate">{fmtAgo(s.updatedAt)} · {s.id.slice(0, 8)}</div>
                </button>
              ))}
            </aside>

            {/* Session detail */}
            <main className="flex flex-col min-h-0 overflow-hidden">
              {sessionLoading ? (
                <div className="p-8 text-[var(--cream-mute)] text-sm">Loading session…</div>
              ) : !openSession ? (
                <div className="p-8 text-[var(--cream-mute)] text-sm leading-relaxed max-w-prose">
                  <div className="action-title mb-2">Past sessions</div>
                  <p>Pick a session on the left. You&apos;ll see:</p>
                  <ul className="mt-2 text-[12px] space-y-1 text-[var(--cream-soft)]">
                    <li>• Every message between you and Codex</li>
                    <li>• Every tool call (commands, file edits, browser actions)</li>
                    <li>• A live file list from the session&apos;s working directory</li>
                    <li>• Click any image / video / HTML → preview right here</li>
                  </ul>
                </div>
              ) : (
                <>
                  {/* Header */}
                  <div className="px-5 py-3 border-b" style={{ borderColor: "var(--line-soft)" }}>
                    <div className="flex items-start justify-between gap-3 mb-1">
                      <div className="action-title truncate">{openSession.threadName}</div>
                      <span className="action-tag shrink-0" style={{ color: ACCENT }}>{fmtAgo(openSession.startedAt)}</span>
                    </div>
                    <div className="text-[10.5px] text-[var(--cream-mute)] mono truncate">
                      cwd: {openSession.cwd}
                      {!openSession.cwdExists && <span className="ml-2" style={{ color: "var(--plum)" }}>(no longer exists on disk)</span>}
                    </div>
                  </div>

                  {/* Scrollable body — transcript + files */}
                  <div className="flex-1 min-h-0 overflow-y-auto scroll p-4 space-y-4">
                    {/* Transcript */}
                    <section>
                      <div className="action-tag mb-2" style={{ color: "var(--cream-dim)" }}>Transcript · {openSession.turns.length} turns</div>
                      <div className="space-y-2">
                        {openSession.turns.map((t, i) => (
                          <div key={i} className={`rounded-md px-3 py-2 text-[13px] leading-relaxed border ${
                            t.role === "user"
                              ? "bg-[rgba(34,197,94,0.06)] border-[rgba(34,197,94,0.22)]"
                              : t.role === "reasoning"
                              ? "bg-[rgba(255,255,255,0.015)] border-[rgba(255,255,255,0.04)]"
                              : "bg-[rgba(255,255,255,0.02)] border-[rgba(255,255,255,0.06)]"
                          }`}>
                            <div className="text-[10px] tracking-widest uppercase opacity-60 mb-1">{t.role}</div>
                            <div className="whitespace-pre-wrap font-[var(--font-geist-mono)] text-[var(--cream)]"
                                 style={t.role === "reasoning" ? { opacity: 0.6 } : undefined}>
                              {t.text.length > 1800 ? t.text.slice(0, 1800) + "\n…[truncated]" : t.text}
                            </div>
                          </div>
                        ))}
                        {openSession.turns.length === 0 && (
                          <div className="text-[11px] text-[var(--cream-mute)] italic">No message turns captured.</div>
                        )}
                      </div>
                    </section>

                    {/* Tool calls */}
                    {openSession.toolCalls.length > 0 && (
                      <section>
                        <div className="action-tag mb-2" style={{ color: "var(--cream-dim)" }}>Tool calls · {openSession.toolCalls.length}</div>
                        <div className="space-y-1.5">
                          {openSession.toolCalls.map((tc, i) => (
                            <details key={i} className="rounded-md border" style={{ borderColor: "var(--line-soft)" }}>
                              <summary className="px-3 py-2 cursor-pointer text-[11.5px] mono" style={{ color: "var(--cream)" }}>
                                <span style={{ color: ACCENT }}>→ {tc.name}</span>
                              </summary>
                              <div className="p-3 border-t text-[10.5px] mono space-y-2" style={{ borderColor: "var(--line-soft)" }}>
                                <div>
                                  <div className="text-[var(--cream-mute)] mb-1">args</div>
                                  <pre className="whitespace-pre-wrap text-[var(--cream-soft)]">{tc.args}</pre>
                                </div>
                                {tc.output && (
                                  <div>
                                    <div className="text-[var(--cream-mute)] mb-1">output</div>
                                    <pre className="whitespace-pre-wrap text-[var(--cream-soft)]">{tc.output}</pre>
                                  </div>
                                )}
                              </div>
                            </details>
                          ))}
                        </div>
                      </section>
                    )}

                    {/* Files in cwd */}
                    {openSession.cwdFiles.length > 0 && (
                      <section>
                        <div className="action-tag mb-2" style={{ color: "var(--cream-dim)" }}>
                          Files in cwd · {openSession.cwdFiles.length}
                        </div>
                        <div className="space-y-0.5">
                          {openSession.cwdFiles.map((f) => {
                            const abs = `${openSession.cwd}/${f.relPath}`;
                            const isOpen = sessionFile?.absPath === abs;
                            return (
                              <button key={f.relPath} onClick={() => openSessionFile(abs)}
                                className="w-full flex items-center justify-between px-3 py-1.5 rounded-md text-left transition hover:bg-[rgba(255,255,255,0.02)]"
                                style={{ background: isOpen ? `${ACCENT}10` : "transparent" }}>
                                <div className="flex items-center gap-2 min-w-0">
                                  <FileText size={11} style={{ color: ACCENT }} />
                                  <span className="text-[12px] mono truncate" style={{ color: "var(--cream)" }}>{f.relPath}</span>
                                  <span className="text-[9.5px] uppercase tracking-widest ml-1" style={{ color: "var(--cream-mute)" }}>{f.kind}</span>
                                </div>
                                <div className="text-[10px] mono shrink-0 ml-2" style={{ color: "var(--cream-mute)" }}>
                                  {(f.bytes / 1024).toFixed(1)}KB
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    )}

                    {/* Referenced files (mentioned in transcript / tool args) */}
                    {openSession.referencedFiles.length > 0 && (
                      <section>
                        <div className="action-tag mb-2" style={{ color: "var(--cream-dim)" }}>
                          Referenced in transcript · {openSession.referencedFiles.length}
                        </div>
                        <div className="space-y-0.5">
                          {openSession.referencedFiles.map((p) => {
                            const isOpen = sessionFile?.absPath === p;
                            const kind = kindFromExt(p);
                            return (
                              <button key={p} onClick={() => openSessionFile(p)}
                                className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-left transition hover:bg-[rgba(255,255,255,0.02)]"
                                style={{ background: isOpen ? `${ACCENT}10` : "transparent" }}>
                                <FileText size={11} style={{ color: ACCENT }} />
                                <span className="text-[11.5px] mono truncate min-w-0 flex-1" style={{ color: "var(--cream)" }}>{p}</span>
                                <span className="text-[9.5px] uppercase tracking-widest shrink-0" style={{ color: "var(--cream-mute)" }}>{kind}</span>
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    )}
                  </div>

                  {/* Inline file preview */}
                  <AnimatePresence>
                    {sessionFile && sessionFile.url && (
                      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                        className="border-t" style={{ borderColor: `${ACCENT}30` }}>
                        <div className="flex items-center justify-between px-3 py-2 border-b"
                          style={{ borderColor: `${ACCENT}30`, background: `${ACCENT}0c` }}>
                          <div className="flex items-center gap-1.5 text-[11px] mono truncate" style={{ color: ACCENT }}>
                            <FileText size={11} />
                            <span className="truncate">{sessionFile.absPath.split("/").slice(-3).join("/")}</span>
                            <span className="ml-2 text-[10px] uppercase tracking-widest text-[var(--cream-mute)]">{sessionFile.kind}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <a href={sessionFile.url} target="_blank" rel="noopener noreferrer"
                              className="text-[var(--cream-dim)] hover:text-[var(--cream)] flex items-center gap-1 text-[10px] uppercase tracking-widest">
                              <ExternalLink size={10} /> New tab
                            </a>
                            <a href={sessionFile.url} download={sessionFile.absPath.split("/").pop()}
                              className="text-[var(--cream-dim)] hover:text-[var(--cream)] flex items-center gap-1 text-[10px] uppercase tracking-widest">
                              <Download size={10} /> Save
                            </a>
                            <button onClick={() => setSessionFile(null)} className="text-[var(--cream-dim)] hover:text-[var(--cream)]">
                              <X size={12} />
                            </button>
                          </div>
                        </div>
                        {sessionFile.kind === "image" && (
                          <a href={sessionFile.url} target="_blank" rel="noopener noreferrer" className="block bg-[rgba(0,0,0,0.6)]">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={sessionFile.url} alt={sessionFile.absPath} className="w-full max-h-[520px] object-contain" />
                          </a>
                        )}
                        {sessionFile.kind === "video" && (
                          <video src={sessionFile.url} controls preload="metadata" className="w-full max-h-[520px] bg-black" />
                        )}
                        {sessionFile.kind === "audio" && (
                          <div className="p-3 bg-[rgba(0,0,0,0.6)]"><audio src={sessionFile.url} controls className="w-full" /></div>
                        )}
                        {sessionFile.kind === "pdf" && (
                          <iframe src={sessionFile.url} title={sessionFile.absPath} className="w-full h-[520px] bg-white" />
                        )}
                        {sessionFile.kind === "text" && /\.html?$/.test(sessionFile.absPath) && (
                          <iframe src={sessionFile.url} title={sessionFile.absPath} className="w-full h-[520px] bg-white"
                            sandbox="allow-scripts allow-forms allow-popups allow-modals" />
                        )}
                        {sessionFile.kind === "text" && !/\.html?$/.test(sessionFile.absPath) && (
                          // For non-HTML text, just open in new tab — we don't want to wedge huge source dumps into this pane
                          <div className="p-4 text-[12px] text-[var(--cream-soft)]">
                            Text file — <a href={sessionFile.url} target="_blank" rel="noopener noreferrer" style={{ color: ACCENT }} className="hover:underline">open in new tab</a>.
                          </div>
                        )}
                        {sessionFile.kind === "binary" && (
                          <div className="p-4 text-[12px] text-[var(--cream-soft)]">
                            Binary file — <a href={sessionFile.url} download style={{ color: ACCENT }} className="hover:underline">download to view</a>.
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              )}
            </main>
          </div>
        )}

        {/* ─── WORKSPACE TAB ─── */}
        {tab === "workspace" && (
          <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-0 h-full min-h-0">
            <aside className="border-r p-3 space-y-2 overflow-y-auto scroll" style={{ borderColor: "var(--line-soft)" }}>
              <div className="flex items-center justify-between mb-1">
                <div className="action-tag" style={{ color: ACCENT }}>
                  <FolderOpen size={11} className="inline mr-1" /> Projects · {projects.length}
                </div>
                <button onClick={refreshProjects} className="text-[var(--cream-mute)] hover:text-[var(--cream-dim)]"><RefreshCw size={11} /></button>
              </div>
              <div className="text-[10.5px] leading-relaxed mb-2" style={{ color: "var(--cream-mute)" }}>
                Anything Codex writes during a chat lands in <code className="mono">AGENT-OS-FOLDERS/&lt;project&gt;/</code>. Goal Mode uses <code className="mono">AGENT-OS-FOLDERS/codex-goals/</code>. Click a file → preview inline.
              </div>

              {/* Create new project */}
              <div className="flex items-center gap-1.5 p-2 rounded-md border" style={{ borderColor: "var(--line-soft)" }}>
                <input
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="Project creation unavailable"
                  className="flex-1 bg-transparent outline-none text-[11px] mono"
                  style={{ color: "var(--cream)" }} />
                <button disabled title="Project creation is unavailable until it is routed through Workbench"
                  className="px-2 py-1 rounded-md text-[10px] uppercase tracking-widest disabled:opacity-40 transition"
                  style={{ background: `${ACCENT}28`, border: `1px solid ${ACCENT}66`, color: ACCENT }}>
                  <FilePlus size={10} className="inline mr-0.5" /> Unavailable
                </button>
              </div>
              <div className="text-[10px] text-amber-200/80">Read-only project browser · creation requires Workbench cutover</div>

              {projects.length === 0 && (
                <div className="text-[11px] text-[var(--cream-mute)] italic p-2">
                  No projects yet. Send a prompt in Chat — Codex will write to the active project, then it&apos;ll appear here.
                </div>
              )}
              {projects.map((p) => (
                // div, not button — inner "Set active" button can't be a child
                // of an outer <button> (hydration error).
                <div key={p.name}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectProject(p)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectProject(p); } }}
                  className="block w-full text-left p-3 rounded-md border transition cursor-pointer focus:outline-none focus:ring-1 focus:ring-[var(--cream-mute)]"
                  style={{
                    borderColor: selected?.name === p.name ? `${ACCENT}66` : "var(--line-soft)",
                    background: selected?.name === p.name ? `${ACCENT}10` : "transparent",
                  }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] text-[var(--cream)] truncate">{p.name}</span>
                    {activeProject === p.name && (
                      <span className="text-[9px] uppercase tracking-widest shrink-0" style={{ color: ACCENT }}>active</span>
                    )}
                  </div>
                  <div className="text-[10px] text-[var(--cream-mute)] mono mt-0.5">{p.fileCount} files · {fmtAgo(p.mtime)}</div>
                  {activeProject !== p.name && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setActiveProject(p.name); }}
                      className="mt-2 text-[10px] uppercase tracking-widest hover:underline"
                      style={{ color: "var(--cream-mute)" }}>
                      Set active →
                    </button>
                  )}
                </div>
              ))}
            </aside>
            <main className="flex flex-col min-h-0 overflow-hidden">
              {!selected ? (
                <div className="p-6 text-[var(--cream-mute)] text-sm">Pick a project on the left.</div>
              ) : (
                <>
                  <div className="px-4 py-2.5 border-b flex items-center justify-between" style={{ borderColor: "var(--line-soft)" }}>
                    <div className="min-w-0">
                      <div className="text-[13px] text-[var(--cream)] truncate">{selected.name}</div>
                      <div className="text-[10.5px] text-[var(--cream-mute)] mono truncate">{selected.root}</div>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto scroll p-2 space-y-0.5">
                    {files.map((f) => (
                      <button key={f.relPath} onClick={() => loadFile(f)}
                        className="w-full flex items-center justify-between px-3 py-2 rounded-md text-left transition hover:bg-[rgba(255,255,255,0.02)]"
                        style={{ background: open?.path === f.relPath ? `${ACCENT}10` : "transparent" }}>
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText size={11} style={{ color: ACCENT }} />
                          <span className="text-[12px] mono truncate" style={{ color: "var(--cream)" }}>{f.relPath}</span>
                          <span className="text-[10px] uppercase tracking-widest ml-1" style={{ color: "var(--cream-mute)" }}>{f.kind}</span>
                        </div>
                        <div className="text-[10px] mono shrink-0 ml-2" style={{ color: "var(--cream-mute)" }}>
                          {(f.bytes / 1024).toFixed(1)}KB · {fmtAgo(f.mtime)}
                        </div>
                      </button>
                    ))}
                  </div>
                  <AnimatePresence>
                    {open && (
                      <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                        className="border-t" style={{ borderColor: `${ACCENT}30` }}>
                        <div className="flex items-center justify-between px-3 py-2 border-b"
                          style={{ borderColor: `${ACCENT}30`, background: `${ACCENT}0c` }}>
                          <div className="flex items-center gap-1.5 text-[11px] mono truncate" style={{ color: ACCENT }}>
                            <FileText size={11} /><span className="truncate">{open.path}</span>
                            <span className="ml-2 text-[10px] uppercase tracking-widest text-[var(--cream-mute)]">{open.kind}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {/\.html?$/.test(open.path) && (
                              <>
                                <div className="flex items-center rounded-md overflow-hidden border" style={{ borderColor: `${ACCENT}40` }}>
                                  <button onClick={() => setHtmlMode("preview")}
                                    className="text-[10px] uppercase tracking-widest px-2 py-1 transition"
                                    style={{
                                      background: htmlMode === "preview" ? `${ACCENT}28` : "transparent",
                                      color: htmlMode === "preview" ? ACCENT : "var(--cream-dim)",
                                    }}><Eye size={10} className="inline mr-1" />Preview</button>
                                  <button onClick={() => setHtmlMode("source")}
                                    className="text-[10px] uppercase tracking-widest px-2 py-1 transition"
                                    style={{
                                      background: htmlMode === "source" ? `${ACCENT}28` : "transparent",
                                      color: htmlMode === "source" ? ACCENT : "var(--cream-dim)",
                                    }}><FileText size={10} className="inline mr-1" />Source</button>
                                </div>
                                <a href={rawUrl(open.path)} target="_blank" rel="noopener noreferrer"
                                  className="text-[var(--cream-dim)] hover:text-[var(--cream)] flex items-center gap-1 text-[10px] uppercase tracking-widest">
                                  <ExternalLink size={10} /> New tab
                                </a>
                              </>
                            )}
                            {open.kind === "text" && (
                              <button onClick={() => navigator.clipboard?.writeText(open.content)}
                                className="text-[var(--cream-dim)] hover:text-[var(--cream)] flex items-center gap-1 text-[10px] uppercase tracking-widest">
                                <Copy size={10} /> Copy
                              </button>
                            )}
                            <a href={rawUrl(open.path)} download={open.path.split("/").pop()}
                              className="text-[var(--cream-dim)] hover:text-[var(--cream)] flex items-center gap-1 text-[10px] uppercase tracking-widest">
                              <Download size={10} /> Save
                            </a>
                            <button onClick={() => setOpen(null)} className="text-[var(--cream-dim)] hover:text-[var(--cream)]"><X size={12}/></button>
                          </div>
                        </div>
                        {open.kind === "text" && (() => {
                          const isHtml = /\.html?$/.test(open.path);
                          if (isHtml && htmlMode === "preview") {
                            return <iframe src={rawUrl(open.path)} title={open.path} className="w-full h-[520px] bg-white" sandbox="allow-scripts allow-forms allow-popups allow-modals" />;
                          }
                          return (
                            <pre className="scroll p-3 text-[12px] leading-relaxed text-[var(--cream)] whitespace-pre-wrap font-[var(--font-geist-mono)] max-h-[440px] overflow-auto">
                              {open.content}
                            </pre>
                          );
                        })()}
                        {open.kind === "image" && (
                          <a href={rawUrl(open.path)} target="_blank" rel="noopener noreferrer" className="block bg-[rgba(0,0,0,0.6)]">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={rawUrl(open.path)} alt={open.path} className="w-full max-h-[520px] object-contain" />
                          </a>
                        )}
                        {open.kind === "video" && (
                          <video src={rawUrl(open.path)} controls preload="metadata" className="w-full max-h-[520px] bg-black" />
                        )}
                        {open.kind === "audio" && (
                          <div className="p-3 bg-[rgba(0,0,0,0.6)]"><audio src={rawUrl(open.path)} controls className="w-full" /></div>
                        )}
                        {open.kind === "pdf" && (
                          <iframe src={rawUrl(open.path)} title={open.path} className="w-full h-[520px] bg-white" />
                        )}
                        {open.kind === "binary" && (
                          <div className="p-4 text-[12px] text-[var(--cream-soft)]">
                            Binary file — <a href={rawUrl(open.path)} download={open.path.split("/").pop()} style={{ color: ACCENT }} className="hover:underline">download to view</a>.
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              )}
            </main>
          </div>
        )}
      </div>
    </div></AgentWorkspaceShell>
  );
}
