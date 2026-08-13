import { expect, expectNoClientErrors, settlePage, test } from "./support/fixtures";

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test(`Mission Control remains directly accessible on ${viewport.name}`, async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/hermes?view=messages", { waitUntil: "domcontentloaded" });
    await settlePage(page);

    const home = page.getByRole("link", { name: "Mission Control", exact: true });
    await expect(home).toBeVisible();
    await expect(home).toHaveAttribute("href", "/");
    expectNoClientErrors(diagnostics);
    await home.click();
    await expect(page).toHaveURL(/\/$/);
  });
}

test("OpenClaw uses its black and red brand palette distinct from Claude", async ({ page, diagnostics }) => {
  await page.goto("/openclaw?view=chat", { waitUntil: "domcontentloaded" });
  await settlePage(page);
  const openClaw = await page.locator('[data-agent-page="openclaw"]').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      accent: style.getPropertyValue("--oc-accent").trim(),
      paper: style.getPropertyValue("--oc-paper").trim(),
    };
  });

  await page.goto("/claude?view=code", { waitUntil: "domcontentloaded" });
  await settlePage(page);
  const claude = await page.locator('[data-agent-page="claude"]').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      accent: style.getPropertyValue("--claude-rust").trim(),
      paper: style.getPropertyValue("--claude-paper").trim(),
    };
  });

  expect(openClaw).toEqual({ accent: "#ea1413", paper: "#0d0d0d" });
  expect(openClaw.accent).not.toBe(claude.accent);
  expect(openClaw.paper).not.toBe(claude.paper);
  expectNoClientErrors(diagnostics);
});
