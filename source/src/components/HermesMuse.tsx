"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Flame, Loader2, ArrowUpRight, Zap, TrendingUp, Copy, Check, RefreshCw, Clapperboard, PenLine, Image as ImageIcon } from "lucide-react";

// HERMES MUSE — the Muses gave creators their ideas. Daily YouTube performance engine:
// what's burning on your channels, and the next videos to forge from those exact winning
// patterns. Molten-orange HUD, live ember field, count-up numbers — hotter than every other tab.

interface FurnaceVideo {
  videoId: string; title: string; channel: string;
  views: number; viewsLabel: string; ageLabel: string; ageDays: number;
  velocity: number; duration: string; thumb: string; heat: number;
}
interface FurnaceIdea { title: string; hook: string; why: string; format: string; borrowed_from: string; heat: number }
interface Payload {
  ok: boolean; scannedAt: string; day: string;
  stats: { videoCount: number; totalViews: number; totalVelocity: number; channels: string[] };
  top: FurnaceVideo[]; rising: FurnaceVideo[]; ideas: FurnaceIdea[]; ideasError?: string;
}

const EMBER = "#ff7a18";
const EMBER_SOFT = "#ffb26b";
const EMBER_DEEP = "#c2410c";
const COAL = "#0d0705";

const SCAN_LINES = [
  "Lighting the furnace…", "Reading your channels off YouTube…", "Weighing every video's pull…",
  "Finding what's burning hottest…", "Forging tomorrow's ideas from today's winners…",
];

function fmt(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
  return String(n);
}
function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (isNaN(s)) return "—";
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------- ember particle field ----------
function EmberField() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    let W = 0, H = 0, raf = 0;
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      const r = cv.getBoundingClientRect();
      W = r.width; H = r.height;
      cv.width = W * DPR; cv.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    resize();
    const N = 70;
    const ps = Array.from({ length: N }, () => ({
      x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 2.2,
      vy: 0.12 + Math.random() * 0.5, drift: (Math.random() - 0.5) * 0.25,
      tw: Math.random() * Math.PI * 2, hot: Math.random(),
    }));
    const step = () => {
      if (!W || !H) { raf = requestAnimationFrame(step); return; } // hidden/unsized canvas → non-finite gradients
      ctx.clearRect(0, 0, W, H);
      const t = performance.now() / 1000;
      for (const p of ps) {
        p.y -= (p.vy / H) * 1.6;
        p.x += (Math.sin(t * 0.7 + p.tw) * 0.0004) + p.drift / W;
        if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); }
        const flick = 0.55 + 0.45 * Math.sin(t * (2 + p.hot * 3) + p.tw);
        const a = flick * (0.25 + p.hot * 0.55) * Math.min(1, p.y * 2.2);
        const x = p.x * W, y = p.y * H;
        const g = ctx.createRadialGradient(x, y, 0, x, y, p.r * 5);
        g.addColorStop(0, `rgba(255,${140 + Math.round(p.hot * 80)},40,${a})`);
        g.addColorStop(1, "rgba(255,110,20,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, p.r * 5, 0, Math.PI * 2); ctx.fill();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const ro = new ResizeObserver(resize); ro.observe(cv);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  return <canvas ref={ref} className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden />;
}

