"use client";

import { motion } from "framer-motion";

export type AgentKey = "claude" | "openclaw" | "hermes" | "gemini" | "antigravity" | "fcc" | "codex" | "kimi" | "glm" | "grok";

interface Props {
  agent: AgentKey;
  size?: number;
  pulse?: boolean;
}

const STYLE: Record<AgentKey, {
  accent: string;
  bg: string;
  gradient: string;
  label: string;
  glyph: (size: number) => React.ReactNode;
}> = {
  claude: {
    accent: "#d97757",
    bg: "rgba(217,119,87,0.18)",
    gradient: "#D97757",
    label: "Claude",
    glyph: (s) => (
      <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2 L13.6 9 L21 10.4 L13.6 12.4 L12 22 L10.4 12.4 L3 10.4 L10.4 9 Z"
          fill="white"
          opacity="0.95"
        />
      </svg>
    ),
  },
  openclaw: {
    accent: "#F5654A",
    bg: "rgba(245,101,74,0.18)",
    gradient: "#F5654A",
    label: "OpenClaw",
    glyph: (s) => (
      // Stylized claw mark
      <svg width={s * 0.6} height={s * 0.6} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round">
        <path d="M5 4 C 8 8, 8 14, 5 19" opacity="0.95" />
        <path d="M11 3 C 14 7, 14 16, 11 21" opacity="0.95" />
        <path d="M17 5 C 19 9, 19 15, 17 20" opacity="0.95" />
      </svg>
    ),
  },
  hermes: {
    accent: "#EDFF45",
    bg: "rgba(237,255,69,0.18)",
    gradient: "#0000F2",
    label: "Hermes",
    glyph: (s) => (
      // Caduceus-style wing mark
      <svg width={s * 0.6} height={s * 0.6} viewBox="0 0 24 24" fill="none">
        <path
          d="M12 3 L12 21 M12 5 C 8 8, 6 7, 4 5 C 6 9, 9 10, 12 9 C 15 10, 18 9, 20 5 C 18 7, 16 8, 12 5"
          stroke="white"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.95"
        />
        <circle cx="12" cy="3" r="1.2" fill="white" opacity="0.95" />
      </svg>
    ),
  },
  gemini: {
    // Google's Gemini palette — blue/red/yellow/green sweep + the four-pointed star glyph.
    accent: "#4285F4",
    bg: "rgba(66,133,244,0.18)",
    gradient: "#1F2853",
    label: "Gemini",
    glyph: (s) => (
      <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24" fill="none">
        <path
          d="M12 4 L13 10 L18 12 L13 14 L12 20 L11 14 L6 12 L11 10 Z"
          fill="white"
          opacity="0.98"
        />
      </svg>
    ),
  },
  fcc: {
    // Free Claude Code = the open-source proxy sibling. Green/emerald gradient to
    // signal "free", with a stylised owl glyph (the default upstream is Owl Alpha).
    accent: "#10b981",
    bg: "rgba(16,185,129,0.18)",
    gradient: "#176B4D",
    label: "Free Claude Code",
    glyph: (s) => (
      <svg width={s * 0.62} height={s * 0.62} viewBox="0 0 24 24" fill="none">
        {/* Owl silhouette: two big round eyes + small triangle beak + ear tufts */}
        <path
          d="M5 4 L7 7 M19 4 L17 7"
          stroke="white" strokeWidth="1.6" strokeLinecap="round" opacity="0.95"
        />
        <circle cx="9" cy="11" r="3.2" fill="white" opacity="0.95" />
        <circle cx="15" cy="11" r="3.2" fill="white" opacity="0.95" />
        <circle cx="9" cy="11" r="1.2" fill="#065f46" />
        <circle cx="15" cy="11" r="1.2" fill="#065f46" />
        <path
          d="M11 14 L12 16 L13 14 Z"
          fill="white" opacity="0.9"
        />
        <path
          d="M6 17 C 8 19, 16 19, 18 17"
          stroke="white" strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.85"
        />
      </svg>
    ),
  },
  codex: {
    // Codex (OpenAI) — onyx/charcoal gradient + open-spiral mark (riff on the
    // OpenAI logo without copying it). Sits visually between Claude and Gemini.
    accent: "#6867AA",
    bg: "rgba(104,103,170,0.18)",
    gradient: "#10101A",
    label: "Codex",
    glyph: (s) => (
      <svg width={s * 0.62} height={s * 0.62} viewBox="0 0 24 24" fill="none">
        {/* Six-petal rosette à la OpenAI mark, rendered with thin strokes */}
        <g stroke="white" strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.96">
          <path d="M12 4 C 16 6, 16 10, 12 12 C 8 10, 8 6, 12 4 Z" />
          <path d="M19 8.5 C 19 12.5, 16 14.5, 12 12 C 12.5 8, 15.5 6.5, 19 8.5 Z" />
          <path d="M19 15.5 C 16 18, 13 16.5, 12 12 C 16 11, 18.5 12.5, 19 15.5 Z" />
          <path d="M12 20 C 8 18, 8 14, 12 12 C 16 14, 16 18, 12 20 Z" />
          <path d="M5 15.5 C 5.5 12.5, 8.5 11, 12 12 C 11 16.5, 8 18, 5 15.5 Z" />
          <path d="M5 8.5 C 8 6.5, 11.5 8, 12 12 C 8 14.5, 5 12.5, 5 8.5 Z" />
        </g>
      </svg>
    ),
  },
  kimi: {
    // Kimi Code (Moonshot AI) — cyan/teal gradient + sharp "K" monogram.
    accent: "#00CCFF",
    bg: "rgba(0,204,255,0.18)",
    gradient: "#236778",
    label: "Kimi Code",
    glyph: (s) => (
      <svg width={s * 0.62} height={s * 0.62} viewBox="0 0 24 24" fill="none">
        <path d="M7 4 L7 20 M17 4 L7 12 L17 20" stroke="white" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" opacity="0.96" />
      </svg>
    ),
  },
  glm: {
    // GLM-5.2 (Zhipu / z.ai) — emerald/teal gradient + "G" monogram.
    accent: "#34E5B0",
    bg: "rgba(52,229,176,0.18)",
    gradient: "#176B4D",
    label: "GLM 5.2",
    glyph: (s) => (
      <svg width={s * 0.62} height={s * 0.62} viewBox="0 0 24 24" fill="none">
        <text x="12" y="17.5" textAnchor="middle" fontSize="15" fontWeight="800" fill="white" fontFamily="ui-sans-serif, system-ui, sans-serif">G</text>
      </svg>
    ),
  },
  grok: {
    // Grok Build (xAI) — monochrome slate→silver gradient + the angular xAI "X" mark.
    accent: "#cdd3f7",
    bg: "rgba(205,211,247,0.18)",
    gradient: "#303A58",
    label: "Grok 4.5",
    glyph: (s) => (
      <svg width={s * 0.58} height={s * 0.58} viewBox="0 0 24 24" fill="none">
        <path d="M6.5 5 L17.5 19 M17.5 5 L6.5 19" stroke="white" strokeWidth="2.2" strokeLinecap="round" opacity="0.96" />
      </svg>
    ),
  },
  antigravity: {
    // Antigravity = the "deep-space" sibling. Indigo + violet gradient with an orbital ring.
    accent: "#7c3aed",
    bg: "rgba(124,58,237,0.18)",
    gradient: "#1F2853",
    label: "Antigravity",
    glyph: (s) => (
      <svg width={s * 0.62} height={s * 0.62} viewBox="0 0 24 24" fill="none">
        {/* Inverted-gravity arrow shooting up out of a planet's surface */}
        <ellipse cx="12" cy="18.5" rx="7.5" ry="2.4" fill="none" stroke="white" strokeWidth="1.2" opacity="0.55" />
        <path
          d="M12 3 L12 17 M12 3 L9 6.5 M12 3 L15 6.5"
          stroke="white"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.98"
        />
        <circle cx="12" cy="3" r="1.3" fill="white" opacity="0.98" />
      </svg>
    ),
  },
};

export default function AgentAvatar({ agent, size = 36, pulse = false }: Props) {
  // Unknown/missing agent ids (e.g. from an imported conversation) must never
  // crash the view — fall back to a neutral style instead.
  const s = STYLE[agent] ?? {
    gradient: "#1F2853",
    accent: "#a59783",
    label: String(agent || "agent"),
    icon: null,
  };
  return (
    <motion.span
      initial={{ scale: 0.96, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      whileHover={{ scale: 1.02 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="relative inline-grid place-items-center rounded-full overflow-hidden shrink-0"
      style={{
        width: size,
        height: size,
        background: s.gradient,
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.28)",
        outline: pulse ? `2px solid ${s.accent}` : undefined,
        outlineOffset: pulse ? 2 : undefined,
      }}
      role="img"
      aria-label={s.label}
    >
      {s.glyph(size)}
    </motion.span>
  );
}

export function agentColor(agent: AgentKey): string {
  return STYLE[agent].accent;
}
export function agentBg(agent: AgentKey): string {
  return STYLE[agent].bg;
}
export function agentLabel(agent: AgentKey): string {
  return STYLE[agent].label;
}
