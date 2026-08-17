import { NextResponse } from "next/server";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config, hermesHome } from "@/lib/config";
import { getDurableWorkbenchControlPlane } from "@/lib/workbench/durableControlPlane";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Entry { ts: number; agent: string; text: string; level?: string; }
interface Source { kind: string; path?: string; entries: number; note?: string; }

/**
 * Log directories, in the order they are actually used. Hermes writes to
 * `<hermesHome>/logs`; the configured default points at `<hermesHome>/cache`, which
 * holds no logs, so the panel rendered empty while 13 log files sat one directory
 * over. Both are reported, so a missing source names the path it checked.
 */
function logDirs(): { agent: string; dir: string }[] {
  const hermesCandidates = [path.join(hermesHome(), "logs"), config.hermesLogs];
  const hermesDir = hermesCandidates.find((candidate) => existsSync(candidate)) ?? config.hermesLogs;
  return [
    { agent: "openclaw", dir: config.openclawLogs },
    { agent: "hermes", dir: hermesDir },
  ];
}

async function tailFile(file: string, agent: string, max = 40): Promise<Entry[]> {
  try {
    const data = await readFile(file, "utf8");
    const lines = data.split(/\r?\n/).filter(Boolean).slice(-max);
    const st = await stat(file);
    const baseTs = st.mtimeMs;
    return lines.map((line, i) => ({
      ts: baseTs - (lines.length - i) * 200,
      agent,
      text: line.length > 400 ? line.slice(0, 400) + "…" : line,
      level: /error|fail/i.test(line) ? "err" : /warn/i.test(line) ? "warn" : "info",
    }));
  } catch { return []; }
}

/**
 * Control-plane activity. Since the Wave 3 cutover this is where real agent work
 * is recorded, so a combined stream that reads only provider log files misses every
 * run the Workbench actually executed.
 */
function controlPlaneEntries(limit = 20): { entries: Entry[]; note?: string } {
  try {
    const runs = getDurableWorkbenchControlPlane().list({ limit });
    return {
      entries: runs.map(({ run, stop }) => {
        const verified = run.status === "cancelled" && stop.verified ? " · termination verified" : "";
        const failure = run.error ? ` · ${run.error.code}` : "";
        return {
          ts: Date.parse(run.updatedAt ?? run.createdAt) || Date.now(),
          agent: run.provider,
          text: `run ${run.id.slice(0, 8)} ${run.status}${failure}${verified}`,
          level: run.error || run.status === "failed" || run.status === "blocked"
            ? "err"
            : run.status === "cancelled" ? "warn" : "info",
        };
      }),
    };
  } catch (error) {
    return { entries: [], note: `control plane unavailable: ${error instanceof Error ? error.message : "unknown"}` };
  }
}

export async function GET() {
  const out: Entry[] = [];
  const sources: Source[] = [];

  const controlPlane = controlPlaneEntries();
  out.push(...controlPlane.entries);
  sources.push({ kind: "control-plane runs", entries: controlPlane.entries.length, note: controlPlane.note });

  for (const { agent, dir } of logDirs()) {
    let entries = 0;
    let note: string | undefined;
    try {
      const items = await readdir(dir);
      const files = items.filter((f) => /\.log$/.test(f)).slice(0, 3);
      if (files.length === 0) note = "no .log files in this directory";
      for (const f of files) {
        const rows = await tailFile(path.join(dir, f), agent, 20);
        entries += rows.length;
        out.push(...rows);
      }
    } catch {
      note = "directory is missing or unreadable";
    }
    sources.push({ kind: `${agent} logs`, path: dir, entries, note });
  }

  out.sort((a, b) => b.ts - a.ts);
  return NextResponse.json({ entries: out.slice(0, 80), sources });
}
