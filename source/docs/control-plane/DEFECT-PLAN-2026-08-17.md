# תוכנית תיקון — חמש התקלות מ-2026-08-17

## הקשר

משה דיווח על חמש תקלות בממשק. כולן אומתו בשרת production חי (port 3921) לפני כתיבת התוכנית,
ולכל אחת מצוינת סיבת שורש עם `file:line` — לא השערה.

**התמונה הגדולה:** שלוש מהתקלות (מודל `unknown`, Token usage, Live activity) הן **רגרסיה מאותה
משפחה**: Wave 1 הקפיא את הביצוע ו-Wave 3 העביר את ההרצות האמיתיות ל-durable control plane, אבל
משטחי הקריאה-בלבד (vitals, tokens, activity) נשארו מחוברים למקורות הנתונים הישנים. הנתונים זזו,
הצרכנים לא.

ראיות חיות (`GET` על שרת production):

```
/api/vitals   → claude: "Provider launch denied: launch_cwd_invalid"
                hermes: model "unknown", provider "unknown", raw "", latencyMs 3
                openclaw: raw "", gateway down
/api/tokens   → {"agents":[],"grand":{"calls":0,...,"costUsd":0}}
/api/activity → {"entries":[]}
```

---

## D1 — בדיקות הבריאות של הספקים נדחות (סיבת השורש של D2 וחלק מ-D7)

**תסמין:** כל הספקים מוצגים Offline/unknown, גם כשה-CLI עובד מצוין
(`hermes status` מדפיס בפועל `Model: deepseek/deepseek-v4-pro-0813`, `Provider: OpenRouter`).

**סיבת שורש:** `src/lib/runner.ts:190-215` דוחה כל אחד מחמשת הספקים המוגנים אלא אם `opts.cwd` הוא
`ApprovedLaunchDirectory`, ו-`assertRuntimeContainmentAvailable` (`src/lib/control-plane/runtimeContainment.ts:92-100`)
זורק תמיד ב-win32. `/api/vitals` קורא `run("hermes", ["status"])` ו-`run("claude", ["--version"])` בלי
cwd מאושר, ולכן הן נדחות **לפני spawn**. `latencyMs: 3` הוא ההוכחה: התהליך מעולם לא רץ.
זו רגרסיה של עבודת Wave 1 — probe לקריאה בלבד אינו execution, אבל הוא עובר באותו runner.

**תיקון:** מסלול probe מוצהר וצר ב-`runner.ts`:

- `probeProvider(provider, args)` חדש, שמותר במכוון, ועובר: `assertProviderLaunch` (זהות executable +
  denylist של דגלים), `buildProviderChildEnvironment` (env מינימלי), cwd בשליטת השרת
  (`ensureWorkspaceRootSync()`), בלי stdin ובלי prompt.
- **allowlist של argv לכל ספק** — `status`, `--version`, `doctor` בלבד. כל argv אחר נדחה.
- אין לקוח שמשפיע: הפרמטרים נבחרים בקוד השרת, לא מגוף בקשה.
- לחבר אליו את `/api/vitals` ואת ה-probes של Setup Center.

**קבצים:** `src/lib/runner.ts`, `src/app/api/vitals/route.ts`, `src/lib/setupRuntime.ts`.

**אימות:** `/api/vitals` מחזיר `hermes.model = "deepseek/deepseek-v4-pro-0813"`,
`hermes.provider = "OpenRouter"`, `claude.version = "2.1.233"`; spec חי שמאמת שה-probe דוחה argv שאינו
ב-allowlist ודוחה `--dangerously-*` ו-`--yolo`.

---

## D2 — בהרמס המודל מופיע `unknown`

**תסמין:** שדה המודל בהרמס מציג `unknown`.

**סיבת שורש:** נגזרת ישירה של D1. `src/app/api/vitals/route.ts:48-55` מפרסר `Model:\s+(\S+)` מתוך
`hermes.stdout`, וה-stdout ריק כי ה-probe נדחה. `src/components/desktop/useHermesDesktopData.ts:227`
גם קובע `model: "unknown"` כברירת מחדל בכשל.

**תיקון:** D1 פותר את המקור. בנוסף שתי הצהרות אמת:

- כשה-probe לא זמין — להציג `unavailable` עם הסיבה, לא `unknown`.
- fallback מסומן: לקרוא את המודל מקונפיגורציית הפרופיל (`hermesHome()/profiles/<name>/.env`) ולסמן אותו
  `configured, not verified` — לפי חוזה התוכנית ש-Configured אינו Ready.

**קבצים:** `src/app/api/vitals/route.ts`, `src/components/desktop/useHermesDesktopData.ts`,
`src/components/desktop/HermesDesktop.tsx`.

**אימות:** צילום מסך של הרמס עם המודל האמיתי; וכשעוצרים את ה-CLI — הכיתוב `unavailable` עם סיבה.

