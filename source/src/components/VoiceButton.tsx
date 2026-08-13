"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Mic, MicOff } from "lucide-react";

// Web Speech API has no first-class TS types in lib.dom — type loosely.
type SR = {
  start: () => void;
  stop: () => void;
  abort: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string; isFinal?: boolean }>> & { length: number } }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

interface Props {
  onTranscript: (text: string, opts: { final: boolean }) => void;
  className?: string;
  size?: number;
  disabled?: boolean;
}

// Shared voice→input wiring: append final transcripts to a text state, showing
// a live "[voice] …" interim marker while speaking. Same behaviour as the
// UnifiedChat composer, packaged so every chat box wires the mic identically:
//   const handleVoice = useVoiceToInput(setInput);
//   <VoiceButton onTranscript={handleVoice} size={34} />
export function useVoiceToInput(setText: (updater: (prev: string) => string) => void) {
  const interimRef = useRef("");
  return (t: string, opts: { final: boolean }) => {
    setText((prev) => {
      const base = interimRef.current ? prev.replace(/\s*\[voice\][^]*$/, "") : prev;
      if (opts.final) {
        interimRef.current = "";
        return (base + (base.endsWith(" ") || base.length === 0 ? "" : " ") + t).trim();
      }
      interimRef.current = t;
      return `${base}${base.length ? " " : ""}[voice] ${t}`.trim();
    });
  };
}

export default function VoiceButton({ onTranscript, className = "", size = 36, disabled = false }: Props) {
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SR | null>(null);

  useEffect(() => {
    const C = (typeof window !== "undefined" && ((window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR }).SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => SR }).webkitSpeechRecognition)) as undefined | { new(): SR };
    setSupported(!!C);
  }, []);

  useEffect(() => {
    if (!disabled) return;
    try { recRef.current?.abort(); } catch {}
    setActive(false);
  }, [disabled]);

  function start() {
    if (disabled) return;
    setError(null);
    const C = (typeof window !== "undefined" && ((window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR }).SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => SR }).webkitSpeechRecognition)) as undefined | { new(): SR };
    if (!C) { setError("Voice not supported in this browser. Use Chrome or Safari."); return; }
    const rec = new C();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-GB";
    let lastFinal = 0;
    rec.onresult = (e) => {
      let interim = "";
      let finalText = "";
      for (let i = lastFinal; i < e.results.length; i++) {
        const r = e.results[i][0];
        if ((e.results[i] as unknown as { isFinal?: boolean }).isFinal) {
          finalText += r.transcript;
          lastFinal = i + 1;
        } else {
          interim += r.transcript;
        }
      }
      if (finalText) onTranscript(finalText.trim(), { final: true });
      else if (interim) onTranscript(interim.trim(), { final: false });
    };
    rec.onerror = (e) => { setError(e.error || "voice error"); setActive(false); };
    rec.onend = () => setActive(false);
    recRef.current = rec;
    try { rec.start(); setActive(true); } catch (e) { setError(String(e)); }
  }

  function stop() {
    try { recRef.current?.stop(); } catch {}
    setActive(false);
  }

  if (supported === false) {
    return (
      <button
        title="Voice input requires Chrome or Safari"
        disabled
        className={`grid place-items-center rounded-lg border border-[var(--panel-border)] text-[var(--fg-dimmer)] opacity-50 cursor-not-allowed ${className}`}
        style={{ width: size, height: size }}
      >
        <MicOff size={size * 0.45} />
      </button>
    );
  }

  return (
    <>
      <motion.button
        onClick={active ? stop : start}
        disabled={disabled}
        whileTap={{ scale: 0.92 }}
        title={disabled ? "Voice input is unavailable for this read-only conversation" : active ? "Stop recording (or finish speaking)" : "Speak to type"}
        className={`relative grid place-items-center rounded-lg border transition disabled:cursor-not-allowed disabled:opacity-45 ${className}`}
        style={{
          width: size, height: size,
          borderColor: active ? "rgba(248,113,113,0.6)" : "var(--panel-border)",
          background: active ? "rgba(248,113,113,0.12)" : "transparent",
          color: active ? "#f87171" : "var(--fg-dim)",
        }}
      >
        <Mic size={size * 0.45} />
        {active && (
          <>
            <span
              className="absolute inset-0 rounded-lg pointer-events-none"
              style={{
                animation: "mic-ring 1.4s ease-out infinite",
              }}
            />
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-rose-400 shadow-[0_0_8px_#f87171]" />
          </>
        )}
        <style jsx>{`
          @keyframes mic-ring {
            0%   { box-shadow: 0 0 0 0 rgba(248,113,113,0.45); }
            70%  { box-shadow: 0 0 0 12px rgba(248,113,113,0); }
            100% { box-shadow: 0 0 0 0 rgba(248,113,113,0); }
          }
        `}</style>
      </motion.button>
      {error && <span className="text-[10px] text-rose-300 ml-2">{error}</span>}
    </>
  );
}
