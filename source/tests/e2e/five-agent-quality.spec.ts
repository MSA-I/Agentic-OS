import { expect, expectNoClientErrors, settlePage, test } from "./support/fixtures";
import type { Page } from "@playwright/test";

const SURFACES = [
  { name: "codex", route: "/codex?panel=chat", composer: 'textarea[aria-label="Message Codex"]' },
  { name: "claude", route: "/claude?view=code", composer: 'textarea[aria-label="Message Claude"]' },
  { name: "hermes", route: "/hermes?view=messages", composer: 'textarea[aria-label="Message Hermes"]' },
  { name: "openclaw", route: "/openclaw?view=chat", composer: 'textarea[aria-label^="Message "]' },
  { name: "antigravity", route: "/antigravity?view=conversation", composer: 'textarea[aria-label="Message Antigravity"]' },
] as const;

async function installSurfaceMocks(page: Page, name: (typeof SURFACES)[number]["name"]) {
  if (name !== "antigravity") return;
  await page.route("**/api/antigravity/workspace**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("kind") && url.searchParams.has("project")) {
      await route.fulfill({ json: { root: "C:\\qa\\antigravity", files: [] } });
      return;
    }
    await route.fulfill({
      json: {
        projects: [{
          name: "qa-project",
          root: "C:\\qa\\antigravity",
          mtime: Date.now(),
          fileCount: 0,
          kind: "scratch",
        }],
      },
    });
  });
}

for (const surface of SURFACES) {
  test(`${surface.name} keeps operational text at 12px or larger`, async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installSurfaceMocks(page, surface.name);
    await page.goto(surface.route, { waitUntil: "domcontentloaded" });
    await settlePage(page, 500);

    const input = page.locator(surface.composer);
    if (await input.isEnabled()) await input.fill("שלום, בדיקת כיווניות בלבד");

    const offenders = await page.locator("body *").evaluateAll((elements) => elements.flatMap((element) => {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return [];
      if (["SCRIPT", "STYLE", "SVG", "PATH"].includes(element.tagName)) return [];
      const directText = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
      const operationalControl = ["BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL"].includes(element.tagName);
      if (!directText && !operationalControl) return [];
      const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
      if (!Number.isFinite(fontSize) || fontSize >= 12) return [];
      return [{
        tag: element.tagName.toLowerCase(),
        className: element.className,
        fontSize,
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      }];
    }));

    expect(offenders, "visible operational text smaller than 12px").toEqual([]);
    expectNoClientErrors(diagnostics);
  });

  test(`${surface.name} remains usable at a 200% equivalent viewport`, async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 720, height: 450 });
    await installSurfaceMocks(page, surface.name);
    await page.goto(surface.route, { waitUntil: "domcontentloaded" });
    await settlePage(page, 500);

    const composer = page.locator(surface.composer);
    await expect(composer).toBeVisible();
    if (await composer.isEnabled()) await composer.fill("שלום, בדיקת כיווניות בלבד");
    const composerBox = await composer.boundingBox();
    expect(composerBox?.x).toBeGreaterThanOrEqual(0);
    expect((composerBox?.x ?? 0) + (composerBox?.width ?? 0)).toBeLessThanOrEqual(721);
    const overflow = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(overflow.content).toBeLessThanOrEqual(overflow.viewport + 1);
    expectNoClientErrors(diagnostics);
  });
}
