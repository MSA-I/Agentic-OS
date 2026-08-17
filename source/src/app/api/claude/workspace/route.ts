import { NextResponse } from "next/server";
import { listProjects, listProjectFiles } from "@/lib/claudeWorkspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/claude/workspace                — list every Claude scratch project
// GET  /api/claude/workspace?project=<name> — list files inside a project
// Project creation intentionally has no POST export until the canonical
// Workbench project lifecycle owns it.
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
