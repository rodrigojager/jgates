import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { expectNoKnownSetAsText } from "./free-text";
import { REPO, createFixture, startServer, type Fixture, type UiServer } from "./support";

// The configuration screens that had keys only the YAML could set: Execução (dataMaxAgeDays, extensionImage,
// trustSelfReported, one save with the diff of jgates.yml), Workspace (kind, enabled, include, exclude and the dependency
// manager of a component, the folder picker for its path), Dados pessoais (enabled, severity, hook.mode, tools.*, fix.*),
// Dependências (.jgates/dependencies.yml: managers, registries by the NAME of the secret), Imagem de extensão (the
// Dockerfile, its state and Reconstruir) and the navigation (Ferramentas, Dados pessoais and Política inside the
// configuration area). Keyboard, 375 px, pt-BR and en.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const FAKE = path.join(REPO, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version as string;
const TOOLS_ID = `sha256:${"a".repeat(64)}`;

const read = (file: string) => fs.readFileSync(file, "utf8");

async function withServer(run: (ctx: { fixture: Fixture; server: UiServer }) => Promise<void>, prepare?: (fixture: Fixture) => void): Promise<void> {
  const fixture = createFixture();
  let server: UiServer | null = null;
  try {
    prepare?.(fixture);
    server = await startServer(fixture);
    await run({ fixture, server });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

function language(fixture: Fixture, value: "pt-BR" | "en"): void {
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language: value }, null, 2)}\n`, { mode: 0o600 });
}

/** Opens a hash route inside the app (the bootstrap link first, so the session cookie exists). */
async function open(page: Page, server: UiServer, hash: string, lang: "pt-BR" | "en" = "pt-BR"): Promise<void> {
  await page.goto(server.bootstrapUrl);
  await expect(page.getByRole("navigation", { name: lang === "en" ? "Main navigation" : "Navegação principal" })).toBeVisible();
  await page.goto(`${page.url().split("#")[0]}#${hash}`);
}

async function noSidewaysScroll(page: Page, where: string): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(0);
}

