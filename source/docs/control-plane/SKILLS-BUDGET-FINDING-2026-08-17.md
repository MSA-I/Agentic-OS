# ממצא: תקציב ה-skills של Codex — קלט ל-Wave 7

תאריך: 2026-08-17 · רמת ראיה: `live-runtime` (נמדד מול ה-CLI המותקן)

## התסמין

כל הפעלה של Codex — כולל הפילוט של Wave 3 — מדפיסה:

```
Exceeded skills context budget of 2%. All skill descriptions were removed
and 3756 additional skills were not included in the model-visible skills list.
```

כלומר Codex מתחיל כל שיחה **בלי אף תיאור skill**. זה לא נוגע להרצות של AGENT-OS עצמו: המתאם ב-
`src/lib/workbench/providers/codex.ts:37` שולח `skills.config=[]` ממילא. זה פוגע בשימוש האינטראקטיבי.

## מה נמדד

| מדד | ערך |
|---|---|
| `~/.agents/skills` | 2,371 תיקיות · 181MB |
| `~/.codex/skills` | 2,254 תיקיות · 60MB |
| `~/.claude/skills` | 2,365 תיקיות · 180MB |
| חפיפה codex ∩ agents | 2,130 (85%) |
| איחוד codex ∪ agents | 2,495 |
| סך תיאורי ה-skills בשני השורשים | 646KB ≈ 161,000 טוקנים |

תקציב של 2% מחלון ההקשר הוא סדר גודל של אלפי טוקנים בודדים. התיאורים לבדם גדולים ממנו בערך פי 20,
ולכן Codex מוחק את כולם.

## איזה שורש באמת נספר

נמדד בשיטה שלא דורשת קריאת מודל: אזהרת התקציב נכתבת בתחילת ה-session, לפני הקריאה לספק, ולכן היא
מודדת שינויים גם כשהקוואטה חסומה.

**מדידה ראשונה, שהייתה מטעה:** הוספת skill בודד ותקין ל-`~/.codex/skills` או ל-`~/.claude/skills`
לא שינתה את הספירה, בעוד שתיקון שלושה קבצים שבורים ב-`~/.agents/skills` העלה אותה 3753 → 3756.
מכאן הוסק בטעות ש-Codex קורא רק את `~/.agents/skills`.

**מדידה בתפזורת, שהיא הנכונה:**

| פעולה | ספירה |
|---|---|
| מצב התחלתי | 3,756 |
| אחרי ארכוב `~/.codex/skills` בשלמותו | **1,770** |
| אחרי הסרת `~/.agents/skills` בנוסף | **אין אזהרה כלל** |

כלומר `~/.codex/skills` תרם כ-1,986 skills — הוא בהחלט נספר. הסמן הבודד לא זז ככל הנראה בגלל cache
של אינדקס ה-skills; רק שינוי בתפזורת חושף את התמונה. **לקח: מדידה של פריט בודד אינה מדידה של מקור.**

## מה `skills.config` כן ולא עושה

הסכימה התגלתה אמפירית מול הפרסר (`--strict-config` דוחה מפתח לא מוכר לפני כל קריאת מודל):

```toml
[[skills.config]]
name = "..."      # אופציונלי
path = "..."      # אופציונלי
enabled = true    # חובה
```

`skills.enabled`, `skills.roots`, `skills.sources`, `skills.max_count`,
`skills.context_budget_percent` ו-`features.skills` — **כולם נדחים** כשדות לא מוכרים. שדה לא מוכר
בתוך רשומה נדחה גם הוא (`skills.config.0.bogus_field`).

וחשוב מכך — אף אחד מאלה לא שינה את אזהרת התקציב:

| override | ספירה |
|---|---|
| ללא override | 3756 |
| `skills.config=[]` | 3756 |
| `skills.config=[{name="_default",enabled=false}]` | 3756 |
| `skills.config=[{name="_default",enabled=false},{name="seo",enabled=true}]` | 3756 |
| `skills.config=[{name="*",enabled=false}]` | 3756 |

