"use client";

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  PackagePlus,
  RefreshCw,
  Sparkles,
  TerminalSquare,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InstallAgentAvailability, InstallAgentStatus } from "@/lib/agentInstall/agentTypes";
import { buildConversationHref } from "@/lib/agentInstall/conversationLink";
import { buildInstallPlanPrompt, type PromptEntry } from "@/lib/agentInstall/prompt";
import { buildRepairPrompt, parseInstallPlan, type ParsedPlan, type ReviewedStep } from "@/lib/agentInstall/planSchema";
import { INSTALL_PROJECT_ID, askInstallAgent, type AskResult } from "@/lib/agentInstall/uiTransport";

/**
 * "Ask an agent to install this" for one service.
 *
 * The agent runs with every tool disabled, so it cannot install anything — it
 * reads the failing checks and the guide and answers with a plan. This stage
 * shows that plan for review. Running it arrives next, which is why the approve
 * button says so rather than pretending.
 */

type Phase = "idle" | "asking" | "review" | "unusable" | "failed";

const HOST = {
  platform: "win32",
  cwdLabel: "a server-owned scratch folder outside the repository",
};

function formatWhen(at: string | undefined): string {
  if (!at) return "";
  const time = Date.parse(at);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "";
}

function stepCommandText(step: ReviewedStep["step"]): string | null {
  if (step.kind !== "command") return null;
  return [step.program, ...step.args].join(" ");
}

