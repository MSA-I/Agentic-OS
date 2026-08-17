import { denyFrozenExecutionMutation } from "@/lib/control-plane/executionFreeze";
import { NextResponse } from "next/server";
import { listNotebooks, createShort, nlmAuthOk } from "@/lib/nlm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → notebooks for the dropdown + auth state
export async function GET() {
  const [notebooks, authed] = await Promise.all([listNotebooks(), nlmAuthOk()]);
  return NextResponse.json({ authed, notebooks });
}

// POST { notebookId, focus? } → kick off a vertical short video
export async function POST(req: Request) {
  const frozen = await denyFrozenExecutionMutation(req, "POST /api/notebooklm/shortvideo");
  if (frozen) return frozen;
  const { notebookId, focus } = await req.json().catch(() => ({}));
  if (typeof notebookId !== "string" || !/^[a-f0-9-]{36}$/i.test(notebookId)) {
    return NextResponse.json({ error: "Pick a notebook first." }, { status: 400 });
  }
  const r = await createShort(notebookId, typeof focus === "string" ? focus : "");
  if (!r.ok) return NextResponse.json({ error: r.error || "Couldn't start the video." }, { status: 502 });
  return NextResponse.json({ notebookId, artifactId: r.artifactId });
}
