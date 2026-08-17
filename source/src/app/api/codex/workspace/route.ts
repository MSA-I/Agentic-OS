import { NextResponse } from "next/server";
import { listProjects, listProjectFiles } from "@/lib/codexWorkspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/codex/workspace                       — list every scratch project
// GET  /api/codex/workspace?project=<name>        — list files inside a project
// Project creation intentionally has no POST export until it is owned by the
// canonical Workbench project lifecycle.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  if (project) {
    const res = await listProjectFiles(project);
    if (!res) return NextResponse.json({ error: "project not found" }, { status: 404 });
    return NextResponse.json(res);
  }
  const projects = await listProjects();
  return NextResponse.json({ projects, readOnly: true });
}
