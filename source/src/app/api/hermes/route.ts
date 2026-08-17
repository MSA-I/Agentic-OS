import { NextResponse } from "next/server";
import { probeProvider } from "@/lib/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COMMANDS = {
  status: ["status"],
  sessions: ["sessions", "list"],
  doctor: ["doctor"],
  insights: ["insights"],
  kanban: ["kanban", "list"],
  skills: ["skills", "list"],
  plugins: ["plugins", "list"],
} as const;

type Action = keyof typeof COMMANDS;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const action = (url.searchParams.get("action") ?? "status") as Action;
  const args = COMMANDS[action];
  if (!args) return NextResponse.json({ error: "unknown action" }, { status: 400 });
  // Read-only introspection: the command map is server-owned and every vector is
  // on the provider probe allowlist, so no client value reaches the argv.
  const out = await probeProvider("hermes", args, { timeoutMs: 10000 });
  return NextResponse.json({ action, ...out });
}
