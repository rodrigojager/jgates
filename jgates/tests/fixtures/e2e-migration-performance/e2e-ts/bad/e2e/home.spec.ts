import { expect, test } from "@playwright/test";

test("the home page shows the store name", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("JGates Shop", { timeout: 3000 });
});
