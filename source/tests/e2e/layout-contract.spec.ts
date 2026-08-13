import { expect, expectNoClientErrors, settlePage, test } from "./support/fixtures";
import { PUBLIC_ROUTES } from "./support/routes";
import type { Page } from "@playwright/test";

const IMMERSIVE_SURFACES = [
  {
    agent: "codex",
    route: "/codex",
    root: '[data-agent-desktop="codex"]',
    composer: 'textarea[aria-label="Message Codex"]',
    mobileTrigger: "Open sessions",
    mobileDrawer: 'aside[aria-label="Codex projects and sessions"]',
    modalDrawer: true,
  },
  {
    agent: "claude",
    route: "/claude",
    root: '[data-agent-page="claude"][data-agent-experience="immersive"]',
    composer: 'textarea[aria-label="Message Claude"]',
    mobileTrigger: "Open sessions",
    mobileDrawer: 'aside[aria-label="Claude projects and sessions"]',
    modalDrawer: true,
  },
  {
    agent: "hermes",
    route: "/hermes",
    root: '[data-agent-page="hermes"][data-agent-experience="immersive"]',
    composer: 'textarea[aria-label="Message Hermes"]',
    mobileTrigger: "Open Hermes navigation",
    mobileDrawer: 'aside[aria-label="Hermes profiles and conversations"]',
    modalDrawer: true,
  },
  {
    agent: "openclaw",
    route: "/openclaw",
    root: '[data-agent-page="openclaw"][data-active-tab="chat"]',
    composer: 'textarea[aria-label^="Message "]',
    mobileTrigger: "Open OpenClaw navigation",
    mobileDrawer: 'aside[aria-label="OpenClaw navigation"]',
    modalDrawer: false,
  },
  {
    agent: "antigravity",
    route: "/antigravity",
    root: '[data-agent-page="antigravity"][data-active-tab="agent"]',
    composer: 'textarea[aria-label="Message Antigravity"]',
    mobileTrigger: "Open projects",
    mobileDrawer: 'aside[aria-label="Antigravity projects"]',
    modalDrawer: false,
  },
] as const;

const IMMERSIVE_ROUTES = new Set<string>(IMMERSIVE_SURFACES.map(({ route }) => route));
const STANDARD_ROUTES = PUBLIC_ROUTES.filter((route) => !IMMERSIVE_ROUTES.has(route));

async function installSurfaceContractMocks(page: Page, agent: string) {
  if (agent !== "antigravity") return;
  await page.route("**/api/antigravity/workspace**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("kind") && url.searchParams.has("project")) {
      await route.fulfill({ json: { root: "C:\\qa\\antigravity", files: [] } });
      return;
    }
    await route.fulfill({
      json: {
        projects: [{
          name: "qa-project",
          root: "C:\\qa\\antigravity",
          mtime: Date.now(),
          fileCount: 0,
          kind: "scratch",
        }],
      },
    });
  });
}