כלומר `skills.config` מדליק ומכבה skills בודדים, אבל **אינו מצמצם את המניה** ואינו פותר את התקציב.
המנוף היחיד שנמדד כעובד הוא מספר ה-skills שקיימים בפועל במקורות שנמנים.

## מה כבר תוקן

שלושה קבצים ב-`~/.agents/skills` שנכשלו בטעינה בכל הפעלה (גיבוי `.bak` נשמר לצד כל אחד):

- `claude-win11-speckit-update-skill/SKILL.md` — חסר frontmatter; נוסף בלוק `name`/`description`.
- `nanobanana-ppt-skills/SKILL.md` — חסר frontmatter; נוסף בלוק `name`/`description`.
- `infinite-gratitude/SKILL.md` — `argument-hint: "<topic>" [...]` נשבר ב-YAML כי הסוגר מגיע אחרי
  סגירת המרכאות; הערך כולו צוטט.

אחרי התיקון שגיאות `failed to load skill` נעלמו מהפלט, והספירה עלתה ב-3 — הראיה שהם נטענים עכשיו.

## מה בוצע — צמצום מדוד

### כמה skills נכנסים בתקציב

נמדד בשחזור מדורג של השורש, כאשר האזהרה בתחילת ה-session היא המדד:

| מספר skills חיים | תוצאה |
|---|---|
| 3,756 (מצב התחלתי) | `Exceeded... **כל** התיאורים הוסרו, 3,756 skills לא נכללו` |
| 300 | חריגה |
| 250 | חריגה |
| **200–220** | `התיאורים **קוצרו** — Codex עדיין רואה **כל** skill` |
| 150 / 100 / 60 | אותה הודעה בדיוק (קיצור), לא טובה יותר |

כלומר האיכות אינה משתפרת מתחת ל-200, אבל הכיסוי כן נפגע. נקודת ההפעלה שנבחרה: **220**.
ההבדל המהותי אינו במספר אלא בסוג ההודעה: מ"אף תיאור לא נראה ו-3,756 skills חסרים" ל"כל skill נראה".

### ה-plugins אינם צרכני התקציב

נמדד מול כל 20 ה-plugins שב-`config.toml`:

| מצב | תוצאה |
|---|---|
| baseline (220 skills) | קיצור תיאורים |
| **כל 20 ה-plugins מושבתים** | קיצור תיאורים — **ללא שינוי** |
| כל plugin מושבת לחוד (20 הרצות) | קיצור תיאורים — ללא שינוי |

לכן הסרת marketplaces או plugins הייתה מורידה פונקציונליות שבשימוש (caveman, ponytail, impeccable,
claude-mem, כלי openai) בתמורה לאפס. **לא בוצעה.** הקונפיג לא נגע; גיבוי נשמר ב-
`~/.codex/config.toml.bak-2026-08-17`.

### המצב הסופי, והכל הפיך

| מיקום | תוכן |
|---|---|
| `~/.agents/skills` | 220 skills חיים |
| `~/.agents/skills.staging-2026-08-17` | כל 2,371 המקוריים |
| `~/.codex/skills.archived-2026-08-17` | 2,254 (60MB) שאורכבו |
| `~/.agents/skills-live-set-2026-08-17.txt` | רשימת ה-220 |

**איך בוחרים skill בחזרה:**

```powershell
Copy-Item -Recurse "$HOME\.agents\skills.staging-2026-08-17\<name>" "$HOME\.agents\skills\<name>"
```

**איך משחזרים הכל:**

```powershell
Remove-Item -Recurse -Force "$HOME\.agents\skills"
Rename-Item "$HOME\.agents\skills.staging-2026-08-17" "skills"
Rename-Item "$HOME\.codex\skills.archived-2026-08-17" "skills"
```

### הסט הסופי — שלושה אותות, לפי חוזק הראיה

הסט הנוכחי (231) נבנה משלושה אותות, בסדר הזה:

