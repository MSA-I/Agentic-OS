import { expect, expectNoClientErrors, settlePage, test } from "./support/fixtures";

const IMMERSIVE_AGENTS = [
  {
    agent: "claude",
    route: "/claude",
    targets: ["chat", "history", "workspace", "artifacts", "ultracode", "ant", "agents"],
  },
  {
    agent: "codex",
    route: "/codex",
    targets: ["chat", "sessions", "goal", "workspace"],
  },
  {
    agent: "hermes",
    route: "/hermes",
    targets: ["chat", "profiles", "sessions", "radar", "muse", "astros", "apollo", "studio", "goals", "outreach", "moa", "workspace", "mcps", "control", "manage"],
  },
  {
    agent: "openclaw",
    route: "/openclaw",
    targets: ["chat", "sessions", "studio", "workspace", "control"],
  },
  {
    agent: "glm",
    route: "/glm",
    targets: ["chat", "workspace"],
  },
  {
    agent: "kimi",
    route: "/kimi",
    targets: ["chat", "workspace"],
  },
  {
    agent: "antigravity",
    route: "/antigravity",
    targets: ["chat", "history", "workspace"],
  },
  {
    agent: "freeclaude",
    route: "/freeclaude",
    targets: ["chat", "workspace", "factory"],
  },
] as const;

const COMPOSER_SELECTORS: Record<(typeof IMMERSIVE_AGENTS)[number]["agent"], string> = {
  claude: '[data-unified-chat="claude"] textarea',
  codex: "[data-codex-view] textarea",
  hermes: '[data-unified-chat="hermes"] textarea',
  openclaw: '[data-unified-chat="openclaw"] textarea',
  glm: '[data-agent-model-view="glm"] textarea',
  kimi: '[data-agent-model-view="kimi"] textarea',
  antigravity: '[data-unified-chat="antigravity"] textarea',
  freeclaude: ".agent-freeclaude-panel textarea",
};

