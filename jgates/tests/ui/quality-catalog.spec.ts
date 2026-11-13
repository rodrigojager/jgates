import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createGateFixture, openApp, pageGet, startGateServer, type GateFixture, type UiServer } from "./support";

// The Quality side of V2 in the browser: the standard catalog offers the new integrations in the tools screen, the
// customer-supplied ones declare their setup (the matrix behind the screens), the six Quality mascot domains show their
// coverage subdimensions and never an AI/Semantic stage, and the tools dialog and screen are keyboard operable
// (Escape closes the dialog and returns the focus), accessible in light and dark and usable on a narrow viewport.

async function withGates(page: Page, body: (ctx: { fixture: GateFixture; server: UiServer; base: string }) => Promise<void>) {
  const fixture = createGateFixture();
  let server: UiServer | null = null;
  try {
    server = await startGateServer(fixture);
    const base = await openApp(page, server);
    await body({ fixture, server, base });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

const NEW_INTEGRATIONS = ["zizmor", "oasdiff", "build-check", "codeql", "schemathesis", "zap", "mutation", "supply-chain", "semgrep"];
const DOMAINS = ["quality", "security", "dependencies", "tests", "architecture", "infrastructure"];
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function serious(page: Page, label: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

test("a fresh standard installation lists the new integrations in the catalog, with no custom adapter", async ({ page }) => {
  await withGates(page, async ({ base }) => {
    await page.goto(`${base}#/tools`);
    await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();
    // The whole catalogue is under "Todas"; "Deste projeto" (the default) keeps the project's languages first.
    await page.getByTestId("tools-scope").getByRole("radio", { name: "Todas" }).check();
    for (const adapter of NEW_INTEGRATIONS) await expect(page.locator(`[data-testid="catalog-card"][data-adapter="${adapter}"]`), adapter).toBeVisible();

    // The filter narrows the catalog and an unknown term says so.
    const search = page.getByPlaceholder("eslint, python, segurança");
    await search.fill("codeql");
    await expect(page.getByTestId("catalog-card")).toHaveCount(1);
    await expect(page.locator('[data-testid="catalog-card"][data-adapter="codeql"]')).toContainText("CodeQL");
    await search.fill("zzz-no-such-tool");
    await expect(page.getByTestId("catalog-card")).toHaveCount(0);
    await search.fill("");
  });
});

test("customer-supplied tools declare their setup: state, prerequisites and distribution, never passed silently", async ({ page }) => {
  await withGates(page, async ({ base }) => {
    await page.goto(`${base}#/tools`);
    await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();
    const doc = await pageGet<any>(page, "/api/tool-matrix");
    expect(doc.problems).toEqual([]);
    const rows: any[] = doc.matrix.rows;
    const codeql = rows.filter((r) => r.adapter === "codeql");
    expect(codeql.length).toBeGreaterThan(0);
    for (const row of codeql) {
      expect(row.state).toBe("customer-setup-required");
      expect(row.distribution).toBe("customer-supplied");
      expect(row.prerequisites.join(" ")).toMatch(/CodeQL CLI/);
    }
    // No validated row without evidence: the matrix itself reports no problem and every validated row cites a test.
    for (const row of rows.filter((r) => r.state === "validated")) expect(row.evidence.tests.length, row.key).toBeGreaterThan(0);

    // The catalog the screen renders agrees: CodeQL is an editable file the customer sets up, not a full integration.
    const catalog = await pageGet<any>(page, "/api/tool-catalog");
    const entry = catalog.adapters.find((a: any) => a.adapter === "codeql");
    expect(entry.supportLevel).toBe("editable-file");
    expect(entry.limitations.join(" ")).toMatch(/customer-supplied: JGates never bundles CodeQL/);
    await expect(page.locator('[data-testid="catalog-card"][data-adapter="codeql"]')).toContainText("Arquivo editável");

    // The card shows the distribution state and, for a customer-supplied tool, the official acquisition and setup links.
    const adapter = doc.matrix.adapters.find((a: any) => a.id === "codeql");
    expect(adapter.distribution.mode).toBe("customer-supplied");
    const card = page.locator('[data-testid="catalog-card"][data-adapter="codeql"]');
    await expect(card.getByTestId("catalog-distribution")).toHaveAttribute("data-mode", "customer-supplied");
    await expect(card.getByTestId("catalog-distribution")).toContainText("Você fornece esta ferramenta");
    const guidance = card.getByTestId("catalog-setup-guidance");
    await expect(guidance).toBeVisible();
    for (const link of [...adapter.distribution.acquisition, ...adapter.distribution.setup]) await expect(guidance.locator(`a[href="${link}"]`), link).toBeVisible();
    // A shipped tool carries its state but no customer setup guidance.
    const shipped = page.locator('[data-testid="catalog-card"][data-adapter="supply-chain"]');
    await expect(shipped.getByTestId("catalog-distribution")).toHaveAttribute("data-mode", "shipped");
    await expect(shipped.getByTestId("catalog-setup-guidance")).toHaveCount(0);
  });
});

test("the six Quality domains show coverage subdimensions and no AI stage", async ({ page }) => {
  await withGates(page, async ({ base }) => {
    await page.goto(`${base}#/validations/choose`);
    const strip = page.getByTestId("quality-mascots");
    await expect(strip).toBeVisible({ timeout: 60_000 });
    const domains = await strip.locator(".quality-mascot[data-domain]").evaluateAll((els) => els.map((e) => e.getAttribute("data-domain")));
    expect(domains.sort()).toEqual([...DOMAINS].sort());
    // Subdimensions are listed per domain; one that has no selected check says it is not covered.
    for (const domain of DOMAINS) {
      const subs = page.getByTestId(`quality-mascot-subs-${domain}`);
      await expect(subs, domain).toHaveCount(1);
      expect(await subs.locator("li[data-sub]").count(), domain).toBeGreaterThan(0);
    }
    const uncovered = strip.locator('li[data-sub][data-covered="false"]');
    if ((await uncovered.count()) > 0) await expect(uncovered.first()).toContainText("sem cobertura");
    // Quality panels never carry a Semantic/AI element.
    await expect(strip.locator('[data-mascot], .sem3d')).toHaveCount(0);
    expect(await strip.innerText()).not.toMatch(/semantic|semântic|\bIA\b/i);
  });
});

test("the create dialog closes with Escape and returns the focus, and the tools screen works by keyboard, in light and dark and on a narrow viewport", async ({ page }) => {
  await withGates(page, async ({ base }) => {
    await page.goto(`${base}#/tools`);
    await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();
    const open = page.getByRole("button", { name: "Adicionar ferramenta", exact: true });
    await open.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expect(await serious(page, "dialog")).toEqual([]);
    // Focus stays inside the dialog while it is open.
    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog")))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelector("dialog[open]"))).toBeNull();
    // Focus goes back to the element that opened the dialog.
    await expect(open).toBeFocused();

    // A catalog card's own action opens the dialog for that adapter, and Escape closes it again.
    const card = page.locator('[data-testid="catalog-card"][data-adapter="zizmor"]');
    await card.getByRole("button", { name: /Criar instância|Usar/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toContainText("zizmor", { ignoreCase: true });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(card.getByRole("button", { name: /Criar instância|Usar/ })).toBeFocused();

    // Light and dark.
    const problems: string[] = [];
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
      problems.push(...(await serious(page, `tools ${scheme}`)));
    }
    expect(problems).toEqual([]);

    // Narrow viewport: no horizontal scrolling.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();
    // Measure after the distribution blocks (with their long setup links) have rendered.
    await expect(page.locator('[data-testid="catalog-card"][data-adapter="codeql"] [data-testid="catalog-setup-guidance"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });
});
