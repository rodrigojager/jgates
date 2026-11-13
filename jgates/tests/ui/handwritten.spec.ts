import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IN_IMAGE, PYTHON, REPO, RUFF, openApp, pageGet, removeDir, startServer, type Fixture, type UiServer } from "./support";

// A hand-written configuration on every guided screen (PLAN-config-editing.md section 6, V2-66). The project is a copy of
// jgates/tests/fixtures/handwritten: a ZAP instance with a key its hand-written form does not know (auth), a zizmor
// instance, an own tool with a command and arguments, a profile with `extends` and selectors the check tree has no row
// for, a template file of the project, comments in every file, services.profiles, and one invalid key (hook.modo in
// .jgates/pii.yml) that makes the whole configuration invalid. Perfil, Ferramentas and each tool page, Templates,
// Execução, Arquitetura, Serviços, Workspace, Dados pessoais, Política and Dependências open on it without a blank or
// error screen, show each hand-written key with a control (the keys are read from the forms API, so a key the screen
// leaves out fails here), and the invalid key shows as a diagnostic with a link to its line. The writes are checked byte
// for byte in tests/v2/v2-66-handwritten-config-survives.mjs.

const FIXTURE = path.join(REPO, "jgates", "tests", "fixtures", "handwritten");
/** What counts as a control in a row: something a person can type in, pick, check or switch. */
const CONTROL = "input:not([type=hidden]), select, textarea, [role=switch], [role=radio], [role=radiogroup]";

/** The git executable of the machine running the tests (the server's PATH is empty: it gets it as JGATES_GIT). */
function findGit(): string | null {
  const names = process.platform === "win32" ? ["git.exe", "git.cmd"] : ["git"];
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

function createHandwritten(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ui-hand-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ui-home-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ui-store-"));
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ui-bin-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, ...IN_IMAGE, JGATES_HOME: home, SEMANTIC_GATE_HOME: store, JGATES_PYTHON: PYTHON, JGATES_RUFF: RUFF, PATH: emptyBin };
  for (const name of Object.keys(env)) if (/_API_KEY$|^SEMANTIC_GATE_(?!HOME$)/.test(name)) delete env[name];
  // A repository, for the screens that read the branches (the pickers of git refs).
  const git = findGit();
  if (git) {
    const run = (...args: string[]) => spawnSync(git, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    run("init", "-q", "-b", "main");
    run("add", "-A");
    run("commit", "-q", "-m", "hand-written configuration");
    env.JGATES_GIT = git;
  }
  return {
    dir,
    home,
    store,
    pyproject: path.join(dir, "pyproject.toml"),
    env,
    cleanup() {
      for (const d of [dir, home, store, emptyBin]) removeDir(d);
    },
  };
}

let fixture: Fixture;
let server: UiServer;
let context: BrowserContext;
let page: Page;
let base = "";
const pageErrors: string[] = [];
const original = new Map<string, Buffer>();

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  fixture = createHandwritten();
  for (const file of fs.readdirSync(path.join(fixture.dir, ".jgates"), { recursive: true }) as string[]) {
    const abs = path.join(fixture.dir, ".jgates", file);
    if (fs.statSync(abs).isFile()) original.set(abs, fs.readFileSync(abs));
  }
  original.set(path.join(fixture.dir, "jgates.yml"), fs.readFileSync(path.join(fixture.dir, "jgates.yml")));
  server = await startServer(fixture);
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "pt-BR" });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (e) => pageErrors.push(e.message));
  base = await openApp(page, server);
});

test.afterAll(async () => {
  await context?.close();
  await server?.stop();
  fixture?.cleanup();
});

/** Opening the screens writes nothing: every configuration file keeps its bytes. */
test.afterEach(() => {
  for (const [abs, bytes] of original) expect(fs.readFileSync(abs).equals(bytes), `${path.relative(fixture.dir, abs)} untouched`).toBe(true);
});

/** Opens a screen and waits for its title and what it loads; nothing on it is an error notice and the page threw nothing. */
async function open(route: string): Promise<void> {
  const before = pageErrors.length;
  await page.goto(`${base}#${route}`);
  await page.reload();
  await expect(page.locator("main h1").first()).toBeVisible({ timeout: 45_000 });
  await expect(page.locator("main .spinner, main [role=status].loading")).toHaveCount(0, { timeout: 45_000 }).catch(() => undefined);
  await settle();
  expect(pageErrors.slice(before), `${route}: no page error`).toEqual([]);
}

/** No error notice and nothing still loading on the screen. */
async function settle(): Promise<void> {
  await expect(page.locator("main [aria-busy=true]")).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator("main .notice.error")).toHaveCount(0);
}