---

## D3 — בהרמס לא ניתן לפתוח צ'אט חדש ולנהל שיחה

**תסמין:** יצירת שיחה חדשה בהרמס לא מאפשרת לשלוח הודעות.

**סיבת שורש:** מכוון בשלב הזה. `POST /api/hermes/chat` מוקפא (`src/lib/control-plane/frozenExecutionRoutes.ts`),
ו-`useHermesDesktopData.ts:450` הוא הקורא היחיד. ה-composer בהרמס כבר מוחלף בהודעה שמסבירה זאת.
**פער אמת שנשאר:** הכפתור `+` ("New Hermes session", `HermesDesktop.tsx:288`) עדיין יוצר draft מקומי
שאי אפשר לשלוח ממנו לעולם.

**תיקון:** להשבית את `+` ולסמן אותו בסיבה המשותפת (`EXECUTION_FROZEN_COPY.controlTitle`) בזמן שהנתיב
מוקפא. שיחה אמיתית בהרמס נפתחת רק ב-Wave 5 (parity), ואין לפתוח אותה מוקדם.

**קבצים:** `src/components/desktop/HermesDesktop.tsx`.

**אימות:** הרחבת `tests/e2e/truthful-disabled-controls.spec.ts` — הכפתור מושבת ונושא סיבה.

---

## D4 — בקלוד קוד מוצג נתיב הפרויקט במקום שם התיקייה

**תסמין:** רשימת ה-Projects בקלוד מציגה `D:\משה פרוייקטים\פיתוח אתרים\...` במקום שם התיקייה, בשונה
מקודקס.

**סיבת שורש:** `src/lib/nativeAgentHistory.ts:803` — `label: cwd ?? group.label`, כאשר `cwd` הוא הנתיב
המוחלט מתוך ה-transcript. קודקס עושה את הדבר הנכון באותו קובץ: `path.basename(projectRoot)`
(שורה 767).

**תיקון:** `label: cwd ? path.basename(cwd) : group.label`, ולהשאיר את `root: cwd` לנתיב המלא
(tooltip/פרטים). **לא לגעת ב-`id`** — הוא משמש למצב ה-URL ולהתאמת identity
(`nativeAgentHistory.ts:860` משווה מול `group.id`, `group.root`, `group.label`), ולכן יש לוודא
שהשוואת ה-label שם לא נשברת. שני פרויקטים עם אותו basename מובדלים בשורה המשנית שמציגה את `root`.

**קבצים:** `src/lib/nativeAgentHistory.ts`, ובמידת הצורך `src/components/desktop/useClaudeDesktopData.ts:318,344`.

**אימות:** בדיקה שאין `\` או `/` ב-label של קבוצת קלוד, וצילום מסך של הרשימה.

---

## D5 — ה-X בהרמס לא פועל

**תסמין:** ה-X בראש ה-sidebar בהרמס נראה לחיץ ולא עושה כלום (התמונה של משה).

**סיבת שורש:** התנגשות CSS ב-`src/components/desktop/HermesDesktop.module.css`:

- שורה 113: `.closeDrawer { display: none }` — הכוונה: מוסתר בדסקטופ.
- שורה 533: הכלל המשותף `.sidebarBottom button, .closeDrawer { display: grid; … }` **דורס** אותו (אותה
  specificity, מופיע אחר כך) ולכן הכפתור מוצג גם בדסקטופ.
- שורה 1791: בתוך `@media (max-width: 900px)` יש `.closeDrawer { display: grid }` — החשיפה המכוונת
  לנייד, שהפכה מיותרת.

בדסקטופ ה-sidebar קבוע, ולכן `setDrawerOpen(false)` (`HermesDesktop.tsx:295`) לא משנה כלום ויזואלית.

**תיקון:** להוציא את `display` מהכלל המשותף ולהשאיר בו רק את הגדלים והצבעים; `display: grid` יינתן
ל-`.sidebarBottom button` בלבד. כך `.closeDrawer` נשאר `display:none` עד ה-media query.

**אימות:** הרחבת `tests/e2e/layout-contract.spec.ts` — ב-1440px הכפתור "Close navigation" אינו נראה,
וב-390px הוא נראה וסוגר את ה-drawer.

---

## D6 — Token usage לא מסונכרן עם המקורות המחוברים

**תסמין:** הפאנל מציג אפסים ואינו משקף מנוי קלוד, OpenRouter וכדומה.

**סיבת שורש:** שלוש שכבות:

1. המקור היחיד הוא `~/.agentic-os/token-usage.jsonl` דרך `logTokens()` (`src/lib/tokenLog.ts`), ו**הקורא
   היחיד** שנשאר הוא `src/app/api/claude/chat/route.ts:221` — נתיב **מוקפא**. כלומר שום דבר לא נכתב.
2. ה-durable control plane כבר אוסף שימוש אמיתי לכל run. באירוע ה-terminal של ההרצה החיה של קלוד היום
   נרשם: `{"turns":1,"totalCostUsd":0.027987,"inputTokens":2,"outputTokens":18,"cacheReadInputTokens":0,"cacheCreationInputTokens":2693}`.
   הנתון הזה לא מגיע ל-`/api/tokens`.
3. יתרות בצד הספק (קרדיט OpenRouter, מנוי קלוד) לא חוברו מעולם.

**תיקון בשלוש שכבות, בסדר הזה:**

1. **מדוד:** לגזור שימוש מ-ledger האירועים של Workbench (לפי provider / run / יום). נתון אמיתי, בלי
   להמציא.
2. **יתרות ספק כשיש API:** OpenRouter — `GET https://openrouter.ai/api/v1/credits` עם המפתח המוגדר.
   שימוש במנוי קלוד ובמנוי Codex אינו חשוף ב-API: להציג `not exposed by provider`, ולהראות את הודעת
   המגבלה של ה-CLI כשהיא קיימת (Codex מדפיס את זמן האיפוס, לקלוד יש `/usage` בתוך ה-CLI).
