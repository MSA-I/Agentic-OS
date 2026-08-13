import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { workspacePath } from "@/lib/workspaceRoot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Returns the last cached Furnace scan (plus the history day-list) so the page paints
// instantly. The 06:20 launchd cron keeps it fresh; the UI can also POST /api/furnace/scan.

const FURNACE_DIR = workspacePath("furnace");
const HISTORY_DIR = path.join(FURNACE_DIR, "history");
const LATEST = path.join(FURNACE_DIR, "latest.json");

export async function GET() {
  let latest: unknown = null;
  try { latest = JSON.parse(await readFile(LATEST, "utf8")); } catch { /* no scan yet */ }
  let days: string[] = [];
  try {
    days = (await readdir(HISTORY_DIR)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort().reverse().slice(0, 14);
  } catch { /* none */ }
  return Response.json({ ok: true, latest, days });
}
