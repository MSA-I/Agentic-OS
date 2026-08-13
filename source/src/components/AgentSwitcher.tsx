"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Bot, Check, ChevronUp, Command, Home, X } from "lucide-react";

const agents = [
  { id: "codex", label: "Codex", detail: "Sessions and review" },
  { id: "claude", label: "Claude", detail: "Sessions and panes" },
  { id: "hermes", label: "Hermes", detail: "Profiles and skills" },
  { id: "openclaw", label: "OpenClaw", detail: "Actors and conversations" },
  { id: "antigravity", label: "Antigravity", detail: "Artifacts and subagents" },
] as const;

const missionControl = { id: "home", label: "Mission Control", detail: "Home and system overview" } as const;

export type CoreAgentId = (typeof agents)[number]["id"];

export default function AgentSwitcher() {
  const pathname = usePathname();
  const router = useRouter();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const current = agents.find((agent) => pathname === `/${agent.id}`) ?? missionControl;

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.current;
    const menu = menuRef.current;
    const focusable = () => Array.from(menu?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
    focusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [open]);

  function choose(agentId: CoreAgentId) {
    setOpen(false);
    if (agentId !== current.id) router.push(`/${agentId}`);
  }

  function chooseHome() {
    setOpen(false);
    if (pathname !== "/") router.push("/");
  }

  return (
    <div data-agent-switcher data-open={open ? "true" : "false"}>
      {open && (
        <>
          <button
            className="agent-switcher-backdrop"
            type="button"
            aria-label="Close agent switcher"
            onClick={() => setOpen(false)}
          />
          <div
            ref={menuRef}
            className="agent-switcher-menu"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <div className="agent-switcher-heading">
              <div>
                <strong id={titleId}>Switch agent</strong>
                <span>Each agent keeps separate projects and history.</span>
              </div>
              <button type="button" aria-label="Close agent switcher" onClick={() => setOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <button
              className="agent-switcher-home"
              type="button"
              data-selected={current.id === missionControl.id ? "true" : "false"}
              aria-current={current.id === missionControl.id ? "page" : undefined}
              onClick={chooseHome}
            >
              <span className="agent-switcher-home-mark" aria-hidden="true"><Home size={15} /></span>
              <span className="agent-switcher-copy">
                <strong>Home</strong>
                <span>Mission Control and system overview</span>
              </span>
              {current.id === missionControl.id && <Check size={15} aria-label="Current page" />}
            </button>
            <div className="agent-switcher-options">
              {agents.map((agent) => {
                const selected = agent.id === current.id;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    data-selected={selected ? "true" : "false"}
                    aria-current={selected ? "page" : undefined}
                    onClick={() => choose(agent.id)}
                  >
                    <span className="agent-switcher-mark" aria-hidden="true">{agent.label.slice(0, 1)}</span>
                    <span className="agent-switcher-copy">
                      <strong>{agent.label}</strong>
                      <span>{agent.detail}</span>
                    </span>
                    {selected && <Check size={15} aria-label="Current agent" />}
                  </button>
                );
              })}
            </div>
            <div className="agent-switcher-shortcut"><Command size={13} /> Ctrl Shift A</div>
          </div>
        </>
      )}
      <a
        className="agent-switcher-home-control"
        href="/"
        aria-label="Mission Control"
        aria-current={current.id === missionControl.id ? "page" : undefined}
        title="Mission Control"
        onClick={() => setOpen(false)}
      >
        <Home size={16} aria-hidden="true" />
      </a>
      <button
        ref={triggerRef}
        className="agent-switcher-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Switch agent. Current agent: ${current.label}`}
        title={`Switch agent · ${current.label} · Ctrl+Shift+A`}
        onClick={() => setOpen((value) => !value)}
      >
        {current.id === missionControl.id ? <Home size={16} aria-hidden="true" /> : <Bot size={16} aria-hidden="true" />}
        <span><small>Agent</small><strong>{current.label}</strong></span>
        <ChevronUp size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
