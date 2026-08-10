import { expect, test, type Page } from "@playwright/test";

const sections = [
  "Get Started",
  "Concepts",
  "Database",
  "Functions",
  "Clients",
  "Authentication & Access",
  "Realtime",
  "Files",
  "Jobs & Services",
  "Plugins",
  "HTTP & MCP",
  "Deploy & Operate",
  "Recipes",
  "Reference",
] as const;

async function openDocumentation(page: Page, path: string) {
  const response = await page.goto(path);
  await page.waitForLoadState("networkidle");
  return response;
}

function captureBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("renders static documentation dark-first with the complete accordion navigation", async ({
  page,
}, testInfo) => {
  const response = await openDocumentation(page, "/docs");

  expect(response?.ok()).toBe(true);
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(page.getByRole("button", { name: "Toggle site theme" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Introduction" })).toBeVisible();

  const sidebar = page.getByTestId("docs-sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator('[data-slot="accordion-trigger"]')).toHaveCount(sections.length);

  for (const section of sections) {
    await expect(sidebar.getByRole("button", { name: section, exact: true })).toBeVisible();
  }
  await expect(sidebar.locator(".lucide-book-open")).toBeVisible();
  await expect(sidebar.locator(".lucide-database")).toBeVisible();
  await expect(
    sidebar.locator('nav[aria-label="Documentation"] [aria-current="page"]'),
  ).toHaveCount(1);

  const getStarted = sidebar.getByRole("button", { name: "Get Started", exact: true });
  const concepts = sidebar.getByRole("button", { name: "Concepts", exact: true });

  await expect(getStarted).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.locator('[data-slot="accordion-trigger"][aria-expanded="true"]')).toHaveCount(1);

  await concepts.focus();
  await concepts.press("Enter");
  await expect(concepts).toHaveAttribute("aria-expanded", "true");
  await expect(getStarted).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.locator('[data-slot="accordion-trigger"][aria-expanded="true"]')).toHaveCount(1);
  await concepts.press("Tab");
  await expect(sidebar.getByRole("link", { name: "Application Model", exact: true })).toBeFocused();

  const reducedMotionDuration = await sidebar
    .locator('[data-slot="accordion-content"]')
    .first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(reducedMotionDuration).toBe("0.001s");

  await testInfo.attach("desktop-documentation", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await expect(page).toHaveScreenshot("documentation-dark-desktop.png", {
    animations: "disabled",
  });
});

test("searches pages from the command palette and runs the theme command", async ({ page }) => {
  await openDocumentation(page, "/docs");
  await page.getByRole("button", { name: "Search documentation" }).click();
  await expect(page.getByRole("dialog", { name: "Command Palette" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+K");

  let palette = page.getByRole("dialog", { name: "Command Palette" });
  await expect(palette).toBeVisible();
  const searchInput = palette.getByRole("combobox", { name: /search/i });
  await searchInput.fill("Installation");
  await expect(palette.getByText("Installation", { exact: true })).toBeVisible();
  await searchInput.press("Enter");
  await expect(page).toHaveURL(/\/docs\/installation$/);
  await expect(page.getByRole("heading", { level: 1, name: "Installation" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+K");
  palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette.getByRole("combobox", { name: /search/i }).fill("defineTable");
  const defineTableResult = palette
    .getByRole("option")
    .filter({ hasText: "defineTable" })
    .filter({ hasText: "Basic Usage · Declare The Todos Schema" });
  await expect(defineTableResult).toHaveCount(1);
  await defineTableResult.click();
  await expect(page).toHaveURL(/\/docs\/basic-usage#declare-the-todos-schema$/);

  await page.keyboard.press("ControlOrMeta+K");
  palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette.getByRole("combobox", { name: /search/i }).fill("Connect React");
  await palette.getByText("Connect React", { exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/basic-usage#connect-react$/);

  await page.keyboard.press("ControlOrMeta+K");
  palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette
    .getByRole("combobox", { name: /search/i })
    .fill("server application owns backend declarations");
  await palette.getByText(/server application owns backend declarations/i).click();
  await expect(page).toHaveURL(/\/docs\/basic-usage#use-one-ownership-layout$/);

  await page.keyboard.press("ControlOrMeta+K");
  palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette.getByRole("combobox", { name: /search/i }).fill("copy page markdown");
  await palette.getByText("Copy page Markdown", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(
    "# Basic Usage",
  );

  await page.keyboard.press("ControlOrMeta+K");
  palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette.getByRole("combobox", { name: /search/i }).fill("edit github");
  const popupPromise = page.waitForEvent("popup");
  await palette.getByText("Edit on GitHub", { exact: true }).click();
  const github = await popupPromise;
  await expect
    .poll(() => {
      const url = new URL(github.url());
      return url.searchParams.get("return_to") ?? url.href;
    })
    .toMatch(/github\.com\/pedrobzz\/ackerdb\/edit\/main\/website\/content\/docs/);
  await github.close();
  await page.bringToFront();
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+K");
  palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette.getByRole("combobox", { name: /search/i }).fill("canary");
  await palette.getByText("Open Canary", { exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/canary\/basic-usage$/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: "Basic Usage" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+K");
  palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette.getByRole("combobox", { name: /search/i }).fill("Installation");
  await expect(palette.getByText("Installation", { exact: true })).toBeVisible();
  await palette.getByText("Installation", { exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/canary\/installation$/);

  await page.keyboard.press("ControlOrMeta+K");
  palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette.getByRole("combobox", { name: /search/i }).fill("theme");
  await palette.getByText(/toggle.*theme/i).click();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);

  await page.goto("/docs?unavailable=%2Ffuture-page");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("This page is unavailable")).toBeVisible();
  await expect(page).toHaveScreenshot("documentation-light.png", {
    animations: "disabled",
  });

  await page.keyboard.press("ControlOrMeta+K");
  palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette.getByRole("combobox", { name: /search/i }).fill("view page markdown");
  await palette.getByText("View page as Markdown", { exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/index\.md$/);
  await expect(page.locator("body")).toContainText("# Introduction");
});

test("hydrates a persisted light theme without replacing static markup", async ({ page }) => {
  const browserErrors = captureBrowserErrors(page);
  await openDocumentation(page, "/docs");

  await page.getByRole("button", { name: "Toggle site theme" }).click();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await page.reload();
  await page.waitForLoadState("networkidle");

  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  expect(browserErrors).toEqual([]);
});

test("hydrates a direct missing-version fallback without replacing static markup", async ({
  page,
}) => {
  const browserErrors = captureBrowserErrors(page);
  await openDocumentation(page, "/docs?unavailable=%2Ffuture-page");

  await expect(page.getByText("This page is unavailable")).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("switches between Latest and Canary while preserving the page route", async ({ page }) => {
  await openDocumentation(page, "/docs/installation");

  const versionSelector = page.getByRole("button", { name: "Select documentation version" });
  await versionSelector.click();
  await page.getByRole("menuitem", { name: "Canary", exact: true }).click();

  await expect(page).toHaveURL(/\/docs\/canary\/installation$/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: "Installation" })).toBeVisible();
  await expect(versionSelector).toContainText("Canary");

  await page.getByRole("link", { name: "Basic Usage", exact: true }).last().click();
  await expect(page).toHaveURL(/\/docs\/canary\/basic-usage$/);

  await versionSelector.click();
  await page.getByRole("menuitem", { name: /Latest/ }).click();
  await expect(page).toHaveURL(/\/docs\/basic-usage$/);
});

test("navigates from the generated sidebar tree to authored documentation", async ({ page }) => {
  await openDocumentation(page, "/docs/application-model");

  await expect(page.getByRole("heading", { level: 1, name: "Application Model" })).toBeVisible();
  await expect(page.getByText(/coming soon/i)).toHaveCount(0);

  const sidebar = page.getByTestId("docs-sidebar");
  await expect(
    sidebar.getByRole("button", { name: "Concepts", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    sidebar.getByRole("button", { name: "Get Started", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await sidebar.getByRole("button", { name: "Functions", exact: true }).click();
  await sidebar.getByRole("link", { name: "Queries", exact: true }).click();

  await expect(page).toHaveURL(/\/docs\/queries$/);
  await expect(page.getByRole("heading", { level: 1, name: "Queries" })).toBeVisible();
  await expect(page.getByText(/coming soon/i)).toHaveCount(0);
});

test("reveals nested page children only inside their active documentation branch", async ({
  page,
}) => {
  await openDocumentation(page, "/docs/installing-plugins");

  const sidebar = page.getByTestId("docs-sidebar");
  await expect(sidebar.getByRole("link", { name: "Cache", exact: true })).toBeVisible();
  await expect(
    sidebar.getByRole("link", { name: "External Cache Adapters", exact: true }),
  ).toHaveCount(0);

  await sidebar.getByRole("link", { name: "Cache", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/cache-plugin$/);
  await expect(
    sidebar.getByRole("link", { name: "External Cache Adapters", exact: true }),
  ).toBeVisible();

  await sidebar.getByRole("link", { name: "External Cache Adapters", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/external-cache-adapters$/);
  await expect(
    sidebar.locator('nav[aria-label="Documentation"] [aria-current="page"]'),
  ).toHaveCount(1);
});

test("does not substitute current content for an unpublished historical version", async ({
  page,
}) => {
  const response = await page.goto("/docs/0.1.0");

  expect(response?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { level: 1, name: "This page does not exist." }),
  ).toBeVisible();
  await expect(page.getByText("AckerDB is the backend that stays in your application")).toHaveCount(0);
});

test("supports keyboard access, page actions, code blocks, and heading navigation", async ({
  page,
}) => {
  await openDocumentation(page, "/docs/basic-usage");

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await expect(skipLink).toBeFocused();
  await skipLink.press("Enter");
  await expect(page.locator("#docs-content")).toBeFocused();

  const codeBlock = page.locator("figure.shiki").filter({ hasText: "apps/server/app.ts" });
  await expect(codeBlock).toBeVisible();
  await expect(codeBlock.getByText("TypeScript", { exact: true })).toBeVisible();
  await expect(page.locator("figure.shiki").filter({ hasText: "Terminal" }).first()).toContainText(
    "Shell",
  );
  await expect(page.locator("figure.shiki").filter({ hasText: "apps/" }).first()).toContainText(
    "Text",
  );
  expect(
    await codeBlock.evaluate((element) => {
      const style = getComputedStyle(element);
      return { borderRadius: style.borderRadius, boxShadow: style.boxShadow };
    }),
  ).toEqual({ borderRadius: "0px", boxShadow: "none" });
  await expect(codeBlock.locator(".highlighted")).toHaveCount(1);

  await codeBlock.getByRole("button", { name: "Copy Text" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("defineApp");

  await page.getByRole("button", { name: "Copy Markdown" }).click();
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("# Basic Usage");

  await expect(page.getByRole("link", { name: "Edit on GitHub" })).toHaveAttribute(
    "href",
    /github\.com\/pedrobzz\/ackerdb\/edit\/main\/website\/content\/docs/,
  );
  const pageNavigation = page.getByRole("navigation", { name: "Documentation pages" });
  await expect(pageNavigation.getByRole("link", { name: /Previous.*Installation/ })).toBeVisible();
  await expect(pageNavigation.getByRole("link", { name: /Next.*Project Structure/ })).toBeVisible();

  const tableOfContents = page.getByRole("complementary", { name: "On this page" });
  await tableOfContents.getByRole("link", { name: "Connect React" }).click();
  await expect(page).toHaveURL(/#connect-react$/);
  await expect(page.locator("#connect-react")).toBeInViewport();
  await expect(tableOfContents.getByRole("link", { name: "Connect React" })).toHaveAttribute(
    "data-active",
    "true",
  );
});

test.describe("tablet documentation", () => {
  test.use({ viewport: { width: 1100, height: 800 } });

  test("uses a navigation drawer while retaining the table of contents", async ({ page }, testInfo) => {
    await openDocumentation(page, "/docs/basic-usage");

    await expect(page.getByTestId("docs-sidebar")).toBeHidden();
    await expect(page.getByTestId("mobile-docs-trigger")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "On this page" })).toBeVisible();
    await expect(page.getByTestId("mobile-on-this-page")).toBeHidden();

    await testInfo.attach("tablet-documentation", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await expect(page).toHaveScreenshot("documentation-dark-tablet.png", {
      animations: "disabled",
    });
  });
});

test.describe("mobile documentation", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("moves navigation into a drawer and the table of contents below the introduction", async ({
    page,
  }, testInfo) => {
    await openDocumentation(page, "/docs/basic-usage");

    await expect(page.getByTestId("docs-sidebar")).toBeHidden();
    await page.getByTestId("mobile-docs-trigger").click();

    const drawer = page.locator('[data-slot="sheet-content"]');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Get Started", exact: true })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Basic Usage", exact: true })).toBeVisible();

    await page.keyboard.press("Escape");
    const mobileToc = page.getByTestId("mobile-on-this-page");
    await expect(mobileToc).toBeVisible();
    await mobileToc.getByRole("button", { name: /on this page/i }).click();
    await expect(mobileToc.getByRole("link", { name: "Use one ownership layout" })).toBeVisible();

    await testInfo.attach("mobile-documentation", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await expect(page).toHaveScreenshot("documentation-dark-mobile.png", {
      animations: "disabled",
    });
  });
});

test.describe("motion timing", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  test("keeps interactive motion within the 250 millisecond budget", async ({ page }) => {
    await openDocumentation(page, "/docs");

    const durations = await page
      .getByTestId("docs-sidebar")
      .locator('[data-slot="accordion-content"]')
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return `${style.transitionDuration},${style.animationDuration}`
          .split(",")
          .map((duration) => duration.trim())
          .filter(Boolean)
          .map((duration) =>
            duration.endsWith("ms")
              ? Number.parseFloat(duration)
              : Number.parseFloat(duration) * 1_000,
          );
      });

    expect(Math.max(...durations)).toBeGreaterThan(0);
    expect(Math.max(...durations)).toBeLessThanOrEqual(250);
  });
});