test.describe("Agentic OS layout contract", () => {
  test("standard desktop shell keeps the global navigation rail", async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await settlePage(page);

    const shell = page.locator('[data-agent-os-shell][data-shell-mode="standard"]');
    const sidebar = shell.locator("[data-agent-os-sidebar]");
    const main = shell.locator("[data-agent-os-main]");
    await expect(shell).toHaveCount(1);
    await expect(sidebar).toBeVisible();
    await expect(main).toBeVisible();

    const sidebarBox = await sidebar.boundingBox();
    const mainBox = await main.boundingBox();
    expect(sidebarBox?.width).toBe(244);
    expect(mainBox?.x).toBe(244);
    expectNoClientErrors(diagnostics);
  });

  for (const route of STANDARD_ROUTES) {
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

  for (const surface of IMMERSIVE_SURFACES) {
    test(`${surface.agent} owns its native full-screen workspace`, async ({ page, diagnostics }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await installSurfaceContractMocks(page, surface.agent);
      await page.goto(surface.route, { waitUntil: "domcontentloaded" });
      await settlePage(page);

      const shell = page.locator('[data-agent-os-shell][data-shell-mode="immersive-agent"]');
      const main = shell.locator(`[data-agent-os-main][data-immersive-agent="${surface.agent}"]`);
      const workspace = main.locator(surface.root);
      await expect(shell).toHaveCount(1);
      await expect(main).toHaveCount(1);
      await expect(workspace).toBeVisible();
      await expect(workspace.locator(surface.composer)).toBeVisible();
      await expect(page.locator("[data-agent-os-sidebar]")).toHaveCount(0);
      await expect(page.locator("[data-agent-os-mobile-nav]")).toHaveCount(0);
      await expect(page.locator("[data-agent-workspace]")).toHaveCount(0);
      await expect(page.locator("[data-unified-chat]")).toHaveCount(0);

      const mainBox = await main.boundingBox();
      const dockBox = await shell.locator(".agent-system-dock").boundingBox();
      const workspaceBox = await workspace.boundingBox();
      expect(workspaceBox?.width).toBe(1440);
      expect(workspaceBox?.height).toBe(mainBox?.height);
      expect(mainBox?.height).toBe(848);
      expect(dockBox?.height).toBe(52);
      expect((workspaceBox?.y ?? 0) + (workspaceBox?.height ?? 0)).toBeLessThanOrEqual(dockBox?.y ?? 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900);
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
    await expect(page.locator('[data-agent-desktop="codex"]')).toBeVisible();
    await expect(page.getByText("This page couldn’t load")).toHaveCount(0);
    expectNoClientErrors(diagnostics);
  });

  test("native immersive controls switch their real work surfaces", async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto("/codex", { waitUntil: "domcontentloaded" });
    await settlePage(page);
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.locator('[data-agent-desktop="codex"] section[aria-label="Review changes"]')).toBeVisible();

    await page.goto("/openclaw", { waitUntil: "domcontentloaded" });
    await settlePage(page);
    await page.getByRole("button", { name: "Coding", exact: true }).click();
    await expect(page.locator('[data-agent-page="openclaw"][data-active-tab="coding"]')).toBeVisible();

    await installSurfaceContractMocks(page, "antigravity");
    await page.goto("/antigravity", { waitUntil: "domcontentloaded" });
    await settlePage(page);
    await expect(page.locator('aside[aria-label="Antigravity artifacts"]')).toBeVisible();
    expectNoClientErrors(diagnostics);
  });

  test("Ctrl Shift A opens exactly five agent choices and restores focus", async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/codex", { waitUntil: "domcontentloaded" });
    await settlePage(page);

    const trigger = page.getByRole("button", { name: /Switch agent\. Current agent:/ });
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await page.keyboard.press("Control+Shift+A");

    const switcher = page.locator('[data-agent-switcher][data-open="true"]');
    const dialog = switcher.getByRole("dialog", { name: "Switch agent" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".agent-switcher-options > button")).toHaveCount(5);
    await expect(dialog.getByRole("button", { name: /Codex/ })).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: /Claude/ })).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: /Hermes/ })).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: /OpenClaw/ })).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: /Antigravity/ })).toHaveCount(1);
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expectNoClientErrors(diagnostics);
  });

  test("named model routes use the standard shell", async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const route of ["/glm", "/kimi", "/freeclaude"] as const) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await settlePage(page);
      await expect(page.locator('[data-agent-os-shell][data-shell-mode="standard"]')).toHaveCount(1);
      await expect(page.locator("[data-agent-os-sidebar]")).toBeVisible();
      await expect(page.locator('[data-shell-mode="immersive-agent"]')).toHaveCount(0);
    }
    expectNoClientErrors(diagnostics);
  });

  test("standard mobile routes retain the global bottom navigation", async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await settlePage(page);

    await expect(page.locator("[data-agent-os-sidebar]")).toBeHidden();
    await expect(page.locator("[data-agent-os-mobile-nav]")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expectNoClientErrors(diagnostics);
  });

  for (const surface of IMMERSIVE_SURFACES) {
    test(`${surface.agent} mobile navigation traps focus and restores its trigger`, async ({ page, diagnostics }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await installSurfaceContractMocks(page, surface.agent);
      await page.goto(surface.route, { waitUntil: "domcontentloaded" });
      await settlePage(page);

      await expect(page.locator("[data-agent-os-mobile-nav]")).toHaveCount(0);
      const trigger = page.getByRole("button", { name: surface.mobileTrigger, exact: true });
      const drawer = page.locator(surface.mobileDrawer);
      await expect(trigger).toBeVisible();
      await expect(drawer).not.toBeInViewport();

      await trigger.click();
      await expect(drawer).toBeInViewport();
      if (surface.modalDrawer) await expect(drawer).toHaveAttribute("aria-modal", "true");
      expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);

      await page.keyboard.press("Escape");
      await expect(drawer).not.toBeInViewport();
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
