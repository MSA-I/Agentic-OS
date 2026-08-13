import { NextResponse } from "next/server";
import { hermesHome } from "@/lib/config";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_HERMES_PROFILE, listHermesProfileNames, resolveHermesProfile } from "@/lib/hermesProfile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROFILES_DIR = path.join(hermesHome(), "profiles");

interface HermesProfile {
  name: string;
  description: string;
  model: string;
  provider: string;
  soul: string;        // first meaningful line of SOUL.md
  sessions: number;
  lastActive: number;  // epoch ms of newest session file (0 = never)
  active: boolean;     // is this the sticky default profile
}

async function readProfile(name: string, activeName: string): Promise<HermesProfile | null> {
  const dir = name === DEFAULT_HERMES_PROFILE ? hermesHome() : path.join(PROFILES_DIR, name);
  if (name !== DEFAULT_HERMES_PROFILE) {
    try {
      if (!(await stat(dir)).isDirectory()) return null;
    } catch { return null; }
  }

  let description = "";
  try {
    const py = await readFile(path.join(dir, "profile.yaml"), "utf8");
    const m = py.match(/^description:\s*"?([\s\S]*?)"?\s*(?:\ndescription_auto|$)/);
    if (m) description = m[1].replace(/\\\s*\n\s*\\?\s*/g, " ").replace(/\\u2192/g, "→").replace(/\s+/g, " ").trim();
  } catch { /* none */ }

  let model = "", provider = "";
  try {
    const cfg = await readFile(path.join(dir, "config.yaml"), "utf8");
    model = cfg.match(/^\s*default:\s*([^\s#]+)/m)?.[1] ?? "";
    provider = cfg.match(/^\s*provider:\s*([^\s#]+)/m)?.[1] ?? "";
  } catch { /* defaults */ }

  let soul = "";
  try {
    const s = await readFile(path.join(dir, "SOUL.md"), "utf8");
    soul = s.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim().slice(0, 160) ?? "";
  } catch { /* none */ }

  let sessions = 0, lastActive = 0;
  try {
    const sdir = path.join(dir, "sessions");
    if (existsSync(sdir)) {
      const files = await readdir(sdir);
      sessions = files.filter((f) => !f.startsWith(".")).length;
      for (const f of files.slice(-30)) {
        try {
          const st = await stat(path.join(sdir, f));
          if (st.mtimeMs > lastActive) lastActive = st.mtimeMs;
        } catch { /* skip */ }
      }
    }
  } catch { /* none */ }

  return { name, description, model: model || "(inherits default)", provider, soul, sessions, lastActive, active: name === activeName };
}

export async function GET() {
  try {
    const activeName = await resolveHermesProfile();
    const names = await listHermesProfileNames();
    const profiles = (await Promise.all(names.map((n) => readProfile(n, activeName)))).filter(Boolean) as HermesProfile[];
    // Active first, then most recently used
    profiles.sort((a, b) => Number(b.active) - Number(a.active) || b.lastActive - a.lastActive);
    return NextResponse.json({ profiles });
  } catch (e) {
    return NextResponse.json({ profiles: [], error: String(e) }, { status: 200 });
  }
}
