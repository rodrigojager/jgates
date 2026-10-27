import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAIN, createFixture, sha256, startServer, type Fixture, type UiServer } from "./support";

// Configuração > Perfil. Profiles of .jgates/profiles.yml as cards, granular on/off written into the profile by
// patch, locks of the policy with the reason, and "why is this on?" with the chain of `config resolve --explain`.

const PROFILES = (f: Fixture) => path.join(f.dir, ".jgates", "profiles.yml");
const read = (file: string) => fs.readFileSync(file, "utf8");

async function open(page: Page, server: UiServer): Promise<void> {
  await page.goto(server.bootstrapUrl);
  await page.getByRole("link", { name: "Configuração" }).first().click();
  await expect(page.getByRole("heading", { name: "Perfis do projeto" })).toBeVisible();
}

async function withServer(run: (ctx: { fixture: Fixture; server: UiServer }) => Promise<void>): Promise<void> {
  const fixture = createFixture();
  let server: UiServer | null = null;
  try {
    server = await startServer(fixture);
    await run({ fixture, server });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

function explain(fixture: Fixture, profile: string): Record<string, any> {
  const r = spawnSync(process.execPath, [MAIN, "config", "resolve", "--cwd", fixture.dir, "--profile", profile, "--explain", "--json"], { env: fixture.env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

test("creating a profile from standard writes it into profiles.yml by patch and the new card appears", async ({ page }) => {
  await withServer(async ({ fixture, server }) => {
    await open(page, server);
    const before = read(PROFILES(fixture));
    await expect(page.locator('[data-testid="profile-card"]')).toHaveCount(3);

    await page.getByRole("button", { name: "Criar perfil" }).click();
    await page.getByLabel("Criar a partir de").selectOption("standard");
    await page.getByLabel("Identificador do perfil").fill("rapido");
    await page.getByRole("button", { name: "Criar", exact: true }).click();

    const card = page.locator('[data-profile="rapido"]');
    await expect(card).toBeVisible();
    await expect(card.getByTestId("extends")).toHaveText("standard");
    await expect(card.getByTestId("estimate")).toHaveText("não estimado");

    const after = read(PROFILES(fixture));
    // A patch: the text that was there is still there, untouched, and the new profile follows it.
    expect(after).toContain(before.trimEnd());
    expect(after).toMatch(/^ {2}rapido:\n {4}extends: standard$/m);
    expect(after.length).toBeGreaterThan(before.length);
  });
});

test("deleting the default profile is refused with the reason and the file does not change", async ({ page }) => {
  await withServer(async ({ fixture, server }) => {
    await open(page, server);
    const before = sha256(read(PROFILES(fixture)));
    const root = sha256(read(path.join(fixture.dir, "jgates.yml")));
    const card = page.locator('[data-profile="minimal"]');
    await expect(card.getByText("Padrão", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Apagar o perfil Essencial" }).click();
    await page.getByRole("button", { name: "Apagar perfil" }).click();
    await expect(page.getByTestId("delete-refusal")).toContainText("é o padrão do projeto");
    expect(sha256(read(PROFILES(fixture)))).toBe(before);
    expect(sha256(read(path.join(fixture.dir, "jgates.yml")))).toBe(root);
    await page.getByRole("button", { name: "Fechar" }).first().click();

    // A profile another one extends is refused too: the reason names the profile that depends on it.
    await page.getByRole("button", { name: "Criar perfil" }).click();
    await page.getByLabel("Criar a partir de").selectOption("strict");
    await page.getByLabel("Identificador do perfil").fill("filho");
    await page.getByRole("button", { name: "Criar", exact: true }).click();
    await expect(page.locator('[data-profile="filho"]')).toBeVisible();
    const withChild = sha256(read(PROFILES(fixture)));
    await page.getByRole("button", { name: "Apagar o perfil Rigoroso" }).click();
    await page.getByRole("button", { name: "Apagar perfil" }).click();
    await expect(page.getByTestId("delete-refusal")).toContainText("filho");
    expect(sha256(read(PROFILES(fixture)))).toBe(withChild);
  });
});

test("turning off Testes unitários writes capability:unit enabled false in the profile and leaves the rest of the category", async ({ page }) => {
  await withServer(async ({ fixture, server }) => {
    await open(page, server);
    await page.getByRole("button", { name: "Editar o perfil Rigoroso" }).click();
    await expect(page.locator('[data-profile="strict"]')).toContainText("Em edição");

    await page.getByRole("button", { name: "Abrir a categoria Testes" }).click();
    const unit = page.getByRole("switch", { name: "Testes unitários", exact: true });
    const coverage = page.getByRole("switch", { name: "Cobertura", exact: true });
    const integration = page.getByRole("switch", { name: "Testes de integração", exact: true });
    await expect(unit).toBeChecked();
    await expect(coverage).toBeChecked();
    await expect(integration).not.toBeChecked();
    // The origin and the file where it is saved are on the row.
    const row = page.locator('[data-selector="capability:unit"]');
    await expect(row.getByTestId("origin-source")).toContainText("Perfil");
    await expect(row.getByTestId("origin-save")).toContainText(".jgates/profiles.yml");

    const before = read(PROFILES(fixture));
    await unit.click();
    await expect(unit).not.toBeChecked();

    const after = read(PROFILES(fixture));
    expect(after).not.toBe(before);
    // Only the strict profile changed: capability:unit is now false, the coverage entry next to it is as it was.
    const strict = (text: string) => text.slice(text.indexOf("  strict:"));
    expect(strict(after)).toMatch(/capability:unit:\n {8}enabled: false/);
    expect(strict(after)).toMatch(/capability:coverage:\n {8}enabled: true/);
    expect(after.slice(0, after.indexOf("  strict:"))).toBe(before.slice(0, before.indexOf("  strict:")));

    // The other items of the category stay as they were, also after the screen reads the files again.
    await page.reload();
    await page.getByRole("button", { name: "Editar o perfil Rigoroso" }).click();
    await page.getByRole("button", { name: "Abrir a categoria Testes" }).click();
    await expect(page.getByRole("switch", { name: "Testes unitários", exact: true })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "Cobertura", exact: true })).toBeChecked();
    await expect(page.getByRole("switch", { name: "Testes de integração", exact: true })).not.toBeChecked();
    const resolved = explain(fixture, "strict").selection.items as Array<{ selector: string; enabled: boolean }>;
    expect(resolved.find((i) => i.selector === "capability:unit")?.enabled).toBe(false);
    expect(resolved.find((i) => i.selector === "capability:coverage")?.enabled).toBe(true);
  });
});

test("a requirement locked by the policy shows the padlock and the reason, and its toggle cannot be turned off", async ({ page }) => {
  await withServer(async ({ fixture, server }) => {
    fs.writeFileSync(
      path.join(fixture.dir, ".jgates", "policy.yml"),
      "schemaVersion: 1\nrequiredEvidence:\n  - check: capability:lint\n    locked: true\n    reason: Exigido pela política do time\n",
    );
    await open(page, server);
    await page.getByRole("button", { name: "Abrir a categoria Qualidade" }).click();
    const locked = page.locator('[data-selector="capability:lint"]');
    await expect(locked).toHaveAttribute("data-locked", "true");
    await expect(locked.getByTestId("locked-item")).toContainText("Exigido pela política do time");
    await expect(locked.locator('[data-locked="true"] svg.icon')).toBeVisible();
    const toggle = locked.getByRole("switch", { name: "Lint", exact: true });
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeDisabled();

    const before = sha256(read(PROFILES(fixture)));
    await toggle.click({ force: true });
    await expect(toggle).toBeChecked();
    expect(sha256(read(PROFILES(fixture)))).toBe(before);

    // The server refuses it as well, with the reason, whatever the screen does.
    const answer = await page.evaluate(async () => {
      const session = await (await fetch("/api/session", { credentials: "same-origin" })).json();
      const response = await fetch("/api/config/selection", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", [session.csrfHeader]: session.csrfToken },
        body: JSON.stringify({ profile: "minimal", changes: [{ selector: "capability:lint", enabled: false }] }),
      });
      return { status: response.status, body: await response.json() };
    });
    expect(answer.status).toBe(422);
    expect(answer.body.message).toContain("Exigido pela política do time");
    expect(sha256(read(PROFILES(fixture)))).toBe(before);
  });
});

test("'Por que isso está ativado?' shows the chain of layers with file and field, the same as config resolve --explain", async ({ page }) => {
  await withServer(async ({ fixture, server }) => {
    await open(page, server);
    await page.getByRole("button", { name: "Abrir a categoria Qualidade" }).click();
    await page.getByRole("button", { name: "Por que isso está ativado? Lint", exact: true }).click();
    const chain = page.getByTestId("origin-chain");
    await expect(chain).toBeVisible();

    const cli = explain(fixture, "minimal");
    const field = cli.fields["/checks/capability:lint/enabled"];
    expect(field.history.length).toBeGreaterThan(1);
    const expected = [...field.history].reverse() as Array<{ layer: string; source: string; file: string | null; path: string | null; value: unknown }>;
    const items = chain.locator("li");
    await expect(items).toHaveCount(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const want = expected[i]!;
      const li = items.nth(i);
      await expect(li).toHaveAttribute("data-layer", want.layer);
      await expect(li).toHaveAttribute("data-source", want.source);
      await expect(li.getByTestId("origin-file")).toHaveText(want.file ?? "sem arquivo");
      if (want.path) await expect(li.getByTestId("origin-path")).toHaveText(want.path);
      await expect(li.getByTestId("origin-value")).toHaveText(String(want.value));
    }
    await expect(items.first()).toContainText("Vale este");
    // Where to edit: the profile file and the field of the selected profile.
    await expect(page.getByTestId("origin-where")).toContainText(".jgates/profiles.yml");
    await expect(page.getByTestId("origin-where")).toContainText("profiles.minimal.checks.capability:lint.enabled");

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });
});

test("the screen has no accessibility violations in both themes and fits the narrow width", async ({ page }) => {
  await withServer(async ({ server }) => {
    await open(page, server);
    await page.getByRole("button", { name: "Abrir a categoria Testes" }).click();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), scheme).toEqual([]);
    }
    await page.setViewportSize({ width: 390, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
