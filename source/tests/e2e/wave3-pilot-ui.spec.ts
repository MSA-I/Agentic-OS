import { expect, test, type Page, type TestInfo } from "@playwright/test";

const LEGACY_SENTINEL = "WAVE3_LEGACY_DRAFT_MUST_BE_PURGED";
const CURRENT_SENTINEL = "WAVE3_VOLATILE_DRAFT_MUST_NOT_PERSIST";

async function assertNoDurableDraft(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(() => JSON.stringify(localStorage))).not.toContain(LEGACY_SENTINEL);
  const storage = await page.evaluate(() => Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => Boolean(key))
      .map((key) => [key, localStorage.getItem(key)]),
  ));
  expect(JSON.stringify(storage)).not.toContain(CURRENT_SENTINEL);
  expect(Object.keys(storage)).not.toContainEqual(expect.stringContaining("agent-os:workbench:draft:v1:"));
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
}

test.describe("Wave 3 restricted pilot UI contract", () => {
  test("Codex shows one explicit target and never posts to the legacy chat route", async ({ page }, testInfo) => {
    const directPosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/codex/chat") {
        directPosts.push(request.url());
      }
    });
    await page.addInitScript((sentinel) => {
      localStorage.setItem("agentic-os:codex:draft:v3:legacy", sentinel);
    }, LEGACY_SENTINEL);

    await page.goto("/codex");
    await expect(page.locator('a[aria-label="Return to Mission Control"]')).toHaveAttribute("href", "/");
    await expect(page.locator(".codex-breadcrumb")).toContainText("Codex");
    await expect(page.locator(".codex-context-badges")).toContainText("Local");
    const composer = page.locator('textarea[aria-label="Message Codex"]');
    if (await composer.isEnabled()) {
      await composer.fill(CURRENT_SENTINEL);
      await page.waitForTimeout(250);
    }
    await assertNoDurableDraft(page);
    expect(directPosts).toEqual([]);
    await attachScreenshot(page, testInfo, "wave3-codex-control-plane");
  });

  test("Claude shows one explicit target and keeps drafts in volatile memory only", async ({ page }, testInfo) => {
    const directPosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/claude/chat") {
        directPosts.push(request.url());
      }
    });
    await page.addInitScript((sentinel) => {
      localStorage.setItem("agent-os:workbench:draft:v1:claude:legacy", sentinel);
    }, LEGACY_SENTINEL);

    await page.goto("/claude");
    await expect(page.locator('a[aria-label="Return to Mission Control"]')).toHaveAttribute("href", "/");
    await expect(page.locator('[data-agent-page="claude"]')).toContainText("Claude");
    await expect(page.locator('[data-agent-page="claude"]')).toContainText("Local worktree");
    const composer = page.locator('textarea[aria-label="Message Claude"]');
    if (!await composer.isEnabled()) {
      await page.getByRole("button", { name: "New conversation" }).first().click();
    }
    await expect(composer).toBeEnabled();
    await composer.fill(CURRENT_SENTINEL);
    await page.waitForTimeout(250);
    await assertNoDurableDraft(page);
    expect(directPosts).toEqual([]);
    await attachScreenshot(page, testInfo, "wave3-claude-control-plane");
  });
});
