import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createFixture, startServer, type Fixture, type UiServer } from "./support";

// PLAN-defects D7, D8, D14, D15, D23, D33: a validation ends at its result (the run, History and the overview open
// `#/validations/result/<id>` with the decision banner; a run with a failing decision never reads as a bare
// "Concluída"), the profile screen survives deleting the profile in edition and an invalid key, and the tool page shows
// the effective limits of the instance with their origin.

async function withServer(body: (ctx: { fixture: Fixture; server: UiServer; base: string }) => Promise<void>, page: Page) {
  const fixture = createFixture();
  let server: UiServer | null = null;
  try {
    server = await startServer(fixture);
    await page.goto(server.bootstrapUrl);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await body({ fixture, server, base: page.url().split("#")[0] as string });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

test("a run that ends opens its result with the decision, and History and the overview open it too", async ({ page }) => {
  await withServer(async ({ base }) => {
    await page.goto(`${base}#/plan`);
    await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/, { timeout: 60_000 });
    await page.getByRole("button", { name: "Executar" }).click();
    await expect(page.getByTestId("run-state")).toHaveAttribute("data-state", "finished", { timeout: 120_000 });

    // The decision is on the state itself: a run with a decision other than "passed" never reads as a bare "Concluída".
    const banner = page.getByTestId("result-banner").first();
    await expect(banner).toBeVisible();
    const kind = await banner.getAttribute("data-kind");
    if (kind !== "passed") await expect(page.getByTestId("run-state")).not.toHaveText("Concluída");

    await page.getByTestId("run-open-result").click();
    await expect(page).toHaveURL(/#\/validations\/result\/run_/);
    const runId = decodeURIComponent(page.url().split("/result/")[1] as string);
    await expect(page.getByTestId("result-banner")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Detalhes da validação", level: 1 })).toBeVisible();

    // History: the row opens the result.
    await page.goto(`${base}#/validations`);
    const row = page.locator(`tr[data-run="${runId}"]`);
    await expect(row).toBeVisible();
    await row.getByRole("link", { name: runId }).click();
    await expect(page).toHaveURL(new RegExp(`#/validations/result/${runId}`));
    await expect(page.getByTestId("result-banner")).toBeVisible();

    // The overview: the link of the last validation opens it.
    await page.goto(`${base}#/overview`);
    const link = page.getByRole("link", { name: "Ver resultado" });
    await expect(link).toHaveAttribute("href", `#/validations/result/${runId}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`#/validations/result/${runId}`));
    await expect(page.getByTestId("result-banner")).toBeVisible();
  }, page);
});

test("deleting the profile in edition returns to the default profile, whose own delete action is disabled with its reason", async ({ page }) => {
  await withServer(async ({ base }) => {
    await page.goto(`${base}#/config`);
    await expect(page.getByRole("heading", { name: "Perfis do projeto" })).toBeVisible();

    await page.getByRole("button", { name: "Criar perfil" }).click();
    await page.getByLabel("Criar a partir de").selectOption("standard");
    await page.getByLabel("Identificador do perfil").fill("rapido");
    await page.getByRole("button", { name: "Criar", exact: true }).click();
    const card = page.locator('[data-profile="rapido"]');
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: /^Editar o perfil/ }).click();
    await expect(card).toContainText("Em edição");

    await card.getByRole("button", { name: /^Apagar o perfil/ }).click();
    await page.getByRole("button", { name: "Apagar perfil" }).click();

    // No error replaces the screen: the cards are there, the deleted one is gone and the default profile is on screen.
    await expect(page.getByRole("heading", { name: "Perfis do projeto" })).toBeVisible();
    await expect(page.locator('[data-profile="rapido"]')).toHaveCount(0);
    await expect(page.getByText("não existe")).toHaveCount(0);
    const standard = page.locator('[data-profile="minimal"]');
    await expect(standard).toContainText("Em edição");

    // The default profile cannot be deleted: the action is disabled and says why.
    await expect(page.getByRole("button", { name: "Apagar o perfil Essencial" })).toBeDisabled();
    await expect(standard.getByTestId("delete-disabled-reason")).toContainText("O perfil padrão não pode ser apagado");
  }, page);
});

test("one invalid key shows the diagnostics with file, key and line and a link to the YAML editor, and the screen still renders", async ({ page }) => {
  await withServer(async ({ fixture, base }) => {
    const file = path.join(fixture.dir, "jgates.yml");
    fs.writeFileSync(file, `${fs.readFileSync(file, "utf8").trimEnd()}\nnot_a_real_key: true\n`);
    await page.goto(`${base}#/config`);
    await page.reload();
    await expect(page.getByRole("heading", { name: "As suas regras. Do seu jeito.", level: 1 })).toBeVisible();
    const diagnostics = page.getByTestId("config-diagnostics");
    await expect(diagnostics).toBeVisible();
    await expect(diagnostics.getByTestId("diag-file").first()).toHaveText("jgates.yml");
    await expect(diagnostics.getByTestId("diag-key").first()).toContainText("not_a_real_key");
    await expect(diagnostics).toContainText(/linha \d+/);
    await expect(diagnostics.getByTestId("diag-open-yaml")).toHaveAttribute("href", "#/config/yaml?file=jgates.yml&path=not_a_real_key");
  }, page);
});

test("the tool page shows the effective time limit of the instance and where it comes from", async ({ page }) => {
  await withServer(async ({ fixture, base }) => {
    await page.goto(`${base}#/tools/ruff`);
    await page.getByTestId("execution").locator("summary").click();
    await expect(page.getByTestId("execution-timeout")).toHaveValue("30");
    await expect(page.getByTestId("execution-timeout-origin")).toContainText("Padrão do JGates");

    const file = path.join(fixture.dir, "jgates.yml");
    fs.writeFileSync(file, `${fs.readFileSync(file, "utf8").trimEnd()}\nexecution:\n  timeoutSeconds: 600\n`);
    await page.reload();
    await page.getByTestId("execution").locator("summary").click();
    await expect(page.getByTestId("execution-timeout")).toHaveValue("10");
    await expect(page.getByTestId("execution-timeout-origin")).toContainText("jgates.yml");
  }, page);
});
