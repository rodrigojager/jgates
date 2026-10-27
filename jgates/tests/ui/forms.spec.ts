import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { PYTEST_SECTION, createFixture, startServer, tomlSection, type Fixture, type UiServer } from "./support";

// The Options tab: the Ruff form edits [tool.ruff] of the pyproject.toml it shares with pytest, through field intents,
// a reviewed diff and the revision of the document.

const TOOLS = "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    config: pyproject.toml\n  pytest:\n    adapter: pytest\n    config: pyproject.toml\n";

async function withServer(page: Page, body: (ctx: { fixture: Fixture; server: UiServer; base: string }) => Promise<void>) {
  const fixture = createFixture();
  fs.writeFileSync(path.join(fixture.dir, ".jgates", "tools.yml"), TOOLS);
  let server: UiServer | null = null;
  try {
    server = await startServer(fixture);
    await page.goto(server.bootstrapUrl);
    // The bootstrap page redirects to the application, which opens on the overview; these specs start from the Tools tab.
    await page.waitForURL((url) => !url.pathname.startsWith("/session"));
    await page.goto(page.url().split("#")[0] + "#/tools");
    await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();
    await body({ fixture, server, base: page.url().split("#")[0] as string });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

async function openOptions(page: Page, base: string, instance: string) {
  await page.goto(`${base}#/tools/${instance}`);
  await page.getByRole("tab", { name: "Opções" }).click();
  await expect(page.getByTestId("form")).toBeVisible();
}

test("edit line-length in the Options tab: only [tool.ruff] changes on disk, the pytest section stays byte for byte", async ({ page }) => {
  await withServer(page, async ({ fixture, base }) => {
    const before = fs.readFileSync(fixture.pyproject, "utf8");
    await openOptions(page, base, "ruff");
    await expect(page.getByTestId("form-shared")).toContainText("pytest");
    await expect(page.getByRole("heading", { name: "Uso comum" })).toBeVisible();

    // Absent from the file: inherited, with the tool default shown but not written.
    const row = page.locator('[data-field="line-length"]');
    await expect(row).toHaveAttribute("data-state", "inherited");
    await expect(row).toContainText("padrão da ferramenta: 88");
    await row.getByRole("checkbox", { name: "Usar valor herdado (Comprimento da linha)" }).uncheck();
    await page.getByLabel("Comprimento da linha", { exact: true }).fill("100");
    await expect(page.getByText("1 alteração(ões) não salva(s)").first()).toBeVisible();

    await page.getByRole("button", { name: "Revisar alterações" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".diff-line.add", { hasText: "line-length = 100" })).toHaveCount(1);
    expect(fs.readFileSync(fixture.pyproject, "utf8")).toBe(before);
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText(/Salvo\. Nova revisão/)).toBeVisible();

    const after = fs.readFileSync(fixture.pyproject, "utf8");
    expect(after).toMatch(/^\[tool\.ruff\]\nline-length = 100\n/m);
    expect(tomlSection(after, "[tool.pytest.ini_options]")).toBe(tomlSection(before, "[tool.pytest.ini_options]"));
    expect(tomlSection(after, "[tool.pytest.ini_options]")).toBe(`${PYTEST_SECTION}\n`);
    expect(tomlSection(after, "[tool.ruff.lint]")).toBe(tomlSection(before, "[tool.ruff.lint]"));
    // Nothing else was written: no default the user did not choose.
    expect(after.replace("[tool.ruff]\nline-length = 100\n\n", "")).toBe(before);
    await expect(row).toHaveAttribute("data-state", "set");
  });
});

test("search by rule and path, and the link to the position of a field in the file", async ({ page }) => {
  await withServer(page, async ({ base }) => {
    await openOptions(page, base, "ruff");
    await page.getByLabel("Buscar opção, regra ou caminho").fill("tool.ruff.lint.select");
    await expect(page.locator("[data-field]")).toHaveCount(1);
    // The rule codes are searchable: "F" is in select, so searching the rule finds the field.
    await page.getByLabel("Buscar opção, regra ou caminho").fill("quote");
    await expect(page.locator('[data-field="format.quote-style"]')).toBeVisible();
    await page.getByLabel("Buscar opção, regra ou caminho").fill("");
    await page.locator('[data-field="lint.select"]').getByRole("button", { name: /Abrir no arquivo, linha \d+/ }).click();
    await expect(page.getByRole("tab", { name: "Arquivos" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("editor")).toHaveAttribute("data-line", /\d+/);
  });
});

test("the pyproject.toml changed after the form was read: the save asks for reconciliation and keeps both changes", async ({ page }) => {
  await withServer(page, async ({ fixture, base }) => {
    await openOptions(page, base, "ruff");
    // Another editor (the pytest form, or the text editor) saves the shared file in the meantime.
    const external = fs.readFileSync(fixture.pyproject, "utf8").replace('addopts = "-q"', 'addopts = "-ra -q"');
    fs.writeFileSync(fixture.pyproject, external);

    const row = page.locator('[data-field="line-length"]');
    await row.getByRole("checkbox", { name: "Usar valor herdado (Comprimento da linha)" }).uncheck();
    await page.getByLabel("Comprimento da linha", { exact: true }).fill("101");
    await page.getByRole("button", { name: "Revisar alterações" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("O arquivo mudou desde que o formulário foi aberto");
    expect(fs.readFileSync(fixture.pyproject, "utf8")).toBe(external);
    await expect(dialog.locator(".diff-line.add", { hasText: "line-length = 101" })).toHaveCount(1);
    await dialog.getByRole("button", { name: "Reaplicar sobre a versão atual" }).click();
    await expect(page.getByText(/Salvo\. Nova revisão/)).toBeVisible();
    const final = fs.readFileSync(fixture.pyproject, "utf8");
    expect(final).toContain('addopts = "-ra -q"');
    expect(final).toContain("line-length = 101");
  });
});
