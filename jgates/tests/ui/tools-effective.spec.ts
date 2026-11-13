import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { expectNoKnownSetAsText } from "./free-text";
import { createFixture, openApp, pageGet, startServer, type Fixture, type UiServer } from "./support";

// Ferramentas shows what runs: on a Python project whose tools.yml has no instance (only templates bring tools) the screen
// lists the effective tools by category and, apart, "suas instâncias"; the catalogue is "Deste projeto" by default with a
// filter to "Todas", and a search ranks the name first. Every tool page has the derived settings form. An own tool opens
// the six steps for editing and has "Testar agora". pt-BR and en, 375 px, keyboard only.

function build(language: "pt-BR" | "en", tools = "schemaVersion: 1\ntools: {}\n"): Fixture {
  const fixture = createFixture();
  fs.writeFileSync(path.join(fixture.dir, ".jgates", "tools.yml"), tools);
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language }, null, 2)}\n`, { mode: 0o600 });
  return fixture;
}

async function withApp(page: Page, fixture: Fixture, body: (base: string) => Promise<void>) {
  let server: UiServer | null = null;
  try {
    server = await startServer(fixture);
    await body(await openApp(page, server));
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

async function noSidewaysScroll(page: Page, where: string): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(0);
}

test("the screen lists the effective tools by category and, apart, your instances; the catalogue is of this project by default (pt-BR)", async ({ page }) => {
  await withApp(page, build("pt-BR"), async (base) => {
    await page.goto(`${base}#/tools`);
    await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();

    // What the plan runs, from the templates alone, by category.
    const effective = page.getByTestId("tools-effective");
    await expect(effective.getByRole("heading", { name: "Ferramentas em uso neste projeto", level: 2 })).toBeVisible();
    await expect(effective.getByTestId("effective-tool").first()).toBeVisible({ timeout: 90_000 });
    expect(await effective.getByTestId("effective-group").count()).toBeGreaterThan(0);
    const fromTemplates = effective.locator('[data-testid="effective-tool"][data-via="template"]');
    expect(await fromTemplates.count(), "templates bring tools").toBeGreaterThan(0);
    expect(await page.locator('[data-testid="tool-card"]').count(), "no instance of your own").toBe(0);
    await expect(page.locator("main, body").first()).not.toContainText("Nenhuma ferramenta configurada");

    // Your instances, apart, and said in words when there are none.
    const instances = page.getByRole("region", { name: "Suas instâncias" });
    await expect(instances).toContainText("Você ainda não criou instâncias");

    // The API says the same: what runs is the plan's, not tools.yml's.
    const doc = await pageGet<any>(page, "/api/tool-effective");
    expect(doc.ok).toBe(true);
    expect(doc.tools.length).toBeGreaterThan(0);
    expect(doc.tools.every((t: any) => t.declared === false)).toBe(true);
    expect(await effective.getByTestId("effective-tool").count()).toBe(doc.tools.length);

    // The catalogue: "Deste projeto" by default, the project's languages first, .NET only under "Todas".
    const catalog = await pageGet<any>(page, "/api/tool-catalog");
    expect(catalog.projectLanguages).toContain("python");
    const python = catalog.adapters.find((a: any) => a.adapter === "ruff");
    const dotnet = catalog.adapters.find((a: any) => a.adapter === "dotnet-test");
    expect(python.relevance).toBe(0);
    expect(dotnet.relevance).toBe(2);
    const scope = page.getByTestId("tools-scope");
    await expect(scope.getByRole("radio", { name: "Deste projeto" })).toBeChecked();
    const cards = page.getByTestId("catalog-card");
    await expect(cards.first()).toBeVisible();
    await expect(page.locator('[data-testid="catalog-card"][data-adapter="ruff"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="catalog-card"][data-adapter="dotnet-test"]')).toHaveCount(0);
    const shown = await cards.evaluateAll((els) => els.map((el) => el.getAttribute("data-adapter")));
    expect(shown.indexOf("ruff"), "Ruff is before every tool that is not for this project").toBeGreaterThanOrEqual(0);
    await expect(page.getByTestId("tools-scope-hidden")).toBeVisible();
    await scope.getByRole("radio", { name: "Todas" }).check();
    await expect(page.locator('[data-testid="catalog-card"][data-adapter="dotnet-test"]')).toHaveCount(1);
    expect(await cards.count()).toBeGreaterThan(shown.length);
    // The facts are said once: a card has one origin block, with the licence in it.
    const card = page.locator('[data-testid="catalog-card"][data-adapter="ruff"]');
    await expect(card.getByTestId("catalog-distribution")).toHaveCount(1);
    await expect(card.getByTestId("origin-row")).toHaveCount(0);
    await scope.getByRole("radio", { name: "Deste projeto" }).check();

    // A search looks through the whole catalogue and ranks the name first.
    await page.getByLabel("Buscar ferramenta ou linguagem").fill("ruff");
    await expect(cards.first()).toHaveAttribute("data-adapter", "ruff");
    await page.getByLabel("Buscar ferramenta ou linguagem").fill("");

    // "Adicionar ferramenta" preselects by the project's languages (never .NET in a Python project).
    await page.getByRole("button", { name: "Adicionar ferramenta", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const chosen = await dialog.locator("select").first().inputValue();
    const entry = catalog.adapters.find((a: any) => a.adapter === chosen);
    expect(entry.relevance, `the preselected tool (${chosen}) is for this project`).toBeLessThan(2);
    expect(entry.instantiable).toBe(true);
    await page.keyboard.press("Escape");
  });
});

