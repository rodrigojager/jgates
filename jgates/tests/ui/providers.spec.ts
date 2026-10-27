import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { createFixture, startServer, type Fixture, type UiServer } from "./support";

// Preferências > Providers e chaves (D9, D10). The key store and the provider preferences live in the fixture's
// SEMANTIC_GATE_HOME (a temporary folder); the provider is a fake local server that speaks the OpenAI API, so no test
// spends a token. A saved key shows ******** and its date, the field goes back to empty and the value is never in the
// page nor in the browser storage; Remover asks first; Testar lists the fake provider's models.

// An obviously fake key: long enough to be found wherever it would leak.
const VALUE = "sk-fake-ui-k03-0123456789abcdefghijklmnopqrstuv";
const ENV_VALUE = "sk-fake-ui-env-k03-zyxwvutsrqponmlkjihgfedcba";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function fakeProvider(key: string): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url === "/v1/models" && req.headers.authorization === `Bearer ${key}`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model-a" }, { id: "fake-model-b" }] }));
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid key" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

async function openProviders(page: Page, server: UiServer): Promise<void> {
  await page.goto(server.bootstrapUrl);
  await page.waitForURL((u) => !u.pathname.startsWith("/session"));
  await page.goto(`${page.url().split("#")[0]}#/preferences/providers`);
  await expect(page.getByRole("heading", { name: "Providers e chaves", level: 1 })).toBeVisible();
}

