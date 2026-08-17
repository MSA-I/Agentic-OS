import { NextResponse } from "next/server";
import { probeProvider } from "@/lib/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COMMANDS = {
  health: ["health"],
  agents: ["agents", "list"],
  logs: ["logs"],
  doctor: ["doctor"],
  memory: ["memory", "--help"],
  cron: ["cron", "list"],
} as const;

type Action = keyof typeof COMMANDS;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const action = (url.searchParams.get("action") ?? "health") as Action;
  const args = COMMANDS[action];
  if (!args) return NextResponse.json({ error: "unknown action" }, { status: 400 });
  // Read-only introspection: the command map is server-owned and every vector is
  // on the provider probe allowlist, so no client value reaches the argv.
  const out = await probeProvider("openclaw", args, { timeoutMs: 8000 });
  return NextResponse.json({ action, ...out });
}
