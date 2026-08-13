"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  PackagePlus,
  Play,
  PlugZap,
  RefreshCw,
  Search,
  ShieldCheck,
  TerminalSquare,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import ScrollArea from "./ScrollArea";

const OPEN_EVENT = "agentos:open-setup-center";

export function openSetupCenter(route?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { route } }));
}

type SetupCategory = "setup-required" | "broken" | "optional" | string;
type DiagnosticState = "ready" | "missing" | "warning" | "error" | "checking" | string;

interface SetupActionField {
  id: string;
  label: string;
  type: "secret" | "path" | "text";
  required?: boolean;
  placeholder?: string;
  help?: string;
}

interface SetupActionDefinition {
  id: string;
  label: string;
  kind: "connect" | "test" | "start" | "install" | "manual";
  description: string;
  requiresConfirm?: boolean;
  availability: "automatic" | "manual";
  copyCommand?: string;
  fields?: SetupActionField[];
}

interface SetupDiagnostic {
  id?: string;
  label?: string;
  name?: string;
  status?: DiagnosticState;
  state?: DiagnosticState;
  message?: string;
  detail?: string;
  reason?: string;
  impact?: "required" | "alternative" | "optional";
  alternativeGroup?: string;
  evidence?: "verified" | "configured";
}

interface SetupReadiness {
  ready: boolean;
  level: "verified" | "configured" | "partial" | "missing";
  reason?: string;
}

interface SetupEntryState {
  route: string;
  title: string;
  category: SetupCategory;
  summary: string;
  guide?: { title?: string; docId?: string };
  actions: SetupActionDefinition[];
  diagnostics?: SetupDiagnostic[];
  readiness?: SetupReadiness;
  guideMarkdown?: string | null;
}

interface SetupPayload {
  version?: number;
  checkedAt?: string;
  entries?: SetupEntryState[];
}

interface NavigationStatus {
  status: "ready" | "not-installed" | "checking";
  reason?: string;
}

interface ActionResult {
  ok?: boolean;
  route?: string;
  actionId?: string;
  mode?: "executed" | "manual";
  message?: string;
  diagnostics?: SetupDiagnostic[];
  copyCommand?: string;
  error?: string;
}

type Filter = "all" | "setup" | "broken" | "connected";
type Tab = "setup" | "guide" | "activity";

const ACTION_ICON: Record<SetupActionDefinition["kind"], ReactNode> = {
  connect: <KeyRound size={14} />,
  install: <PackagePlus size={14} />,
  start: <Play size={14} />,
  test: <RefreshCw size={14} />,
  manual: <TerminalSquare size={14} />,
};

function diagnosticState(diagnostic: SetupDiagnostic): DiagnosticState {
  return diagnostic.status ?? diagnostic.state ?? "checking";
}

function diagnosticLabel(diagnostic: SetupDiagnostic): string {
  return diagnostic.label ?? diagnostic.name ?? diagnostic.id ?? "Requirement";
}

function actionFieldKey(actionId: string, fieldId: string): string {
  return `${actionId}:${fieldId}`;
}

function statusTone(status: NavigationStatus | undefined, category: SetupCategory, readiness?: SetupReadiness) {
  if (readiness?.ready && readiness.level === "verified") return { label: "Verified", color: "var(--preview)", bg: "rgba(43,224,138,0.08)" };
  if (readiness?.ready && readiness.level === "configured") return { label: "Configured", color: "var(--sdi-soft)", bg: "rgba(46,125,255,0.08)" };
  if (readiness?.ready && readiness.level === "partial") return { label: "Ready · optional setup", color: "var(--preview)", bg: "rgba(43,224,138,0.08)" };
  if (category === "broken") return { label: "Repair required", color: "var(--tally)", bg: "rgba(255,46,77,0.09)" };
  if (status?.status === "ready") return { label: "Connected", color: "var(--preview)", bg: "rgba(43,224,138,0.08)" };
  if (status?.status === "checking" || !status) return { label: "Checking", color: "var(--amber)", bg: "rgba(255,176,32,0.08)" };
  return { label: "Setup required", color: "var(--amber)", bg: "rgba(255,176,32,0.08)" };
}