async function serious(page: Page, include?: string): Promise<string[]> {
  const builder = new AxeBuilder({ page }).withTags(TAGS);
  const result = await (include ? builder.include(include) : builder).analyze();
  return result.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

/** Everything the browser keeps for the page: the markup, the input values, localStorage, sessionStorage and cookies. */
async function browserState(page: Page): Promise<string> {
  const html = await page.content();
  const values = await page.evaluate(() => [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join("\n"));
  const storage = await page.evaluate(() => {
    const dump = (s: Storage) => Object.keys(s).map((k) => `${k}=${s.getItem(k)}`).join("\n");
    return `${dump(window.localStorage)}\n${dump(window.sessionStorage)}\n${document.cookie}`;
  });
  return `${html}\n${values}\n${storage}`;
}

test.describe("Providers e chaves", () => {
  let fixture: Fixture;
  let server: UiServer;
  let fake: Awaited<ReturnType<typeof fakeProvider>>;

  test.beforeEach(async () => {
    fake = await fakeProvider(VALUE);
    fixture = createFixture();
    // A key the environment already has: the screen says the environment wins.
    fixture.env.OPENROUTER_API_KEY = ENV_VALUE;
    server = await startServer(fixture);
  });

  test.afterEach(async () => {
    await server?.stop();
    fixture?.cleanup();
    await fake?.close();
  });

  test("saving a key shows ******** and the date, empties the field and keeps the value out of the page; Testar lists the fake models; Remover asks first", async ({ page }) => {
    await openProviders(page, server);
    const openai = page.getByTestId("provider-openai");
    await expect(page.getByTestId("key-state-OPENAI_API_KEY")).toHaveText("Ausente");

    // Point the provider at the fake server through its preferences (Configurar).
    await openai.getByRole("button", { name: "Configurar openai" }).click();
    await openai.getByLabel("Base URL").fill(fake.url);
    await openai.getByRole("button", { name: "Salvar as preferências de openai" }).click();
    await expect(page.getByTestId("base-url-openai")).toContainText(fake.url);
    await expect(page.getByTestId("base-url-openai")).toContainText("sua preferência");
    expect(JSON.parse(fs.readFileSync(path.join(fixture.store, "config.json"), "utf8")).providers.openai.baseUrl).toBe(fake.url);

    // Gravar chave: a password field without autocomplete, emptied after the save.
    await openai.getByRole("button", { name: "Gravar chave OPENAI_API_KEY" }).click();
    const input = page.getByTestId("key-input-OPENAI_API_KEY");
    await expect(input).toHaveAttribute("type", "password");
    await expect(input).toHaveAttribute("autocomplete", "off");
    await input.fill(VALUE);
    expect(await page.content()).not.toContain(VALUE);
    await openai.getByRole("button", { name: "Salvar chave OPENAI_API_KEY no cofre" }).click();
    await expect(page.getByTestId("toasts")).toContainText("Chave OPENAI_API_KEY gravada no cofre.");
    const state = page.getByTestId("key-state-OPENAI_API_KEY");
    await expect(state).toHaveText(/^\*{8} gravada em \d{2}\/\d{2}\/\d{4}/);
    await expect(state).toHaveAttribute("data-source", "vault");
    await expect(page.getByTestId("key-input-OPENAI_API_KEY")).toHaveCount(0);
    await openai.getByRole("button", { name: "Trocar chave OPENAI_API_KEY" }).click();
    await expect(page.getByTestId("key-input-OPENAI_API_KEY")).toHaveValue("");
    expect(await serious(page, '[data-testid="provider-openai"]')).toEqual([]);
    await openai.getByRole("button", { name: "Cancelar" }).click();
    const kept = await browserState(page);
    expect(kept).not.toContain(VALUE);
    // The store has it, outside the project; the project and the data folder do not.
    expect(fs.readFileSync(path.join(fixture.store, "secrets.json"), "utf8")).toContain(VALUE);
    expect(fs.readFileSync(path.join(fixture.dir, "jgates.yml"), "utf8")).not.toContain(VALUE);

    // Testar: the fake provider's models, with the key, and nothing but the model listing was called.
    await openai.getByRole("button", { name: "Testar openai" }).click();
    const models = page.getByTestId("models-openai");
    await expect(models).toContainText("openai respondeu: 2 modelos.");
    await expect(models).toContainText("fake-model-a");
    await expect(models).toContainText("fake-model-b");
    expect(fake.seen.every((s) => s === "GET /v1/models")).toBe(true);

    // With the key set, Configurar lists the models for the default model.
    await openai.getByRole("button", { name: "Configurar openai" }).click();
    await expect(page.getByTestId("models-count-openai")).toHaveText("2 modelos do provider para escolher.");
    await openai.getByLabel("Modelo padrão").fill("fake-model-b");
    await openai.getByRole("button", { name: "Salvar as preferências de openai" }).click();
    await expect(page.getByTestId("model-openai")).toContainText("fake-model-b");

    // The environment wins: the screen says so, and a save in the store does not go unnoticed.
    const router = page.getByTestId("provider-openrouter");
    await expect(page.getByTestId("key-state-OPENROUTER_API_KEY")).toHaveText("Definida no ambiente (OPENROUTER_API_KEY)");
    await expect(router).toContainText("A variável de ambiente OPENROUTER_API_KEY está definida e tem precedência");
    await router.getByRole("button", { name: "Gravar chave OPENROUTER_API_KEY" }).click();
    await expect(router).toContainText("Gravar no cofre não muda nada enquanto a variável OPENROUTER_API_KEY estiver definida");
    await page.getByTestId("key-input-OPENROUTER_API_KEY").fill(VALUE);
    await router.getByRole("button", { name: "Salvar chave OPENROUTER_API_KEY no cofre" }).click();
    await expect(page.getByTestId("toasts")).toContainText("mas a variável de ambiente OPENROUTER_API_KEY continua valendo");
    await expect(router).toContainText("o valor do cofre só vale quando ela não estiver definida");

    // Remover asks first: Cancelar keeps the key, the confirmation removes it from the store.
    await openai.getByRole("button", { name: "Remover chave OPENAI_API_KEY" }).click();
    const dialog = page.getByRole("dialog", { name: "Remover a chave OPENAI_API_KEY?" });
    await expect(dialog).toBeVisible();
    expect(await serious(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(state).toHaveAttribute("data-state", "set");
    await openai.getByRole("button", { name: "Remover chave OPENAI_API_KEY" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remover do cofre" }).click();
    await expect(page.getByTestId("toasts")).toContainText("Chave OPENAI_API_KEY removida do cofre.");
    await expect(state).toHaveText("Ausente");
    expect(fs.readFileSync(path.join(fixture.store, "secrets.json"), "utf8")).not.toContain(`"OPENAI_API_KEY"`);
    expect(await browserState(page)).not.toContain(VALUE);
    expect(await browserState(page)).not.toContain(ENV_VALUE);
  });

  test("a name of the user's own: Acrescentar nome, Trocar and Remover, and Restaurar padrões of a provider", async ({ page }) => {
    await openProviders(page, server);
    await page.getByRole("button", { name: "Acrescentar nome" }).click();
    const form = page.getByTestId("add-key-form");
    await form.getByLabel("Nome da chave").fill("minha");
    await expect(form).toContainText("Use letras maiúsculas, dígitos e \"_\"");
    await form.getByLabel("Nome da chave").fill("MY_PII_TOOL_KEY");
    await page.getByTestId("add-key-value").fill(VALUE);
    await form.getByRole("button", { name: "Gravar no cofre" }).click();
    const other = page.getByTestId("other-key-MY_PII_TOOL_KEY");
    await expect(other).toBeVisible();
    await expect(page.getByTestId("key-state-MY_PII_TOOL_KEY")).toHaveText(/^\*{8} gravada em/);
    expect(await browserState(page)).not.toContain(VALUE);
    await other.getByRole("button", { name: "Trocar chave MY_PII_TOOL_KEY" }).click();
    await page.getByTestId("key-input-MY_PII_TOOL_KEY").fill(`${VALUE}-2`);
    await other.getByRole("button", { name: "Salvar chave MY_PII_TOOL_KEY no cofre" }).click();
    await expect(page.getByTestId("key-input-MY_PII_TOOL_KEY")).toHaveCount(0);
    await other.getByRole("button", { name: "Remover chave MY_PII_TOOL_KEY" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remover do cofre" }).click();
    await expect(page.getByTestId("other-key-MY_PII_TOOL_KEY")).toHaveCount(0);

    // A provider with a preference can go back to its defaults (with a confirmation).
    const gemini = page.getByTestId("provider-gemini");
    await gemini.getByRole("button", { name: "Configurar gemini" }).click();
    await gemini.getByLabel("Modelo padrão").fill("fake-gemini");
    await gemini.getByRole("button", { name: "Salvar as preferências de gemini" }).click();
    await expect(page.getByTestId("model-gemini")).toContainText("fake-gemini");
    await gemini.getByRole("button", { name: "Restaurar padrões de gemini" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restaurar os padrões" }).click();
    await expect(page.getByTestId("model-gemini")).toContainText("Não definido");
    // A CLI provider keeps only its default model: no key and no Testar.
    const cli = page.getByTestId("provider-codex-cli");
    await expect(cli).toContainText("Login do próprio CLI");
    await expect(cli.getByRole("button", { name: "Testar codex-cli" })).toHaveCount(0);
  });

  test("a connection with a credential header is refused by field, then added, tested and removed", async ({ page }) => {
    await openProviders(page, server);
    await page.getByRole("button", { name: "Acrescentar conexão" }).click();
    const form = page.getByTestId("add-connection-form");
    await form.getByLabel("Nome da conexão").fill("openai");
    await expect(form).toContainText("Este nome é de um provider do semantic gate");
    await form.getByLabel("Nome da conexão").fill("team-gateway");
    await form.getByLabel("Base URL").fill(fake.url);
    await form.getByLabel("Nome da chave").fill("TEAM_GATEWAY_KEY");
    await form.getByLabel("Cabeçalhos extras").fill("X-Api-Key: abc");
    await form.getByRole("button", { name: "Acrescentar" }).click();
    await expect(form).toContainText("um cabeçalho que leva uma credencial é recusado");
    await form.getByLabel("Cabeçalhos extras").fill("X-Team: qa");
    await form.getByRole("button", { name: "Acrescentar" }).click();
    const card = page.getByTestId("provider-team-gateway");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Conexão openai-compatible");
    await expect(card).toContainText("X-Team");
    await card.getByRole("button", { name: "Gravar chave TEAM_GATEWAY_KEY" }).click();
    await page.getByTestId("key-input-TEAM_GATEWAY_KEY").fill(VALUE);
    await card.getByRole("button", { name: "Salvar chave TEAM_GATEWAY_KEY no cofre" }).click();
    await card.getByRole("button", { name: "Testar team-gateway" }).click();
    await expect(page.getByTestId("models-team-gateway")).toContainText("fake-model-a");
    expect(await serious(page)).toEqual([]);

    await card.getByRole("button", { name: "Remover conexão team-gateway" }).click();
    const dialog = page.getByRole("dialog", { name: "Remover a conexão team-gateway?" });
    await dialog.getByRole("button", { name: "Remover a conexão" }).click();
    await expect(page.getByTestId("provider-team-gateway")).toHaveCount(0);
    await expect(page.getByTestId("no-connections")).toBeVisible();
    expect(await browserState(page)).not.toContain(VALUE);
  });
});

test("in the governed mode the screen is read-only and says why", async ({ page }) => {
  const fixture = createFixture();
  const outside = fs.mkdtempSync(path.join(path.dirname(fixture.dir), "jgates-ui-policy-"));
  fixture.env.JGATES_POLICY_DIR = outside;
  fixture.env.JGATES_POLICY_SHA256 = "a".repeat(64);
  const server = await startServer(fixture);
  try {
    await openProviders(page, server);
    await expect(page.getByTestId("providers-locked")).toContainText("Modo governado");
    await expect(page.getByRole("button", { name: "Configurar openai" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Gravar chave OPENAI_API_KEY" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Acrescentar conexão" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Testar openai", exact: true })).toBeVisible();
    expect(await serious(page)).toEqual([]);
  } finally {
    await server.stop();
    fixture.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Preferências links to Providers e chaves and the screen speaks English", async ({ page }) => {
  const fixture = createFixture();
  const server = await startServer(fixture);
  try {
    await page.goto(server.bootstrapUrl);
    await page.waitForURL((u) => !u.pathname.startsWith("/session"));
    await page.goto(`${page.url().split("#")[0]}#/preferences`);
    await page.getByTestId("prefs-providers-link").click();
    await expect(page.getByRole("heading", { name: "Providers e chaves", level: 1 })).toBeVisible();
    await page.goto(`${page.url().split("#")[0]}#/preferences`);
    await page.getByTestId("prefs-language").selectOption("en");
    await expect(page.getByRole("heading", { name: "Preferences", level: 1 })).toBeVisible();
    await page.goto(`${page.url().split("#")[0]}#/preferences/providers`);
    await expect(page.getByRole("heading", { name: "Providers and keys", level: 1 })).toBeVisible();
    await expect(page.getByTestId("key-state-OPENAI_API_KEY")).toHaveText("Not set");
    await expect(page.getByRole("button", { name: "Save key OPENAI_API_KEY" })).toBeVisible();
    // No catalog key shows up raw.
    expect(await page.locator("main").innerText()).not.toMatch(/\bpk_[a-z_]+\b/);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
