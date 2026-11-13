import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { expectNoKnownSetAsText } from "./free-text";
import { createFixture, openApp, startServer, type Fixture, type UiServer } from "./support";

// Perfil and Política edited through the derived forms (PLAN-config-editing.md section 4):
//   - creating a profile asks for its name and derives the id; name and description stay editable; intensity, scope,
//     gates and the selectors pii:, architecture: and component: have controls; "Editar" scrolls to the editor and names it;
//   - the category Verificações próprias lists the own tools (an x-custom: capability) with a control that writes
//     capability:x-custom:<name>, and offers "Adicionar ferramenta própria"; with none it explains why and offers the same;
//   - tool rows show catalogue names with the instance id as secondary text;
//   - Política edits a local policy file with the same form (created when missing) and is read-only under a governed policy;
//   - the free-text check, keyboard only, 375 px, pt-BR and en.

const OWN_TOOL = `  acme-lint:
    adapter: generic-command
    command: "true"
    capabilities: ["x-custom:acme-lint"]
    config:
      effects:
        readsCode: true
        writesOutputs: false
        mayChangeCode: false
        executesProjectCode: false
        usesNetwork: false
      evidence:
        kind: exit-code
  lint-py:
    adapter: ruff
    config: pyproject.toml
    capabilities: [lint]
`;

const ARCHITECTURE = `schemaVersion: 1
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

// A control that never shows up fails after 30 s with its name, not after the whole test timeout.
test.use({ actionTimeout: 30_000 });

// The field of the coverage minimum in the policy form (a rule key with a dot is written in brackets).
const THRESHOLD = `[data-field='rules["coverage.minimum"].threshold']`;

const read = (file: string) => fs.readFileSync(file, "utf8");
const profilesFile = (f: Fixture) => path.join(f.dir, ".jgates", "profiles.yml");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

async function withServer(run: (ctx: { fixture: Fixture; server: UiServer }) => Promise<void>, prepare?: (fixture: Fixture) => void, language: "pt-BR" | "en" = "pt-BR"): Promise<void> {
  const fixture = createFixture();
  let server: UiServer | null = null;
  try {
    fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language }, null, 2)}\n`, { mode: 0o600 });
    prepare?.(fixture);
    server = await startServer(fixture);
    await run({ fixture, server });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

const withOwnTool = (fixture: Fixture) => fs.appendFileSync(path.join(fixture.dir, ".jgates", "tools.yml"), OWN_TOOL);

async function openProfiles(page: Page, server: UiServer, heading = "Perfis do projeto"): Promise<void> {
  await page.goto(server.bootstrapUrl);
  await page.getByRole("link", { name: /^(Configuração|Configuration)$/ }).first().click();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
}

async function openPolicy(page: Page, server: UiServer): Promise<void> {
  const base = await openApp(page, server);
  await page.goto(`${base}#/policy`);
  await expect(page.getByRole("heading", { name: "Política de CI", level: 1 })).toBeVisible();
}

/** Presses Tab until the control has the focus (the keyboard path reaches it), never clicking. */
async function tabTo(page: Page, target: Locator, max = 250): Promise<void> {
  await expect(target).toBeVisible();
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`the keyboard never reached ${await target.evaluate((el) => el.outerHTML.slice(0, 200))}`);
}

const field = (page: Page, id: string) => page.locator(`[data-testid="profile-editor"] [data-field="${id}"]`).first();

