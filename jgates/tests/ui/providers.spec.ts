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

// GET /api/providers/cli-status and POST /api/providers/:name/login are stubbed in the browser: no real CLI runs and no
// terminal opens. Claude Code needs a login (until the stub says it is done), Codex CLI is ready, OpenCode cannot confirm
// its login and lists many models, Gemini CLI is not installed.
const OPENCODE_MODELS = Array.from({ length: 60 }, (_, i) => `provider-${i % 3}/model-${String(i).padStart(2, "0")}`);

interface CliStub {
  claudeLoggedIn: boolean;
  logins: string[];
  statusCalls: string[];
}

function cliEntry(id: string, name: string, command: string, installed: boolean, login: "logged-in" | "not-logged-in" | "unknown", models: { source: string; list: string[]; configured: string | null; suggestedDefault: string | null } | null, withModels: boolean) {
  return {
    id,
    name,
    command,
    installed,
    path: installed ? `C:/stub/bin/${command}.cmd` : null,
    version: installed ? "1.2.3" : null,
    login: { state: installed ? login : "unknown", reason: installed ? "STATUS_COMMAND" : "NOT_INSTALLED", method: login === "logged-in" ? "ChatGPT" : null, checkedWith: `${command} status` },
    models: withModels && models ? { truncated: false, configuredIn: models.configured ? "~/.stub" : null, problem: null, ...models } : null,
    loginCommand: { command, args: ["login"], display: `${command} login` },
    install: `npm install -g ${command}-stub`,
  };
}

async function stubCli(page: Page): Promise<CliStub> {
  const stub: CliStub = { claudeLoggedIn: false, logins: [], statusCalls: [] };
  await page.route("**/api/providers/cli-status**", async (route) => {
    const url = new URL(route.request().url());
    stub.statusCalls.push(url.search);
    const withModels = url.searchParams.get("models") !== "0";
    const only = url.searchParams.get("only");
    const all = [
      cliEntry("claude-code", "Claude Code", "claude", true, stub.claudeLoggedIn ? "logged-in" : "not-logged-in", { source: "suggested", list: ["sonnet", "opus", "haiku"], configured: null, suggestedDefault: "sonnet" }, withModels),
      cliEntry("codex-cli", "Codex CLI", "codex", true, "logged-in", { source: "cli", list: ["gpt-5.5", "gpt-5.5-mini", "gpt-5.4"], configured: "gpt-5.5-mini", suggestedDefault: "gpt-5.5-mini" }, withModels),
      cliEntry("opencode", "OpenCode", "opencode", true, "unknown", { source: "cli", list: OPENCODE_MODELS, configured: null, suggestedDefault: null }, withModels),
      cliEntry("gemini-cli", "Gemini CLI", "gemini", false, "unknown", null, withModels),
    ];
    const providers = only ? all.filter((p) => p.id === only) : all;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, status: "OK", checkedAt: new Date().toISOString(), timeoutMs: 8000, providers }) });
  });
  await page.route("**/api/providers/*/login", async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3] as string);
    stub.logins.push(name);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, status: "OK", opened: true, method: "terminal", command: { display: "claude auth login" }, reason: null }) });
  });
  return stub;
}

