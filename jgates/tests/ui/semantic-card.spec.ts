import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createFixture, startServer } from "./support";

// The card of the semantic gate in Ferramentas. A freshly initialized workspace shows it off; with a provider in
// jgates.yml it shows provider, model, scope and limits. Its essential fields are edited through the forms engine
// (Editar o semantic gate): the native file is the source, the save is a minimal patch of jgates.yml with the revision
// the card was read from, and a file that changed meanwhile is a conflict, as in the other screens.

async function openTools(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForURL((u) => !u.pathname.startsWith("/session"));
  await page.goto(page.url().split("#")[0] + "#/tools");
  await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();
}

test("the semantic gate card says Desligado in a workspace that was just initialized", async ({ page }) => {
  const fixture = createFixture();
  const server = await startServer(fixture);
  try {
    await openTools(page, server.bootstrapUrl);
    const card = page.getByTestId("semantic-card");
    await expect(card.getByRole("heading", { name: "Semantic gate" })).toBeVisible();
    await expect(card.getByTestId("semantic-state")).toHaveText("Desligado");
    await expect(card.getByTestId("semantic-provider")).toHaveText("Não definido");
    const results = await new AxeBuilder({ page }).include('[data-testid="semantic-card"]').analyze();
    expect(results.violations).toEqual([]);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("with a provider in jgates.yml the card shows Configurado with provider, model and scope", async ({ page }) => {
  const fixture = createFixture();
  const file = path.join(fixture.dir, "jgates.yml");
  fs.writeFileSync(file, `${fs.readFileSync(file, "utf8").replace(/\n*$/, "\n")}extensions:\n  semantic-gate:\n    provider: mock\n    model: mock-1\n    scope: full\n`);
  const server = await startServer(fixture);
  try {
    await openTools(page, server.bootstrapUrl);
    const card = page.getByTestId("semantic-card");
    await expect(card.getByTestId("semantic-state")).toHaveText("Configurado");
    await expect(card.getByTestId("semantic-provider")).toHaveText("mock");
    await expect(card).toContainText("mock-1");
    await expect(card).toContainText("Projeto inteiro");
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

async function addConnection(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url);
  await page.waitForURL((u) => !u.pathname.startsWith("/session"));
  await page.goto(page.url().split("#")[0] + "#/preferences/providers");
  await page.getByRole("button", { name: "Acrescentar conexão" }).click();
  const form = page.getByTestId("add-connection-form");
  await form.getByLabel("Nome da conexão").fill(name);
  await form.getByLabel("Base URL").fill("http://127.0.0.1:4000/v1");
  await form.getByLabel("Modelo padrão").fill("revisao");
  await form.getByRole("button", { name: "Acrescentar" }).click();
  await expect(page.getByTestId(`provider-${name}`)).toBeVisible();
}

test("a connection added in Providers e chaves is chosen in the card and written as provider: <name> in jgates.yml", async ({ page }) => {
  const fixture = createFixture();
  const file = path.join(fixture.dir, "jgates.yml");
  fs.writeFileSync(file, `# team settings: keep this comment\n${fs.readFileSync(file, "utf8")}`);
  const server = await startServer(fixture);
  try {
    await addConnection(page, server.bootstrapUrl, "litellm-local");
    await page.goto(page.url().split("#")[0] + "#/tools");
    const card = page.getByTestId("semantic-card");
    await expect(card.getByTestId("semantic-state")).toHaveText("Desligado");
    await card.getByRole("button", { name: "Editar o semantic gate" }).click();
    const form = card.getByTestId("semantic-form");
    await expect(form.getByTestId("semantic-connections")).toContainText("litellm-local");
    await expect(form.getByTestId("semantic-advanced")).toContainText("docs/jgates/semantic-gate.pt-BR.md");
    await form.getByRole("checkbox", { name: "Usar valor herdado (Provider ou conexão)" }).uncheck();
    await form.getByLabel("Provider ou conexão", { exact: true }).selectOption("litellm-local");
    await form.getByRole("checkbox", { name: "Usar valor herdado (Escopo)" }).uncheck();
    await form.getByRole("combobox", { name: "Escopo", exact: true }).selectOption("full");
    await expect(form.getByRole("status").filter({ hasText: "alteração" })).toHaveText("2 alteração(ões) não salva(s)");
    expect((await new AxeBuilder({ page }).include('[data-testid="semantic-card"]').analyze()).violations.filter((v) => v.impact === "critical" || v.impact === "serious")).toEqual([]);
    await form.getByRole("button", { name: "Salvar no jgates.yml" }).click();
    await expect(page.getByTestId("toasts")).toContainText("Semantic gate salvo no jgates.yml.");
    await expect(card.getByTestId("semantic-state")).toHaveText("Configurado");
    await expect(card.getByTestId("semantic-provider")).toHaveText("litellm-local");
    // The model comes from the connection in the user's preferences, and the card says where it came from.
    await expect(card.getByTestId("semantic-model")).toContainText("revisao");
    await expect(card.getByTestId("semantic-model")).toContainText("suas preferências");
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith("# team settings: keep this comment\n")).toBe(true);
    expect(text).toMatch(/semantic-gate:\n\s+provider: litellm-local\n/);
    expect(text).toContain("scope: full");
    // Inherit removes the key again (the form never writes a default the user did not choose).
    await card.getByTestId("semantic-form").getByRole("checkbox", { name: "Usar valor herdado (Escopo)" }).check();
    await card.getByTestId("semantic-form").getByRole("button", { name: "Salvar no jgates.yml" }).click();
    await expect.poll(() => fs.readFileSync(file, "utf8").includes("scope:")).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toContain("provider: litellm-local");
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("a jgates.yml changed after the card was read is a revision conflict: nothing is saved and the card reloads", async ({ page }) => {
  const fixture = createFixture();
  const file = path.join(fixture.dir, "jgates.yml");
  fs.writeFileSync(file, `${fs.readFileSync(file, "utf8").replace(/\n*$/, "\n")}extensions:\n  semantic-gate:\n    provider: mock\n    model: mock-1\n`);
  const server = await startServer(fixture);
  try {
    await openTools(page, server.bootstrapUrl);
    const card = page.getByTestId("semantic-card");
    await card.getByRole("button", { name: "Editar o semantic gate" }).click();
    const form = card.getByTestId("semantic-form");
    await form.getByLabel("Modelo", { exact: true }).fill("mock-2");
    // Another editor saves the file in the meantime.
    const external = fs.readFileSync(file, "utf8").replace("model: mock-1", "model: mock-external");
    fs.writeFileSync(file, external);
    await form.getByRole("button", { name: "Salvar no jgates.yml" }).click();
    await expect(card.getByRole("alert")).toContainText("O jgates.yml mudou desde que foi lido.");
    await expect(card.getByRole("alert")).toContainText("Recarregue a tela para ver a versão atual antes de salvar de novo.");
    expect(fs.readFileSync(file, "utf8")).toBe(external);
    await card.getByRole("alert").getByRole("button", { name: "Tentar de novo" }).click();
    await expect(card.getByTestId("semantic-model")).toContainText("mock-external");
    await expect(card.getByRole("alert")).toHaveCount(0);
    await card.getByTestId("semantic-form").getByLabel("Modelo", { exact: true }).fill("mock-2");
    await card.getByTestId("semantic-form").getByRole("button", { name: "Salvar no jgates.yml" }).click();
    await expect(card.getByTestId("semantic-model")).toContainText("mock-2");
    expect(fs.readFileSync(file, "utf8")).toContain("model: mock-2");
    await card.getByRole("button", { name: "Fechar o formulário" }).click();
    await expect(card.getByTestId("semantic-form")).toHaveCount(0);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("governed, the card shows the values and says why it cannot edit them", async ({ page }) => {
  const fixture = createFixture();
  const outside = fs.mkdtempSync(path.join(path.dirname(fixture.dir), "jgates-ui-policy-"));
  fixture.env.JGATES_POLICY_DIR = outside;
  fixture.env.JGATES_POLICY_SHA256 = "a".repeat(64);
  const server = await startServer(fixture);
  try {
    await openTools(page, server.bootstrapUrl);
    const card = page.getByTestId("semantic-card");
    await expect(card.getByTestId("semantic-locked")).toContainText("Modo governado");
    await expect(card.getByRole("button", { name: "Editar o semantic gate" })).toHaveCount(0);
  } finally {
    await server.stop();
    fixture.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
