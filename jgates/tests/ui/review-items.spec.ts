import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import { REPO, createFixture, createGateFixture, openApp, simulateHostDisk, startGateServer, startServer, type Fixture } from "./support";

// The gate and the target are chosen, not typed, and what will not run is a list of items with buttons (V2-71):
//   - the wizard's review (step 6) starts with the gate (Quality, Semantic, both: Semantic disabled with its reason and
//     action while no provider is configured) and the target as radios; the plan below is grouped by category, each row
//     named by what is checked; what will not run is a list with the tool in bold, the reason, a suggestion and buttons
//     that work (a check that cannot apply has none); a Preparação block has one button per pending item, and the step
//     says exactly what it waits for; its network line agrees with the preparation steps; nothing says "Máquina local";
//   - Escolher uses the same controls: branch changes name their base, branch, tag and commit selects instead of typed
//     references, a folder picker for the folder, "Usar como padrão do projeto" saves the choice in jgates.yml.
// Keyboard only, at desktop width in Portuguese and at 375 px in English.

const FAKE = path.join(REPO, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version as string;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ab".repeat(32)}`;

interface Texts {
  language: "pt-BR" | "en";
  next: string;
  skip: string;
  save: string;
  title: (n: number) => string;
  quality: RegExp;
  semantic: RegExp;
  both: RegExp;
  semanticOff: string;
  semanticAction: string;
  fullWorkspace: RegExp;
  download: string;
  data: string;
  dependencies: string;
  waiting: string;
  network: string;
  saveDefault: string;
  saved: string;
  preparation: string;
  noTool: string;
}

const PT: Texts = {
  language: "pt-BR",
  next: "Continuar",
  skip: "Pular por agora",
  save: "Salvar e continuar",
  title: (n) => `Passo ${n} de 6 · ${["Docker", "Ferramentas", "Projeto", "Perfil", "Dependências", "Revisão"][n - 1]}`,
  quality: /^Quality ·/,
  semantic: /^Semantic ·/,
  both: /^Quality e depois Semantic/,
  semanticOff: "ainda não está configurado",
  semanticAction: "Configurar o Semantic",
  fullWorkspace: /^Workspace completo/,
  download: "Baixar as ferramentas do JGates",
  data: "Atualizar os dados de segurança",
  dependencies: "Preparar as dependências",
  waiting: "a instalação das dependências do projeto",
  network: "A preparação usa a rede para:",
  saveDefault: "Usar como padrão do projeto",
  saved: "Padrão salvo em jgates.yml",
  preparation: "Preparação",
  noTool: "sem ferramenta",
};

const EN: Texts = {
  language: "en",
  next: "Continue",
  skip: "Skip for now",
  save: "Save and continue",
  title: (n) => `Step ${n} of 6 · ${["Docker", "Tools", "Project", "Profile", "Dependencies", "Review"][n - 1]}`,
  quality: /^Quality ·/,
  semantic: /^Semantic ·/,
  both: /^Quality, then Semantic/,
  semanticOff: "not set up yet",
  semanticAction: "Set up Semantic",
  fullWorkspace: /^Full workspace/,
  download: "Download the JGates tools",
  data: "Update the security data",
  dependencies: "Prepare the dependencies",
  waiting: "the installation of the project's dependencies",
  network: "The preparation uses the network for:",
  saveDefault: "Use as the project default",
  saved: "Default saved in jgates.yml",
  preparation: "Preparation",
  noTool: "no tool",
};

/** A project served with the fake container engine; the tools image is "downloaded" by the first pull. */
function containerFixture(language: "pt-BR" | "en", wizard: boolean): Fixture {
  const fixture = createFixture();
  if (wizard) {
    fs.rmSync(path.join(fixture.dir, "jgates.yml"));
    fs.rmSync(path.join(fixture.dir, ".jgates"), { recursive: true, force: true });
  }
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
  simulateHostDisk(fixture);
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language }, null, 2)}\n`, { mode: 0o600 });
  return fixture;
}

async function tabTo(page: Page, target: Locator, max = 250): Promise<void> {
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`the keyboard never reached ${await target.evaluate((el) => el.outerHTML.slice(0, 200))}`);
}

async function press(page: Page, target: Locator, key = "Enter", max = 250): Promise<void> {
  await tabTo(page, target, max);
  await page.keyboard.press(key);
}

async function noSidewaysScroll(page: Page, where: string): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(0);
}

/** The wizard up to its review: Docker, tools (not downloaded), project, profile saved, dependencies skipped. */
async function toReview(page: Page, text: Texts): Promise<Locator> {
  const wizard = page.locator('[data-state="wizard"]');
  const nav = wizard.getByTestId("wizard-nav");
  const heading = wizard.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(text.title(1));
  await expect(wizard.getByTestId("wizard-engine")).toHaveAttribute("data-engine", "ready");
  for (const n of [2, 3, 4]) {
    await press(page, nav.getByRole("button", { name: text.next }));
    await expect(heading).toHaveText(text.title(n));
  }
  // The strict profile asks for more than this project can do today: the list of what will not run has every kind.
  await wizard.locator('[data-profile="strict"]').getByRole("radio").check();
  await press(page, nav.getByRole("button", { name: text.save }), "Enter", 400);
  await expect(heading).toHaveText(text.title(5));
  await press(page, nav.getByRole("button", { name: text.skip }));
  await expect(heading).toHaveText(text.title(6));
  return wizard;
}

async function reviewChecks(page: Page, fixture: Fixture, text: Texts, narrow: boolean): Promise<void> {
  const wizard = await toReview(page, text);
  const nav = wizard.getByTestId("wizard-nav");
  const step = wizard.getByTestId("wizard-step-review");

  // The review starts with the gate: Quality is chosen; Semantic and both are disabled, with the reason and the action.
  const firstSection = step.locator("section").first();
  await expect(firstSection).toHaveAttribute("data-testid", "gate-choice");
  const gates = step.getByTestId("gate-choice");
  await expect(gates.getByRole("radio", { name: text.quality })).toBeChecked();
  await expect(gates.getByRole("radio", { name: text.semantic })).toBeDisabled();
  await expect(gates.getByRole("radio", { name: text.both })).toBeDisabled();
  await expect(gates.getByTestId("semantic-off")).toContainText(text.semanticOff);
  await expect(gates.getByRole("link", { name: text.semanticAction })).toHaveAttribute("href", "#/semantic/setup?step=provider");

  // Then the target: the whole workspace is chosen; what needs Git is disabled in a folder that is not a repository.
  const targets = step.getByTestId("target-choice");
  await expect(targets.getByRole("radio", { name: text.fullWorkspace })).toBeChecked();
  await expect(targets.getByRole("radio")).toHaveCount(6);
  for (const kind of ["last-commit", "changed", "compare", "pr"]) await expect(targets.locator(`[data-target="${kind}"] input`)).toBeDisabled();
  await expect(targets.locator('[data-target="paths"] input')).toBeEnabled();
  if (narrow) await noSidewaysScroll(page, "gate and target");

  // The preparation: the tools were downloaded when step 2 ended, the dependencies were skipped: one pending item, one button,
  // and the network line names the same step.
  const prep = step.getByTestId("wizard-preparation");
  await expect(prep.getByRole("heading", { name: text.preparation })).toBeVisible();
  const pending = prep.getByTestId("pending-preparations");
  await expect(pending.locator("[data-pending]")).not.toHaveCount(0, { timeout: 90_000 });
  const depsItem = pending.locator('[data-pending="dependencies"]');
  await expect(depsItem).toHaveAttribute("data-network", "bridge");
  await expect(depsItem.getByRole("button")).toHaveCount(1);
  await expect(pending.locator("[data-pending]")).toHaveCount(await pending.locator("[data-pending] button").count());
  const network = step.getByTestId("wizard-network");
  await expect(network).toContainText(text.network);
  await expect(network).not.toContainText("garantido");
  await expect(network).not.toContainText("guaranteed");
  for (const label of await pending.locator("[data-pending] .capst-name").allTextContents()) await expect(network, `the network line names ${label}`).toContainText(label);
  await expect(step).not.toContainText("Máquina local");
  await expect(step).not.toContainText("Local machine");
  await expect(step).not.toContainText("Runner padrão");
  if (narrow) await noSidewaysScroll(page, "preparation");

  // The plan: grouped by category, each row named by what is checked, so no name repeats.
  const plan = step.getByTestId("wizard-plan");
  await expect(plan).toBeVisible();
  await expect(plan.getByTestId("wizard-plan-row").first()).toBeVisible();
  const names = await plan.getByTestId("wizard-plan-row").locator("strong").allTextContents();
  expect(names.length).toBeGreaterThan(3);
  expect(new Set(names).size, `no repeated row: ${names.join(" | ")}`).toBe(names.length);
  expect(await plan.getByTestId("wizard-plan-group").count()).toBeGreaterThan(1);
  await expect(plan.getByTestId("wizard-plan-group").first().locator("h3")).not.toHaveText("");
  // No row repeats "sem rede (garantido)": the network is said once, in the line above.
  await expect(plan.getByTestId("wizard-plan-row").filter({ hasText: /garantido|guaranteed/ })).toHaveCount(0);

  // What will not run: items, grouped by the kind of reason, the tool in bold.
  const list = step.getByTestId("not-running");
  await expect(list).toBeVisible();
  const groups = list.getByTestId("not-running-group");
  expect(await groups.count()).toBeGreaterThan(0);
  const items = list.getByTestId("not-running-item");
  const count = await items.count();
  expect(count).toBeGreaterThan(2);
  await expect(list).toHaveAttribute("data-total", String(count));
  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const bold = await item.locator("strong").first().evaluate((el) => getComputedStyle(el).fontWeight);
    expect(Number(bold), "the tool is in bold").toBeGreaterThanOrEqual(600);
    await expect(item.getByTestId("not-running-tool")).not.toHaveText("");
    await expect(item.getByTestId("not-running-reason")).not.toHaveText("");
  }
  // A check that cannot apply to the project is plain information: no button, no link.
  const cannot = list.locator('li[data-kind="not-applicable"]');
  expect(await cannot.count(), "this project has a check no tool covers").toBeGreaterThan(0);
  await expect(cannot.locator("button, a")).toHaveCount(0);
  await expect(cannot.first().getByTestId("not-running-suggestion")).toHaveCount(0);
  // A check that needs configuration has a suggestion and a link to the options of its tool.
  const configure = list.locator('li[data-kind="configuration"] a[data-action-type="configure"]').first();
  await expect(configure).toBeVisible();
  await expect(configure).toHaveAttribute("href", /^#\/tools/);
  await expect(list.locator('li[data-kind="configuration"]').first().getByTestId("not-running-suggestion")).not.toHaveText("");
  // CodeQL is prepared in the environment, after its terms.
  const codeql = list.locator('[data-reason="CUSTOMER_SUPPLIED"] a[data-action-type="prepare-codeql"]');
  if ((await codeql.count()) > 0) await expect(codeql.first()).toHaveAttribute("href", "#/environment");
  if (narrow) await noSidewaysScroll(page, "plan and what will not run");

  // The step names what it waits for: pressing the button of the dependencies (keyboard only) names it, and the plan is
  // built again when it ends, with nothing left to prepare.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __waits: string[] }).__waits = seen;
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="wizard-waiting"]');
      if (el?.textContent) seen.push(el.textContent);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await press(page, depsItem.getByRole("button", { name: text.dependencies }));
  await expect(pending.locator('[data-pending="dependencies"]')).toHaveCount(0, { timeout: 180_000 });
  const waits = await page.evaluate(() => (window as unknown as { __waits: string[] }).__waits);
  expect(waits.some((w) => w.includes(text.waiting)), `the step said what it waits for: ${waits.join(" / ")}`).toBe(true);
  await expect(step.getByTestId("wizard-waiting")).toHaveCount(0, { timeout: 60_000 });
  await expect(step.getByTestId("wizard-network")).not.toContainText(text.network);

  // The choice is saved as the project's default with a button; jgates.yml gets its selection.
  await expect(gates.getByRole("radio", { name: text.quality })).toBeChecked();
  const save = targets.getByRole("button", { name: text.saveDefault });
  await press(page, save);
  await expect(targets.getByTestId("default-saved")).toContainText(text.saved);
  const yml = fs.readFileSync(path.join(fixture.dir, "jgates.yml"), "utf8");
  expect(yml).toMatch(/selection:/);
  expect(yml).toMatch(/scope: full/);
  expect(yml).toMatch(/gates:\s*\n?\s*- quality|gates: \[quality\]/);
  if (narrow) await noSidewaysScroll(page, "after the preparation");
  await expect(nav.getByRole("button")).not.toHaveCount(0);
}

test("the wizard's review: gate and target first, the plan by what is checked, what will not run as items, the preparation with buttons (pt-BR, keyboard only)", async ({ page }) => {
  const fixture = containerFixture("pt-BR", true);
  const server = await startServer(fixture);
  try {
    await page.goto(server.bootstrapUrl);
    await expect(page.locator('[data-state="wizard"]')).toBeVisible();
    await reviewChecks(page, fixture, PT, false);
    const axe = await new AxeBuilder({ page }).include('[data-testid="wizard-step-review"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("the wizard's review in English at 375 px: the same, and no step scrolls sideways", async ({ page }) => {
  const fixture = containerFixture("en", true);
  await page.setViewportSize({ width: 375, height: 800 });
  const server = await startServer(fixture);
  try {
    await page.goto(server.bootstrapUrl);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator('[data-state="wizard"]')).toBeVisible();
    await reviewChecks(page, fixture, EN, true);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("the review screen: no Máquina local, and its network line agrees with the preparation steps and their buttons", async ({ page }) => {
  const fixture = containerFixture("pt-BR", false);
  const server = await startServer(fixture);
  try {
    const base = await openApp(page, server);
    await page.goto(`${base}#/validations/review`);
    // The tools image is missing: the plan blocks on it, and the download is also a button of the preparation.
    await expect(page.getByTestId("preparation")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("dt").filter({ hasText: /^Execução$/ })).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("Máquina local");
    const line = page.getByTestId("review-network");
    await expect(line).toContainText("A preparação usa a rede para:");
    const pending = page.getByTestId("preparation").getByTestId("pending-preparations");
    await expect(pending.locator('[data-pending="tools"]').getByRole("button", { name: "Baixar as ferramentas do JGates" })).toBeVisible();
    // The dependencies are the step "Preparar as dependências" of the group; the tools and the data are named as they are.
    for (const label of await pending.locator("[data-pending]:not([data-pending='dependencies']) .capst-name").allTextContents()) await expect(line, label).toContainText(label);
    // Every step of the preparation that uses the network is in the line.
    for (const step of await page.getByTestId("preparation").locator('ol > li[data-network="bridge"][data-done="false"] strong').allTextContents()) await expect(line, step).toContainText(step);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

