import { run } from "@/lib/runner";
import { config } from "@/lib/config";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { workspacePath } from "@/lib/workspaceRoot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// THE FURNACE — daily YouTube performance engine behind Hermes Muse. Scrapes the
// member's configured channels straight off youtube.com (ytInitialData →
// lockupViewModel, no API key), ranks what's burning hottest (views + views/day
// velocity), then has Hermes (Grok OAuth — no paid credits) forge new video ideas
// from the proven winners. Cached like the Radar; wire a daily cron/launchd job to
// POST here each morning if you want it fresh without opening the tab.

const FURNACE_DIR = workspacePath("furnace");
const HISTORY_DIR = path.join(FURNACE_DIR, "history");
const LATEST = path.join(FURNACE_DIR, "latest.json");
const STATUS = path.join(FURNACE_DIR, "status.json");

// Channels come from config: "furnaceChannels" (handles, no @) or the handle parsed
// from "youtubeChannel". Never a hardcoded person's channel list.
const CHANNELS = config.furnaceChannels.map((h) => ({ handle: h, label: `@${h}` }));

export interface FurnaceVideo {
  videoId: string; title: string; channel: string;
  views: number; viewsLabel: string; ageLabel: string; ageDays: number;
  velocity: number; // views per day
  duration: string; thumb: string; heat: number; // 1-100 within this scan
}
export interface FurnaceIdea {
  title: string; hook: string; why: string; format: string;
  borrowed_from: string; heat: number;
}

// ---------- YouTube scrape (no API key) ----------

function parseViews(s: string): number {
  const m = String(s || "").replace(/,/g, "").match(/([\d.]+)\s*([KMB])?\s*view/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : m[2] === "B" ? 1e9 : 1;
  return Math.round(n * mult);
}
function parseAgeDays(s: string): number {
  const m = String(s || "").match(/(\d+)\s*(hour|day|week|month|year)/i);
  if (!m) return 9999;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const per: Record<string, number> = { hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 };
  return Math.max(1 / 24, n * (per[unit] || 1));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function collect(o: any, key: string, out: any[]) {
  if (Array.isArray(o)) { for (const v of o) collect(v, key, out); return; }
  if (o && typeof o === "object") {
    if (o[key]) out.push(o[key]);
    for (const v of Object.values(o)) collect(v, key, out);
  }
}

async function scrapeChannel(handle: string, label: string): Promise<FurnaceVideo[]> {
  const r = await fetch(`https://www.youtube.com/@${handle}/videos`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      "Accept-Language": "en",
    },
    cache: "no-store",
  });
  const html = await r.text();
  const m = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
  if (!m) return [];
  let data: any;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const lockups: any[] = [];
  collect(data, "lockupViewModel", lockups);
  const out: FurnaceVideo[] = [];
  for (const v of lockups) {
    const id = String(v?.contentId || "");
    const meta = v?.metadata?.lockupMetadataViewModel || {};
    const title = String(meta?.title?.content || "");
    if (!id || !title) continue;
    const parts: any[] = [];
    collect(meta, "metadataParts", parts);
    let viewsLabel = "", ageLabel = "";
    for (const row of parts) for (const p of (Array.isArray(row) ? row : [])) {
      const t = String(p?.text?.content || "");
      if (/view/i.test(t)) viewsLabel = t;
      else if (/ago/i.test(t)) ageLabel = t;
    }
    const badges: any[] = [];
    collect(v, "thumbnailBadgeViewModel", badges);
    const duration = String(badges.find((b) => /^[\d:]+$/.test(String(b?.text || "")))?.text || "");
    const views = parseViews(viewsLabel);
    const ageDays = parseAgeDays(ageLabel);
    out.push({
      videoId: id, title, channel: label,
      views, viewsLabel: viewsLabel || "—", ageLabel: ageLabel || "—", ageDays,
      velocity: Math.round(views / ageDays),
      duration, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, heat: 0,
    });
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- idea forge (Hermes on Grok OAuth — same free lane as the Radar) ----------

function forgePrompt(top: FurnaceVideo[], rising: FurnaceVideo[]): string {
  const list = (vs: FurnaceVideo[]) => vs.map((v) =>
    `- "${v.title}" — ${v.viewsLabel}, ${v.ageLabel}, ~${v.velocity.toLocaleString()} views/day (${v.channel})`).join("\n");
  const WHO = config.userName && config.userName !== "You" ? config.userName : "the creator";
  return [
    `You are THE FURNACE — the YouTube content strategist for ${WHO}'s channel(s).`,
    "",
    "Below are the channel's ACTUAL best-performing recent videos (scraped today, real numbers).",
    "",
    "ALL-OUT WINNERS (most total views):",
    list(top),
    "",
    "RISING FAST (highest views/day right now):",
    list(rising),
    "",
    "Study the PATTERNS in what wins: which tools/models, which formats (VS battles, 'X is INSANE',",
    "courses, money angles), which title shapes. Then forge NEW video ideas that ride those exact",
    "patterns — same proven appeal, fresh topic or fresh twist. Not remakes; next moves.",
    "",
    "Return ONLY a JSON array of exactly 8 objects, hottest first:",
    "{",
    '  "title": "a YouTube title under 60 chars in the channel\'s proven style",',
    '  "hook": "the opening line of the video, punchy, spoken voice",',
    '  "why": "1 sentence: which winner(s) prove this will work — name the pattern",',
    '  "format": one of "Video" | "VS battle" | "Course" | "Short" | "Livestream",',
    '  "borrowed_from": "the title of the winning video this pattern comes from",',
    '  "heat": integer 1-100 (confidence it performs, based on the data above)',
    "}",
    "Output ONLY the raw JSON array — no commentary, no markdown fences.",
  ].join("\n");
}

function extractIdeas(raw: string): FurnaceIdea[] {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("["); const end = s.lastIndexOf("]");
  if (start === -1 || end < start) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.title === "string")
      .map((x) => ({
        title: String(x.title).slice(0, 120),
        hook: String(x.hook || "").slice(0, 300),
        why: String(x.why || "").slice(0, 300),
        format: String(x.format || "Video").slice(0, 30),
        borrowed_from: String(x.borrowed_from || "").slice(0, 120),
        heat: Math.max(1, Math.min(100, Math.round(Number(x.heat) || 50))),
      }));
  } catch { return []; }
}