async function serious(page: Page, label: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

/** No select with a single option: a choice of one is text. */
async function noSingleOptionSelect(page: Page, where: string): Promise<void> {
  const singles = await page.evaluate(() => [...document.querySelectorAll("select")].filter((s) => s.getBoundingClientRect().width > 0 && s.options.length === 1).map((s) => s.id || s.getAttribute("aria-label") || s.outerHTML.slice(0, 80)));
  expect(singles, `${where}: selects with one option`).toEqual([]);
}

const ROOT_TAIL = (dir: string) => read(path.join(dir, "jgates.yml"));

test("Execução has controls for every key, presets plus Outro valor, and one save with the diff", async ({ page }) => {
  await withServer(async ({ fixture, server }) => {
    const root = path.join(fixture.dir, "jgates.yml");
    const before = read(root);
    await open(page, server, "/config/execution");
    await expect(page.getByRole("heading", { name: "Execução", level: 1 })).toBeVisible();

    // The three keys that only the YAML had, with controls: a select of presets, a choice and a switch. failFast is a switch too.
    await expect(page.locator('[data-field="dataMaxAgeDays"] select')).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Imagens de extensão no jgates ci" })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Aceitar o que o próprio projeto relata" })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Parar na primeira falha" })).toHaveAttribute("aria-checked", "false");
    await expect(page.locator('[data-field="failFast"] select')).toHaveCount(0);
    // Durations and sizes: presets, then Outro valor.
    const days = page.getByLabel("Idade máxima dos dados de vulnerabilidades", { exact: true });
    expect(await days.locator("option").allTextContents()).toEqual(["1 dia", "3 dias", "7 dias", "14 dias", "30 dias", "Outro valor…"]);
    await expect(days).toHaveValue("7");
    const timeout = page.getByLabel("Limite de tempo de cada verificação");
    expect(await timeout.locator("option").allTextContents()).toEqual(["Sem limite", "30 segundos", "60 segundos", "120 segundos", "300 segundos", "600 segundos", "1800 segundos", "3600 segundos", "Outro valor…"]);
    await noSingleOptionSelect(page, "Execução");

    // No button per field: one "Revisar e salvar", disabled until something changes.
    const review = page.getByRole("button", { name: /^Revisar e salvar/ });
    await expect(review).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Salvar/ })).toHaveCount(0);

    // Change five keys with the controls, one of them by the keyboard.
    await page.getByRole("radio", { name: "Negada" }).check();
    const failFast = page.getByRole("switch", { name: "Parar na primeira falha" });
    await failFast.focus();
    await page.keyboard.press("Space");
    await expect(failFast).toHaveAttribute("aria-checked", "true");
    await days.selectOption("14");
    await page.getByRole("radio", { name: "Fixar por digest" }).check();
    await page.getByRole("switch", { name: "Aceitar o que o próprio projeto relata" }).click();
    await timeout.selectOption({ label: "Outro valor…" });
    await page.getByLabel("Outro valor de Limite de tempo de cada verificação").fill("90");
    await expect(review).toHaveText("Revisar e salvar 6 alterações");
    expect(read(root)).toBe(before);
    // The free-text check: the only typed box is the number of Outro valor.
    expect(await expectNoKnownSetAsText(page, "main", "Execução")).toBe(1);

    await review.click();
    const dialog = page.getByRole("dialog", { name: "Salvar a configuração de execução" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".diff-line.add").first()).toBeVisible();
    const added = (await dialog.locator(".diff-line.add > span:last-child").allTextContents()).map((l) => l.replace(/^linha adicionada: /, "").trim());
    expect(added).toEqual(expect.arrayContaining(["network: deny", "failFast: true", "dataMaxAgeDays: 14", "extensionImage: pinned", "trustSelfReported: true", "timeoutSeconds: 90"]));
    // Still nothing written before the confirmation.
    expect(read(root)).toBe(before);
    await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Revisar e salvar/ })).toBeDisabled();

    const after = ROOT_TAIL(fixture.dir);
    expect(after).toContain(before.trimEnd());
    expect(after).toMatch(/^execution:\n(?: {2}.+\n)+/m);
    for (const line of ["network: deny", "failFast: true", "dataMaxAgeDays: 14", "extensionImage: pinned", "trustSelfReported: true", "timeoutSeconds: 90"]) expect(after).toContain(`  ${line}`);
    await expect(page.getByRole("radio", { name: "Negada" })).toBeChecked();
    await expect(days).toHaveValue("14");

    // Back to the inherited value removes the key; discarding drops the draft.
    await page.getByRole("button", { name: "Voltar ao herdado: Idade máxima dos dados de vulnerabilidades" }).click();
    await expect(page.getByRole("button", { name: /^Revisar e salvar/ })).toBeEnabled();
    await page.getByRole("button", { name: "Descartar alterações" }).click();
    await expect(page.getByRole("button", { name: /^Revisar e salvar/ })).toBeDisabled();
    expect(await serious(page, "execution")).toEqual([]);

    // 375 px.
    await page.setViewportSize({ width: 375, height: 800 });
    await noSidewaysScroll(page, "Execução 375");
  });
});

