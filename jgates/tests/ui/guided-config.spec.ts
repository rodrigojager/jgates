import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { expectNoKnownSetAsText } from "./free-text";
import { MAIN, createFixture, openApp, startServer, type Fixture, type UiServer } from "./support";

// Templates, architecture rules and Serviços as guided flows (PLAN-config-editing.md section 4): creating a template is a
// stepper (what it checks, where it applies, the command as an argument list, the review with the diff), a template can
// be edited and deleted, a file nobody references is offered with "Usar neste projeto"; Arquitetura proposes layers from
// the project's folders, writes .jgates/architecture.yml after a diff and edits a hand-written file without dropping
// its content. Serviços' own steps are checked in services.spec.ts.

const read = (file: string) => fs.readFileSync(file, "utf8");

const ARCHITECTURE = `# Regras de arquitetura do projeto (comentário que o patch precisa preservar).
schemaVersion: 1
architecture:
  layers:
    - id: domain
      paths: ["demo/domain/**"]
    - id: infrastructure
      paths: ["demo/infra/**"]
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

const EXTRA_TEMPLATE = `schemaVersion: 1
id: extra-check
label: Extra check
extends:
  - builtin:base
match:
  languages:
    - python
config:
  tools:
    extra-check-check:
      adapter: generic-command
      enabled: true
      capabilities:
        - lint
      command: echo
      args:
        - hi
      config:
        support: partial
        effects:
          readsCode: true
          writesOutputs: false
          mayChangeCode: false
          executesProjectCode: true
          usesNetwork: false
        evidence:
          kind: exit-code
