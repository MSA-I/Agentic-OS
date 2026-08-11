import { expect, test as base, type Page } from "@playwright/test";
import { installApiMocks, type MockApiLog } from "./mock-api";

export interface BrowserDiagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  httpErrors: string[];
}

interface QaFixtures {
  apiLog: MockApiLog;
  diagnostics: BrowserDiagnostics;
}

export const test = base.extend<QaFixtures>({
  apiLog: [
    async ({ page }, use) => {
      const log = await installApiMocks(page);
      await use(log);
    },
    { auto: true },
  ],
  diagnostics: async ({ page }, use) => {
    const diagnostics: BrowserDiagnostics = {
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
      httpErrors: [],
    };

    page.on("console", (message) => {
      if (message.type() === "error") {
        const location = message.location();
        diagnostics.consoleErrors.push(`${message.text()}${location.url ? ` — ${location.url}` : ""}`);
      }
    });
    page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      diagnostics.failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "failed"}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) diagnostics.httpErrors.push(`${response.status()} ${response.url()}`);
    });

    await use(diagnostics);
  },
});

export { expect };

export async function settlePage(page: Page, milliseconds = 350) {
  await page.locator("body").waitFor({ state: "visible" });
  await page.waitForTimeout(milliseconds);
}

export function expectNoClientErrors(diagnostics: BrowserDiagnostics) {
  expect(diagnostics.pageErrors, "uncaught browser errors").toEqual([]);
  expect(diagnostics.consoleErrors, "browser console errors").toEqual([]);
  expect(diagnostics.failedRequests, "failed browser requests").toEqual([]);
  expect(diagnostics.httpErrors, "HTTP responses >= 400").toEqual([]);
}
