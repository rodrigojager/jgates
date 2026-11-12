import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expectNoKnownSetAsText } from "./free-text";
import { createFixture, openApp, pageGet, startServer, type Fixture, type UiServer } from "./support";

// The derived forms (ADR-0009, PLAN-config-editing.md sections 2-3) on the demo route #/config/form, for tool instances
// of adapters without a hand-written form (zizmor, file-size) and with one (oasdiff, zap):
//   - every key of the schema renders with the control of its widget, a hand-written unknown key as a custom text field,
//     each value says where it comes from, "Voltar ao herdado" removes the key and "Editar no YAML" links to
//     #/config/yaml?file=<file>&path=<key path>;
//   - pickers come from GET /api/pickers/<source>: project files filtered by pattern, folders, local branches, tags and
//     recent commits, the compose services and ports plus "URL...", each with "Outro..." for typing;
//   - a save shows the diff of the file first and writes only after "Salvar"; a switch saves at once and "Desfazer"
//     restores the previous bytes;
//   - keyboard only, 375 px with no horizontal scroll, pt-BR and en, and the free-text check on the rendered forms.

const TOOLS = `schemaVersion: 1
# Tools written by hand.
tools:
  ruff:
    adapter: ruff
    config: pyproject.toml
  zz:
    adapter: zizmor   # no hand-written form
    persona: pedantic
    myOwnKey: hello   # a key the schema does not know
  size:
    adapter: file-size
  api:
    adapter: oasdiff
  dast:
    adapter: zap
`;

const COMPOSE = `services:
  web:
    image: nginx
    ports: ["8080:80"]
  db:
    image: postgres
    expose: ["5432"]
`;

/** The git executable of the machine running the tests (the server's PATH is empty: it gets it as JGATES_GIT). */
function findGit(): string | null {
  const names = process.platform === "win32" ? ["git.exe", "git.cmd"] : ["git"];
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

function prepare(fixture: Fixture): void {
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(fixture.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(fixture.dir, rel), text);
  };
  write(".jgates/tools.yml", TOOLS);
  write("compose.yaml", COMPOSE);
  write("api/openapi.yaml", "openapi: 3.0.0\ninfo: { title: demo, version: '1' }\npaths: {}\n");
  write("docs/README.md", "# demo\n");
  write("src/app/main.py", "print('hi')\n");
  const git = findGit();
  if (!git) throw new Error("git is needed by the git-ref picker test");
  const run = (...args: string[]) => {
    const r = spawnSync(git, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: fixture.dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  run("init", "-q", "-b", "main");
  run("add", "-A");
  run("commit", "-q", "-m", "fixture commit");
  run("branch", "feature/x");
  run("tag", "v1.0");
  fixture.env.JGATES_GIT = git;
}

let fixture: Fixture;
let server: UiServer;
let context: BrowserContext;
let page: Page;
let base = "";

// One browser session for the file (the bootstrap link is used once).
test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  fixture = createFixture();
  prepare(fixture);
  server = await startServer(fixture);
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "pt-BR" });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  base = await openApp(page, server);
});

test.afterAll(async () => {
  await context?.close();
  await server?.stop();
  fixture?.cleanup();
});

const toolsFile = () => path.join(fixture.dir, ".jgates", "tools.yml");
const toolsText = () => fs.readFileSync(toolsFile(), "utf8");

async function openForm(query: string): Promise<Locator> {
  await page.goto(`${base}#/config/form?${query}`);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const form = page.getByTestId("derived-form");
  await expect(form).toBeVisible({ timeout: 30_000 });
  return form;
}

const row = (form: Locator, id: string) => form.locator(`[data-field="${id}"]`).first();

