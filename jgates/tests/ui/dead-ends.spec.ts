import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createFixture, startServer, type Fixture, type UiServer } from "./support";

// No dead ends: Arquitetura without its file creates it and lands on it; the review's Configure action for
// migration-drift, performance and playwright opens the tool's Options with the named field focused; Escolher refuses a
// folder target without a folder; the own-tool dialog asks before discarding; a hand-written value the form does not
// accept is shown as written (never "Salvo"); and #/plan has a title and no phantom unsaved-document blocker.

async function withServer(page: Page, prepare: ((fixture: Fixture) => void) | null, body: (ctx: { fixture: Fixture; server: UiServer; base: string }) => Promise<void>) {
  const fixture = createFixture();
  let server: UiServer | null = null;
  try {
    prepare?.(fixture);
    server = await startServer(fixture);
    await page.goto(server.bootstrapUrl);
    await page.waitForURL((url) => !url.pathname.startsWith("/session"));
    await expect(page.locator("h1").first()).toBeVisible();
    await body({ fixture, server, base: page.url().split("#")[0] as string });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

const toolsFile = (fixture: Fixture) => path.join(fixture.dir, ".jgates", "tools.yml");

test("Arquitetura without its file offers 'Criar regras de arquitetura', which opens the guided editor and creates the file", async ({ page }) => {
  await withServer(page, null, async ({ fixture, base }) => {
    const file = path.join(fixture.dir, ".jgates", "architecture.yml");
    expect(fs.existsSync(file)).toBe(false);
    await page.goto(`${base}#/config/architecture`);
    await expect(page.getByRole("heading", { name: "Arquitetura", level: 1 })).toBeVisible();
    const create = page.getByRole("button", { name: "Criar regras de arquitetura" });
    await expect(create).toBeVisible();
    await expect(page.getByTestId("arch-missing")).not.toContainText("aba YAML");
    await create.click();
    // The guided editor opens (no dead end, no raw YAML); a project without layer-like folders starts from an empty list.
    const editor = page.getByTestId("architecture-editor");
    await expect(editor).toBeVisible();
    await expect(editor).toContainText("Nenhuma pasta do projeto lembra uma camada conhecida");
    expect(fs.existsSync(file)).toBe(false);
    // A layer is named and its folder picked; the file is created after the review.
    await editor.getByLabel("Nome de uma nova camada").fill("core");
    await editor.getByRole("button", { name: "Adicionar camada" }).click();
    await page.locator("#cfa-ed-paths-core").selectOption("demo");
    await editor.getByRole("button", { name: "Adicionar pasta" }).click();
    await page.getByTestId("arch-next").click();
    await page.getByTestId("arch-next").click();
    await page.getByTestId("arch-save").click();
    await expect(editor).toHaveCount(0);
    expect(fs.readFileSync(file, "utf8")).toContain("demo/**");
    await expect(page.getByTestId("arch-map")).toContainText("core");
    await expect(page.getByRole("button", { name: "Criar regras de arquitetura" })).toHaveCount(0);
  });
});

const INSTANCES = "  migration:\n    adapter: migration-drift\n  perf:\n    adapter: performance\n  e2e:\n    adapter: playwright\n";

test("Configure for migration-drift, performance and playwright opens Options with the named field focused", async ({ page }) => {
  const prepare = (fixture: Fixture) => fs.appendFileSync(toolsFile(fixture), INSTANCES);
  await withServer(page, prepare, async ({ base }) => {
    await page.goto(`${base}#/tools/migration?focus=databaseUrl`);
    await expect(page.getByRole("tab", { name: "Opções" })).toBeVisible();
    const form = page.getByTestId("settings-form");
    await expect(form).toBeVisible({ timeout: 30_000 });
    await expect(form.locator("#rtf-databaseUrl")).toBeFocused();
    await expect(form.locator('[data-field="databaseUrl"]')).toHaveAttribute("data-missing", "true");

    await page.goto(`${base}#/tools/e2e?focus=target`);
    await expect(page.getByRole("tab", { name: "Opções" })).toBeVisible();
    await expect(page.getByTestId("settings-form").locator("#rtf-target")).toBeFocused({ timeout: 30_000 });

    // Budgets are a map kept in the YAML: the form lands on the baseline file that can stand in and says where they are edited.
    await page.goto(`${base}#/tools/perf?focus=budgets`);
    await expect(page.getByRole("tab", { name: "Opções" })).toBeVisible();
    const perf = page.getByTestId("settings-form");
    await expect(perf.locator("#rtf-baseline")).toBeFocused({ timeout: 30_000 });
    await expect(perf.getByTestId("rtf-no-field")).toContainText("budgets");
  });
});

test("Escolher with target Diretório and an empty path cannot continue and says why", async ({ page }) => {
  await withServer(page, null, async ({ base }) => {
    await page.goto(`${base}#/validations/choose`);
    await expect(page.getByRole("heading", { name: "Escolher a validação", level: 1 }).or(page.locator("h1").first())).toBeVisible();
    await page.getByRole("radio", { name: /^Diretório/ }).check();
    const next = page.getByRole("button", { name: "Revisar o plano" });
    await expect(next).toBeDisabled();
    const why = page.getByTestId("path-problem");
    await expect(why).toContainText("Informe o diretório");
    await expect(page.locator("body")).not.toContainText("--path");
    await page.getByLabel(/^Diretório \(relativo/).fill("demo");
    await expect(why).toHaveCount(0);
    await expect(next).toBeEnabled();
  });
});

test("Escape in the own-tool dialog with typed content asks before discarding", async ({ page }) => {
  await withServer(page, null, async ({ base }) => {
    await page.goto(`${base}#/tools`);
    await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Adicionar ferramenta", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: /Própria/ }).check();
    await dialog.getByTestId("tools-path-continue").click();
    const own = page.getByTestId("custom-tool-dialog");
    await expect(own).toBeVisible();
    const spec = own.getByLabel("Pacote e versão");
    await spec.fill("acme-lint==1.0");

    await page.keyboard.press("Escape");
    const ask = page.getByTestId("ctl-discard");
    await expect(ask).toBeVisible();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Keep editing: everything typed is still there.
    await page.getByRole("button", { name: "Continuar editando" }).click();
    await expect(ask).toHaveCount(0);
    await expect(spec).toHaveValue("acme-lint==1.0");

    // A second Escape asks again; discarding closes.
    await page.keyboard.press("Escape");
    await expect(ask).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Descartar e fechar" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test("an invalid hand-written ZAP value is shown as written with a warning and an open-at-line link, and saving does not claim success", async ({ page }) => {
  const prepare = (fixture: Fixture) => fs.appendFileSync(toolsFile(fixture), "  zap:\n    adapter: zap\n    capabilities: [dast]\n    target: 12345\n");
  await withServer(page, prepare, async ({ fixture, base }) => {
    await page.goto(`${base}#/tools/zap`);
    const form = page.getByTestId("settings-form");
    await expect(form).toBeVisible({ timeout: 30_000 });
    const field = form.locator('[data-field="target"]');
    await expect(field).toHaveAttribute("data-state", "unrecognized");
    await expect(field.getByTestId("rtf-written")).toHaveText("12345");
    await expect(field.getByText("Valor escrito à mão que o formulário não aceita")).toBeVisible();
    const link = field.getByTestId("rtf-open-at-line");
    await expect(link).toContainText("linha");
    await expect(link).toHaveAttribute("href", /#\/config\/yaml\?file=.*tools\.yml&line=\d+/);

    await form.getByRole("button", { name: "Salvar" }).click();
    await expect(form.getByTestId("rtf-not-saved")).toBeVisible();
    await expect(form.getByTestId("rtf-saved")).toHaveCount(0);
    // The file still holds the value as it was written.
    expect(fs.readFileSync(toolsFile(fixture), "utf8")).toContain("target: 12345");
  });
});

test("#/plan has a title in the breadcrumb and never shows an unsaved-document blocker when no draft exists", async ({ page }) => {
  await withServer(page, null, async ({ base }) => {
    // Remember whether the phrase ever appeared, even for a moment, while the plan was being built.
    await page.addInitScript(() => {
      (window as unknown as { __sawUnsaved: boolean }).__sawUnsaved = false;
      const look = () => {
        if (document.body?.innerText.includes("Documento com alterações não salvas")) (window as unknown as { __sawUnsaved: boolean }).__sawUnsaved = true;
      };
      new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await page.goto(`${base}#/plan`);
    await page.reload();
    await expect(page.getByText("Montando o plano...")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator("h1").first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: /Caminho|Navegação estrutural|Trilha/ }).or(page.locator("nav.breadcrumb"))).toContainText("Validações");
    await expect(page.getByText("Documento com alterações não salvas")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __sawUnsaved: boolean }).__sawUnsaved)).toBe(false);
  });
});