export default function AgentInstallPanel({ entry }: { entry: PromptEntry }) {
  const [availability, setAvailability] = useState<InstallAgentAvailability | null>(null);
  const [checking, setChecking] = useState(false);
  const [availabilityError, setAvailabilityError] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [partial, setPartial] = useState("");
  const [parsed, setParsed] = useState<ParsedPlan | null>(null);
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [askError, setAskError] = useState("");
  const [copied, setCopied] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const refreshAvailability = useCallback(async () => {
    setChecking(true);
    setAvailabilityError("");
    try {
      const response = await fetch("/api/setup/agents", { cache: "no-store" });
      if (!response.ok) throw new Error(`Agent availability returned ${response.status}`);
      setAvailability(await response.json() as InstallAgentAvailability);
    } catch (cause) {
      setAvailabilityError(cause instanceof Error ? cause.message : "בדיקת הסוכנים נכשלה");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void refreshAvailability(); }, [refreshAvailability]);

  // A different service means a different plan. Reset rather than showing a
  // stale one against the wrong card.
  useEffect(() => {
    abortRef.current?.abort();
    setPhase("idle");
    setPartial("");
    setParsed(null);
    setAnswer(null);
    setAskError("");
  }, [entry.route]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const chosen: InstallAgentStatus | null =
    availability?.agents.find((agent) => agent.id === availability.selected) ?? null;

  const ask = useCallback(async () => {
    if (!chosen) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("asking");
    setPartial("");
    setParsed(null);
    setAnswer(null);
    setAskError("");

    const built = buildInstallPlanPrompt(entry, HOST);
    try {
      let result = await askInstallAgent(
        { agent: chosen.id, prompt: built.prompt },
        setPartial,
        controller.signal,
      );
      let review = parseInstallPlan(result.text, entry);

      // One repair attempt, on the same session, so the correction lands in the
      // conversation the user will open rather than in an orphan run.
      if (!review.ok) {
        setPartial("");
        result = await askInstallAgent(
          { agent: chosen.id, prompt: buildRepairPrompt(review), sessionId: result.sessionId },
          setPartial,
          controller.signal,
        );
        review = parseInstallPlan(result.text, entry);
      }

      setAnswer(result);
      setParsed(review);
      setPhase(review.ok ? "review" : "unusable");
    } catch (cause) {
      if (controller.signal.aborted) { setPhase("idle"); return; }
      setAskError(cause instanceof Error ? cause.message : "הבקשה מהסוכן נכשלה");
      setPhase("failed");
    }
  }, [chosen, entry]);

  const runnableCount = parsed?.steps.filter((step) => step.runnable).length ?? 0;
  const conversationHref = answer
    ? buildConversationHref(answer.agent, answer.sessionId, INSTALL_PROJECT_ID)
    : null;

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(""), 1600);
    } catch { /* the text is on screen either way */ }
  };

  return (
    <div
      className="mb-4 rounded-md border p-3.5"
      style={{ borderColor: "rgba(212,165,116,.28)", background: "rgba(212,165,116,.05)" }}
      data-agent-install-panel
      data-agent-install-phase={phase}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border"
          style={{ color: "var(--gold)", borderColor: "rgba(212,165,116,.3)", background: "rgba(212,165,116,.08)" }}
        >
          <Sparkles size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[12.5px] font-semibold text-[var(--cream)]">שאל סוכן להתקין את {entry.title}</h4>
            <button
              type="button"
              onClick={() => void refreshAvailability()}
              disabled={checking || phase === "asking"}
              aria-label="בדוק מחדש אילו סוכנים פנויים"
              className="grid h-6 w-6 place-items-center rounded-md text-[var(--cream-dim)] transition hover:bg-white/5 disabled:opacity-50"
            >
              <RefreshCw size={12} className={checking ? "animate-spin" : ""} />
            </button>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-[var(--cream-mute)]">
            הסוכן קורא את הבדיקות ואת המדריך ומרכיב תוכנית. הוא לא מריץ דבר בעצמו —
            Agent OS מריץ את הצעדים רק אחרי שתאשר את כולם בלחיצה אחת.
          </p>

          {availabilityError && (
            <div className="mt-2.5 rounded-sm border px-2.5 py-1.5 text-[10px]" style={{ borderColor: "rgba(255,46,77,.3)", background: "rgba(255,46,77,.07)", color: "var(--tally)" }}>
              {availabilityError}
            </div>
          )}

          {/* The availability list collapses to one line once an agent is chosen:
              three rows of reasons only help when nothing can run. */}
          {availability && (!chosen || phase === "idle") && (
            <div className="mt-2.5 space-y-1">
              {availability.agents
                .filter((agent) => !chosen || agent.available)
                .map((agent) => (
                  <div
                    key={agent.id}
                    data-agent-status={agent.id}
                    data-agent-available={String(agent.available)}
                    className="flex items-start gap-2 rounded-sm border px-2.5 py-1.5"
                    style={{
                      borderColor: agent.available ? "rgba(43,224,138,.26)" : "var(--line-soft)",
                      background: agent.available ? "rgba(43,224,138,.05)" : "rgba(255,255,255,.015)",
                    }}
                  >
                    <span className="mt-0.5 shrink-0">
                      {agent.available
                        ? <CheckCircle2 size={12} style={{ color: "var(--preview)" }} />
                        : <AlertTriangle size={12} style={{ color: "var(--amber)" }} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10.5px] font-medium text-[var(--cream)]">{agent.label}</span>
                        {agent.id === availability.selected && (
                          <span className="text-[7.5px] uppercase tracking-[0.1em]" style={{ color: "var(--preview)" }}>ייבחר</span>
                        )}
                      </span>
                      <span className="block text-[9.5px] leading-relaxed text-[var(--cream-mute)]">{agent.reason}</span>
                      {agent.fix && agent.fix.kind !== "none" && (
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[9px]" style={{ color: "var(--amber)" }}>
                          <span>{agent.fix.label}{agent.fix.at ? ` · ${formatWhen(agent.fix.at)}` : ""}</span>
                          {agent.fix.command && (
                            <button
                              type="button"
                              onClick={() => void copy(agent.id, agent.fix!.command!)}
                              className="inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[8.5px] text-[var(--cream-dim)]"
                              style={{ borderColor: "var(--line-soft)" }}
                            >
                              <Copy size={9} /> {copied === agent.id ? "הועתק" : agent.fix.command}
                            </button>
                          )}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
            </div>
          )}

          {phase === "asking" && (
            <div className="mt-3 rounded-sm border px-2.5 py-2" style={{ borderColor: "rgba(46,125,255,.3)", background: "rgba(46,125,255,.06)" }}>
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[10px] text-[var(--sdi-soft)]">
                  <Loader2 size={11} className="animate-spin" /> {chosen?.label} מרכיב תוכנית…
                </span>
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="inline-flex items-center gap-1 text-[9px] text-[var(--cream-dim)]"
                >
                  <X size={10} /> עצור
                </button>
              </div>
              {partial && (
                <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words text-[8.5px] leading-relaxed text-[var(--cream-mute)]">
                  {partial.slice(-900)}
                </pre>
              )}
            </div>
          )}

          {phase === "failed" && (
            <div className="mt-3 rounded-sm border px-2.5 py-2 text-[10px]" style={{ borderColor: "rgba(255,46,77,.3)", background: "rgba(255,46,77,.07)", color: "var(--tally)" }}>
              {askError}
            </div>
          )}

          {phase === "unusable" && parsed && (
            <div className="mt-3 rounded-sm border px-2.5 py-2" style={{ borderColor: "rgba(255,176,32,.32)", background: "rgba(255,176,32,.07)" }}>
              <div className="text-[10.5px] font-semibold text-[var(--cream)]">הסוכן לא הפיק תוכנית שאפשר להשתמש בה</div>
              <ul className="mt-1 list-inside list-disc text-[9.5px] leading-relaxed text-[var(--cream-dim)]">
                {parsed.errors.map((problem) => <li key={problem}>{problem}</li>)}
              </ul>
              <details className="mt-2">
                <summary className="cursor-pointer text-[9px] text-[var(--cream-mute)]">התשובה הגולמית</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[8.5px] text-[var(--cream-mute)]">{parsed.raw.slice(0, 4000)}</pre>
              </details>
            </div>
          )}

          {phase === "review" && parsed?.plan && (
            <div className="mt-3" data-agent-install-review>
              <p className="text-[10.5px] leading-relaxed text-[var(--cream)]">{parsed.plan.summary}</p>
              {parsed.plan.risks.length > 0 && (
                <ul className="mt-1 list-inside list-disc text-[9px] leading-relaxed" style={{ color: "var(--amber)" }}>
                  {parsed.plan.risks.map((risk) => <li key={risk}>{risk}</li>)}
                </ul>
              )}
              <ol className="mt-2 space-y-1.5">
                {parsed.steps.map((reviewed, index) => {
                  const command = stepCommandText(reviewed.step);
                  const badge = reviewed.step.kind === "catalog" ? "פעולה מהקטלוג"
                    : reviewed.step.kind === "command" ? "פקודה"
                      : "ידני";
                  return (
                    <li
                      key={`${index}-${reviewed.step.kind}`}
                      data-agent-install-step={String(index)}
                      data-agent-install-runnable={String(reviewed.runnable)}
                      className="flex items-start gap-2 rounded-sm border px-2.5 py-2"
                      style={{
                        borderColor: reviewed.runnable ? "var(--line-soft)" : "rgba(255,176,32,.28)",
                        background: reviewed.runnable ? "rgba(255,255,255,.018)" : "rgba(255,176,32,.05)",
                        opacity: reviewed.rejection ? 0.85 : 1,
                      }}
                    >
                      <span className="mt-0.5 shrink-0" style={{ color: reviewed.runnable ? "var(--gold)" : "var(--amber)" }}>
                        {reviewed.step.kind === "catalog" ? <PackagePlus size={12} />
                          : reviewed.step.kind === "command" ? <TerminalSquare size={12} />
                            : <AlertTriangle size={12} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[8px] uppercase tracking-[0.1em] text-[var(--cream-mute)]">{index + 1} · {badge}</span>
                        </span>
                        {command && (
                          <span className="mt-0.5 flex items-center gap-1.5">
                            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[9.5px] text-[var(--sdi-soft)]">{command}</code>
                            <button
                              type="button"
                              onClick={() => void copy(`step-${index}`, command)}
                              className="inline-flex shrink-0 items-center gap-1 text-[8.5px] text-[var(--cream-dim)]"
                            >
                              <Copy size={9} /> {copied === `step-${index}` ? "הועתק" : "העתק"}
                            </button>
                          </span>
                        )}
                        {reviewed.step.kind === "catalog" && (
                          <span className="mt-0.5 block text-[9.5px] text-[var(--cream)]">{reviewed.step.actionId}</span>
                        )}
                        {reviewed.step.kind === "manual" && reviewed.step.instruction && (
                          <span className="mt-0.5 block text-[9.5px] text-[var(--cream)]">{reviewed.step.instruction}</span>
                        )}
                        {reviewed.step.why && (
                          <span className="mt-0.5 block text-[9px] leading-relaxed text-[var(--cream-mute)]">{reviewed.step.why}</span>
                        )}
                        {reviewed.rejection && (
                          <span className="mt-1 block text-[9px]" style={{ color: "var(--amber)" }}>{reviewed.rejection.reason}</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>

              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {/* Running the plan lands in the next stage. Saying so beats a button
                    that looks live and does nothing. */}
                <button
                  type="button"
                  disabled
                  title="הרצת התוכנית מגיעה בשלב הבא"
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border px-3 text-[10px] font-semibold disabled:opacity-50"
                  style={{ color: "var(--amber)", borderColor: "rgba(255,176,32,.36)", background: "rgba(0,0,0,.16)" }}
                >
                  אשר והרץ {runnableCount} צעדים · בקרוב
                </button>
                {conversationHref && (
                  <a
                    href={conversationHref}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border px-3 text-[10px] text-[var(--cream-dim)] transition hover:text-[var(--cream)]"
                    style={{ borderColor: "var(--line-soft)" }}
                  >
                    <ExternalLink size={11} /> פתח את השיחה ב-{answer?.agent === "codex" ? "Codex" : "Claude Code"}
                  </a>
                )}
              </div>
              <p className="mt-1.5 text-[9px] leading-relaxed text-[var(--cream-mute)]">
                עד אז אפשר להעתיק כל פקודה ולהריץ אותה בטרמינל. השיחה נשמרה כסשן רגיל של הסוכן;
                היא עשויה להופיע שם רק אחרי כמה שניות.
              </p>
            </div>
          )}

          {(phase === "idle" || phase === "unusable" || phase === "failed") && (
            <button
              type="button"
              onClick={() => void ask()}
              disabled={!chosen || checking}
              title={chosen ? undefined : "אין כרגע סוכן פנוי"}
              data-agent-install-ask
              className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-sm border px-3 text-[10px] font-semibold transition hover:brightness-125 disabled:opacity-50"
              style={{ color: "var(--gold)", borderColor: "rgba(212,165,116,.34)", background: "rgba(0,0,0,.16)" }}
            >
              <Bot size={13} />
              {chosen
                ? phase === "idle" ? `בקש מ-${chosen.label} להתקין` : `נסה שוב עם ${chosen.label}`
                : "אין סוכן פנוי כרגע"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