const fieldRow = (scope: Page | Locator, id: string): Locator => scope.locator(`[data-field=${JSON.stringify(id)}]`).first();

/** Each of these rows of a derived form is visible and has a control. */
async function expectRows(scope: Page | Locator, ids: string[], what: string): Promise<void> {
  expect(ids.length, `${what}: keys to check`).toBeGreaterThan(0);
  for (const id of ids) {
    const row = fieldRow(scope, id);
    await expect(row, `${what}: ${id} is shown`).toBeVisible();
    await expect(row.locator(CONTROL).first(), `${what}: ${id} has a control`).toBeVisible();
  }
}

interface ApiField {
  id: string;
  path: Array<string | number>;
  state: string;
  widget: string;
}

/** The keys written in a file (or an instance), as the forms API lists them: every one must have a control. */
async function writtenKeys(source: { file: string } | { instance: string }, keep: (f: ApiField) => boolean = () => true): Promise<string[]> {
  const url = "file" in source ? `/api/forms/derived/file?file=${encodeURIComponent(source.file)}` : `/api/forms/derived/instance/${encodeURIComponent(source.instance)}`;
  const { form } = await pageGet(page, url);
  return (form.fields as ApiField[]).filter((f) => f.state !== "inherited" && f.widget !== "readonly" && keep(f)).map((f) => f.id);
}

/** The diagnostic of the invalid key: file, key, line and a link that opens the YAML editor at that key. */
async function expectTypoDiagnostic(scope: Locator): Promise<void> {
  const item = scope.locator("li", { hasText: "hook.modo" }).first();
  await expect(item).toBeVisible();
  await expect(item).toContainText(".jgates/pii.yml");
  await expect(item).toContainText("15");
  const href = await item.getByTestId("diag-line-link").getAttribute("href");
  expect(href).toContain("#/config/yaml?file=.jgates/pii.yml");
  expect(href).toContain("path=hook.modo");
}

test("Perfil shows the hand-written profiles, their selectors and the project defaults, with the invalid key as a diagnostic", async () => {
  test.setTimeout(240_000);
  await open("/config");
  await expectTypoDiagnostic(page.getByTestId("config-diagnostics"));

  // The editor of the profile: every key written under profiles.team except the checks (the tree below).
  const team = await writtenKeys({ file: ".jgates/profiles.yml" }, (f) => f.path[1] === "team" && f.path[2] !== "checks");
  expect(team).toEqual(expect.arrayContaining(["profiles.team.label", "profiles.team.description", "profiles.team.extends", "profiles.team.scope"]));
  await expectRows(page, team, "Perfil team");

  // The checks: the selectors without a row in the category tree, then the tree's own.
  await expect(page.locator('[data-selector="pii:cpf"]').locator(CONTROL).first()).toBeVisible();
  await expect(page.locator('[data-selector="architecture:domain-isolation"]').locator(CONTROL).first()).toBeVisible();
  for (const [category, selector, tools] of [
    ["Qualidade", "capability:lint", null],
    ["Segurança", "capability:secrets", null],
    ["Verificações próprias", "tool:my-lint", /Ferramentas de compile/],
  ] as const) {
    const row = page.locator(`[data-selector="${selector}"]`).first();
    if (!(await row.isVisible())) await page.getByRole("button", { name: `Abrir a categoria ${category}` }).click();
    if (tools && !(await row.isVisible())) await page.getByRole("button", { name: tools }).click();
    await expect(row.locator(CONTROL).first(), selector).toBeVisible();
  }
  // tool:my-lint is "when available" in the file: a three-state select, on "available".
  await expect(page.locator('[data-selector="tool:my-lint"] select').first()).toHaveValue("available");

  // The project defaults of jgates.yml (scope, extends); the default profile is the card marked Padrão.
  const defaults = await writtenKeys({ file: "jgates.yml" }, (f) => f.path[0] === "extends" || (f.path[0] === "selection" && f.path[1] !== "profile"));
  await expectRows(page.getByTestId("project-defaults"), defaults, "Perfil defaults");

  // The other profile: its own label, parent and checks.
  await page.locator('[data-testid=profile-card][data-profile="quick"]').getByRole("button", { name: /^Editar/ }).first().click();
  await expect(page.getByRole("heading", { name: /Editando o perfil Rápido/ })).toBeVisible();
  const quick = await writtenKeys({ file: ".jgates/profiles.yml" }, (f) => f.path[1] === "quick" && f.path[2] !== "checks");
  await expectRows(page, quick, "Perfil quick");
  await expect(page.locator('[data-selector="capability:sast"]').first()).toBeAttached();
  await settle();
});

