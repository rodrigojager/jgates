import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import { REPO, createFixture, pageGet, startServer, type Fixture } from "./support";

// The first-run wizard walked with the keyboard only (Tab to reach a control, Enter or the arrow keys to use it), on a
// fresh project with the fake container engine: in Portuguese at desktop width, and in English at 375 px, where no step
// may scroll sideways. A dialog closes with Esc and gives the focus back to the button that opened it. The walk ends
// with the first run started; afterwards the overview is the dashboard, and "Refazer a configuração guiada" opens the
// wizard again.

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
}

const PT: Texts = {
  steps: ["Docker", "Ferramentas", "Projeto", "Perfil", "Dependências", "Revisão"],
  title: (n) => `Passo ${n} de 6 · ${PT.steps[n - 1]}`,
  stepsNav: "Passos da configuração",
  next: "Continuar",
  download: "Baixar as ferramentas do JGates",
  preview: "Ver o arquivo antes de salvar",
  previewTitle: "O que vai ser gravado",
  minimal: "Mínimo",
  recommended: "Recomendado",
  save: "Salvar e continuar",
  prepare: "Preparar dependências",
  run: "Executar a primeira validação",
  redo: "Refazer a configuração guiada",
  close: "Fechar o assistente",
};

const EN: Texts = {
  steps: ["Docker", "Tools", "Project", "Profile", "Dependencies", "Review"],
  title: (n) => `Step ${n} of 6 · ${EN.steps[n - 1]}`,
  stepsNav: "Setup steps",
  next: "Continue",
  download: "Download the JGates tools",
  preview: "See the file before saving",
  previewTitle: "What will be written",
  minimal: "Minimal",
  recommended: "Recommended",
  save: "Save and continue",
  prepare: "Prepare dependencies",
  run: "Run the first validation",
  redo: "Redo the guided setup",
  close: "Close the wizard",
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
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`the keyboard never reached ${await target.evaluate((el) => el.outerHTML.slice(0, 200))}`);
}

async function press(page: Page, target: Locator, key = "Enter"): Promise<void> {
  await expect(target).toBeEnabled();
  await tabTo(page, target);
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

  // 1 Docker: the fake engine is running.
  await atStep(1);
  await expect(wizard.getByTestId("wizard-engine")).toHaveAttribute("data-engine", "ready");
  await expect(wizard.getByTestId("wizard-command")).toBeVisible();
  await press(page, nav.getByRole("button", { name: text.next }));

  // 2 Ferramentas: the download starts; the title of the new step has the focus.
  await atStep(2);
  await expect(heading).toBeFocused();
  await press(page, wizard.getByRole("button", { name: text.download }));
  await expect(wizard.getByTestId("wizard-download")).toHaveAttribute("data-state", "ready");
  if (narrow) await noSidewaysScroll(page, "download finished");
  await press(page, nav.getByRole("button", { name: text.next }));

  // 3 Projeto: the Python component discovery found, with its selects.
  await atStep(3);
  const component = wizard.locator("li[data-component]").first();
  await expect(component.getByRole("combobox").first()).toHaveValue("python");
  await press(page, nav.getByRole("button", { name: text.next }));

  // 4 Perfil: radio cards with what each runs; the tools are there, so Rigoroso is the recommended (and preselected) one.
  await atStep(4);
  const strict = wizard.locator('[data-profile="strict"]');
  await expect(strict).toContainText(text.recommended);
  await expect(strict.getByRole("radio")).toBeChecked();
  // The arrow keys move the choice inside the group: two up from Rigoroso is Mínimo.
  await tabTo(page, strict.getByRole("radio"));
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(wizard.getByRole("radio", { name: new RegExp(`^${text.minimal}`) })).toBeChecked();
  // The file before it is written: a dialog that Esc closes, giving the focus back to its button.
  const previewButton = wizard.getByRole("button", { name: text.preview });
  await press(page, previewButton);
  const dialog = page.getByRole("dialog", { name: text.previewTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("wizard-config-preview")).toContainText("profile: minimal");
  if (narrow) await noSidewaysScroll(page, "preview dialog");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(previewButton).toBeFocused();
  expect(fs.existsSync(path.join(fixture.dir, "jgates.yml")), "the preview wrote nothing").toBe(false);
  await press(page, nav.getByRole("button", { name: text.save }));

  // 5 Dependências: jgates.yml is written; the dependencies are prepared now (the tools are there).
  await atStep(5);
  expect(fs.readFileSync(path.join(fixture.dir, "jgates.yml"), "utf8")).toMatch(/profile: minimal/);
  const prepare = wizard.getByRole("button", { name: text.prepare });
  if (await prepare.count()) {
    await press(page, prepare);
    await expect(wizard.getByTestId("wizard-deps-status")).toHaveAttribute("data-state", "done");
  }
  if (narrow) await noSidewaysScroll(page, "dependencies");
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
  // "Refazer a configuração guiada" (Workspace) opens it again at step 1, and "Fechar o assistente" leaves it.
  await page.goto(`${base}#/workspace`);
  await press(page, page.getByRole("link", { name: text.redo }));
  await expect(wizard.getByRole("heading", { level: 1 })).toHaveText(text.title(1));
  await expect(wizard.getByRole("navigation", { name: text.stepsNav }).locator('[data-step="review"]')).toBeEnabled();
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
