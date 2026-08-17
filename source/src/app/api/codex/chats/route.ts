import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { workspacePath } from "@/lib/workspaceRoot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Legacy Codex chat metadata. Raw prompt/transcript files may exist from older
// builds, but this route never returns or writes their content. Native provider
// history is the only persistent transcript authority during the pilot.
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

// GET              → redacted legacy metadata (newest first)
// GET ?id=<id>     → one redacted metadata record
export async function GET(req: Request) {
  await ensure();
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    try {
      const file = path.join(ROOT, safe(id) + ".json");
      const [raw, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
      const record = JSON.parse(raw) as { id?: unknown; messages?: unknown };
      return NextResponse.json({
        session: {
          id: typeof record.id === "string" ? record.id : id,
          count: Array.isArray(record.messages) ? record.messages.length : 0,
          when: stat.mtime.toISOString(),
          legacyContentWithheld: true,
        },
      });
    } catch { return NextResponse.json({ error: "not found" }, { status: 404 }); }
  }
  const files = (await fs.readdir(ROOT).catch(() => [])).filter((f) => f.endsWith(".json"));
  const sessions = await Promise.all(files.map(async (f) => {
    try {
      const st = await fs.stat(path.join(ROOT, f));
      const j = JSON.parse(await fs.readFile(path.join(ROOT, f), "utf8"));
      return {
        id: j.id || storedId(f),
        count: (j.messages || []).length,
        when: st.mtime.toISOString(),
        legacyContentWithheld: true,
      };
    } catch { return { id: storedId(f), count: 0, when: new Date(0).toISOString(), legacyContentWithheld: true }; }
  }));
  return NextResponse.json({ sessions: sessions.sort((a, b) => b.when.localeCompare(a.when)).slice(0, 40) });
}
