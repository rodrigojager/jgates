import { expect, test, type Locator, type Page } from "@playwright/test";
import { createFixture, openApp, startServer, type Fixture, type UiServer } from "./support";

// Every action shows progress and the screen updates from the answer of the write. The calls are delayed in the browser
// (the same effect as the fake engine behind a delay: the server answers late), so a control that does not show its
// busy state, or a screen that asks again after a write, shows up here.

const DELAY_MS = 700;
const BUSY_WITHIN_MS = 100;

async function withServer(run: (ctx: { fixture: Fixture; server: UiServer }) => Promise<void>): Promise<void> {
  const fixture = createFixture();
  let server: UiServer | null = null;
  try {
    server = await startServer(fixture);
    await run({ fixture, server });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

/** Delays every write (and, when `reads` is set, the view of the Perfil screen) before it reaches the server. */
async function delayCalls(page: Page, state: { reads: number }): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const write = request.method() !== "GET" && pathname !== "/api/session";
    const view = request.method() === "GET" && pathname === "/api/config/profile";
    const wait = write ? DELAY_MS : view ? state.reads : 0;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    await route.continue();
  });
}

const busy = (control: Locator) => expect(control).toHaveAttribute("aria-busy", "true", { timeout: BUSY_WITHIN_MS });

test("Perfil: every write shows a busy state at once and the screen updates without asking for the view again", async ({ page }) => {
  await withServer(async ({ server }) => {
    const state = { reads: 0 };
    await openApp(page, server);
    await page.getByRole("link", { name: "Configuração" }).first().click();
    await expect(page.getByRole("heading", { name: "Perfis do projeto" })).toBeVisible();
    await expect(page.locator('[data-testid="profile-card"]').first()).toBeVisible();
    await delayCalls(page, state);

    let viewReads = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/config/profile") viewReads += 1;
    });
    const dialog = page.getByRole("dialog");

    // Create.
    viewReads = 0;
    await page.getByRole("button", { name: "Criar perfil" }).click();
    await page.getByLabel("Identificador do perfil").fill("t1");
    let confirm = dialog.getByRole("button", { name: "Criar", exact: true });
    await confirm.click();
    await busy(confirm);
    await expect(page.locator('[data-profile="t1"]')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(viewReads, "create asked for the view again").toBe(0);

    // Duplicate.
    viewReads = 0;
    await page.locator('[data-profile="standard"]').getByRole("button", { name: /^Duplicar/ }).click();
    await page.getByLabel("Identificador do perfil").fill("t2");
    confirm = dialog.getByRole("button", { name: "Criar", exact: true });
    await confirm.click();
    await busy(confirm);
    await expect(page.locator('[data-profile="t2"]')).toBeVisible();
    expect(viewReads, "duplicate asked for the view again").toBe(0);

    // Rename (a profile that is not the one on screen).
    viewReads = 0;
    await page.locator('[data-profile="t1"]').getByRole("button", { name: /^Renomear/ }).click();
    await dialog.getByRole("textbox").fill("t3");
    confirm = dialog.getByRole("button", { name: "Renomear", exact: true });
    await confirm.click();
    await busy(confirm);
    await expect(page.locator('[data-profile="t3"]')).toBeVisible();
    await expect(page.locator('[data-profile="t1"]')).toHaveCount(0);
    expect(viewReads, "rename asked for the view again").toBe(0);

    // Make default.
    viewReads = 0;
    const makeDefault = page.locator('[data-profile="t2"]').getByRole("button", { name: /^Marcar como padrão/ });
    await makeDefault.click();
    await busy(makeDefault);
    await expect(page.locator('[data-profile="t2"]').getByText("Padrão", { exact: true })).toBeVisible();
    expect(viewReads, "make default asked for the view again").toBe(0);

    // Delete.
    viewReads = 0;
    await page.locator('[data-profile="t3"]').getByRole("button", { name: /^Apagar/ }).click();
    confirm = dialog.getByRole("button", { name: "Apagar perfil" });
    await confirm.click();
    await busy(confirm);
    await expect(page.locator('[data-profile="t3"]')).toHaveCount(0);
    expect(viewReads, "delete asked for the view again").toBe(0);

    // A category switch on the profile on screen.
    viewReads = 0;
    const category = page.locator('[data-testid^="category-"]').first();
    await expect(category).toBeEnabled();
    await category.click();
    await busy(category);
    await expect(category).not.toHaveAttribute("aria-busy", "true");
    expect(viewReads, "the category switch asked for the view again").toBe(0);
  });
});

test("Perfil: a reload keeps the previous content under an aria-busy updating indicator", async ({ page }) => {
  await withServer(async ({ server }) => {
    const state = { reads: 0 };
    await openApp(page, server);
    await page.getByRole("link", { name: "Configuração" }).first().click();
    await expect(page.getByRole("heading", { name: "Perfis do projeto" })).toBeVisible();
    const cards = page.locator('[data-testid="profile-card"]');
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    await delayCalls(page, state);
    state.reads = 2500;

    // Picking another profile asks for its view: the screen stays as it was and says it is updating.
    await cards.nth(1).getByRole("button", { name: /^Editar o perfil/ }).click();
    const updating = page.getByTestId("updating");
    await expect(updating).toBeVisible({ timeout: BUSY_WITHIN_MS * 3 });
    await expect(updating).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("heading", { name: "Perfis do projeto" })).toBeVisible();
    await expect(cards).toHaveCount(count);
    await expect(page.locator('[data-testid="categories"]')).toBeVisible();
    await expect(updating).toHaveCount(0);
    await expect(cards.nth(1).getByText("Em edição")).toBeVisible();
  });
});

test("Revisar: opening the review sends POST /api/plans once", async ({ page }) => {
  await withServer(async ({ server }) => {
    const base = await openApp(page, server);
    const plans: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/plans" && !(request.postData() ?? "").includes("\"preview\":true")) plans.push(request.postData() ?? "");
    });
    await page.goto(`${base}#/validations/review`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Montando o plano", { exact: false })).toHaveCount(0, { timeout: 60_000 });
    await page.waitForTimeout(2000);
    expect(plans, "opening the review directly").toHaveLength(1);

    // From "Escolher": its own previews are not counted, only what the review sends once it is open.
    await page.goto(`${base}#/validations/choose`);
    await page.getByRole("button", { name: "Revisar o plano" }).click();
    await expect(page).toHaveURL(/#\/validations\/review/);
    const before = 1;
    await expect(page.getByText("Montando o plano", { exact: false })).toHaveCount(0, { timeout: 60_000 });
    await page.waitForTimeout(2000);
    expect(plans.length - before, "opening the review from Escolher").toBe(1);
  });
});
