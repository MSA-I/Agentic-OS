"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Radio } from "lucide-react";
import Panel from "./Panel";

interface Entry { ts: number; agent: string; text: string; level?: string; }
interface Source { kind: string; path?: string; entries: number; note?: string; }

export default function ActivityStream() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [sources, setSources] = useState<Source[]>([]);

  useEffect(() => {
    let stop = false;
    const fetchIt = async () => {
      try {
        const r = await fetch("/api/activity", { cache: "no-store" });
        const j = await r.json();
        if (!stop) {
          setEntries(j.entries ?? []);
          setSources(j.sources ?? []);
        }
      } catch { /* ignore */ }
    };
    fetchIt();
    const t = setInterval(fetchIt, 8000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  const dot = (a: string) =>
    a === "openclaw" ? "text-[var(--openclaw)]" :
    a === "hermes" ? "text-[var(--hermes)]" :
    "text-[var(--claude)]";

  return (
    <Panel
      title="Activity Stream"
      accent="system"
      icon={<Radio size={14} />}
      actions={
        <span className="pill pill-info">
          <span className="heartbeat" /> {entries.length} events
        </span>
      }
      className="min-h-[460px]"
    >
      <div className="scroll stream-fade overflow-y-auto h-full min-h-0 pr-2">
        <AnimatePresence initial={false}>
          {entries.length === 0 && (
            // Name the sources that were checked. An empty panel with no explanation
            // reads as "nothing happened" when the real answer is "this path holds
            // no logs".
            <div className="text-sm text-[var(--fg-dim)]">
              <p>No activity to show yet. Checked:</p>
              <ul className="mt-2 space-y-1 text-[11.5px]">
                {sources.map((source) => (
                  <li key={source.kind}>
                    <span className="text-[var(--fg)]">{source.kind}</span>
                    {source.path && <> · <code>{source.path}</code></>}
                    {source.note && <> · {source.note}</>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {entries.map((e, i) => (
            <motion.div
              key={`${e.ts}-${i}`}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.25, delay: Math.min(i * 0.01, 0.2) }}
              className="flex gap-2 py-1.5 text-[11.5px] font-[var(--font-geist-mono)] border-b border-[rgba(255,255,255,0.04)] last:border-0"
            >
              <span className={`${dot(e.agent)} shrink-0`}>●</span>
              <span className="text-[var(--fg-dimmer)] shrink-0">
                {new Date(e.ts).toLocaleTimeString("en-GB", { hour12: false })}
              </span>
              <span className="text-[var(--fg-dim)] uppercase shrink-0 w-16 truncate">{e.agent}</span>
              <span className={`${
                e.level === "err" ? "text-rose-300" :
                e.level === "warn" ? "text-amber-300" :
                "text-[var(--fg-dim)]"
              } truncate`}>
                {e.text}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Panel>
  );
}
