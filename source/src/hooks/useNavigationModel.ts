"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  defaultNavigationPreferences,
  LEGACY_HIDDEN_KEY,
  LEGACY_ORDER_KEY,
  migrateLegacyNavigation,
  NAVIGATION_BY_HREF,
  NAVIGATION_ITEMS,
  NAVIGATION_SECTIONS,
  NAVIGATION_STORAGE_KEY,
  sanitizeNavigationPreferences,
  type EffectiveNavigationSection,
  type NavigationDefinition,
  type NavigationPreferencesV2,
  type NavigationStatus,
} from "@/lib/navigation";

export interface NavigationModelItem extends NavigationDefinition {
  status: NavigationStatus;
  favorite: boolean;
  hidden: boolean;
  effectiveSection: EffectiveNavigationSection;
}

export interface NavigationModelSection {
  id: EffectiveNavigationSection;
  items: NavigationModelItem[];
}

interface StatusSnapshot {
  statuses: Record<string, NavigationStatus>;
  settled: boolean;
  failed: boolean;
}

const defaultPreferences = defaultNavigationPreferences();
let preferencesSnapshot = defaultPreferences;
let preferencesLoaded = false;
let storageListenerInstalled = false;
const preferenceListeners = new Set<() => void>();

const initialStatuses: Record<string, NavigationStatus> = Object.fromEntries(
  NAVIGATION_ITEMS.map((entry) => [entry.href, { status: "checking" }]),
);
let statusSnapshot: StatusSnapshot = { statuses: initialStatuses, settled: false, failed: false };
const serverStatusSnapshot: StatusSnapshot = statusSnapshot;
let statusProbeStarted = false;
const statusListeners = new Set<() => void>();

function emitPreferences() {
  for (const listener of preferenceListeners) listener();
}

function emitStatus() {
  for (const listener of statusListeners) listener();
}

function subscribePreferences(listener: () => void) {
  preferenceListeners.add(listener);
  return () => preferenceListeners.delete(listener);
}

function subscribeStatus(listener: () => void) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function loadPreferencesFromStorage(): NavigationPreferencesV2 {
  try {
    const saved = localStorage.getItem(NAVIGATION_STORAGE_KEY);
    if (saved) return sanitizeNavigationPreferences(JSON.parse(saved));
    const legacyOrder = JSON.parse(localStorage.getItem(LEGACY_ORDER_KEY) || "null");
    const legacyHidden = JSON.parse(localStorage.getItem(LEGACY_HIDDEN_KEY) || "null");
    return migrateLegacyNavigation(legacyOrder, legacyHidden);
  } catch {
    return defaultNavigationPreferences();
  }
}

function ensurePreferencesLoaded() {
  if (preferencesLoaded || typeof window === "undefined") return;
  preferencesLoaded = true;
  preferencesSnapshot = loadPreferencesFromStorage();
  try { localStorage.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify(preferencesSnapshot)); } catch { /* ignore */ }
  emitPreferences();

  if (!storageListenerInstalled) {
    storageListenerInstalled = true;
    window.addEventListener("storage", (event) => {
      if (event.key !== NAVIGATION_STORAGE_KEY || !event.newValue) return;
      try {
        preferencesSnapshot = sanitizeNavigationPreferences(JSON.parse(event.newValue));
        emitPreferences();
      } catch { /* ignore malformed cross-tab state */ }
    });
  }
}

function commitPreferences(next: NavigationPreferencesV2) {
  preferencesSnapshot = sanitizeNavigationPreferences(next);
  try { localStorage.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify(preferencesSnapshot)); } catch { /* ignore */ }
  emitPreferences();
}

function updatePreferences(mutator: (current: NavigationPreferencesV2) => NavigationPreferencesV2) {
  commitPreferences(mutator(preferencesSnapshot));
}

function normalizeStatus(value: unknown): NavigationStatus | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { status?: unknown; installed?: unknown; reason?: unknown };
  const status = raw.status === "ready" || raw.status === "not-installed"
    ? raw.status
    : typeof raw.installed === "boolean"
      ? raw.installed ? "ready" : "not-installed"
      : null;
  if (!status) return null;
  return {
    status,
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
  };
}

async function refreshStatusProbe() {
  fetch("/api/navigation-status", { cache: "no-store" })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("navigation status unavailable")))
    .then((payload: { settled?: boolean; statuses?: Record<string, unknown> }) => {
      const statuses = { ...initialStatuses };
      let incomplete = false;
      for (const entry of NAVIGATION_ITEMS) {
        const normalized = normalizeStatus(payload.statuses?.[entry.href]);
        if (normalized) statuses[entry.href] = normalized;
        else incomplete = true;
      }
      statusSnapshot = { statuses, settled: payload.settled !== false, failed: incomplete };
      emitStatus();
    })
    .catch(() => {
      statusSnapshot = { statuses: initialStatuses, settled: true, failed: true };
      emitStatus();
    })
    .finally(() => {
      if (typeof window !== "undefined") window.setTimeout(refreshStatusProbe, 60_000);
    });
}

function startStatusProbe() {
  if (statusProbeStarted || typeof window === "undefined") return;
  statusProbeStarted = true;
  void refreshStatusProbe();
}

