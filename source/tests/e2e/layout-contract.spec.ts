import { expect, expectNoClientErrors, settlePage, test } from "./support/fixtures";

test.describe("original information architecture contract", () => {
  test("desktop shell keeps the original 244px sidebar and content position", async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await settlePage(page);

    const sidebar = page.locator("[data-agent-os-sidebar]");
    const main = page.locator("[data-agent-os-main]");
    const sidebarBox = await sidebar.boundingBox();
    const mainBox = await main.boundingBox();

    expect(sidebarBox?.width).toBe(244);
    expect(mainBox?.x).toBe(244);
    expect(await sidebar.locator("a").evaluateAll((links) => links.slice(0, 5).map((link) => link.getAttribute("href")))).toEqual([
      "/",
      "/",
      "/paperclip",
      "/room",
      "/pipeline",
    ]);

    const overviewSections = await page.locator("main .eyebrow .label").evaluateAll((labels) =>
      labels.map((label) => label.textContent?.replace(/\s+/g, " ").trim()),
    );
    expect(overviewSections).toEqual([
      "Mission Control",
      "Today · tick it off",
      "Agents · click to open control room",
      "Token usage · what each agent is burning",
      "Self · grounded in your Obsidian vault",
      "Live activity · combined log stream",
    ]);
    expectNoClientErrors(diagnostics);
  });

  test("Claude keeps the original agent workspace and tab order", async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/claude", { waitUntil: "domcontentloaded" });
    await settlePage(page);

    const workspace = page.locator('[data-agent-workspace="claude"]');
    await expect(workspace).toBeVisible();
    const agentSidebarBox = await workspace.locator('[data-agent-sidebar="claude"]').boundingBox();
    expect(agentSidebarBox?.width).toBe(276);

    const tabs = await workspace.locator(".scroll-rail").first().locator(":scope > button").evaluateAll((buttons) =>
      buttons.map((button) =>
        Array.from(button.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(" ")
          .trim(),
      ),
    );
    expect(tabs.map((label) => label.trim())).toEqual([
      "Chat",
      "Sessions",
      "Workspace",
      "Artifacts",
      "Ultracode",
      "Ant CLI",
      "Agents",
    ]);
    expectNoClientErrors(diagnostics);
  });

  const lockedAgentTabOrders = [
    {
      agent: "codex",
      route: "/codex",
      labels: ["Chat", "Goal Mode", "Sessions", "Workspace"],
    },
    {
      agent: "hermes",
      route: "/hermes",
      labels: [
        "Chat",
        "Profiles",
        "Apollo",
        "Hermes Oracle",
        "Hermes Muse",
        "Hermes Astros",
        "Studio",
        "Sessions",
        "Outreach",
        "Mixture",
        "Workspace",
        "MCPs",
        "Manage",
        "Control Room",
        "Goal Mode",
      ],
    },
    {
      agent: "openclaw",
      route: "/openclaw",
      labels: ["Chat", "Sessions", "Studio", "Workspace", "Control Room"],
    },
  ] as const;

  for (const surface of lockedAgentTabOrders) {
    test(`${surface.agent} keeps original agent workspace and tab order`, async ({ page, diagnostics }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(surface.route, { waitUntil: "domcontentloaded" });
      await settlePage(page);

      const workspace = page.locator(`[data-agent-workspace="${surface.agent}"]`);
      await expect(workspace).toBeVisible();
      const agentSidebarBox = await workspace.locator(`[data-agent-sidebar="${surface.agent}"]`).boundingBox();
      expect(agentSidebarBox?.width).toBe(276);

      const tabs = await workspace.locator(".scroll-rail").first().locator(":scope > button").evaluateAll((buttons) =>
        buttons.map((button) =>
          Array.from(button.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent ?? "")
            .join(" ")
            .trim(),
        ),
      );
      expect(tabs.map((label) => label.trim())).toEqual(surface.labels);
      expectNoClientErrors(diagnostics);
    });
  }

  test("mobile keeps the original bottom navigation and single content surface", async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await settlePage(page);

    await expect(page.locator("[data-agent-os-sidebar]")).toBeHidden();
    await expect(page.locator("[data-agent-os-mobile-nav]")).toBeVisible();
    const mainBox = await page.locator("[data-agent-os-main]").boundingBox();
    expect(mainBox?.x).toBe(0);
    expect(mainBox?.width).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expectNoClientErrors(diagnostics);
  });

  test("mobile full menu traps focus, closes on Escape, and restores the trigger", async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await settlePage(page);

    const trigger = page.getByRole("button", { name: "Open full menu" });
    await trigger.click();

    const dialog = page.getByRole("dialog", { name: /all sections/i });
    const closeButton = page.getByRole("button", { name: "Close menu" });
    const main = page.locator("[data-agent-os-main]");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(closeButton).toBeFocused();
    await expect(main).toHaveAttribute("inert", "");
    await expect(main).toHaveAttribute("aria-hidden", "true");

    const lastLink = dialog.getByRole("link").last();
    await page.keyboard.press("Shift+Tab");
    await expect(lastLink).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(closeButton).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await main.getAttribute("inert")).toBeNull();
    expect(await main.getAttribute("aria-hidden")).toBeNull();

    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("[data-agent-os-sidebar]")).toBeVisible();
    expect(await main.getAttribute("inert")).toBeNull();
    expect(await main.getAttribute("aria-hidden")).toBeNull();
    expect(await page.locator("[data-agent-os-sidebar]").getAttribute("inert")).toBeNull();
    expect(await page.locator("[data-agent-os-sidebar]").getAttribute("aria-hidden")).toBeNull();
    expectNoClientErrors(diagnostics);
  });
});
