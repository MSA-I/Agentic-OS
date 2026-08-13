import { expect, expectNoClientErrors, settlePage, test } from "./support/fixtures";

test("Codex canonicalizes a session to its owning project", async ({ page, diagnostics }) => {
  await page.route("**/api/agent-history?agent=codex", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        groups: [
          { id: "project-a", label: "Project A", root: "mock://a", sessions: [] },
          {
            id: "project-b",
            label: "Project B",
            root: "mock://b",
            sessions: [{ id: "session-b", name: "Session B", path: "mock:codex:b", mtime: Date.now(), bytes: 1 }],
          },
        ],
      },
    });
  });

  await page.goto("/codex?project=project-a&session=mock%3Acodex%3Ab", { waitUntil: "domcontentloaded" });
  await settlePage(page);

  await expect.poll(() => new URL(page.url()).searchParams.get("project")).toBe("project-b");
  await expect(page.locator(".codex-breadcrumb")).toContainText("Project B");
  expectNoClientErrors(diagnostics);
});

test("Claude restores and writes workspace context with its files pane", async ({ page, diagnostics }) => {
  await page.route("**/api/claude/workspace**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("project")) {
      await route.fulfill({ contentType: "application/json", json: { files: [] } });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: { projects: [
        { name: "alpha", root: "mock://alpha", mtime: Date.now(), fileCount: 0 },
        { name: "beta", root: "mock://beta", mtime: Date.now(), fileCount: 0 },
      ] },
    });
  });

  await page.goto("/claude?view=files&pane=files&workspace=beta", { waitUntil: "domcontentloaded" });
  await settlePage(page);

  const projectPicker = page.locator('[aria-label="Files pane"] select[aria-label="Claude project"]');
  await expect(projectPicker).toHaveValue("beta");
  await projectPicker.selectOption("alpha");
  await expect.poll(() => new URL(page.url()).searchParams.get("workspace")).toBe("alpha");
  await expect.poll(() => new URL(page.url()).searchParams.get("pane")).toBe("files");
  expectNoClientErrors(diagnostics);
});

test("Hermes restores and writes workspace context with its files pane", async ({ page, diagnostics }) => {
  await page.route("**/api/hermes/workspace**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("bucket")) {
      await route.fulfill({ contentType: "application/json", json: { files: [] } });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: { buckets: [
        { id: "alpha", label: "Alpha", roots: ["mock://alpha"], description: "Alpha workspace", fileCount: 0, mtime: Date.now() },
        { id: "beta", label: "Beta", roots: ["mock://beta"], description: "Beta workspace", fileCount: 0, mtime: Date.now() },
      ] },
    });
  });

  await page.goto("/hermes?view=projects&pane=files&workspace=beta", { waitUntil: "domcontentloaded" });
  await settlePage(page);

  const bucketPicker = page.locator('[aria-label="files pane"] select');
  await expect(bucketPicker).toHaveValue("beta");
  await bucketPicker.selectOption("alpha");
  await expect.poll(() => new URL(page.url()).searchParams.get("workspace")).toBe("alpha");
  await expect.poll(() => new URL(page.url()).searchParams.get("pane")).toBe("files");
  expectNoClientErrors(diagnostics);
});
