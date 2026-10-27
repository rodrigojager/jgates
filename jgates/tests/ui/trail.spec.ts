import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MAIN, PYTEST_SECTION, PYTHON, createFixture, sha256, startServer, tomlSection, type Fixture, type UiServer } from "./support";

// The vertical slice through the browser: editing the Ruff configuration in the UI changes what the next run finds.

const EDITOR = ".editor-host .cm-content";

async function withServer(body: (ctx: { page: Page; fixture: Fixture; server: UiServer }) => Promise<void>, page: Page) {
  const fixture = createFixture();
  let server: UiServer | null = null;
  try {
    server = await startServer(fixture);
    await page.goto(server.bootstrapUrl);
    // The bootstrap page redirects to the application, which opens on the overview; these specs start from the Tools tab.
    await page.waitForURL((url) => !url.pathname.startsWith("/session"));
    await page.goto(page.url().split("#")[0] + "#/tools");
    await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();
    await body({ page, fixture, server });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

async function openRuffConfig(page: Page) {
  await page.getByRole("link", { name: "Abrir ruff" }).click();
  // The area opens on the Options tab; the file editor is the Files tab.
  await page.getByRole("tab", { name: "Arquivos" }).click();
  await page.getByRole("button", { name: /pyproject\.toml/ }).first().click();
  await expect(page.locator(EDITOR)).toBeVisible();
  await expect(page.locator(EDITOR)).toContainText("tool.ruff.lint");
}

async function runPlanAndWait(page: Page): Promise<{ planHash: string; findingRules: string[] }> {
  await page.goto(page.url().split("#")[0] + "#/plan");
  const hash = page.getByTestId("plan-hash");
  await expect(hash).toHaveText(/^\S{16,}$/,{ timeout: 60_000 });
  const planHash = ((await hash.textContent()) ?? "").trim();
  await page.getByRole("button", { name: "Executar" }).click();
  await expect(page.getByTestId("run-state")).toHaveAttribute("data-state", "finished", { timeout: 120_000 });
  await expect(page.getByRole("heading", { name: "Resultado" })).toBeVisible();
  const findingRules = (await page.getByRole("table", { name: "Achados" }).locator("tbody tr td:nth-child(2)").allTextContents()).map((s) => s.trim());
  return { planHash, findingRules };
}

function newestResult(home: string): any {
  const files: { file: string; mtime: number }[] = [];
  const workspaces = path.join(home, "workspaces");
  for (const w of fs.readdirSync(workspaces)) {
    const runs = path.join(workspaces, w, "runs");
    if (!fs.existsSync(runs)) continue;
    for (const r of fs.readdirSync(runs)) {
      const file = path.join(runs, r, "result.json");
      if (fs.existsSync(file)) files.push({ file, mtime: fs.statSync(file).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  expect(files.length).toBeGreaterThan(0);
  return JSON.parse(fs.readFileSync(files[0]!.file, "utf8"));
}

test("edit the Ruff configuration in the UI, save, run: the finding of the ignored rule is gone", async ({ page }) => {
  await withServer(async ({ fixture }) => {
    // Baseline run: both known violations are reported.
    const before = await runPlanAndWait(page);
    expect(before.findingRules.join(" ")).toContain("F401");
    expect(before.findingRules.join(" ")).toContain("E711");

    await page.goto(page.url().split("#")[0] + "#/tools");
    await openRuffConfig(page);
    const original = fs.readFileSync(fixture.pyproject, "utf8");
    const pytestBefore = tomlSection(original, "[tool.pytest.ini_options]");
    expect(pytestBefore).toBe(`${PYTEST_SECTION}\n`);

    // Edit: ignore F401 only.
    await page.locator(EDITOR).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type('ignore = ["F401"]');
    await expect(page.getByText("Alterações não salvas")).toBeVisible();

    // Review the diff, then save.
    await page.getByRole("button", { name: "Revisar alterações" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText('ignore = ["F401"]');
    await expect(dialog).toContainText("A sintaxe está válida."); // TOML is checked by the sidecar helper
    await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByText(/Arquivo salvo\. Nova revisão/)).toBeVisible();

    // The disk has the edit, and the pytest section is byte for byte the same.
    const saved = fs.readFileSync(fixture.pyproject, "utf8");
    expect(saved).toContain('ignore = ["F401"]');
    expect(tomlSection(saved, "[tool.pytest.ini_options]")).toBe(pytestBefore);
    expect(saved.startsWith(original.trimEnd())).toBe(true);

    // The next run does not report the ignored rule any more; the plan hash on screen is the one in result.json.
    const after = await runPlanAndWait(page);
    expect(after.findingRules.join(" ")).not.toContain("F401");
    expect(after.findingRules.join(" ")).toContain("E711");
    expect(after.planHash).not.toBe(before.planHash);
    const result = newestResult(fixture.home);
    expect(result.selection.planHash).toBe(after.planHash);
    expect(sha256(fs.readFileSync(fixture.pyproject))).toBe(sha256(saved));
  }, page);
});

test("an external change during the edit shows the conflict dialog and the disk keeps the external version", async ({ page }) => {
  await withServer(async ({ fixture }) => {
    await openRuffConfig(page);
    await page.locator(EDITOR).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type('ignore = ["F401"]');
    await page.getByRole("button", { name: "Revisar alterações" }).click();
    const review = page.getByRole("dialog");
    await expect(review).toContainText('ignore = ["F401"]');

    // Another writer changes the file while the review is open.
    const external = fs.readFileSync(fixture.pyproject, "utf8").replace('select = ["E", "F"]', 'select = ["E", "F", "I"]');
    fs.writeFileSync(fixture.pyproject, external);

    await review.getByRole("button", { name: "Salvar", exact: true }).click();
    const conflict = page.getByRole("dialog", { name: "O arquivo mudou no disco" });
    await expect(conflict).toBeVisible();
    await expect(page.getByTestId("conflict-current")).toContainText('select = ["E", "F", "I"]');
    await expect(page.getByTestId("conflict-local")).toContainText('ignore = ["F401"]');
    // Nothing was written: the file is the external version.
    expect(fs.readFileSync(fixture.pyproject, "utf8")).toBe(external);

    await conflict.getByRole("button", { name: "Descartar o local e carregar o atual" }).click();
    await expect(page.locator(EDITOR)).toContainText('select = ["E", "F", "I"]');
    await expect(page.locator(EDITOR)).not.toContainText("ignore");
    expect(fs.readFileSync(fixture.pyproject, "utf8")).toBe(external);
  }, page);
});

// ---- The whole trail on the main fixture, and its equivalence with the CLI ---------------------------------------------
// Discover, choose, edit a tool in the UI, review, run (failed: the two planted findings), fix the fixture, run again
// (Aprovado). Each state is also run by the CLI with the command the review shows, and the results must agree.

const here = path.dirname(fileURLToPath(import.meta.url));
const mainFixtureLib = createRequire(import.meta.url)(path.resolve(here, "..", "..", "..", "tests", "fixtures", "jgates", "main-fixture.js")) as {
  MIN_API_COVERAGE: number;
  createMainFixture(): { dir: string };
  fixMainFixture(dir: string): string;
  removeFixture(dir: string): void;
};

const JGATES_YML = `schemaVersion: 1
extends:
  - .jgates/profiles.yml
selection:
  profile: demo
templates:
  - id: base
    source: builtin:base
    activation: always
  - id: python
    source: builtin:python
    activation: detected
    match:
      languages:
        - python
  - id: python-pytest
    source: builtin:python-pytest
    activation: detected
    match:
      languages:
        - python
`;
const PROFILES_YML = `schemaVersion: 1
profiles:
  demo:
    label: Demonstração local
    description: Lint, arquitetura, testes e cobertura do Python, tudo local e sem Docker.
    checks:
      capability:lint: { enabled: true }
      capability:architecture: { enabled: true }
      capability:unit: { enabled: true }
      capability:coverage: { enabled: true }
      capability:file-size: { enabled: false }
      capability:secrets: { enabled: false }
      capability:sast: { enabled: false }
      capability:dependencies: { enabled: false }
      capability:duplication: { enabled: false }
      capability:iac: { enabled: false }
      capability:pii: { enabled: false }
      tool:quality-bridge: { enabled: false }
      tool:builtin-pii: { enabled: false }
`;
const TOOLS_YML = `schemaVersion: 1
tools:
  ruff:
    adapter: ruff
    component: api
    capabilities: [lint]
  import-linter:
    adapter: import-linter
    component: api
    capabilities: [architecture]
  pytest:
    adapter: pytest
    component: api
    config: api/pyproject.toml
    capabilities: [unit, coverage]
`;
const POLICY_YML = `schemaVersion: 1\nrules:\n  coverage.minimum:\n    threshold: ${mainFixtureLib.MIN_API_COVERAGE}\n`;
const ARCHITECTURE_YML = `schemaVersion: 1
architecture:
  layers:
    - id: domain
      paths: ["api/src/shop_api/domain/**"]
    - id: infrastructure
      paths: ["api/src/shop_api/infrastructure/**"]
  rules:
    - id: domain-independent
      kind: forbidden-dependency
      from: domain
      to: [infrastructure]
      enabled: true
      severity: high
      blocking: true
      owner: generated
`;

interface Main {
  dir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  fixture: Fixture;
  cli(args: string[]): { code: number | null; doc: any; out: string };
  cleanup(): void;
}

function gitIn(dir: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** The main fixture with the demonstration configuration (only steps that run locally), as the CLI demonstration has it. */
function createMain(): Main {
  const { dir } = mainFixtureLib.createMainFixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-trail-home-"));
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-trail-bin-"));
  const env: NodeJS.ProcessEnv = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, PATH: emptyBin, DOCKER_HOST: "tcp://127.0.0.1:1" };
  delete env.JGATES_NO_CACHE;
  delete env.JGATES_RUFF;
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 300_000, cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    let doc: any = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, doc, out: `${r.stdout}${r.stderr}` };
  };
  const init = cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
  if (init.code !== 0) throw new Error(`init failed: ${init.out}`);
  const files: Record<string, string> = {
    "jgates.yml": JGATES_YML,
    ".jgates/profiles.yml": PROFILES_YML,
    ".jgates/tools.yml": TOOLS_YML,
    ".jgates/policy.yml": POLICY_YML,
    ".jgates/architecture.yml": ARCHITECTURE_YML,
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return {
    dir,
    home,
    env,
    fixture: { dir, home, pyproject: path.join(dir, "api", "pyproject.toml"), env, cleanup() {} },
    cli,
    cleanup() {
      mainFixtureLib.removeFixture(dir);
      for (const d of [home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

/** The correction as a commit; the JGates configuration stays out of it (as in the CLI demonstration). */
function fixMain(m: Main): void {
  mainFixtureLib.fixMainFixture(m.dir);
  gitIn(m.dir, ["rm", "-r", "-q", "--cached", "jgates.yml", ".jgates"]);
  gitIn(m.dir, ["commit", "-q", "--amend", "--no-edit"]);
}

function resultsOf(home: string): { runId: string; doc: any }[] {
  const out: { runId: string; doc: any; mtime: number }[] = [];
  const workspaces = path.join(home, "workspaces");
  for (const w of fs.existsSync(workspaces) ? fs.readdirSync(workspaces) : []) {
    const runs = path.join(workspaces, w, "runs");
    if (!fs.existsSync(runs)) continue;
    for (const r of fs.readdirSync(runs)) {
      const file = path.join(runs, r, "result.json");
      if (fs.existsSync(file)) out.push({ runId: r, doc: JSON.parse(fs.readFileSync(file, "utf8")), mtime: fs.statSync(file).mtimeMs });
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

const fingerprints = (doc: any): string[] => (doc.findings as any[]).map((f) => f.fingerprint as string).sort();
const base = (page: Page): string => page.url().split("#")[0] as string;

/** Escolher (demo profile, optionally with checks turned off) -> Revisar -> Executar -> the finished run. */
async function chooseReviewRun(page: Page, off: (string | RegExp)[] = []): Promise<{ command: string; planHash: string }> {
  await page.goto(`${base(page)}#/validations/choose`);
  await expect(page.getByRole("heading", { name: "Escolher a validação", level: 1 })).toBeVisible();
  await page.locator('[data-profile="demo"]').click();
  if (off.length > 0) {
    await page.getByTestId("customize").locator("summary").click();
    for (const name of off) await page.getByRole("checkbox", { name }).uncheck();
  }
  await page.getByRole("button", { name: "Revisar o plano" }).click();
  await expect(page.getByRole("heading", { name: "Revisar a validação", level: 1 })).toBeVisible();
  await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/, { timeout: 60_000 });
  await expect(page.getByTestId("blockers")).toHaveCount(0);
  const planHash = ((await page.getByTestId("plan-hash").textContent()) ?? "").trim();
  const command = ((await page.getByTestId("equivalent-command").textContent()) ?? "").trim();
  await page.getByRole("button", { name: "Executar" }).click();
  await expect(page.getByTestId("run-state")).toHaveAttribute("data-state", "finished", { timeout: 240_000 });
  await expect(page.getByTestId("result-banner")).toBeVisible({ timeout: 60_000 });
  return { command, planHash };
}

/**
 * Runs the command the review showed, by the CLI, on the same workspace (the plan binds to the workspace path and id) but
 * with a home of its own, so the UI run leaves nothing to reuse. The runs of the home are the CLI side of the comparison.
 */
function runShownCommand(m: Main, home: string, command: string) {
  const argv = command.split(" ").slice(1);
  const r = spawnSync(process.execPath, [MAIN, ...argv, "--no-interactive"], { encoding: "utf8", env: { ...m.env, JGATES_HOME: home }, input: "", timeout: 300_000, cwd: m.dir, maxBuffer: 64 * 1024 * 1024 });
  let doc: any = null;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    doc = null;
  }
  return { code: r.status, doc, out: `${r.stdout}${r.stderr}` };
}

/** Tracked files plus the JGates configuration, with their hashes: what a run must leave alone. */
function projectFiles(dir: string): Record<string, string> {
  const names = new Set(gitIn(dir, ["ls-files"]).split("\n").filter(Boolean));
  names.add("jgates.yml");
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, e.name);
      if (e.isDirectory()) walk(child);
      else names.add(child);
    }
  };
  walk(".jgates");
  return Object.fromEntries([...names].sort().map((n) => [n, sha256(fs.readFileSync(path.join(dir, n)))]));
}

test("the whole trail through the UI: failed with the two findings, fix, Aprovado, and the same results as the CLI", async ({ page, context }) => {
  test.setTimeout(900_000);
  const ui = createMain();
  const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-trail-clihome-"));
  const other = createFixture();
  let server: UiServer | null = null;
  try {
    server = await startServer(ui.fixture);
    await page.goto(server.bootstrapUrl);
    await page.waitForURL((url) => !url.pathname.startsWith("/session"));

    // Discover: the three components of the fixture, with their evidence.
    await page.goto(`${base(page)}#/workspace`);
    await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();
    await expect(page.locator("article[data-component]")).toHaveCount(3);

    // Templates: the three declared by the project are listed.
    await page.goto(`${base(page)}#/config/templates`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("python-pytest").first()).toBeVisible();

    // Edit a tool in the UI: a comment in the pyproject that pytest reads; the review gets the new input.
    await page.goto(`${base(page)}#/tools`);
    await page.getByRole("link", { name: "Abrir pytest" }).click();
    await page.getByRole("tab", { name: "Arquivos" }).click();
    await page.getByRole("button", { name: /pyproject\.toml/ }).first().click();
    await expect(page.locator(EDITOR)).toContainText("tool.setuptools");
    await page.locator(EDITOR).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("# edited in the UI");
    await page.getByRole("button", { name: "Revisar alterações" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByText(/Arquivo salvo\. Nova revisão/)).toBeVisible();
    const edited = fs.readFileSync(path.join(ui.dir, "api", "pyproject.toml"), "utf8");
    expect(edited).toContain("# edited in the UI");

    // Run 1 through the UI: Reprovado, decision failed, exactly the two findings.
    const first = await chooseReviewRun(page);
    await expect(page.getByTestId("result-banner")).toHaveAttribute("data-kind", /.*/);
    await expect(page.getByTestId("result-banner-title")).toHaveText("Reprovado");
    const uiFirst = resultsOf(ui.home).at(-1)!.doc;
    expect(uiFirst.decision).toBe("failed");
    expect(uiFirst.findings.map((f: any) => f.tool).sort()).toEqual(["import-linter", "pytest"]);
    expect(uiFirst.selection.planHash).toBe(first.planHash);
    await expect(page.getByRole("table", { name: "Achados" }).locator("tbody tr")).toHaveCount(2);

    // The command the review showed, run by the CLI on the same state: same decision, fingerprints and plan hash.
    const cliFirst = runShownCommand(ui, cliHome, first.command);
    expect(cliFirst.code, cliFirst.out).toBe(1);
    expect(cliFirst.doc.decision).toBe(uiFirst.decision);
    expect(fingerprints(cliFirst.doc)).toEqual(fingerprints(uiFirst));
    expect(fingerprints(uiFirst).length).toBe(2);
    expect(cliFirst.doc.selection.planHash).toBe(uiFirst.selection.planHash);

    // The fix (a new commit), on both copies; run 2 through the UI ends with Aprovado.
    fixMain(ui);
    const secondRun = await chooseReviewRun(page);
    await expect(page.getByTestId("result-banner-title")).toHaveText("Aprovado");
    const uiSecond = resultsOf(ui.home).at(-1)!.doc;
    expect(uiSecond.decision).toBe("passed");
    expect(uiSecond.findings.length).toBe(0);
    expect(uiSecond.analyzed.inputs.hash).not.toBe(uiFirst.analyzed.inputs.hash);
    const cliSecond = runShownCommand(ui, cliHome, secondRun.command);
    expect(cliSecond.code, cliSecond.out).toBe(0);
    expect(cliSecond.doc.decision).toBe("passed");
    expect(fingerprints(cliSecond.doc)).toEqual(fingerprints(uiSecond));
    expect(cliSecond.doc.selection.planHash).toBe(uiSecond.selection.planHash);

    // Reduced run: 'Testes unitários' off in the panel. No file of the project changes.
    const filesBefore = projectFiles(ui.dir);
    await chooseReviewRun(page, [/Testes unitários/]);
    await expect(page.getByTestId("result-banner")).toHaveAttribute("data-kind", "passed-reduced");
    expect(resultsOf(ui.home).at(-1)!.doc.reduced).toBe(true);
    expect(projectFiles(ui.dir)).toEqual(filesBefore);

    // Salvar como perfil: the card shows up in Escolher.
    await page.goto(`${base(page)}#/validations/choose`);
    await page.locator('[data-profile="demo"]').click();
    await page.getByTestId("customize").locator("summary").click();
    await page.getByRole("checkbox", { name: /Testes unitários/ }).uncheck();
    await page.getByRole("button", { name: "Salvar como perfil" }).click();
    await page.getByLabel("Identificador do novo perfil").fill("sem-unitarios");
    await page.getByRole("button", { name: "Criar perfil" }).click();
    await expect(page.locator('[data-profile="sem-unitarios"]')).toBeVisible();

    // The history lists the three runs of this workspace.
    await page.goto(`${base(page)}#/validations`);
    await expect(page.locator("tr[data-run]")).toHaveCount(3);
    const mine = resultsOf(ui.home).map((r) => r.runId);

    // Another workspace with one run of its own: after the switch the history shows only that run.
    const otherEnv = { ...other.env, JGATES_HOME: ui.home };
    const added = spawnSync(process.execPath, [MAIN, "workspaces", "add", other.dir], { env: otherEnv, encoding: "utf8" });
    expect(added.status, added.stderr).toBe(0);
    const otherRun = spawnSync(process.execPath, [MAIN, "run", "--cwd", other.dir, "--no-interactive", "--json"], { env: otherEnv, encoding: "utf8", timeout: 170_000, maxBuffer: 64 * 1024 * 1024 });
    const otherDoc = JSON.parse(otherRun.stdout);
    expect(mine).not.toContain(otherDoc.runId);

    await page.getByRole("button", { name: "Selecionar workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Selecionar workspace" });
    const popupPromise = context.waitForEvent("page");
    await dialog.locator(".ws-item").filter({ hasText: path.basename(other.dir) }).getByRole("button", { name: /Abrir/ }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    await expect(popup.getByRole("button", { name: "Selecionar workspace" })).toContainText(path.basename(other.dir));
    await popup.goto(`${popup.url().split("#")[0]}#/validations`);
    await expect(popup.locator("tr[data-run]")).toHaveCount(1);
    await expect(popup.locator(`tr[data-run="${otherDoc.runId}"]`)).toBeVisible();
    for (const id of mine) await expect(popup.locator(`tr[data-run="${id}"]`)).toHaveCount(0);
  } finally {
    await server?.stop();
    ui.cleanup();
    fs.rmSync(cliHome, { recursive: true, force: true });
    other.cleanup();
  }
});
