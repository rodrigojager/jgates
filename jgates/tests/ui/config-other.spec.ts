import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAIN, createFixture, startServer, type Fixture, type UiServer } from "./support";

// Configuração > Templates, Arquitetura, Execução e YAML. Every control writes into the real file by patch, the
// next plan shows the change, a wrong key is reported with file and field and the draft stays, and the governed mode
// locks the fields with the reason.

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

const read = (file: string) => fs.readFileSync(file, "utf8");

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

/** Entry of the application is the Visão geral: the tab is reached through the Configuração area, like a person would. */
async function openTab(page: Page, server: UiServer, tab: string, heading: string): Promise<void> {
  await page.goto(server.bootstrapUrl);
  await page.getByRole("link", { name: "Configuração" }).first().click();
  await page.getByRole("link", { name: tab, exact: true }).click();
  await expect(page.getByRole("heading", { name: heading, exact: true, level: 1 })).toBeVisible();
}

function plan(fixture: Fixture): Record<string, any> {
  const r = spawnSync(process.execPath, [MAIN, "plan", "--cwd", fixture.dir, "--json"], { env: fixture.env, encoding: "utf8", timeout: 120_000 });
  expect(r.stderr === "" || r.status !== null, r.stderr).toBeTruthy();
  return JSON.parse(r.stdout).plan;
}

