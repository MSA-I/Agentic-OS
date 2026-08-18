import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = process.cwd();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export default undefined" };
    }
    let candidate = null;
    if (specifier.startsWith("@/")) {
      candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
    } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      candidate = new URL(specifier, context.parentURL);
      candidate = decodeURIComponent(candidate.pathname).replace(/^\/(?=[A-Za-z]:\/)/u, "");
    }
    if (candidate) {
      for (const target of [`${candidate}.ts`, candidate, path.join(candidate, "index.ts")]) {
        if (existsSync(target) && statSync(target).isFile()) {
          return { shortCircuit: true, url: pathToFileURL(target).href };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { buildInstallPlanPrompt, placeholderSecrets, PROMPT_BYTE_CAP } = await import("./prompt.ts");
const { PLAN_OPEN_MARKER } = await import("./planSchema.ts");
const { SETUP_CATALOG } = await import("../setupCatalog.ts");

const HOST = { platform: "win32", cwdLabel: "a server-owned scratch folder" };

function guidesRoot() {
  for (const candidate of [path.join(sourceRoot, "install"), path.join(sourceRoot, "..", "install")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function entryFor(catalogEntry, guideMarkdown) {
  return {
    route: catalogEntry.route,
    title: catalogEntry.title,
    summary: catalogEntry.summary,
    actions: catalogEntry.actions,
    diagnostics: [
      { id: "cli", label: "CLI", status: "missing", detail: "CLI לא נמצא. ניתן לבחור קובץ קיים או לפעול לפי המדריך.", impact: "required" },
      { id: "auth", label: "Authentication", status: "missing", detail: "טרם התחבר.", impact: "required" },
    ],
    guideMarkdown,
  };
}

test("every catalog service, paired with the largest real guide, fits the cap", () => {
  const root = guidesRoot();
  assert.ok(root, "install/ guides not found");
  const guides = readdirSync(root).filter((name) => name.endsWith(".md"));
  const largest = guides
    .map((name) => readFileSync(path.join(root, name), "utf8"))
    .reduce((biggest, text) => (text.length > biggest.length ? text : biggest), "");
  assert.ok(largest.length > 4000, "expected a guide of a few KB to test against");

  for (const catalogEntry of SETUP_CATALOG) {
    const built = buildInstallPlanPrompt(entryFor(catalogEntry, largest), HOST);
    assert.ok(
      built.bytes <= PROMPT_BYTE_CAP,
      `${catalogEntry.route}: ${built.bytes} bytes exceeds ${PROMPT_BYTE_CAP}`,
    );
  }
});

test("every real guide fits with its own service", () => {
  const root = guidesRoot();
  for (const catalogEntry of SETUP_CATALOG) {
    const docId = catalogEntry.guide?.docId;
    if (!docId) continue;
    const file = path.join(root, docId);
    if (!existsSync(file)) continue;
    const built = buildInstallPlanPrompt(entryFor(catalogEntry, readFileSync(file, "utf8")), HOST);
    assert.ok(built.bytes <= PROMPT_BYTE_CAP, `${catalogEntry.route}: ${built.bytes} bytes`);
  }
});

test("an oversized guide is trimmed rather than silently dropped", () => {
  const huge = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} with enough words to matter here.`).join("\n\n");
  const built = buildInstallPlanPrompt(entryFor(SETUP_CATALOG[0], huge), HOST);
  assert.ok(built.bytes <= PROMPT_BYTE_CAP);
  assert.equal(built.trimmed.length, 1);
  assert.match(built.prompt, /guide trimmed to fit/);
});

test("the sections that must never be trimmed are always present", () => {
  const built = buildInstallPlanPrompt(entryFor(SETUP_CATALOG[0], "x".repeat(50_000)), HOST);
  assert.match(built.prompt, /RESPONSE CONTRACT/);
  assert.match(built.prompt, /THIS MACHINE/);
  assert.match(built.prompt, /THE SERVICE/);
  assert.match(built.prompt, /YOUR TASK/);
  assert.ok(built.prompt.trimEnd().endsWith('{"version": 1,'), "the prefill must be last");
  assert.ok(built.prompt.includes(PLAN_OPEN_MARKER));
});

// redactText runs over the prompt server-side. Left alone, a guide line like
// `export ANTHROPIC_API_KEY=sk-live-…` comes back as [REDACTED_*] mid-sentence
// and the agent reads a mangled instruction.
test("secret-shaped guide lines become named placeholders before sending", () => {
  const guide = [
    "export ANTHROPIC_API_KEY=sk-ant-abc123",
    "run the tool with --api-key sk-live-xyz",
    "curl -H 'Authorization: Bearer eyJhbGciOi'",
    "OPENROUTER_API_KEY=or-v1-secret",
  ].join("\n");
  const cleaned = placeholderSecrets(guide);
  for (const secret of ["sk-ant-abc123", "sk-live-xyz", "eyJhbGciOi", "or-v1-secret"]) {
    assert.doesNotMatch(cleaned, new RegExp(secret), `${secret} survived`);
  }
  assert.match(cleaned, /ANTHROPIC_API_KEY=<your value>/);
  assert.match(cleaned, /--api-key <your value>/);
  assert.match(cleaned, /Bearer <your value>/);
});

test("the prompt tells the agent the two rules a plan most often breaks", () => {
  const built = buildInstallPlanPrompt(entryFor(SETUP_CATALOG[0], ""), HOST);
  assert.match(built.prompt, /NO ARGUMENT MAY CONTAIN A SPACE/);
  assert.match(built.prompt, /There is NO shell/);
});

test("actions needing a user value are marked so the agent does not choose them", () => {
  const withField = {
    ...SETUP_CATALOG[0],
    actions: [{ id: "connect-key", label: "מפתח", kind: "connect", availability: "automatic", description: "d", fields: [{ id: "apiKey" }] }],
  };
  const built = buildInstallPlanPrompt(entryFor(withField, ""), HOST);
  assert.match(built.prompt, /NEEDS A VALUE FROM THE USER/);
});

test("a service with no automatic actions says so instead of listing nothing", () => {
  const manualOnly = {
    ...SETUP_CATALOG[0],
    actions: [{ id: "install-manual", label: "ידני", kind: "install", availability: "manual", description: "d" }],
  };
  const built = buildInstallPlanPrompt(entryFor(manualOnly, ""), HOST);
  assert.match(built.prompt, /none — every step must be a command or manual/);
});

test("the absolute working directory never reaches the prompt", () => {
  const built = buildInstallPlanPrompt(entryFor(SETUP_CATALOG[0], ""), HOST);
  assert.doesNotMatch(built.prompt, /[A-Za-z]:\\/);
});