// ---- Escolher -------------------------------------------------------------------------------------------------------

test("Escolher uses the same controls: gate radios, target radios naming the base, branch/tag/commit selects, a folder picker, and the default saved in jgates.yml", async ({ page }) => {
  const fixture = createGateFixture();
  // Two commits, a tag and a branch the workspace is on: what the selects offer.
  fixture.write("src/core/a.js", "exports.a = () => 2;\n");
  fixture.git("add", "-A");
  fixture.git("commit", "-q", "-m", "second");
  fixture.git("tag", "v1");
  fixture.git("checkout", "-q", "-b", "feature");
  const server = await startGateServer(fixture);
  try {
    const base = await openApp(page, server);
    await page.goto(`${base}#/validations/choose`);
    await expect(page.getByRole("heading", { name: "Escolher a validação", level: 1 })).toBeVisible();
    const gates = page.getByTestId("gate-choice");
    const targets = page.getByTestId("target-choice");
    // Semantic is configured here: all three gates are chosen from the radios.
    await expect(gates.getByRole("radio")).toHaveCount(3);
    for (const radio of await gates.getByRole("radio").all()) await expect(radio).toBeEnabled();
    await expect(gates.getByTestId("semantic-off")).toHaveCount(0);
    await expect(targets.getByRole("radio")).toHaveCount(6);
    await expect(targets.getByRole("radio", { name: PT.fullWorkspace })).toBeChecked();

    // Branch changes name their base, picked from the branches of the repository.
    const changed = targets.getByRole("radio", { name: /^Alterações da branch, comparadas com main/ });
    await tabTo(page, targets.getByRole("radio", { name: PT.fullWorkspace }));
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(changed).toBeChecked();
    const baseSelect = targets.locator('[data-target="changed"] select').first();
    await expect(baseSelect).toHaveValue("main");
    // Branches, tags and recent commits are the groups of the select; nothing is typed.
    const groups = await baseSelect.locator("optgroup").evaluateAll((els) => els.map((e) => e.getAttribute("label")));
    expect(groups).toEqual(["Branches locais", "Tags", "Commits recentes"]);
    await expect(baseSelect.locator("optgroup[label='Tags'] option")).toHaveText(["v1"]);
    expect(await baseSelect.locator("optgroup[label='Commits recentes'] option").count()).toBe(2);
    await expect(targets.locator('[data-target="changed"] input[type="text"]')).toHaveCount(0);

    // Comparison: two selects. Pull request: the branch of the pull request is the one the workspace is on.
    await targets.getByRole("radio", { name: "Comparação" }).check();
    await expect(targets.locator('[data-target="compare"] select')).toHaveCount(2);
    await targets.getByRole("radio", { name: "Pull request" }).check();
    const pr = targets.locator('[data-target="pr"] select');
    await expect(pr).toHaveCount(2);
    await expect(pr.nth(0)).toHaveValue("main");
    await expect(pr.nth(1)).toHaveValue("feature");
    await expect(targets.getByTestId("refs-problem")).toHaveCount(0);

    // Last commit needs nothing more; the folder is a picker of the folders of the project.
    await targets.getByRole("radio", { name: /^Último commit/ }).check();
    await expect(targets.locator('[data-target="last-commit"] select')).toHaveCount(0);
    await targets.getByRole("radio", { name: /^Diretório/ }).check();
    const folder = targets.locator('[data-picker="project-folder"] select');
    await expect(folder).toBeVisible();
    const review = page.getByRole("button", { name: "Revisar o plano" });
    await expect(review).toBeDisabled();
    await expect(page.getByTestId("path-problem")).toContainText("Informe o diretório");
    await folder.selectOption("src");
    await expect(page.getByTestId("path-problem")).toHaveCount(0);
    await expect(review).toBeEnabled();

    // The choice (both gates, the folder) is saved as the default of the project, and preselected the next time.
    await gates.getByRole("radio", { name: PT.both }).check();
    const save = targets.getByRole("button", { name: PT.saveDefault });
    await expect(save).toBeEnabled();
    await press(page, save);
    await expect(targets.getByTestId("default-saved")).toContainText(PT.saved);
    const yml = fs.readFileSync(path.join(fixture.dir, "jgates.yml"), "utf8");
    expect(yml).toMatch(/scope: paths/);
    expect(yml).toMatch(/- semantic/);
    expect(yml).toMatch(/- src/);
    await page.evaluate(() => window.sessionStorage.clear());
    await page.reload();
    await expect(page.getByTestId("gate-choice").getByRole("radio", { name: PT.both })).toBeChecked();
    await expect(page.getByTestId("target-choice").getByRole("radio", { name: /^Diretório/ })).toBeChecked();
    await expect(page.getByTestId("target-choice").locator('[data-picker="project-folder"] select')).toHaveValue("src");
    // A target that names commits cannot be a default.
    await page.getByTestId("target-choice").getByRole("radio", { name: /^Último commit/ }).check();
    await expect(page.getByTestId("target-choice").getByRole("button", { name: PT.saveDefault })).toBeDisabled();
    // The last commit goes to the review as a plan of what the commit changed.
    await page.getByTestId("gate-choice").getByRole("radio", { name: PT.quality }).check();
    await page.getByRole("button", { name: "Revisar o plano" }).click();
    await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/, { timeout: 90_000 });
    await expect(page.getByTestId("review-network")).toContainText("Nenhuma verificação usa a rede");
    await expect(page.locator("dt").filter({ hasText: /^Execução$/ })).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("Máquina local");
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("Escolher at 375 px in English: the gate and the target stay usable and the page never scrolls sideways", async ({ page }) => {
  const fixture = createFixture();
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language: "en" }, null, 2)}\n`, { mode: 0o600 });
  await page.setViewportSize({ width: 375, height: 800 });
  const server = await startServer(fixture);
  try {
    const base = await openApp(page, server);
    await page.goto(`${base}#/validations/choose`);
    await expect(page.getByTestId("gate-choice")).toBeVisible();
    // This project has no Semantic provider: the gate says so and offers the way to set it up.
    await expect(page.getByTestId("semantic-off")).toContainText("not set up yet");
    await expect(page.getByTestId("gate-choice").getByRole("radio", { name: EN.semantic })).toBeDisabled();
    await expect(page.getByTestId("gate-choice").getByRole("link", { name: EN.semanticAction })).toBeVisible();
    await noSidewaysScroll(page, "Escolher");
    // Not a Git repository: only the workspace and a folder, and the reason is said once.
    await expect(page.getByTestId("target-choice")).toContainText("not a Git repository");
    await tabTo(page, page.getByTestId("target-choice").getByRole("radio", { name: EN.fullWorkspace }));
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("target-choice").getByRole("radio", { name: /^Directory/ })).toBeChecked();
    await expect(page.getByTestId("target-choice").locator('[data-picker="project-folder"] select')).toBeVisible();
    await noSidewaysScroll(page, "Escolher with the folder");
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
