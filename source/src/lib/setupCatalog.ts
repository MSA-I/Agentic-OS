import { workspacePath } from "@/lib/workspaceRoot";

export type SetupCategory = "setup-required" | "broken" | "optional";
export type SetupGroup = "agents" | "models" | "orchestration" | "create" | "operations";
export type SetupActionKind = "connect" | "test" | "start" | "install" | "manual";
export type SetupActionAvailability = "automatic" | "manual";
export type SetupFieldType = "secret" | "path" | "text";
export type SetupRoute =
  | "/claude" | "/openclaw" | "/hermes" | "/codex" | "/freeclaude"
  | "/glm-code" | "/local" | "/engine" | "/ruflo" | "/higgsfield"
  | "/antigravity" | "/kimi" | "/glm" | "/jcode" | "/grok"
  | "/hy3-coder" | "/deepseek-coder" | "/muse-code" | "/opencode"
  | "/fusion" | "/sakana" | "/paperclip" | "/room" | "/loop"
  | "/opendesign" | "/video" | "/studio" | "/openmontage" | "/video-use"
  | "/music" | "/games" | "/apps" | "/thumbnails" | "/leads" | "/notebook"
  | "/omniroute";

export interface SetupActionField {
  id: string;
  label: string;
  type: SetupFieldType;
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface SetupActionDefinition {
  id: string;
  label: string;
  kind: SetupActionKind;
  description: string;
  availability: SetupActionAvailability;
  requiresConfirm: boolean;
  fields?: SetupActionField[];
  copyCommand?: string;
}

export interface SetupGuideDefinition {
  title: string;
  docId: string;
}

export interface SetupCatalogEntry {
  route: SetupRoute;
  title: string;
  category: SetupCategory;
  group: SetupGroup;
  summary: string;
  guide: SetupGuideDefinition;
  actions: SetupActionDefinition[];
}

export type SetupDiagnosticStatus = "ready" | "missing" | "warning" | "error";
export type SetupDiagnosticImpact = "required" | "alternative" | "optional";
export type SetupEvidence = "verified" | "configured";
export type SetupReadinessLevel = "verified" | "configured" | "partial" | "missing";

export interface SetupDiagnostic {
  id: string;
  label: string;
  status: SetupDiagnosticStatus;
  message: string;
  detail: string;
  impact: SetupDiagnosticImpact;
  alternativeGroup?: string;
  evidence: SetupEvidence;
}

export interface SetupReadiness {
  ready: boolean;
  level: SetupReadinessLevel;
  reason?: string;
}

export interface SetupEntryState extends SetupCatalogEntry {
  diagnostics: SetupDiagnostic[];
  readiness: SetupReadiness;
  guideMarkdown: string | null;
}

export interface SetupGetResponse {
  version: 1;
  checkedAt: string;
  entries: SetupEntryState[];
}

export interface SetupActionRequest {
  route: string;
  actionId: string;
  confirm?: true;
  values?: Record<string, string>;
}

export interface SetupActionResponse {
  ok: boolean;
  route: string;
  actionId: string;
  mode: "executed" | "manual";
  message: string;
  diagnostics?: SetupDiagnostic[];
  copyCommand?: string;
}

const testAction = (): SetupActionDefinition => ({
  id: "test",
  label: "בדיקה בטוחה",
  kind: "test",
  description: "בדיקת זמינות מקומית בלבד, ללא יצירת תוכן וללא חיוב ספק.",
  availability: "automatic",
  requiresConfirm: false,
});

const cliPathAction = (): SetupActionDefinition => ({
  id: "connect-cli-path",
  label: "חיבור קובץ CLI קיים",
  kind: "connect",
  description: "שומר ב-Agent OS נתיב לקובץ CLI קיים לאחר אימות שהוא קובץ אמיתי.",
  availability: "automatic",
  requiresConfirm: true,
  fields: [{
    id: "cliPath",
    label: "נתיב מלא לקובץ ההפעלה",
    type: "path",
    required: true,
    placeholder: "C:\\Tools\\agent.exe",
    help: "יש לבחור קובץ קיים. תיקיות ונתיבים יחסיים יידחו.",
  }],
});

const secretAction = (
  id: string,
  label: string,
  fieldId: string,
  fieldLabel: string,
  description: string,
): SetupActionDefinition => ({
  id,
  label,
  kind: "connect",
  description,
  availability: "automatic",
  requiresConfirm: true,
  fields: [{ id: fieldId, label: fieldLabel, type: "secret", required: true }],
});

const manualAction = (
  id: string,
  label: string,
  kind: "connect" | "start" | "install" | "manual",
  description: string,
  copyCommand?: string,
): SetupActionDefinition => ({
  id,
  label,
  kind,
  description,
  availability: "manual",
  requiresConfirm: false,
  copyCommand,
});

const automaticSystemAction = (
  id: string,
  label: string,
  kind: "start" | "install",
  description: string,
  copyCommand: string,
): SetupActionDefinition => ({
  id,
  label,
  kind,
  description,
  availability: "automatic",
  requiresConfirm: true,
  copyCommand,
});

const openRouterAction = (profile: "active" | "fusion" | "north-mini" = "active") =>
  secretAction(
    `connect-openrouter-${profile}`,
    "שמירת OpenRouter key",
    "apiKey",
    "OpenRouter API key",
    "המפתח יישמר בקובץ הסביבה שהרכיב קורא, ולא יוחזר בד response.",
  );

export const SETUP_CATALOG = [
  {
    route: "/claude", title: "Claude", category: "setup-required", group: "agents",
    summary: "חיבור Claude Code CLI והשלמת כניסת Claude בחשבון המשתמש.",
    guide: { title: "Agent CLIs", docId: "7-AGENT-CLIS.md" },
    actions: [testAction(), cliPathAction(), manualAction("login-manual", "כניסה ל-Claude", "connect", "הכניסה נפתחת בדפדפן ואינה מתבצעת אוטומטית.", "claude login"), manualAction("install-manual", "הוראות התקנה", "install", "הורד Claude Code מהאתר הרשמי של Anthropic.")],
  },
  {
    route: "/openclaw", title: "OpenClaw", category: "setup-required", group: "agents",
    summary: "חיבור OpenClaw CLI קיים; onboarding נשאר אינטראקטיבי.",
    guide: { title: "Agent CLIs", docId: "7-AGENT-CLIS.md" },
    actions: [
      testAction(),
      cliPathAction(),
      manualAction("onboard-manual", "OpenClaw onboarding", "connect", "הרץ את תהליך ה-onboarding הרשמי בטרמינל.", "openclaw onboard"),
      automaticSystemAction("start-gateway", "הפעלת OpenClaw Gateway", "start", "מפעיל את שירות ה-Gateway המוגדר באמצעות מנהל השירות של OpenClaw.", "openclaw gateway start"),
      manualAction("install-manual", "הוראות התקנה", "install", "התקן לפי מאגר OpenClaw הרשמי."),
    ],
  },
  {
    route: "/hermes", title: "Hermes", category: "setup-required", group: "agents",
    summary: "חיבור Hermes CLI והגדרת provider בפרופיל Hermes הפעיל.",
    guide: { title: "Hermes", docId: "4-HERMES.md" },
    actions: [testAction(), cliPathAction(), openRouterAction(), manualAction("install-manual", "התקנת Hermes", "install", "ב-Windows השתמש במתקין Hermes הרשמי; ב-Python environments פעל לפי המדריך.")],
  },
  {
    route: "/codex", title: "Codex", category: "setup-required", group: "agents",
    summary: "חיבור Codex CLI וכניסה לחשבון OpenAI המקומי.",
    guide: { title: "Agent CLIs", docId: "7-AGENT-CLIS.md" },
    actions: [testAction(), cliPathAction(), manualAction("login-manual", "כניסה ל-Codex", "connect", "הכניסה לחשבון מתבצעת מחוץ לאפליקציה.", "codex login"), manualAction("install-manual", "הוראות התקנה", "install", "התקן את Codex CLI מהמקור הרשמי של OpenAI.")],
  },
  {
    route: "/freeclaude", title: "Free Claude Code", category: "setup-required", group: "agents",
    summary: "בדיקת Claude CLI ו-gateway חינמי פעיל עבור שיחות ובנייה.",
    guide: { title: "Free Claude Code", docId: "5-FREE-CLAUDE-CODE.md" },
    actions: [
      testAction(), cliPathAction(),
      automaticSystemAction("install-omniroute", "התקנת OmniRoute", "install", "מתקין גרסה pinned של OmniRoute באמצעות npm.", "npm.cmd install -g omniroute@3.8.49"),
      automaticSystemAction("start-omniroute", "הפעלת OmniRoute", "start", "מפעיל את ה-gateway רק אם אינו מחזיר מודלים.", "omniroute"),
    ],
  },
  {
    route: "/glm-code", title: "GLM Code", category: "setup-required", group: "agents",
    summary: "בדיקת coding CLI או Ollama bridge וחיבור Ollama Cloud אופציונלי.",
    guide: { title: "GLM Code", docId: "27-GLM-CODE.md" },
    actions: [
      testAction(),
      secretAction("connect-ollama-cloud", "שמירת Ollama Cloud key", "apiKey", "OLLAMA_API_KEY", "נשמר ב-.env.local שה-GLM Code backend קורא לאחר restart."),
      automaticSystemAction("install-ollama", "התקנת Ollama", "install", "מתקין Ollama באמצעות winget.", "winget install --id Ollama.Ollama --exact --accept-package-agreements --accept-source-agreements --disable-interactivity"),
      automaticSystemAction("start-ollama", "הפעלת Ollama", "start", "מפעיל ollama serve אם השירות אינו מגיב.", "ollama serve"),
    ],
  },
  {
    route: "/local", title: "Local Models", category: "setup-required", group: "models",
    summary: "התקנה והפעלה של שירות Ollama המקומי.",
    guide: { title: "Hermes and local models", docId: "4-HERMES.md" },
    actions: [testAction(), automaticSystemAction("install-ollama", "התקנת Ollama", "install", "מתקין Ollama באמצעות winget.", "winget install --id Ollama.Ollama --exact --accept-package-agreements --accept-source-agreements --disable-interactivity"), automaticSystemAction("start-ollama", "הפעלת Ollama", "start", "מפעיל ollama serve אם השירות אינו מגיב.", "ollama serve")],
  },
  {
    route: "/engine", title: "Model Engine", category: "setup-required", group: "models",
    summary: "בדיקת Hermes CLI ושירות Ollama עבור Model Engine.",
    guide: { title: "Hermes and local models", docId: "4-HERMES.md" },
    actions: [testAction(), cliPathAction(), automaticSystemAction("install-ollama", "התקנת Ollama", "install", "מתקין Ollama באמצעות winget.", "winget install --id Ollama.Ollama --exact --accept-package-agreements --accept-source-agreements --disable-interactivity"), automaticSystemAction("start-ollama", "הפעלת Ollama", "start", "מפעיל ollama serve אם השירות אינו מגיב.", "ollama serve")],
  },
  {
    route: "/ruflo", title: "Ruflo", category: "setup-required", group: "orchestration",
    summary: "חיבור Ruflo CLI קיים; התקנה נשארת מודרכת עד לאימות package רשמי.",
    guide: { title: "Agent CLIs", docId: "7-AGENT-CLIS.md" },
    actions: [testAction(), cliPathAction(), manualAction("install-manual", "התקנת Ruflo", "install", "פעל לפי הוראות Ruflo הרשמיות והפעל Test לאחר מכן.")],
  },
  {
    route: "/higgsfield", title: "Higgsfield", category: "setup-required", group: "create",
    summary: "רישום Higgsfield MCP בפרופיל Hermes והשלמת OAuth בדפדפן.",
    guide: { title: "Higgsfield", docId: "40-HIGGSFIELD.md" },
    actions: [
      testAction(),
      { id: "connect-higgsfield", label: "רישום Higgsfield MCP", kind: "connect", description: "רושם endpoint קבוע של Higgsfield בפרופיל Hermes הפעיל דרך ה-CLI.", availability: "automatic", requiresConfirm: true },
      manualAction("login-manual", "כניסה ל-Higgsfield", "connect", "OAuth נפתח בדפדפן ודורש אישור משתמש.", "hermes mcp login higgsfield"),
    ],
  },
  {
    route: "/antigravity", title: "Antigravity", category: "setup-required", group: "agents",
    summary: "חיבור CLI של Google Antigravity ממיקום קיים במחשב.",
    guide: { title: "Agent CLIs", docId: "7-AGENT-CLIS.md" },
    actions: [testAction(), cliPathAction(), manualAction("install-manual", "הוראות התקנה", "install", "התקן לפי ההוראות הרשמיות של Google Antigravity.")],
  },
  {
    route: "/kimi", title: "Kimi Code", category: "setup-required", group: "agents",
    summary: "חיבור Kimi Code CLI והשלמת OAuth באופן ידני בדפדפן.",
    guide: { title: "Kimi Code", docId: "16-KIMI-CODE.md" },
    actions: [testAction(), cliPathAction(), manualAction("login-manual", "התחברות ל-Kimi", "connect", "OAuth דורש אישור בדפדפן.", "kimi login"), manualAction("install-manual", "הוראות התקנה", "install", "הורד את Kimi Code מהאתר הרשמי.")],
  },
  {
    route: "/glm", title: "GLM 5.2", category: "setup-required", group: "models",
    summary: "חיבור API key של Z.AI לפרופיל GLM הייעודי.",
    guide: { title: "Extra Models", docId: "17-EXTRA-MODELS.md" },
    actions: [testAction(), secretAction("connect-glm", "שמירת GLM key", "apiKey", "GLM API key", "נשמר כ-GLM_API_KEY בפרופיל glm-5-2.")],
  },
  {
    route: "/jcode", title: "jcode", category: "setup-required", group: "agents",
    summary: "סוכן Rust קטן המשתמש בהתחברות הקיימת של Claude.",
    guide: { title: "jcode", docId: "39-JCODE.md" },
    actions: [testAction(), manualAction("install-manual", "התקנה ידנית", "install", "התקן מהמאגר הרשמי והשלם consent בטרמינל.", "jcode")],
  },
  {
    route: "/grok", title: "Grok Build", category: "setup-required", group: "agents",
    summary: "חיבור Grok Build CLI והתחברות device-auth של המשתמש.",
    guide: { title: "Grok Build", docId: "18-GROK-BUILD.md" },
    actions: [testAction(), cliPathAction(), manualAction("login-manual", "התחברות ל-Grok", "connect", "התחברות לחשבון X מתבצעת מחוץ לאפליקציה.", "grok login --device-auth"), manualAction("install-manual", "הוראות התקנה", "install", "התקן לפי הוראות xAI הרשמיות.")],
  },
  {
    route: "/hy3-coder", title: "HY3 Coder", category: "setup-required", group: "models",
    summary: "חיבור OpenRouter עבור מסלול HY3 Coder.",
    guide: { title: "HY3 Coder", docId: "31-HY3-CODER.md" },
    actions: [testAction(), openRouterAction()],
  },
  {
    route: "/deepseek-coder", title: "DeepSeek Coder", category: "setup-required", group: "models",
    summary: "חיבור DeepSeek API key לקובץ הסביבה שה-agent קורא.",
    guide: { title: "DeepSeek Coder", docId: "37-DEEPSEEK-CODER.md" },
    actions: [testAction(), secretAction("connect-deepseek", "שמירת DeepSeek key", "apiKey", "DeepSeek API key", "נשמר כ-DEEPSEEK_API_KEY בסביבת Free Claude.")],
  },
  {
    route: "/muse-code", title: "Muse Code", category: "setup-required", group: "models",
    summary: "חיבור OpenRouter עבור Muse Code.",
    guide: { title: "Muse Code", docId: "41-MUSE-CODE.md" },
    actions: [testAction(), openRouterAction()],
  },
  {
    route: "/opencode", title: "OpenCode", category: "setup-required", group: "agents",
    summary: "זיהוי OpenCode CLI מקומי והתחברות ספקים אופציונלית.",
    guide: { title: "OpenCode", docId: "34-OPENCODE.md" },
    actions: [
      testAction(),
      cliPathAction(),
      {
        id: "connect-omniroute-provider",
        label: "חיבור OmniRoute ל-OpenCode",
        kind: "connect",
        description: "מוסיף provider מקומי ל-config של OpenCode בלי לדרוס providers או מודלים קיימים.",
        availability: "automatic",
        requiresConfirm: true,
      },
      automaticSystemAction("install-opencode", "התקנת OpenCode", "install", "מתקין גרסת OpenCode מאומתת ו-pinned באמצעות npm הקיים.", "npm.cmd install -g opencode-ai@1.18.16"),
      manualAction("auth-manual", "חיבור ספק", "connect", "התחברות לספק מתבצעת ב-CLI.", "opencode auth login"),
    ],
  },
  {
    route: "/fusion", title: "Fusion", category: "setup-required", group: "models",
    summary: "חיבור OpenRouter לפרופיל Fusion.",
    guide: { title: "Extra Models", docId: "17-EXTRA-MODELS.md" },
    actions: [testAction(), openRouterAction("fusion")],
  },
  {
    route: "/sakana", title: "Sakana Fugu", category: "setup-required", group: "models",
    summary: "חיבור Sakana API key לפרופיל Fugu.",
    guide: { title: "Extra Models", docId: "17-EXTRA-MODELS.md" },
    actions: [testAction(), secretAction("connect-sakana", "שמירת Sakana key", "apiKey", "Sakana API key", "נשמר כ-SAKANA_API_KEY בפרופיל sakana-fugu.")],
  },
  {
    route: "/paperclip", title: "Paperclip", category: "setup-required", group: "orchestration",
    summary: "חיבור company id ובדיקת שרת Paperclip מקומי.",
    guide: { title: "Paperclip", docId: "6-PAPERCLIP.md" },
    actions: [
      testAction(),
      {
        id: "connect-company", label: "שמירת company id", kind: "connect",
        description: "נשמר כ-PAPERCLIP_COMPANY ב-.env.local של Agent OS ודורש restart.",
        availability: "automatic", requiresConfirm: true,
        fields: [{ id: "companyId", label: "Paperclip company id", type: "text", required: true, help: "אותיות, מספרים, נקודה, קו תחתון או מקף בלבד." }],
      },
      manualAction("install-manual", "Onboarding ידני", "install", "Onboarding יוצר state ומפעיל שירות ולכן אינו רץ אוטומטית.", "npx.cmd paperclipai onboard --yes"),
    ],
  },
  {
    route: "/room", title: "Agent Room", category: "setup-required", group: "orchestration",
    summary: "חיבור OpenRouter עבור סוכני החדר שאינם מקומיים.",
    guide: { title: "Extra Models", docId: "17-EXTRA-MODELS.md" },
    actions: [testAction(), openRouterAction()],
  },
  {
    route: "/loop", title: "Loop Engineering", category: "setup-required", group: "orchestration",
    summary: "חיבור builder אחד לפחות (MiniMax, Nous או OpenRouter), Ollama כ-judge מקומי ו-Chromium לבדיקת render.",
    guide: { title: "Loop Engineering", docId: "19-LOOP-ENGINEERING.md" },
    actions: [
      testAction(),
      openRouterAction(),
      manualAction("connect-nous", "חיבור Nous Portal", "connect", "מריץ device-code OAuth אינטראקטיבי ושומר את credential ב-auth.json של Hermes. לאחר הסיום חזור לכאן והפעל בדיקה.", "hermes portal"),
      manualAction("connect-minimax", "חיבור MiniMax", "connect", "מריץ OAuth אינטראקטיבי ושומר minimax-oauth בפרופיל Hermes הפעיל. זהו builder/judge חלופי ל-OpenRouter.", "hermes auth add minimax-oauth"),
      automaticSystemAction("install-ollama", "התקנת Ollama", "install", "מתקין Ollama באמצעות winget בפקודה קבועה ומאושרת.", "winget install --id Ollama.Ollama --exact --accept-package-agreements --accept-source-agreements --disable-interactivity"),
      automaticSystemAction("start-ollama", "הפעלת Ollama", "start", "מפעיל ollama serve רק אם השירות המקומי עדיין אינו מגיב.", "ollama serve"),
      manualAction("pull-loop-model", "הורדת מודל ל-judge המקומי", "install", "Ollama פעיל עדיין צריך מודל. זו ברירת המחדל שה-Loop מבקש כש-LOCAL_MODEL אינו מוגדר; ההורדה עשויה להיות גדולה.", "ollama pull xentriom/gemma-4-12B-coder-fable5-composer2.5-v1"),
      automaticSystemAction("install-browser", "התקנת Chromium לבדיקה", "install", "מתקין גרסת Chromium pinned ב-cache של Playwright תחת LocalAppData, שם ה-Loop מאתר אותה לבדיקת render.", "npx.cmd --yes playwright@1.51.1 install chromium"),
    ],
  },
  {
    route: "/opendesign", title: "Open Design", category: "setup-required", group: "create",
    summary: "בדיקת repository ושני שירותי Open Design המקומיים.",
    guide: { title: "Open Design", docId: "21-OPEN-DESIGN.md" },
    actions: [testAction(), manualAction("install-manual", "התקנה ידנית", "install", "ההתקנה דורשת clone ו-pnpm; הפקודות נמצאות במדריך."), manualAction("start-manual", "הפעלה ידנית", "start", "ה-launcher הנוכחי אינו בטוח להפעלה אוטומטית ב-Windows.")],
  },
  {
    route: "/video", title: "Video Studio", category: "setup-required", group: "create",
    summary: "בדיקת HyperFrames, ffmpeg וחיבור ספקי HeyGen ו-ElevenLabs.",
    guide: { title: "Video Studio", docId: "12-VIDEO-STUDIO.md" },
    actions: [
      testAction(),
      secretAction("connect-heygen", "שמירת HeyGen key", "apiKey", "HeyGen API key", "נשמר בקובץ heygen.env שה-video backend קורא."),
      secretAction("connect-elevenlabs", "שמירת ElevenLabs key", "apiKey", "ElevenLabs API key", "נשמר בפרופיל Hermes הפעיל."),
      automaticSystemAction("install-ffmpeg", "התקנת ffmpeg", "install", "מתקין ffmpeg באמצעות winget בפקודה קבועה ומאושרת.", "winget install --id Gyan.FFmpeg --exact --accept-package-agreements --accept-source-agreements --disable-interactivity"),
    ],
  },
  {
    route: "/studio", title: "Media Studio", category: "setup-required", group: "create",
    summary: "חיבור MiniMax, Grok/xAI או ElevenLabs בפרופיל Hermes הפעיל, ובדיקת Python runtime של Hermes עבור Grok.",
    guide: { title: "Video Studio", docId: "12-VIDEO-STUDIO.md" },
    actions: [
      testAction(),
      manualAction("check-hermes-runtime", "בדיקת Hermes Python ב-Windows", "manual", "Grok בלבד מריץ את Python של Hermes מהנתיב HERMES_HOME\\hermes-agent\\.venv\\Scripts\\python.exe. אל תיצור venv ריק: הוא חייב לכלול את מודולי hermes-agent.", "hermes doctor"),
      manualAction("repair-hermes-runtime", "עדכון Hermes runtime", "install", "אם Hermes doctor מדווח שה-runtime חסר, עדכן דרך מנגנון Hermes הרשמי ואז הפעל מחדש את Agent OS.", "hermes update"),
      manualAction("connect-minimax", "חיבור MiniMax", "connect", "OAuth נפתח מחוץ לאפליקציה ונשמר כ-minimax-oauth בפרופיל Hermes הפעיל.", "hermes auth add minimax-oauth"),
      manualAction("connect-grok", "חיבור Grok / xAI", "connect", "OAuth נפתח מחוץ לאפליקציה ונשמר כ-xai-oauth בפרופיל Hermes הפעיל; מסלול זה דורש גם את Hermes Python runtime.", "hermes auth add xai-oauth"),
      secretAction("connect-elevenlabs", "שמירת ElevenLabs key", "apiKey", "ElevenLabs API key", "נשמר ב-.env של פרופיל Hermes הפעיל ומשמש למסלול voice בלבד."),
    ],
  },
  {
    route: "/openmontage", title: "OpenMontage", category: "broken", group: "create",
    summary: "חסום: cinematic_om.py ו-movie_om.py אינם כלולים ב-pack ואין עבורם מקור התקנה מאומת.",
    guide: { title: "OpenMontage", docId: "26-OPENMONTAGE.md" },
    actions: [
      testAction(),
      manualAction("missing-generation-scripts", "שני scripts חסרים", "manual", "ה-runtime דורש cinematic_om.py וגם movie_om.py תחת HERMES_HOME\\profiles\\openmontage\\workspace\\scripts. אין לשני הקבצים מקור התקנה מאומת בריפו או ב-pack, ולכן אין כאן פקודת הורדה מומצאת."),
      openRouterAction(),
      automaticSystemAction("install-python", "התקנת Python", "install", "מתקין Python 3.12 באמצעות winget בפקודה קבועה ומאושרת.", "winget install --id Python.Python.3.12 --exact --accept-package-agreements --accept-source-agreements --disable-interactivity"),
      automaticSystemAction("install-ffmpeg", "התקנת ffmpeg", "install", "מתקין ffmpeg באמצעות winget בפקודה קבועה ומאושרת.", "winget install --id Gyan.FFmpeg --exact --accept-package-agreements --accept-source-agreements --disable-interactivity"),
    ],
  },
  {
    route: "/video-use", title: "Video Editor", category: "setup-required", group: "create",
    summary: "חסום כרגע: ה-video-use skill ומקור התקנה מאומת שלו אינם כלולים ב-pack.",
    guide: { title: "Video Editor", docId: "33-VIDEO-EDITOR.md" },
    actions: [
      testAction(),
      manualAction("missing-skill", "video-use skill חסר", "manual", "ה-runtime דורש %USERPROFILE%\\.claude\\skills\\video-use\\SKILL.md, אך ה-skill ומקור התקנה מאומת שלו אינם קיימים בריפו או ב-pack. אין כאן URL או פקודת התקנה מומצאים."),
      automaticSystemAction("install-ffmpeg", "התקנת ffmpeg", "install", "מתקין את חבילת Gyan.FFmpeg הכוללת ffmpeg ו-ffprobe באמצעות winget.", "winget install --id Gyan.FFmpeg --exact --accept-package-agreements --accept-source-agreements --disable-interactivity"),
    ],
  },
  {
    route: "/music", title: "Music Studio", category: "setup-required", group: "create",
    summary: "חיבור Suno API key ללא הפעלת generation.",
    guide: { title: "Music Studio", docId: "14-MUSIC-STUDIO.md" },
    actions: [testAction(), secretAction("connect-suno", "שמירת Suno key", "apiKey", "Suno API key", "נשמר ב-suno.env שה-music backend קורא.")],
  },
  {
    route: "/games", title: "Game Studio", category: "setup-required", group: "create",
    summary: "הכנת Hermes CLI, kanban.db, פרופיל game-dev, board בשם game-studio ותיקיית המשחקים.",
    guide: { title: "Game Studio", docId: "13-GAME-STUDIO.md" },
    actions: [
      testAction(),
      manualAction("init-kanban", "אתחול Kanban database", "install", "יוצר kanban.db אם הוא חסר; הפקודה idempotent ואינה מוחקת board קיים.", "hermes kanban init"),
      manualAction("create-games-workspace", "יצירת Games workspace", "install", "יוצר את התיקייה המדויקת שה-gallery וה-commission route קוראים ב-Windows.", `New-Item -ItemType Directory -Force -LiteralPath "${workspacePath("games")}"`),
      manualAction("create-game-profile", "יצירת פרופיל game-dev", "install", "מריץ רק אם hermes profile list אינו מציג game-dev. הפרופיל משוכפל מהפרופיל הפעיל כדי לשמור provider/skills, ומקבל תיאור המשמש את ה-Kanban router.", 'hermes profile create game-dev --clone --description "Build complete self-contained browser games in the assigned workspace."'),
      manualAction("create-game-board", "יצירת board בשם game-studio", "install", "מריץ רק אם hermes kanban boards list אינו מציג game-studio. שם ה-board חייב להתאים בדיוק ל-route של Game Studio.", `hermes kanban boards create game-studio --name "Game Studio" --default-workdir "${workspacePath("games")}"`),
    ],
  },
  {
    route: "/apps", title: "App Lab", category: "broken", group: "create",
    summary: "נדרשים upstream repo, שלושה adaptation files שאינם ב-pack, שלושה Windows venvs וחיבור OpenRouter.",
    guide: { title: "App Lab", docId: "35-APP-LAB.md" },
    actions: [
      testAction(),
      openRouterAction("north-mini"),
      automaticSystemAction("install-python", "התקנת Python ל-App Lab", "install", "מתקין Python 3.12 באמצעות winget בפקודה קבועה ומאושרת; נדרש לפני יצירת ה-venvs.", "winget install --id Python.Python.3.12 --exact --accept-package-agreements --accept-source-agreements --disable-interactivity"),
      manualAction("clone-upstream", "שכפול awesome-llm-apps", "install", "משכפל את upstream repository לנתיב המדויק שה-App Lab קורא. ה-clone לבדו אינו כולל את שלושת קובצי ה-adaptation של Agent OS.", `git clone https://github.com/Shubhamsaboo/awesome-llm-apps "${workspacePath("app-lab", "awesome-llm-apps")}"`),
      manualAction("missing-adaptations", "שלושה adaptation files חסרים", "manual", "ה-runtime דורש free_mixture_of_agents.py, free_web_chat.py ו-free_travel_agent.py בנתיבים המוגדרים ב-appslab.ts. הם אינם קיימים בריפו הזה ואינם חלק מ-upstream; אין מקור מאומת להורדה ולכן אין פקודת התקנה."),
      manualAction("create-moa-venv", "יצירת venv ל-Mixture of Agents", "install", "יוצר את Windows venv שה-diagnostic מצפה לו; יש להריץ רק לאחר שה-repository קיים.", `py -m venv "${workspacePath("app-lab", "awesome-llm-apps", "starter_ai_agents", "mixture_of_agents", ".venv")}"`),
      manualAction("create-web-chat-venv", "יצירת venv ל-Web Chat", "install", "יוצר את Windows venv שה-diagnostic מצפה לו; dependencies מדויקים תלויים בקובץ ה-adaptation החסר.", `py -m venv "${workspacePath("app-lab", "awesome-llm-apps", "rag_tutorials", "llama3.1_local_rag", ".venv")}"`),
      manualAction("create-travel-venv", "יצירת venv ל-Travel Planner", "install", "יוצר את Windows venv שה-diagnostic מצפה לו; dependencies מדויקים תלויים בקובץ ה-adaptation החסר.", `py -m venv "${workspacePath("app-lab", "awesome-llm-apps", "starter_ai_agents", "ai_travel_agent", ".venv")}"`),
    ],
  },
  {
    route: "/thumbnails", title: "Thumbnail Studio", category: "setup-required", group: "create",
    summary: "העתקת שני scripts הכלולים ב-pack, התקנת Python/Pillow וחיבור OpenAI ב-Windows.",
    guide: { title: "Thumbnail Studio", docId: "10-THUMBNAIL-STUDIO.md" },
    actions: [
      testAction(),
      {
        id: "install-local-scripts",
        label: "התקנת scripts מה-pack",
        kind: "install",
        description: "מעתיק באופן allowlisted רק את generate.py ו-text_overlay.py הקיימים ב-extras\\thumbnail-generator אל %USERPROFILE%\\.claude\\skills\\youtube-thumbnails\\scripts. אם קובץ יעד קיים ושונה, הפעולה נעצרת ואינה דורסת אותו.",
        availability: "automatic",
        requiresConfirm: true,
      },
      automaticSystemAction("install-python", "התקנת Python", "install", "מתקין Python 3.12 באמצעות winget בפקודה קבועה ומאושרת אם Python launcher חסר.", "winget install --id Python.Python.3.12 --exact --accept-package-agreements --accept-source-agreements --disable-interactivity"),
      automaticSystemAction("install-pillow", "התקנת Pillow", "install", "מתקין גרסה pinned של Pillow למשתמש הנוכחי באמצעות Python launcher קיים.", "py -m pip install --user Pillow==12.3.0"),
      secretAction("connect-openai", "שמירת OpenAI key", "apiKey", "OpenAI API key", "נשמר מקומית ב-%USERPROFILE%\\.claude\\skills\\youtube-thumbnails\\.env ואינו מוחזר בתגובה."),
    ],
  },
  {
    route: "/leads", title: "Lead Engine", category: "setup-required", group: "operations",
    summary: "חיבור Hunter, Apollo ו-OpenRouter ללא חיפוש או scoring אוטומטי.",
    guide: { title: "Leads", docId: "22-LEADS.md" },
    actions: [
      testAction(),
      secretAction("connect-hunter", "שמירת Hunter key", "apiKey", "Hunter API key", "נשמר בפרופיל Hermes הפעיל."),
      secretAction("connect-apollo", "שמירת Apollo key", "apiKey", "Apollo API key", "נשמר בפרופיל Hermes הפעיל."),
      openRouterAction(),
    ],
  },
  {
    route: "/notebook", title: "NotebookLM", category: "setup-required", group: "operations",
    summary: "חיבור notebooklm-mcp קיים והשלמת login בדפדפן.",
    guide: { title: "NotebookLM", docId: "15-NOTEBOOKLM.md" },
    actions: [testAction(), cliPathAction(), manualAction("login-manual", "התחברות ל-NotebookLM", "connect", "Login לחשבון Google מתבצע מחוץ לאפליקציה.", "nlm login"), automaticSystemAction("install-notebooklm", "התקנת NotebookLM MCP", "install", "מתקין גרסה pinned של notebooklm-mcp-cli באמצעות uv קיים.", "uv tool install notebooklm-mcp-cli==0.9.8")],
  },
  {
    route: "/omniroute", title: "OmniRoute Diagnostics", category: "optional", group: "models",
    summary: "אבחון, התקנה והפעלה של ה-gateway המקומי המשמש את Free AI Coder, Free Claude ו-Codex.",
    guide: { title: "OmniRoute", docId: "28-OMNIROUTE.md" },
    actions: [
      testAction(),
      automaticSystemAction("install-omniroute", "התקנת OmniRoute", "install", "מתקין גרסה pinned של OmniRoute באמצעות npm הקיים.", "npm.cmd install -g omniroute@3.8.49"),
      automaticSystemAction("start-omniroute", "הפעלת OmniRoute", "start", "מפעיל את gateway המקומי רק אם הוא עדיין אינו מחזיר מודלים.", "omniroute"),
    ],
  },
] satisfies readonly SetupCatalogEntry[];

const catalogByRoute = new Map<string, SetupCatalogEntry>(
  SETUP_CATALOG.map((entry) => [entry.route, entry]),
);

export function getSetupEntry(route: string): SetupCatalogEntry | null {
  return catalogByRoute.get(route) ?? null;
}

export function getSetupAction(route: string, actionId: string): SetupActionDefinition | null {
  return getSetupEntry(route)?.actions.find((action) => action.id === actionId) ?? null;
}
