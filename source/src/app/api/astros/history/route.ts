import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { workspacePath } from "@/lib/workspaceRoot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HISTORY_DIR = workspacePath("astros", "history");

export async function GET() {
  try {
    const files = (await readdir(HISTORY_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 14);
    const days = await Promise.all(files.map(async (f) => {
      try {
        const d = JSON.parse(await readFile(path.join(HISTORY_DIR, f), "utf8"));
        return { day: f.replace(".json", ""), scannedAt: d.scannedAt || null, count: (d.topics || []).length, topics: d.topics || [] };
      } catch { return null; }
    }));
    return Response.json({ ok: true, days: days.filter(Boolean) });
  } catch {
    return Response.json({ ok: true, days: [] });
  }
}
