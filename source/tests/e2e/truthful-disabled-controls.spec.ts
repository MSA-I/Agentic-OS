import { expect, settlePage, test } from "./support/fixtures";

// A control that would fail closed must say so before it is pressed. These are the
// user-visible half of the execution freeze: the shell notice on every page whose
// components mutate a frozen route, and the agent surfaces that replace their
// composer instead of offering a Run that cannot run.
test.describe("truthful disabled controls", () => {
  test("a page with frozen actions says so, a page without them does not", async ({ page }) => {
    await page.goto("/seo", { waitUntil: "domcontentloaded" });
    await settlePage(page);
    const notice = page.locator('[data-execution-frozen="/seo"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Actions on this page are disabled");
    await expect(notice).toContainText("no run is created");
    await expect(notice).toContainText("disabled endpoints on this page");

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await settlePage(page);
    await expect(page.locator("[data-execution-frozen]")).toHaveCount(0);
  });

  test("the notice lists only endpoints the freeze manifest actually contains", async ({ page }) => {
    await page.goto("/leads", { waitUntil: "domcontentloaded" });
    await settlePage(page);
    const notice = page.locator('[data-execution-frozen="/leads"]');
    await expect(notice).toBeVisible();
    await notice.locator("summary").click();
    for (const path of ["/api/leads/icp", "/api/leads/find", "/api/leads/enrich", "/api/leads/score"]) {
      await expect(notice.locator("code", { hasText: path })).toBeVisible();
    }
  });

  test("Antigravity offers no composer and no Run while it cannot run", async ({ page }) => {
    await page.goto("/antigravity", { waitUntil: "domcontentloaded" });
    await settlePage(page);
    await expect(page.getByLabel("Antigravity run unavailable")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Antigravity" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Run" })).toHaveCount(0);
  });

  test("OpenClaw replaces its composer with the reason", async ({ page }) => {
    await page.goto("/openclaw", { waitUntil: "domcontentloaded" });
    await settlePage(page);
    await expect(page.getByLabel("OpenClaw send unavailable")).toBeVisible();
    await expect(page.getByRole("textbox", { name: /^Message / })).toHaveCount(0);
  });

  test("Hermes replaces its composer with the reason", async ({ page }) => {
    await page.goto("/hermes", { waitUntil: "domcontentloaded" });
    await settlePage(page);
    await expect(page.getByText("Sending from Agent OS is disabled")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Hermes" })).toHaveCount(0);
  });
});