async function openProviders(page: Page, server: UiServer): Promise<CliStub> {
  const stub = await stubCli(page);
  await page.goto(server.bootstrapUrl);
  await page.waitForURL((u) => !u.pathname.startsWith("/session"));
  await page.goto(`${page.url().split("#")[0]}#/preferences/providers`);
  await expect(page.getByRole("heading", { name: "Provedores e chaves", level: 1 })).toBeVisible();
  return stub;
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
    await expect(page.getByTestId("models-count-openai")).toHaveText("2 modelos do provedor para escolher.");
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
    // A CLI provider has no key and no Testar: its state comes from the CLI itself.
    const cli = page.getByTestId("provider-codex-cli");
    await expect(cli).toContainText("Pronto");
    await expect(cli).not.toContainText("Login do próprio CLI");
    await expect(cli.getByRole("button", { name: "Testar codex-cli" })).toHaveCount(0);
  });

  test("the agent CLIs show their live state (Pronto, Falta entrar, Login não confirmado, Não instalado), Entrar re-checks on focus, and the default model is picked from the CLI's models", async ({ page }) => {
    const stub = await openProviders(page, server);
    const section = page.getByTestId("pk-cli-cards");
    await expect(section).toBeVisible();
    await expect(page.getByText("Login do próprio CLI")).toHaveCount(0);

    // Pronto: the login method, the version and the executable's path.
    const codex = page.getByTestId("provider-codex-cli");
    await expect(codex).toHaveAttribute("data-state", "ready");
    await expect(codex.getByRole("heading", { name: "Codex CLI" })).toBeVisible();
    await expect(codex).toContainText("Pronto");
    await expect(page.getByTestId("pk-cli-detail-codex-cli")).toHaveText("Instalado e com login feito (ChatGPT). · versão 1.2.3");
    await expect(page.getByTestId("pk-cli-path-codex-cli")).toContainText("C:/stub/bin/codex.cmd");
    await expect(page.getByTestId("model-codex-cli")).toHaveText("Padrão do próprio Codex CLI (hoje: gpt-5.5-mini)");
    await expect(page.getByTestId("pk-cli-recheck-codex-cli")).toHaveCount(0);

    // Login não confirmado: Entrar (secondary) and Verificar de novo.
    const opencode = page.getByTestId("provider-opencode");
    await expect(opencode).toHaveAttribute("data-state", "unknown");
    await expect(opencode).toContainText("Login não confirmado");
    await expect(page.getByTestId("pk-cli-login-opencode")).toBeVisible();
    await expect(page.getByTestId("pk-cli-recheck-opencode")).toBeVisible();

    // Não instalado: how to install, a copy button and Verificar de novo; no path.
    const gemini = page.getByTestId("provider-gemini-cli");
    await expect(gemini).toHaveAttribute("data-state", "missing");
    await expect(gemini).toContainText("Não instalado");
    await expect(gemini.getByText("npm install -g gemini-stub")).toBeVisible();
    await expect(page.getByTestId("pk-cli-install-copy-gemini-cli")).toBeVisible();
    await expect(page.getByTestId("pk-cli-path-gemini-cli")).toHaveCount(0);
    await expect(page.getByTestId("pk-cli-login-gemini-cli")).toHaveCount(0);
    const before = stub.statusCalls.length;
    await page.getByRole("button", { name: "Verificar de novo o Gemini CLI" }).click();
    await expect.poll(() => stub.statusCalls.slice(before).some((q) => q.includes("only=gemini-cli") && q.includes("refresh=1"))).toBe(true);

    // Falta entrar: Entrar opens the CLI's own login (stubbed); the card is checked again when the window gets the
    // focus back.
    const claude = page.getByTestId("provider-claude-code");
    await expect(claude).toHaveAttribute("data-state", "login");
    await expect(claude).toContainText("Falta entrar");
    await page.getByRole("button", { name: "Entrar no Claude Code" }).click();
    await expect(page.getByTestId("pk-cli-login-note-claude-code")).toContainText("Abrimos um terminal com claude auth login");
    expect(stub.logins).toEqual(["claude-code"]);
    stub.claudeLoggedIn = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(claude).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("toasts")).toContainText("Login confirmado no Claude Code.");
    await expect(page.getByTestId("pk-cli-login-note-claude-code")).toHaveCount(0);

    // Configurar: the default model is a select fed by the CLI's models, with "Outro…"; the keyboard reaches it.
    await codex.getByRole("button", { name: "Configurar codex-cli" }).click();
    const picker = page.getByTestId("pk-cli-model-codex-cli");
    const select = picker.getByLabel("Modelo padrão", { exact: true });
    await expect(select).toHaveValue("__default__");
    await expect(select.locator("option")).toHaveText(["Padrão do próprio Codex CLI (hoje: gpt-5.5-mini)", "gpt-5.5", "gpt-5.5-mini", "gpt-5.4", "Outro…"]);
    await expect(picker).toContainText("Lista do próprio Codex CLI (3 modelos).");
    await select.selectOption({ label: "Outro…" });
    await expect(picker.getByLabel("Nome do modelo")).toBeVisible();
    await select.focus();
    await select.selectOption("gpt-5.4");
    await expect(picker.getByLabel("Nome do modelo")).toHaveCount(0);
    await codex.getByRole("button", { name: "Salvar as preferências de codex-cli" }).click();
    await expect(page.getByTestId("model-codex-cli")).toContainText("gpt-5.4");
    await expect(page.getByTestId("model-codex-cli")).toContainText("sua preferência");
    expect(JSON.parse(fs.readFileSync(path.join(fixture.store, "config.json"), "utf8")).providers["codex-cli"].model).toBe("gpt-5.4");

    // Many models: a combobox that filters as you type; Esc closes the list only.
    await opencode.getByRole("button", { name: "Configurar opencode" }).click();
    const combo = page.getByTestId("pk-cli-model-opencode").getByRole("combobox", { name: "Modelo padrão" });
    await combo.fill("model-1");
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(10);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(combo).toHaveValue("provider-2/model-11");
    await page.keyboard.press("Escape");
    await opencode.getByRole("button", { name: "Cancelar" }).click();

    // Back to the CLI's own default: Restaurar padrões.
    await codex.getByRole("button", { name: "Restaurar padrões de codex-cli" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restaurar os padrões" }).click();
    await expect(page.getByTestId("model-codex-cli")).toHaveText("Padrão do próprio Codex CLI (hoje: gpt-5.5-mini)");

    // 375 px: nothing wider than the screen.
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await serious(page, '[data-testid="pk-cli-cards"]')).toEqual([]);
  });

  test("a connection with a credential header is refused by field, then added, tested and removed", async ({ page }) => {
    await openProviders(page, server);
    await page.getByRole("button", { name: "Acrescentar conexão" }).click();
    const form = page.getByTestId("add-connection-form");
    await form.getByLabel("Nome da conexão").fill("openai");
    await expect(form).toContainText("Este nome é de um provedor do semantic gate");
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

test("Preferências links to Provedores e chaves, now under Semântica (IA); the old address redirects and the screen speaks English", async ({ page }) => {
  const fixture = createFixture();
  const server = await startServer(fixture);
  try {
    await stubCli(page);
    await page.goto(server.bootstrapUrl);
    await page.waitForURL((u) => !u.pathname.startsWith("/session"));
    await page.goto(`${page.url().split("#")[0]}#/preferences`);
    await page.getByTestId("prefs-providers-link").click();
    await expect(page.getByRole("heading", { name: "Provedores e chaves", level: 1 })).toBeVisible();
    // The screen lives in the Semantic (AI) area now, says it holds the defaults of every project and links to the
    // project's own choice.
    await expect.poll(() => new URL(page.url()).hash).toBe("#/semantic/providers");
    const nav = page.getByRole("navigation", { name: "Navegação principal" });
    await expect(nav.getByRole("link", { name: "Provedores e chaves" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Revisão semântica" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Padrões para todos os projetos", { exact: true })).toBeVisible();
    await expect(page.getByTestId("providers-project-link")).toHaveAttribute("href", "#/semantic/setup?step=provider");
    // The old address redirects (replacing it in the history).
    await page.goto(`${page.url().split("#")[0]}#/preferences/providers`);
    await expect.poll(() => new URL(page.url()).hash).toBe("#/semantic/providers");
    await expect(page.getByRole("heading", { name: "Provedores e chaves", level: 1 })).toBeVisible();
    await page.getByTestId("providers-project-link").click();
    await expect(page.getByRole("heading", { name: "Quem vai fazer a revisão por IA?" })).toBeVisible();
    await page.goto(`${page.url().split("#")[0]}#/preferences`);
    await page.getByTestId("prefs-language").selectOption("en");
    await expect(page.getByRole("heading", { name: "Preferences", level: 1 })).toBeVisible();
    await page.goto(`${page.url().split("#")[0]}#/preferences/providers`);
    await expect(page.getByRole("heading", { name: "Providers and keys", level: 1 })).toBeVisible();
    await expect(page.getByTestId("key-state-OPENAI_API_KEY")).toHaveText("Not set");
    await expect(page.getByRole("button", { name: "Save key OPENAI_API_KEY" })).toBeVisible();
    await expect(page.getByTestId("provider-codex-cli")).toContainText("Ready");
    await expect(page.getByTestId("provider-gemini-cli")).toContainText("Not installed");
    await expect(page.getByTestId("model-codex-cli")).toHaveText("Codex CLI's own default (now: gpt-5.5-mini)");
    // No catalog key shows up raw.
    expect(await page.locator("main").innerText()).not.toMatch(/\bpk_[a-z_]+\b/);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