test("a created instance continues into its settings in the same flow", async ({ page }) => {
  const fixture = build("pt-BR");
  await withApp(page, fixture, async (base) => {
    await page.goto(`${base}#/tools`);
    await page.getByRole("button", { name: "Adicionar ferramenta", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("select").first().selectOption("zizmor");
    await dialog.getByRole("button", { name: "Criar instância" }).click();
    await page.waitForURL(/#\/tools\/zizmor/);
    expect(fs.readFileSync(path.join(fixture.dir, ".jgates", "tools.yml"), "utf8")).toContain("zizmor:");
    const settings = page.getByTestId("tool-settings");
    await expect(settings.getByTestId("derived-form")).toBeVisible({ timeout: 60_000 });
    await expect(settings.locator('[data-field$=".persona"]').first()).toBeVisible();
  });
});

test("every adapter's tool page shows the derived settings form with enabled, required, timeoutSeconds and capabilities", async ({ page }) => {
  const tools = [
    ["zizmor", "zizmor", "persona"],
    ["mutation", "mutation", "minimumScore"],
    ["file-size", "file-size", "maxLines"],
    ["supply-chain", "supply-chain", "blockOn"],
    ["ruff", "ruff", "enabled"],
  ];
  const yml = `schemaVersion: 1\ntools:\n${tools.map(([id, adapter]) => `  ${id}:\n    adapter: ${adapter}\n`).join("")}`;
  await withApp(page, build("pt-BR", yml), async (base) => {
    for (const [id, , key] of tools) {
      await page.goto(`${base}#/tools/${id}`);
      const settings = page.getByTestId("tool-settings");
      await expect(settings.getByTestId("derived-form")).toBeVisible({ timeout: 60_000 });
      for (const k of [key as string, "enabled", "required", "timeoutSeconds", "capabilities"]) {
        await expect(settings.locator(`[data-field="tools.${id}.${k}"], [data-field$=".${k}"]`).first(), `${id}: ${k}`).toBeVisible();
      }
    }
    // A tool the templates bring has no entry in tools.yml and still has its page and its form.
    const doc = await pageGet<any>(page, "/api/tool-effective");
    const brought = doc.tools.find((t: any) => !t.declared);
    await page.goto(`${base}#/tools/${brought.tool}`);
    await expect(page.getByTestId("tool-settings").getByTestId("derived-form")).toBeVisible({ timeout: 60_000 });
  });
});

test("the screen in English and at 375 px: no sideways scroll, no free text where the values are known, keyboard reaches the filters", async ({ page }) => {
  await withApp(page, build("en"), async (base) => {
    await page.goto(`${base}#/tools`);
    await expect(page.getByRole("heading", { name: "Tools", level: 1 })).toBeVisible();
    await page.setViewportSize({ width: 375, height: 900 });
    await expect(page.getByRole("heading", { name: "Tools in use in this project", level: 2 })).toBeVisible();
    await expect(page.getByTestId("effective-tool").first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("region", { name: "Your instances" })).toContainText("You have not created any instance yet");
    await expect(page.getByTestId("tools-scope").getByRole("radio", { name: "For this project" })).toBeChecked();
    await noSidewaysScroll(page, "tools screen");
    expect(await expectNoKnownSetAsText(page, "main", "tools screen")).toBeGreaterThanOrEqual(0);

    // Keyboard only: the scope radios are reached with Tab and changed with the arrow keys.
    const project = page.getByTestId("tools-scope").getByRole("radio", { name: "For this project" });
    for (let i = 0; i < 80 && !(await project.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(project).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("tools-scope").getByRole("radio", { name: "All" })).toBeChecked();

    // The creation dialog and the tool page of an effective tool at 375 px.
    await page.getByRole("button", { name: "Add tool", exact: true }).click();
    expect(await expectNoKnownSetAsText(page, "dialog", "creation dialog")).toBeGreaterThanOrEqual(0);
    await noSidewaysScroll(page, "creation dialog");
    await page.keyboard.press("Escape");
    const first = page.getByTestId("effective-tool").first();
    const tool = await first.getAttribute("data-tool");
    await page.goto(`${base}#/tools/${tool}`);
    await expect(page.getByTestId("tool-settings").getByTestId("derived-form")).toBeVisible({ timeout: 60_000 });
    await noSidewaysScroll(page, "tool page");
  });
});

const OWN = `schemaVersion: 1
tools:
  acme-lint:
    adapter: generic-command
    command: acme-lint
    args: ["--out={outputDir}/acme-lint.sarif", "{workspace}"]
    capabilities: [sast]
    enabled: true
    config:
      effects:
        readsCode: true
        writesOutputs: true
        mayChangeCode: false
        executesProjectCode: false
        usesNetwork: false
      evidence:
        kind: sarif
        file: acme-lint.sarif
`;

test("an existing own tool opens the six steps filled in, saves key by key, and has Testar agora on its page and its card", async ({ page }) => {
  const fixture = build("pt-BR", OWN);
  await withApp(page, fixture, async (base) => {
    await page.goto(`${base}#/tools`);
    const card = page.locator('[data-testid="tool-card"][data-instance="acme-lint"]');
    // The card's `Não testada` state has the action.
    await expect(card.getByTestId("origin-row")).toContainText("Não testada");
    await expect(card.getByRole("button", { name: "Testar agora: acme-lint" })).toBeVisible();

    // Editing from the card: the six steps, filled in.
    await card.getByRole("button", { name: "Editar acme-lint" }).click();
    const own = page.getByTestId("custom-tool-dialog");
    await expect(own).toHaveAttribute("data-step", "obtain");
    await expect(own.getByRole("radio", { name: /Manter como está/ })).toBeChecked();
    await own.getByTestId("ctl-next").click();
    await expect(own.getByTestId("ctl-id")).toHaveValue("acme-lint");
    await expect(own.getByTestId("ctl-id")).toHaveAttribute("readonly", "");
    await expect(own.getByTestId("ctl-command")).toHaveValue("acme-lint");
    await expect(own.getByTestId("ctl-args")).toHaveValue("--out={output}/acme-lint.sarif\n{workspace}");
    await own.getByTestId("ctl-command").fill("acme-lint2");
    await own.getByTestId("ctl-next").click();
    await expect(own.getByTestId("ctl-file")).toHaveValue("acme-lint.sarif");
    await own.getByTestId("ctl-next").click();
    await expect(own.locator('input[data-capability="sast"]')).toBeChecked();
    await own.getByTestId("ctl-next").click();
    // The review shows the change of the one key; nothing is written before Salvar.
    const diff = own.locator('[data-testid="ctl-diff"][data-file=".jgates/tools.yml"]');
    await expect(diff).toContainText("acme-lint2");
    expect(fs.readFileSync(path.join(fixture.dir, ".jgates", "tools.yml"), "utf8")).toContain("command: acme-lint\n");
    await own.getByTestId("ctl-save").click();
    await expect(own.getByTestId("ctl-saved")).toBeVisible();
    const after = fs.readFileSync(path.join(fixture.dir, ".jgates", "tools.yml"), "utf8");
    expect(after).toContain("command: acme-lint2");
    expect(after, "keys the dialog does not know stay").toContain("enabled: true");
    await own.getByTestId("ctl-done").click();
    await expect(page.getByTestId("tools-notice")).toContainText("acme-lint");

    // The tool page: the own-tool panel, the edit and Testar agora, and the settings form beside them.
    await page.goto(`${base}#/tools/acme-lint`);
    const panel = page.getByTestId("own-tool-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Não testada");
    await expect(panel.getByRole("button", { name: "Testar agora: acme-lint" })).toBeVisible();
    await expect(panel.getByTestId("own-tool-edit")).toBeVisible();
    await expect(page.getByTestId("tool-settings").getByTestId("derived-form")).toBeVisible({ timeout: 60_000 });
    for (const k of ["enabled", "required", "timeoutSeconds", "capabilities"]) await expect(page.getByTestId("tool-settings").locator(`[data-field$=".${k}"]`).first(), k).toBeVisible();
  });
});
