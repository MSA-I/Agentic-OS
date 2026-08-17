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

- תיקון שלושה קבצי `SKILL.md` שבורים ב-`~/.agents/skills` העלה את הספירה **3753 → 3756**.
- הוספת skill תקין ל-`~/.codex/skills` לא שינתה את הספירה.
- הוספת skill תקין ל-`~/.claude/skills` לא שינתה את הספירה.

**מסקנה:** מבין שלושת השורשים, Codex מונה רק את `~/.agents/skills`. שאר ההפרש (3,756 מול 2,371)
מגיע ממקורות שאינם השורש הזה — ה-marketplaces וה-plugins הרשומים ב-`~/.codex/config.toml`
(`openai-bundled`, `openai-primary-runtime`, `claude-plugins-official`, `impeccable` ועוד).

**נגזרת:** ה-sync שהעתיק 2,229 skills מ-`~/.claude/skills` אל `~/.codex/skills`
(`~/.codex/claude-compatible-skill-sync-report.json`) לא תרם ל-Codex דבר. 60MB שאינם נקראים.

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

## מה נשאר להחלטה של הבעלים

אלה נגיעות בנתונים ובקונפיגורציה של המכונה, ולכן לא בוצעו:

1. **לצמצם את `~/.agents/skills`** — זה השורש היחיד שנמנה מהדיסק. כל skill שמוסר יורד מהמניה.
2. **לצמצם marketplaces/plugins** ב-`~/.codex/config.toml` — שם נמצא ההפרש של ~1,385 הפריטים.
3. **לארכב את `~/.codex/skills`** (2,254 תיקיות, 60MB) — נמדד כלא-נקרא על ידי Codex.
4. עוד שבעה ערכים ב-`~/.agents/skills` הם תיקיות ללא `SKILL.md` כלל (`libreoffice`, `linear`,
   `nano-banana-prompts`, `nanobanana-prompt`, `npxskillui`, `security`, `SPDD`) ואחד הוא `.system`
   ב-`~/.codex/skills`. הם אינם skills; לא נגעתי בהם.

## הקשר ל-Wave 7

התוכנית דורשת ב-Wave 7 קטלוג יכולות אמיתי עם provenance ודדופליקציה, ותיקון של `agent-orchestrator`.
הממצא הזה הוא בדיוק אותו כשל בקנה מידה אמיתי: שלושה שורשים כמעט זהים, 85% כפילות, ומנוע שמוותר על
כל התיאורים. `count` אינו הוכחת capability — כאן הוא אפילו לא הוכחת נראות.
