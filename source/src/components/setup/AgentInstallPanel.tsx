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
 * reads the failing checks and the guide and answers with a plan. The user
 * approves that plan once, and the application runs it step by step: catalog
 * steps through the existing /api/setup/action, commands through a plan token
 * so the server executes what the user actually read.
 */

interface StepProgress {
  state: "pending" | "running" | "done" | "failed" | "skipped";
  message?: string;
}

type Phase = "idle" | "asking" | "review" | "running" | "done" | "unusable" | "failed";

const HOST = {
  platform: "win32",
  cwdLabel: "a server-owned scratch folder outside the repository",
};

function formatWhen(at: string | undefined): string {
  if (!at) return "";
  const time = Date.parse(at);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "";
}

function stepColor(state: StepProgress["state"] | undefined, runnable: boolean): string {
  if (state === "done") return "var(--preview)";
  if (state === "failed") return "var(--tally)";
  if (state === "running") return "var(--sdi-soft)";
  return runnable ? "var(--gold)" : "var(--amber)";
}

function stepBorder(state: StepProgress["state"] | undefined, runnable: boolean): string {
  if (state === "done") return "rgba(43,224,138,.3)";
  if (state === "failed") return "rgba(255,46,77,.35)";
  if (state === "running") return "rgba(46,125,255,.35)";
  return runnable ? "var(--line-soft)" : "rgba(255,176,32,.28)";
}

function stepBackground(state: StepProgress["state"] | undefined, runnable: boolean): string {
  if (state === "done") return "rgba(43,224,138,.05)";
  if (state === "failed") return "rgba(255,46,77,.06)";
  if (state === "running") return "rgba(46,125,255,.06)";
  return runnable ? "rgba(255,255,255,.018)" : "rgba(255,176,32,.05)";
}

function stepCommandText(step: ReviewedStep["step"]): string | null {
  if (step.kind !== "command") return null;
  return [step.program, ...step.args].join(" ");
}