test("creating a profile asks for the name and derives the id; name and description stay editable and the editor controls are there", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(async ({ fixture, server }) => {
    await openProfiles(page, server);
    await page.getByRole("button", { name: "Criar perfil" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Criar a partir de").selectOption("standard");
    // The name comes first; the identifier follows it (no accents, hyphens) until the person writes one.
    await dialog.getByLabel("Nome do perfil").fill("Revisão Rápida");
    await expect(dialog.getByLabel("Identificador do perfil")).toHaveValue("revisao-rapida");
    await dialog.getByLabel("Descrição (opcional)").fill("Para o dia a dia");
    await dialog.getByRole("button", { name: "Criar", exact: true }).click();

    const card = page.locator('[data-profile="revisao-rapida"][data-testid="profile-card"]');
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading", { name: "Revisão Rápida" })).toBeVisible();
    await expect(card).toContainText("Para o dia a dia");
    const created = read(profilesFile(fixture));
    expect(created).toMatch(/^ {2}revisao-rapida:\n {4}label: Revisão Rápida\n {4}description: Para o dia a dia\n {4}extends: standard$/m);

    // The editor opened on the new profile and names it.
    const editor = page.getByTestId("profile-editor");
    await expect(editor.getByRole("heading", { name: "Editando o perfil Revisão Rápida" })).toBeVisible();

    // Name and description are editable afterwards, one key at a time, after the diff.
    const label = field(page, "profiles.revisao-rapida.label");
    await label.getByRole("textbox").fill("Revisão Veloz");
    await label.getByRole("button", { name: /Revisar e salvar/ }).click();
    const review = page.getByRole("dialog");
    await expect(review.locator(".diff-line.add")).toContainText("label: Revisão Veloz");
    await review.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect.poll(() => read(profilesFile(fixture))).toContain("label: Revisão Veloz");
    await expect(card.getByRole("heading", { name: "Revisão Veloz" })).toBeVisible();

    const description = field(page, "profiles.revisao-rapida.description");
    await description.getByRole("textbox").fill("Só o essencial");
    await description.getByRole("button", { name: /Revisar e salvar/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true }).click();
    await expect.poll(() => read(profilesFile(fixture))).toContain("description: Só o essencial");
    expect(read(profilesFile(fixture))).toContain("extends: standard");

    // Intensity, scope and gates have controls too (set from the file when it has them, from the schema when it does not).
    for (const key of ["intensity", "scope", "gates", "extends"]) await expect(field(page, `profiles.revisao-rapida.${key}`), key).toBeVisible();
    await field(page, "profiles.revisao-rapida.scope").locator("select, input[type=radio]").first().waitFor();
    await expect(field(page, "profiles.revisao-rapida.gates").locator("input[type=checkbox]")).toHaveCount(2);
    // The checks are the tree below, not this form.
    await expect(editor.locator('[data-field*=".checks"]')).toHaveCount(0);

    await expectNoKnownSetAsText(page, '[data-testid="profile-editor"]', "profile editor");
  });
});

test("a scope chosen in the editor is written to the profile", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(async ({ fixture, server }) => {
    await openProfiles(page, server);
    await page.getByRole("button", { name: "Editar o perfil Rigoroso" }).click();
    const scope = field(page, "profiles.strict.scope");
    await expect(scope).toBeVisible();
    const radio = scope.getByRole("radio", { name: "full" });
    if (await radio.count()) await radio.check();
    else await scope.locator("select").selectOption("full");
    await scope.getByRole("button", { name: /Revisar e salvar/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true }).click();
    await expect.poll(() => read(profilesFile(fixture))).toMatch(/strict:[\s\S]*?scope: full/);
  });
});

test("Editar on a card scrolls to the editor and names it; pii:, architecture: and component: selectors have controls", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(
    async ({ fixture, server }) => {
      await openProfiles(page, server);
      await page.setViewportSize({ width: 1280, height: 500 });
      const button = page.getByRole("button", { name: "Editar o perfil Rigoroso" });
      await button.scrollIntoViewIfNeeded();
      await button.click();
      const heading = page.getByRole("heading", { name: "Editando o perfil Rigoroso" });
      await expect(heading).toBeVisible();
      await expect(heading).toBeFocused();
      await expect.poll(() => heading.evaluate((el) => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().top < window.innerHeight)).toBe(true);

      // Each kind of selector has its group with a switch per entity, rule or component.
      const selectors = page.getByTestId("selectors");
      for (const kind of ["pii", "architecture", "component"]) {
        const group = selectors.locator(`[data-selector-kind="${kind}"]`);
        await expect(group, kind).toBeVisible();
        await expect(group.locator(`[data-selector^="${kind}:"]`).first()).toBeVisible();
      }
      const rule = selectors.locator('[data-selector="architecture:domain-independent"]');
      await expect(rule.getByRole("switch")).toBeVisible();
      const before = read(profilesFile(fixture));
      await rule.getByRole("switch").click();
      await expect.poll(() => read(profilesFile(fixture))).not.toBe(before);
      expect(read(profilesFile(fixture))).toMatch(/strict:[\s\S]*?architecture:domain-independent:\n {8}enabled: false/);
    },
    (fixture) => fs.writeFileSync(path.join(fixture.dir, ".jgates", "architecture.yml"), ARCHITECTURE),
  );
});