`;

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

const touch = (fixture: Fixture, rel: string, text = "") => {
  const file = path.join(fixture.dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** The sample's layout: hello/domain and hello/infrastructure. */
const sampleFolders = (fixture: Fixture) => {
  touch(fixture, "hello/__init__.py");
  touch(fixture, "hello/domain/greeting.py", "def greet():\n    return 'hi'\n");
  touch(fixture, "hello/infrastructure/store.py", "VALUE = 1\n");
};

const validate = (fixture: Fixture) => {
  const r = spawnSync(process.execPath, [MAIN, "config", "validate", "--cwd", fixture.dir, "--json"], { env: fixture.env, encoding: "utf8", timeout: 120_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
};

async function noSidewaysScroll(page: Page, where: string): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(0);
}

test("creating a template is a stepper; a template can be edited and deleted", async ({ page }) => {
  await withServer(async ({ fixture, server }) => {
    const base = await openApp(page, server);
    await page.goto(`${base}#/config/templates`);
    await expect(page.getByRole("heading", { name: "Templates", exact: true, level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "Criar template" }).click();
    const wizard = page.getByTestId("template-wizard");
    const steps = wizard.getByRole("navigation", { name: "Etapas do template" });
    await expect(steps.locator("ol.stepper > li button")).toHaveText(["O que verifica", "Onde vale", "Comando", "Revisão"]);
    await expect(steps.locator('[aria-current="step"]')).toHaveAttribute("data-step", "purpose");

    // 1. What it checks: the capability is chosen by name from a select, never typed.
    expect(await page.locator("#cft-w-capability").evaluate((el) => el.tagName)).toBe("SELECT");
    const next = page.getByTestId("tpl-next");
    await expect(next).toBeDisabled();
    await wizard.getByLabel("Identificador do template").fill("go-service");
    await wizard.getByLabel("Nome (opcional)").fill("Go service");
    await expect(next).toBeDisabled();
    await page.locator("#cft-w-capability").selectOption("unit");
    await expect(next).toBeEnabled();
    await expect(steps.locator('button[data-step="command"]')).toBeEnabled();

    // The next step opens with the keyboard.
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(steps.locator('[aria-current="step"]')).toHaveAttribute("data-step", "match");

    // 2. Where it applies: language and framework are selects, chosen one at a time.
    expect(await page.locator("#cft-w-language").evaluate((el) => el.tagName)).toBe("SELECT");
    expect(await page.locator("#cft-w-framework").evaluate((el) => el.tagName)).toBe("SELECT");
    await page.locator("#cft-w-language").selectOption("go");
    await page.getByTestId("pick-language").getByRole("button", { name: "Adicionar" }).click();
    await expect(page.getByTestId("pick-language").locator("code")).toHaveText("go");
    await next.click();

    // 3. The command is an executable and an argument list: an argument with spaces and quotes stays one argument.
    await wizard.getByLabel("Executável").fill("go");
    const add = wizard.getByRole("button", { name: "Adicionar argumento" });
    await add.click();
    await add.click();
    await add.click();
    await wizard.getByLabel("Argumento 1", { exact: true }).fill("test");
    await wizard.getByLabel("Argumento 2", { exact: true }).fill("-run");
    await wizard.getByLabel("Argumento 3", { exact: true }).fill('^Test(A|B)$ "x y"');
    await expect(page.getByTestId("command-vector")).toContainText(JSON.stringify(["go", "test", "-run", '^Test(A|B)$ "x y"']));
    await wizard.getByLabel("Contrato de evidência").selectOption("go-test");
    expect(await expectNoKnownSetAsText(page, '[data-testid="template-wizard"]', "template command step")).toBeGreaterThan(0);
    await next.click();

    // 4. Review: the diff of every file that changes, and nothing written yet.
    const review = page.getByTestId("template-review");
    await expect(review).toBeVisible();
    await expect(review.locator('[data-file=".jgates/templates/go-service.yml"]')).toContainText("adapter: generic-command");
    await expect(review.locator('[data-file="jgates.yml"]')).toContainText("source: .jgates/templates/go-service.yml");
    expect(fs.existsSync(path.join(fixture.dir, ".jgates", "templates", "go-service.yml"))).toBe(false);
    await page.getByTestId("tpl-save").click();

    const row = page.locator('[data-template="go-service"]');
    await expect(row).toBeVisible();
    await expect(row.getByTestId("tpl-badge")).toHaveText("Sem correspondência");
    const file = path.join(fixture.dir, ".jgates", "templates", "go-service.yml");
    const created = parseYaml(read(file)) as any;
    expect(created.config.tools["go-service-check"].command).toBe("go");
    expect(created.config.tools["go-service-check"].args).toEqual(["test", "-run", '^Test(A|B)$ "x y"']);
    expect(created.match).toEqual({ languages: ["go"] });
    expect(created.config.tools["go-service-check"].config.evidence).toEqual({ kind: "test-runner", runner: "go-test" });
    expect(read(path.join(fixture.dir, "jgates.yml"))).toContain("source: .jgates/templates/go-service.yml");
    validate(fixture);

    // Edit: the same steps, filled from the file; what the person wrote by hand stays.
    fs.appendFileSync(file, "# a note written by hand\n");
    await row.getByRole("button", { name: "Editar o template Go service" }).click();
    await expect(wizard.getByLabel("Identificador do template")).toBeDisabled();
    await expect(wizard.getByLabel("Nome (opcional)")).toHaveValue("Go service");
    await steps.locator('button[data-step="command"]').click();
    await expect(wizard.getByLabel("Executável")).toHaveValue("go");
    await expect(wizard.getByLabel("Argumento 3", { exact: true })).toHaveValue('^Test(A|B)$ "x y"');
    await wizard.getByLabel("Argumento 1", { exact: true }).fill("vet");
    await steps.locator('button[data-step="review"]').click();
    await expect(page.getByTestId("template-review").locator(".diff-line.add")).not.toHaveCount(0);
    await page.getByTestId("tpl-save").click();
    await expect(page.getByTestId("template-wizard")).toHaveCount(0);
    const edited = read(file);
    expect(edited).toContain("# a note written by hand");
    expect((parseYaml(edited) as any).config.tools["go-service-check"].args).toEqual(["vet", "-run", '^Test(A|B)$ "x y"']);
    validate(fixture);

    // Delete: asks first, then removes the entry and the file.
    await row.getByRole("button", { name: "Apagar o template Go service" }).click();
    await expect(page.getByTestId("delete-template")).toBeVisible();
    await page.getByRole("button", { name: "Cancelar" }).click();
    expect(fs.existsSync(file)).toBe(true);
    await row.getByRole("button", { name: "Apagar o template Go service" }).click();
    await page.getByRole("button", { name: "Apagar template" }).click();
    await expect(page.locator('[data-template="go-service"]')).toHaveCount(0);
    expect(fs.existsSync(file)).toBe(false);
    expect(read(path.join(fixture.dir, "jgates.yml"))).not.toContain("go-service");
    validate(fixture);
  });
});