// ---------- persistence + status (Radar pattern) ----------

interface ScanStatus { running: boolean; startedAt?: string; endedAt?: string; phase?: string; error?: string; scannedAt?: string }
async function readStatus(): Promise<ScanStatus> {
  try { return JSON.parse(await readFile(STATUS, "utf8")); } catch { return { running: false }; }
}
async function writeStatus(s: ScanStatus) {
  try { await mkdir(FURNACE_DIR, { recursive: true }); await writeFile(STATUS, JSON.stringify(s), "utf8"); } catch { /* best effort */ }
}
function pad(n: number) { return String(n).padStart(2, "0"); }

async function runScan(): Promise<void> {
  const startedAt = new Date().toISOString();
  if (!CHANNELS.length) {
    await writeStatus({ running: false, startedAt, endedAt: new Date().toISOString(), error: 'No channels configured — set "youtubeChannel" (or "furnaceChannels") in ~/.agentic-os/config.json, then scan again.' });
    return;
  }
  await writeStatus({ running: true, startedAt, phase: "Stoking the furnace — reading your channels…" });
  try {
    const batches = await Promise.all(CHANNELS.map((c) => scrapeChannel(c.handle, c.label).catch(() => [])));
    const videos = batches.flat().filter((v) => v.views > 0);
    if (!videos.length) {
      await writeStatus({ running: false, startedAt, endedAt: new Date().toISOString(), error: "Could not read the channels — YouTube may have changed its page format." });
      return;
    }
    const maxV = Math.max(...videos.map((v) => v.views));
    const maxVel = Math.max(...videos.map((v) => v.velocity));
    for (const v of videos) {
      // heat blends absolute pull and current velocity so fresh risers still glow
      v.heat = Math.max(1, Math.round(60 * (v.views / maxV) + 40 * (v.velocity / (maxVel || 1))));
    }
    const byViews = [...videos].sort((a, b) => b.views - a.views);
    const byVelocity = [...videos].sort((a, b) => b.velocity - a.velocity);
    const top = byViews.slice(0, 8);
    const rising = byVelocity.slice(0, 8);

    await writeStatus({ running: true, startedAt, phase: "Winners found — forging new ideas…" });
    const PROVIDER = process.env.FURNACE_PROVIDER || "xai-oauth";
    const MODEL = process.env.FURNACE_MODEL || "grok-4";
    let res = await run("hermes", ["-z", forgePrompt(top, rising), "--provider", PROVIDER, "--model", MODEL], { cwd: FURNACE_DIR, timeoutMs: 300_000 });
    let ideas = extractIdeas(res.stdout || "");
    if (!ideas.length) {
      await writeStatus({ running: true, startedAt, phase: "Reheating — asking the forge once more…" });
      res = await run("hermes", ["-z", forgePrompt(top, rising), "--provider", PROVIDER, "--model", MODEL], { cwd: FURNACE_DIR, timeoutMs: 300_000 });
      ideas = extractIdeas(res.stdout || "");
    }

    const scannedAt = new Date().toISOString();
    const when = new Date(scannedAt);
    const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
    const totalViews = videos.reduce((a, v) => a + v.views, 0);
    const totalVelocity = videos.reduce((a, v) => a + v.velocity, 0);
    const payload = {
      ok: true, scannedAt, day,
      stats: { videoCount: videos.length, totalViews, totalVelocity, channels: CHANNELS.map((c) => c.label) },
      top, rising, ideas,
      ideasError: ideas.length ? "" : ((res.stderr || "").slice(-200) || "The forge came back empty — hit Re-stoke."),
    };
    await mkdir(HISTORY_DIR, { recursive: true });
    await writeFile(LATEST, JSON.stringify(payload, null, 2), "utf8");
    await writeFile(path.join(HISTORY_DIR, `${day}.json`), JSON.stringify(payload, null, 2), "utf8");
    await writeStatus({ running: false, startedAt, endedAt: new Date().toISOString(), scannedAt });
  } catch (e) {
    await writeStatus({ running: false, startedAt, endedAt: new Date().toISOString(), error: String((e as Error)?.message || e) });
  }
}

// POST — kick a scan, return instantly (fire-and-forget; long-lived launchd server keeps it running).
export async function POST() {
  const st = await readStatus();
  if (st.running && st.startedAt && Date.now() - new Date(st.startedAt).getTime() < 700_000) {
    return Response.json({ ok: true, status: "running", startedAt: st.startedAt });
  }
  const startedAt = new Date().toISOString();
  await writeStatus({ running: true, startedAt, phase: "Lighting the furnace…" });
  void runScan();
  return Response.json({ ok: true, status: "started", startedAt });
}

// GET — poll status; self-heal a stuck "running" flag after a server restart.
export async function GET() {
  const st = await readStatus();
  if (st.running && st.startedAt && Date.now() - new Date(st.startedAt).getTime() > 700_000) {
    const healed = { ...st, running: false, error: st.error || "The last scan was interrupted — hit Re-stoke." };
    await writeStatus(healed);
    return Response.json(healed);
  }
  return Response.json(st);
}