test("Ferramentas lists the hand-written instances and the tools the templates bring, with the invalid key as a diagnostic", async () => {
  await open("/tools");
  const effective = page.getByTestId("tools-effective");
  await expectTypoDiagnostic(effective.getByTestId("config-diagnostics"));
  for (const tool of ["dast", "workflows", "my-lint", "team-extras-check"]) {
    await expect(effective.locator(`[data-testid=effective-tool][data-tool="${tool}"] a`).first(), `${tool} listed`).toBeVisible();
  }
  for (const instance of ["dast", "workflows", "my-lint"]) await expect(page.locator(`[data-testid=tool-card][data-instance="${instance}"]`)).toBeVisible();
});

test("each tool page shows every key of its instance with a control: the settings form, the keys it does not know and the own tool", async () => {
  test.setTimeout(240_000);
  // ZAP: the hand-written form, then the keys it has no field for (auth) in the derived form under it.
  await open("/tools/dast");
  const settings = page.getByTestId("settings-form");
  await expect(settings.getByLabel(/URL do alvo/)).toHaveValue("http://localhost:8000");
  await expect(settings.locator('input[type=radio][value="passive"]')).toBeChecked();
  await expect(settings.locator("select").filter({ has: page.locator('option[value="high"]') }).first()).toHaveValue("high");
  await expect(page.getByTestId("rtf-kept")).toHaveCount(0);
  await expect(page.getByText(/Nenhum alvo configurado/)).toHaveCount(0);
  const overlay = new Set(["capabilities", "target", "mode", "allowActive", "spec", "blockingRisk", "spiderMinutes"]);
  const dast = await writtenKeys({ instance: "dast" }, (f) => !overlay.has(String(f.path[2])));
  expect(dast).toEqual(expect.arrayContaining(["tools.dast.auth.header", "tools.dast.auth.valueEnv", "tools.dast.timeoutSeconds"]));
  await expectRows(page.getByTestId("tool-settings"), dast, "dast");
  await expect(fieldRow(page, "tools.dast.auth.valueEnv").locator("input").first()).toHaveValue("DAST_TOKEN");

  // zizmor: no hand-written form, every key in the derived form.
  await open("/tools/workflows");
  await expectRows(page, await writtenKeys({ instance: "workflows" }), "workflows");

  // The own tool: command, arguments, capabilities, timeout and its config, and no false "no command" problem.
  await open("/tools/my-lint");
  await expect(page.getByText(/não declara o executável/)).toHaveCount(0);
  const own = await writtenKeys({ instance: "my-lint" });
  expect(own).toEqual(expect.arrayContaining(["tools.my-lint.command", "tools.my-lint.args", "tools.my-lint.capabilities", "tools.my-lint.timeoutSeconds"]));
  await expectRows(page, own, "my-lint");
  await expect(fieldRow(page, "tools.my-lint.command").locator("input").first()).toHaveValue("python");
  // Its six steps open filled with the command and the arguments as written.
  await page.getByRole("button", { name: /Editar my-lint/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".notice.error")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("Templates: the template of the project shows its entry in jgates.yml and every key of its file with a control", async () => {
  test.setTimeout(180_000);
  await open("/config/templates");
  await page.getByRole("button", { name: "Ver os detalhes do template Extras do time" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("template-detail")).toBeVisible();
  // Both forms are folded (the dialog stays short): open them.
  await dialog.getByTestId("template-entry").locator("summary").click();
  await dialog.getByTestId("template-keys").locator("summary").click();
  const entry = await writtenKeys({ file: "jgates.yml" }, (f) => f.path[0] === "templates" && f.path[1] === 2);
  expect(entry).toEqual(expect.arrayContaining(["templates[2].activation", "templates[2].priority"]));
  await expectRows(dialog.getByTestId("template-entry"), entry.filter((id) => !/\.(id|source)$/.test(id)), "template entry");
  const keys = await writtenKeys({ file: ".jgates/templates/team-extras.yml" });
  expect(keys).toEqual(expect.arrayContaining(["description", "priority", "config.execution.timeoutSeconds"]));
  await expectRows(dialog.getByTestId("template-keys"), keys, "template file");
  await expect(dialog.locator(".notice.error")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The stepper opens on the template's own command.
  await page.getByRole("button", { name: "Editar o template Extras do time" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").locator(".notice.error")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("Execução shows the values of jgates.yml with their controls while the configuration is invalid", async () => {
  await open("/config/execution");
  await expectTypoDiagnostic(page.getByTestId("config-diagnostics"));
  for (const key of ["concurrency", "network", "timeoutSeconds", "dataMaxAgeDays"]) await expect(fieldRow(page, key).locator(CONTROL).first(), key).toBeVisible();
  await expect(fieldRow(page, "concurrency").locator("select").first()).toHaveValue("2");
  await expect(fieldRow(page, "dataMaxAgeDays").locator("select").first()).toHaveValue("14");
});

test("Arquitetura shows every key of the hand-written layers and rules with a control", async () => {
  await open("/config/architecture");
  await expect(page.getByTestId("toggle-domain-isolation")).toBeVisible();
  const keys = await writtenKeys({ file: ".jgates/architecture.yml" });
  expect(keys).toEqual(expect.arrayContaining(["architecture.layers[0].label", "architecture.rules[0].severity", "architecture.rules[0].message"]));
  await expectRows(page.getByTestId("arch-keys"), keys, "architecture");
});

test("Serviços shows the compose files, the target, the wait time and the compose profiles written by hand", async () => {
  await open("/config/services");
  await expect(page.getByText("compose.yaml").first()).toBeVisible();
  await page.locator('button[data-step="target"]').click();
  await expect(page.getByTestId("svc-app-health")).toHaveValue("/health");
  // "Usar como alvo" would replace the URL written in the ZAP instance: it starts unchecked.
  await expect(page.getByTestId("svc-set-targets")).not.toBeChecked();
  await page.locator('button[data-step="review"]').click();
  await page.getByTestId("svc-customize").locator("summary").click();
  await expect(page.getByTestId("svc-timeout")).toHaveValue("90");
  const profiles = page.getByTestId("svc-profiles");
  await expect(profiles.locator('input[value="backend"]')).toBeChecked();
  await expect(profiles.locator('input[value="debug"]')).toBeChecked();
  await expect(profiles).toContainText("debug");
  await settle();
});

test("Workspace shows the declared component's keys and the scope written by hand", async () => {
  await open("/workspace");
  const fields = page.locator('[data-component-fields="app"]');
  await fields.locator("summary").click();
  const component = await writtenKeys({ file: ".jgates/workspace.yml" }, (f) => f.path[0] === "components" && !["id", "path", "language"].includes(String(f.path[2])));
  expect(component).toEqual(expect.arrayContaining(["components[0].kind", "components[0].include", "components[0].exclude", "components[0].dependencies.manager", "components[0].dependencies.groups"]));
  await expectRows(fields, component, "component app");
  await page.getByRole("tab", { name: "Detecção e escopo" }).click();
  await expectRows(page, await writtenKeys({ file: ".jgates/workspace.yml" }, (f) => f.path[0] === "discovery" && f.path[1] === "enabled"), "discovery");
  await expect(page.locator("main").getByText("build/**").first()).toBeVisible();
  await settle();
});

test("Dados pessoais shows every key of pii.yml and the invalid one as a custom field with its line and a link to it", async () => {
  await open("/tools/builtin-pii");
  // The entity table: CPF critical, phone off.
  await expect(page.locator("select").filter({ has: page.locator('option[value="critical"]') }).first()).toHaveValue("critical");
  const other = page.getByTestId("pii-other");
  const keys = await writtenKeys({ file: ".jgates/pii.yml" }, (f) => !["entities", "detection", "reporting", "remediation"].includes(String(f.path[0])));
  expect(keys).toEqual(expect.arrayContaining(["enabled", "severity", "hook.mode", "hook.modo"]));
  await expectRows(other, keys, "pii");
  const typo = fieldRow(other, "hook.modo");
  await expect(typo.locator(".df-diagnostics")).toContainText("15");
  const link = typo.locator('a[href*="#/config/yaml?file=.jgates/pii.yml"][href*="path=hook.modo"]').first();
  await expect(link).toBeVisible();
});

test("Política shows every rule, threshold and exception of the hand-written policy with a control", async () => {
  await open("/policy");
  const keys = await writtenKeys({ file: ".jgates/policy.yml" });
  expect(keys).toEqual(expect.arrayContaining(['rules["coverage.minimum"].threshold', "exceptions[0].expires"]));
  await expectRows(page, keys, "policy");
});

test("Dependências shows the private registry and the install command written by hand", async () => {
  await open("/config/dependencies");
  const keys = await writtenKeys({ file: ".jgates/dependencies.yml" });
  expect(keys).toEqual(expect.arrayContaining(["registries.python.url", "registries.python.tokenSecret", "install.command"]));
  await expectRows(page, keys, "dependencies");
  await expect(fieldRow(page, "registries.python.url").locator("input").first()).toHaveValue("https://pypi.example.test/simple");
});