test.describe("Agentic OS layout contract", () => {
  test("standard desktop routes keep the 244px global sidebar", async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await settlePage(page);

    const shell = page.locator('[data-agent-os-shell][data-shell-mode="standard"]');
    const sidebarBox = await shell.locator("[data-agent-os-sidebar]").boundingBox();
    const mainBox = await shell.locator("[data-agent-os-main]").boundingBox();
    expect(sidebarBox?.width).toBe(244);
    expect(mainBox?.x).toBe(244);
    expectNoClientErrors(diagnostics);
  });

  for (const surface of IMMERSIVE_AGENTS) {
    test(`${surface.agent} owns a single full-height immersive workspace`, async ({ page, diagnostics }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(surface.route, { waitUntil: "domcontentloaded" });
      await settlePage(page);

      const shell = page.locator('[data-agent-os-shell][data-shell-mode="immersive-agent"]');
      const workspace = shell.locator(`[data-agent-workspace="${surface.agent}"][data-agent-experience="immersive"]`);
      await expect(shell).toHaveCount(1);
      await expect(page.locator("[data-agent-os-sidebar]")).toHaveCount(0);
      await expect(page.locator("[data-agent-os-mobile-nav]")).toHaveCount(0);
      await expect(workspace.locator(`[data-agent-sidebar="${surface.agent}"]`)).toHaveCount(1);
      await expect(workspace.locator("[data-agent-os-home]")).toBeVisible();

      const workspaceBox = await workspace.boundingBox();
      const sidebarBox = await workspace.locator(`[data-agent-sidebar="${surface.agent}"]`).boundingBox();
      expect(workspaceBox?.height).toBe(900);
      expect(sidebarBox?.width).toBe(236);

      for (let index = 0; index < 8; index += 1) {
        const closedToggle = workspace.locator('[data-navigation-group-toggle][aria-expanded="false"]').first();
        if (await closedToggle.count() === 0) break;
        await closedToggle.evaluate((element) => (element as HTMLButtonElement).click());
      }
      const targets = await workspace.locator("[data-workspace-target]").evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-workspace-target")),
      );
      expect(targets).toHaveLength(surface.targets.length);
      expect(new Set(targets)).toEqual(new Set(surface.targets));
      await expect(workspace.locator(COMPOSER_SELECTORS[surface.agent])).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900);
      expectNoClientErrors(diagnostics);
    });
  }

  for (const route of ["/opencode", "/glm-code"] as const) {
    test(`${route} remains in the standard shell`, async ({ page, diagnostics }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await settlePage(page);

      await expect(page.locator('[data-agent-os-shell][data-shell-mode="standard"]')).toHaveCount(1);
      await expect(page.locator("[data-agent-os-sidebar]")).toBeVisible();
      await expect(page.locator('[data-shell-mode="immersive-agent"]')).toHaveCount(0);
      expectNoClientErrors(diagnostics);
    });
  }

  test("codex tolerates legacy local workspace storage without crashing", async ({ page, diagnostics }) => {
    await page.addInitScript(() => {
      localStorage.setItem("agentic-os:codex:local-sessions:v2", JSON.stringify({ legacy: true }));
      localStorage.setItem("agentic-os:codex:pinned-sessions:v2", JSON.stringify({ legacy: true }));
      localStorage.setItem("agentic-os:codex:navigation-groups:v2", JSON.stringify([]));
    });
    await page.goto("/codex", { waitUntil: "domcontentloaded" });
    await settlePage(page);
    await expect(page.locator('[data-agent-workspace="codex"]')).toBeVisible();
    await expect(page.getByText("This page couldn’t load")).toHaveCount(0);
    expectNoClientErrors(diagnostics);
  });

  for (const surface of [
    { agent: "openclaw", route: "/openclaw", target: "studio", content: '[data-agent-page="openclaw"][data-active-tab="studio"]' },
    { agent: "glm", route: "/glm", target: "workspace", content: '[data-agent-model-view="glm"][data-active-tab="workspace"]' },
    { agent: "kimi", route: "/kimi", target: "workspace", content: '[data-agent-model-view="kimi"][data-active-tab="workspace"]' },
    { agent: "antigravity", route: "/antigravity", target: "workspace", content: '[data-agent-page="antigravity"][data-active-tab="workspace"]' },
    { agent: "freeclaude", route: "/freeclaude", target: "factory", content: '[data-agent-page="freeclaude"][data-active-tab="factory"]' },
  ] as const) {
    test(`${surface.agent} sidebar drives its existing workspace modes`, async ({ page, diagnostics }) => {
      await page.goto(surface.route, { waitUntil: "domcontentloaded" });
      await settlePage(page);
      const workspace = page.locator(`[data-agent-workspace="${surface.agent}"]`);
      for (let index = 0; index < 8; index += 1) {
        const closedToggle = workspace.locator('[data-navigation-group-toggle][aria-expanded="false"]').first();
        if (await closedToggle.count() === 0) break;
        await closedToggle.click();
      }
      const control = workspace.locator(`[data-workspace-target="${surface.target}"]`);
      await control.click();
      await expect(control).toHaveAttribute("aria-current", "page");
      await expect(page.locator(surface.content)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`workspaceTarget=${surface.target}`));
      expectNoClientErrors(diagnostics);
    });
  }

  test("standard mobile routes retain the global bottom navigation", async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await settlePage(page);

    await expect(page.locator("[data-agent-os-sidebar]")).toBeHidden();
    await expect(page.locator("[data-agent-os-mobile-nav]")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expectNoClientErrors(diagnostics);
  });

  for (const surface of IMMERSIVE_AGENTS) {
    test(`${surface.agent} mobile drawer traps focus and restores the trigger`, async ({ page, diagnostics }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(surface.route, { waitUntil: "domcontentloaded" });
      await settlePage(page);

      await expect(page.locator("[data-agent-os-mobile-nav]")).toHaveCount(0);
      const trigger = page.locator(`[data-agent-sidebar-toggle="${surface.agent}"]`);
      const sidebar = page.locator(`[data-agent-sidebar="${surface.agent}"]`);
      await expect(trigger).toBeVisible();
      await expect(sidebar).toBeHidden();
      await trigger.click();
      await expect(sidebar).toBeVisible();
      await expect(sidebar).toHaveAttribute("aria-modal", "true");
      expect(await sidebar.evaluate((element) => element.contains(document.activeElement))).toBe(true);

      await page.keyboard.press("Escape");
      await expect(sidebar).toBeHidden();
      await expect(trigger).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
      expectNoClientErrors(diagnostics);
    });
  }

  test("standard mobile menu still traps focus and closes on Escape", async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await settlePage(page);

    const trigger = page.getByRole("button", { name: "Open full menu" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: /all sections/i });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expectNoClientErrors(diagnostics);
  });
});
