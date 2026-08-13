// Apollo voice memory — "Apollo, remember …" → saved to disk + Obsidian.
//
//   ~/.agentic-os/apollo-memory.jsonl              (powers recall in the UI)
//   <vault>/Agentic OS/Apollo/Memory.md            (a clean list in Obsidian)

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { workspacePath } from "./workspaceRoot";

const STATE_DIR = workspacePath("apollo", "memory");
const MEM_FILE = path.join(STATE_DIR, "apollo-memory.jsonl");

export interface ApolloMemory { id: string; ts: number; text: string; }

function pad(n: number): string { return String(n).padStart(2, "0"); }

async function appendReadableMemory(text: string, ts: number): Promise<void> {
  try {
    const d = new Date(ts);
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const dir = STATE_DIR;
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const file = path.join(dir, "Memory.md");
    const header = existsSync(file) ? "" : `# Apollo — Memory\n\nThings you've asked Apollo to remember.\n`;
    await appendFile(file, `${header}\n- **${stamp}** — ${text}`, "utf8");
  } catch { /* best-effort */ }
}

export async function appendMemory(text: string): Promise<ApolloMemory> {
  const ts = Date.now();
  const row: ApolloMemory = { id: `m_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ts, text: text.slice(0, 1000) };
  try {
    if (!existsSync(STATE_DIR)) await mkdir(STATE_DIR, { recursive: true });
    await appendFile(MEM_FILE, JSON.stringify(row) + "\n", "utf8");
  } catch { /* */ }
  await appendReadableMemory(row.text, ts);
  return row;
}

export async function listMemories(limit = 50): Promise<ApolloMemory[]> {
  if (!existsSync(MEM_FILE)) return [];
  try {
    const txt = await readFile(MEM_FILE, "utf8");
    const lines = txt.split(/\r?\n/).filter((l) => l.trim());
    const out: ApolloMemory[] = [];
    for (const l of lines.slice(Math.max(0, lines.length - limit))) {
      try { out.push(JSON.parse(l)); } catch { /* */ }
    }
    return out.reverse(); // newest first
  } catch { return []; }
}