| אות | כמות | איך נמדד |
|---|---|---|
| הותקן במכוון | 45 | mtime של `SKILL.md` שאינו יום ההתקנה בתפזורת |
| **שימוש בפועל לאחרונה** | 87 | קריאות אמיתיות ב-Codex וב-Claude מאז 2026-07-10 |
| התאמה לסטאק הפרויקטים | 98 | פרופיל התלויות של 38 הפרויקטים |
| מוגדר בקונפיג הגלובלי | 1 | `graphify`, שהיה קיים רק ב-`~/.claude/skills` ולכן Codex מעולם לא ראה אותו |

**איך נמדד שימוש אמיתי.** ניסיון ראשון ספר שמות בתמלילים והחזיר זבל: כל session מדפיס את קטלוג
ה-skills המלא, ולכן 700 skills "נספרו" עם ~5,300 הופעות כל אחד. האותות הנכונים שונים בין הכלים:

- **Claude** רושם הפעלה כקריאת כלי: `"name":"Skill","input":{"skill":"<name>"`.
- **ל-Codex אין רישום כזה**, אבל הרצת skill קוראת את `SKILL.md` שלו, ולכן הפניה לנתיב
  `skills/<name>/SKILL.md` ב-rollout היא הראיה.

מ-1,262 תמלילים מאז 10.7: **167 קריאות ב-Claude על 79 skills**, ו-**6,729 קריאות SKILL.md ב-Codex
על 599 skills**. הפער אינו מקרי: orchestrator ב-Codex קורא הרבה קבצי `SKILL.md` בזמן חיפוש, ולכן
קריאה בודדת אינה שימוש. הסף שנקבע: **8 קריאות ומעלה, או קריאת כלי אחת של Claude**.

השימוש הכבד ביותר, וכולו נכנס לסט:

```
code-reviewer:154  skill-orchestrator:90  frontend-design:70  agent-orchestrator:45
antigravity-skill-orchestrator:26  e2e-testing:22  verification-before-completion:15
closed-loop-delivery:14  create-issue-gate:14  code-review-checklist:13
code-review-excellence:13  vibers-code-review:12  requesting-code-review:12
receiving-code-review:12  executing-plans:11  multi-agent-brainstorming:11
agents-sdk:10  acceptance-orchestrator:10  swarm:10  pdf-official:7  i18n-localization:1
```

השורה האחרונה מספרת סיפור: `pdf-official` ו-`i18n-localization` הופעלו על מסמכי PDF בעברית, ומשפחת
ה-code-review כולה בשימוש חוזר. אלה לא היו נבחרים על ידי ניקוד תחומים.

**73 skills שהיו בשימוש אינם ניתנים להוספה** מ-staging כי הם מגיעים מ-plugins ולא מהשורש
(`documents`, `pdf`, `presentations`, `gmail`, `computer-use`, `control-chrome`, `visualize`
ועוד), ושניים הם skills ייעודיים לפרויקט (`supplyflow-production-rollout`,
`nir-app-remediation-phase`). הם עובדים כרגיל דרך ה-plugins.

**59 skills שהיו בשימוש נדחו מחוסר מקום** (התקציב נמדד: 220 נכנסים, 250 חורגים). כולם ב-staging
ונוספים בפקודת העתקה אחת.

### הסט הקודם — נבנה מהסטאק שנמדד

הבחירה הראשונה (mtime) הייתה שרירותית עבור 175 מתוך 220, כי 2,319 skills חולקים יום התקנה אחד.
לכן הסט נבנה מחדש מראיות: **פרופיל התלויות של 38 הפרויקטים** תחת `D:\משה פרוייקטים\פיתוח אתרים`.

התלויות הנפוצות שנמדדו:

```
react:62  react-dom:43  vite:42  three:26  typescript:26  lucide-react:21  tailwindcss:20
papaparse:18  vitest:16  zod:14  idb:14  sharp:12  supabase-js:11  react-query:9  recharts:9
react-pdf:9  xlsx:9  msw:9  playwright-core:9  vite-plugin-pwa:9  tus-js-client:9
framer-motion:6  zustand:6  gsap:5  drei:4  fiber:4  konva:3  next:2
```

