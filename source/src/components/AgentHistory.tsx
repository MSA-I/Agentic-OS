"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Clock3, Copy, FolderTree, MessageSquare, RefreshCw } from "lucide-react";

type Agent = "claude" | "openclaw" | "hermes" | "antigravity" | "codex";
interface Row { id: string; name: string; path: string; mtime: number; bytes: number; }
interface Group { id: string; label: string; root: string; sessions: Row[]; }
interface Turn { role: string; text: string; }
interface Detail { path: string; turns: Turn[]; raw: string; bytes: number; truncated: boolean; cwd?: string; model?: string | null; }

const fmt = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export default function AgentHistory({ agent }: { agent: Agent }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [source, setSource] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Row | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const openRow = useCallback(async (row: Row) => {
    setSelected(row); setDetail(null); setDetailLoading(true);
    try {
      const response = await fetch(`/api/agent-history?agent=${agent}&path=${encodeURIComponent(row.path)}`, { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setDetail(data.detail ?? null);
    } finally { setDetailLoading(false); }
  }, [agent]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await (await fetch(`/api/agent-history?agent=${agent}`, { cache: "no-store" })).json();
      const next: Group[] = data.groups ?? [];
      setGroups(next); setSource(data.source ?? "");
      const requested = sessionStorage.getItem(`agentic-os:${agent}:selected-session`);
      const requestedGroup = requested ? next.find((group) => group.sessions.some((session) => session.path === requested)) : null;
      setExpandedId((current) => requestedGroup?.id ?? current ?? next.find((group) => group.sessions.length)?.id ?? null);
      const requestedRow = requestedGroup?.sessions.find((session) => session.path === requested);
      if (requestedRow) {
        sessionStorage.removeItem(`agentic-os:${agent}:selected-session`);
        void openRow(requestedRow);
      }
    } finally { setLoading(false); }
  }, [agent, openRow]);

  useEffect(() => { void load(); }, [load]);
  const total = groups.reduce((count, group) => count + group.sessions.length, 0);

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--panel-border)] px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-[var(--fg)]"><FolderTree size={14} /> Projects / profiles · {groups.length}</div>
          <div className="mt-1 truncate text-[10.5px] text-[var(--fg-dimmer)]">{total} sessions · {source}</div>
        </div>
        <button onClick={load} disabled={loading} className="rounded-lg border border-[var(--panel-border)] p-2 text-[var(--fg-dim)] disabled:opacity-50" title="Refresh history">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="grid min-h-[560px] grid-cols-1 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
        <div className="max-h-[68vh] overflow-y-auto border-r border-[var(--panel-border)] p-3 space-y-2">
          {!loading && groups.length === 0 && <div className="p-8 text-center text-sm text-[var(--fg-dim)]">No local projects or profiles found for this agent.</div>}
          {groups.map((group) => {
            const expanded = expandedId === group.id;
            return <section key={group.id} className="overflow-hidden rounded-xl border border-[var(--panel-border)]">
              <button onClick={() => setExpandedId(expanded ? null : group.id)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/[0.025]">
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--fg)]" title={group.label}>{group.label}</span>
                <span className="text-[10px] text-[var(--fg-dimmer)]">{group.sessions.length}</span>
                <span onClick={(event) => { event.stopPropagation(); navigator.clipboard?.writeText(group.root); }} className="p-1 text-[var(--fg-dimmer)] hover:text-[var(--fg)]" title="Copy project path"><Copy size={11} /></span>
              </button>
              {expanded && <div className="space-y-1 border-t border-[var(--panel-border)] px-3 py-2">
                {group.sessions.length === 0 && <div className="py-2 text-[11px] text-[var(--fg-dimmer)]">No sessions in this project.</div>}
                {group.sessions.map((row) => <div key={row.path} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-lg px-2 py-1.5 hover:bg-white/[0.025]" style={{ background: selected?.path === row.path ? "rgba(255,255,255,0.045)" : undefined }}>
                  <button onClick={() => void openRow(row)} className="min-w-0 text-left">
                    <div className="truncate text-[11.5px] text-[var(--fg-dim)]">{row.name}</div>
                    <div className="mt-0.5 flex items-center gap-1 text-[9.5px] text-[var(--fg-dimmer)]"><Clock3 size={9} /> {new Date(row.mtime).toLocaleString()} · {fmt(row.bytes)}</div>
                  </button>
                  <button onClick={() => navigator.clipboard?.writeText(row.path)} className="text-[var(--fg-dimmer)] hover:text-[var(--fg)]" title="Copy session path"><Copy size={11} /></button>
                </div>)}
              </div>}
            </section>;
          })}
        </div>

        <div className="max-h-[68vh] overflow-y-auto p-4">
          {!selected && <div className="grid h-full min-h-[320px] place-items-center text-center text-[var(--fg-dimmer)]"><div><MessageSquare size={20} className="mx-auto mb-2" /><div className="text-sm">Select a session to read its history.</div></div></div>}
          {selected && <div>
            <div className="sticky top-0 z-10 mb-3 border-b border-[var(--panel-border)] bg-[var(--bg)] pb-3">
              <div className="truncate text-sm font-medium text-[var(--fg)]">{selected.name}</div>
              <div className="mt-1 truncate text-[10px] text-[var(--fg-dimmer)]">{detail?.cwd ?? detail?.path ?? selected.path}{detail?.model ? ` · ${detail.model}` : ""}</div>
            </div>
            {detailLoading && <div className="py-12 text-center text-sm text-[var(--fg-dim)]">Loading transcript…</div>}
            {!detailLoading && detail && detail.turns.length > 0 && <div className="space-y-3">
              {detail.turns.map((turn, index) => <article key={`${index}-${turn.role}`} className="rounded-lg border border-[var(--panel-border)] px-3 py-2.5" style={{ borderLeftColor: turn.role === "user" ? "#94a3b8" : "#60a5fa", borderLeftWidth: 2 }}>
                <div className="mb-1.5 text-[8.5px] font-semibold uppercase tracking-[0.2em] text-[var(--fg-dimmer)]">{turn.role}</div>
                <div className="whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-[var(--fg-dim)]">{turn.text}</div>
              </article>)}
            </div>}
            {!detailLoading && detail && detail.turns.length === 0 && <pre className="whitespace-pre-wrap break-words rounded-lg border border-[var(--panel-border)] p-3 text-[10.5px] leading-relaxed text-[var(--fg-dim)]">{detail.raw || "This session format has no readable transcript."}</pre>}
            {!detailLoading && !detail && <div className="py-12 text-center text-sm text-[var(--fg-dim)]">The session exists, but its transcript could not be opened.</div>}
          </div>}
        </div>
      </div>
    </div>
  );
}
