import AxeBuilder from "@axe-core/playwright";
import { expect, expectNoClientErrors, settlePage, test } from "./support/fixtures";
import { QA_VIEWPORTS, VISUAL_ROUTES } from "./support/routes";

function formatViolations(violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]) {
  return violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
  }));
}

for (const viewport of QA_VIEWPORTS) {
  for (const surface of VISUAL_ROUTES) {
    test(`${surface.name} has no automated WCAG 2.2 AA violations at ${viewport.name}`, async ({ page, diagnostics }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(surface.route, { waitUntil: "domcontentloaded" });
      await settlePage(page, 500);

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();

      expect(formatViolations(results.violations), "axe WCAG violations").toEqual([]);
      expectNoClientErrors(diagnostics);
    });
  }
}
