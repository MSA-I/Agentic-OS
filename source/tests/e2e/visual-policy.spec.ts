import type { Page } from "@playwright/test";
import { expect, expectNoClientErrors, settlePage, test } from "./support/fixtures";

async function expectStaticVisualPolicy(page: Page, route: string) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await settlePage(page, 700);

  expect(await page.locator("canvas").count(), `${route} decorative canvases`).toBe(0);
  const violations = await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const gradientElements = Array.from(document.querySelectorAll("[data-agent-os-main] *"))
      .filter(visible)
      .flatMap((element) => [null, "::before", "::after"].map((pseudo) => ({ element, pseudo, style: getComputedStyle(element, pseudo) })))
      .filter(({ style }) => /(?:linear|radial|conic)-gradient/i.test(style.backgroundImage))
      .slice(0, 10)
      .map(({ element, pseudo, style }) => ({
        element: `${element.tagName.toLowerCase()}${pseudo ?? ""}`,
        backgroundImage: style.backgroundImage,
      }));
    const infiniteAnimations = document.getAnimations()
      .filter((animation) => animation.playState === "running" && animation.effect?.getComputedTiming().iterations === Infinity)
      .map((animation) => {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        return target instanceof Element ? target.tagName.toLowerCase() : "unknown";
      });
    return { gradientElements, infiniteAnimations };
  });
  expect(violations.gradientElements, "visible CSS gradients").toEqual([]);
  expect(violations.infiniteAnimations, "running infinite animations").toEqual([]);
}

test("standard specialist surfaces retain the static visual policy", async ({ page, diagnostics }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const route of ["/", "/pipeline", "/radar", "/astros", "/deepseek-coder", "/hy3-coder", "/muse-code", "/omniroute", "/higgsfield"]) {
    await expectStaticVisualPolicy(page, route);
  }
  expectNoClientErrors(diagnostics);
});

test("MEMORY uses the approved cinematic canvas and keeps the clean graph alternative", async ({ page, diagnostics }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/memory", { waitUntil: "domcontentloaded" });
  await settlePage(page, 1200);

  const galaxy = page.locator("[data-memory-galaxy]");
  const canvas = galaxy.locator("canvas");
  await expect(galaxy).toBeVisible();
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toHaveAttribute("role", "img");
  await expect(canvas).toHaveAttribute("aria-label", /Memory Galaxy with \d+ stars and \d+ links/);
  await expect(canvas).toHaveAttribute("data-animation-state", "running");
  expect(Number(await galaxy.getAttribute("data-memory-stars"))).toBeGreaterThan(0);

  const luma = await canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext("2d");
    if (!context) return 0;
    const { width, height } = element as HTMLCanvasElement;
    const pixels = context.getImageData(0, 0, width, height).data;
    let total = 0;
    const stride = Math.max(4, Math.floor(pixels.length / 5000 / 4) * 4);
    for (let index = 0; index < pixels.length; index += stride) total += pixels[index] + pixels[index + 1] + pixels[index + 2];
    return total / (pixels.length / stride * 3);
  });
  expect(luma).toBeGreaterThan(2);

  const box = await canvas.boundingBox();
  if (!box) throw new Error("Memory Galaxy canvas has no visible bounds");
  await page.mouse.move(box.x + box.width * 0.78, box.y + box.height * 0.72);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.66, box.y + box.height * 0.62, { steps: 4 });
  await page.mouse.up();
  await expect(canvas).toHaveAttribute("data-orbit", /,/);
  await canvas.dispatchEvent("wheel", { deltaY: -160 });
  await expect(canvas).toHaveAttribute("data-zoom", /\d/);

  await page.getByRole("button", { name: /Galaxy/ }).click();
  const cleanGraph = page.locator('svg[data-memory-graph="graph"]');
  await expect(cleanGraph).toBeVisible();
  const firstNote = cleanGraph.locator('g[role="button"]').first();
  await firstNote.focus();
  await expect(firstNote).toBeFocused();
  expectNoClientErrors(diagnostics);
});

test("MEMORY disables flight and twinkle under reduced motion", async ({ page, diagnostics }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/memory", { waitUntil: "domcontentloaded" });
  await settlePage(page, 800);
  await expect(page.locator("[data-memory-galaxy] canvas")).toHaveAttribute("data-animation-state", "reduced-motion");
  expectNoClientErrors(diagnostics);
});