3. **תווית מקור לכל שורה:** `measured (control plane)` / `provider balance` / `not exposed`. אסור להציג
   אפס כאילו הוא עובדה.

**קבצים:** `src/lib/tokenLog.ts`, `src/app/api/tokens/route.ts`, `src/components/TokenUsage.tsx`,
ומקור חדש שקורא מ-`src/lib/workbench/store.ts`.

**אימות:** אחרי הרצה חיה, `/api/tokens` מציג את העלות והטוקנים של אותו run; עם מפתח OpenRouter מוגדר —
יתרה חיה; בלי מפתח — השורה אומרת "not configured".

---

## D7 — Live activity לא עובד

**תסמין:** הפאנל "Live activity · combined log stream" (`src/components/Overview.tsx:177`) ריק.

**סיבת שורש:** `/api/activity` מחזיר `{"entries":[]}` משלוש סיבות:

1. `src/lib/config.ts:277-280` — `hermesLogs` ברירת מחדל `hermesHome()/cache`, בעוד שהלוגים האמיתיים
   נמצאים ב-`hermesHome()/logs` (נמדד: 13 קבצי `.log`). התיקייה שנבדקת פשוט לא מכילה לוגים.
2. `~/.openclaw/logs` קיימת אבל **אפס** קבצי `.log`.
3. `src/app/api/activity/route.ts:9-12` מכיר שני agents בלבד (hermes, openclaw) ואינו קורא את ledger
   האירועים של Workbench — המקום שבו כל הפעילות האמיתית נמצאת אחרי Wave 3.

**תיקון:**

1. `hermesLogs` יעדיף `hermesHome()/logs` כשהיא קיימת, עם נפילה ל-`cache`.
2. להוסיף את ledger האירועים של Workbench כמקור ראשי (מעברי סטטוס, נסיונות ספק, ביטולים) עם תווית
   provider לכל שורה.
3. כשמקור חסר — לכתוב איזה נתיב נבדק, במקום פאנל ריק ששקר בשתיקה.

**קבצים:** `src/lib/config.ts`, `src/app/api/activity/route.ts`, `src/components/ActivityStream.tsx`.

**אימות:** אחרי הרצה חיה של קלוד, הפאנל מציג את מעברי הסטטוס שלה; בדיקת יחידה שמאמתת שפתרון תיקיית
הלוגים מעדיף `logs` קיימת.

---

## סדר עדיפויות

1. **D1** — רגרסיה שמשביתה את כל שכבת ה-vitals, ופותרת גם את D2 וחלק מ-D7. חייב allowlist ובדיקות,
   כי היא פותחת מחדש מסלול spawn.
2. **D5 + D4** — תיקונים קטנים וגלויים מאוד (CSS אחד, שורה אחת).
3. **D7** — מחזיר את הפאנל לחיים על נתונים אמיתיים.
4. **D6** — שלוש שכבות; השכבה הראשונה (מדידה מה-ledger) נותנת את רוב הערך.
5. **D3** — סימון אמת בלבד; שיחה אמיתית בהרמס נפתחת ב-Wave 5.

## כללי עבודה שנשמרים

- כל תיקון מקבל בדיקה אחת לפחות, ואין "בוצע" בלי אימות בפועל.
- D1 אינו מבטל את denylist הדגלים, את זהות ה-executable ואת ה-env המינימלי. probe לקריאה בלבד אינו
  היתר להרצה.
- לפני staging: לרענן `mutation-inventory.json` ואת `executionFrozenSurfaces.ts`, ולהריץ את
  `verify-wave1-execution-freeze.mjs`.
- שער Wave 3 נשאר חסום עד הרצת Codex חיה אחרי 2026-08-20 08:02. אין לפתוח Wave 4 לפניה.
