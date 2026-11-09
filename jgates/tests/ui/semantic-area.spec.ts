import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createGateFixture, openApp, startGateServer, type GateFixture, type UiServer } from "./support";

// The Semantic (AI) area in the browser, without Quality: configuration and prerequisites, the setup with full / selected /
// incremental scope and the impact preview, a Semantic-only run with its result and history, cancellation that keeps partial
// evidence, the reduced motion of the AI mascots, keyboard use, light/dark, a narrow viewport and axe. The model is the
// scripted mock or a local command that never answers (no tokens). A Semantic run never creates or joins a Quality run.

async function withGates(page: Page, body: (ctx: { fixture: GateFixture; server: UiServer; base: string }) => Promise<void>, prepare?: (fixture: GateFixture) => void) {
  const fixture = createGateFixture();
  let server: UiServer | null = null;
  try {
    prepare?.(fixture);
    server = await startGateServer(fixture);
    const base = await openApp(page, server);
    await body({ fixture, server, base });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function serious(page: Page, label: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

/** Setup step 1 -> 2 -> preview with the scope already chosen on the page. */
async function toPreview(page: Page) {
  await page.getByRole("button", { name: "Avançar" }).click();
  await page.getByTestId("semsetup-show-preview").click();
  await expect(page.getByTestId("semsetup-preview")).toBeVisible({ timeout: 60_000 });
}

test("configuration shows the saved settings and the prerequisites, and a workspace without a provider says what is missing", async ({ page }) => {
  await withGates(page, async ({ base }) => {
    await page.goto(`${base}#/semantic/config`);
    await expect(page.getByRole("heading", { name: "Configure a revisão semântica.", level: 1 })).toBeVisible();
    const saved = page.getByTestId("semcfg-saved");
    await expect(saved).toContainText("Configurado");
    await expect(saved).toContainText("mock");
    await expect(page.locator("[data-prerequisite]").first()).toBeVisible();
    // The run-only choices are apart from the saved settings, and the methods are selectable.
    await expect(page.getByTestId("semcfg-run-only")).toBeVisible();
    await expect(page.getByTestId("semcfg-methods").locator("[data-method]").first()).toBeVisible();
    await expect(page.getByTestId("semcfg-modules")).not.toHaveText("-");
  });
  await withGates(
    page,
    async ({ base }) => {
      await page.goto(`${base}#/semantic/config`);
      await expect(page.getByTestId("semcfg-saved")).toContainText("Desligado");
      // At least one required prerequisite is not ready, and it says so in text (not by color alone).
      const missing = page.locator('[data-prerequisite][data-ok="false"]');
      await expect(missing.first()).toBeVisible();
      await expect(missing.first()).toContainText(/Faltando|Opcional/);
    },
    (fixture) => fixture.write("jgates.yml", "schemaVersion: 1\nselection:\n  profile: seq\ntemplates:\n  - id: seq\n    source: .jgates/templates/seq.yml\n    activation: always\n"),
  );
});

test("scope modes: full, selected and incremental each give their own impact preview and start nothing", async ({ page }) => {
  await withGates(page, async ({ base, fixture }) => {
    // An incremental change: b.js changes in a second commit.
    fixture.write("src/other/b.js", "exports.b = () => 3;\n");
    fixture.git("add", "-A");
    fixture.git("commit", "-q", "-m", "change b");
    await page.goto(`${base}#/semantic/setup`);
    await expect(page.getByRole("heading", { name: "Prepare uma revisão semântica.", level: 1 })).toBeVisible();

    // Full: the whole repository, recommended.
    const modes = page.getByRole("radiogroup");
    await modes.getByRole("radio", { name: /Projeto inteiro/ }).check();
    await toPreview(page);
    const total = Number(await page.getByTestId("semsetup-subjects").getAttribute("data-count"));
    expect(total).toBeGreaterThanOrEqual(6);
    await expect(page.getByTestId("semsetup-estimates")).toContainText("arquivos no repositório");
    await expect(page.getByTestId("semsetup-reserve")).toContainText("guardadas para validação");
    await expect(page.getByTestId("semsetup-start")).toBeEnabled();

    // Selected: only what is named.
    await page.getByRole("button", { name: "Escopo", exact: true }).click();
    await modes.getByRole("radio", { name: /Escopo selecionado/ }).check();
    // Without a path the preview is refused with a reason.
    await expect(page.getByRole("status").filter({ hasText: "Indique ao menos um caminho" })).toBeVisible();
    await page.getByRole("textbox", { name: /Caminhos, pastas ou globs/ }).fill("src/core");
    await toPreview(page);
    await expect(page.getByTestId("semsetup-subjects")).toHaveAttribute("data-count", "1");
    await expect(page.getByTestId("semsetup-subjects")).toContainText("src/core/a.js");
    await expect(page.getByTestId("semsetup-subjects")).not.toContainText("src/other/b.js");

    // Incremental: the changed file between a base and the target, never the whole repository.
    await page.getByRole("button", { name: "Escopo", exact: true }).click();
    await modes.getByRole("radio", { name: /Incremental/ }).check();
    await expect(page.getByRole("status").filter({ hasText: "precisa de uma referência base" })).toBeVisible();
    await page.getByPlaceholder("main", { exact: true }).fill("HEAD~1");
    await toPreview(page);
    await expect(page.getByTestId("semsetup-subjects")).toContainText("src/other/b.js");
    expect(Number(await page.getByTestId("semsetup-subjects").getAttribute("data-count"))).toBeLessThan(total);
    await expect(page.getByTestId("semsetup-context")).toBeVisible();
    await expect(page.getByTestId("semsetup-reuse")).toBeVisible();
    await expect(page.getByTestId("semsetup-gaps")).toBeVisible();

    // The previews started no run and no Quality run exists.
    expect(fixture.runFolders("semantic-runs")).toEqual([]);
    expect(fixture.runFolders("runs")).toEqual([]);
    expect(fixture.providerCalls()).toBe(0);
  });
});

test("Semantic only: a full run with no Quality history is followed, finishes, and lands in the Semantic history only", async ({ page }) => {
  test.setTimeout(300_000);
  await withGates(page, async ({ base, fixture }) => {
    await page.goto(`${base}#/semantic`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("tr[data-run]")).toHaveCount(0);

    // By keyboard: the history's call to action opens the setup.
    await page.getByTestId("semhist-new-run").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Prepare uma revisão semântica.", level: 1 })).toBeVisible();
    await page.getByRole("radio", { name: /Projeto inteiro/ }).check();
    await toPreview(page);
    await page.getByTestId("semsetup-start").click();

    await page.waitForURL(/#\/semantic\/runs\/sem_/);
    const runId = decodeURIComponent(page.url().split("/runs/")[1] as string);
    expect(runId).toMatch(/^sem_/);
    await expect(page.getByTestId("semantic-mascots")).toBeVisible();
    await expect(page.getByTestId("semantic-run-state")).toHaveAttribute("data-state", "finished", { timeout: 180_000 });
    await expect(page.getByTestId("semantic-results")).toHaveAttribute("data-decision", "passed");

    // The Quality gate did not run: no Quality run folder, no Quality history entry; the model was called.
    expect(fixture.runFolders("runs")).toEqual([]);
    expect(fixture.runFolders("semantic-runs")).toEqual([runId]);
    expect(fixture.providerCalls()).toBeGreaterThan(0);
    await page.goto(`${base}#/validations`);
    await expect(page.locator("tr[data-run]")).toHaveCount(0);
    const qualityHistory = await page.evaluate(async () => (await fetch("/api/history")).text());
    expect(qualityHistory).not.toContain("sem_");

    await page.goto(`${base}#/semantic`);
    await expect(page.locator("tr[data-run]")).toHaveCount(1);
    await expect(page.locator(`tr[data-run="${runId}"]`)).toHaveAttribute("data-lifecycle", "settled");
    await page.goto(`${base}#/semantic/results/${runId}`);
    await expect(page.getByTestId("semantic-results")).toBeVisible();
    for (const id of ["semres-scope-completion", "semres-repository-coverage", "semres-usage"]) await expect(page.getByTestId(id)).toBeVisible();

    // Accessibility in light and dark, and a narrow viewport without horizontal scrolling, on every Semantic screen.
    const routes = ["#/semantic", "#/semantic/config", "#/semantic/setup", `#/semantic/runs/${runId}`, `#/semantic/results/${runId}`];
    const problems: string[] = [];
    for (const route of routes) {
      await page.goto(`${base}${route}`);
      await page.reload();
      await expect(page.locator("main h1").first()).toBeVisible();
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
        problems.push(...(await serious(page, `${route} ${scheme}`)));
      }
    }
    expect(problems).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    for (const route of routes) {
      await page.goto(`${base}${route}`);
      await page.reload();
      await expect(page.locator("main h1").first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${route} overflows the narrow viewport`).toBeLessThanOrEqual(1);
    }
  });
});

test("methods are the only choice: General review is checked by default, none selected is an error, only Security audit shows its own label", async ({ page }) => {
  test.setTimeout(300_000);
  await withGates(
    page,
    async ({ base }) => {
      // The setup has no purpose control; the methods are checkboxes with the general review checked.
      await page.goto(`${base}#/semantic/setup`);
      await page.getByRole("button", { name: "Avançar" }).click();
      const methods = page.getByTestId("semcfg-methods");
      await expect(methods).toBeVisible();
      await expect(page.getByText("Propósito", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Módulos para este propósito")).toHaveCount(0);
      await expect(methods.locator('[data-method="general-review"] input')).toBeChecked();
      await expect(methods.locator('[data-method="security-audit"] input')).not.toBeChecked();

      // None selected: an inline error and no way forward.
      await methods.locator('[data-method="general-review"] input').uncheck();
      await expect(page.getByTestId("semcfg-methods-error")).toContainText("Escolha ao menos um método");
      await expect(page.getByTestId("semsetup-show-preview")).toBeDisabled();
      const problems = await serious(page, "setup, no method");

      // The configuration screen says the same and refuses to keep an empty selection.
      await page.goto(`${base}#/semantic/config`);
      await expect(page.getByTestId("semcfg-methods")).toBeVisible();
      await expect(page.getByText("Propósito", { exact: true })).toHaveCount(0);
      await page.getByTestId("semcfg-methods").locator('[data-method="general-review"] input').uncheck();
      await expect(page.getByTestId("semcfg-methods-error")).toBeVisible();
      await expect(page.getByRole("button", { name: /Guardar|Manter/ }).first()).toBeDisabled();
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
        problems.push(...(await serious(page, `config, no method, ${scheme}`)));
      }
      expect(problems).toEqual([]);

      // Only the Security audit: that is the one method of the run, and results and history say so.
      await page.goto(`${base}#/semantic/setup`);
      await page.getByRole("button", { name: "Avançar" }).click();
      await page.getByTestId("semcfg-methods").locator('[data-method="security-audit"] input').check();
      await page.getByTestId("semcfg-methods").locator('[data-method="general-review"] input').uncheck();
      await page.getByTestId("semsetup-show-preview").click();
      await expect(page.getByTestId("semsetup-methods").locator("[data-method]")).toHaveCount(1);
      await expect(page.getByTestId("semsetup-methods").locator('[data-method="security-audit"]')).toBeVisible();
      await page.getByTestId("semsetup-start").click();
      await page.waitForURL(/#\/semantic\/runs\/sem_/);
      const runId = decodeURIComponent(page.url().split("/runs/")[1] as string);
      await expect(page.getByTestId("semantic-run-state")).not.toHaveAttribute("data-state", "running", { timeout: 180_000 });
      await page.goto(`${base}#/semantic/results/${runId}`);
      await expect(page.getByTestId("semres-methods")).toHaveText("Auditoria de segurança");
      await expect(page.getByTestId("semantic-results")).not.toContainText("Revisão geral");
      await page.goto(`${base}#/semantic`);
      await expect(page.locator(`tr[data-run="${runId}"] [data-testid="semhist-methods"]`)).toHaveText("Auditoria de segurança");
    },
  );
});

test("cancelling a running Semantic review stops it, keeps partial evidence, and the AI mascots do not animate under reduced motion", async ({ page }) => {
  await withGates(
    page,
    async ({ base, fixture }) => {
      await page.goto(`${base}#/semantic/setup`);
      await page.getByRole("radio", { name: /Projeto inteiro/ }).check();
      await toPreview(page);
      await page.getByTestId("semsetup-start").click();
      await page.waitForURL(/#\/semantic\/runs\/sem_/);
      const runId = decodeURIComponent(page.url().split("/runs/")[1] as string);
      await expect.poll(() => fixture.reviewerStarted(), { timeout: 90_000 }).toBe(true);
      await expect(page.getByTestId("semantic-run-state")).toHaveAttribute("data-state", "running");
      await expect(page.getByTestId("semantic-run-progress")).toBeVisible({ timeout: 30_000 });
      const mascots = page.getByTestId("semantic-mascots");
      await expect(mascots).toHaveAttribute("data-running", "true");
      await expect(mascots.locator('li[data-state="working"]').first()).toBeVisible({ timeout: 30_000 });
      await expect(mascots.locator("li[data-mascot]")).toHaveCount(4);

      // Motion on: a working AI mascot animates (so the check below can fail).
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const animated = () =>
        page.evaluate(() => {
          const out: string[] = [];
          for (const el of document.querySelectorAll('[data-testid="semantic-mascots"] .sem-mascot[data-state="working"] .m-anim')) {
            const name = getComputedStyle(el).animationName;
            if (name && name !== "none") out.push(name);
          }
          return out;
        });
      await expect.poll(animated).not.toEqual([]);
      // Reduced motion: no AI mascot animates at all, in any state.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect.poll(animated).toEqual([]);
      const anyAnimation = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll('[data-testid="semantic-mascots"] svg *')) {
          const style = getComputedStyle(el);
          if (style.animationName !== "none" || style.transitionDuration.split(",").some((d) => parseFloat(d) > 0)) out.push(`${el.tagName}.${el.getAttribute("class")}`);
        }
        return out;
      });
      expect(anyAnimation).toEqual([]);
      await page.emulateMedia({ reducedMotion: "no-preference" });

      // Cancel: only this run stops, the partial evidence stays, the decision is cancelled.
      await page.getByRole("button", { name: "Cancelar a revisão" }).click();
      await expect(page.getByTestId("semantic-run-state")).toHaveAttribute("data-state", "cancelled", { timeout: 90_000 });
      await expect(mascots.locator('li[data-state="working"]')).toHaveCount(0);
      await expect(page.getByTestId("semantic-results")).toHaveAttribute("data-decision", "cancelled");
      const runDir = path.join(fixture.home, "workspaces", fs.readdirSync(path.join(fixture.home, "workspaces"))[0] as string, "semantic-runs", runId);
      expect(fs.existsSync(path.join(runDir, "result.json"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8")).decision).toBe("cancelled");

      // Its own history entry; the Quality side has nothing.
      await page.goto(`${base}#/semantic`);
      await expect(page.locator(`tr[data-run="${runId}"]`)).toBeVisible();
      expect(fixture.runFolders("runs")).toEqual([]);
      await page.goto(`${base}#/validations`);
      await expect(page.locator("tr[data-run]")).toHaveCount(0);
    },
    (fixture) => fixture.useHangingReviewer(),
  );
});
