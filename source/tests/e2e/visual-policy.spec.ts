import type { Page } from "@playwright/test";
import { expect, expectNoClientErrors, settlePage, test } from "./support/fixtures";

async function expectStaticVisualPolicy(page: Page, route: string, tab?: string) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(route, { waitUntil: "domcontentloaded" });
  if (tab) {
    await page.getByRole("button", { name: tab, exact: true }).click();
  }
  await settlePage(page, 900);

  expect(await page.locator("canvas").count(), `${route}${tab ? ` / ${tab}` : ""} decorative canvases`).toBe(0);

  const violations = await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };

    const gradientElements = Array.from(document.querySelectorAll("[data-agent-os-main] *"))
      .filter(visible)
      .flatMap((element) => [null, "::before", "::after"].map((pseudo) => ({
        element,
        pseudo,
        style: getComputedStyle(element, pseudo),
      })))
      .filter(({ style }) => /(?:linear|radial|conic)-gradient/i.test(style.backgroundImage))
      .slice(0, 10)
      .map(({ element, pseudo, style }) => ({
        element: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(/\s+/).slice(0, 2).join(".")}` : ""}${pseudo ?? ""}`,
        backgroundImage: style.backgroundImage,
      }));

    const infiniteAnimations = document.getAnimations()
      .filter((animation) => animation.playState === "running" && animation.effect?.getComputedTiming().iterations === Infinity)
      .slice(0, 10)
      .map((animation) => {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        if (!(target instanceof Element)) return "unknown";
        const className = typeof target.className === "string" ? target.className : target.getAttribute("class") ?? "";
        return `${target.tagName.toLowerCase()}.${className.trim().replace(/\s+/g, ".")}:${getComputedStyle(target).animationName}`;
      });

    return { gradientElements, infiniteAnimations };
  });

  expect(violations.gradientElements, "visible CSS gradients").toEqual([]);
  expect(violations.infiniteAnimations, "running infinite animations").toEqual([]);
}

test("specialist surfaces keep the locked layout without idle decorative FX", async ({ page, diagnostics }) => {
  for (const viewport of [{ width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expectStaticVisualPolicy(page, "/");
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await expectStaticVisualPolicy(page, "/pipeline");
  await expectStaticVisualPolicy(page, "/radar");
  await expectStaticVisualPolicy(page, "/astros");
  await expectStaticVisualPolicy(page, "/deepseek-coder");
  await expectStaticVisualPolicy(page, "/hy3-coder");
  await expectStaticVisualPolicy(page, "/muse-code");
  await expectStaticVisualPolicy(page, "/omniroute");
  await expectStaticVisualPolicy(page, "/higgsfield");
  await expectStaticVisualPolicy(page, "/memory");

  const memoryGraph = page.locator("svg[data-memory-graph='galaxy']");
  await expect(memoryGraph).toHaveCount(1);
  const graphLayer = memoryGraph.locator(":scope > g").first();
  const initialTransform = await graphLayer.getAttribute("transform");
  await memoryGraph.dispatchEvent("wheel", { deltaY: -120 });
  await expect.poll(() => graphLayer.getAttribute("transform")).not.toBe(initialTransform);
  const zoomedTransform = await graphLayer.getAttribute("transform");

  const graphBox = await memoryGraph.boundingBox();
  if (!graphBox) throw new Error("Memory graph has no visible bounds");
  await page.mouse.move(graphBox.x + graphBox.width * 0.92, graphBox.y + graphBox.height * 0.88);
  await page.mouse.down();
  await page.mouse.move(graphBox.x + graphBox.width * 0.84, graphBox.y + graphBox.height * 0.82, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => graphLayer.getAttribute("transform")).not.toBe(zoomedTransform);

  const firstNode = memoryGraph.locator("g[role='button']").first();
  const firstNodeCircle = firstNode.locator("circle").nth(1);
  const initialNodeX = await firstNodeCircle.getAttribute("cx");
  const nodeBox = await firstNode.boundingBox();
  if (!nodeBox) throw new Error("Memory graph node has no visible bounds");
  await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(nodeBox.x + nodeBox.width / 2 + 24, nodeBox.y + nodeBox.height / 2 + 12, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => firstNodeCircle.getAttribute("cx")).not.toBe(initialNodeX);

  await expectStaticVisualPolicy(page, "/hermes", "Hermes Muse");
  await expectStaticVisualPolicy(page, "/hermes", "Apollo");
  expectNoClientErrors(diagnostics);
});
