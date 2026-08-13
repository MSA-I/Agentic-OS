"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  Brain,
  Building2,
  Check,
  Clapperboard,
  Columns3,
  Cpu,
  Eye,
  EyeOff,
  Film,
  FlaskConical,
  Gamepad2,
  GripVertical,
  Image as ImageIcon,
  LayoutDashboard,
  LayoutGrid,
  MessagesSquare,
  Music2,
  Network,
  NotebookText,
  Palette,
  PlugZap,
  Repeat,
  Route,
  Scissors,
  SlidersHorizontal,
  SquareTerminal,
  Star,
  TrendingUp,
  Wand2,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import AgentAvatar from "./AgentAvatar";
import ScrollArea from "./ScrollArea";
import { openSetupCenter } from "./SetupCenterHost";
import { useNavigationModel, type NavigationModelItem } from "@/hooks/useNavigationModel";
import {
  NAVIGATION_BY_HREF,
  NAVIGATION_SECTION_LABELS,
  type EffectiveNavigationSection,
} from "@/lib/navigation";

interface NavVisual {
  icon: ReactNode;
  accent: string;
  dim: string;
}

const visual = (icon: ReactNode, accent: string, rgb: string): NavVisual => ({
  icon,
  accent,
  dim: `rgba(${rgb},0.16)`,
});

const NAV_VISUALS: Record<string, NavVisual> = {
  "/": visual(<LayoutGrid size={16} />, "#a855f7", "168,85,247"),
  "/paperclip": visual(<Building2 size={16} />, "#d4a574", "212,165,116"),
  "/room": visual(<MessagesSquare size={16} />, "#a855f7", "168,85,247"),
  "/pipeline": visual(<Workflow size={16} />, "#34d399", "52,211,153"),
  "/claude": visual(<AgentAvatar agent="claude" size={22} />, "#d97757", "217,119,87"),
  "/openclaw": visual(<AgentAvatar agent="openclaw" size={22} />, "#f472b6", "244,114,182"),
  "/hermes": visual(<AgentAvatar agent="hermes" size={22} />, "#60a5fa", "96,165,250"),
  "/antigravity": visual(<AgentAvatar agent="antigravity" size={22} />, "#7c3aed", "124,58,237"),
  "/codex": visual(<AgentAvatar agent="codex" size={22} />, "#22c55e", "34,197,94"),
  "/kimi": visual(<AgentAvatar agent="kimi" size={22} />, "#00CCFF", "0,204,255"),
  "/glm": visual(<AgentAvatar agent="glm" size={22} />, "#34E5B0", "52,229,176"),
  "/glm-code": visual(<SquareTerminal size={18} />, "#10b981", "16,185,129"),
  "/jcode": visual(<SquareTerminal size={18} />, "#f5a623", "245,166,35"),
  "/grok": visual(<AgentAvatar agent="grok" size={22} />, "#cdd3f7", "205,211,247"),
  "/freeclaude": visual(<AgentAvatar agent="fcc" size={22} />, "#10b981", "16,185,129"),
  "/omniroute": visual(<Route size={18} />, "#2dd4bf", "45,212,191"),
  "/hy3-coder": visual(<Cpu size={18} />, "#3b82f6", "59,130,246"),
  "/deepseek-coder": visual(<Cpu size={18} />, "#4d6bfe", "77,107,254"),
  "/muse-code": visual(<Cpu size={18} />, "#0082FB", "0,130,251"),
  "/higgsfield": visual(<Wand2 size={18} />, "#c084fc", "192,132,252"),
  "/opencode": visual(<SquareTerminal size={18} />, "#38bdf8", "56,189,248"),
  "/fusion": visual(<Network size={18} />, "#d4a574", "212,165,116"),
  "/sakana": visual(<Network size={18} />, "#ff5f9e", "255,95,158"),
  "/local": visual(<Cpu size={18} />, "#5eead4", "94,234,212"),
  "/engine": visual(<Cpu size={18} />, "#67e8f9", "103,232,249"),
  "/agent-kanban": visual(<LayoutDashboard size={18} />, "#7dd3fc", "125,211,252"),
  "/loop": visual(<Repeat size={16} />, "#2dd4bf", "45,212,191"),
  "/ruflo": visual(<Network size={16} />, "#818cf8", "129,140,248"),
  "/leads": visual(<TrendingUp size={16} />, "#fb7185", "251,113,133"),
  "/seo": visual(<TrendingUp size={16} />, "#a3e635", "163,230,53"),
  "/opendesign": visual(<Palette size={16} />, "#e879f9", "232,121,249"),
  "/video": visual(<Film size={16} />, "#ef4444", "239,68,68"),
  "/studio": visual(<Palette size={16} />, "#c084fc", "192,132,252"),
  "/openmontage": visual(<Clapperboard size={16} />, "#f0a868", "240,168,104"),
  "/video-use": visual(<Scissors size={16} />, "#f59e0b", "245,158,11"),
  "/music": visual(<Music2 size={16} />, "#c084fc", "192,132,252"),
  "/games": visual(<Gamepad2 size={16} />, "#39ff8e", "57,255,142"),
  "/apps": visual(<FlaskConical size={16} />, "#a3e635", "163,230,53"),
  "/thumbnails": visual(<ImageIcon size={16} />, "#fb7185", "251,113,133"),
  "/notebook": visual(<NotebookText size={16} />, "#fde047", "253,224,71"),
  "/kanban": visual(<Columns3 size={16} />, "#14b8a6", "20,184,166"),
  "/memory": visual(<Brain size={16} />, "#22d3ee", "34,211,238"),
  "/goals": visual(<Workflow size={16} />, "#fbbf24", "251,191,36"),
  "/journal": visual(<NotebookText size={16} />, "#a78bfa", "167,139,250"),
};