test("creating a template writes it into .jgates/templates/ from the model and the list shows the badge", async ({ page }) => {
  await withServer(async ({ fixture, server }) => {
    await openTab(page, server, "Templates", "Templates");
    await expect(page.locator('[data-template="base"]')).toHaveAttribute("data-badge", "required");

    // A stack the project does not have: no component matches.
    await page.getByRole("button", { name: "Criar template" }).click();
    await page.getByLabel("Identificador do template").fill("go-service");
    await page.getByLabel("Linguagens que ele casa").fill("go");
    await page.getByLabel("Comando (executável e argumentos)").fill("go test ./...");
    await expect(page.getByTestId("command-vector")).toContainText('["go","test","./..."]');
    await page.getByLabel("Contrato de evidência").selectOption("go-test");
    await page.getByRole("button", { name: "Criar", exact: true }).click();

    const none = page.locator('[data-template="go-service"]');
    await expect(none).toBeVisible();
    await expect(none.getByTestId("tpl-badge")).toHaveText("Sem correspondência");

    const file = path.join(fixture.dir, ".jgates", "templates", "go-service.yml");
    const text = read(file);
    expect(text).toContain("extends:");
    expect(text).toContain("builtin:base");
    expect(text).toContain("adapter: generic-command");
    expect(text).toMatch(/args:\n\s+- test\n\s+- \.\/\.\.\./);
    expect(text).toContain("runner: go-test");
    expect(read(path.join(fixture.dir, "jgates.yml"))).toContain("source: .jgates/templates/go-service.yml");

    // A stack the project has: its component matches, and the count shows.
    await page.getByRole("button", { name: "Criar template" }).click();
    await page.getByLabel("Identificador do template").fill("py-extra");
    await page.getByLabel("Linguagens que ele casa").fill("python");
    await page.getByLabel("Comando (executável e argumentos)").fill("python -m compileall demo");
    await page.getByRole("button", { name: "Criar", exact: true }).click();
    await expect(page.locator('[data-template="py-extra"]').getByTestId("tpl-badge")).toHaveText(/^1 componente$/);

    // The files are valid configuration and the project still resolves.
    const resolved = spawnSync(process.execPath, [MAIN, "config", "validate", "--cwd", fixture.dir, "--json"], { env: fixture.env, encoding: "utf8" });
    expect(resolved.status, resolved.stdout + resolved.stderr).toBe(0);

    // The detail shows the application and the inheritance, field by field.
    await page.getByRole("button", { name: "Ver os detalhes do template py-extra" }).click();
    await expect(page.getByTestId("application")).toHaveText("Quando a stack for detectada");
    await expect(page.getByTestId("extends")).toHaveText("builtin:base");
    await expect(page.getByText("Herança, campo a campo")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

test("turning off domain-independent writes enabled false by patch and the next plan shows it with the origin", async ({ page }) => {
  await withServer(
    async ({ fixture, server }) => {
      const file = path.join(fixture.dir, ".jgates", "architecture.yml");
      await openTab(page, server, "Arquitetura", "Arquitetura");
      const rule = page.locator('[data-rule="domain-independent"]');
      await expect(rule.getByText("Bloqueia")).toBeVisible();
      await expect(rule.getByText("Dono: gerada")).toBeVisible();
      await expect(page.getByTestId("arch-map")).toContainText("domain");
      expect(plan(fixture).architecture.rules[0].enabled).toBe(true);

      const before = read(file);
      await page.getByTestId("toggle-domain-independent").click();
      await expect(rule).toHaveAttribute("data-enabled", "false");
      await expect(rule.getByText("Desativada", { exact: true })).toBeVisible();

      const after = read(file);
      // A patch: only the value changed, the comment and the other lines are the ones that were there.
      expect(after).toBe(before.replace("enabled: true", "enabled: false"));

      const next = plan(fixture);
      expect(next.architecture.rules).toEqual([expect.objectContaining({ id: "domain-independent", enabled: false, origin: { file: ".jgates/architecture.yml", path: "architecture.rules[0].enabled" } })]);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    },
    (fixture) => fs.writeFileSync(path.join(fixture.dir, ".jgates", "architecture.yml"), ARCHITECTURE),
  );
});

test("the Execução tab changes execution.network in jgates.yml and the next plan shows the network", async ({ page }) => {
  await withServer(async ({ fixture, server }) => {
    expect(plan(fixture).network.policy).toBe("explicit");
    await openTab(page, server, "Execução", "Execução");
    const root = path.join(fixture.dir, "jgates.yml");
    const before = read(root);

    await page.getByLabel("Rede", { exact: true }).selectOption("deny");
    await page.getByRole("button", { name: "Salvar Rede" }).click();
    await expect(page.getByText("Rede salvo em jgates.yml.")).toBeVisible();
    await expect(page.locator('[data-field="network"]').getByTestId("origin-save")).toContainText("jgates.yml");

    const after = read(root);
    expect(after).toMatch(/^execution:\n {2}network: deny$/m);
    expect(after).toContain(before.trimEnd());
    expect(plan(fixture).network.policy).toBe("deny");

    // Back to the inherited value removes the key.
    await page.getByRole("button", { name: "Voltar ao herdado: Rede" }).click();
    await expect(page.locator('[data-field="network"] select')).toHaveValue("explicit");
    expect(plan(fixture).network.policy).toBe("explicit");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

test("an unknown key in the YAML tab shows the file and the field on 'Checar estrutura' and the draft is kept", async ({ page }) => {
  await withServer(async ({ fixture, server }) => {
    await openTab(page, server, "YAML", "Arquivos YAML");
    const root = path.join(fixture.dir, "jgates.yml");
    const original = read(root);
    await page.locator('[data-file="jgates.yml"]').first().click();
    await expect(page.getByTestId("yaml-pane")).toHaveAttribute("data-file", "jgates.yml");

    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\nnetwork_typo: true\n");
    await expect(page.getByTestId("yaml-state")).toHaveText("Alterações não salvas");

    await page.getByRole("button", { name: "Checar estrutura" }).click();
    const errors = page.getByTestId("check-errors");
    await expect(errors).toBeVisible();
    await expect(errors.getByTestId("diag-file").first()).toHaveText("jgates.yml");
    await expect(errors.getByTestId("diag-path").first()).toContainText("network_typo");
    expect(read(root)).toBe(original);

    // Saving the wrong text is refused and nothing is written.
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "não foi salvo" })).toBeVisible();
    expect(read(root)).toBe(original);

    // The draft survives leaving the screen: it is kept outside the project.
    await expect.poll(() => fs.readdirSync(path.join(fixture.home, "workspaces")).flatMap((w) => fs.readdirSync(path.join(fixture.home, "workspaces", w, "drafts")).filter((n) => n.startsWith("config-"))).length).toBe(1);
    await page.reload();
    await page.getByRole("link", { name: "Configuração" }).first().click();
    await page.getByRole("link", { name: "YAML", exact: true }).click();
    await expect(page.getByTestId("draft-note")).toBeVisible();
    await expect(page.locator(".cm-content")).toContainText("network_typo: true");
    await expect(page.locator('[data-file="jgates.yml"]').first()).toContainText("Rascunho");

    // Discarding brings back the saved text.
    await page.getByRole("button", { name: "Descartar alterações" }).click();
    await expect(page.locator(".cm-content")).not.toContainText("network_typo");
    expect(read(root)).toBe(original);
    // The comment color of the shared editor (Editor.tsx) is out of this screen's reach.
    expect((await new AxeBuilder({ page }).exclude(".editor-host").analyze()).violations).toEqual([]);
  });
});

test("a valid edit in the YAML tab saves with the revision and a changed file is refused with a conflict", async ({ page }) => {
  await withServer(async ({ fixture, server }) => {
    await openTab(page, server, "YAML", "Arquivos YAML");
    const root = path.join(fixture.dir, "jgates.yml");
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("execution:\n  concurrency: 2\n");
    await page.getByRole("button", { name: "Checar estrutura" }).click();
    await expect(page.getByTestId("check-ok")).toBeVisible();

    // Another writer changes the file between the opening and the save.
    fs.appendFileSync(root, "# alterado por fora\n");
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByTestId("yaml-state")).toHaveText("Conflito");
    expect(read(root)).not.toContain("concurrency: 2");
  });
});

test("the governed mode shows the fields locked with the reason in the four tabs", async ({ page }) => {
  const fixture = createFixture();
  fixture.env.JGATES_POLICY_DIR = "/etc/policies/company-policy";
  fixture.env.JGATES_POLICY_SHA256 = "a".repeat(64);
  fs.writeFileSync(path.join(fixture.dir, ".jgates", "architecture.yml"), ARCHITECTURE);
  const server = await startServer(fixture);
  try {
    await openTab(page, server, "Execução", "Execução");
    await expect(page.getByTestId("governed-note")).toContainText("company-policy");
    await expect(page.locator('[data-field="network"] [data-locked="true"]')).toContainText("fixada pela política");
    await expect(page.locator("main select")).toHaveCount(0);

    await page.getByRole("link", { name: "Arquitetura", exact: true }).click();
    await expect(page.getByTestId("toggle-domain-independent")).toBeDisabled();
    await expect(page.locator('[data-rule="domain-independent"]')).toContainText("Modo governado");

    await page.getByRole("link", { name: "Templates", exact: true }).click();
    await expect(page.getByRole("button", { name: "Criar template" })).toBeDisabled();
    await expect(page.getByRole("switch", { name: "Usar o template base" })).toBeDisabled();
    await expect(page.locator('[data-template="base"]')).toContainText("Modo governado");

    await page.getByRole("link", { name: "YAML", exact: true }).click();
    await expect(page.getByTestId("governed-note")).toContainText("só lê");
    await expect(page.getByRole("button", { name: "Salvar", exact: true })).toBeDisabled();

    // The server refuses the write too, whatever the screen does.
    const status = await page.evaluate(async () => {
      const session = await (await fetch("/api/session", { credentials: "same-origin" })).json();
      const r = await fetch("/api/config/execution", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json", [session.csrfHeader]: session.csrfToken }, body: JSON.stringify({ expectedRevision: "0".repeat(64), changes: { network: "allow" } }) });
      return r.status;
    });
    expect(status).toBe(403);
    expect(read(path.join(fixture.dir, "jgates.yml"))).not.toContain("network: allow");
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
