import { NextResponse } from "next/server";
import { listRuns, getRun } from "@/lib/ultracodeRuns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/claude/ultracode            — list run summaries (history)
// GET  /api/claude/ultracode?id=<id>    — full run record (for replay)
// Lifecycle mutations intentionally have no route exports until Ultracode is
// owned by Workbench and Stop can prove ACTIVE_PROCESS_ZERO.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const run = await getRun(id);
    if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
    return NextResponse.json({ run });
  }
  const runs = await listRuns();
  return NextResponse.json({ runs });
}
