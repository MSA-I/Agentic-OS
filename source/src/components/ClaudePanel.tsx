"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Square, Sparkles, Zap, AlertTriangle } from "lucide-react";
import Panel from "./Panel";
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
import { purgeLegacySensitiveBrowserState, readVolatileText, writeVolatileText } from "@/lib/workbench/volatileClientState";

interface Msg { role: "user" | "assistant" | "system"; text: string; }

export default function ClaudePanel() {
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const activeRunRef = useRef<Run | null>(null);
  const [stopState, setStopState] = useState<WorkbenchStopState>("not_requested");
  const [nativeSessionId, setNativeSessionId] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const draftKey = "draft:claude:claude-default:new";
  const nativeSessionKey = "agent-os:workbench:native-session:v1:claude:claude-default";

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, partial]);

  useEffect(() => {
    try {
      purgeLegacySensitiveBrowserState();
      setInput(readVolatileText(draftKey));
      setNativeSessionId(localStorage.getItem(nativeSessionKey));
    } catch { /* optional */ }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => writeVolatileText(draftKey, input), 180);
    return () => window.clearTimeout(timeout);
  }, [input]);

  async function send() {
    const prompt = input.trim();
    if (!prompt || streaming) return;
    setMsgs((m) => [...m, { role: "user", text: prompt }]);
    setInput("");
    setPartial("");
    setError("");
    setStreaming(true);
    setStopState("not_requested");

    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    let acc = "";

    try {
      const result = await executeWorkbenchRun({
        agentId: "claude",
        prompt,
        projectId: "claude-default",
        sessionId: nativeSessionId,
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
      if (result.run.context.sessionId) {
        setNativeSessionId(result.run.context.sessionId);
        try { localStorage.setItem(nativeSessionKey, result.run.context.sessionId); } catch { /* state remains authoritative */ }
      }
      if (result.run.status !== "succeeded") {
        if (!isVerifiedCancellation(result)) setInput(prompt);
        setError(result.run.error?.message ?? `Run ended as ${result.run.status}. Your draft was kept.`);
      }
    } catch (caught) {
      setInput(prompt);
      setError(describeWorkbenchError(caught));
    }

    setMsgs((m) => [...m, { role: "assistant", text: acc || "(no output)" }]);
    setPartial("");
    setStreaming(false);
    ctrlRef.current = null;
  }

  async function stop() {
    const run = activeRunRef.current;
    if (!run || stopState === "stopping") return;
    setStopState("stopping");
    setError("Stop requested. Waiting for verified process-tree termination.");
    try {
      const snapshot = await cancelWorkbenchRun(run, (next) => {
        activeRunRef.current = next.run;
        setActiveRun(next.run);
        setStopState(next.stop.state);
      });
      activeRunRef.current = snapshot.run;
      setActiveRun(snapshot.run);
      setStopState(snapshot.stop.state);
      if (snapshot.run.context.sessionId) {
        setNativeSessionId(snapshot.run.context.sessionId);
        try { localStorage.setItem(nativeSessionKey, snapshot.run.context.sessionId); } catch { /* state remains authoritative */ }
      }
      setError(isVerifiedCancellation(snapshot) ? "Stopped and verified." : `Run ended as ${snapshot.run.status}.`);
    } catch (caught) {
      setStopState("failed_to_stop");
      setError(describeWorkbenchError(caught, false));
    }
  }

  return (
    <Panel
      title="Claude — Workbench Channel"
      accent="claude"
      icon={<Sparkles size={14} />}
      actions={
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setMsgs([]);
              setPartial("");
              setError("");
              setNativeSessionId(null);
              activeRunRef.current = null;
              setActiveRun(null);
              setStopState("not_requested");
              try { localStorage.removeItem(nativeSessionKey); } catch { /* state is already reset */ }
            }}
            disabled={streaming || msgs.length === 0}
            title="Start a fresh conversation (clears context)"
            className="px-2.5 py-1 rounded-full border text-[11px] uppercase tracking-widest transition border-[var(--panel-border)] text-[var(--fg-dim)] hover:text-[var(--fg)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            New chat
          </button>
          <button
            disabled
            title="Unavailable in Wave 3. Ultracode requires the enforceable Tool Gateway in Wave 4."
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] uppercase tracking-widest transition"
            style={{
              borderColor: "var(--panel-border)",
              background: "transparent",
              color: "var(--fg-dim)",
            }}
          >
            <Zap size={11} />
            Ultracode unavailable
          </button>
          <span className="pill pill-info">{workbenchRunLabel(activeRun, stopState)}</span>
        </div>
      }
      className="flex-1 min-h-[600px]"
    >
      <div className="flex flex-col h-full min-h-0">
        <div ref={scrollRef} className="scroll flex-1 min-h-0 overflow-y-auto space-y-3 pr-2">
          <AnimatePresence initial={false}>
            {msgs.length === 0 && !streaming && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-[var(--fg-dim)] text-sm leading-relaxed"
              >
                <p className="text-base text-[var(--fg)]">Mission Channel open.</p>
                <p className="mt-2">
                  Claude runs through the canonical Workbench lifecycle with a server-owned target.
                </p>
                <ul className="mt-3 text-xs text-[var(--fg-dimmer)] space-y-1">
                  <li>• Multi-turn — keeps context across messages (<strong>New chat</strong> resets)</li>
                  <li>• Live output over the Workbench event ledger</li>
                  <li>• Stop waits for verified process-tree termination</li>
                  <li>• <strong style={{ color: "var(--claude)" }}>Ultracode</strong> remains unavailable until the Tool Gateway is live</li>
                </ul>
              </motion.div>
            )}
            {msgs.map((m, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className={`rounded-xl px-4 py-3 text-sm leading-relaxed border ${
                  m.role === "user"
                    ? "bg-[rgba(217,119,87,0.08)] border-[rgba(217,119,87,0.18)] text-[var(--fg)]"
                    : "bg-[rgba(255,255,255,0.02)] border-[rgba(255,255,255,0.06)] text-[var(--fg)]"
                }`}
              >
                <div className="text-[10px] tracking-widest uppercase mb-1 opacity-60">
                  {m.role === "user" ? "you" : "claude"}
                </div>
                <div className="whitespace-pre-wrap font-[var(--font-geist-mono)]">{m.text}</div>
              </motion.div>
            ))}
            {streaming && (
              <motion.div
                key="partial"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="rounded-xl px-4 py-3 text-sm leading-relaxed border bg-[rgba(255,255,255,0.02)] border-[rgba(255,255,255,0.06)]"
              >
                <div className="text-[10px] tracking-widest uppercase mb-1 opacity-60 flex items-center gap-2">
                  claude
                  <span className="inline-flex">
                    <span className="tick live" style={{ color: "var(--claude)" }} />
                    <span className="tick live" style={{ color: "var(--claude)", animationDelay: ".2s" }} />
                    <span className="tick live" style={{ color: "var(--claude)", animationDelay: ".4s" }} />
                  </span>
                </div>
                <div className="whitespace-pre-wrap font-[var(--font-geist-mono)]">{partial || "thinking…"}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {error && <div className="mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-[11.5px] leading-snug border" role="alert" style={{ borderColor: "rgba(248,113,113,0.35)", background: "rgba(248,113,113,0.08)", color: "var(--fg)" }}><AlertTriangle size={13} className="shrink-0 mt-0.5 text-rose-300" /><span>{error}</span></div>}

        <div className="mt-4 panel border border-[var(--panel-border)] flex items-end gap-2 p-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
              if (e.key === "Escape" && streaming) void stop();
            }}
            rows={2}
            placeholder="Ask Claude anything…  (⌘+Enter to send)"
            className="flex-1 bg-transparent outline-none resize-none px-3 py-2 text-sm text-[var(--fg)] placeholder:text-[var(--fg-dimmer)]"
          />
          {streaming ? (
            <button
              onClick={() => void stop()}
              disabled={stopState === "stopping"}
              className="px-3 py-2 rounded-lg bg-[rgba(248,113,113,0.15)] border border-[rgba(248,113,113,0.4)] text-rose-300 text-sm flex items-center gap-1.5 hover:bg-[rgba(248,113,113,0.22)] transition"
            >
              <Square size={14} /> {stopState === "stopping" ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!input.trim()}
              className="px-3 py-2 rounded-lg bg-[rgba(217,119,87,0.18)] border border-[rgba(217,119,87,0.4)] text-[var(--claude)] text-sm flex items-center gap-1.5 hover:bg-[rgba(217,119,87,0.28)] transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send size={14} /> Send
            </button>
          )}
        </div>
      </div>
    </Panel>
  );
}