function ordered(items: NavigationModelItem[], preferred: string[]): NavigationModelItem[] {
  const rank = new Map(preferred.map((href, index) => [href, index]));
  const fallback = new Map(NAVIGATION_ITEMS.map((entry, index) => [entry.href, index]));
  return [...items].sort((a, b) =>
    (rank.get(a.href) ?? 100_000 + (fallback.get(a.href) ?? 0))
    - (rank.get(b.href) ?? 100_000 + (fallback.get(b.href) ?? 0))
  );
}

export function useNavigationModel(options: { includeHidden?: boolean } = {}) {
  const preferences = useSyncExternalStore(
    subscribePreferences,
    () => preferencesSnapshot,
    () => defaultPreferences,
  );
  const statusState = useSyncExternalStore(
    subscribeStatus,
    () => statusSnapshot,
    () => serverStatusSnapshot,
  );

  useEffect(() => {
    ensurePreferencesLoaded();
    startStatusProbe();
  }, []);

  const allItems = useMemo<NavigationModelItem[]>(() => NAVIGATION_ITEMS.map((entry) => {
    const status = statusState.statuses[entry.href] ?? { status: "checking" };
    const favorite = preferences.favorites.includes(entry.href);
    const hidden = preferences.hidden.includes(entry.href);
    const effectiveSection: EffectiveNavigationSection = status.status === "not-installed"
      ? "not-installed"
      : favorite
        ? "favorites"
        : entry.section;
    return { ...entry, status, favorite, hidden, effectiveSection };
  }), [preferences, statusState.statuses]);

  const sections = useMemo<NavigationModelSection[]>(() => NAVIGATION_SECTIONS.map((id) => {
    const preferred = id === "favorites" ? preferences.favorites : preferences.orderBySection[id];
    const items = ordered(
      allItems.filter((entry) => entry.effectiveSection === id && (options.includeHidden || !entry.hidden)),
      preferred,
    );
    return { id, items };
  }).filter((section) => section.items.length > 0), [allItems, options.includeHidden, preferences]);

  const agentSections = useMemo<NavigationModelSection[]>(() => {
    const agents = allItems.filter((entry) => entry.section === "agents" && !entry.hidden);
    return (["agents", "not-installed"] as const).map((id) => ({
      id,
      items: ordered(
        agents.filter((entry) => id === "not-installed"
          ? entry.status.status === "not-installed"
          : entry.status.status !== "not-installed"),
        preferences.orderBySection[id],
      ),
    })).filter((section) => section.items.length > 0);
  }, [allItems, preferences.orderBySection]);

  const mobileShortcuts = useMemo(() => {
    const candidates = [...preferences.favorites, "/claude", "/memory"];
    const seen = new Set<string>(["/"]);
    const out: NavigationModelItem[] = [];
    for (const href of candidates) {
      if (seen.has(href)) continue;
      seen.add(href);
      const entry = allItems.find((candidate) => candidate.href === href);
      if (!entry || entry.hidden || entry.status.status !== "ready") continue;
      out.push(entry);
      if (out.length === 2) break;
    }
    return out;
  }, [allItems, preferences.favorites]);

  const toggleFavorite = useCallback((href: string) => {
    if (!NAVIGATION_BY_HREF.has(href)) return;
    updatePreferences((current) => {
      const exists = current.favorites.includes(href);
      const favorites = exists ? current.favorites.filter((route) => route !== href) : [...current.favorites, href];
      return {
        ...current,
        favorites,
        hidden: current.hidden.filter((route) => route !== href),
        orderBySection: { ...current.orderBySection, favorites },
      };
    });
  }, []);

  const toggleHidden = useCallback((href: string) => {
    if (!NAVIGATION_BY_HREF.has(href)) return;
    updatePreferences((current) => {
      const hiding = !current.hidden.includes(href);
      const favorites = hiding ? current.favorites.filter((route) => route !== href) : current.favorites;
      return {
        ...current,
        favorites,
        hidden: hiding ? [...current.hidden, href] : current.hidden.filter((route) => route !== href),
        orderBySection: { ...current.orderBySection, favorites },
      };
    });
  }, []);

  const moveItem = useCallback((from: string, to: string | "__end__", section: EffectiveNavigationSection) => {
    const currentSection = sections.find((entry) => entry.id === section);
    if (!currentSection || !currentSection.items.some((entry) => entry.href === from)) return;
    const routes = currentSection.items.map((entry) => entry.href).filter((href) => href !== from);
    const index = to === "__end__" ? routes.length : routes.indexOf(to);
    routes.splice(index < 0 ? routes.length : index, 0, from);
    updatePreferences((current) => {
      if (section === "favorites") {
        const favorites = [...routes, ...current.favorites.filter((href) => !routes.includes(href))];
        return { ...current, favorites, orderBySection: { ...current.orderBySection, favorites } };
      }
      const prior = current.orderBySection[section];
      const next = [...routes, ...prior.filter((href) => !routes.includes(href))];
      return { ...current, orderBySection: { ...current.orderBySection, [section]: next } };
    });
  }, [sections]);

  const reset = useCallback(() => commitPreferences(defaultNavigationPreferences()), []);

  return {
    sections,
    agentSections,
    allItems,
    mobileShortcuts,
    settled: statusState.settled,
    statusFailed: statusState.failed,
    preferences,
    toggleFavorite,
    toggleHidden,
    moveItem,
    reset,
  };
}
