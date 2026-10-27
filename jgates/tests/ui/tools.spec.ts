import { expect, test, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { parse as parseYaml } from "yaml";
import { createFixture, startServer, type Fixture, type UiServer } from "./support";

// Tools: catalog and instances, the tool area (tab order, missing file, package file, effective configuration,
// rendered command), the choice kept for a draft, and the Editor component against a parent that renders an older text.

const EDITOR = ".editor-host .cm-content";
const ESLINT_CONFIG = "export default [];\n";
const here = path.dirname(fileURLToPath(import.meta.url));

function write(root: string, rel: string, content: string) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** The Python fixture plus two TypeScript components (web, ui), the tools.yml given and the files given. */
function createToolsFixture(tools: string, files: Record<string, string> = {}): Fixture {
  const fixture = createFixture();
  for (const c of ["web", "ui"]) {
    write(fixture.dir, `${c}/package.json`, JSON.stringify({ name: c, version: "1.0.0", devDependencies: { typescript: "5" } }));
    write(fixture.dir, `${c}/tsconfig.json`, "{}\n");
    write(fixture.dir, `${c}/src/index.ts`, "export const a = 1;\n");
  }
  write(fixture.dir, ".jgates/tools.yml", tools);
  for (const [rel, content] of Object.entries(files)) write(fixture.dir, rel, content);
  return fixture;
}

async function withServer(page: Page, fixture: Fixture, body: (ctx: { fixture: Fixture; server: UiServer; base: string }) => Promise<void>) {
  let server: UiServer | null = null;
  try {
    server = await startServer(fixture);
    await page.goto(server.bootstrapUrl);
    // The bootstrap page redirects to the application, which opens on the overview; these specs start from the Tools tab.
    await page.waitForURL((url) => !url.pathname.startsWith("/session"));
    await page.goto(page.url().split("#")[0] + "#/tools");
    await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();
    await body({ fixture, server, base: page.url().split("#")[0] as string });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

const toolsYml = (fixture: Fixture): any => parseYaml(fs.readFileSync(path.join(fixture.dir, ".jgates", "tools.yml"), "utf8"));

const ESLINT_WEB = `schemaVersion: 1
tools:
  eslint-web:
    adapter: eslint
    component: web
    config: web/eslint.config.js
`;

test("a second ESLint instance for another component is written to tools.yml and both appear with their files", async ({ page }) => {
  const fixture = createToolsFixture(ESLINT_WEB, { "web/eslint.config.js": ESLINT_CONFIG, "ui/eslint.config.js": ESLINT_CONFIG });
  await withServer(page, fixture, async () => {
    await expect(page.locator('[data-instance="eslint-web"]')).toContainText("web/eslint.config.js");

    // The catalog filters: by language/tool text and by category.
    await page.getByLabel("Buscar ferramenta ou linguagem").fill("eslint");
    await expect(page.getByTestId("catalog-card")).toHaveCount(1);
    await page.getByLabel("Buscar ferramenta ou linguagem").fill("");
    await expect(page.getByTestId("catalog-card").first()).toBeVisible();

    await page.getByRole("button", { name: "Nova instância", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Ferramenta").selectOption({ label: "ESLint" });
    await dialog.getByLabel("Componente").selectOption("ui");
    await expect(dialog.getByLabel("Nome da instância")).toHaveValue("eslint-ui");
    await dialog.getByRole("button", { name: "Criar instância" }).click();
    await expect(page.getByTestId("tools-notice")).toContainText("eslint-ui");

    // Written to tools.yml, the first instance untouched.
    const tools = toolsYml(fixture).tools;
    expect(tools["eslint-ui"]).toEqual({ adapter: "eslint", component: "ui", config: "ui/eslint.config.js" });
    expect(tools["eslint-web"]).toEqual({ adapter: "eslint", component: "web", config: "web/eslint.config.js" });
    // Both are listed with their own file.
    await expect(page.locator('[data-instance="eslint-web"]')).toContainText("web/eslint.config.js");
    await expect(page.locator('[data-instance="eslint-ui"]')).toContainText("ui/eslint.config.js");

    // Rename and remove write tools.yml too.
    await page.getByRole("button", { name: "Renomear eslint-ui" }).click();
    await page.getByRole("dialog").getByLabel("Nome da instância").fill("eslint-interface");
    await page.getByRole("dialog").getByRole("button", { name: "Renomear", exact: true }).click();
    await expect(page.locator('[data-instance="eslint-interface"]')).toContainText("ui/eslint.config.js");
    expect(Object.keys(toolsYml(fixture).tools).sort()).toEqual(["eslint-interface", "eslint-web"]);
    await page.getByRole("button", { name: "Remover eslint-interface" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remover instância" }).click();
    await expect(page.locator('[data-instance="eslint-interface"]')).toHaveCount(0);
    expect(Object.keys(toolsYml(fixture).tools)).toEqual(["eslint-web"]);
    // The file of the removed instance is still there.
    expect(fs.existsSync(path.join(fixture.dir, "ui", "eslint.config.js"))).toBe(true);
  });
});

test("a creation that does not create the file: the instance is listed with the file missing, nothing is written", async ({ page }) => {
  const fixture = createToolsFixture(ESLINT_WEB, { "web/eslint.config.js": ESLINT_CONFIG });
  await withServer(page, fixture, async () => {
    await page.getByRole("button", { name: "Criar instância de ESLint" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Componente").selectOption("ui");
    await dialog.getByRole("button", { name: "Criar instância" }).click();
    await expect(page.locator('[data-instance="eslint-ui"]')).toContainText("ui/eslint.config.js");
    expect(fs.existsSync(path.join(fixture.dir, "ui", "eslint.config.js"))).toBe(false);
  });
});

test("a missing configuration file is not created by opening the area; Criar com template shows the diff first", async ({ page }) => {
  const fixture = createToolsFixture(`schemaVersion: 1\ntools:\n  eslint-ui:\n    adapter: eslint\n    component: ui\n    config: ui/eslint.config.js\n`);
  await withServer(page, fixture, async ({ base }) => {
    const file = path.join(fixture.dir, "ui", "eslint.config.js");
    await page.goto(`${base}#/tools/eslint-ui`);
    await page.getByRole("button", { name: /ui\/eslint\.config\.js/ }).click();
    await expect(page.getByTestId("doc-missing")).toBeVisible();
    expect(fs.existsSync(file)).toBe(false);

    await page.getByRole("button", { name: "Criar com template" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".diff-line.add", { hasText: "export default" })).toHaveCount(1);
    // The diff is only a preview: the file does not exist yet.
    expect(fs.existsSync(file)).toBe(false);

    await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByText(/Arquivo salvo\. Nova revisão/)).toBeVisible();
    expect(fs.readFileSync(file, "utf8")).toContain("export default");
  });
});

test("Selecionar arquivo points the binding at another file without creating it", async ({ page }) => {
  const fixture = createToolsFixture(`schemaVersion: 1\ntools:\n  eslint-ui:\n    adapter: eslint\n    component: ui\n    config: ui/eslint.config.js\n`, { "ui/lint/eslint.config.mjs": ESLINT_CONFIG });
  await withServer(page, fixture, async ({ base }) => {
    await page.goto(`${base}#/tools/eslint-ui`);
    await page.getByRole("button", { name: /ui\/eslint\.config\.js/ }).click();
    await page.getByRole("button", { name: "Selecionar arquivo" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Caminho do arquivo no workspace").fill("../outside.js");
    await dialog.getByRole("button", { name: "Usar este arquivo" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    expect(toolsYml(fixture).tools["eslint-ui"].config).toBe("ui/eslint.config.js");
    await dialog.getByLabel("Caminho do arquivo no workspace").fill("ui/lint/eslint.config.mjs");
    await dialog.getByRole("button", { name: "Usar este arquivo" }).click();
    await expect(page.getByTestId("editor")).toBeVisible();
    await expect(page.locator(EDITOR)).toContainText("export default");
    expect(toolsYml(fixture).tools["eslint-ui"].config).toBe("ui/lint/eslint.config.mjs");
  });
});

test("a file of a package is read only with criar override local, which copies it into the project and changes the binding", async ({ page }) => {
  const packageConfig = "// shared lint rules\nexport default [];\n";
  const fixture = createToolsFixture(
    `schemaVersion: 1
externalRoots:
  - id: shared
    path: node_modules/@acme/lint-config
tools:
  eslint-shared:
    adapter: eslint
    component: ui
    config:
      root: shared
      path: eslint.config.js
`,
    { "node_modules/@acme/lint-config/eslint.config.js": packageConfig },
  );
  await withServer(page, fixture, async ({ base }) => {
    await page.goto(`${base}#/tools/eslint-shared`);
    await page.getByRole("button", { name: /eslint\.config\.js/ }).click();
    await expect(page.getByText("Do pacote", { exact: true })).toBeVisible();
    await expect(page.getByTestId("doc-override")).toBeVisible();
    // Read only: typing does not change anything.
    await expect(page.locator(EDITOR)).toContainText("shared lint rules");
    await expect(page.locator(EDITOR)).toHaveAttribute("contenteditable", "false");

    await page.getByRole("button", { name: "Criar override local" }).click();
    await expect(page.getByTestId("override-note")).toContainText("ui/eslint.config.js");

    // The copy is in the project, the original is untouched, the binding points at the copy.
    expect(fs.readFileSync(path.join(fixture.dir, "ui", "eslint.config.js"), "utf8")).toBe(packageConfig);
    expect(fs.readFileSync(path.join(fixture.dir, "node_modules/@acme/lint-config/eslint.config.js"), "utf8")).toBe(packageConfig);
    const binding = toolsYml(fixture).tools["eslint-shared"].config;
    expect(binding.path).toBe("ui/eslint.config.js");
    expect(binding.root).toBeUndefined();
    // The open document is now the editable copy.
    await expect(page.getByText("Editável", { exact: true })).toBeVisible();
    await expect(page.getByTestId("doc-override")).toHaveCount(0);
  });
});

test("the effective configuration of Ruff shows the origin of each value and is partial when there is an extend", async ({ page }) => {
  const fixture = createFixture();
  fs.writeFileSync(fixture.pyproject, `[tool.ruff]\nextend = "../base.toml"\nline-length = 100\n\n[tool.ruff.lint]\nselect = ["E", "F"]\n`);
  await withServer(page, fixture, async ({ base }) => {
    await page.goto(`${base}#/tools/ruff`);
    await page.getByRole("tab", { name: "Configuração efetiva" }).click();
    const eff = page.getByTestId("effective");
    await expect(eff).toContainText("Resolução parcial");
    await expect(page.locator('[data-reason="EXTEND_NOT_RESOLVED"]')).toContainText("extend");
    // A value of the file, with its line; a value of the tool default.
    await expect(eff.locator('[data-path="tool.ruff.line-length"]')).toContainText("pyproject.toml, linha 3");
    await expect(eff.locator('[data-path="tool.ruff.lint.select"]')).toContainText('["E","F"]');
    await expect(eff.locator('[data-origin="default"]').first()).toContainText("Padrão da ferramenta");
    // The flags of the command that win over the file.
    await expect(page.getByTestId("effective-prevailing")).toContainText("--config");

    // Without the extend the resolution is complete.
    fs.writeFileSync(fixture.pyproject, `[tool.ruff]\nline-length = 100\n`);
    await page.getByRole("tab", { name: "Opções" }).click();
    await page.getByRole("tab", { name: "Configuração efetiva" }).click();
    await expect(eff).toContainText("Resolução completa");
    await expect(page.locator('[data-reason="EXTEND_NOT_RESOLVED"]')).toHaveCount(0);
  });
});

test("the collapsed Execution shows the rendered command, the same one the plan has", async ({ page }) => {
  const fixture = createFixture();
  await withServer(page, fixture, async ({ base }) => {
    await page.goto(`${base}#/tools/ruff`);
    const panel = page.getByTestId("execution");
    await expect(panel).toBeVisible();
    // Collapsed: the command is not visible until the summary is opened.
    await expect(page.getByTestId("execution-command")).toBeHidden();
    await panel.locator("summary").click();
    const shown = ((await page.getByTestId("execution-command").textContent()) ?? "").trim();
    const shownCwd = ((await page.getByTestId("execution-cwd").textContent()) ?? "").trim();

    const planned = await page.evaluate(async () => {
      const session = await (await fetch("/api/session", { credentials: "same-origin" })).json();
      const response = await fetch("/api/plans", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", [session.csrfHeader]: session.csrfToken },
        body: "{}",
      });
      const json = await response.json();
      const item = (json.plan.groups.willRun as any[]).find((i) => i.tool === "ruff");
      return { executable: item.command.executable as string, args: item.command.args as string[], cwd: item.command.cwd as string };
    });
    expect(shown).toBe([planned.executable, ...planned.args].join(" "));
    expect(shown).toContain("check --config {workspace}/pyproject.toml --no-fix --output-format json");
    expect(shownCwd).toBe(planned.cwd);
    // The header carries the version and the availability.
    await expect(page.getByTestId("tool-header")).toContainText("Disponível");
    await expect(page.getByTestId("tool-version")).toHaveText(/^\d+\.\d+/);
  });
});

test("the Options tab comes before Files and is the default; it warns about a draft of the document", async ({ page }) => {
  const fixture = createFixture();
  await withServer(page, fixture, async ({ base }) => {
    await page.goto(`${base}#/tools/ruff`);
    const tabs = page.getByRole("tab");
    await expect(tabs.first()).toHaveText("Opções");
    expect(await tabs.allTextContents()).toEqual(["Opções", "Arquivos", "Configuração efetiva"]);
    await expect(page.getByRole("tab", { name: "Opções" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("form")).toBeVisible();
    await expect(page.getByTestId("options-draft")).toHaveCount(0);

    // Type in the Files tab: the draft is kept, and the Options tab says so.
    await page.getByRole("tab", { name: "Arquivos" }).click();
    await page.getByRole("button", { name: /pyproject\.toml/ }).first().click();
    await page.locator(EDITOR).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n# draft note");
    await expect(page.getByTestId("draft-state")).toHaveAttribute("data-state", "saved");
    await page.getByRole("tab", { name: "Opções" }).click();
    await expect(page.getByTestId("options-draft")).toContainText("rascunho");
    await page.getByTestId("options-draft").getByRole("button", { name: "Abrir o rascunho em Arquivos" }).click();
    await expect(page.getByRole("tab", { name: "Arquivos" })).toHaveAttribute("aria-selected", "true");
  });
});

test("Usar a versão salva is kept per draft version and survives a reload of the page", async ({ page }) => {
  const fixture = createFixture();
  await withServer(page, fixture, async ({ base }) => {
    const type = async (text: string) => {
      await page.locator(EDITOR).click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type(text);
      await expect(page.getByTestId("draft-state")).toHaveAttribute("data-state", "saved");
    };
    await page.goto(`${base}#/tools/ruff`);
    await page.getByRole("tab", { name: "Arquivos" }).click();
    await page.getByRole("button", { name: /pyproject\.toml/ }).first().click();
    await type('\nignore = ["F401"]');

    await page.goto(`${base}#/plan`);
    await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/, { timeout: 60_000 });
    const pending = page.getByTestId("pending-drafts");
    await expect(page.getByRole("button", { name: "Executar" })).toBeDisabled();
    await pending.getByRole("button", { name: "Usar a versão salva", exact: true }).click();
    await expect(pending).toContainText("Usará a versão salva.");
    await expect(page.getByRole("button", { name: "Executar" })).toBeEnabled();

    // Reload the page: the choice for this version of the draft is still there.
    await page.reload();
    await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/, { timeout: 60_000 });
    await expect(page.getByTestId("pending-drafts")).toContainText("Usará a versão salva.");
    await expect(page.getByRole("button", { name: "Executar" })).toBeEnabled();

    // Another edit is another version of the draft: the question comes back.
    await page.goto(`${base}#/tools/ruff`);
    await page.getByRole("tab", { name: "Arquivos" }).click();
    await page.getByRole("button", { name: /pyproject\.toml/ }).first().click();
    await expect(page.getByTestId("draft-restored")).toBeVisible();
    await type("\n# more");
    await page.goto(`${base}#/plan`);
    await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/, { timeout: 60_000 });
    await expect(page.getByTestId("pending-drafts")).not.toContainText("Usará a versão salva.");
    await expect(page.getByRole("button", { name: "Executar" })).toBeDisabled();
  });
});

test("Editor component: a key typed while the parent renders an older text is not lost", async ({ page }) => {
  const harness = path.resolve(here, "..", "..", "ui", "src", "screens", "tools", "harness");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-editor-harness-"));
  let server: http.Server | null = null;
  try {
    await build({
      root: harness,
      configFile: false,
      logLevel: "silent",
      plugins: [react()],
      build: { outDir: out, emptyOutDir: true, write: true, rollupOptions: { input: path.join(harness, "editor-harness.html") } },
    });
    const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? "/").split("?")[0] as string);
      const file = path.join(out, rel === "/" ? "editor-harness.html" : rel);
      if (!file.startsWith(out) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as { port: number };
    await page.goto(`http://127.0.0.1:${port}/editor-harness.html`);
    await expect(page.locator(EDITOR)).toBeVisible();

    // Keys come faster than the parent hands the text back (150 ms): the first renders carry "a", "ab"... while the
    // editor already holds more.
    await page.locator(EDITOR).click();
    await page.keyboard.type("abcdefghij", { delay: 30 });
    await expect(page.getByTestId("parent-value")).toHaveText("abcdefghij");
    await expect(page.locator(EDITOR)).toHaveText("abcdefghij");
    await expect(page.getByTestId("reported-count")).toHaveText("10");

    // A real replacement from the parent still reaches the editor.
    await page.getByRole("button", { name: "replace" }).click();
    await expect(page.locator(EDITOR)).toHaveText("replaced from outside");
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    fs.rmSync(out, { recursive: true, force: true });
  }
});
