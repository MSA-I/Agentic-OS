"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import CommandPalette from "./CommandPalette";

interface PageMeta { numeral: string; label: string; title: string; sub: string; }

// Roman numeral + chapter label per route (Midnight Aubergine design system).
// numeral renders in Caveat gold, label in small-caps Manrope. See globals.css `.eyebrow`.
const TITLES: Record<string, PageMeta> = {
  "/":            { numeral: "I.",    label: "Mission Control",    title: "Mission Control",         sub: "Status of every agent, every memory, every signal." },
  "/claude":      { numeral: "II.",   label: "Agent · Claude",     title: "Claude",                  sub: "Direct streaming channel to your Claude Code CLI. Voice in, auto-logged to Obsidian." },
  "/openclaw":    { numeral: "III.",  label: "Agent · OpenClaw",   title: "OpenClaw",                sub: "Chat one-shot or open the control room. Logged to your vault." },
  "/hermes":      { numeral: "IV.",   label: "Agent · Hermes",     title: "Hermes",                  sub: "Nous Research agent. Sessions, skills, kanban — and a chat line." },
  "/antigravity": { numeral: "V.",    label: "Agent · Antigravity",title: "Antigravity",             sub: "Gemini CLI's successor. Go-based, multi-agent harness, plugins, async workflows." },
  "/codex":       { numeral: "VII.",  label: "Agent · Codex",      title: "Codex",                   sub: "OpenAI's coding agent. Chat, set long-running goals, preview anything it builds." },
  "/kimi":        { numeral: "VII.",  label: "Agent · Kimi Code",  title: "Kimi Code",               sub: "Moonshot's Kimi coding agent — now with K3 (2.5T · 1M context). Chat with memory, build, and preview anything it writes." },
  "/glm":         { numeral: "VIII.", label: "Agent · GLM 5.2",    title: "GLM 5.2",                 sub: "Zhipu's GLM-5.2 flagship coder on the z.ai Coding Plan. 1M context. Chat, build, and preview anything it writes." },
  "/grok":        { numeral: "VIII.", label: "Agent · Grok Build", title: "Grok Build",              sub: "xAI's grok-4.5 coding agent, signed in on your X Premium+ plan (Grok OAuth). Chat, build games + apps, and preview anything it writes." },
  "/freeclaude":  { numeral: "VIII.", label: "Agent · Free Claude Code", title: "Free Claude Code",  sub: "Open-source proxy. Same Claude CLI, routed to your local model — free, on your Mac." },
  "/jcode":       { numeral: "VIII.", label: "Agent · jcode", title: "jcode",  sub: "The most RAM-efficient harness — Rust, ~28MB a session, 14ms to first frame, on your Claude login." },
  "/omniroute":   { numeral: "VIII.", label: "Agent · Free AI Coder", title: "Free AI Coder", sub: "Two locally managed gateways, one dropdown: OmniRoute (free pool) and 9Router (models available through your connected accounts). Routing and fallback happen on this computer; inference can send prompts and files to the selected upstream provider." },
  "/fusion":      { numeral: "VIII.", label: "Agent · Fusion",     title: "Fusion Boardroom",        sub: "OpenRouter Fusion — a panel of models deliberates with web search, then a judge writes the verdict. For the calls where being wrong is expensive." },
  "/sakana":      { numeral: "VIII.", label: "Agent · Sakana",     title: "Sakana Fugu",             sub: "A vendor-agnostic council — a panel of models deliberates in parallel with web search, then a judge weighs it all and writes the verdict. Collective intelligence, not one model's guess." },
  "/local":       { numeral: "VIII.", label: "Agent · Local",      title: "Local",                   sub: "Whatever model you've pinned warm in Ollama, running 100% on your Mac — offline, free, instant. Build with your voice, preview live." },
  "/engine":      { numeral: "VIII.", label: "Agent · Local Engine", title: "The Local Hermes Engine", sub: "A real agent on your Mac — Gemma-4 12B Coder via Hermes, fully offline. Give it a task by voice or text; it runs commands and builds files, and you watch what it makes appear live. Free, private, nothing leaves the machine." },
  "/agent-kanban":{ numeral: "VIII.", label: "Agent · Kanban",       title: "Agent Kanban",            sub: "A team of local offline agents works a live board: the Planner breaks your goal into cards, the Builder builds each one, the Reviewer checks it really landed — and every Done card previews live. 100% on your Mac." },
  "/room":        { numeral: "IX.",   label: "Self · Mastermind",  title: "AI Agent Mastermind",     sub: "A live group chat with all your agents — each one a different real model. They read your vault, reply in turn, riff off each other, and can save notes or start projects. Tag one with @claude." },
  "/pipeline":    { numeral: "X.",    label: "Self · Pipeline",    title: "From Inbox to Shipped",   sub: "Capture an idea → agents classify, route + plan it → you approve once → a PM + subagents build it. Lives in your vault." },
  "/loop":        { numeral: "X.",    label: "Self · Loop",        title: "Loop Engineering",        sub: "Define what 'done' looks like. A builder acts, Fusion verifies it adversarially, and it loops until the gate passes — you stop being the loop." },
  "/goals":       { numeral: "X.",    label: "Self · Goals",       title: "Goals",                   sub: "Set targets. Tick them off. Watch the bar fill. Saved to Goals.md." },
  "/seo":         { numeral: "X.",    label: "Self · SEO Pipeline",title: "SEO Content Pipeline",    sub: "Pick a keyword + transcript. Generate 5 unique articles. Deploy to your Netlify funnel." },
  "/radar":       { numeral: "X.",    label: "Self · Radar",       title: "The Radar",               sub: "A 24/7 watcher on AI news + X. Hermes searches X live (Grok OAuth), ranks what's actually trending, and hands you the post-it-today story — with the source tweet, your angle and a ready hook. Sweeps every morning, logs to Obsidian." },
  "/opendesign":  { numeral: "X.",    label: "Self · Open Design", title: "Open Design",             sub: "The local-first, open-source Claude Design alternative — embedded right here. Generate prototypes, dashboards, decks, images and motion graphics on your own machine, driving your own agents." },
  "/games":       { numeral: "XI.",   label: "Workflow · Game Agent", title: "Game Studio",        sub: "The Coding Video Game Agent — describe a game, it builds it, you play it on the shelf." },
  "/studio":      { numeral: "XI.",   label: "Self · Studio",      title: "Studio",                  sub: "Generate images, videos and speech with Hermes. Voice in, preview inline, save to vault." },
  "/thumbnails":  { numeral: "XI.",   label: "Self · Thumbnails",  title: "Thumbnail Studio",        sub: "Upload a thumbnail + say what to improve → gpt-image-2 makes better versions. Every round is logged to your vault so it learns your style." },
  "/notebook":    { numeral: "XII.",  label: "Self · Notebook",    title: "Notebook",                sub: "Your NotebookLM notebooks, audio overviews and chats — all in one place, synced to Obsidian." },
  "/kanban":      { numeral: "XIII.", label: "Self · Kanban",      title: "Kanban",                  sub: "Hermes Agent multi-agent board. Drop a prompt into triage, watch the orchestrator decompose + assign." },
  "/journal":     { numeral: "XIV.",  label: "Self · Journal",     title: "Journal",                 sub: "Daily entries with voice or text. One markdown file per day." },
  "/memory":      { numeral: "XV.",   label: "Self · Memory",      title: "Memory",                  sub: "Search 1261 Omi memories + your Obsidian vault." },
  "/guide":       { numeral: "XVI.",  label: "Build · Your Own",   title: "Build Your Own",          sub: "Step-by-step guide. Anyone can follow it. Share with your community." },
  // Routes added after the original map — without an entry here the page silently
  // inherits Mission Control's header, which is what a phone shows first.
  "/deepseek-coder": { numeral: "VIII.", label: "Agent · DeepSeek",   title: "DeepSeek Coder",          sub: "DeepSeek V4 Flash straight off DeepSeek's own API. Describe something, watch it build live." },
  "/muse-code":   { numeral: "VIII.", label: "Agent · Muse Code",  title: "Muse Code",               sub: "Meta's Muse Spark 1.2 — the brain behind their first coding agent. Describe something, watch it build live." },
  "/hy3-coder":   { numeral: "VIII.", label: "Agent · HY3",        title: "HY3 Coder",               sub: "Tencent's 295B agentic model, free on OpenRouter. Chat, build, preview anything it writes." },
  "/glm-code":    { numeral: "VIII.", label: "Agent · GLM Code",   title: "GLM Code",                sub: "GLM's coding agent on your z.ai plan. Build and preview in one panel." },
  "/opencode":    { numeral: "VIII.", label: "Agent · OpenCode",   title: "OpenCode",                sub: "The open-source terminal coding agent, wired to whichever provider you point it at." },
  "/higgsfield":  { numeral: "XI.",   label: "Studio · Higgsfield", title: "Higgsfield",             sub: "Image and video generation over MCP — every asset, session and prompt kept in one gallery." },
  "/video":       { numeral: "XI.",   label: "Studio · Video",     title: "Video",                   sub: "Generate video with your agents. Keyframes, motion inspection, saved to the workspace." },
  "/video-use":   { numeral: "XI.",   label: "Studio · Video Use", title: "Video Use",               sub: "Point an agent at a video and have it watch, describe and act on what it sees." },
  "/music":       { numeral: "XI.",   label: "Studio · Music",     title: "Music",                   sub: "Suno-powered tracks from a prompt, saved straight into the workspace." },
  "/openmontage": { numeral: "XI.",   label: "Studio · Montage",   title: "OpenMontage",             sub: "Agentic video editing — a real Remotion render from a prompt, no keys required." },
  "/astros":      { numeral: "VIII.", label: "Agent · Astros",     title: "Hermes Astros",           sub: "Hermes' long-running research crew. Set a brief, come back to the findings." },
  "/leads":       { numeral: "X.",    label: "Self · Leads",       title: "Leads",                   sub: "Find, enrich, score and write to prospects — one pipeline, your own data." },
  "/apps":        { numeral: "XI.",   label: "Self · Apps",        title: "Apps",                    sub: "Everything your agents have built, playable and previewable in one shelf." },
  "/demo-history":{ numeral: "XI.",   label: "Self · Demo History",title: "Demo History",            sub: "Every build this OS has produced, newest first, one click to open." },
  "/paperclip":   { numeral: "X.",    label: "Self · Paperclip",   title: "Paperclip",               sub: "Clip anything into the vault — a link, a note, a screenshot — and let the agents file it." },
  "/ruflo":       { numeral: "X.",    label: "Self · Ruflo",       title: "Ruflo",                   sub: "Swarm memory, routing and hooks — the coordination layer under the agents." },
  "/seo-guide":   { numeral: "XVI.",  label: "Build · SEO",        title: "SEO Setup Guide",         sub: "Wire the SEO pipeline to your own sites, step by step." },
};

