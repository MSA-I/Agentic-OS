"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Square, Zap, AlertTriangle } from "lucide-react";
import AgentAvatar, { agentColor, agentLabel, type AgentKey } from "./AgentAvatar";
import VoiceButton from "./VoiceButton";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import HermesPet, { usePetState } from "./HermesPet";
import type { WorkspaceNavDetail, WorkspaceProjectRef, WorkspaceSessionRef } from "./AgentWorkspaceShell";
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
  readVolatileText,
  readVolatileValue,
  writeVolatileText,
  writeVolatileValue,
} from "@/lib/workbench/volatileClientState";

// Render an agent reply as formatted markdown (bold, lists, code, links) instead
// of raw text with visible ** asterisks. User messages stay plain.
function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

interface Msg { role: "user" | "assistant"; agent?: AgentKey; text: string; ts: number; }

// Raw conversation content and drafts are intentionally document-memory only.
// Hermes additionally namespaces by profile so in-memory threads do not mix.
const conversationMemoryKey = (agent: AgentKey, sessionPath: string, sub?: string) =>
  `conversation:${agent}${sub ? `:${sub}` : ""}:${sessionPath}`;
const draftMemoryKey = (sessionPath: string) => `draft:claude:${sessionPath}`;

function safeContext(raw: string | null): { project: WorkspaceProjectRef | null; session: WorkspaceSessionRef | null } {
  if (!raw) return { project: null, session: null };
  try {
    const value = JSON.parse(raw) as { project?: WorkspaceProjectRef; session?: WorkspaceSessionRef };
    return { project: value.project ?? null, session: value.session ?? null };
  } catch { return { project: null, session: null }; }
}

// Accent colors for the Hermes profile pills (mirrors HermesProfiles.tsx).
function profileAccent(name: string): string {
  if (name.startsWith("seo-keywords")) return "#fbbf24";
  if (name.startsWith("seo-outline")) return "#8b5cf6";
  if (name.startsWith("seo-writer")) return "#5ab896";
  if (name.startsWith("seo-links")) return "#f472b6";
  if (name === "julian") return "#d4a574";
  return "#60a5fa";
}

interface Props {
  defaultAgent?: AgentKey;
  showAgentSwitcher?: boolean;
  height?: string;
}

