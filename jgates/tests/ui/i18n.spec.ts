import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createFixture, startServer, type Fixture, type UiServer } from "./support";

// The language of the UI. The choice is made in Preferências (Idioma), saved in the data folder and applied to
// every screen; the same screen reads in Portuguese and in English, and the choice survives a reload.

async function withServer(body: (server: UiServer, fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = createFixture();
  const server = await startServer(fixture);
  try {
    await body(server, fixture);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
}

const storedLanguage = (fixture: Fixture): string | null => {
  const file = path.join(fixture.home, "preferences.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")).language as string) : null;
};

async function openPreferences(page: Page): Promise<void> {
  await page.goto(`${new URL(page.url()).origin}/#/preferences`);
  await expect(page.locator("main h1").first()).toBeVisible();
}

test("the language chosen in Preferências changes the texts of the UI, and a screen reads in both languages", async ({ page }) => {
  await withServer(async (server, fixture) => {
    await page.goto(server.bootstrapUrl);
    await expect(page.getByRole("navigation", { name: "Navegação principal" })).toBeVisible();
    await openPreferences(page);

    // Portuguese first: the Idioma control is a working one (no mark of unavailable) and offers both languages.
    await expect(page.getByRole("heading", { name: "Preferências", level: 1 })).toBeVisible();
    const language = page.getByTestId("prefs-language");
    await expect(language).toHaveValue("pt-BR");
    await expect(page.locator("[data-control-unavailable]").filter({ has: language })).toHaveCount(0);
    await expect(language.locator("option")).toHaveText(["Português (Brasil)", "English"]);
    await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");

    // Switch to English: the page reloads and every text of the screen is English.
    await language.selectOption("en");
    await expect(page.getByRole("heading", { name: "Preferences", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Language", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Preferências" })).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByTestId("prefs-language")).toHaveValue("en");
    await expect.poll(() => storedLanguage(fixture)).toBe("en");

    // Another screen is in English too, with the same structure (the Help screen of the shell navigation).
    await page.getByRole("link", { name: "Help and CLI" }).click();
    await expect(page.getByRole("heading", { name: "In the browser or in the terminal.", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy jgates init --cwd ./my-project" })).toBeVisible();
    await expect(page.getByText("Pular para o conteúdo")).toHaveCount(0);

    // The choice survives a reload and the server speaks the same language (a 404 of the API).
    await page.reload();
    await expect(page.getByRole("heading", { name: "In the browser or in the terminal.", level: 1 })).toBeVisible();
    const apiMessage = await page.evaluate(async () => (await (await fetch("/api/no-such-route")).json()).message as string);
    expect(apiMessage).toBe("Route not found.");

    // Back to Portuguese: the same screen again, in Portuguese.
    await openPreferences(page);
    await page.getByTestId("prefs-language").selectOption("pt-BR");
    await expect(page.getByRole("heading", { name: "Preferências", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Navegação principal" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
    await expect.poll(() => storedLanguage(fixture)).toBe("pt-BR");
    await page.getByRole("link", { name: "Ajuda e CLI" }).click();
    await expect(page.getByRole("heading", { name: "No navegador ou no terminal.", level: 1 })).toBeVisible();
    const apiMessagePt = await page.evaluate(async () => (await (await fetch("/api/no-such-route")).json()).message as string);
    expect(apiMessagePt).toBe("Rota não encontrada.");
  });
});

test("a language saved in the data folder wins over the language this browser remembered", async ({ page }) => {
  await withServer(async (server, fixture) => {
    await page.goto(server.bootstrapUrl);
    await expect(page.getByRole("navigation", { name: "Navegação principal" })).toBeVisible();
    // The preference changes outside this browser (another window, or the file edited): the next load follows it once.
    const file = path.join(fixture.home, "preferences.json");
    const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { schemaVersion: 1, theme: "system" };
    fs.writeFileSync(file, `${JSON.stringify({ ...stored, language: "en" }, null, 2)}\n`, { mode: 0o600 });
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });
});
