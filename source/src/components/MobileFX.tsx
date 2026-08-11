"use client";

import { useEffect, useRef, useState } from "react";

// Narrow-window dopamine layer: rising fire embers + gentle twinkling stars,
// drawn on one lightweight canvas over every page. Full-width desktop never mounts it —
// this exists for the phone (IG-video) experience only. pointer-events: none, capped
// particle count, and it fully disables for prefers-reduced-motion.
export default function MobileFX() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1180px)");
    const rm = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setOn(mq.matches && !rm.matches);
    update();
    mq.addEventListener("change", update);
    rm.addEventListener("change", update);
    return () => { mq.removeEventListener("change", update); rm.removeEventListener("change", update); };
  }, []);

  useEffect(() => {
    if (!on || !ref.current) return;
    const canvas = ref.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let W = 0, H = 0, raf = 0, running = true;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const size = () => {
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = W * DPR; canvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    size();
    window.addEventListener("resize", size);

    // ember palette: fire first, then brand neon accents
    const COLORS = ["#ffb84d", "#ff8a3c", "#ff5f3c", "#ffd700", "#e6c69a", "#7fe0bd", "#c084fc"];
    type Ember = { x: number; y: number; vx: number; vy: number; r: number; life: number; max: number; c: string; sway: number };
    const embers: Ember[] = [];
    const MAX = 60; // phone-safe cap

    const spawn = (): Ember => ({
      x: Math.random() * W,
      y: H + 8,
      vx: (Math.random() - 0.5) * 0.25,
      vy: -(0.35 + Math.random() * 0.85),
      r: Math.random() < 0.22 ? 3.0 + Math.random() * 1.8 : 1.0 + Math.random() * 2.2,
      life: 0,
      max: 260 + Math.random() * 240,
      c: COLORS[Math.random() < 0.78 ? (Math.random() * 5) | 0 : 5 + ((Math.random() * 2) | 0)],
      sway: 0.4 + Math.random() * 1.4,
    });
    for (let i = 0; i < MAX; i++) { const e = spawn(); e.y = Math.random() * H; e.life = Math.random() * e.max; embers.push(e); }

    // gentle twinkling stars — calm beauty layer (no streaks, nothing that darts)
    type Star = { x: number; y: number; r: number; ph: number; sp: number; c: string };
    const stars: Star[] = Array.from({ length: 34 }, () => ({
      x: Math.random(), y: Math.random() * 0.9,
      r: 0.5 + Math.random() * 1.1,
      ph: Math.random() * Math.PI * 2,
      sp: 0.006 + Math.random() * 0.012,
      c: ["#f3ebda", "#e6c69a", "#9dffd8", "#cdd3f7"][(Math.random() * 4) | 0],
    }));
    let frame = 0;

    const tick = () => {
      if (!running) return;
      ctx.clearRect(0, 0, W, H);

      // bottom heat glow
      const g = ctx.createLinearGradient(0, H - 130, 0, H);
      g.addColorStop(0, "rgba(255,95,60,0)");
      g.addColorStop(1, "rgba(255,138,60,0.16)");
      ctx.fillStyle = g;
      ctx.fillRect(0, H - 130, W, 130);

      for (const e of embers) {
        e.life++;
        e.x += e.vx + Math.sin((e.life / 34) * e.sway) * 0.35;
        e.y += e.vy;
        const p = e.life / e.max;
        if (p >= 1 || e.y < -10) { Object.assign(e, spawn()); continue; }
        const alpha = p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85;
        ctx.globalAlpha = Math.max(0, alpha) * 0.92;
        ctx.shadowBlur = 14;
        ctx.shadowColor = e.c;
        ctx.fillStyle = e.c;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r * (1 - p * 0.4), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;

      // twinkling stars — slow sine shimmer, the biggest ones get a sparkle cross
      frame++;
      for (const s of stars) {
        const tw = Math.abs(Math.sin(frame * s.sp + s.ph));
        const a = 0.12 + tw * 0.65;
        const x = s.x * W, y = s.y * H;
        ctx.globalAlpha = a;
        ctx.shadowBlur = 8;
        ctx.shadowColor = s.c;
        ctx.fillStyle = s.c;
        ctx.beginPath();
        ctx.arc(x, y, s.r, 0, Math.PI * 2);
        ctx.fill();
        if (s.r > 1.2 && tw > 0.85) {
          ctx.globalAlpha = (tw - 0.85) * 4;
          ctx.strokeStyle = s.c;
          ctx.lineWidth = 0.7;
          const L = s.r * 5;
          ctx.beginPath();
          ctx.moveTo(x - L, y); ctx.lineTo(x + L, y);
          ctx.moveTo(x, y - L); ctx.lineTo(x, y + L);
          ctx.stroke();
        }
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const vis = () => { running = document.visibilityState === "visible"; if (running) raf = requestAnimationFrame(tick); };
    document.addEventListener("visibilitychange", vis);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [on]);

  if (!on) return null;
  return (
    <>
      <div aria-hidden className="fx-aurora" />
      <canvas
        ref={ref}
        aria-hidden
        style={{ position: "fixed", inset: 0, zIndex: 35, pointerEvents: "none" }}
      />
    </>
  );
}