export default function UnifiedChat({
  defaultAgent = "claude",
  showAgentSwitcher = true,
  height = "min(72vh, 800px)",
}: Props) {
  const [agent, setAgent] = useState<AgentKey>(defaultAgent);
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState("");
  const [sendError, setSendError] = useState("");
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const activeRunRef = useRef<Run | null>(null);
  const [stopState, setStopState] = useState<WorkbenchStopState>("not_requested");
  // Elapsed seconds counter, for non-streaming agents where you can't see token-by-token progress.
  const [elapsedMs, setElapsedMs] = useState(0);
  const startMsRef = useRef<number>(0);
  const ctrlRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const interimRef = useRef<string>("");

  // Hermes profile switcher — chat as any employee (each gets its own thread).
  const [hermesProfile, setHermesProfile] = useState("");
  const [hermesProfileReady, setHermesProfileReady] = useState(false);
  const [hermesProfiles, setHermesProfiles] = useState<string[]>([]);
  const [openclawAgent, setOpenclawAgent] = useState("main");
  const [openclawAgents, setOpenclawAgents] = useState<string[]>([]);
  const [workspaceProject, setWorkspaceProject] = useState<WorkspaceProjectRef | null>(null);
  const [workspaceSession, setWorkspaceSession] = useState<WorkspaceSessionRef | null>(null);
  const localWorkspaceSession = workspaceSession?.source === "local" || workspaceSession?.path.startsWith("local:");
  const readOnlyConversation = agent === "antigravity"
    && Boolean(workspaceSession)
    && !localWorkspaceSession
    && workspaceSession?.resumable !== true;
  const executionUnavailable = agent !== "claude";
  useEffect(() => {
    purgeLegacySensitiveBrowserState();
  }, []);
  useEffect(() => {
    if (agent !== "hermes") return;
    try { setHermesProfile(localStorage.getItem("agentic-os-hermes-profile") ?? ""); }
    catch { setHermesProfile(""); }
    finally { setHermesProfileReady(true); }
  }, [agent]);
  useEffect(() => {
    if (agent !== "hermes") return;
    fetch("/api/hermes/profiles", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { profiles?: { name: string }[] }) => {
        const names = (j.profiles ?? []).map((p) => p.name).filter((n) => n !== "default" && !n.startsWith("swarm"));
        setHermesProfiles(names);
        // Drop a stale selection (a profile that no longer exists on this machine) so we
        // never keep sending a dead `--profile` that fails every message.
        setHermesProfile((cur) => (cur && !names.includes(cur) ? "" : cur));
      })
      .catch(() => {});
  }, [agent]);
  useEffect(() => {
    if (agent !== "hermes" || !hermesProfileReady) return;
    try { localStorage.setItem("agentic-os-hermes-profile", hermesProfile); } catch {}
  }, [agent, hermesProfile, hermesProfileReady]);
  useEffect(() => {
    if (agent !== "openclaw") return;
    fetch("/api/vitals", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { openclaw?: { agents?: string[] } }) => {
        const names = (j.openclaw?.agents ?? []).filter(Boolean);
        setOpenclawAgents(names);
        if (names.length && !names.includes(openclawAgent)) setOpenclawAgent(names[0]);
      })
      .catch(() => {});
  }, [agent, openclawAgent]);
  async function loadWorkspaceConversation(project: WorkspaceProjectRef | null, session: WorkspaceSessionRef | null, forceFresh = false) {
    setWorkspaceProject(project);
    setWorkspaceSession(session);
    setPartial("");
    setSendError("");
    activeRunRef.current = null;
    setActiveRun(null);
    setStopState("not_requested");
    if (agent === "claude" && session && !forceFresh) {
      setInput(readVolatileText(draftMemoryKey(session.path)));
    } else {
      setInput("");
    }
    if (agent === "hermes" && project) {
      const profile = project.scope ?? project.id;
      setHermesProfile(profile === "default" ? "" : profile);
    }
    if (agent === "openclaw" && project) setOpenclawAgent((project.scope ?? project.id.replace(/^agent:/, "")) || "main");
    try {
      if (forceFresh || !session) {
        setMsgs([]);
      } else if (session.source === "local" || session.path.startsWith("local:")) {
        setMsgs(readVolatileValue<Msg[]>(conversationMemoryKey(agent, session.path)) ?? []);
      } else {
        const response = await fetch(`/api/agent-history?agent=${agent}&path=${encodeURIComponent(session.path)}`, { cache: "no-store" });
        const payload = await response.json();
        const turns = Array.isArray(payload.detail?.turns) ? payload.detail.turns : [];
        setMsgs(turns.filter((turn: { role?: string; text?: string }) => (turn.role === "user" || turn.role === "assistant") && turn.text)
          .map((turn: { role: "user" | "assistant"; text: string }) => ({ role: turn.role, text: turn.text, ts: Date.now(), agent: turn.role === "assistant" ? agent : undefined })));
      }
    } catch { setMsgs([]); }
  }

  // Restore the active project/session selected in the native sidebar.
  useEffect(() => {
    const context = safeContext(localStorage.getItem(`agentic-os:${agent}:conversation-context:v2`));
    void loadWorkspaceConversation(context.project, context.session, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  useEffect(() => {
    const onNav = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceNavDetail>).detail;
      if (detail?.agent !== agent) return;
      if (detail.action === "new") void loadWorkspaceConversation(detail.project ?? null, detail.session ?? null, true);
      else if (detail.action === "select") void loadWorkspaceConversation(detail.project ?? null, detail.session ?? null, false);
      else if (detail.action === "project") {
        setWorkspaceProject(detail.project ?? null);
        setWorkspaceSession(null);
        setMsgs([]); setPartial(""); setInput("");
      }
    };
    window.addEventListener("agent-workspace-nav", onNav);
    return () => window.removeEventListener("agent-workspace-nav", onNav);
  // Project selection is the source of truth for the active conversation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  // Keep raw local conversations available only while this browser document lives.
  useEffect(() => {
    if (!workspaceSession?.path) return;
    writeVolatileValue(conversationMemoryKey(agent, workspaceSession.path), msgs.slice(-200));
  }, [msgs, agent, workspaceSession?.path]);

  useEffect(() => {
    if (agent !== "claude" || streaming || !workspaceSession?.path) return;
    writeVolatileText(draftMemoryKey(workspaceSession.path), input);
  }, [agent, input, streaming, workspaceSession?.path]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, partial]);

  async function send(voicePrompt?: string) {
    const prompt = (voicePrompt ?? input).trim();
    if (!prompt || streaming || !workspaceProject || !workspaceSession || readOnlyConversation || executionUnavailable) return;
    const userMsg: Msg = { role: "user", text: prompt, ts: Date.now() };
    setMsgs((m) => [...m, userMsg]);
    if (!voicePrompt) setInput("");
    setPartial("");
    setSendError("");
    setStreaming(true);
    setStopState("not_requested");
    interimRef.current = "";

    // Elapsed timer for non-streaming agents
    startMsRef.current = Date.now();
    setElapsedMs(0);
    const tick = setInterval(() => setElapsedMs(Date.now() - startMsRef.current), 250);

    let reply = "";

    let completed = true;
    try {
      reply = await streamClaude(prompt);
    } catch (e) {
      if (agent === "claude") {
        completed = false;
        setInput(prompt);
        if (workspaceSession?.path) writeVolatileText(draftMemoryKey(workspaceSession.path), prompt);
        setSendError(describeWorkbenchError(e));
      } else {
        reply = `[error: ${String(e)}]`;
      }
    } finally {
      clearInterval(tick);
      ctrlRef.current = null;
    }

    if (completed) {
      setMsgs((m) => [...m, { role: "assistant", agent, text: reply || "(no output)", ts: Date.now() }]);
      if (agent === "claude" && workspaceSession?.path) {
        writeVolatileText(draftMemoryKey(workspaceSession.path), "");
      }
    }
    setPartial("");
    setStreaming(false);

  }

  async function streamClaude(prompt: string): Promise<string> {
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    let acc = "";
    const sessionId = workspaceSession?.source === "native" || workspaceSession?.nativeStarted
      ? (workspaceSession.nativeId || workspaceSession.id)
      : null;
    const result = await executeWorkbenchRun({
      agentId: "claude",
      prompt,
      projectId: workspaceProject?.id || "claude-default",
      sessionId,
      idempotencyKey: createWorkbenchIdempotencyKey("claude"),
    }, {
      onStarted: ({ run }) => {
        activeRunRef.current = run;
        setActiveRun(run);
      },
      onOutput: (text) => {
        acc += text;
        setPartial(acc);
      },
    }, ctrl.signal);
    activeRunRef.current = result.run;
    setActiveRun(result.run);
    setStopState(result.stop.state);
    if (result.run.context.sessionId) rememberNativeId(result.run.context.sessionId);
    if (result.run.status === "succeeded") {
      return acc || "Run completed without a text response.";
    }
    if (isVerifiedCancellation(result)) {
      setSendError("Stopped and verified. The process tree is no longer running.");
      return acc || "Stopped and verified.";
    }
    throw new Error(result.run.error?.message ?? `Run ended as ${result.run.status}.`);
  }

  async function stop() {
    if (agent !== "claude") return;
    const run = activeRunRef.current;
    if (!run) {
      ctrlRef.current?.abort();
      setStreaming(false);
      setPartial("");
      return;
    }
    if (stopState === "stopping") return;
    setStopState("stopping");
    setSendError("Stop requested. Waiting for verified process-tree termination.");
    try {
      const snapshot = await cancelWorkbenchRun(run, (next) => {
        activeRunRef.current = next.run;
        setActiveRun(next.run);
        setStopState(next.stop.state);
      });
      activeRunRef.current = snapshot.run;
      setActiveRun(snapshot.run);
      setStopState(snapshot.stop.state);
      setSendError(isVerifiedCancellation(snapshot)
        ? "Stopped and verified. The process tree is no longer running."
        : `Run ended as ${snapshot.run.status}.`);
    } catch (error) {
      setStopState("failed_to_stop");
      setSendError(describeWorkbenchError(error, false));
    }
  }

  function rememberNativeId(nativeId: string) {
    if (!workspaceSession?.path || !nativeId) return;
    setWorkspaceSession((current) => current ? { ...current, nativeId, nativeStarted: true, resumable: true } : current);
    window.dispatchEvent(new CustomEvent("agent-conversation-native-id", { detail: {
      agent, sessionPath: workspaceSession.path, nativeId,
    } }));
  }

  function handleVoice(t: string, opts: { final: boolean }) {
    if (readOnlyConversation) return;
    if (opts.final) {
      const base = (interimRef.current ? input.replace(/\s*\[voice\][^]*$/, "") : input);
      interimRef.current = "";
      const next = (base + (base.endsWith(" ") || base.length === 0 ? "" : " ") + t).trim();
      setInput(next);
    } else {
      // Show interim with marker
      interimRef.current = t;
      const base = input.replace(/\s*\[voice\][^]*$/, "");
      setInput(`${base}${base.length ? " " : ""}[voice] ${t}`.trim());
    }
  }

  function clearChat() {
    if (!workspaceSession?.path) return;
    if (!confirm(`Clear ${agentLabel(agent)} chat history?`)) return;
    setMsgs([]);
    setPartial("");
    clearVolatileValue(conversationMemoryKey(agent, workspaceSession.path));
  }

  const accent = agentColor(agent);
  const accentText = agent === "claude"
    ? "#8C3D26"
    : agent === "codex"
      ? "#D9D9E8"
      : accent;

  const petState = usePetState(streaming);

  return (
    <div data-unified-chat={agent} className="panel flex flex-col overflow-hidden relative" style={{ height }}>
      {/* Animated Hermes pet — mirrors the agent's live state (idle / thinking / done / failed) */}
      {agent === "hermes" && (
        <div className="hermes-pet-dock">
          <HermesPet state={petState} height={104} />
          <span className="pet-state">{petState === "running" ? "thinking" : petState}</span>
        </div>
      )}
      {/* Top: agent switcher */}
      <div data-chat-header className="flex items-center justify-between px-5 py-3 border-b border-[var(--panel-border)]">
        <div className="flex items-center gap-2">
          {showAgentSwitcher ? (
            (["claude", "openclaw", "hermes", "antigravity"] as AgentKey[]).map((a) => {
              const active = agent === a;
              const ac = agentColor(a);
              return (
                <button
                  key={a}
                  onClick={() => { if (!streaming) setAgent(a); }}
                  disabled={streaming}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-full border transition disabled:opacity-50"
                  style={{
                    background: active ? `${ac}1f` : "transparent",
                    borderColor: active ? ac : "var(--panel-border)",
                    color: active ? "var(--fg)" : "var(--fg-dim)",
                  }}
                  title={`Switch to ${agentLabel(a)}`}
                >
                  <AgentAvatar agent={a} size={22} />
                  <span className="text-[12.5px] font-medium">{agentLabel(a)}</span>
                </button>
              );
            })
          ) : (
            <div className="flex items-center gap-2">
              <AgentAvatar agent={agent} size={26} pulse={streaming} />
            <span className="text-sm font-medium" style={{ color: accentText }}>{agentLabel(agent)}</span>
              {agent === "hermes" && hermesProfile && (
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full border"
                  style={{ color: profileAccent(hermesProfile), borderColor: `${profileAccent(hermesProfile)}55` }}>
                  {hermesProfile}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Ultracode stays unavailable until the Tool Gateway ships. */}
          {agent === "claude" && (
            <>
              <span
                className="hidden lg:inline-flex px-2.5 py-1.5 rounded-full border text-[10px] uppercase tracking-widest"
                style={{ borderColor: "var(--panel-border)", color: "var(--fg-dim)" }}
              >
                {activeRun ? workbenchRunLabel(activeRun, stopState) : "Ready"}
              </span>
              <span
                className="hidden md:inline-flex px-2.5 py-1.5 rounded-full border text-[10px] uppercase tracking-widest"
                style={{ borderColor: "var(--panel-border)", color: "var(--fg-dim)" }}
              >
                Tools disabled
              </span>
              <button
                disabled
                title="Unavailable · Tool Gateway required"
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[11px] uppercase tracking-widest opacity-55 cursor-not-allowed"
                style={{ borderColor: "var(--panel-border)", background: "transparent", color: "var(--fg-dim)" }}
              >
                <Zap size={11} />
                Ultracode · unavailable
              </button>
            </>
          )}
          {msgs.length > 0 && (
            <button
              onClick={clearChat}
              className="text-[10px] uppercase tracking-widest text-[var(--fg-dimmer)] hover:text-rose-300 transition"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Hermes staff switcher — chat as any profile, each with its own thread */}
      {agent === "hermes" && hermesProfiles.length > 0 && (
        <div className="flex items-center gap-1.5 px-5 py-2 border-b border-[var(--panel-border)] overflow-x-auto">
          <span className="text-[10px] uppercase tracking-widest shrink-0 mr-1" style={{ color: "var(--fg-dimmer)" }}>Profile</span>
          <button
            onClick={() => { if (!streaming) setHermesProfile(""); }}
            disabled={streaming}
            className="px-2.5 py-1 rounded-full border text-[11.5px] font-medium transition disabled:opacity-50 shrink-0"
            style={{
              borderColor: !hermesProfile ? "#60a5fa" : "var(--panel-border)",
              background: !hermesProfile ? "rgba(96,165,250,0.16)" : "transparent",
              color: !hermesProfile ? "var(--fg)" : "var(--fg-dim)",
            }}
          >
            default
          </button>
          {hermesProfiles.map((p) => {
            const active = hermesProfile === p;
            const pc = profileAccent(p);
            return (
              <button
                key={p}
                onClick={() => { if (!streaming) setHermesProfile(p); }}
                disabled={streaming}
                className="px-2.5 py-1 rounded-full border text-[11.5px] font-medium transition disabled:opacity-50 shrink-0"
                style={{
                  borderColor: active ? pc : "var(--panel-border)",
                  background: active ? `${pc}1f` : "transparent",
                  color: active ? "var(--fg)" : "var(--fg-dim)",
                }}
                title={`Chat as ${p} — separate thread`}
              >
                {p}
              </button>
            );
          })}
        </div>
      )}
      {agent === "openclaw" && openclawAgents.length > 0 && (
        <div className="flex items-center gap-1.5 px-5 py-2 border-b border-[var(--panel-border)] overflow-x-auto">
          <span className="text-[10px] uppercase tracking-widest shrink-0 mr-1" style={{ color: "var(--fg-dimmer)" }}>Agent</span>
          {openclawAgents.map((name) => {
            const active = openclawAgent === name;
            return (
              <button key={name} onClick={() => { if (!streaming) setOpenclawAgent(name); }} disabled={streaming}
                className="px-2.5 py-1 rounded-full border text-[11.5px] font-medium transition disabled:opacity-50 shrink-0"
                style={{ borderColor: active ? "#f472b6" : "var(--panel-border)", background: active ? "rgba(244,114,182,0.16)" : "transparent", color: active ? "var(--fg)" : "var(--fg-dim)" }}
                title={`Chat with OpenClaw agent ${name} — separate thread`}>
                {name}
              </button>
            );
          })}
        </div>
      )}
      {/* No profiles yet → tell the member the swap bar exists + how to populate it (it's per-user,
          read from THEIR ~/.hermes/profiles — so it's empty until they create some). */}
      {agent === "hermes" && hermesProfiles.length === 0 && (
        <div className="px-5 py-2 border-b border-[var(--panel-border)] text-[11px] leading-snug text-[var(--fg-dimmer)]">
          <span className="uppercase tracking-widest mr-1" style={{ color: "var(--fg-dimmer)" }}>Profile</span>
          Chatting as Hermes&rsquo; default. Add profiles in <code>~/.hermes/profiles/</code> — each is a separate AI &ldquo;employee&rdquo; with its own model &amp; memory — and a quick-swap bar appears right here. Guide: <code>install/4-HERMES.md</code>.
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="scroll flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3"
        tabIndex={0}
        aria-label="Conversation messages"
      >
        <AnimatePresence initial={false}>
          {msgs.length === 0 && !streaming && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="h-full grid place-items-center text-center"
            >
              <div className="max-w-xl" data-agent-empty-state={agent}>
                {agent !== "hermes" && <div className="mx-auto mb-3"><AgentAvatar agent={agent} size={56} /></div>}
                <h3 className={agent === "hermes" ? "hermes-agent-title" : "text-lg font-medium"} style={{ color: accentText }}>
                  {agent === "hermes" ? "HERMES AGENT" : agent === "claude" ? "Welcome back, Moshe" : `Chat with ${agentLabel(agent)}`}
                </h3>
                <p className="mt-2 text-sm text-[var(--fg-dim)] leading-relaxed">
                  {agent === "hermes"
                    ? "Drop a file path, a traceback, or a rough idea. I’ll investigate, suggest next steps, and keep things reversible."
                    : <>Type or use the mic. Draft and local transcript content stay in memory for this browser session only.</>}
                </p>
                <div className="mt-4 flex items-center justify-center gap-2 text-[11px] text-[var(--fg-dimmer)]">
                  <kbd className="px-1.5 py-0.5 rounded border border-[var(--panel-border)]">⌘+Enter</kbd>
                  <span>send</span>
                  <span>·</span>
                  <kbd className="px-1.5 py-0.5 rounded border border-[var(--panel-border)]">Esc</kbd>
                  <span>stop</span>
                </div>
              </div>
            </motion.div>
          )}

          {msgs.map((m, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              className={`flex gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}
            >
              {m.role === "assistant" && m.agent && (
                <AgentAvatar agent={m.agent} size={32} />
              )}
              {m.role === "user" && (
                <div className="w-8 h-8 rounded-full grid place-items-center shrink-0 text-[10px] uppercase tracking-widest text-[var(--fg-dim)] border border-[var(--panel-border)]">
                  you
                </div>
              )}
              <div
                className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap ${
                  m.role === "user"
                    ? "rounded-tr-md bg-[rgba(255,255,255,0.05)] border border-[var(--panel-border)] text-[var(--fg)]"
                    : "rounded-tl-md border"
                }`}
                style={
                  m.role === "assistant"
                    ? {
                  background: `${agentColor(m.agent!)}10`,
                        borderColor: `${agentColor(m.agent!)}40`,
                        color: "var(--fg)",
                      }
                    : undefined
                }
              >
                {m.role === "assistant" ? <ChatMarkdown text={m.text} /> : m.text}
              </div>
            </motion.div>
          ))}

          {streaming && (
            <motion.div
              key="partial"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="flex gap-3"
            >
              <AgentAvatar agent={agent} size={32} pulse />
              <div
                className="max-w-[78%] rounded-2xl rounded-tl-md px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap border"
                style={{
                  background: `${accent}10`,
                  borderColor: `${accent}40`,
                  color: "var(--fg)",
                }}
              >
                {partial ? (
                  <ChatMarkdown text={partial} />
                ) : (
                  <span className="inline-flex items-center gap-2 text-[var(--fg-dim)]">
                    <span className="inline-flex items-center">
                      <span className="tick live" style={{ color: accent }} />
                      <span className="tick live" style={{ color: accent, animationDelay: ".15s" }} />
                      <span className="tick live" style={{ color: accent, animationDelay: ".3s" }} />
                    </span>
                    <span>
                      {agentLabel(agent)} thinking
                      {agent !== "claude" && elapsedMs > 0 && (
                        <span className="ml-2 font-[var(--font-geist-mono)] text-[12px]" style={{ color: accentText }}>
                          {Math.floor(elapsedMs / 1000)}s
                        </span>
                      )}
                    </span>
                    {agent !== "claude" && elapsedMs > 30_000 && (
                      <span className="text-[11px] text-amber-300/80 ml-1">
                        (slow model, usually 20–40s)
                      </span>
                    )}
                  </span>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Composer */}
      <div className="border-t border-[var(--panel-border)] p-3">
        {agent === "claude" && sendError && (
          <div
            role="status"
            className="mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-snug"
            style={{ borderColor: "rgba(217,119,87,0.38)", background: "rgba(217,119,87,0.08)", color: "var(--fg-dim)" }}
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" style={{ color: "#8C3D26" }} />
            <span>{sendError}</span>
          </div>
        )}
        {readOnlyConversation && (
          <div
            role="status"
            className="mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-snug"
            style={{ borderColor: "rgba(148,163,184,0.38)", background: "rgba(148,163,184,0.08)", color: "var(--fg-dim)" }}
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span><strong className="text-[var(--fg)]">Read only.</strong> This native Antigravity conversation can be viewed here, but the installed CLI cannot resume it. Start a new mission in the same workspace to continue.</span>
          </div>
        )}
        {executionUnavailable && (
          <div
            role="status"
            className="mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-snug"
            style={{ borderColor: "rgba(251,191,36,0.38)", background: "rgba(251,191,36,0.08)", color: "var(--fg-dim)" }}
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" />
            <span><strong className="text-[var(--fg)]">Execution unavailable.</strong> {agentLabel(agent)} history and setup remain visible, but start/resume/stop stay disabled until the provider is cut over to Workbench.</span>
          </div>
        )}
        <div
          className="flex items-end gap-2 rounded-2xl border bg-[rgba(0,0,0,0.25)] p-2 focus-within:border-[var(--panel-border-hot)] transition"
          style={{ borderColor: "var(--panel-border)" }}
        >
          <VoiceButton onTranscript={handleVoice} size={38} disabled={executionUnavailable || readOnlyConversation || !workspaceProject || !workspaceSession} />
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
              if (e.key === "Escape" && streaming) void stop();
            }}
            rows={2}
            disabled={executionUnavailable || !workspaceProject || !workspaceSession || readOnlyConversation}
            placeholder={executionUnavailable
              ? `${agentLabel(agent)} execution unavailable until Workbench cutover`
              : readOnlyConversation
              ? "Read-only native conversation"
              : workspaceProject && workspaceSession
              ? `Message ${agentLabel(agent)}… (⌘+Enter)`
              : workspaceProject
                ? `Start a new conversation in ${workspaceProject.label}`
                : "Choose a project to start"}
            className="flex-1 bg-transparent outline-none resize-none px-2 py-2 text-[14px] text-[var(--fg)] placeholder:text-[var(--fg-dimmer)]"
          />
          {streaming ? (
            <button
              onClick={() => void stop()}
              disabled={agent === "claude" && stopState === "stopping"}
              className="px-3 h-[38px] rounded-lg bg-[rgba(248,113,113,0.18)] border border-[rgba(248,113,113,0.45)] text-rose-300 text-sm flex items-center gap-1.5 hover:bg-[rgba(248,113,113,0.28)] transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Square size={14} /> {agent === "claude" && stopState === "stopping" ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button
              onClick={() => send()}
              disabled={executionUnavailable || !input.trim() || !workspaceProject || !workspaceSession || readOnlyConversation}
              className="px-3 h-[38px] rounded-lg flex items-center gap-1.5 text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: `${accent}24`,
                border: `1px solid ${accent}55`,
                  color: accentText,
              }}
            >
              <Send size={14} /> Send
            </button>
          )}
        </div>
        <div className="mt-1.5 px-1 flex items-center justify-between text-[10px] text-[var(--fg-dimmer)] uppercase tracking-widest">
          <span>content kept in memory only</span>
          {agent !== "claude" && (
            <span className="text-amber-400/80">
              Workbench lifecycle required
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
