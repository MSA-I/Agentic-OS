import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { workspacePath } from "@/lib/workspaceRoot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Codex chat history — persisted to disk so conversations survive refreshes and
// restarts (same pattern as the OmniRoute workspace). One JSON per session plus
// a readable .md transcript alongside.
const ROOT = workspacePath("codex-workspace", "chats");

async function ensure() { await fs.mkdir(ROOT, { recursive: true }); }
// Encode the id as one portable filename segment. `path.basename()` alone
// leaves `:` intact, which makes project-scoped `local:<uuid>` drafts invalid
// filenames on Windows.
const safe = (name: string) => encodeURIComponent(path.basename(name));
const storedId = (file: string) => {
  const stem = file.replace(/\.json$/, "");
  try { return decodeURIComponent(stem); } catch { return stem; }
};

// GET              → { sessions: [{id,title,count,when}] }  (newest first)
// GET ?id=<id>     → the saved conversation JSON
export async function GET(req: Request) {
  await ensure();
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    try {
      const j = await fs.readFile(path.join(ROOT, safe(id) + ".json"), "utf8");
      return NextResponse.json(JSON.parse(j));
    } catch { return NextResponse.json({ error: "not found" }, { status: 404 }); }
  }
  const files = (await fs.readdir(ROOT).catch(() => [])).filter((f) => f.endsWith(".json"));
  const sessions = await Promise.all(files.map(async (f) => {
    try {
      const st = await fs.stat(path.join(ROOT, f));
      const j = JSON.parse(await fs.readFile(path.join(ROOT, f), "utf8"));
      return {
        id: j.id || storedId(f),
        title: j.title || "Chat",
        count: (j.messages || []).length,
        when: st.mtime.toISOString(),
        project: typeof j.project === "string" ? j.project : undefined,
        root: typeof j.root === "string" ? j.root : undefined,
      };
    } catch { return { id: storedId(f), title: "Chat", count: 0, when: new Date(0).toISOString() }; }
  }));
  return NextResponse.json({ sessions: sessions.sort((a, b) => b.when.localeCompare(a.when)).slice(0, 40) });
}

// POST { id, title, messages } → saves sessions/<id>.json + .md
export async function POST(req: Request) {
  await ensure();
  const body = await req.json().catch(() => ({}));
  const id = safe(String(body.id || `c-${Date.now()}`));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const title = String(body.title || "Chat").slice(0, 80);
  const originalId = String(body.id || decodeURIComponent(id));
  const project = typeof body.project === "string" ? body.project.slice(0, 240) : undefined;
  const root = typeof body.root === "string" ? body.root.slice(0, 2048) : undefined;
  await fs.writeFile(path.join(ROOT, id + ".json"), JSON.stringify({ id: originalId, title, when: new Date().toISOString(), messages, project, root }, null, 2), "utf8");
  const md = `# ${title}\n\n` + messages.map((m: { role: string; text: string }) => `**${m.role}:**\n\n${m.text}\n`).join("\n---\n\n");
  await fs.writeFile(path.join(ROOT, id + ".md"), md, "utf8");
  return NextResponse.json({ ok: true, id: originalId });
}
