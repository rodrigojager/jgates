import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import { REPO, createFixture, pageGet, startServer, type Fixture } from "./support";

// The first-run wizard walked with the keyboard only (Tab to reach a control, Enter or the arrow keys to use it), on a
// fresh project with the fake container engine: in Portuguese at desktop width, and in English at 375 px, where no step
// may scroll sideways. A dialog closes with Esc and gives the focus back to the button that opened it. The walk ends
// with the first run started; afterwards the overview is the dashboard, and "Refazer a configuração guiada" opens the
// wizard again only when asked, at a chosen step, without taking over the overview (D13). Step 1 has the doctor mascot
// (checking, needs you, ok, error) and the runtime list with "Testar"; locked steps say what unlocks them; step 2 never
// keeps a promise that no longer holds (D29); step 3 has no bare "." and declares a component in a dialog of its own;
// step 4 embeds the profile editor (ADR-0008): switches, the quality mascot strip following them and "Criar perfil a
// partir deste", all on a draft until "Salvar e continuar" (D10); step 5 says per unit what is installed, where it goes
// and the network it uses, and takes its state from the job's result (D27).

const FAKE = path.join(REPO, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version as string;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ab".repeat(32)}`;

interface Texts {
  steps: string[];
  title: (n: number) => string;
  stepsNav: string;
  next: string;
  download: string;
  preview: string;
  previewTitle: string;
  minimal: string;
  recommended: string;
  save: string;
  prepare: string;
  run: string;
  redo: string;
  close: string;
  locked: string;
  lockedNote: string;
  custom: string;
  runtimePath: string;
  test: string;
  stale: RegExp;
  declare: string;
  declareTitle: string;
  reopenOpen: string;
  reopenStep: string;
  planSteps: string;
  categories: string[];
  openQuality: string;
  createFrom: string;
  createTitle: string;
  profileName: string;
  create: string;
  installs: string;
  volume: string;
  network: string;
  installed: string;
}

/** The categories in the mascot strip's order, then the project's own checks. */
const CATEGORY_ORDER = ["quality", "security", "dependencies", "tests", "architecture", "infrastructure", "custom"];

const PT: Texts = {
  steps: ["Docker", "Ferramentas", "Projeto", "Perfil", "Dependências", "Revisão"],
  title: (n) => `Passo ${n} de 6 · ${PT.steps[n - 1]}`,
  stepsNav: "Passos da configuração",
  next: "Continuar",
  download: "Baixar as ferramentas do JGates",
  preview: "Ver o arquivo antes de salvar",
  previewTitle: "O que vai ser gravado",
  minimal: "Essencial",
  recommended: "Recomendado",
  save: "Salvar e continuar",
  prepare: "Preparar dependências",
  run: "Executar a primeira validação",
  redo: "Refazer a configuração guiada",
  close: "Fechar o assistente",
  locked: "Abre quando o passo Docker estiver concluído.",
  lockedNote: "Os próximos passos abrem quando você concluir o passo Docker.",
  custom: "Outro executável…",
  runtimePath: "Caminho do executável",
  test: "Testar",
  stale: /vão ser baixados|vai ser baixado/i,
  declare: "Declarar componente",
  declareTitle: "Declarar componente",
  reopenOpen: "Abrir o assistente",
  reopenStep: "Começar no passo",
  planSteps: "verificações",
  categories: ["Qualidade", "Segurança", "Dependências", "Testes", "Arquitetura", "Infraestrutura", "Verificações próprias"],
  openQuality: "Abrir a categoria Qualidade",
  createFrom: "Criar perfil a partir de Essencial",
  createTitle: "Criar perfil",
  profileName: "Nome do perfil",
  create: "Criar",
  installs: "Os pacotes declarados em",
  volume: "No volume",
  network: "Só durante a instalação",
  installed: "Dependências instaladas",
};

const EN: Texts = {
  steps: ["Docker", "Tools", "Project", "Profile", "Dependencies", "Review"],
  title: (n) => `Step ${n} of 6 · ${EN.steps[n - 1]}`,
  stepsNav: "Setup steps",
  next: "Continue",
  download: "Download the JGates tools",
  preview: "See the file before saving",
  previewTitle: "What will be written",
  minimal: "Essential",
  recommended: "Recommended",
  save: "Save and continue",
  prepare: "Prepare dependencies",
  run: "Run the first validation",
  redo: "Redo the guided setup",
  close: "Close the wizard",
  locked: "Opens once the Docker step is done.",
  lockedNote: "The next steps open once you finish the Docker step.",
  custom: "Another executable…",
  runtimePath: "Path of the executable",
  test: "Test",
  stale: /will be downloaded/i,
  declare: "Declare a component",
  declareTitle: "Declare a component",
  reopenOpen: "Open the wizard",
  reopenStep: "Start at step",
  planSteps: "checks",
  categories: ["Quality", "Security", "Dependencies", "Tests", "Architecture", "Infrastructure", "Your own checks"],
  openQuality: "Open the category Quality",
  createFrom: "Create a profile from Essential",
  createTitle: "Create profile",
  profileName: "Profile name",
  create: "Create",
  installs: "The packages declared in",
  volume: "In the volume",
  network: "Only while installing",
  installed: "Dependencies installed",
};

/** A project without jgates.yml, served with the fake engine (not in-image): the image exists once it was pulled. */
function wizardFixture(language: "pt-BR" | "en"): Fixture {
  const fixture = createFixture();
  fs.rmSync(path.join(fixture.dir, "jgates.yml"));
  fs.rmSync(path.join(fixture.dir, ".jgates"), { recursive: true, force: true });
  const engine = fs.mkdtempSync(path.join(fixture.home, "engine-"));
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    [
      `const fs = require("node:fs");`,
      `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};`,
      `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`,
      `const present = fs.existsSync(${JSON.stringify(path.join(engine, "pull-attempts"))});`,
      `process.env.FAKE_DOCKER_LABELS = present ? ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))} : "none";`,
      `require(${JSON.stringify(FAKE)});`,
      ``,
    ].join("\n"),
  );
  fixture.env.JGATES_IMAGE_JSON = "";
  fixture.env.JGATES_CONTAINER_RUNTIME = runtime;
  fixture.env.JGATES_TOOLS_IMAGE = PINNED;
  fixture.env.JGATES_NO_CACHE = "1";
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language }, null, 2)}\n`, { mode: 0o600 });
  return fixture;
}

/** Presses Tab until the control has the focus (the keyboard path reaches it), never clicking. */
async function tabTo(page: Page, target: Locator, max = 80): Promise<void> {
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`the keyboard never reached ${await target.evaluate((el) => el.outerHTML.slice(0, 200))}`);
}

async function press(page: Page, target: Locator, key = "Enter", max = 80): Promise<void> {
  await expect(target).toBeEnabled();
  await tabTo(page, target, max);
  await page.keyboard.press(key);
}

async function noSidewaysScroll(page: Page, where: string): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(0);
}

async function walk(page: Page, fixture: Fixture, text: Texts, narrow: boolean): Promise<void> {
  const wizard = page.locator('[data-state="wizard"]');
  const heading = wizard.getByRole("heading", { level: 1 });
  const nav = wizard.getByTestId("wizard-nav");
  const atStep = async (n: number) => {
    await expect(heading).toHaveText(text.title(n));
    await expect(wizard.getByRole("navigation", { name: text.stepsNav }).locator(`[data-step="${["docker", "tools", "project", "profile", "dependencies", "review"][n - 1]}"]`)).toHaveAttribute("aria-current", "step");
    if (narrow) await noSidewaysScroll(page, text.title(n));
  };

  // 1 Docker: the fake engine is running; the doctor says so (or needs you for a low value) beside the requirements.
  await atStep(1);
  await expect(wizard.getByTestId("wizard-engine")).toHaveAttribute("data-engine", "ready");
  const requirements = wizard.getByTestId("wizard-requirements");
  await expect(requirements.locator("[data-requirement]")).toHaveCount(4);
  await expect(requirements.locator('[data-requirement="memory"] [data-testid="wizard-requirement-value"]')).not.toHaveText("");
  const warned = await requirements.locator('[data-state="warn"]').count();
  await expect(wizard.getByTestId("wizard-doctor")).toHaveAttribute("data-state", warned > 0 ? "needs-you" : "ok");
  await expect(wizard.locator('[data-mascot="doctor"]')).toHaveAttribute("data-state", warned > 0 ? "needs-you" : "ok");
  // The steps that cannot open yet say what unlocks them.
  await expect(wizard.getByRole("navigation", { name: text.stepsNav }).locator('[data-step="tools"]')).toHaveAttribute("title", text.locked);
  await expect(wizard.getByTestId("wizard-locked-note")).toHaveText(text.lockedNote);
  await expect(wizard.getByTestId("wizard-command")).toBeVisible();
  if (narrow) await noSidewaysScroll(page, "requirements and runtime");
  await press(page, nav.getByRole("button", { name: text.next }));

  // 2 Ferramentas: the download starts; the title of the new step has the focus.
  await atStep(2);
  await expect(heading).toBeFocused();
  // What will be on the machine: the image with its tools, the security databases, the totals.
  await expect(wizard.getByTestId("wizard-image")).toContainText("jgates-tools");
  await expect(wizard.getByTestId("wizard-data").locator("[data-database]")).toHaveCount(4);
  await expect(wizard.getByTestId("wizard-totals")).not.toHaveText("");
  // No download runs yet: the button is "Continuar" (D29).
  await expect(nav.getByRole("button", { name: text.next, exact: true })).toBeVisible();
  const list = wizard.getByTestId("wizard-tools-list");
  await press(page, list.locator("summary"));
  await expect(list.locator("tr[data-tool]").first()).toBeVisible();
  if (narrow) await noSidewaysScroll(page, "tools list");
  await press(page, list.locator("summary"));
  await press(page, wizard.getByRole("button", { name: text.download }));
  await expect(wizard.getByTestId("wizard-download")).toHaveAttribute("data-state", "ready");
  // Once ready nothing says the data "will be downloaded" any more, and the button is "Continuar" again.
  await expect(wizard.getByTestId("wizard-step-tools")).not.toContainText(text.stale);
  await expect(nav.getByRole("button", { name: text.next, exact: true })).toBeVisible();
  if (narrow) await noSidewaysScroll(page, "download finished");
  await press(page, nav.getByRole("button", { name: text.next }));

  // 3 Projeto: the Python component discovery found, with its selects.
  await atStep(3);
  const component = wizard.locator("li[data-component]").first();
  await expect(component.getByRole("combobox").first()).toHaveValue("python");
  await expect(component.getByTestId("wizard-component-sentence")).not.toHaveText(".");
  const bare = await wizard.getByTestId("wizard-step-project").evaluate((el) => [...el.querySelectorAll("*")].filter((n) => n.children.length === 0 && n.textContent?.trim() === ".").length);
  expect(bare, "no bare . on step 3").toBe(0);
  // Declaring a component opens a dialog inside the wizard, with the folder picker; Esc gives the focus back.
  const declare = wizard.getByRole("button", { name: text.declare });
  await press(page, declare);
  const declareDialog = page.getByRole("dialog", { name: text.declareTitle });
  await expect(declareDialog).toBeVisible();
  await expect(declareDialog.locator('[data-picker="project-folder"] select')).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash, { message: "the dialog opens inside the wizard" }).toBe("#/overview");
  if (narrow) await noSidewaysScroll(page, "declare dialog");
  await page.keyboard.press("Escape");
  await expect(declareDialog).toHaveCount(0);
  await expect(declare).toBeFocused();
  await press(page, nav.getByRole("button", { name: text.next }));

  // 4 Perfil: the profile editor inside the wizard (ADR-0008). Radio cards with what each runs; the tools are there, so
  // Rigoroso is the recommended (and preselected) one.
  await atStep(4);
  const profileStep = wizard.getByTestId("wizard-step-profile");
  const strict = wizard.locator('[data-profile="strict"]');
  await expect(strict).toContainText(text.recommended);
  await expect(strict.getByRole("radio")).toBeChecked();
  // The arrow keys move the choice inside the group: two up from Rigoroso is Essencial.
  await tabTo(page, strict.getByRole("radio"));
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  const minimal = wizard.locator('[data-profile="minimal"]');
  await expect(wizard.getByRole("radio", { name: new RegExp(`^${text.minimal}`) })).toBeChecked();
  await expect(minimal.getByTestId("wizard-profile-runs")).toContainText(text.planSteps);
  // The category list of the chosen profile, the same component as Configuração > Perfil: one fixed order, the names of
  // the mascot strip; the quality mascot strip of the selected profile beside it.
  const editor = wizard.getByTestId("wizard-profile-editor");
  await expect(editor).toHaveAttribute("data-editing", "minimal");
  const categories = editor.getByTestId("categories").locator("section.category[data-category]");
  await expect(categories).toHaveCount(CATEGORY_ORDER.length);
  expect(await categories.evaluateAll((els) => els.map((e) => e.getAttribute("data-category")))).toEqual(CATEGORY_ORDER);
  expect(await categories.locator("h3").allTextContents()).toEqual(text.categories);
  const strip = wizard.getByTestId("wizard-profile-mascots").getByTestId("quality-mascots");
  await expect(strip.locator("[data-domain]")).toHaveCount(6);
  const security = strip.locator('[data-domain="security"]');
  await expect(security).not.toHaveAttribute("data-selection", "disabled");
  const totalBefore = Number(await minimal.getAttribute("data-total"));
  // A switch: Segurança off, with the keyboard. The draft changes, the count and the mascot follow; the project does not.
  const securitySwitch = editor.getByTestId("category-security");
  await expect(securitySwitch).toHaveAttribute("aria-checked", "true");
  await tabTo(page, securitySwitch);
  await page.keyboard.press("Space");
  await expect(securitySwitch).toHaveAttribute("aria-checked", "false");
  await expect(security).toHaveAttribute("data-selection", "disabled");
  await expect.poll(async () => Number(await minimal.getAttribute("data-total"))).toBeLessThan(totalBefore);
  expect(fs.existsSync(path.join(fixture.dir, "jgates.yml")), "a switch writes nothing to the project").toBe(false);
  // A category opens into its capabilities; nothing in the step leads out of the wizard.
  const qualityOpen = editor.locator('section.category[data-category="quality"]').getByRole("button", { name: text.openQuality });
  await press(page, qualityOpen, "Enter", 150);
  await expect(editor.locator('section.category[data-category="quality"] li.capability').first()).toBeVisible();
  await expect(profileStep.locator('a[href^="#"]')).toHaveCount(0);
  if (narrow) await noSidewaysScroll(page, "profile editor");
  // "Criar perfil a partir deste" on Essencial: a dialog of the wizard, the name first and the identifier from it.
  const createFrom = minimal.getByRole("button", { name: text.createFrom });
  await press(page, createFrom, "Enter", 150);
  const createDialog = page.getByRole("dialog", { name: text.createTitle });
  await expect(createDialog).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash, { message: "the dialog opens inside the wizard" }).toBe("#/overview");
  if (narrow) await noSidewaysScroll(page, "create dialog");
  await tabTo(page, createDialog.getByRole("textbox", { name: text.profileName }));
  await page.keyboard.type("Rapido");
  await press(page, createDialog.getByRole("button", { name: text.create, exact: true }));
  await expect(createDialog).toHaveCount(0);
  const rapido = wizard.locator('[data-profile="rapido"]');
  await expect(rapido.getByRole("radio")).toBeChecked();
  await expect(editor).toHaveAttribute("data-editing", "rapido");
  // It inherits Essencial as the draft holds it (Segurança off) and is customized here: Qualidade off too.
  await expect(editor.getByTestId("category-security")).toHaveAttribute("aria-checked", "false");
  const rapidoQuality = editor.getByTestId("category-quality");
  await press(page, rapidoQuality, "Space", 150);
  await expect(rapidoQuality).toHaveAttribute("aria-checked", "false");
  await expect(strip.locator('[data-domain="quality"]')).toHaveAttribute("data-selection", "disabled");
  expect(fs.existsSync(path.join(fixture.dir, "jgates.yml")), "creating a profile writes nothing to the project").toBe(false);
  // The files before they are written: a dialog that Esc closes, giving the focus back to its button.
  const previewButton = wizard.getByRole("button", { name: text.preview });
  await press(page, previewButton, "Enter", 150);
  const dialog = page.getByRole("dialog", { name: text.previewTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("wizard-config-preview")).toContainText("profile: rapido");
  if (narrow) await noSidewaysScroll(page, "preview dialog");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(previewButton).toBeFocused();
  expect(fs.existsSync(path.join(fixture.dir, "jgates.yml")), "the preview wrote nothing").toBe(false);
  await press(page, nav.getByRole("button", { name: text.save }), "Enter", 150);

  // 5 Dependências: jgates.yml and the profiles are written from the draft; each unit says what it installs, where it
  // goes and the network it uses; after the job its state is the job's result and no stale button is left (D27).
  await atStep(5);
  expect(fs.readFileSync(path.join(fixture.dir, "jgates.yml"), "utf8")).toMatch(/profile: rapido/);
  expect(fs.readFileSync(path.join(fixture.dir, ".jgates", "profiles.yml"), "utf8")).toMatch(/rapido:/);
  const unit = wizard.locator("li[data-unit]").first();
  await expect(unit.locator('[data-fact="manager"]')).not.toHaveText("");
  await expect(unit.locator('[data-fact="lockfile"]')).not.toHaveText("");
  await expect(unit.locator('[data-fact="installs"]')).toContainText(text.installs);
  await expect(unit.locator('[data-fact="volume"]')).toContainText(text.volume);
  await expect(unit.locator('[data-fact="volume"]')).toContainText("-deps-");
  await expect(unit.locator('[data-fact="network"]')).toContainText(text.network);
  if (narrow) await noSidewaysScroll(page, "dependencies");
  const prepare = wizard.getByRole("button", { name: text.prepare });
  await press(page, prepare);
  await expect(wizard.getByTestId("wizard-deps-status")).toHaveAttribute("data-state", "done");
  await expect(unit).toHaveAttribute("data-state", "ready");
  // The job's own words are in the language of the screen.
  await expect(unit.locator("details summary")).toHaveText(text.installed);
  await expect(wizard.getByTestId("wizard-deps-ready")).toBeVisible();
  await expect(wizard.getByRole("button", { name: text.prepare })).toHaveCount(0);
  if (narrow) await noSidewaysScroll(page, "dependencies ready");
  await press(page, nav.getByRole("button", { name: text.next }));

  // 6 Revisão: the plan of the first validation; its button starts the run and opens the run screen.
  await atStep(6);
  await expect(wizard.getByTestId("wizard-plan")).toHaveAttribute("data-approvable", "true");
  if (narrow) await noSidewaysScroll(page, "review");
  await press(page, nav.getByRole("button", { name: text.run }));
  await expect.poll(() => new URL(page.url()).hash).toMatch(/^#\/runs\/job_[0-9a-f]{16}$/);
  const runId = new URL(page.url()).hash.slice("#/runs/".length);
  // Let the run end before the fixture goes away.
  await expect.poll(async () => (await pageGet(page, `/api/runs/${runId}`)).run?.state, { timeout: 120_000 }).not.toBe("running");
}

async function afterSetup(page: Page, text: Texts): Promise<void> {
  const wizard = page.locator('[data-state="wizard"]');
  // The overview is the dashboard now.
  const base = page.url().split("#")[0];
  await page.goto(`${base}#/overview`);
  await expect(page.locator("main h1").first()).toBeVisible();
  await expect(wizard).toHaveCount(0);
  // "Refazer a configuração guiada" (Workspace) opens a screen that changes nothing by itself (D13): the person picks the
  // step to start at and opens the wizard.
  await page.goto(`${base}#/workspace`);
  await press(page, page.getByRole("link", { name: text.redo }));
  const reopen = page.locator('[data-state="wizard-reopen"]');
  await expect(reopen).toBeVisible();
  await expect(wizard).toHaveCount(0);
  const chooser = reopen.getByRole("combobox", { name: text.reopenStep });
  await tabTo(page, chooser);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(chooser).toHaveValue("project");
  await press(page, reopen.getByRole("button", { name: text.reopenOpen }));
  await expect(wizard.getByRole("heading", { level: 1 })).toHaveText(text.title(3));
  await expect(wizard.getByRole("navigation", { name: text.stepsNav }).locator('[data-step="review"]')).toBeEnabled();
  // The reopened wizard does not replace the overview.
  await page.goto(`${base}#/overview`);
  await expect(page.locator("main h1").first()).toBeVisible();
  await expect(wizard).toHaveCount(0);
  // Back on #/setup it is where it was; "Fechar o assistente" leaves it.
  await page.goto(`${base}#/setup`);
  await expect(wizard.getByRole("heading", { level: 1 })).toHaveText(text.title(3));
  await press(page, wizard.getByRole("button", { name: text.close }));
  await expect.poll(() => new URL(page.url()).hash).toBe("#/overview");
  await expect(wizard).toHaveCount(0);
}