test("Verificações próprias lists the own tool with a control that writes capability:x-custom:<name> and offers Adicionar ferramenta própria", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(
    async ({ fixture, server }) => {
      await openProfiles(page, server);
      await page.getByRole("button", { name: "Abrir a categoria Verificações próprias" }).click();
      const row = page.locator('[data-selector="capability:x-custom:acme-lint"]');
      await expect(row).toBeVisible();
      await expect(row.getByRole("combobox", { name: "acme-lint", exact: true })).toBeVisible();
      const before = read(profilesFile(fixture));
      await row.getByRole("combobox", { name: "acme-lint", exact: true }).selectOption("required");
      await expect(row).toHaveAttribute("data-mode", "required");
      await expect.poll(() => read(profilesFile(fixture))).not.toBe(before);
      expect(read(profilesFile(fixture))).toMatch(/capability:x-custom:acme-lint:\n {8}enabled: true/);
      // It survives a reload: the selector is accepted by the schema and by the engine.
      await page.reload();
      await page.getByRole("button", { name: "Abrir a categoria Verificações próprias" }).click();
      await expect(page.locator('[data-selector="capability:x-custom:acme-lint"]')).toHaveAttribute("data-mode", "required");
      await expect(page.getByTestId("category-custom")).toBeVisible();

      // The action opens the six-step dialog; Esc closes it.
      await page.getByTestId("add-own-tool").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Adicionar ferramenta própria" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    },
    withOwnTool,
  );
});

test("with no own tool the category explains why and offers the same action instead of 0 de 0", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(async ({ server }) => {
    await openProfiles(page, server);
    const category = page.locator('[data-category="custom"]');
    await expect(category).toContainText("ainda não tem ferramenta própria");
    await expect(category).not.toContainText("0 de 0");
    // Keyboard only: the action is reachable by Tab and opens the dialog with Enter.
    const add = category.getByRole("button", { name: "Adicionar ferramenta própria" });
    await tabTo(page, add);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Adicionar ferramenta própria" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(add).toBeFocused();
  });
});

test("tool rows show the catalogue name with the instance id as secondary text", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(
    async ({ server }) => {
      await openProfiles(page, server);
      await page.getByRole("button", { name: "Abrir a categoria Qualidade" }).click();
      await page.getByRole("button", { name: /^Ferramentas de Lint/ }).click();
      const tool = page.locator('[data-tool="lint-py"]');
      await expect(tool).toBeVisible();
      await expect(tool.locator("strong").first()).toHaveText("Ruff");
      await expect(tool.getByTestId("secondary-id").first()).toHaveText("lint-py");
      // The policy controls the engine does not apply yet are no longer on this screen.
      await expect(page.getByText("Quando bloquear a entrega?")).toHaveCount(0);
      await expect(page.getByTestId("policy-pointer").getByRole("link", { name: "Abrir Política" })).toHaveAttribute("href", "#/policy");
    },
    withOwnTool,
  );
});

test("the Perfil screen works at 375 px without horizontal scroll, has no accessibility violations and passes the free-text check", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(
    async ({ server }) => {
      await openProfiles(page, server);
      await page.setViewportSize({ width: 375, height: 800 });
      await page.getByRole("button", { name: "Abrir a categoria Verificações próprias" }).click();
      await page.getByRole("button", { name: "Criar perfil" }).click();
      await expectNoKnownSetAsText(page, '[role="dialog"]', "create profile dialog");
      await page.keyboard.press("Escape");
      await expectNoKnownSetAsText(page, "body", "Perfil");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    },
    withOwnTool,
  );
});

