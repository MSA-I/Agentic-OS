import { NextResponse } from "next/server";
import {
  listNativeAgentHistory,
  readNativeHistoryPath,
  type NativeHistoryAgent,
} from "@/lib/nativeAgentHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NATIVE_HISTORY_AGENTS = new Set<NativeHistoryAgent>([
  "codex",
  "claude",
  "hermes",
  "openclaw",
  "antigravity",
]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedAgent = url.searchParams.get("agent");
  if (!requestedAgent || !NATIVE_HISTORY_AGENTS.has(requestedAgent as NativeHistoryAgent)) {
    return NextResponse.json({ error: "unsupported agent" }, { status: 400 });
  }

  const agent = requestedAgent as NativeHistoryAgent;
  const requestedPath = url.searchParams.get("path");
  if (requestedPath) {
    const detail = await readNativeHistoryPath(agent, requestedPath);
    return detail
      ? NextResponse.json({ detail })
      : NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  return NextResponse.json(await listNativeAgentHistory(agent));
}