export default function AgentInstallPanel({
  entry,
  onFinished,
}: {
  entry: PromptEntry;
  /** Called after a run so the caller can refresh the readiness checks. */
  onFinished?: () => void;
}) {
  const [availability, setAvailability] = useState<InstallAgentAvailability | null>(null);
  const [checking, setChecking] = useState(false);
  const [availabilityError, setAvailabilityError] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [partial, setPartial] = useState("");
  const [parsed, setParsed] = useState<ParsedPlan | null>(null);
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [askError, setAskError] = useState("");
  const [copied, setCopied] = useState("");
  const [pickedAgent, setPickedAgent] = useState<InstallAgentStatus["id"] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<StepProgress[]>([]);
  const [runError, setRunError] = useState("");
  const runAbortRef = useRef<AbortController | null>(null);

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
    setProgress([]);
    setRunError("");
    setPickedAgent(null);
    runAbortRef.current?.abort();
  }, [entry.route]);

  useEffect(() => () => {
    abortRef.current?.abort();
    runAbortRef.current?.abort();
  }, []);

  // The server ranks the agents and names a default. A pick overrides it, and
  // falls back the moment that agent stops being available — so the button
  // never points at an agent that cannot run.
  const defaultAgent = availability?.agents.find((agent) => agent.id === availability.selected) ?? null;
  const picked = pickedAgent
    ? availability?.agents.find((agent) => agent.id === pickedAgent && agent.available) ?? null
    : null;
  const chosen: InstallAgentStatus | null = picked ?? defaultAgent;

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

  /**
   * The single approval. Everything runnable in the list runs, in order, and
   * the loop stops at the first failure rather than pressing on through a
   * dependency that never installed.
   */
  const approveAndRun = useCallback(async () => {
    if (!parsed?.plan) return;
    const controller = new AbortController();
    runAbortRef.current = controller;
    setRunError("");
    setPhase("running");
    setProgress(parsed.steps.map((step) => ({
      state: step.runnable ? "pending" : "skipped",
      message: step.rejection?.reason,
    })));

    let planId: string;
    try {
      const response = await fetch("/api/setup/agent-install/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: entry.route, steps: parsed.steps.map((step) => step.step) }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `אישור התוכנית נכשל (${response.status})`);
      planId = body.planId as string;
    } catch (cause) {
      if (controller.signal.aborted) { setPhase("review"); return; }
      setRunError(cause instanceof Error ? cause.message : "אישור התוכנית נכשל");
      setPhase("review");
      return;
    }

    let failed = false;
    for (const [index, reviewed] of parsed.steps.entries()) {
      if (!reviewed.runnable) continue;
      if (controller.signal.aborted) break;
      setProgress((current) => current.map((item, position) => (
        position === index ? { state: "running" } : item
      )));
      try {
        const response = await fetch("/api/setup/agent-install/step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planId, stepIndex: index }),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        const ok = response.ok && body.ok !== false;
        setProgress((current) => current.map((item, position) => (
          position === index
            ? { state: ok ? "done" : "failed", message: body.message ?? body.error }
            : item
        )));
        if (!ok) { failed = true; break; }
      } catch (cause) {
        if (controller.signal.aborted) break;
        setProgress((current) => current.map((item, position) => (
          position === index
            ? { state: "failed", message: cause instanceof Error ? cause.message : "הצעד נכשל" }
            : item
        )));
        failed = true;
        break;
      }
    }

    // Re-read the service so the readiness checks above reflect what just ran.
    onFinished?.();
    setPhase(failed ? "failed" : "done");
    if (failed) setRunError("צעד נכשל, ולכן שאר הצעדים לא רצו.");
  }, [entry.route, onFinished, parsed]);
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

          {/* Every agent stays listed while idle: an available one is a control
              that selects it, a blocked one shows why and what would fix it. */}
          {availability && (!chosen || phase === "idle") && (
            <div className="mt-2.5 space-y-1" role="radiogroup" aria-label="בחירת סוכן">
              {availability.agents
                .map((agent) => {
                  const isChosen = agent.id === chosen?.id;
                  return (
                  <div
                    key={agent.id}
                    data-agent-status={agent.id}
                    data-agent-available={String(agent.available)}
                    data-agent-chosen={String(isChosen)}
                    role={agent.available ? "radio" : undefined}
                    aria-checked={agent.available ? isChosen : undefined}
                    tabIndex={agent.available ? 0 : undefined}
                    onClick={agent.available ? () => setPickedAgent(agent.id) : undefined}
                    onKeyDown={agent.available
                      ? (event) => {
                          if (event.key === " " || event.key === "Enter") {
                            event.preventDefault();
                            setPickedAgent(agent.id);
                          }
                        }
                      : undefined}
                    className={`flex items-start gap-2 rounded-sm border px-2.5 py-1.5 ${agent.available ? "cursor-pointer transition hover:brightness-110" : ""}`}
                    style={{
                      borderColor: isChosen ? "var(--preview)" : agent.available ? "rgba(43,224,138,.26)" : "var(--line-soft)",
                      background: isChosen ? "rgba(43,224,138,.1)" : agent.available ? "rgba(43,224,138,.05)" : "rgba(255,255,255,.015)",
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
                        {isChosen && (
                          <span className="text-[7.5px] uppercase tracking-[0.1em]" style={{ color: "var(--preview)" }}>
                            {pickedAgent === agent.id ? "נבחר" : "ברירת מחדל"}
                          </span>
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
                  );
                })}
              <p className="pt-0.5 text-[9px] text-[var(--cream-mute)]">
                לחיצה על סוכן פנוי בוחרת אותו. בלי בחירה רץ הראשון ברשימה.
              </p>
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

          {(phase === "review" || phase === "running" || phase === "done" || (phase === "failed" && parsed?.plan)) && parsed?.plan && (
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
                  const state = progress[index]?.state;
                  const outcome = progress[index]?.message;
                  return (
                    <li
                      key={`${index}-${reviewed.step.kind}`}
                      data-agent-install-step={String(index)}
                      data-agent-install-runnable={String(reviewed.runnable)}
                      className="flex items-start gap-2 rounded-sm border px-2.5 py-2"
                      data-agent-install-step-state={state ?? ""}
                      style={{
                        borderColor: stepBorder(state, reviewed.runnable),
                        background: stepBackground(state, reviewed.runnable),
                        opacity: reviewed.rejection && !state ? 0.85 : 1,
                      }}
                    >
                      <span className="mt-0.5 shrink-0" style={{ color: stepColor(state, reviewed.runnable) }}>
                        {state === "running" ? <Loader2 size={12} className="animate-spin" />
                          : state === "done" ? <CheckCircle2 size={12} />
                            : state === "failed" ? <AlertTriangle size={12} />
                              : reviewed.step.kind === "catalog" ? <PackagePlus size={12} />
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
                        {outcome && state !== "skipped" && (
                          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[8.5px] leading-relaxed" style={{ color: state === "failed" ? "var(--tally)" : "var(--cream-mute)" }}>{outcome}</pre>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>

              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {/* The single approval. Everything runnable below runs after this
                    click, without asking again — the label says so. */}
                {phase === "review" && (
                  <button
                    type="button"
                    onClick={() => void approveAndRun()}
                    disabled={runnableCount === 0}
                    data-agent-install-approve
                    title={runnableCount === 0 ? "אין צעד שאפשר להריץ אוטומטית" : undefined}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border px-3 text-[10px] font-semibold transition hover:brightness-125 disabled:opacity-50"
                    style={{ color: "var(--amber)", borderColor: "rgba(255,176,32,.36)", background: "rgba(0,0,0,.16)" }}
                  >
                    {runnableCount === 0 ? "אין צעד אוטומטי להרצה" : `אשר והרץ ${runnableCount} צעדים`}
                  </button>
                )}
                {phase === "running" && (
                  <button
                    type="button"
                    onClick={() => runAbortRef.current?.abort()}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border px-3 text-[10px] text-[var(--cream-dim)]"
                    style={{ borderColor: "var(--line-soft)" }}
                  >
                    <X size={11} /> עצור
                  </button>
                )}
                {phase === "done" && (
                  <span className="inline-flex min-h-9 items-center gap-1.5 text-[10px] font-semibold" style={{ color: "var(--preview)" }}>
                    <CheckCircle2 size={13} /> כל הצעדים הסתיימו
                  </span>
                )}
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
              {runError && (
                <p className="mt-1.5 text-[9.5px] leading-relaxed" style={{ color: "var(--tally)" }}>{runError}</p>
              )}
              <p className="mt-1.5 text-[9px] leading-relaxed text-[var(--cream-mute)]">
                {phase === "running"
                  ? "עצירה מבטלת את הצעדים הבאים; צעד שכבר התחיל יסיים בשרת."
                  : "אפשר גם להעתיק כל פקודה ולהריץ אותה בטרמינל."}
                {" "}השיחה נשמרה כסשן רגיל של הסוכן; היא עשויה להופיע שם רק אחרי כמה שניות.
              </p>
            </div>
          )}

          {(phase === "idle" || phase === "unusable" || (phase === "failed" && !parsed?.plan)) && (
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