export default function TopBar() {
  const pathname = usePathname();
  const t = TITLES[pathname] ?? TITLES["/"];
  const [time, setTime] = useState<string>("");

  useEffect(() => {
    const set = () =>
      setTime(new Date().toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit" }));
    set();
    const i = setInterval(set, 1000 * 15);
    return () => clearInterval(i);
  }, []);

  return (
    <header className="flex items-start justify-between gap-3 md:gap-6 mb-6 md:mb-10">
      <motion.div
        key={pathname}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="min-w-0"
      >
        {/* Chapter eyebrow — `I. ───── MISSION CONTROL` */}
        <div className="eyebrow">
          <span className="num">{t.numeral}</span>
          <span className="line" />
          <span className="label">{t.label}</span>
        </div>

        <h1 className="page-title">{t.title}</h1>
        <p className="page-subtitle">{t.sub}</p>

        <div className="mt-4 status-meta">
          <span className="hand">{time}</span>
          <span className="mx-2 opacity-40">·</span>
          Local · Studio
        </div>
      </motion.div>

      <div className="flex items-center gap-3 pt-2 shrink-0">
        <CommandPalette />
        <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-md border border-[var(--line-soft)] text-[11px]"
             style={{ color: "var(--cream-dim)", background: "rgba(243,235,218,0.02)" }}>
          <span className="inline-flex">
            <span className="tick live" style={{ color: "var(--gold)" }} />
            <span className="tick live" style={{ color: "var(--gold-soft)", animationDelay: ".15s" }} />
            <span className="tick live" style={{ color: "var(--emerald)", animationDelay: ".3s" }} />
            <span className="tick live" style={{ color: "var(--rust)", animationDelay: ".45s" }} />
          </span>
          <span className="uppercase tracking-widest" style={{ fontFamily: "'Manrope', sans-serif", fontWeight: 600 }}>
            All systems
          </span>
        </div>
      </div>
    </header>
  );
}
