import { expect, expectNoClientErrors, settlePage, test } from "./support/fixtures";

test("Hermes labels, finds, and filters Discord sessions without changing transport source", async ({ page, diagnostics }) => {
  await page.route("**/api/agent-history?agent=hermes", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        groups: [{
          id: "hermes-qa-project",
          label: "QA Project",
          root: "mock://qa-project",
          scope: "profile-alpha",
          sessions: [
            {
              id: "discord-session",
              name: "Release check",
              path: "mock:hermes:discord",
              mtime: Date.now(),
              bytes: 1,
              source: "native",
              platform: "discord",
              channel: "release-ops",
              chatType: "guild-channel",
              nativeStarted: true,
              resumable: true,
            },
            {
              id: "local-session",
              name: "Local session",
              path: "mock:hermes:local",
              mtime: Date.now() - 1,
              bytes: 1,
              source: "local",
              resumable: true,
            },
          ],
        }],
      },
    });
  });
  await page.route("**/api/hermes/profiles", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { profiles: [{ name: "profile-alpha", description: "QA profile", model: "Hermes QA", provider: "mock", soul: "", sessions: 2, lastActive: Date.now(), active: true }] },
    });
  });

  await page.goto("/hermes", { waitUntil: "domcontentloaded" });
  await settlePage(page);

  const group = page.getByRole("button", { name: /QA Project/ });
  await expect(group).toBeVisible();
  if (!(await page.locator('[data-source="discord"]').isVisible())) await group.click();
  const discordSession = page.locator('[data-source="discord"]');
  await expect(discordSession).toContainText("Release check");
  await expect(discordSession.getByText("Discord", { exact: true })).toBeVisible();
  await expect(discordSession.getByText("#release-ops", { exact: true })).toBeVisible();

  const search = page.getByRole("textbox", { name: "Search conversations" });
  await search.fill("release-ops");
  await expect(discordSession).toBeVisible();
  await expect(page.getByText("Local session", { exact: true })).toHaveCount(0);
  await search.fill("");

  await page.getByRole("combobox", { name: "Filter conversations" }).selectOption("discord");
  await expect(discordSession).toBeVisible();
  await expect(page.getByText("Local session", { exact: true })).toHaveCount(0);

  await discordSession.locator('button[type="button"]').first().click();
  await expect(page.locator("#hermes-profile")).toBeDisabled();
  await expect.poll(() => new URL(page.url()).searchParams.get("profile")).toBe("profile-alpha");
  expectNoClientErrors(diagnostics);
});