test("a template file that jgates.yml does not reference is listed with 'Usar neste projeto'", async ({ page }) => {
  await withServer(
    async ({ fixture, server }) => {
      const base = await openApp(page, server);
      await page.goto(`${base}#/config/templates`);
      const row = page.locator('[data-template="extra-check"]');
      await expect(row).toBeVisible();
      await expect(row).toContainText("Fora do jgates.yml");
      expect(read(path.join(fixture.dir, "jgates.yml"))).not.toContain("extra-check");
      await row.getByRole("button", { name: "Usar o template Extra check neste projeto" }).click();
      await expect(row.getByRole("button", { name: /Usar o template/ })).toHaveCount(0);
      await expect(row).not.toContainText("Fora do jgates.yml");
      await expect(row.getByTestId("tpl-badge")).toHaveText(/^1 componente$/);
      expect(read(path.join(fixture.dir, "jgates.yml"))).toContain("source: .jgates/templates/extra-check.yml");
      validate(fixture);
    },
    (fixture) => touch(fixture, ".jgates/templates/extra-check.yml", EXTRA_TEMPLATE),
  );
});

test("Arquitetura proposes the layers of the folders, writes the file after a diff and the screen shows the rule", async ({ page }) => {
  await withServer(
    async ({ fixture, server }) => {
      const file = path.join(fixture.dir, ".jgates", "architecture.yml");
      expect(fs.existsSync(file)).toBe(false);
      const base = await openApp(page, server);
      await page.goto(`${base}#/config/architecture`);
      await page.getByRole("button", { name: "Criar regras de arquitetura" }).click();
      const editor = page.getByTestId("architecture-editor");
      await expect(editor).toBeVisible();

      // Layers proposed from the folders of the project.
      await expect(editor.locator('[data-edit-layer="domain"]')).toContainText("hello/domain/**");
      await expect(editor.locator('[data-edit-layer="infrastructure"]')).toContainText("hello/infrastructure/**");
      await expect(editor.locator('[data-edit-layer="domain"] input[type="checkbox"]')).toBeChecked();
      // Keyboard: the dialog closes with Escape and opens again from the same button.
      await page.keyboard.press("Escape");
      await expect(editor).toHaveCount(0);
      await page.getByRole("button", { name: "Criar regras de arquitetura" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("architecture-editor")).toBeVisible();

      // Rules proposed from the layers: the domain must not import the infrastructure.
      await page.getByTestId("arch-next").click();
      const rule = editor.locator('[data-edit-rule="domain-not-infrastructure"]');
      await expect(rule).toContainText("domain não pode importar infrastructure");
      await expect(rule.locator('input[type="checkbox"]').first()).toBeChecked();
      await page.getByTestId("arch-next").click();

      // The diff, and nothing written before the confirmation.
      const review = page.getByTestId("architecture-review");
      await expect(review).toContainText("hello/domain/**");
      await expect(review).toContainText("domain-not-infrastructure");
      expect(fs.existsSync(file)).toBe(false);
      await page.getByTestId("arch-save").click();
      await expect(page.getByTestId("architecture-editor")).toHaveCount(0);

      const written = parseYaml(read(file)) as any;
      expect(written.architecture.layers).toEqual([
        { id: "domain", paths: ["hello/domain/**"] },
        { id: "infrastructure", paths: ["hello/infrastructure/**"] },
      ]);
      expect(written.architecture.rules).toEqual([{ id: "domain-not-infrastructure", kind: "forbidden-dependency", from: "domain", to: ["infrastructure"], blocking: true }]);
      await expect(page.locator('[data-rule="domain-not-infrastructure"]')).toBeVisible();
      await expect(page.getByTestId("arch-map")).toContainText("domain");
      validate(fixture);
    },
    sampleFolders,
  );
});

test("Arquitetura edits a hand-written file without dropping its content", async ({ page }) => {
  await withServer(
    async ({ fixture, server }) => {
      const file = path.join(fixture.dir, ".jgates", "architecture.yml");
      const base = await openApp(page, server);
      await page.goto(`${base}#/config/architecture`);
      await page.getByTestId("edit-guided").click();
      const editor = page.getByTestId("architecture-editor");
      // The layers of the file are there, ticked; the folder the file does not know is proposed.
      await expect(editor.locator('[data-edit-layer="domain"]')).toContainText("demo/domain/**");
      await expect(editor.locator('[data-edit-layer="presentation"]')).toContainText("demo/presentation/**");
      await page.getByTestId("arch-next").click();
      await expect(editor.locator('[data-edit-rule="domain-independent"]')).toBeVisible();
      await expect(editor.locator('[data-edit-rule="domain-not-presentation"]')).toContainText("(proposta)");
      // The pair the file already forbids is not proposed again.
      await expect(editor.locator('[data-edit-rule="domain-not-infrastructure"]')).toHaveCount(0);
      await page.getByTestId("arch-next").click();
      const review = page.getByTestId("architecture-review");
      await expect(review).toContainText("presentation");
      // Only the spacing of two flow lists changes; no line of content is removed.
      for (const line of await review.locator(".diff-line.del").allInnerTexts()) expect(line).toContain("[");
      await page.getByTestId("arch-save").click();
      await expect(page.locator('[data-rule="domain-not-presentation"]')).toBeVisible();

      const after = read(file);
      // Every line is still there, except that the codec respaces the flow lists it rewrites.
      const norm = (line: string) => line.replace(/\[\s*/g, "[").replace(/\s*\]/g, "]");
      for (const line of ARCHITECTURE.split("\n").filter(Boolean)) expect(after.split("\n").map(norm), `the line "${line}" was dropped`).toContain(norm(line));
      const parsed = parseYaml(after) as any;
      expect(parsed.architecture.layers.map((l: any) => l.id)).toEqual(["domain", "infrastructure", "presentation"]);
      expect(parsed.architecture.rules.map((r: any) => r.id)).toEqual(["domain-independent", "domain-not-presentation"]);
      expect(parsed.architecture.rules[0].owner).toBe("generated");
      validate(fixture);

      // Unticking a proposal and a known rule: the diff removes exactly that rule.
      await page.getByTestId("edit-guided").click();
      await page.getByTestId("arch-next").click();
      await editor.locator('[data-edit-rule="domain-not-presentation"] input[type="checkbox"]').first().uncheck();
      await page.getByTestId("arch-next").click();
      await expect(page.getByTestId("architecture-review").locator(".diff-line.del")).not.toHaveCount(0);
      await page.getByTestId("arch-save").click();
      await expect(page.locator('[data-rule="domain-not-presentation"]')).toHaveCount(0);
      expect((parseYaml(read(file)) as any).architecture.rules.map((r: any) => r.id)).toEqual(["domain-independent"]);
      expect(read(file)).toContain("# Regras de arquitetura do projeto");
    },
    (fixture) => {
      touch(fixture, ".jgates/architecture.yml", ARCHITECTURE);
      touch(fixture, "demo/domain/model.py", "X = 1\n");
      touch(fixture, "demo/infra/db.py", "Y = 1\n");
      touch(fixture, "demo/presentation/web.py", "Z = 1\n");
    },
  );
});

test("the guided flows work at 375 px and in English, with no free text where the values are known", async ({ page }) => {
  await withServer(
    async ({ server }) => {
      await page.setViewportSize({ width: 375, height: 800 });
      const base = await openApp(page, server);

      await page.goto(`${base}#/config/templates`);
      await page.getByRole("button", { name: "Create template" }).click();
      const wizard = page.getByTestId("template-wizard");
      await expect(wizard.getByRole("navigation", { name: "Template steps" })).toBeVisible();
      await wizard.getByLabel("Template identifier").fill("tiny-check");
      await page.locator("#cft-w-capability").selectOption("lint");
      await noSidewaysScroll(page, "template step 1");
      expect(await expectNoKnownSetAsText(page, '[data-testid="template-wizard"]', "template step 1 (en)")).toBeGreaterThan(0);
      await page.getByTestId("tpl-next").click();
      await page.getByTestId("tpl-next").click();
      await wizard.getByLabel("Executable").fill("echo");
      await wizard.getByRole("button", { name: "Add argument" }).click();
      await noSidewaysScroll(page, "template command step");
      expect(await expectNoKnownSetAsText(page, '[data-testid="template-wizard"]', "template command step (en)")).toBeGreaterThan(0);
      await wizard.getByLabel("Argument 1", { exact: true }).fill("hello");
      await page.getByTestId("tpl-next").click();
      await expect(page.getByTestId("template-review")).toContainText("tiny-check");
      await noSidewaysScroll(page, "template review");
      await page.getByRole("button", { name: "Cancel" }).click();

      await page.goto(`${base}#/config/architecture`);
      await page.getByRole("button", { name: "Create architecture rules" }).click();
      const editor = page.getByTestId("architecture-editor");
      await expect(editor.locator('[data-edit-layer="domain"]')).toBeVisible();
      await noSidewaysScroll(page, "architecture layers");
      expect(await expectNoKnownSetAsText(page, '[data-testid="architecture-editor"]', "architecture layers (en)")).toBeGreaterThan(0);
      await page.getByTestId("arch-next").click();
      await expect(editor.locator('[data-edit-rule="domain-not-infrastructure"]')).toContainText("domain must not import infrastructure");
      await noSidewaysScroll(page, "architecture rules");
    },
    (fixture) => {
      sampleFolders(fixture);
      fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language: "en" }, null, 2)}\n`, { mode: 0o600 });
    },
  );
});
