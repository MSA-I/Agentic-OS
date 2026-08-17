import { denyFrozenExecutionMutation } from "@/lib/control-plane/executionFreeze";
import { NextResponse } from "next/server";
import { appBySlug, stopApp } from "@/lib/appslab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const frozen = await denyFrozenExecutionMutation(req, "POST /api/appslab/stop");
  if (frozen) return frozen;
  const { slug } = await req.json();
  const app = appBySlug(String(slug));
  if (!app) return NextResponse.json({ error: "unknown app" }, { status: 404 });
  return NextResponse.json({ ok: stopApp(app.slug) });
}
