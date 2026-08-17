import { expect, expectNoClientErrors, settlePage, test } from "./support/fixtures";
import { PUBLIC_ROUTES } from "./support/routes";

test.describe("public route smoke coverage", () => {
  test("discovers the 48-route page surface", () => {
    // 47 pre-redesign routes plus /graphify.
    expect(PUBLIC_ROUTES).toHaveLength(48);
    expect(new Set(PUBLIC_ROUTES).size).toBe(48);
    expect(PUBLIC_ROUTES).toContain("/");
    expect(PUBLIC_ROUTES).toContain("/claude");
    expect(PUBLIC_ROUTES).toContain("/codex");
    expect(PUBLIC_ROUTES).toContain("/hermes");
    expect(PUBLIC_ROUTES).toContain("/graphify");
  });

  for (const route of PUBLIC_ROUTES) {
    test(`${route} renders without runtime or network errors`, async ({ page, diagnostics }) => {
      const response = await page.goto(route, { waitUntil: "domcontentloaded" });
      expect(response, `missing navigation response for ${route}`).not.toBeNull();
      expect(response?.status(), `HTTP status for ${route}`).toBe(200);
      await settlePage(page);

      await expect(page, `document title for ${route}`).toHaveTitle(/Agentic OS/);

      await expect(page.locator("body")).not.toContainText("Application error");
      await expect(page.locator("body")).not.toContainText("This page could not be found");
      expectNoClientErrors(diagnostics);
    });
  }
});