test("every key of a zizmor instance renders with its control, origin, custom field, YAML link and back to inherited", async () => {
  test.setTimeout(180_000);
  fs.writeFileSync(toolsFile(), TOOLS);
  const form = await openForm("instance=zz");
  const data = (await pageGet(page, "/api/forms/derived/instance/zz")).form;
  expect(data.fields.length).toBeGreaterThan(8);
  // One row per key the server derives, with the control of its widget.
  for (const f of data.fields) {
    const r = row(form, f.id);
    await expect(r, f.id).toHaveAttribute("data-widget", f.widget);
    const has = async (selector: string) => expect(r.locator(selector).first(), `${f.id} (${f.widget}) shows ${selector}`).toBeVisible();
    if (f.state === "custom") await has("input[type=text], textarea");
    else if (f.widget === "readonly") await has("[data-readonly]");
    else if (f.widget === "switch") await has("[role=switch]");
    else if (f.widget === "radio") await expect(r.locator("input[type=radio]")).toHaveCount(f.options.length);
    else if (f.widget === "select") await has("select");
    else if (f.widget === "number") await has((f.presets ?? []).length >= 2 ? "select" : "input[type=number]");
    else if (f.widget === "checklist") await expect(r.locator("input[type=checkbox]")).toHaveCount(f.options.length);
    else if (f.widget === "list") await has(".df-list");
    else if (f.widget === "choice") await has("[role=radiogroup]");
    else if (f.widget === "yaml") await has("textarea");
    else if (f.source) await has(`[data-picker="${f.source.name}"] select`);
    else await has("input[type=text]");
    // Where the value comes from, and the YAML editor at its key.
    await expect(r.getByTestId("df-origin").first()).not.toBeEmpty();
    await expect(r.getByRole("link", { name: /Editar no YAML/ }).first()).toHaveAttribute("href", `#/config/yaml?file=.jgates/tools.yml&path=${f.id}`);
  }
  await expect(form.locator("[data-field]")).toHaveCount(data.fields.length);

  // The persona radios (four values or fewer), set in this file; the time limit is a select of presets plus "Outro valor...".
  const persona = row(form, "tools.zz.persona");
  await expect(persona.getByRole("radio", { name: "pedantic" })).toBeChecked();
  await expect(persona.getByTestId("df-origin")).toContainText("Definido neste arquivo");
  await expect(row(form, "tools.zz.enabled").getByTestId("df-origin")).toContainText("Padrão");
  const timeout = row(form, "tools.zz.timeoutSeconds").locator("select");
  await expect(timeout.locator("option", { hasText: "Outro valor..." })).toHaveCount(1);
  await expect(timeout.locator("option", { hasText: "60 segundos" })).toHaveCount(1);

  // The hand-written key the schema does not know: a custom text field with its value.
  const custom = row(form, "tools.zz.myOwnKey");
  await expect(custom).toHaveAttribute("data-state", "custom");
  await expect(custom).toContainText("Campo personalizado");
  await expect(custom.locator("input[type=text]")).toHaveValue("hello");
  await expect(custom.locator("input[type=text]")).toHaveAttribute("data-free-text", "custom-key");

  // "Editar no YAML" opens the YAML screen at the file.
  await persona.getByRole("link", { name: /Editar no YAML/ }).click();
  await expect(page).toHaveURL(/#\/config\/yaml\?file=\.jgates\/tools\.yml&path=tools\.zz\.persona$/);

  // "Voltar ao herdado" removes the key, after the diff.
  const form2 = await openForm("instance=zz");
  const before = toolsText();
  await row(form2, "tools.zz.persona").getByRole("button", { name: /Voltar ao herdado/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("df-review")).toBeVisible();
  await expect(dialog.locator(".diff-line.del")).toContainText("persona: pedantic");
  expect(toolsText()).toBe(before);
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(toolsText()).toBe(before.replace("    persona: pedantic\n", ""));
  await expect(row(form2, "tools.zz.persona")).toHaveAttribute("data-state", "inherited");
  await expect(form2.getByTestId("df-undo")).toContainText("salvo em .jgates/tools.yml");

  // The file-size instance: its own setting with its control.
  const size = await openForm("instance=size");
  await expect(row(size, "tools.size.maxLines")).toHaveAttribute("data-widget", "number");
  await expect(row(size, "tools.size.adapter").locator("[data-readonly]")).toHaveText("file-size");
});

test("a save shows the diff first and writes only after confirmation; a switch saves at once and Desfazer restores the bytes", async () => {
  test.setTimeout(180_000);
  fs.writeFileSync(toolsFile(), TOOLS);
  const form = await openForm("instance=zz");
  const original = toolsText();

  // A change is an edit until it is reviewed: the file does not move.
  const severity = row(form, "tools.zz.minSeverity");
  await severity.getByRole("radio", { name: "high" }).check();
  await expect(severity).toHaveAttribute("data-pending", "true");
  expect(toolsText()).toBe(original);
  // Cancel keeps the file as it is.
  await severity.getByRole("button", { name: /Revisar e salvar/ }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.locator(".diff-line.add")).toContainText("minSeverity: high");
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(dialog).toHaveCount(0);
  expect(toolsText()).toBe(original);
  // Review, then save.
  await severity.getByRole("button", { name: /Revisar e salvar/ }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.locator(".diff-line.add")).toContainText("minSeverity: high");
  expect(toolsText()).toBe(original);
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => toolsText()).toContain("minSeverity: high");
  expect(toolsText()).toContain("# Tools written by hand.");
  expect(toolsText()).toContain("myOwnKey: hello   # a key the schema does not know");
  await expect(row(form, "tools.zz.minSeverity")).toHaveAttribute("data-state", "set");

  // A switch saves at once, shows the change and offers Desfazer, which writes back the exact previous bytes.
  const beforeSwitch = fs.readFileSync(toolsFile());
  await row(form, "tools.zz.offline").getByRole("switch").click();
  const undo = form.getByTestId("df-undo");
  await expect(undo).toHaveAttribute("data-state", "saved");
  await expect.poll(() => toolsText()).toMatch(/offline: (true|false)/);
  await undo.getByText("Ver a alteração").click();
  await expect(undo.locator(".diff-line.add")).toContainText("offline:");
  await undo.getByRole("button", { name: "Desfazer" }).click();
  await expect(undo).toHaveAttribute("data-state", "undone");
  expect(fs.readFileSync(toolsFile()).equals(beforeSwitch)).toBe(true);
  await expect(row(form, "tools.zz.offline")).toHaveAttribute("data-state", "inherited");
});

test("pickers list project files by pattern, folders, git refs and compose targets, each with Outro... for typing", async () => {
  test.setTimeout(180_000);
  fs.writeFileSync(toolsFile(), TOOLS);
  // The server route behind them.
  const zz = await openForm("instance=zz");
  const folders = await pageGet(page, "/api/pickers/project-folder");
  expect(folders.items.map((i: { value: string }) => i.value)).toEqual(expect.arrayContaining(["api", "src", "src/app", "docs"]));
  const refs = await pageGet(page, "/api/pickers/git-ref");
  expect(refs.notes).toEqual([]);

  // A folder picker (zizmor's base folder).
  const baseSelect = row(zz, "tools.zz.base").locator('[data-picker="project-folder"] select');
  await expect(baseSelect.locator("option", { hasText: /^src\/app$/ })).toHaveCount(1);
  await baseSelect.selectOption("src/app");
  await expect(row(zz, "tools.zz.base")).toHaveAttribute("data-pending", "true");

  // oasdiff: the spec is a file picker filtered by its pattern, the base ref a picker of branches, tags and commits.
  const api = await openForm("instance=api");
  const spec = row(api, "tools.api.spec").locator('[data-picker="project-file"] select');
  await expect(spec.locator("option", { hasText: "api/openapi.yaml" })).toHaveCount(1);
  await expect(spec.locator("option", { hasText: "README.md" })).toHaveCount(0);
  await expect(spec.locator("option", { hasText: "Outro..." })).toHaveCount(1);
  const ref = row(api, "tools.api.baseRef").locator('[data-picker="git-ref"] select');
  await expect(ref.locator('optgroup[label="Branches locais"] option')).toHaveText(["feature/x", "main"]);
  await expect(ref.locator('optgroup[label="Tags"] option')).toHaveText(["v1.0"]);
  await expect(ref.locator('optgroup[label="Commits recentes"] option').first()).toContainText("fixture commit");
  await expect(ref.locator("option", { hasText: "Outro..." })).toHaveCount(1);
  // Outro... opens a box for typing, with the kind of open value it takes.
  await ref.selectOption("__other__");
  const typed = row(api, "tools.api.baseRef").getByRole("textbox", { name: /Outro valor de/ });
  await expect(typed).toBeFocused();
  await expect(typed).toHaveAttribute("data-free-text", "identifier");
  await typed.fill("origin/main");
  await expect(row(api, "tools.api.baseRef")).toHaveAttribute("data-pending", "true");
  await row(api, "tools.api.baseRef").getByRole("button", { name: "Voltar à lista" }).click();

  // zap: the target lists the services and ports of the compose file, plus URL... and Outro....
  const dast = await openForm("instance=dast");
  const target = row(dast, "tools.dast.target").locator('[data-picker="service-target"] select');
  await expect(target.locator("option", { hasText: "web : 80" })).toHaveAttribute("value", "service:web:80");
  await expect(target.locator("option", { hasText: "db : 5432" })).toHaveAttribute("value", "service:db:5432");
  await expect(target.locator("option", { hasText: "URL..." })).toHaveCount(1);
  await expect(target.locator("option", { hasText: "Outro..." })).toHaveCount(1);
  await target.selectOption("__url__");
  const url = row(dast, "tools.dast.target").getByRole("textbox", { name: /URL de/ });
  await expect(url).toHaveAttribute("data-free-text", "url");
  await target.selectOption("service:web:80");
  await row(dast, "tools.dast.target").getByRole("button", { name: /Revisar e salvar/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".diff-line.add")).toContainText("target: service:web:80");
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect.poll(() => toolsText()).toContain("target: service:web:80");
});

test("keyboard only, 375 px without horizontal scroll, the free-text check, axe and English", async () => {
  test.setTimeout(240_000);
  fs.writeFileSync(toolsFile(), TOOLS);
  await page.setViewportSize({ width: 375, height: 800 });
  for (const instance of ["zz", "size", "api", "dast"]) {
    const form = await openForm(`instance=${instance}`);
    await expect(form.locator("[data-field]").first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${instance}: horizontal scroll at 375 px`).toBeLessThanOrEqual(0);
    expect(await expectNoKnownSetAsText(page, '[data-testid="derived-form"]', `derived form ${instance}`)).toBeGreaterThan(0);
    const axe = await new AxeBuilder({ page }).include('[data-testid="config-form"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }

  // Keyboard only: Tab to the severity radios, choose with the arrows, Tab to "Revisar e salvar", Enter, Tab to Salvar.
  const form = await openForm("instance=zz");
  const original = toolsText();
  const focusedIn = (selector: string) => page.evaluate((s) => document.activeElement !== null && document.activeElement.closest(s) !== null, selector);
  await page.locator("#cff-target").focus();
  let found = false;
  for (let i = 0; i < 120 && !found; i++) {
    await page.keyboard.press("Tab");
    found = await focusedIn('[data-field="tools.zz.minSeverity"] [role=radiogroup]');
  }
  expect(found, "the severity radios are reachable with Tab").toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect(row(form, "tools.zz.minSeverity")).toHaveAttribute("data-pending", "true");
  found = false;
  for (let i = 0; i < 10 && !found; i++) {
    await page.keyboard.press("Tab");
    found = await page.evaluate(() => (document.activeElement?.textContent ?? "").includes("Revisar e salvar"));
  }
  expect(found, "Revisar e salvar is reachable with Tab").toBe(true);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".diff-line.add")).toContainText("minSeverity:");
  // The dialog fits 375 px; its diff scrolls inside it.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // Escape closes without writing and gives the focus back; the review opens again with the keyboard.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(toolsText()).toBe(original);
  await expect(row(form, "tools.zz.minSeverity").getByRole("button", { name: /Revisar e salvar/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.locator(".diff-line.add")).toContainText("minSeverity:");
  found = false;
  for (let i = 0; i < 20 && !found; i++) {
    await page.keyboard.press("Tab");
    found = await page.evaluate(() => (document.activeElement?.textContent ?? "").trim() === "Salvar");
  }
  expect(found, "Salvar is reachable with Tab").toBe(true);
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => toolsText()).toContain("minSeverity:");

  // English: the same form reads in English.
  fs.writeFileSync(toolsFile(), TOOLS);
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), JSON.stringify({ schemaVersion: 1, theme: "system", language: "en" }));
  try {
    await page.goto(`${base}#/config/form?instance=zz`);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Guided form", level: 1 })).toBeVisible({ timeout: 30_000 });
    const en = page.getByTestId("derived-form");
    await expect(row(en, "tools.zz.persona").getByTestId("df-origin")).toContainText("Set in this file");
    await expect(row(en, "tools.zz.persona").getByRole("button", { name: /Back to inherited/ })).toBeVisible();
    await expect(row(en, "tools.zz.persona").getByRole("link", { name: /Edit in YAML/ })).toBeVisible();
    await expect(row(en, "tools.zz.myOwnKey")).toContainText("Custom field");
    await expect(row(en, "tools.zz.timeoutSeconds").locator("option", { hasText: "Other value..." })).toHaveCount(1);
    await expect(row(en, "tools.zz.base").locator("option", { hasText: "Other..." })).toHaveCount(1);
    expect(await expectNoKnownSetAsText(page, '[data-testid="derived-form"]', "derived form en")).toBeGreaterThan(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    fs.writeFileSync(path.join(fixture.home, "preferences.json"), JSON.stringify({ schemaVersion: 1, theme: "system", language: "pt-BR" }));
  }
});
