export type NativeNavigationSection = "workspace" | "agents" | "orchestration" | "create" | "operate";
export type EffectiveNavigationSection = "favorites" | NativeNavigationSection | "not-installed";
export type NavigationStatusKind = "checking" | "ready" | "not-installed";

export interface NavigationDefinition {
  href: string;
  label: string;
  section: NativeNavigationSection;
  dependency: boolean;
}

export interface NavigationStatus {
  status: NavigationStatusKind;
  reason?: string;
}

export interface NavigationPreferencesV2 {
  version: 2;
  favorites: string[];
  hidden: string[];
  orderBySection: Record<EffectiveNavigationSection, string[]>;
}

export const NAVIGATION_STORAGE_KEY = "agentos.navigation.v2";
export const LEGACY_ORDER_KEY = "agentos.sidebar.order";
export const LEGACY_HIDDEN_KEY = "agentos.sidebar.hidden";

export const NAVIGATION_SECTIONS: readonly EffectiveNavigationSection[] = [
  "favorites",
  "workspace",
  "orchestration",
  "agents",
  "create",
  "operate",
  "not-installed",
];

export const NAVIGATION_SECTION_LABELS: Record<EffectiveNavigationSection, string> = {
  favorites: "Favorites",
  workspace: "Workspace",
  agents: "Agents",
  orchestration: "Orchestration",
  create: "Create",
  operate: "Operate",
  "not-installed": "Not installed",
};

const item = (
  href: string,
  label: string,
  section: NativeNavigationSection,
  dependency = false,
): NavigationDefinition => ({ href, label, section, dependency });

export const NAVIGATION_ITEMS: readonly NavigationDefinition[] = [
  item("/", "Mission Control", "workspace"),

  item("/claude", "Claude", "agents", true),
  item("/openclaw", "OpenClaw", "agents", true),
  item("/hermes", "Hermes", "agents", true),
  item("/antigravity", "Antigravity", "agents", true),
  item("/codex", "Codex", "agents", true),
  item("/kimi", "Kimi Code", "agents", true),
  item("/glm", "GLM 5.2", "agents", true),
  item("/glm-code", "GLM Code", "agents", true),
    item("/graphify", "Graphify", "agents", true),
    item("/jcode", "jcode", "agents", true),
  item("/grok", "Grok Build", "agents", true),
  item("/freeclaude", "Free Claude Code", "agents", true),
  item("/omniroute", "Free AI Coder", "agents", true),
  item("/hy3-coder", "Hy3 Coder", "agents", true),
  item("/deepseek-coder", "DeepSeek Coder", "agents", true),
  item("/muse-code", "Muse Code", "agents", true),
  item("/opencode", "opencode", "agents", true),
  item("/fusion", "Fusion", "agents", true),
  item("/sakana", "Sakana Fugu", "agents", true),
  item("/local", "Local", "agents", true),
  item("/engine", "Model Engine", "agents", true),

  item("/paperclip", "Paperclip", "orchestration"),
  item("/room", "AI Agent Mastermind", "orchestration"),
  item("/pipeline", "Pipeline", "orchestration"),
  item("/agent-kanban", "Agent Kanban", "orchestration"),
  item("/loop", "Loop", "orchestration"),
  item("/ruflo", "Ruflo", "orchestration", true),

  item("/higgsfield", "Higgsfield", "create", true),
  item("/opendesign", "Open Design", "create"),
  item("/video", "Video", "create"),
  item("/studio", "Media Studio", "create"),
  item("/openmontage", "OpenMontage", "create"),
  item("/video-use", "Video Editor", "create"),
  item("/music", "Music", "create", true),
  item("/games", "Game Studio", "create"),
  item("/apps", "App Lab", "create"),
  item("/thumbnails", "Thumbnails", "create"),

  item("/leads", "Leads", "operate"),
  item("/seo", "SEO", "operate"),
  item("/notebook", "Notebook", "operate", true),
  item("/kanban", "Kanban", "operate"),
  item("/memory", "Memory", "operate"),
  item("/goals", "Goals", "operate"),
  item("/journal", "Journal", "operate"),
] as const;

export const NAVIGATION_BY_HREF: ReadonlyMap<string, NavigationDefinition> = new Map(
  NAVIGATION_ITEMS.map((entry) => [entry.href, entry]),
);

export const DEPENDENCY_ROUTES = new Set(
  NAVIGATION_ITEMS.filter((entry) => entry.dependency).map((entry) => entry.href),
);

const emptyOrder = (): Record<EffectiveNavigationSection, string[]> => ({
  favorites: [],
  workspace: [],
  agents: [],
  orchestration: [],
  create: [],
  operate: [],
  "not-installed": [],
});

export function defaultNavigationPreferences(): NavigationPreferencesV2 {
  const orderBySection = emptyOrder();
  for (const entry of NAVIGATION_ITEMS) orderBySection[entry.section].push(entry.href);
  return { version: 2, favorites: [], hidden: [], orderBySection };
}

function validUniqueRoutes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((route): route is string => {
    if (typeof route !== "string" || !NAVIGATION_BY_HREF.has(route) || seen.has(route)) return false;
    seen.add(route);
    return true;
  });
}

function completeSectionOrder(
  section: EffectiveNavigationSection,
  saved: unknown,
  fallback: string[],
): string[] {
  const valid = validUniqueRoutes(saved).filter((href) => {
    if (section === "favorites" || section === "not-installed") return true;
    return NAVIGATION_BY_HREF.get(href)?.section === section;
  });
  return [...valid, ...fallback.filter((href) => !valid.includes(href))];
}

export function sanitizeNavigationPreferences(value: unknown): NavigationPreferencesV2 {
  const defaults = defaultNavigationPreferences();
  if (!value || typeof value !== "object") return defaults;
  const raw = value as Partial<NavigationPreferencesV2>;
  const favorites = validUniqueRoutes(raw.favorites);
  const hidden = validUniqueRoutes(raw.hidden).filter((href) => !favorites.includes(href));
  const orderBySection = emptyOrder();
  for (const section of NAVIGATION_SECTIONS) {
    const fallback = section === "favorites"
      ? favorites
      : section === "not-installed"
        ? NAVIGATION_ITEMS.map((entry) => entry.href)
        : defaults.orderBySection[section];
    orderBySection[section] = completeSectionOrder(section, raw.orderBySection?.[section], fallback);
  }
  return { version: 2, favorites, hidden, orderBySection };
}

export function migrateLegacyNavigation(orderValue: unknown, hiddenValue: unknown): NavigationPreferencesV2 {
  const defaults = defaultNavigationPreferences();
  const legacyOrder = validUniqueRoutes(orderValue);
  const globalOrder = [...legacyOrder, ...NAVIGATION_ITEMS.map((entry) => entry.href).filter((href) => !legacyOrder.includes(href))];
  for (const section of NAVIGATION_SECTIONS) {
    if (section === "favorites") continue;
    defaults.orderBySection[section] = globalOrder.filter((href) => {
      if (section === "not-installed") return true;
      return NAVIGATION_BY_HREF.get(href)?.section === section;
    });
  }
  defaults.hidden = validUniqueRoutes(hiddenValue);
  return defaults;
}