test("the first-run wizard walked with the keyboard only, in Portuguese, starts the first run", async ({ page }) => {
  const fixture = wizardFixture("pt-BR");
  const server = await startServer(fixture);
  try {
    await page.goto(server.bootstrapUrl);
    await expect.poll(() => new URL(page.url()).hash).toBe("#/overview");
    await expect(page.locator('[data-state="wizard"]')).toBeVisible();
    const axe = await new AxeBuilder({ page }).include('[data-state="wizard"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    await walk(page, fixture, PT, false);
    await afterSetup(page, PT);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("the first-run wizard in English at 375 px: keyboard only and no step scrolls sideways", async ({ page }) => {
  const fixture = wizardFixture("en");
  await page.setViewportSize({ width: 375, height: 800 });
  const server = await startServer(fixture);
  try {
    await page.goto(server.bootstrapUrl);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator('[data-state="wizard"]')).toBeVisible();
    await walk(page, fixture, EN, true);
    await afterSetup(page, EN);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("the wizard resumes at the same step after a reload of the page", async ({ page }) => {
  const fixture = wizardFixture("pt-BR");
  const server = await startServer(fixture);
  try {
    await page.goto(server.bootstrapUrl);
    const wizard = page.locator('[data-state="wizard"]');
    await expect(wizard.getByRole("heading", { level: 1 })).toHaveText(PT.title(1));
    await expect(wizard.getByTestId("wizard-engine")).toHaveAttribute("data-engine", "ready");
    await press(page, wizard.getByTestId("wizard-nav").getByRole("button", { name: PT.next }));
    await expect(wizard.getByRole("heading", { level: 1 })).toHaveText(PT.title(2));
    await page.reload();
    await expect(wizard.getByRole("heading", { level: 1 })).toHaveText(PT.title(2));
    // "Voltar" goes back to a finished step; the steps after the current one cannot be opened yet.
    await expect(wizard.getByRole("navigation", { name: PT.stepsNav }).locator('[data-step="project"]')).toBeDisabled();
    await press(page, wizard.getByTestId("wizard-nav").getByRole("button", { name: "Voltar" }));
    await expect(wizard.getByRole("heading", { level: 1 })).toHaveText(PT.title(1));
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("step 1: the doctor follows the machine check (checking, needs you, ok, error) and Testar asks another executable", async ({ page }) => {
  const fixture = wizardFixture("pt-BR");
  const server = await startServer(fixture);
  // The machine check, held and then rewritten: the doctor's state comes from the answer.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let mode: "real" | "low" | "unsupported" = "real";
  await page.route(/\/api\/setup\/docker\?/, async (route) => {
    await held;
    let response;
    try {
      response = await route.fetch();
    } catch {
      // The server stopped at the end of the test while a check was on its way.
      await route.abort().catch(() => undefined);
      return;
    }
    const json = await response.json();
    if (mode === "low") {
      json.requirements = json.requirements.map((r: { id: string; state: string }) => (r.id === "memory" ? { ...r, state: "warn", value: 2048 } : r));
    }
    if (mode === "unsupported") {
      json.ready = false;
      json.state = "unsupported";
    }
    await route.fulfill({ response, json });
  });
  try {
    await page.goto(server.bootstrapUrl);
    const wizard = page.locator('[data-state="wizard"]');
    const doctor = wizard.getByTestId("wizard-doctor");
    await expect(doctor).toHaveAttribute("data-state", "checking");
    await expect(wizard.locator('[data-mascot="doctor"]')).toHaveAttribute("data-state", "checking");
    mode = "low";
    release();
    await expect(doctor).toHaveAttribute("data-state", "needs-you");
    await expect(wizard.getByTestId("wizard-requirements").locator('[data-requirement="memory"]')).toHaveAttribute("data-state", "warn");
    // A low value is a warning: "Continuar" stays enabled.
    await expect(wizard.getByTestId("wizard-nav").getByRole("button", { name: PT.next })).toBeEnabled();
    mode = "unsupported";
    await press(page, wizard.getByRole("button", { name: "Verificar de novo" }));
    await expect(doctor).toHaveAttribute("data-state", "error");
    mode = "real";
    await press(page, wizard.getByRole("button", { name: "Verificar de novo" }));
    await expect(doctor).toHaveAttribute("data-state", /^(ok|needs-you)$/);

    // Another executable: its path, then "Testar" (nothing saved yet).
    const runtime = wizard.getByTestId("wizard-runtime");
    const custom = runtime.getByRole("radio", { name: PT.custom });
    await tabTo(page, runtime.getByRole("radio").first());
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(custom).toBeChecked();
    const pathBox = runtime.getByRole("textbox", { name: PT.runtimePath });
    await tabTo(page, pathBox);
    await page.keyboard.type(fixture.env.JGATES_CONTAINER_RUNTIME as string);
    await press(page, runtime.getByRole("button", { name: PT.test }));
    await expect(runtime.getByTestId("wizard-runtime-test")).toHaveAttribute("data-ok", "true");
    await expect(runtime.getByTestId("wizard-runtime-test")).toContainText("27.0.1-fake");
    expect(JSON.parse(fs.readFileSync(path.join(fixture.home, "preferences.json"), "utf8")).containerRuntime, "Testar saves nothing").toBeUndefined();
    await press(page, runtime.getByRole("button", { name: "Usar este executável" }));
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(fixture.home, "preferences.json"), "utf8")).containerRuntime).toBe(fixture.env.JGATES_CONTAINER_RUNTIME);
    // The variable of the fixture wins over the choice, and the screen says so.
    await expect(runtime).toContainText("JGATES_CONTAINER_RUNTIME");
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await server.stop();
    fixture.cleanup();
  }
});
