import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { workspacePath } from "@/lib/workspaceRoot";

const OPENMONTAGE_ROOT = workspacePath("openmontage");

// GET ?id=<jobId> → current job status (status, progress, message, title, video URL).
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!/^om-[a-z0-9]+$/i.test(id)) {
    return Response.json({ error: "bad id" }, { status: 400 });
  }
  const jobFile = path.join(OPENMONTAGE_ROOT, "jobs", `${id}.json`);
  if (!existsSync(jobFile)) {
    return Response.json({ status: "starting", progress: 0, message: "Starting…" });
  }
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(readFileSync(jobFile, "utf8")); } catch { /* mid-write */ }
  if (data.status === "done" && data.video) {
    const videoPath = path.join(OPENMONTAGE_ROOT, "generated", path.basename(String(data.video)));
    data.videoUrl = `/api/media/file?path=${encodeURIComponent(videoPath)}`;
  }
  return Response.json(data, { headers: { "cache-control": "no-store" } });
}