test("in English the editor, the own-tool category and the dialog are translated", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(
    async ({ server }) => {
      await openProfiles(page, server, "Project profiles");
      await page.getByRole("button", { name: "Create profile" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Profile name").fill("Fast review");
      await expect(dialog.getByLabel("Profile identifier")).toHaveValue("fast-review");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /^Edit the profile / }).first().click();
      await expect(page.getByRole("heading", { name: /^Editing the profile / })).toBeVisible();
      await page.getByRole("button", { name: "Open the category Your own checks" }).click();
      await expect(page.locator('[data-category="custom"]').getByRole("button", { name: "Add own tool" })).toBeVisible();
    },
    undefined,
    "en",
  );
});

test("Política: a local policy file is created when missing and edited with the same form", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(async ({ fixture, server }) => {
    const policy = path.join(fixture.dir, ".jgates", "policy.yml");
    fs.rmSync(policy, { force: true });
    await openPolicy(page, server);
    const rules = page.getByTestId("policy-rules");
    await expect(rules.getByRole("heading", { name: "Regras da política deste projeto" })).toBeVisible();
    await expect(rules.getByTestId("policy-missing")).toContainText(".jgates/policy.yml ainda não existe");
    expect(fs.existsSync(policy)).toBe(false);

    // Keyboard only: Tab reaches the button, Enter creates the file from its template.
    await tabTo(page, rules.getByTestId("policy-create"));
    await page.keyboard.press("Enter");
    await expect.poll(() => fs.existsSync(policy)).toBe(true);
    await expect(rules.getByTestId("derived-form")).toBeVisible();
    expect(read(policy)).toContain("schemaVersion: 1");

    // A rule written by hand shows with its control and is edited key by key.
    fs.writeFileSync(policy, "schemaVersion: 1\n# kept\nrules:\n  coverage.minimum:\n    threshold: 70\n");
    await page.reload();
    const threshold = page.locator(`[data-testid="policy-rules"] ${THRESHOLD}`).first();
    await expect(threshold).toBeVisible();
    await threshold.locator("input[type=number], select").first().fill("85");
    await threshold.getByRole("button", { name: /Revisar e salvar/ }).click();
    await expect(page.getByRole("dialog").locator(".diff-line.add")).toContainText("threshold: 85");
    await page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true }).click();
    await expect.poll(() => read(policy)).toContain("threshold: 85");
    expect(read(policy)).toContain("# kept");

    await expectNoKnownSetAsText(page, '[data-testid="policy-rules"]', "Política");
    await page.setViewportSize({ width: 375, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });
});

test("Política under a governed policy is read-only and says why", async ({ page }) => {
  test.setTimeout(240_000);
  const fixture = createFixture();
  fixture.env.JGATES_POLICY_DIR = "/etc/policies/company-policy";
  fixture.env.JGATES_POLICY_SHA256 = "b".repeat(64);
  fs.writeFileSync(path.join(fixture.dir, ".jgates", "policy.yml"), "schemaVersion: 1\nrules:\n  coverage.minimum:\n    threshold: 70\n");
  let server: UiServer | null = null;
  try {
    server = await startServer(fixture);
    await openPolicy(page, server);
    const rules = page.getByTestId("policy-rules");
    await expect(rules).toHaveAttribute("data-mode", "governed");
    await expect(rules.getByTestId("policy-readonly")).toContainText("company-policy");
    await expect(rules.getByTestId("policy-readonly")).toContainText("não mudam por aqui");
    await expect(rules.locator(THRESHOLD).first()).toBeVisible();
    await expect(rules.locator("input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role=switch]:not([disabled])")).toHaveCount(0);
    await expect(rules.getByRole("button", { name: /Revisar e salvar|Voltar ao herdado/ })).toHaveCount(0);
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
});
