// Sensitive prompt, transcript, and draft state must never be written to
// localStorage, sessionStorage, IndexedDB, or workspace files. These maps keep
// state available while the current browser document is alive and disappear on
// refresh/restart by design. Session ids, pins, and non-sensitive preferences
// remain outside this module and may use their existing persistent storage.

const volatileText = new Map<string, string>();
const volatileValues = new Map<string, unknown>();
const LEGACY_SENSITIVE_PREFIXES = [
  "agentic-os/codex/history/v1",
  "agentic-os:codex:draft:v3:",
  "agent-os:workbench:draft:v1:",
  "agentic-os-chat-v3:",
  "agentic-os-chat-draft-v1:",
  "agentic-os:ultracode:draft:v1",
] as const;

export function purgeLegacySensitiveBrowserState(): void {
  if (typeof window === "undefined") return;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key && LEGACY_SENSITIVE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage access is optional; current content still remains volatile only.
  }
}

export function readVolatileText(key: string): string {
  return volatileText.get(key) ?? "";
}

export function writeVolatileText(key: string, value: string): void {
  if (value) volatileText.set(key, value);
  else volatileText.delete(key);
}

export function readVolatileValue<T>(key: string): T | undefined {
  return volatileValues.get(key) as T | undefined;
}

export function writeVolatileValue<T>(key: string, value: T): void {
  volatileValues.set(key, value);
}

export function clearVolatileValue(key: string): void {
  volatileValues.delete(key);
  volatileText.delete(key);
}
