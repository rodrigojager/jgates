import { expect, test, type Page } from "@playwright/test";
import { createFixture, openApp, startServer } from "./support";

// The generic Stepper as the Semantic setup uses it: a numbered list, the current step marked with aria-current, steps
// reachable by click and by keyboard, and a screen that checks the machine again when the person comes back to the tab.

async function withApp(page: Page, body: (base: string) => Promise<void>) {
  const fixture = createFixture();
  const server = await startServer(fixture);
  try {
    const base = await openApp(page, server);
    await body(base);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
}

test("the Semantic setup steps are a Stepper: one current step, moving with the buttons and the keyboard", async ({ page }) => {
  await withApp(page, async (base) => {
    await page.goto(`${base}#/semantic/setup`);
    const nav = page.getByRole("navigation", { name: "Etapas da preparação" });
    await expect(nav).toBeVisible();
    const items = nav.locator("ol.stepper > li button");
    await expect(items).toHaveCount(4);
    // One step is current at a time, and the others are not.
    await expect(nav.locator('[aria-current="step"]')).toHaveCount(1);
    const current = await nav.locator('[aria-current="step"]').getAttribute("data-step");
    expect(["provider", "scope"]).toContain(current);
    // Without a configured provider only the provider step can be opened; with one, the scope step is current.
    if (current === "scope") {
      await page.getByRole("button", { name: "Avançar" }).click();
      await expect(nav.locator('[aria-current="step"]')).toHaveAttribute("data-step", "choices");
      await nav.locator('button[data-step="scope"]').focus();
      await page.keyboard.press("Enter");
      await expect(nav.locator('[aria-current="step"]')).toHaveAttribute("data-step", "scope");
      await expect(nav.locator('button[data-step="scope"]')).toHaveAttribute("data-state", "current");
    }
  });
});

test("a screen with the environment state checks again when the tab becomes visible, without a restart", async ({ page }) => {
  await withApp(page, async (base) => {
    const first = page.waitForResponse((r) => r.url().includes("/api/environment/state") && r.request().method() === "GET");
    await page.goto(`${base}#/environment`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await first;
    const again = page.waitForResponse((r) => r.url().includes("/api/environment/state") && r.request().method() === "GET", { timeout: 15_000 });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect((await again).ok()).toBe(true);
  });
});
