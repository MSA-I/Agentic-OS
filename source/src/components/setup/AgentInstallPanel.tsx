"use client";

import { AlertTriangle, Bot, CheckCircle2, Copy, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * The "ask an agent to install this" surface. Stage one: it reports which agent
 * could do the work and, when none can, the one thing that would unblock each.
 * The action itself lands in the next stage, so the button is present and
 * honestly disabled rather than absent.
 */

interface AgentFix {
  kind: "restart" | "wait" | "setup" | "auth" | "none";
  label: string;
  route?: string;
  command?: string;
  at?: string;
}

interface AgentStatus {
  id: "claude" | "codex" | "hermes";
  label: string;
  transport: "workbench" | "unavailable";
  available: boolean;
  blockedBy: string | null;
  reason: string;
  fix: AgentFix | null;
  latencyMs: number | null;
}

interface Availability {
  version: 1;
  checkedAt: string;
  agents: AgentStatus[];
  selected: AgentStatus["id"] | null;
  capacity: { activeRuns: number; maxActiveRuns: number; saturated: boolean };
}

function formatWhen(at: string | undefined): string {
  if (!at) return "";
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString();
}

export default function AgentInstallPanel({ serviceTitle }: { serviceTitle: string }) {
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/setup/agents", { cache: "no-store" });
      if (!response.ok) throw new Error(`Agent availability returned ${response.status}`);
      setAvailability(await response.json() as Availability);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "בדיקת הסוכנים נכשלה");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const chosen = availability?.agents.find((agent) => agent.id === availability.selected) ?? null;

  return (
    <div
      className="mb-4 rounded-md border p-3.5"
      style={{ borderColor: "rgba(212,165,116,.28)", background: "rgba(212,165,116,.05)" }}
      data-agent-install-panel
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
            <h4 className="text-[12.5px] font-semibold text-[var(--cream)]">שאל סוכן להתקין את {serviceTitle}</h4>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label="בדוק מחדש אילו סוכנים פנויים"
              className="grid h-6 w-6 place-items-center rounded-md text-[var(--cream-dim)] transition hover:bg-white/5 disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-[var(--cream-mute)]">
            הסוכן קורא את הבדיקות ואת המדריך, ומרכיב תוכנית התקנה. הוא לא מריץ דבר בעצמו —
            Agent OS מריץ את הצעדים רק אחרי שתאשר אותם.
          </p>

          {error && (
            <div className="mt-2.5 rounded-sm border px-2.5 py-1.5 text-[10px]" style={{ borderColor: "rgba(255,46,77,.3)", background: "rgba(255,46,77,.07)", color: "var(--tally)" }}>
              {error}
            </div>
          )}

          {loading && !availability && (
            <div className="mt-2.5 inline-flex items-center gap-1.5 text-[10px] text-[var(--cream-mute)]">
              <Loader2 size={11} className="animate-spin" /> בודק אילו סוכנים פנויים…
            </div>
          )}

          {availability && (
            <div className="mt-2.5 space-y-1">
              {availability.agents.map((agent) => (
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
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(agent.fix!.command!);
                                setCopied(agent.id);
                                window.setTimeout(() => setCopied(""), 1600);
                              } catch { /* the command is visible either way */ }
                            }}
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

          {/* Stage one ships the selector only. The button is rendered disabled rather
              than hidden so the entry point is discoverable and its state is truthful. */}
          <button
            type="button"
            disabled
            title="תכנון ההתקנה מגיע בשלב הבא"
            className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-sm border px-3 text-[10px] font-semibold disabled:opacity-50"
            style={{ color: "var(--gold)", borderColor: "rgba(212,165,116,.34)", background: "rgba(0,0,0,.16)" }}
          >
            <Bot size={13} />
            {chosen ? `בקש מ-${chosen.label} להתקין · בקרוב` : "אין סוכן פנוי כרגע"}
          </button>
        </div>
      </div>
    </div>
  );
}
