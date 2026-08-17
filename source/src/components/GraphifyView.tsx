"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Network, Terminal, Send, Loader2, FolderOpen, FileCode,
  Search, Route, HelpCircle, BookOpen, RefreshCw,
} from "lucide-react";

const ACCENT = "#a855f7";
const ACCENT2 = "#8b5cf6";
const HKEY = "agentic-os/graphify/history/v1";
const GRAPHIFY_DIR = "D:\\משה פרוייקטים\\פיתוח אתרים\\AI\\graphify";

interface Run {
  command: string;
  stdout: string;
  stderr: string;
  ok: boolean;
  ms: number;
}

const QUICK_ACTIONS = [
  { label: "Version", cmd: "--version", icon: <HelpCircle size={14} /> },
  { label: "God Nodes", cmd: "god-nodes --top 5", icon: <Network size={14} /> },
  { label: "Status", cmd: "diagnose multigraph", icon: <FileCode size={14} /> },
  { label: "Tree View", cmd: "tree --max-children 100", icon: <Route size={14} /> },
];

const REPO_PRESETS = [
  { label: "PanoWorld", path: "D:\\משה פרוייקטים\\פיתוח אתרים\\PanoWorld-Automation" },
  { label: "AGENT-OS", path: "D:\\משה פרוייקטים\\פיתוח אתרים\\AGENT-OS\\source" },
  { label: "AMIT-SITE", path: "D:\\משה פרוייקטים\\פיתוח אתרים\\AMIT-SITE" },
  { label: "BLOONS-SITE", path: "D:\\משה פרוייקטים\\פיתוח אתרים\\BLOONS-SITE" },
  { label: "NIR-APP", path: "D:\\משה פרוייקטים\\פיתוח אתרים\\NIR-APP" },
];

export default function GraphifyView() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [cmd, setCmd] = useState("");
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [workDir, setWorkDir] = useState(GRAPHIFY_DIR);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    try { const r = localStorage.getItem(HKEY); if (r) setRuns(JSON.parse(r).slice(-30)); } catch { /* ignore */ }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (hydrated.current) {
      try { localStorage.setItem(HKEY, JSON.stringify(runs.slice(-30))); } catch { /* ignore */ }
    }
  }, [runs]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [runs, running]);

  const runCmd = useCallback(async (command: string, cwdOverride?: string) => {
    const fullCmd = command.trim();
    if (!fullCmd || running) return;
    setRunning(true);
    setErr(null);
    const t0 = Date.now();
    try {
      const res = await fetch("/api/graphify/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: fullCmd, cwd: cwdOverride ?? workDir }),
      });
      const data = await res.json();
      const run: Run = {
        command: fullCmd,
        stdout: data.stdout ?? "",
        stderr: data.stderr ?? "",
        ok: data.ok,
        ms: data.durationMs ?? (Date.now() - t0),
      };
      setRuns((prev) => [...prev, run]);
    } catch (e) {
      setErr(String(e));
    } finally {
      setRunning(false);
    }
  }, [running, workDir]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runCmd(cmd);
    setCmd("");
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-white/10 shrink-0">
        <Network size={22} style={{ color: ACCENT }} />
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-white/90">Graphify</h2>
          <p className="text-[11px] text-white/40">Codebase Knowledge Graph</p>
        </div>
        <div className="flex items-center gap-2">
          <FolderOpen size={14} className="text-white/30" />
          <select
            className="text-[11px] bg-white/5 border border-white/10 rounded px-2 py-1 text-white/60 max-w-[200px]"
            value={workDir}
            onChange={(e) => setWorkDir(e.target.value)}
          >
            <option value={GRAPHIFY_DIR}>Graphify root</option>
            {REPO_PRESETS.map((r) => (
              <option key={r.path} value={r.path}>{r.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex gap-2 px-5 py-2 border-b border-white/5 shrink-0 flex-wrap">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.label}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-md border border-white/10 text-white/60 hover:text-white hover:border-white/30 transition-colors disabled:opacity-40"
            onClick={() => runCmd(a.cmd)}
            disabled={running}
          >
            {a.icon}
            {a.label}
          </button>
        ))}
        {REPO_PRESETS.slice(0, 3).map((r) => (
          <button
            key={r.label}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-md border border-white/10 text-white/40 hover:text-white hover:border-white/30 transition-colors disabled:opacity-40"
            onClick={() => runCmd(`extract "${r.path}" --code-only`, r.path)}
            disabled={running}
            title={`Extract ${r.label} (AST only, no API key)`}
          >
            <RefreshCw size={12} />
            Scan {r.label}
          </button>
        ))}
      </div>

      {/* Output area */}
      <div ref={scrollRef} className="flex-1 overflow-auto px-5 py-3 font-mono text-[12px] space-y-3">
        {runs.length === 0 && !err && (
          <div className="text-white/20 text-center mt-12">
            <Network size={32} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm">Run a graphify command to get started</p>
            <p className="text-[11px] mt-1">e.g. <code className="text-white/40 bg-white/5 px-1.5 py-0.5 rounded">god-nodes --top 5</code></p>
          </div>
        )}

        {err && (
          <div className="text-red-400 bg-red-500/10 border border-red-500/20 rounded-md p-3 text-[12px]">
            {err}
          </div>
        )}

        {runs.map((run, i) => (
          <div key={i} className="border border-white/10 rounded-md overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 border-b border-white/10">
              <span className={`w-2 h-2 rounded-full ${run.ok ? "bg-emerald-400" : "bg-red-400"}`} />
              <span className="text-white/50 text-[10px]">$ graphify {run.command}</span>
              <span className="ml-auto text-white/30 text-[10px]">{run.ms}ms</span>
            </div>
            <pre className="px-3 py-2 text-white/70 whitespace-pre-wrap break-all max-h-[400px] overflow-auto">
              {run.stdout || run.stderr || <span className="text-white/20 italic">no output</span>}
            </pre>
          </div>
        ))}
      </div>

      {/* Command input */}
      <form onSubmit={handleSubmit} className="shrink-0 border-t border-white/10 px-5 py-3">
        <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-md px-3 py-2 focus-within:border-purple-500/50 transition-colors">
          <Terminal size={14} className="text-white/30 shrink-0" />
          <span className="text-white/40 text-[11px] shrink-0">$&nbsp;graphify</span>
          <input
            className="flex-1 bg-transparent border-none outline-none text-[13px] text-white/80 placeholder:text-white/20"
            placeholder="extract <path> --code-only | god-nodes --top 5 | query &quot;question&quot; | help"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            disabled={running}
          />
          <button
            type="submit"
            disabled={running || !cmd.trim()}
            className="shrink-0 p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-30"
          >
            {running ? <Loader2 size={16} className="animate-spin text-purple-400" /> : <Send size={16} className="text-white/40" />}
          </button>
        </div>
        {running && (
          <div className="flex items-center gap-2 mt-2">
            <Loader2 size={12} className="animate-spin text-purple-400" />
            <span className="text-[11px] text-white/40">Running command...</span>
          </div>
        )}
      </form>
    </div>
  );
}