import { mkdirSync } from "node:fs";
import path from "node:path";
import { expectNoClientErrors, settlePage, test } from "./support/fixtures";
import { QA_VIEWPORTS, VISUAL_ROUTES } from "./support/routes";

const outputDirectory = process.env.AGENT_OS_VISUAL_QA_DIR
  ? path.resolve(process.env.AGENT_OS_VISUAL_QA_DIR)
  : path.resolve(process.cwd(), ".next", "visual-qa");

test.beforeAll(() => {
  mkdirSync(outputDirectory, { recursive: true });
});

for (const viewport of QA_VIEWPORTS) {
  for (const surface of VISUAL_ROUTES) {
    test(`${surface.name} visual at ${viewport.name}`, async ({ page, diagnostics }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(surface.route, { waitUntil: "domcontentloaded" });
      await settlePage(page, 500);

      await page.screenshot({
        path: path.join(outputDirectory, `${surface.name}-${viewport.name}.png`),
        fullPage: false,
        animations: "disabled",
      });
      expectNoClientErrors(diagnostics);
    });
  }
}