const FALLBACK_VISUAL = visual(<Cpu size={18} />, "#d4a574", "212,165,116");

function navVisual(href: string): NavVisual {
  return NAV_VISUALS[href] ?? FALLBACK_VISUAL;
}

function isRouteActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function itemData(item: NavigationModelItem, active: boolean) {
  return {
    "data-nav-item": "",
    "data-nav-route": item.href,
    "data-nav-native-section": item.section,
    "data-nav-section": item.effectiveSection,
    "data-nav-status": item.status.status,
    "data-nav-favorite": String(item.favorite),
    "data-nav-hidden": String(item.hidden),
    "data-nav-active": String(active),
  };
}

export default function Sidebar() {
  const pathname = usePathname();
  const [customize, setCustomize] = useState(false);
  const [dragItem, setDragItem] = useState<{ href: string; section: EffectiveNavigationSection } | null>(null);
  const [overHref, setOverHref] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  const navigation = useNavigationModel({ includeHidden: customize });
  const setupRequiredCount = navigation.allItems.filter((item) => item.status.status === "not-installed").length;

  useEffect(() => {
    fetch("/api/version").then((response) => response.json()).then((payload) => setVersion(payload.version || "")).catch(() => {});
  }, []);

  return (
    <aside
      data-main-sidebar
      data-navigation-root="desktop"
      data-nav-settled={String(navigation.settled)}
      data-nav-status-failed={String(navigation.statusFailed)}
      className="hidden md:flex flex-col w-[232px] shrink-0 h-screen overflow-hidden py-5 border-r border-[var(--line-soft)]"
      style={{ background: "var(--bg-mid)" }}
    >
      <Link href="/" className="block mb-5 px-4 shrink-0">
        <div className="text-[10px] uppercase tracking-[0.25em] mb-1" style={{ color: "var(--cream-mute)", fontFamily: "'Manrope', sans-serif", fontWeight: 600 }}>
          Local · Studio
        </div>
        <div className="text-xl tracking-tight" style={{ fontFamily: "'Bricolage Grotesque', sans-serif", fontWeight: 500, color: "var(--cream)" }}>
          Agentic <span className="hand text-[1.3em] ml-1">OS</span>
        </div>
        {version && (
          <div className="text-[10px] mt-1 tracking-wider" style={{ color: "var(--cream-mute)", fontFamily: "'Manrope', sans-serif" }} title="Pack build version">
            build {version}
          </div>
        )}
      </Link>

      <ScrollArea
        ariaLabel="Main navigation"
        className="flex-1 min-h-0"
        viewportClassName="h-full"
        scrollbar="hover"
        fades
        overscroll="contain"
        style={{ "--scroll-area-fade-color": "var(--bg-mid)" } as CSSProperties}
      >
        <div className="px-4 pb-2 flex items-center justify-between">
          <span className="sidebar-section-label">Navigation</span>
          <div className="flex items-center gap-2">
            {customize && (
              <button onClick={navigation.reset} title="Reset navigation preferences" className="text-[9px] uppercase tracking-[0.15em] hover:opacity-100 opacity-70 transition" style={{ color: "var(--cream-dim)" }}>
                Reset
              </button>
            )}
            <button
              onClick={() => setCustomize((current) => !current)}
              title={customize ? "Done customizing" : "Customize favorites, order and visibility"}
              aria-pressed={customize}
              className="grid place-items-center w-6 h-6 rounded-md transition"
              style={{ color: customize ? "var(--gold)" : "var(--cream-dim)", background: customize ? "rgba(212,165,116,0.14)" : "transparent" }}
            >
              {customize ? <Check size={14} /> : <SlidersHorizontal size={14} />}
            </button>
          </div>
        </div>
        {customize && (
          <div className="px-4 pb-2 text-[10px] leading-snug" style={{ color: "var(--cream-mute)" }}>
            Drag within a section · star favorites · use the eye to hide
          </div>
        )}

        <nav className="flex flex-col gap-0.5 relative" aria-label="Main navigation">
          {navigation.sections.map((section, sectionIndex) => (
            <section
              key={section.id}
              data-nav-section={section.id}
              data-nav-section-order={sectionIndex}
              className={sectionIndex === 0 ? "" : "mt-4"}
            >
              <div className="mb-1 px-4">
                <span className="sidebar-section-label">{NAVIGATION_SECTION_LABELS[section.id]}</span>
              </div>
              {section.items.map((item) => {
                const active = isRouteActive(pathname, item.href);
                const style = navVisual(item.href);
                const unavailableTitle = item.status.status === "not-installed"
                  ? item.status.reason ?? "Not installed"
                  : item.status.status === "checking"
                    ? navigation.statusFailed ? "Status unavailable" : "Checking availability"
                    : undefined;
                const isOver = overHref === item.href && dragItem?.href !== item.href;

                if (customize) {
                  return (
                    <div
                      key={item.href}
                      {...itemData(item, active)}
                      draggable
                      onDragStart={() => setDragItem({ href: item.href, section: section.id })}
                      onDragEnter={() => { if (dragItem?.section === section.id) setOverHref(item.href); }}
                      onDragOver={(event) => { if (dragItem?.section === section.id) event.preventDefault(); }}
                      onDrop={() => {
                        if (dragItem?.section === section.id) navigation.moveItem(dragItem.href, item.href, section.id);
                        setDragItem(null);
                        setOverHref(null);
                      }}
                      onDragEnd={() => { setDragItem(null); setOverHref(null); }}
                      className="sidebar-item relative group flex min-h-9 items-center gap-1.5 px-2.5 mx-1.5 rounded-lg cursor-grab active:cursor-grabbing"
                      style={{
                        opacity: dragItem?.href === item.href ? 0.4 : item.hidden ? 0.4 : item.status.status === "not-installed" ? 0.68 : 1,
                        borderTop: isOver ? "2px solid var(--gold)" : "2px solid transparent",
                        background: isOver ? "rgba(212,165,116,0.08)" : "transparent",
                      }}
                      title={unavailableTitle}
                    >
                      <GripVertical size={14} style={{ color: "var(--cream-mute)" }} className="shrink-0" />
                      <span className="shrink-0 grid place-items-center w-6 h-6 rounded-md" style={{ color: "var(--cream-dim)" }}>{style.icon}</span>
                      <span className="flex-1 truncate" style={{ textDecoration: item.hidden ? "line-through" : "none" }}>{item.label}</span>
                      <button
                        onClick={() => navigation.toggleFavorite(item.href)}
                        aria-label={item.favorite ? `Remove ${item.label} from favorites` : `Add ${item.label} to favorites`}
                        aria-pressed={item.favorite}
                        className="shrink-0 grid place-items-center w-6 h-6 rounded-md transition hover:bg-[rgba(255,255,255,0.06)]"
                        style={{ color: item.favorite ? "var(--gold)" : "var(--cream-mute)" }}
                      >
                        <Star size={13} fill={item.favorite ? "currentColor" : "none"} />
                      </button>
                      <button
                        onClick={() => navigation.toggleHidden(item.href)}
                        aria-label={item.hidden ? `Show ${item.label}` : `Hide ${item.label}`}
                        className="shrink-0 grid place-items-center w-6 h-6 rounded-md transition hover:bg-[rgba(255,255,255,0.06)]"
                        style={{ color: item.hidden ? "var(--cream-mute)" : "var(--gold)" }}
                      >
                        {item.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  );
                }

                return (
                  <div
                    key={item.href}
                    {...itemData(item, active)}
                    className={`sidebar-item relative group flex items-center mx-0 ${active ? "active" : ""}`}
                    style={{ opacity: item.status.status === "not-installed" ? 0.68 : 1 }}
                    title={unavailableTitle}
                  >
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`relative min-w-0 min-h-9 flex-1 flex items-center gap-2.5 py-1 pl-4 pr-1 ${active ? "active" : ""}`}
                    >
                      {active && (
                        <motion.span
                          layoutId="nav-indicator"
                          className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-[22px]"
                          style={{ background: "var(--gold)", boxShadow: "0 0 10px var(--gold)" }}
                          transition={{ type: "spring", stiffness: 380, damping: 30 }}
                        />
                      )}
                      <span className="shrink-0 grid place-items-center w-6 h-6 rounded-md transition" style={{ color: active ? "var(--gold)" : "var(--cream-dim)" }}>
                        {style.icon}
                      </span>
                      <span className="truncate">{item.label}</span>
                      {item.status.status !== "ready" && (
                        <span
                          aria-label={item.status.status === "checking" ? "Checking availability" : "Not installed"}
                          className={`ml-auto shrink-0 w-1.5 h-1.5 rounded-full ${item.status.status === "checking" ? "animate-pulse" : ""}`}
                          style={{ background: item.status.status === "checking" ? "var(--gold)" : "var(--cream-mute)" }}
                        />
                      )}
                    </Link>
                    {item.status.status === "not-installed" && (
                      <button
                        type="button"
                        onClick={() => openSetupCenter(item.href)}
                        aria-label={`Set up ${item.label}`}
                        title={`Install or connect ${item.label}`}
                        className="shrink-0 grid place-items-center w-7 h-7 rounded-md opacity-70 transition hover:opacity-100 hover:bg-[rgba(212,165,116,0.12)] focus:opacity-100"
                        style={{ color: "var(--gold)" }}
                      >
                        <PlugZap size={13} />
                      </button>
                    )}
                    <button
                      onClick={() => navigation.toggleFavorite(item.href)}
                      aria-label={item.favorite ? `Remove ${item.label} from favorites` : `Add ${item.label} to favorites`}
                      aria-pressed={item.favorite}
                      className={`mr-2 shrink-0 grid place-items-center w-6 h-6 rounded-md transition hover:bg-[rgba(255,255,255,0.06)] ${item.favorite ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
                      style={{ color: item.favorite ? "var(--gold)" : "var(--cream-mute)" }}
                    >
                      <Star size={13} fill={item.favorite ? "currentColor" : "none"} />
                    </button>
                  </div>
                );
              })}
              {customize && (
                <div
                  onDragEnter={() => { if (dragItem?.section === section.id) setOverHref(`${section.id}:end`); }}
                  onDragOver={(event) => { if (dragItem?.section === section.id) event.preventDefault(); }}
                  onDrop={() => {
                    if (dragItem?.section === section.id) navigation.moveItem(dragItem.href, "__end__", section.id);
                    setDragItem(null);
                    setOverHref(null);
                  }}
                  className="h-4 mx-2 rounded-lg"
                  style={{ borderTop: overHref === `${section.id}:end` ? "2px solid var(--gold)" : "2px solid transparent" }}
                />
              )}
            </section>
          ))}
        </nav>
      </ScrollArea>

      <div className="shrink-0 pt-5 mx-5 border-t border-[var(--line-soft)]">
        {setupRequiredCount > 0 && (
          <button
            type="button"
            onClick={() => openSetupCenter()}
            className="mb-3 min-h-9 w-full inline-flex items-center justify-center gap-2 rounded-md border text-[11px] font-semibold transition hover:bg-[rgba(212,165,116,0.1)]"
            style={{ borderColor: "rgba(212,165,116,0.3)", color: "var(--gold)" }}
          >
            <PlugZap size={13} /> Connect services <span className="metric opacity-70">{setupRequiredCount}</span>
          </button>
        )}
        <div className="text-[10px] leading-relaxed mono" style={{ color: "var(--cream-dim)" }}>
          {navigation.statusFailed
            ? "Availability check unavailable"
            : navigation.settled
              ? "Live availability checked"
              : "Checking integrations…"}
        </div>
      </div>
    </aside>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  const navigation = useNavigationModel();
  const [open, setOpen] = useState<null | "all" | "agents">(null);

  useEffect(() => { setOpen(null); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  const sheetSections = open === "agents" ? navigation.agentSections : navigation.sections;
  const onAgentPage = navigation.allItems.some((item) => item.section === "agents" && isRouteActive(pathname, item.href));
  const home = navigation.allItems.find((item) => item.href === "/");

  return (
    <>
      {open && (
        <div
          data-navigation-root="mobile-sheet"
          data-nav-settled={String(navigation.settled)}
          data-nav-status-failed={String(navigation.statusFailed)}
          className="md:hidden !fixed inset-0 z-50 flex flex-col"
          style={{ background: "rgba(10,6,16,0.97)", backdropFilter: "blur(14px)" }}
        >
          <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-[var(--line-soft)]">
            <span className="text-[11px] uppercase tracking-[0.2em] text-[var(--fg-dimmer)]">
              {open === "agents" ? "Choose your agent" : "Agentic OS · navigation"}
            </span>
            <button onClick={() => setOpen(null)} aria-label="Close menu" className="grid place-items-center w-11 h-11 rounded-lg border border-[var(--line-soft)] text-[var(--fg-dim)]">
              <X size={16} className="text-[var(--fg-dim)]" />
            </button>
          </div>
          <ScrollArea
            ariaLabel={open === "agents" ? "Agent navigation" : "All navigation"}
            className="flex-1 min-h-0"
            viewportClassName="h-full"
            scrollbar="hover"
            fades
            overscroll="contain"
            style={{ "--scroll-area-fade-color": "rgba(10,6,16,0.97)" } as CSSProperties}
          >
          <div className="px-4 py-4" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 24px)" }}>
            {sheetSections.map((section, sectionIndex) => (
              <section key={section.id} data-nav-section={section.id} data-nav-section-order={sectionIndex} className="mb-5">
                <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--fg-dimmer)] px-2 mb-2">
                  {NAVIGATION_SECTION_LABELS[section.id]}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {section.items.map((item) => {
                    const active = isRouteActive(pathname, item.href);
                    const style = navVisual(item.href);
                    return (
                      <div
                        key={item.href}
                        {...itemData({ ...item, effectiveSection: section.id }, active)}
                        className="group flex min-h-[44px] items-stretch rounded-xl border transition overflow-hidden"
                        style={{
                          borderColor: active ? style.accent : "var(--line-soft)",
                          background: active ? style.dim : "rgba(255,255,255,0.02)",
                          color: active ? style.accent : "var(--fg)",
                          opacity: item.status.status === "not-installed" ? 0.68 : 1,
                        }}
                        title={item.status.reason}
                      >
                        <Link href={item.href} aria-current={active ? "page" : undefined} className="min-h-[44px] min-w-0 flex-1 flex items-center gap-2.5 pl-3 pr-1 py-2.5">
                          <span className="shrink-0 grid place-items-center" style={{ color: active ? style.accent : "var(--fg-dim)" }}>{style.icon}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-medium truncate">{item.label}</span>
                            {item.status.status !== "ready" && (
                              <span className="block text-[8px] uppercase tracking-[0.08em] text-[var(--fg-dimmer)]">
                                {item.status.status === "checking" ? "Checking" : "Not installed"}
                              </span>
                            )}
                          </span>
                        </Link>
                        {item.status.status === "not-installed" && (
                          <button
                            type="button"
                            onClick={() => openSetupCenter(item.href)}
                            aria-label={`Set up ${item.label}`}
                            className="min-h-[44px] shrink-0 w-11 grid place-items-center"
                            style={{ color: "var(--gold)" }}
                          >
                            <PlugZap size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => navigation.toggleFavorite(item.href)}
                          aria-label={item.favorite ? `Remove ${item.label} from favorites` : `Add ${item.label} to favorites`}
                          aria-pressed={item.favorite}
                          className="min-h-[44px] shrink-0 w-11 grid place-items-center text-[var(--fg-dimmer)]"
                          style={{ color: item.favorite ? "var(--gold)" : undefined }}
                        >
                          <Star size={12} fill={item.favorite ? "currentColor" : "none"} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
          </ScrollArea>
        </div>
      )}

      <nav
        data-navigation-root="mobile-bar"
        data-nav-settled={String(navigation.settled)}
        data-nav-status-failed={String(navigation.statusFailed)}
        className="md:hidden !fixed bottom-0 left-0 right-0 z-40 border-t border-[var(--line-soft)]"
        style={{ background: "rgba(14,9,20,0.94)", backdropFilter: "blur(14px)", paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-stretch justify-around px-1 py-1.5">
          {home && (() => {
            const active = isRouteActive(pathname, home.href);
            const style = navVisual(home.href);
            return (
              <Link
                href={home.href}
                {...itemData({ ...home, effectiveSection: "workspace" }, active)}
                aria-current={active ? "page" : undefined}
                className="flex min-h-11 flex-col items-center justify-center gap-0.5 px-2 py-1 rounded-lg min-w-[56px]"
                style={{ color: active ? style.accent : "var(--fg-dim)", background: active ? style.dim : "transparent" }}
              >
                {style.icon}
                <span className="text-[9.5px] leading-none">Home</span>
              </Link>
            );
          })()}
          {navigation.mobileShortcuts.map((item) => {
            const active = isRouteActive(pathname, item.href);
            const style = navVisual(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                {...itemData(item, active)}
                aria-current={active ? "page" : undefined}
                className="flex min-h-11 flex-col items-center justify-center gap-0.5 px-2 py-1 rounded-lg min-w-[56px]"
                style={{ color: active ? style.accent : "var(--fg-dim)", background: active ? style.dim : "transparent" }}
              >
                {style.icon}
                <span className="text-[9.5px] leading-none max-w-[56px] truncate">{item.label.split(" ")[0]}</span>
              </Link>
            );
          })}
          <button
            onClick={() => setOpen("agents")}
            aria-label="Choose an agent"
            aria-expanded={open === "agents"}
            className="flex min-h-11 flex-col items-center justify-center gap-0.5 px-2 py-1 rounded-lg min-w-[56px]"
            style={{
              color: open === "agents" || onAgentPage ? "#d4a574" : "var(--fg-dim)",
              background: onAgentPage ? "rgba(212,165,116,0.16)" : "transparent",
            }}
          >
            <Network size={16} />
            <span className="text-[9.5px] leading-none">Agents</span>
          </button>
          <button
            onClick={() => setOpen("all")}
            aria-label="Open full menu"
            aria-expanded={open === "all"}
            className="flex min-h-11 flex-col items-center justify-center gap-0.5 px-2 py-1 rounded-lg min-w-[56px]"
            style={{ color: open === "all" ? "#d4a574" : "var(--fg-dim)" }}
          >
            <SlidersHorizontal size={16} />
            <span className="text-[9.5px] leading-none">Menu</span>
          </button>
        </div>
      </nav>
    </>
  );
}
