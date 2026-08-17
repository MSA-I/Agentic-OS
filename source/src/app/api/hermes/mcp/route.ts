// GET  /api/hermes/mcp           → { catalog, installed } combined snapshot
// POST /api/hermes/mcp           → { action: "toggle" | "uninstall", name, enabled? }
//
// Single endpoint keeps the front-end's polling cheap (one round-trip for the
// whole MCPs tab). For mutations we use POST + an action discriminator so the
// dashboard doesn't need to know about multiple URL shapes.

import { denyFrozenExecutionMutation } from "@/lib/control-plane/executionFreeze";
import { NextResponse } from "next/server";
import { listCatalog, listInstalled, toggleEnabled, uninstall } from "@/lib/hermesMcp";
import { hermesProfileExists, isValidHermesProfile, resolveHermesProfile } from "@/lib/hermesProfile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const requestedProfile = new URL(req.url).searchParams.get("profile");
  if (requestedProfile && !isValidHermesProfile(requestedProfile)) {
    return NextResponse.json({ ok: false, error: "invalid profile", catalog: [], installed: [] }, { status: 400 });
  }
  const profile = await resolveHermesProfile(requestedProfile);
  if (!hermesProfileExists(profile)) {
    return NextResponse.json({ ok: false, profile, error: "profile not found", catalog: [], installed: [] }, { status: 404 });
  }
  try {
    const [catalog, installed] = await Promise.all([
      listCatalog(profile),
      listInstalled(profile),
    ]);
    return NextResponse.json({ ok: true, profile, catalog, installed });
  } catch (e) {
    return NextResponse.json({ ok: false, profile, error: String(e), catalog: [], installed: [] }, { status: 200 });
  }
}

export async function POST(req: Request) {
  const frozen = await denyFrozenExecutionMutation(req, "POST /api/hermes/mcp");
  if (frozen) return frozen;
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 }); }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "missing body" }, { status: 400 });
  }
  const { action, name, enabled, profile: requestedProfile } = body as { action?: string; name?: string; enabled?: boolean; profile?: string };
  if (!action || !name) {
    return NextResponse.json({ ok: false, error: "action and name required" }, { status: 400 });
  }

  if (requestedProfile && !isValidHermesProfile(requestedProfile)) {
    return NextResponse.json({ ok: false, error: "invalid profile" }, { status: 400 });
  }
  const profile = await resolveHermesProfile(requestedProfile);
  if (!hermesProfileExists(profile)) {
    return NextResponse.json({ ok: false, error: "profile not found" }, { status: 404 });
  }

  if (action === "toggle") {
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ ok: false, error: "enabled (boolean) required for toggle" }, { status: 400 });
    }
    const r = await toggleEnabled(name, enabled, profile);
    return NextResponse.json(r, { status: r.ok ? 200 : 500 });
  }
  if (action === "uninstall") {
    const r = await uninstall(name, profile);
    return NextResponse.json(r, { status: r.ok ? 200 : 500 });
  }
  return NextResponse.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
}
