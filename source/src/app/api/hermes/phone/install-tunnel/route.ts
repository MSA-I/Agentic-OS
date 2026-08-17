import { denyFrozenExecutionMutation } from "@/lib/control-plane/executionFreeze";
import { NextResponse } from "next/server";
import { installCloudflared, installerRunning } from "@/lib/hermesPhone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const frozen = await denyFrozenExecutionMutation(req, "POST /api/hermes/phone/install-tunnel");
  if (frozen) return frozen;
  return NextResponse.json({ ...installCloudflared(), installing: installerRunning() });
}
