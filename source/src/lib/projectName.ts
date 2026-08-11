// Project-folder name guard.
//
// The pack shipped `/^[A-Za-z0-9_.-]+$/` on every workspace lookup. That is an
// allow-list of ASCII, so any real folder with a space ("Agent OS") or a
// non-Latin name (Hebrew, Cyrillic, CJK…) silently 404s — it lists in the
// sidebar and then refuses to open. That matters the moment the scratch root
// points at a real projects directory instead of an empty one.
//
// What actually needs blocking is escaping the root, not "unusual letters":
// path separators, traversal, drive-qualified paths, and control characters.
// Callers still resolve the final path and containment-check it against the
// root, so this is the outer of two guards, not the only one.
export function isSafeProjectName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const n = name.trim();
  if (n.length === 0 || n.length > 120) return false;
  if (n === "." || n === "..") return false;
  if (n.includes("/") || n.includes("\\")) return false; // no separators
  if (/^[A-Za-z]:/.test(n)) return false;                // no C:\… style paths
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(n)) return false;           // no NUL / control chars
  return true;
}

// Self-check: node --experimental-strip-types src/lib/projectName.ts
if (process.env.PROJECT_NAME_SELFTEST) {
  const ok = ["NIR-APP", "Agent OS", "דוד זגורי", "شركة", "日本語", "a.b_c-d"];
  const bad = ["", "..", ".", "a/b", "a\\b", "C:\\Windows", "x\u0000y", "x".repeat(121), null, 42];
  for (const v of ok) if (!isSafeProjectName(v)) throw new Error(`should accept: ${v}`);
  for (const v of bad) if (isSafeProjectName(v)) throw new Error(`should reject: ${String(v)}`);
  console.log("projectName self-check passed");
}