// ---------- animated count-up ----------
function CountUp({ value }: { value: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t0 = performance.now(); const dur = 1400; let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      setN(Math.round(value * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{fmt(n)}</>;
}

function HeatBar({ heat }: { heat: number }) {
  return (
    <div className="h-[5px] rounded-full overflow-hidden" style={{ background: "rgba(255,122,24,0.12)" }}>
      <div className="h-full rounded-full furnace-heatbar" style={{ width: `${heat}%` }} />
    </div>
  );
}

export default function HermesMuse() {
  const [data, setData] = useState<Payload | null>(null);
  const [booting, setBooting] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [lineIdx, setLineIdx] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [lens, setLens] = useState<"top" | "rising">("top");

  const loadLatest = useCallback(async () => {
    try {
      const r = await fetch("/api/furnace/latest", { cache: "no-store" });
      const j = await r.json();
      if (j.latest) setData(j.latest as Payload);
    } catch { /* ignore */ }
    setBooting(false);
  }, []);

  useEffect(() => { loadLatest(); }, [loadLatest]);

  // poll while a scan runs
  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch("/api/furnace/scan", { cache: "no-store" });
        const s = await r.json();
        if (!s.running) {
          setScanning(false);
          if (s.error) setErr(s.error);
          await loadLatest();
        }
      } catch { /* keep polling */ }
    }, 3500);
    const lines = setInterval(() => setLineIdx((i) => (i + 1) % SCAN_LINES.length), 3000);
    return () => { clearInterval(t); clearInterval(lines); };
  }, [scanning, loadLatest]);

  const stoke = useCallback(async () => {
    setErr(null); setScanning(true); setLineIdx(0);
    try { await fetch("/api/furnace/scan", { method: "POST" }); }
    catch { setScanning(false); setErr("Could not reach the furnace."); }
  }, []);

  const copy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key); setTimeout(() => setCopied(null), 1500);
    });
  };

  const winners = data ? (lens === "top" ? data.top : data.rising) : [];

  return (
    <div className="space-y-5 furnace-root">
      <style>{`
        .furnace-root { --ember:${EMBER}; --ember-soft:${EMBER_SOFT}; }
        @keyframes furnacePulse { 0%,100%{opacity:.75;transform:scale(1)} 50%{opacity:1;transform:scale(1.045)} }
        @keyframes furnaceShimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
        @keyframes furnaceGlowSpin { 0%{transform:rotate(0)} 100%{transform:rotate(360deg)} }
        .furnace-heatbar { background: linear-gradient(90deg, ${EMBER_DEEP}, ${EMBER}, ${EMBER_SOFT});
          box-shadow: 0 0 12px rgba(255,122,24,.7); transition: width 1.2s cubic-bezier(.2,.8,.2,1); }
        .furnace-card { position:relative; border:1px solid rgba(255,122,24,.22); background:
          linear-gradient(180deg, rgba(30,12,4,.85), rgba(13,7,5,.95)); border-radius:16px; overflow:hidden;
          transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease; }
        .furnace-card:hover { transform: translateY(-3px) scale(1.012); border-color: rgba(255,122,24,.65);
          box-shadow: 0 10px 40px rgba(255,90,10,.25), 0 0 0 1px rgba(255,122,24,.25) inset; }
        .furnace-idea { position:relative; border-radius:16px; padding:1px; background:
          linear-gradient(120deg, rgba(255,122,24,.55), rgba(255,178,107,.12) 30%, rgba(255,122,24,.5) 60%, rgba(194,65,12,.2));
          background-size: 300% 100%; animation: furnaceShimmer 6s linear infinite; }
        .furnace-idea > div { border-radius:15px; background: linear-gradient(180deg, rgba(26,10,3,.96), rgba(13,7,5,.98)); }
        .furnace-rank { font-family:'Bricolage Grotesque',sans-serif; font-weight:800;
          background: linear-gradient(180deg, ${EMBER_SOFT}, ${EMBER}); -webkit-background-clip:text;
          background-clip:text; color:transparent; text-shadow: 0 0 24px rgba(255,122,24,.35); }
        .furnace-chip { border:1px solid rgba(255,122,24,.35); color:${EMBER_SOFT};
          background: rgba(255,122,24,.08); border-radius:999px; padding:2px 10px; font-size:11px;
          font-family:'JetBrains Mono',monospace; letter-spacing:.04em; white-space:nowrap; }
      `}</style>

      {/* ── hero: molten header ── */}
      <div className="relative overflow-hidden rounded-2xl border" style={{
        borderColor: "rgba(255,122,24,.3)",
        background: `radial-gradient(120% 160% at 50% 115%, rgba(255,100,10,.34), rgba(194,65,12,.14) 40%, ${COAL} 75%)`,
      }}>
        <EmberField />
        <div className="absolute -bottom-24 left-1/2 -translate-x-1/2 w-[520px] h-[240px] pointer-events-none"
          style={{ background: "radial-gradient(closest-side, rgba(255,122,24,.5), transparent 70%)", filter: "blur(30px)", animation: "furnacePulse 3.6s ease-in-out infinite" }} />
        <div className="relative z-10 px-6 pt-6 pb-7">
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{
              background: "linear-gradient(160deg, rgba(255,122,24,.3), rgba(194,65,12,.15))",
              border: "1px solid rgba(255,122,24,.5)", boxShadow: "0 0 28px rgba(255,122,24,.45)",
            }}>
              <Flame size={22} color={EMBER_SOFT} style={{ animation: "furnacePulse 2.2s ease-in-out infinite" }} />
            </div>
            <div>
              <h2 className="text-[20px] font-extrabold tracking-tight" style={{ fontFamily: "'Bricolage Grotesque',sans-serif", color: EMBER_SOFT, textShadow: "0 0 30px rgba(255,122,24,.4)" }}>
                HERMES MUSE
              </h2>
              <p className="text-[12px]" style={{ color: "rgba(255,200,160,.75)" }}>
                The Muse reads your channels · what&apos;s burning · the next videos to forge · re-stoked daily at 06:20
              </p>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <span className="furnace-chip">{data ? `scanned ${ago(data.scannedAt)}` : "no scan yet"}</span>
              <button onClick={stoke} disabled={scanning}
                className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold transition"
                style={{
                  background: scanning ? "rgba(255,122,24,.15)" : `linear-gradient(120deg, ${EMBER_DEEP}, ${EMBER})`,
                  color: scanning ? EMBER_SOFT : "#1a0a03",
                  boxShadow: scanning ? "none" : "0 0 24px rgba(255,122,24,.5)",
                }}>
                {scanning ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
                {scanning ? "Stoking…" : "Re-stoke now"}
              </button>
            </div>
          </div>

          {/* stat row */}
          {data && (
            <div className="grid grid-cols-3 gap-3 mt-6 max-w-[640px]">
              {[
                { label: "views on the board", value: data.stats.totalViews },
                { label: "views / day right now", value: data.stats.totalVelocity },
                { label: "videos scanned", value: data.stats.videoCount },
              ].map((s) => (
                <div key={s.label} className="rounded-xl px-4 py-3" style={{ background: "rgba(0,0,0,.35)", border: "1px solid rgba(255,122,24,.2)" }}>
                  <div className="text-[26px] font-extrabold leading-none furnace-rank"><CountUp value={s.value} /></div>
                  <div className="text-[10.5px] mt-1 uppercase tracking-widest" style={{ color: "rgba(255,190,150,.6)" }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}

          {scanning && (
            <div className="mt-4 flex items-center gap-2 text-[12.5px]" style={{ color: EMBER_SOFT }}>
              <Loader2 size={13} className="animate-spin" /> {SCAN_LINES[lineIdx]}
            </div>
          )}
          {err && <div className="mt-4 text-[12.5px]" style={{ color: "#fda4af" }}>{err}</div>}
        </div>
      </div>

      {booting ? (
        <div className="flex items-center gap-2 text-[13px] py-10 justify-center" style={{ color: EMBER_SOFT }}>
          <Loader2 size={14} className="animate-spin" /> Opening the furnace…
        </div>
      ) : !data ? (
        <div className="text-center py-12">
          <Flame size={34} color={EMBER} className="mx-auto mb-3" style={{ animation: "furnacePulse 2s infinite" }} />
          <p className="text-[14px] mb-4" style={{ color: "var(--fg-dim)" }}>No scan yet — light it up and see what your channel is really burning on.</p>
          <button onClick={stoke} disabled={scanning} className="px-5 py-2.5 rounded-full font-bold text-[13.5px]"
            style={{ background: `linear-gradient(120deg, ${EMBER_DEEP}, ${EMBER})`, color: "#1a0a03", boxShadow: "0 0 24px rgba(255,122,24,.5)" }}>
            🔥 First scan
          </button>
        </div>
      ) : (
        <>
          {/* ── winners ── */}
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-bold" style={{ fontFamily: "'Bricolage Grotesque',sans-serif", color: "var(--fg)" }}>
              {lens === "top" ? "🔥 Burning hottest" : "🚀 Rising fastest"}
            </h3>
            <div className="ml-auto flex rounded-full overflow-hidden border" style={{ borderColor: "rgba(255,122,24,.3)" }}>
              {(["top", "rising"] as const).map((k) => (
                <button key={k} onClick={() => setLens(k)} className="px-3.5 py-1.5 text-[12px] font-semibold flex items-center gap-1.5 transition"
                  style={{ background: lens === k ? "rgba(255,122,24,.2)" : "transparent", color: lens === k ? EMBER_SOFT : "var(--fg-dim)" }}>
                  {k === "top" ? <Flame size={12} /> : <TrendingUp size={12} />}
                  {k === "top" ? "All-out winners" : "Views/day"}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))" }}>
            {winners.map((v, i) => (
              <a key={v.videoId + lens} href={`https://www.youtube.com/watch?v=${v.videoId}`} target="_blank" rel="noopener noreferrer" className="furnace-card block group">
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={v.thumb} alt={v.title} className="w-full aspect-video object-cover" loading="lazy"
                    style={{ opacity: 0.92, maskImage: "linear-gradient(180deg, #000 78%, transparent)" }} />
                  <div className="absolute top-2 left-2 text-[30px] leading-none furnace-rank">#{i + 1}</div>
                  {v.duration && <span className="absolute bottom-2 right-2 text-[10.5px] px-1.5 py-0.5 rounded" style={{ background: "rgba(0,0,0,.75)", color: "#fff", fontFamily: "'JetBrains Mono',monospace" }}>{v.duration}</span>}
                </div>
                <div className="px-3.5 pt-1 pb-3.5">
                  <p className="text-[13px] font-semibold leading-snug line-clamp-2" style={{ color: "var(--fg)" }}>{v.title}</p>
                  <div className="flex items-center gap-2 mt-2 text-[11px]" style={{ color: EMBER_SOFT, fontFamily: "'JetBrains Mono',monospace" }}>
                    <span>{v.viewsLabel}</span><span style={{ opacity: 0.4 }}>·</span>
                    <span>{fmt(v.velocity)}/day</span><span style={{ opacity: 0.4 }}>·</span>
                    <span style={{ color: "rgba(255,190,150,.55)" }}>{v.ageLabel}</span>
                    <ArrowUpRight size={12} className="ml-auto opacity-0 group-hover:opacity-100 transition" />
                  </div>
                  <div className="mt-2.5"><HeatBar heat={v.heat} /></div>
                </div>
              </a>
            ))}
          </div>

          {/* ── the forge: new ideas ── */}
          <div className="flex items-center gap-2 pt-2">
            <h3 className="text-[15px] font-bold" style={{ fontFamily: "'Bricolage Grotesque',sans-serif", color: "var(--fg)" }}>⚒️ Forged for tomorrow</h3>
            <span className="text-[11.5px]" style={{ color: "var(--fg-dimmer)" }}>— new ideas built from your proven winners</span>
          </div>

          {data.ideas.length === 0 ? (
            <div className="rounded-xl border px-4 py-4 text-[12.5px] flex items-center gap-3" style={{ borderColor: "rgba(255,122,24,.25)", color: "var(--fg-dim)" }}>
              <Flame size={14} color={EMBER} /> {data.ideasError || "The forge came back empty."}
              <button onClick={stoke} className="ml-auto flex items-center gap-1.5 furnace-chip"><RefreshCw size={11} /> Re-stoke</button>
            </div>
          ) : (
            <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
              {data.ideas.map((idea, i) => {
                const key = `idea-${i}`;
                const text = `${idea.title}\n\nHOOK: ${idea.hook}\n\nWHY IT WORKS: ${idea.why}\nPATTERN FROM: ${idea.borrowed_from}\nFORMAT: ${idea.format}`;
                return (
                  <div key={key} className="furnace-idea">
                    <div className="p-4 h-full flex flex-col">
                      <div className="flex items-start gap-3">
                        <span className="furnace-rank text-[26px] leading-none">{idea.heat}</span>
                        <div className="min-w-0">
                          <p className="text-[14px] font-bold leading-snug" style={{ color: "var(--fg)" }}>{idea.title}</p>
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="furnace-chip">{idea.format}</span>
                            <div className="flex-1 min-w-[60px]"><HeatBar heat={idea.heat} /></div>
                          </div>
                        </div>
                        <button onClick={() => copy(key, text)} title="Copy the full idea"
                          className="shrink-0 p-1.5 rounded-lg transition" style={{ border: "1px solid rgba(255,122,24,.3)", color: copied === key ? "#86efac" : EMBER_SOFT }}>
                          {copied === key ? <Check size={13} /> : <Copy size={13} />}
                        </button>
                      </div>
                      <p className="text-[12.5px] mt-3 leading-relaxed" style={{ color: "rgba(255,220,195,.85)" }}>
                        <span style={{ color: EMBER_SOFT, fontWeight: 700 }}>Hook: </span>&ldquo;{idea.hook}&rdquo;
                      </p>
                      <p className="text-[11.5px] mt-2 leading-relaxed" style={{ color: "var(--fg-dim)" }}>{idea.why}</p>
                      {idea.borrowed_from && (
                        <p className="text-[10.5px] mt-auto pt-2.5" style={{ color: "rgba(255,190,150,.5)", fontFamily: "'JetBrains Mono',monospace" }}>
                          ↳ pattern from: {idea.borrowed_from}
                        </p>
                      )}
                      {/* one click from idea → production, straight into the other Agent OS tools */}
                      <div className="flex items-center gap-1.5 pt-3 flex-wrap">
                        <a href={`/video?topic=${encodeURIComponent(`${idea.title} — open with: ${idea.hook}`)}`}
                          className="furnace-chip flex items-center gap-1.5 hover:brightness-125 transition" title="Send to the Video Director">
                          <Clapperboard size={11} /> Make the video
                        </a>
                        <a href={`/agent-kanban?seo=1&goal=${encodeURIComponent(idea.title)}`}
                          className="furnace-chip flex items-center gap-1.5 hover:brightness-125 transition" title="Send to the SEO cluster (Agent Kanban → Hermes)">
                          <PenLine size={11} /> SEO article
                        </a>
                        <a href={`/thumbnails?topic=${encodeURIComponent(idea.title)}`}
                          className="furnace-chip flex items-center gap-1.5 hover:brightness-125 transition" title="Send to the Thumbnail Studio">
                          <ImageIcon size={11} /> Thumbnail
                        </a>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
