import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startServer, type Fixture } from "./support";

// The Workspace area on the main fixture (three components). Components and why they were detected, the
// discovery mode and the scope written by patch into .jgates/workspace.yml (comments stay), the preview of what an
// exclude takes out, unsupported languages and conflicting lockfiles, and the Ambiente tab.

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createMainFixture, removeFixture } = require(path.resolve(here, "..", "..", "..", "tests", "fixtures", "jgates", "main-fixture.js")) as {
  createMainFixture(): { dir: string };
  removeFixture(dir: string): void;
};

const WORKSPACE_YML = "# Workspace settings: keep this comment\nschemaVersion: 1\ndiscovery:\n  mode: auto # trailing note\n";

function mainFixture(): Fixture {
  const { dir } = createMainFixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ui-home-"));
  fs.mkdirSync(path.join(dir, ".jgates"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".jgates", "workspace.yml"), WORKSPACE_YML);
  // Committed, so the top bar shows a clean tree (the dirty mark is not what this spec is about).
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "f@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "f@example.invalid" } });
  git("add", "-A");
  git("commit", "-q", "-m", "workspace settings");
  return {
    dir,
    home,
    pyproject: path.join(dir, "api", "pyproject.toml"),
    env: { ...process.env, JGATES_HOME: home },
    cleanup() {
      removeFixture(dir);
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("Workspace shows the components, the scope preview, the mode by patch and the Ambiente tab", async ({ page }) => {
  const fixture = mainFixture();
  const file = path.join(fixture.dir, ".jgates", "workspace.yml");
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    server = await startServer(fixture);
    await page.goto(server.bootstrapUrl);
    await page.getByRole("link", { name: "Workspace" }).first().click();
    await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();

    // Componentes: the three components of the main fixture, each with the manifests that justify it.
    const cards = page.locator("article[data-component]");
    await expect(cards).toHaveCount(3);
    const expected: Record<string, string> = { web: "web/package.json", api: "api/pyproject.toml", "libs-shared": "libs/shared/package.json" };
    for (const [id, manifest] of Object.entries(expected)) {
      const card = page.locator(`article[data-component="${id}"]`);
      await expect(card).toBeVisible();
      await expect(card.getByTestId("status-badge")).toHaveText("detected");
      await card.getByRole("button", { name: "Por que foi detectado?" }).click();
      const dialog = page.getByTestId("why-dialog");
      await expect(dialog.getByTestId("why-evidence")).toContainText(manifest);
      await expect(dialog).toContainText("discovery/");
      await page.getByRole("button", { name: "Fechar" }).click();
    }
    await expect(page.getByTestId("ws-tree")).toContainText(".jgates/");

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);

    // Detectar novamente: what appeared since the previous discovery, an unsupported language and a lockfile conflict.
    fs.mkdirSync(path.join(fixture.dir, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(fixture.dir, "legacy", "pom.xml"), "<project/>\n");
    fs.mkdirSync(path.join(fixture.dir, "tools", "dual"), { recursive: true });
    fs.writeFileSync(path.join(fixture.dir, "tools", "dual", "package.json"), '{ "name": "dual", "version": "1.0.0" }\n');
    fs.writeFileSync(path.join(fixture.dir, "tools", "dual", "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(fixture.dir, "tools", "dual", "yarn.lock"), "\n");
    await page.getByRole("button", { name: "Detectar novamente" }).click();
    await expect(page.getByTestId("discovery-changes")).toContainText("Novo:");

    await page.getByRole("tab", { name: "Detecção e escopo" }).click();
    await expect(page.getByTestId("unsupported")).toContainText("java em legacy");
    await expect(page.getByTestId("unsupported")).toContainText("Motivo");
    await expect(page.getByTestId("lockfile-conflicts")).toContainText("tools/dual");
    await expect(page.getByTestId("lockfile-conflicts")).toContainText("package-lock.json");
    await expect(page.getByTestId("lockfile-conflicts")).toContainText("yarn.lock");
    await expect(page.getByTestId("lockfile-conflicts")).toContainText("Motivo");

    for (const theme of ["light", "dark"]) {
      await page.getByRole("combobox", { name: "Tema" }).selectOption(theme);
      const scopeAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(scopeAxe.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    }

    // Excluir: the preview names the files that leave and the rule, and nothing is written before Salvar.
    await page.getByLabel("Excluir", { exact: true }).fill("web/src");
    const excluded = page.getByTestId("preview-excluded");
    await expect(excluded).toContainText("web/src/index.ts");
    await expect(excluded).toContainText("exclude: web/src");
    await expect(page.getByTestId("preview-summary")).toContainText("saem com esta alteração");
    await expect(page.getByTestId("scope-state")).toContainText("Alterações não salvas");
    expect(fs.readFileSync(file, "utf8")).toBe(WORKSPACE_YML);
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByTestId("scope-state")).toContainText("Salvo em .jgates/workspace.yml");
    const afterExclude = fs.readFileSync(file, "utf8");
    expect(afterExclude).toContain("# Workspace settings: keep this comment");
    expect(afterExclude).toContain("# trailing note");
    expect(afterExclude).toMatch(/exclude:\s*\n\s*- web\/src/);

    // Só reportar: discovery.mode is patched in place, comments included.
    // The screen re-reads the file after the previous save: a click that lands during that re-render is not a choice, so
    // the click is repeated until the radio is the checked one (the saved file is asserted right below).
    await expect(async () => {
      await page.getByRole("radio", { name: /Só reportar/ }).click({ timeout: 5_000 });
      await expect(page.getByRole("radio", { name: /Só reportar/ })).toBeChecked({ timeout: 5_000 });
    }).toPass({ timeout: 45_000 });
    await expect(page.getByTestId("scope-state")).toContainText("Salvo em .jgates/workspace.yml");
    await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("mode: report-only");
    const afterMode = fs.readFileSync(file, "utf8");
    expect(afterMode).toContain("# Workspace settings: keep this comment");
    expect(afterMode).toContain("# trailing note");
    expect(afterMode).toMatch(/exclude:\s*\n\s*- web\/src/);
    expect(afterMode).not.toContain("mode: auto");

    // Ambiente opens from the Workspace tab and from the card at the foot of the navigation.
    await page.getByRole("tab", { name: "Ambiente" }).click();
    await expect(page.getByRole("heading", { name: "Ambiente", level: 1 })).toBeVisible();
    await page.getByRole("link", { name: "Workspace" }).first().click();
    await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();
    await page.getByTestId("card-environment").click();
    await expect(page.getByRole("heading", { name: "Ambiente", level: 1 })).toBeVisible();
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
});

test("Declarar componente offers languages, frameworks and folders as choices, keyboard first", async ({ page }) => {
  const fixture = mainFixture();
  const file = path.join(fixture.dir, ".jgates", "workspace.yml");
  // A declared component with the "kind" field the dialog no longer shows: a correction must keep it.
  const declared = `${WORKSPACE_YML}components:\n  - id: api # the Python API\n    path: api\n    language: python\n    kind: service\n`;
  fs.writeFileSync(file, declared);
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    server = await startServer(fixture);
    await page.goto(server.bootstrapUrl);
    await page.getByRole("link", { name: "Workspace" }).first().click();
    const card = page.locator('article[data-component="api"]');
    await expect(card.getByTestId("status-badge")).toHaveText("explicit");
    await card.getByRole("button", { name: "Corrigir" }).click();

    const dialog = page.getByRole("dialog", { name: "Corrigir api" });
    const form = dialog.getByTestId("declare-form");
    await expect(form).toBeVisible();
    const pathField = dialog.getByLabel("Caminho");
    const idField = dialog.getByLabel("Identificador");
    const language = dialog.getByLabel("Linguagem", { exact: true });
    const framework = dialog.getByLabel("Framework", { exact: true });
    // kind left the form; every field explains itself.
    await expect(dialog.getByLabel("Tipo")).toHaveCount(0);
    for (const field of [pathField, idField, language, framework]) await expect(field).toHaveAttribute("aria-describedby", /help/);
    await expect(dialog).toContainText("relativa à raiz do projeto");

    // The supported languages by readable name, then the recognized ones without tools, then Outro….
    const supported = dialog.locator('#ws-decl-language optgroup[label="Com verificações do JGates"] option');
    await expect(supported).toHaveText(["Python", "TypeScript", "JavaScript", "Go", "Rust", "C#", "F#", "Visual Basic"]);
    await expect(dialog.locator('#ws-decl-language optgroup[label="Reconhecidas, sem ferramentas ainda"] option[value="cpp"]')).toHaveText("C++ (sem ferramentas ainda)");
    await expect(language.locator("option").last()).toHaveText("Outro…");
    await expect(language).toHaveValue("python");
    // Python offers only Python frameworks, Nenhum and Outro….
    await expect(framework.locator("option")).toHaveText(["Nenhum", "Django", "FastAPI", "Flask", "Starlette", "Tornado", "Outro…"]);

    // Keyboard only: the path field has the focus, Tab walks to the language, arrows change it.
    await expect(pathField).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(idField).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(language).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(language).toHaveValue("typescript");
    await expect(framework.locator('option[value="next"]')).toHaveText("Next.js");
    await expect(framework.locator('option[value="fastapi"]')).toHaveCount(0);
    await page.keyboard.press("ArrowUp");
    await expect(language).toHaveValue("python");

    // A recognized language without tools says what that means.
    await language.selectOption("cpp");
    await expect(dialog.getByTestId("language-notice")).toContainText("O JGates reconhece C++, mas ainda não tem ferramentas");
    await expect(framework.locator("option")).toHaveText(["Nenhum", "Outro…"]);
    // Outro… opens a free field with its own label and help.
    await language.selectOption({ label: "Outro…" });
    await expect(dialog.getByLabel("Qual linguagem?")).toBeVisible();
    await dialog.getByLabel("Qual linguagem?").fill("elm");
    await expect(dialog.getByTestId("language-notice")).toContainText("não conhece essa linguagem");
    await language.selectOption("python");
    await expect(dialog.getByLabel("Qual linguagem?")).toHaveCount(0);
    await expect(dialog.getByTestId("language-notice")).toHaveCount(0);
    await framework.selectOption({ label: "Outro…" });
    await expect(dialog.getByLabel("Qual framework?")).toBeVisible();
    await framework.focus();
    await page.keyboard.press("Home");
    await expect(framework).toHaveValue("");
    await framework.selectOption({ label: "FastAPI" });

    // 375 px: the dialog fits without horizontal scrolling.
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.locator("dialog[open]").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const axe = await new AxeBuilder({ page }).include("dialog[open]").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 800 });

    await dialog.getByRole("button", { name: "Gravar no workspace.yml" }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("framework: fastapi");
    const saved = fs.readFileSync(file, "utf8");
    expect(saved).toContain("language: python");
    expect(saved).toContain("kind: service");
    expect(saved).toContain("# Workspace settings: keep this comment");

    // A new declaration: folders are suggested (detected ones first), the id follows the path, Esc closes.
    await page.getByRole("button", { name: "Declarar componente" }).click();
    const fresh = page.getByRole("dialog", { name: "Declarar componente" });
    const folders = fresh.locator("#ws-decl-folders option");
    await expect(folders.first()).toHaveAttribute("value", "api");
    await expect(fresh.locator('#ws-decl-folders option[value="web"]')).toHaveText("componente detectado");
    await expect(fresh.locator('#ws-decl-folders option[value="web/src"]')).toHaveCount(1);
    await expect(fresh.getByLabel("Linguagem", { exact: true })).toHaveValue("");
    await expect(fresh.getByLabel("Framework", { exact: true }).locator('option[value="fastapi"]')).toHaveCount(1);
    await page.keyboard.type("libs/Shared Code");    await expect(fresh.getByLabel("Identificador")).toHaveValue("libs-shared-code");
    await page.keyboard.press("Escape");
    await expect(fresh).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Declarar componente" })).toBeFocused();
    expect(fs.readFileSync(file, "utf8")).toBe(saved);
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
});

test("Workspace refuses to overwrite a workspace.yml that changed outside the screen", async ({ page }) => {
  const fixture = mainFixture();
  const file = path.join(fixture.dir, ".jgates", "workspace.yml");
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    server = await startServer(fixture);
    await page.goto(server.bootstrapUrl);
    await page.getByRole("link", { name: "Workspace" }).first().click();
    await page.getByRole("tab", { name: "Detecção e escopo" }).click();
    const outside = `${WORKSPACE_YML}exclude:\n  - docs\n`;
    fs.writeFileSync(file, outside);
    await page.getByLabel("Excluir", { exact: true }).fill("web");
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByTestId("scope-state")).toContainText("Conflito");
    expect(fs.readFileSync(file, "utf8")).toBe(outside);
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
});
