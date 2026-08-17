import { NextResponse } from "next/server";
import { getGoal, listGoals, readGoalLog } from "@/lib/codexGoals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Legacy Goal Mode is read-only during the restricted pilot. Start, Stop, and
// Delete intentionally have no route exports until Workbench owns their full
// lifecycle and Stop can prove ACTIVE_PROCESS_ZERO.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const goal = await getGoal(id);
    if (!goal) return NextResponse.json({ error: "not found" }, { status: 404 });
    const log = await readGoalLog(id);
    return NextResponse.json({ goal, log });
  }
  return NextResponse.json({ goals: await listGoals(), readOnly: true });
}
