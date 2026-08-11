import { NextResponse } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";
import { hermesHome } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/musecoder/status — Muse Spark is cloud (via OpenRouter), so "running" means
// we have an OpenRouter key on disk.

function haveKey(): boolean {
  if (process.env.OPENROUTER_API_KEY) return true;
  for (const file of [path.join(hermesHome(), ".env"), path.join(os.homedir(), ".fcc", ".env")]) {
    try {
      const m = fs.readFileSync(file, "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m);
      if (m && m[1].trim().length > 10) return true;
    } catch { /* ignore */ }
  }
  return false;
}

export async function GET() {
  return NextResponse.json({
    running: haveKey(),
    model: "meta/muse-spark-1.2",
    label: "Muse Spark 1.2",
    provider: "Meta Muse Spark (via OpenRouter)",
    models: [
      { id: "meta/muse-spark-1.2", label: "Muse Spark 1.2", sub: "agent-tuned · 1M ctx" },
      { id: "meta/muse-spark-1.1", label: "Muse Spark 1.1", sub: "previous release" },
    ],
  });
}