test("Execução in English and with a conflicting external change", async ({ page }) => {
  await withServer(
    async ({ fixture, server }) => {
      await open(page, server, "/config/execution", "en");
      await expect(page.getByRole("heading", { name: "Execution", level: 1 })).toBeVisible();
      await expect(page.getByRole("switch", { name: "Accept what the project reports about itself" })).toBeVisible();
      const days = page.getByLabel("Maximum age of the vulnerability data");
      expect(await days.locator("option").allTextContents()).toEqual(["1 day", "3 days", "7 days", "14 days", "30 days", "Other value…"]);
      await page.getByRole("radio", { name: "Forbid" }).check();
      // The file changes behind the screen: the save reports it instead of overwriting.
      const root = path.join(fixture.dir, "jgates.yml");
      fs.appendFileSync(root, "\n# changed elsewhere\n");
      await page.getByRole("button", { name: "Review and save 1 change" }).click();
      const dialog = page.getByRole("dialog", { name: "Save the execution settings" });
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("jgates.yml changed");
      expect(read(root)).not.toContain("extensionImage");
      await dialog.getByRole("button", { name: "Reload" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("radio", { name: "Not set" })).toBeChecked();
    },
    (fixture) => language(fixture, "en"),
  );
});

test("the configuration area lists Ferramentas, Dados pessoais, Política, Dependências and Imagem de extensão, and nothing is under Outras telas", async ({ page }) => {
  await withServer(async ({ server }) => {
    await open(page, server, "/config");
    const nav = page.getByRole("navigation", { name: "Navegação principal" });
    await expect(nav.getByText("Outras telas")).toHaveCount(0);
    const sub = nav.locator("ul.nav-sub");
    for (const name of ["Perfil", "Templates", "Ferramentas", "Arquitetura", "Execução", "YAML", "Política de CI", "Serviços", "Dados pessoais", "Dependências", "Imagem de extensão"]) {
      await expect(sub.getByRole("link", { name: name === "Política de CI" ? /Pol[ií]tica/ : name, exact: name !== "Política de CI" }).first(), `${name} is a configuration entry`).toBeVisible();
    }
    // Each one opens its screen with the configuration area still open and the page named in the breadcrumb.
    await sub.getByRole("link", { name: "Dados pessoais" }).click();
    await expect(page.getByRole("heading", { name: "Dados pessoais (PII)", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Navegação estrutural" }).or(page.locator("nav.breadcrumb"))).toContainText("Dados pessoais");
    await expect(sub.getByRole("link", { name: "Dados pessoais" })).toHaveAttribute("aria-current", "page");
    await sub.getByRole("link", { name: "Ferramentas", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();
    await expect(sub.getByRole("link", { name: "Ferramentas", exact: true })).toHaveAttribute("aria-current", "page");
    // A tool page keeps the area open on Ferramentas.
    await page.goto(`${page.url().split("#")[0]}#/tools/ruff`);
    await expect(nav.locator("ul.nav-sub")).toBeVisible();
    await expect(nav.locator("ul.nav-sub").getByRole("link", { name: "Ferramentas", exact: true })).toHaveAttribute("aria-current", "page");
  });
});

const PII_YML = `# PII settings (kept)
schemaVersion: 1
enabled: true
tools:
  scrub:
    command: scrubber # the external tool
    timeoutSeconds: 30
fix:
  tools: [scrub]
  backupRetentionDays: 7
hook:
  mode: block
`;

test("Dados pessoais has controls for enabled, severity, hook.mode, tools.* and fix.*, a title and no empty banner", async ({ page }) => {
  await withServer(
    async ({ fixture, server }) => {
      const file = path.join(fixture.dir, ".jgates", "pii.yml");
      await open(page, server, "/config");
      await page.getByRole("navigation", { name: "Navegação principal" }).locator("ul.nav-sub").getByRole("link", { name: "Dados pessoais" }).click();
      await expect(page.getByRole("heading", { name: "Dados pessoais (PII)", level: 1 })).toBeVisible();
      // No file yet: the notice says so once, and the green status banner is not there empty.
      await expect(page.getByText("O arquivo ainda não existe").first()).toBeVisible();
      await expect(page.getByTestId("pii-status")).toBeEmpty();
      expect(await page.locator(".notice.ok").evaluateAll((els) => els.filter((e) => (e.textContent ?? "").trim() === "").length)).toBe(0);
      expect(fs.existsSync(file)).toBe(false);

      // The file appears (by hand); the screen shows every key with a control.
      fs.writeFileSync(file, PII_YML);
      await page.reload();
      const other = page.getByTestId("pii-other");
      await expect(other.getByRole("heading", { name: "Instância, ferramentas externas e hook" })).toBeVisible();
      await expect(other.locator('[data-field="enabled"] [role="switch"]')).toBeVisible();
      await expect(other.locator('[data-field="severity"] select, [data-field="severity"] [role="radiogroup"]').first()).toBeVisible();
      await expect(other.locator('[data-field="hook.mode"] select, [data-field="hook.mode"] [role="radiogroup"]').first()).toBeVisible();
      await expect(other.locator('[data-field="tools.scrub.command"]')).toBeVisible();
      await expect(other.locator('[data-field="tools.scrub.timeoutSeconds"] select')).toBeVisible();
      await expect(other.locator('[data-field="fix.backupRetentionDays"] select')).toBeVisible();
      await expect(other.locator('[data-field="fix.tools"]')).toBeVisible();
      await noSingleOptionSelect(page, "Dados pessoais");
      expect(await expectNoKnownSetAsText(page, '[data-testid="pii-other"]', "Dados pessoais")).toBeGreaterThan(0);

      // Change hook.mode: a diff, then Salvar; the rest of the file is untouched.
      const before = read(file);
      const hook = other.locator('[data-field="hook.mode"]');
      const control = hook.locator("select, [role='radiogroup']").first();
      if ((await control.evaluate((el) => el.tagName)) === "SELECT") await control.selectOption("off");
      else await hook.getByRole("radio", { name: /off|Desligado/i }).check();
      await hook.getByRole("button", { name: /^Revisar e salvar/ }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.locator(".diff-line.add")).toContainText("mode: off");
      await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(read(file)).toBe(before.replace("mode: block", "mode: off"));
      expect(read(file)).toContain("scrubber # the external tool");

      // The entity table and the derived form share the file: a switch in the table does not lose the revision.
      await page.getByRole("checkbox", { name: "Detectar Telefone" }).click();
      await expect(page.getByTestId("pii-status")).toContainText("Alteração gravada em .jgates/pii.yml");
      expect(read(file)).toMatch(/phone:\s*\n\s+enabled: true/);
      expect(read(file)).toContain("mode: off");

      expect(await serious(page, "pii")).toEqual([]);
      await page.setViewportSize({ width: 375, height: 800 });
      await noSidewaysScroll(page, "pii 375");
    },
    (fixture) => fs.rmSync(path.join(fixture.dir, ".jgates", "pii.yml"), { force: true }),
  );
});

const WORKSPACE_YML = `# Workspace of the demo (kept)
schemaVersion: 1
discovery:
  mode: auto
components:
  - id: demo
    path: demo
    language: python
    kind: library # kept
    dependencies:
      manager: pip
`;

test("Workspace: kind, enabled, include, exclude, manager and groups have controls; the path is a folder picker", async ({ page }) => {
  await withServer(
    async ({ fixture, server }) => {
      const file = path.join(fixture.dir, ".jgates", "workspace.yml");
      await open(page, server, "/workspace");
      const card = page.locator('article[data-component="demo"]');
      await expect(card).toBeVisible();
      await card.getByText("Mais campos de demo").click();
      const fields = card.getByTestId("component-fields");
      await expect(fields.locator('[data-field="components[0].kind"] input')).toHaveValue("library");
      await expect(fields.locator('[data-field="components[0].enabled"] [role="switch"]')).toBeVisible();
      await expect(fields.locator('[data-field="components[0].include"]')).toBeVisible();
      await expect(fields.locator('[data-field="components[0].exclude"]')).toBeVisible();
      await expect(fields.locator('[data-field="components[0].dependencies.manager"] select option:checked')).toHaveText("pip");
      await expect(fields.locator('[data-field="components[0].dependencies.groups"]')).toBeVisible();
      await noSingleOptionSelect(page, "Workspace");

      // Switch the component off: it saves at once, shows the change and keeps the comments.
      const before = read(file);
      await expect(fields.locator('[data-field="components[0].enabled"] [role="switch"]')).toHaveAttribute("aria-checked", "true");
      await fields.locator('[data-field="components[0].enabled"] [role="switch"]').click();
      await expect(fields.getByTestId("df-undo")).toBeVisible();
      expect(read(file)).toContain("# kept");
      expect(read(file)).toContain("enabled: false");
      expect(read(file).replace(/\n {4}enabled: false/, "")).toBe(before);

      // The dependency manager is a select of the known managers.
      await fields.locator('[data-field="components[0].dependencies.manager"] select').selectOption({ label: "uv" });
      await fields.locator('[data-field="components[0].dependencies.manager"]').getByRole("button", { name: /^Revisar e salvar/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(read(file)).toContain("manager: uv");

      // discovery.enabled sits in the scope tab with the mode.
      await page.getByRole("tab", { name: /Detecção e escopo/ }).click();
      await expect(page.getByTestId("ws-discovery-switch").locator('[role="switch"]')).toBeVisible();

      // The path of a component is picked from the folders of the project, never typed unless Outro.
      await page.getByRole("tab", { name: /Componentes/ }).click();
      await page.getByRole("button", { name: "Declarar componente" }).click();
      const dialog = page.getByRole("dialog", { name: "Declarar componente" });
      const pathField = dialog.getByLabel("Caminho", { exact: true });
      expect(await pathField.evaluate((el) => el.tagName)).toBe("SELECT");
      await expect(pathField).toBeFocused();
      await expect(pathField.locator("option", { hasText: "demo" }).first()).toBeAttached();
      await pathField.selectOption("demo");
      await expect(dialog.getByLabel("Identificador")).toHaveValue(/demo/);
      expect(await serious(page, "workspace")).toEqual([]);
      await page.setViewportSize({ width: 375, height: 800 });
      const overflow = await page.locator("dialog[open]").evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    },
    (fixture) => fs.writeFileSync(path.join(fixture.dir, ".jgates", "workspace.yml"), WORKSPACE_YML),
  );
});

test("Dependências creates .jgates/dependencies.yml, edits registries by the name of the secret and never shows a token value", async ({ page }) => {
  const TOKEN = "s3cr3t-token-value-0123456789";
  await withServer(
    async ({ fixture, server }) => {
      const file = path.join(fixture.dir, ".jgates", "dependencies.yml");
      await open(page, server, "/config");
      await page.getByRole("navigation", { name: "Navegação principal" }).locator("ul.nav-sub").getByRole("link", { name: "Dependências" }).click();
      await expect(page.getByRole("heading", { name: "Dependências", level: 1 })).toBeVisible();
      await expect(page.getByRole("table", { name: "Gerenciador de dependências de cada componente" })).toBeVisible();
      // The file does not exist: one action creates it from the template.
      expect(fs.existsSync(file)).toBe(false);
      await expect(page.getByTestId("dep-missing")).toBeVisible();
      await page.getByRole("button", { name: "Criar .jgates/dependencies.yml" }).click();
      await expect(page.getByTestId("dep-missing")).toHaveCount(0);
      expect(read(file)).toContain("schemaVersion: 1");

      // The registry has a URL and the NAME of the secret; there is no field for a value.
      const form = page.getByTestId("derived-form");
      await expect(form).toBeVisible();
      await expect(form.locator('[data-field="registries.node.url"]')).toBeVisible();
      await expect(form.locator('[data-field="registries.node.tokenSecret"]')).toBeVisible();
      expect(await page.locator('input[type="password"]').count()).toBe(0);
      const url = form.locator('[data-field="registries.node.url"] input');
      await url.fill("https://registry.example.com/npm/");
      await form.locator('[data-field="registries.node.url"]').getByRole("button", { name: /^Revisar e salvar/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true }).click();
      await expect(page.getByTestId("df-undo")).toContainText("salvo em .jgates/dependencies.yml");
      await expect(url).toHaveValue("https://registry.example.com/npm/");
      const secret = form.locator('[data-field="registries.node.tokenSecret"] input');
      await secret.fill("NPM_TOKEN");
      await form.locator('[data-field="registries.node.tokenSecret"]').getByRole("button", { name: /^Revisar e salvar/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(read(file)).toContain("url: https://registry.example.com/npm/");
      expect(read(file)).toContain("tokenSecret: NPM_TOKEN");
      // The value of the token (in the server environment) is nowhere on the screen or in the file.
      expect(await page.locator("body").innerText()).not.toContain(TOKEN);
      expect(read(file)).not.toContain(TOKEN);
      expect(await serious(page, "dependencies")).toEqual([]);
      await page.setViewportSize({ width: 375, height: 800 });
      await noSidewaysScroll(page, "dependencies 375");
    },
    (fixture) => {
      fixture.env.NPM_TOKEN = TOKEN;
    },
  );
});

function fakeEngine(fixture: Fixture): string {
  const engine = fs.mkdtempSync(path.join(fixture.home, "engine-"));
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    [
      `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};`,
      `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`,
      `process.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};`,
      `process.env.FAKE_DOCKER_IMAGE_ID = ${JSON.stringify(TOOLS_ID)};`,
      `require(${JSON.stringify(FAKE)});`,
      ``,
    ].join("\n"),
  );
  fixture.env.JGATES_IMAGE_JSON = "";
  fixture.env.JGATES_CONTAINER_RUNTIME = runtime;
  fixture.env.JGATES_TOOLS_IMAGE = "jgates-tools:dev";
  fixture.env.JGATES_NO_CACHE = "1";
  return engine;
}

test("Imagem de extensão shows the Dockerfile and its state, and Reconstruir builds through the existing build", async ({ page }) => {
  let engine = "";
  await withServer(
    async ({ fixture, server }) => {
      await open(page, server, "/config/image");
      await expect(page.getByRole("heading", { name: "Imagem de extensão", level: 1 })).toBeVisible();
      await expect(page.getByTestId("img-state")).toHaveAttribute("data-status", "outdated");
      await expect(page.getByTestId("img-state-text")).toContainText("ainda não foi construída");
      await expect(page.getByTestId("img-dockerfile")).toContainText("FROM ${JGATES_TOOLS}");
      await expect(page.getByTestId("img-dockerfile")).toContainText("uv tool install acme-lint==1.0");
      expect(await serious(page, "extension image")).toEqual([]);

      await page.getByRole("button", { name: "Reconstruir" }).click();
      await expect(page.getByTestId("img-built")).toBeVisible({ timeout: 120_000 });
      await expect(page.getByTestId("img-state")).toHaveAttribute("data-status", "ready");
      const calls = fs
        .readFileSync(path.join(engine, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
      const builds = calls.filter((c) => c[0] === "build");
      expect(builds).toHaveLength(1);
      expect(builds[0]).toContain("org.jgates.kind=extension-image");

      // The Dockerfile changes: outdated again, and the cause is the files.
      fs.appendFileSync(path.join(fixture.dir, ".jgates", "image", "Dockerfile"), "RUN echo changed\n");
      await page.reload();
      await expect(page.getByTestId("img-state")).toHaveAttribute("data-status", "outdated");
      await expect(page.getByTestId("img-state-text")).toContainText("mudou desde a última construção");
      await page.setViewportSize({ width: 375, height: 800 });
      await noSidewaysScroll(page, "image 375");
    },
    (fixture) => {
      engine = fakeEngine(fixture);
      fs.mkdirSync(path.join(fixture.dir, ".jgates", "image"), { recursive: true });
      fs.writeFileSync(path.join(fixture.dir, ".jgates", "image", "Dockerfile"), "ARG JGATES_TOOLS\nFROM ${JGATES_TOOLS}\nRUN uv tool install acme-lint==1.0\n");
    },
  );
});

test("Imagem de extensão without a Dockerfile says so and offers the own-tool flow", async ({ page }) => {
  await withServer(
    async ({ server }) => {
      await open(page, server, "/config/image");
      await expect(page.getByTestId("img-state")).toHaveAttribute("data-status", "none");
      await expect(page.getByTestId("img-missing")).toBeVisible();
      await expect(page.getByRole("button", { name: "Reconstruir" })).toHaveCount(0);
    },
    (fixture) => {
      fakeEngine(fixture);
    },
  );
});