function diagnosticIcon(state: DiagnosticState) {
  if (state === "ready" || state === "ok" || state === "connected" || state === "present") return <CheckCircle2 size={14} style={{ color: "var(--preview)" }} />;
  if (state === "error" || state === "broken") return <AlertTriangle size={14} style={{ color: "var(--tally)" }} />;
  if (state === "missing" || state === "warning" || state === "unavailable") return <AlertTriangle size={14} style={{ color: "var(--amber)" }} />;
  return <CircleDashed size={14} className="animate-spin" style={{ color: "var(--cream-mute)" }} />;
}

function actionTone(kind: SetupActionDefinition["kind"]): { color: string; border: string; background: string } {
  if (kind === "connect") return { color: "var(--sdi-soft)", border: "rgba(46,125,255,0.35)", background: "rgba(46,125,255,0.09)" };
  if (kind === "install") return { color: "var(--gold)", border: "rgba(212,165,116,0.34)", background: "rgba(212,165,116,0.09)" };
  if (kind === "start") return { color: "var(--preview)", border: "rgba(43,224,138,0.3)", background: "rgba(43,224,138,0.08)" };
  return { color: "var(--cream-dim)", border: "var(--line-soft)", background: "rgba(255,255,255,0.025)" };
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export default function SetupCenterHost() {
  const [open, setOpen] = useState(false);
  const [requestedRoute, setRequestedRoute] = useState<string | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const [payload, setPayload] = useState<SetupPayload>({});
  const [statuses, setStatuses] = useState<Record<string, NavigationStatus>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [tab, setTab] = useState<Tab>("setup");
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<SetupActionDefinition | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [copied, setCopied] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogContentRef = useRef<HTMLDivElement>(null);
  const confirmDialogRef = useRef<HTMLDivElement>(null);
  const cancelConfirmRef = useRef<HTMLButtonElement>(null);
  const confirmationTriggerRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [setupResponse, statusResponse] = await Promise.all([
        fetch("/api/setup", { cache: "no-store" }),
        fetch("/api/navigation-status", { cache: "no-store" }),
      ]);
      if (!setupResponse.ok) throw new Error(`Setup API returned ${setupResponse.status}`);
      const nextPayload = await setupResponse.json() as SetupPayload;
      const nextStatuses = statusResponse.ok
        ? (await statusResponse.json() as { statuses?: Record<string, NavigationStatus> }).statuses ?? {}
        : {};
      setPayload(nextPayload);
      setStatuses(nextStatuses);
      const entries = nextPayload.entries ?? [];
      setSelectedRoute((current) => {
        const preferred = requestedRoute ?? current;
        if (preferred && entries.some((entry) => entry.route === preferred)) return preferred;
        return entries.find((entry) => nextStatuses[entry.route]?.status !== "ready")?.route ?? entries[0]?.route ?? null;
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Setup Center is unavailable");
    } finally {
      setLoading(false);
    }
  }, [requestedRoute]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const route = (event as CustomEvent<{ route?: string }>).detail?.route ?? null;
      setRequestedRoute(route);
      setSelectedRoute(route);
      setOpen(true);
      setTab("setup");
      setValues({});
      setRevealed(new Set());
      setPendingAction(null);
      setResult(null);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => closeRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = priorOverflow;
      prior?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const background = dialogContentRef.current;
    if (pendingAction) {
      background?.setAttribute("inert", "");
      background?.setAttribute("aria-hidden", "true");
      window.setTimeout(() => cancelConfirmRef.current?.focus(), 0);
    } else {
      background?.removeAttribute("inert");
      background?.removeAttribute("aria-hidden");
      const trigger = confirmationTriggerRef.current;
      confirmationTriggerRef.current = null;
      if (trigger?.isConnected) window.setTimeout(() => trigger.focus(), 0);
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (pendingAction) setPendingAction(null);
        else setOpen(false);
        return;
      }
      const focusRoot = pendingAction ? confirmDialogRef.current : dialogRef.current;
      if (event.key !== "Tab" || !focusRoot) return;
      const focusable = [...focusRoot.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
        .filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      background?.removeAttribute("inert");
      background?.removeAttribute("aria-hidden");
    };
  }, [open, pendingAction]);

  const entries = payload.entries ?? [];
  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      const status = statuses[entry.route];
      const ready = entry.readiness?.ready || status?.status === "ready";
      if (filter === "broken" && entry.category !== "broken") return false;
      if (filter === "connected" && !ready) return false;
      if (filter === "setup" && (ready || entry.category === "broken")) return false;
      return !needle || `${entry.title} ${entry.summary} ${entry.route}`.toLowerCase().includes(needle);
    });
  }, [entries, filter, query, statuses]);
  const selected = entries.find((entry) => entry.route === selectedRoute) ?? null;
  const selectedStatus = selected ? statuses[selected.route] : undefined;
  const tone = selected ? statusTone(selectedStatus, selected.category, selected.readiness) : null;
  const counts = useMemo(() => ({
    setup: entries.filter((entry) => !(entry.readiness?.ready || statuses[entry.route]?.status === "ready") && entry.category !== "broken").length,
    broken: entries.filter((entry) => entry.category === "broken" && !(entry.readiness?.ready || statuses[entry.route]?.status === "ready")).length,
    connected: entries.filter((entry) => entry.readiness?.ready || statuses[entry.route]?.status === "ready").length,
  }), [entries, statuses]);

  useEffect(() => {
    setValues({});
    setRevealed(new Set());
    setPendingAction(null);
    setResult(null);
  }, [selectedRoute]);

  const execute = useCallback(async (action: SetupActionDefinition, confirmed = false) => {
    if (!selected) return;
    if (action.requiresConfirm && !confirmed) {
      confirmationTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPendingAction(action);
      return;
    }
    const actionValues = Object.fromEntries((action.fields ?? []).map((field) => [field.id, values[actionFieldKey(action.id, field.id)] ?? ""]));
    const missing = (action.fields ?? []).find((field) => field.required && !actionValues[field.id]?.trim());
    if (missing) {
      setResult({ ok: false, message: `${missing.label} is required.` });
      setTab("activity");
      return;
    }
    setBusyAction(action.id);
    setPendingAction(null);
    setResult(null);
    try {
      const response = await fetch("/api/setup/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: selected.route, actionId: action.id, confirm: confirmed || undefined, values: actionValues }),
      });
      const next = await response.json().catch(() => ({})) as ActionResult;
      if (!response.ok || next.ok === false) throw new Error(next.error || next.message || `Action returned ${response.status}`);
      setResult(next);
      if ((action.fields ?? []).length > 0) {
        const completedKeys = new Set((action.fields ?? []).map((field) => actionFieldKey(action.id, field.id)));
        setValues((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !completedKeys.has(key))));
        setRevealed((current) => new Set([...current].filter((key) => !completedKeys.has(key))));
      }
      if (next.diagnostics) {
        setPayload((current) => ({ ...current, entries: (current.entries ?? []).map((entry) => entry.route === selected.route ? { ...entry, diagnostics: next.diagnostics } : entry) }));
      }
      setTab("activity");
      await refresh();
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : "The action failed" });
      setTab("activity");
    } finally {
      setBusyAction(null);
    }
  }, [refresh, selected, values]);

  if (!open) return null;

  return (
    <div data-setup-center-root className="fixed inset-0 z-[90] flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm md:items-center md:p-5">
      <button type="button" aria-label="Close Setup Center" className="absolute inset-0 cursor-default" onClick={() => setOpen(false)} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-center-title"
        data-setup-route={selected?.route ?? ""}
        className="relative z-10 flex h-[92dvh] w-full max-w-[1160px] flex-col overflow-hidden rounded-t-xl border md:h-[min(86dvh,820px)] md:rounded-lg"
        style={{ background: "var(--bg-mid)", borderColor: "var(--line)", boxShadow: "0 32px 100px rgba(0,0,0,.62)" }}
      >
        <div ref={dialogContentRef} className="flex min-h-0 flex-1 flex-col">
        <header className="flex min-h-[62px] shrink-0 items-center gap-3 border-b px-4 md:px-5" style={{ borderColor: "var(--line-soft)", background: "var(--bg-deep)" }}>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border" style={{ color: "var(--gold)", borderColor: "rgba(212,165,116,.3)", background: "rgba(212,165,116,.08)" }}><PlugZap size={17} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="setup-center-title" className="text-[15px] font-semibold tracking-tight text-[var(--cream)]">Setup Center</h2>
            <p className="truncate text-[10px] uppercase tracking-[0.14em] text-[var(--cream-mute)]">Install · connect · start · verify</p>
          </div>
          <div className="hidden items-center gap-2 text-[10px] md:flex">
            <span className="pill pill-warn">{counts.setup} setup</span>
            {counts.broken > 0 && <span className="pill pill-err">{counts.broken} repair</span>}
            <span className="pill pill-ok">{counts.connected} connected</span>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh setup status" className="grid h-9 w-9 place-items-center rounded-md text-[var(--cream-dim)] transition hover:bg-white/5 hover:text-[var(--cream)] disabled:opacity-50">
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
          <button ref={closeRef} type="button" onClick={() => setOpen(false)} aria-label="Close Setup Center" className="grid h-9 w-9 place-items-center rounded-md border text-[var(--cream-dim)] transition hover:text-[var(--cream)]" style={{ borderColor: "var(--line-soft)" }}><X size={16} /></button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[288px_minmax(0,1fr)]">
          <aside className="hidden min-h-0 flex-col border-r md:flex" style={{ borderColor: "var(--line-soft)", background: "rgba(0,0,0,.1)" }}>
            <div className="shrink-0 space-y-2 border-b p-3" style={{ borderColor: "var(--line-soft)" }}>
              <label className="flex h-9 items-center gap-2 rounded-md border px-2.5" style={{ borderColor: "var(--line-soft)", background: "rgba(255,255,255,.025)" }}>
                <Search size={13} className="text-[var(--cream-mute)]" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a service" className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--cream)] outline-none placeholder:text-[var(--cream-mute)]" />
              </label>
              <div className="grid grid-cols-4 gap-1" aria-label="Filter services">
                {(["all", "setup", "broken", "connected"] as Filter[]).map((id) => (
                  <button key={id} type="button" onClick={() => setFilter(id)} aria-pressed={filter === id} className="h-7 truncate rounded-sm border px-1 text-[8px] uppercase tracking-[0.08em]" style={{ borderColor: filter === id ? "rgba(212,165,116,.42)" : "var(--line-soft)", color: filter === id ? "var(--gold)" : "var(--cream-mute)", background: filter === id ? "rgba(212,165,116,.08)" : "transparent" }}>{id}</button>
                ))}
              </div>
            </div>
            <ScrollArea ariaLabel="Services in Setup Center" className="min-h-0 flex-1" viewportClassName="h-full" scrollbar="hover" fades overscroll="contain" style={{ "--scroll-area-fade-color": "var(--bg-mid)" } as CSSProperties}>
              <div className="space-y-0.5 p-2">
                {filteredEntries.map((entry) => {
                  const entryTone = statusTone(statuses[entry.route], entry.category, entry.readiness);
                  const active = selectedRoute === entry.route;
                  return (
                    <button key={entry.route} type="button" onClick={() => { setSelectedRoute(entry.route); setTab("setup"); }} className="group flex min-h-[52px] w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition" style={{ borderColor: active ? `${entryTone.color}55` : "transparent", background: active ? entryTone.bg : "transparent" }}>
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-sm border" style={{ color: entryTone.color, borderColor: `${entryTone.color}38`, background: entryTone.bg }}>{entry.category === "broken" ? <Wrench size={13} /> : statuses[entry.route]?.status === "ready" ? <CheckCircle2 size={13} /> : <PlugZap size={13} />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11.5px] font-medium text-[var(--cream)]">{entry.title}</span>
                        <span className="block truncate text-[9px] text-[var(--cream-mute)]">{entryTone.label}</span>
                      </span>
                      <ChevronRight size={12} className="shrink-0 text-[var(--cream-mute)] transition group-hover:translate-x-0.5" />
                    </button>
                  );
                })}
                {!loading && filteredEntries.length === 0 && <div className="px-3 py-8 text-center text-[11px] text-[var(--cream-mute)]">No matching services.</div>}
              </div>
            </ScrollArea>
          </aside>

          <section className="flex min-h-0 min-w-0 flex-col">
            <div className="shrink-0 border-b px-4 py-3 md:px-5" style={{ borderColor: "var(--line-soft)" }}>
              <div className="mb-3 md:hidden">
                <label className="mb-1 block text-[9px] uppercase tracking-[0.14em] text-[var(--cream-mute)]" htmlFor="setup-service-select">Service</label>
                <select id="setup-service-select" value={selectedRoute ?? ""} onChange={(event) => setSelectedRoute(event.target.value)} className="h-11 w-full rounded-md border px-3 text-[12px] text-[var(--cream)] outline-none" style={{ borderColor: "var(--line-soft)", background: "var(--bg-deep)" }}>
                  {entries.map((entry) => <option key={entry.route} value={entry.route}>{entry.title} · {statusTone(statuses[entry.route], entry.category, entry.readiness).label}</option>)}
                </select>
              </div>
              {selected && tone && (
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <h3 className="text-[18px] font-semibold tracking-tight text-[var(--cream)]">{selected.title}</h3>
                      <span className="pill" style={{ color: tone.color, borderColor: `${tone.color}55`, background: tone.bg }}>{tone.label}</span>
                    </div>
                    <p className="max-w-3xl text-[11.5px] leading-relaxed text-[var(--cream-dim)]">{selected.summary}</p>
                    {(selected.readiness?.reason || selectedStatus?.reason) && <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--cream-mute)]">Current check: {selected.readiness?.reason || selectedStatus?.reason}</p>}
                  </div>
                  <a href={selected.route} className="hidden min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-[10.5px] text-[var(--cream-dim)] transition hover:text-[var(--cream)] sm:inline-flex" style={{ borderColor: "var(--line-soft)" }}><ExternalLink size={12} /> Open tool</a>
                </div>
              )}
              <div className="mt-3 flex gap-1 overflow-x-auto" role="tablist" aria-label="Setup Center views">
                {(["setup", "guide", "activity"] as Tab[]).map((id) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className="min-h-8 shrink-0 border-b-2 px-3 text-[9px] uppercase tracking-[0.13em]" style={{ borderColor: tab === id ? "var(--gold)" : "transparent", color: tab === id ? "var(--gold)" : "var(--cream-mute)" }}>{id}</button>
                ))}
              </div>
            </div>

            <ScrollArea ariaLabel="Selected service setup" className="min-h-0 flex-1" viewportClassName="h-full" scrollbar="hover" fades overscroll="contain" style={{ "--scroll-area-fade-color": "var(--bg-mid)" } as CSSProperties}>
              <div className="p-4 pb-8 md:p-5 md:pb-8">
                {loadError && <div className="mb-4 rounded-md border px-3 py-2.5 text-[11px]" style={{ borderColor: "rgba(255,46,77,.35)", background: "rgba(255,46,77,.08)", color: "var(--tally)" }}>{loadError}</div>}
                {loading && !selected && <div className="grid min-h-[240px] place-items-center text-[11px] text-[var(--cream-mute)]"><span className="inline-flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> Inspecting local services…</span></div>}
                {selected && tab === "setup" && (
                  <div className="space-y-5">
                    <div>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <h4 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--cream-dim)]">Readiness</h4>
                        <span className="text-[9px] text-[var(--cream-mute)]">Read-only checks · no generation or paid calls</span>
                      </div>
                      <div className="grid gap-1.5 sm:grid-cols-2">
                        {(selected.diagnostics ?? []).map((diagnostic, index) => {
                          const state = diagnosticState(diagnostic);
                          return (
                            <div key={diagnostic.id ?? `${diagnosticLabel(diagnostic)}-${index}`} className="flex min-h-[46px] items-start gap-2.5 rounded-md border px-3 py-2" style={{ borderColor: "var(--line-soft)", background: "rgba(255,255,255,.018)" }}>
                              <span className="mt-0.5 shrink-0">{diagnosticIcon(state)}</span>
                              <span className="min-w-0">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-[11px] font-medium text-[var(--cream)]">{diagnosticLabel(diagnostic)}</span>
                                  {diagnostic.impact && diagnostic.impact !== "required" && <span className="text-[7.5px] uppercase tracking-[0.1em] text-[var(--cream-mute)]">{diagnostic.impact === "alternative" ? "one of" : "optional"}</span>}
                                  {diagnostic.evidence === "configured" && state === "ready" && <span className="text-[7.5px] uppercase tracking-[0.1em] text-[var(--sdi-soft)]">configured</span>}
                                </span>
                                {(diagnostic.detail || diagnostic.message || diagnostic.reason) && <span className="block text-[9.5px] leading-relaxed text-[var(--cream-mute)]">{diagnostic.detail || diagnostic.message || diagnostic.reason}</span>}
                              </span>
                            </div>
                          );
                        })}
                        {(selected.diagnostics ?? []).length === 0 && <div className="sm:col-span-2 rounded-md border px-3 py-3 text-[10px] text-[var(--cream-mute)]" style={{ borderColor: "var(--line-soft)" }}>Run Test to collect detailed local checks.</div>}
                      </div>
                    </div>

                    <div>
                      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--cream-dim)]">Actions</h4>
                      <div className="grid gap-2 lg:grid-cols-2">
                        {selected.actions.map((action) => {
                          const actionStyle = actionTone(action.kind);
                          const activeBusy = busyAction === action.id;
                          return (
                            <div key={action.id} className="rounded-md border p-3" style={{ borderColor: actionStyle.border, background: actionStyle.background }}>
                              <div className="flex items-start gap-2">
                                <span className="mt-0.5" style={{ color: actionStyle.color }}>{ACTION_ICON[action.kind]}</span>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-[11.5px] font-semibold text-[var(--cream)]">{action.label}</span>
                                    <span className="text-[8px] uppercase tracking-[0.1em]" style={{ color: action.availability === "automatic" ? "var(--preview)" : "var(--cream-mute)" }}>{action.availability}</span>
                                  </div>
                                  <p className="mt-1 text-[9.5px] leading-relaxed text-[var(--cream-mute)]">{action.description}</p>
                                </div>
                              </div>
                              {(action.fields ?? []).length > 0 && (
                                <div className="mt-3 space-y-2">
                                  {(action.fields ?? []).map((field) => (
                                    <label key={field.id} className="block">
                                      <span className="mb-1 flex items-center justify-between gap-2 text-[9px] font-medium text-[var(--cream-dim)]"><span>{field.label}{field.required ? " *" : ""}</span>{field.type === "secret" && <ShieldCheck size={11} style={{ color: "var(--preview)" }} />}</span>
                                      <span className="relative block">
                                        <input
                                          type={field.type === "secret" && !revealed.has(actionFieldKey(action.id, field.id)) ? "password" : "text"}
                                          autoComplete="off"
                                          value={values[actionFieldKey(action.id, field.id)] ?? ""}
                                          onChange={(event) => setValues((current) => ({ ...current, [actionFieldKey(action.id, field.id)]: event.target.value }))}
                                          placeholder={field.placeholder}
                                          className="h-9 w-full rounded-sm border bg-black/20 px-2.5 pr-9 text-[11px] text-[var(--cream)] outline-none focus:border-[var(--sdi-blue)]"
                                          style={{ borderColor: "var(--line-soft)" }}
                                        />
                                        {field.type === "secret" && (
                                          <button type="button" onClick={() => setRevealed((current) => { const key = actionFieldKey(action.id, field.id); const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} aria-label={revealed.has(actionFieldKey(action.id, field.id)) ? `Hide ${field.label}` : `Show ${field.label}`} className="absolute inset-y-0 right-0 grid w-9 place-items-center text-[var(--cream-mute)]">
                                            {revealed.has(actionFieldKey(action.id, field.id)) ? <EyeOff size={12} /> : <Eye size={12} />}
                                          </button>
                                        )}
                                      </span>
                                      {field.help && <span className="mt-1 block text-[8.5px] leading-relaxed text-[var(--cream-mute)]">{field.help}</span>}
                                    </label>
                                  ))}
                                </div>
                              )}
                              {action.copyCommand && (
                                <div className="mt-3 flex items-center gap-2 rounded-sm border bg-black/20 px-2 py-1.5" style={{ borderColor: "var(--line-soft)" }}>
                                  <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[9px] text-[var(--sdi-soft)]">{action.copyCommand}</code>
                                  <button type="button" onClick={async () => { if (await copyText(action.copyCommand ?? "")) { setCopied(action.id); window.setTimeout(() => setCopied(""), 1600); } }} className="inline-flex shrink-0 items-center gap-1 text-[8.5px] text-[var(--cream-dim)]"><Copy size={10} /> {copied === action.id ? "Copied" : "Copy"}</button>
                                </div>
                              )}
                              <button type="button" onClick={() => void execute(action)} disabled={activeBusy || (busyAction !== null && !activeBusy)} className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-sm border px-3 text-[10px] font-semibold transition hover:brightness-125 disabled:cursor-wait disabled:opacity-50" style={{ color: actionStyle.color, borderColor: actionStyle.border, background: "rgba(0,0,0,.16)" }}>
                                {activeBusy ? <Loader2 size={12} className="animate-spin" /> : ACTION_ICON[action.kind]} {activeBusy ? "Working…" : action.label}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {selected && tab === "guide" && (
                  <div>
                    <div className="mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-[9.5px] text-[var(--cream-mute)]" style={{ borderColor: "var(--line-soft)", background: "rgba(255,255,255,.018)" }}><ShieldCheck size={13} style={{ color: "var(--preview)" }} /> This is the project&apos;s mapped guide. Windows-specific blockers detected by Test take precedence over older macOS commands.</div>
                    <div className="mb-5 max-w-3xl rounded-md border p-3" style={{ borderColor: "var(--line-soft)", background: "rgba(255,255,255,.018)" }}>
                      <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cream-dim)]">Steps available on this Windows computer</h4>
                      <div className="mt-2 space-y-1.5">
                        {selected.actions.map((action, index) => (
                          <div key={`guide-${action.id}`} className="flex items-start gap-2 rounded-sm border px-2.5 py-2" style={{ borderColor: "var(--line-soft)" }}>
                            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[8px] font-semibold" style={{ background: "rgba(212,165,116,.1)", color: "var(--gold)" }}>{index + 1}</span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[10.5px] font-medium text-[var(--cream)]">{action.label} · {action.availability === "automatic" ? "can run here" : "guided"}</span>
                              <span className="mt-0.5 block text-[9px] leading-relaxed text-[var(--cream-mute)]">{action.description}</span>
                              {action.copyCommand && <code className="mt-1.5 block overflow-x-auto whitespace-pre text-[8.5px] text-[var(--sdi-soft)]">{action.copyCommand}</code>}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {selected.guideMarkdown ? (
                      <div className="setup-guide max-w-3xl text-[11.5px] leading-relaxed text-[var(--cream-dim)]">
                        <ReactMarkdown components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="text-[var(--sdi-soft)] underline underline-offset-2">{children}</a> }}>{selected.guideMarkdown}</ReactMarkdown>
                      </div>
                    ) : <div className="rounded-md border px-4 py-5 text-[11px] text-[var(--cream-mute)]" style={{ borderColor: "var(--line-soft)" }}>No standalone document exists yet. Use the service-specific readiness checks and actions on the Setup tab.</div>}
                  </div>
                )}

                {selected && tab === "activity" && (
                  <div className="max-w-3xl">
                    <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--cream-dim)]">Latest action</h4>
                    {!result && !busyAction && <div className="rounded-md border px-4 py-5 text-[11px] text-[var(--cream-mute)]" style={{ borderColor: "var(--line-soft)" }}>No action has run in this window yet.</div>}
                    {busyAction && !result && <div className="flex items-center gap-2 rounded-md border px-4 py-4 text-[11px] text-[var(--sdi-soft)]" style={{ borderColor: "rgba(46,125,255,.3)", background: "rgba(46,125,255,.07)" }}><Loader2 size={14} className="animate-spin" /> The allowlisted action is running…</div>}
                    {result && (
                      <div className="rounded-md border p-4" style={{ borderColor: result.ok === false ? "rgba(255,46,77,.35)" : "rgba(43,224,138,.3)", background: result.ok === false ? "rgba(255,46,77,.07)" : "rgba(43,224,138,.06)" }}>
                        <div className="flex items-start gap-2">
                          {result.ok === false ? <AlertTriangle size={15} style={{ color: "var(--tally)" }} /> : <CheckCircle2 size={15} style={{ color: "var(--preview)" }} />}
                          <div className="min-w-0 flex-1">
                            <div className="text-[11.5px] font-semibold text-[var(--cream)]">{result.mode === "manual" ? "Manual step ready" : result.ok === false ? "Action failed" : "Action completed"}</div>
                            <p className="mt-1 whitespace-pre-wrap text-[10px] leading-relaxed text-[var(--cream-dim)]">{result.message || result.error || "The service was checked."}</p>
                          </div>
                        </div>
                        {result.copyCommand && <div className="mt-3 flex items-center gap-2 rounded-sm border bg-black/20 px-2.5 py-2" style={{ borderColor: "var(--line-soft)" }}><code className="min-w-0 flex-1 overflow-x-auto text-[9px] text-[var(--sdi-soft)]">{result.copyCommand}</code><button type="button" onClick={() => void copyText(result.copyCommand ?? "")} className="inline-flex shrink-0 items-center gap-1 text-[9px] text-[var(--cream-dim)]"><Copy size={10} /> Copy</button></div>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </ScrollArea>
          </section>
        </div>
        </div>

        {pendingAction && selected && (
          <div className="absolute inset-0 z-20 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
            <div ref={confirmDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="setup-confirm-title" aria-describedby="setup-confirm-description" className="w-full max-w-md rounded-lg border p-5" style={{ borderColor: "rgba(255,176,32,.36)", background: "var(--bg-deep)", boxShadow: "0 24px 70px rgba(0,0,0,.55)" }}>
              <span className="mb-3 grid h-9 w-9 place-items-center rounded-md" style={{ color: "var(--amber)", background: "rgba(255,176,32,.1)" }}><AlertTriangle size={17} /></span>
              <h3 id="setup-confirm-title" className="text-[15px] font-semibold text-[var(--cream)]">Confirm {pendingAction.label}</h3>
              <p id="setup-confirm-description" className="mt-2 text-[10.5px] leading-relaxed text-[var(--cream-dim)]">{pendingAction.description}</p>
              {pendingAction.copyCommand && (
                <div className="mt-3 rounded-sm border bg-black/25 px-3 py-2" style={{ borderColor: "var(--line-soft)" }}>
                  <div className="mb-1 text-[8px] uppercase tracking-[0.12em] text-[var(--cream-mute)]">Exact allowlisted command</div>
                  <code className="block overflow-x-auto whitespace-pre text-[9px] text-[var(--sdi-soft)]">{pendingAction.copyCommand}</code>
                </div>
              )}
              <p className="mt-2 text-[9.5px] leading-relaxed text-[var(--cream-mute)]">Only the fixed, allowlisted action for {selected.title} will run. No command text is accepted from the browser.</p>
              <div className="mt-5 flex justify-end gap-2">
                <button ref={cancelConfirmRef} type="button" onClick={() => setPendingAction(null)} className="min-h-10 rounded-md border px-4 text-[10.5px] text-[var(--cream-dim)]" style={{ borderColor: "var(--line-soft)" }}>Cancel</button>
                <button type="button" onClick={() => void execute(pendingAction, true)} className="min-h-10 rounded-md px-4 text-[10.5px] font-semibold" style={{ color: "#211506", background: "var(--amber)" }}>Confirm action</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