מכאן נגזרו אחת-עשרה קבוצות תחום עם משקלים, וכל skill נוקד לפי התאמת **מילה שלמה** בשם ובתיאור
(התאמת תת-מחרוזת ניפחה את הניקוד: `ci` נתפס בתוך `specification`). בנוסף:

- כל 45 ה-skills שהותקנו במכוון מקבלים עדיפות מוחלטת — כולם בסט.
- **892 skills של אינטגרציות לכלים שאינם מחוברים כאן נזרקו** (`*-automation` ל-SaaS שלא בשימוש).
  אינטגרציה שורדת רק אם היא נוקבת בכלי שמחובר בפועל: supabase, github, cloudflare, vercel,
  openrouter, openai, anthropic, notion, telegram, whatsapp, gmail, google-*, stripe, slack, figma,
  playwright, firecrawl, apify, neon, postgres.

התפלגות הסט (skill יכול להשתייך לכמה תחומים):

| תחום | כמות |
|---|---|
| ai-agents | 116 |
| ui-ux | 93 |
| testing-quality | 71 |
| data-backend | 70 |
| frontend | 56 |
| seo-content | 42 |
| security | 38 |
| devops-cli | 37 |
| media | 33 |
| product-growth | 27 |
| 3d-canvas | 14 |

דוגמאות שנכנסו מהגוש בזכות התאמה לסטאק: `spline-3d-integration`, `3d-web-design`, `shadcn`,
`animejs-animation`, `scroll-hero-effect`, `senior-frontend`, `postgres-best-practices`,
`drizzle-orm-expert`, `vercel-ai-sdk-expert`, `landing-page-generator`, `artifacts-builder`,
`cc-skill-frontend-patterns`, `agents-sdk`.

הרשימה המלאה, עם התחום של כל skill, ב-`~/.agents/skills-live-set-2026-08-17.txt`.

### על הבחירה הקודמת — מה היה שרירותי

הקריטריון היה זמן שינוי של `SKILL.md`, אבל **2,319 מתוך 2,364 חולקים את אותו יום (2026-07-21)** —
התקנה בתפזורת. לכן:

- **45 skills הותקנו או עודכנו במכוון** (ימים אחרים: caveman על מגוון פקודותיו, watch, migration,
  lean-build, investigate-first, safe-refactor, surgical-patch, verify-and-stop ועוד). כולם בסט החי.
- **175 הנותרים נבחרו שרירותית** מתוך גוש ה-21.7. אין במכונה אות שימוש אמין: תמלילי ה-sessions
  מכילים את קטלוג ה-skills המלא בכל הפעלה, ולכן תדירות הופעה של שם אינה מדד לשימוש.
- שבע תיקיות ללא `SKILL.md` (`libreoffice`, `linear`, `nano-banana-prompts`, `nanobanana-prompt`,
  `npxskillui`, `security`, `SPDD`) נשארו ב-staging; הן אינן נטענות ממילא.

אם תרצה סט אחר — הוא נבחר בפקודת העתקה אחת מהרשימה למעלה.

## מה נשאר להחלטה של הבעלים

1. **צמצום `~/.agents/skills`** — בוצע: 220 חיים, השאר ב-staging.
2. **צמצום marketplaces/plugins** — נמדד כחסר תועלת ולכן לא בוצע.
3. **ארכוב `~/.codex/skills`** — בוצע.
4. עוד שבעה ערכים ב-`~/.agents/skills` הם תיקיות ללא `SKILL.md` כלל (`libreoffice`, `linear`,
   `nano-banana-prompts`, `nanobanana-prompt`, `npxskillui`, `security`, `SPDD`) ואחד הוא `.system`
   ב-`~/.codex/skills`. הם אינם skills; לא נגעתי בהם.

## הקשר ל-Wave 7

התוכנית דורשת ב-Wave 7 קטלוג יכולות אמיתי עם provenance ודדופליקציה, ותיקון של `agent-orchestrator`.
הממצא הזה הוא בדיוק אותו כשל בקנה מידה אמיתי: שלושה שורשים כמעט זהים, 85% כפילות, ומנוע שמוותר על
כל התיאורים. `count` אינו הוכחת capability — כאן הוא אפילו לא הוכחת נראות.
