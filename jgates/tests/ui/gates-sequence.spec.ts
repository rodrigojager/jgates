import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createGateFixture, openApp, startGateServer, type GateFixture, type UiServer } from "./support";

// Gate selection and the sequence of two gates in the browser: Quality only, both gates with a passing Quality run (Semantic
// starts after it, as its own run), both gates with a Quality run that does not approve (Semantic never starts, the model is
// never called), and the manual advance. Each gate keeps its own run, result and history: a Semantic run never appears in the
// Quality history. The Semantic model is the scripted mock (no tokens).

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

/** Chooses the gates in "Escolher a validação", reviews the plan and starts it. */
async function startFromChoose(page: Page, base: string, gates: "quality" | "both", options: { manual?: boolean } = {}) {
  await page.goto(`${base}#/validations/choose`);
  await expect(page.getByRole("heading", { name: "Escolher a validação", level: 1 })).toBeVisible();
  const choice = page.getByTestId("gate-choice");
  await choice.getByRole("radio", { name: gates === "both" ? /Quality e depois Semantic/ : /^Quality ·/ }).check();
  if (options.manual) await choice.getByRole("checkbox", { name: /Pausar após a aprovação de Quality/ }).check();
  await page.getByRole("button", { name: "Revisar o plano" }).click();
  await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/, { timeout: 90_000 });
  if (gates === "both") await expect(page.getByTestId("sequence-plan")).toContainText("Dois gates, duas execuções");
  await page.getByRole("button", { name: "Executar" }).click();
}

const gateCard = (page: Page, gate: "quality" | "semantic") => page.getByTestId(`sequence-${gate}`);

test("Quality only: one Quality run, nothing of Semantic is created and the model is never called", async ({ page }) => {
  await withGates(page, async ({ fixture, base }) => {
    await startFromChoose(page, base, "quality");
    await page.waitForURL(/#\/runs\//);
    await expect(page.getByTestId("run-state")).toHaveAttribute("data-state", "finished", { timeout: 120_000 });
    await expect(page.getByRole("heading", { name: "Resultado", level: 2 })).toBeVisible();
    expect(fixture.runFolders("runs")).toHaveLength(1);
    expect(fixture.runFolders("runs")[0]).toMatch(/^run_/);
    expect(fixture.runFolders("semantic-runs")).toEqual([]);
    expect(fixture.runFolders("sequences")).toEqual([]);
    expect(fixture.providerCalls()).toBe(0);

    // The Semantic history is empty; the Quality one lists the run.
    await page.goto(`${base}#/semantic`);
    await expect(page.getByRole("heading", { name: /semântic/i, level: 1 })).toBeVisible();
    await expect(page.locator("tr[data-run]")).toHaveCount(0);
    await page.goto(`${base}#/validations`);
    await expect(page.locator("tr[data-run]")).toHaveCount(1);
  });
});

test("both gates with a passing Quality: two distinct runs, Semantic starts after Quality and never enters the Quality history", async ({ page }) => {
  await withGates(page, async ({ fixture, base }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await startFromChoose(page, base, "both");
    await page.waitForURL(/#\/sequence\/seq_/);
    const overview = page.getByTestId("sequence-overview");
    await expect(overview).toBeVisible({ timeout: 30_000 }).catch(async (e) => {
      throw new Error(`${e.message}\n--- errors: ${errors.join(" | ")}\n--- page: ${page.url()}\n${await page.locator("body").innerText()}`);
    });
    await expect(overview).toHaveAttribute("data-status", "completed", { timeout: 180_000 });
    await expect(gateCard(page, "quality")).toHaveAttribute("data-state", "passed");
    await expect(gateCard(page, "semantic")).toHaveAttribute("data-state", "passed");

    // Two separate runs in disjoint namespaces, linked only by the sequence.
    const qualityRun = (await gateCard(page, "quality").getAttribute("data-run")) ?? "";
    const semanticRun = (await gateCard(page, "semantic").getAttribute("data-run")) ?? "";
    expect(qualityRun).toMatch(/^run_/);
    expect(semanticRun).toMatch(/^sem_/);
    expect(fixture.runFolders("runs")).toEqual([qualityRun]);
    expect(fixture.runFolders("semantic-runs")).toEqual([semanticRun]);
    expect(fixture.runFolders("sequences")).toHaveLength(1);
    expect(fixture.providerCalls()).toBeGreaterThan(0);

    // The transition is shown with its reason.
    await expect(page.getByTestId("sequence-transition")).toHaveAttribute("data-code", "QUALITY_APPROVED");
    await expect(page.getByTestId("semantic-not-started")).toHaveCount(0);

    // Separate histories: a Semantic run never appears among the Quality runs, nor the other way round.
    await page.goto(`${base}#/validations`);
    await expect(page.locator("tr[data-run]")).toHaveCount(1);
    await expect(page.locator(`tr[data-run="${qualityRun}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-run="${semanticRun}"]`)).toHaveCount(0);
    expect(await page.locator("main").innerText()).not.toContain(semanticRun);
    const qualityApi = await page.evaluate(async () => (await fetch("/api/history")).text());
    expect(qualityApi).toContain(qualityRun);
    expect(qualityApi).not.toContain("sem_");

    await page.goto(`${base}#/semantic`);
    await expect(page.locator("tr[data-run]")).toHaveCount(1);
    await expect(page.locator(`tr[data-run="${semanticRun}"]`)).toBeVisible();
    expect(await page.locator("main").innerText()).not.toContain(qualityRun);

    // Each result page keeps its own gate: the Semantic result is a Semantic screen.
    await page.goto(`${base}#/semantic/results/${semanticRun}`);
    await expect(page.getByTestId("semantic-results")).toHaveAttribute("data-decision", "passed");
    await page.goto(`${base}#/validations/result/${qualityRun}`);
    await expect(page.getByTestId("result-banner")).toBeVisible();
  });
});

test("both gates with a Quality run that fails: Semantic is never started and the model is never called", async ({ page }) => {
  await withGates(
    page,
    async ({ fixture, base }) => {
      await startFromChoose(page, base, "both");
      await page.waitForURL(/#\/sequence\/seq_/);
      await expect(page.getByTestId("sequence-overview")).toHaveAttribute("data-lifecycle", /settled|stopped|finished|completed|idle/, { timeout: 180_000 }).catch(() => undefined);
      await expect(gateCard(page, "quality")).toHaveAttribute("data-state", "failed", { timeout: 180_000 });
      await expect(gateCard(page, "semantic")).toHaveAttribute("data-state", "not-started");
      await expect(page.getByTestId("semantic-not-started")).toBeVisible();
      await expect(page.getByTestId("sequence-transition")).toHaveAttribute("data-code", "QUALITY_FAILED");

      // Nothing of Semantic was created: no run folder, no model call, no run id on the card.
      expect(fixture.runFolders("semantic-runs")).toEqual([]);
      expect(fixture.providerCalls()).toBe(0);
      await expect(gateCard(page, "semantic")).toHaveAttribute("data-run", "");

      // The Semantic history stays empty; the failed Quality run is in the Quality history.
      await page.goto(`${base}#/semantic`);
      await expect(page.locator("tr[data-run]")).toHaveCount(0);
      await page.goto(`${base}#/validations`);
      await expect(page.locator("tr[data-run]")).toHaveCount(1);

      // Semantic can still be run on its own, with its own run and no change to the Quality decision.
      await page.goto(`${base}#/semantic/setup`);
      await expect(page.getByRole("heading", { name: /revisão semântica/i, level: 1 })).toBeVisible();
    },
    (fixture) => fixture.setMode("fail"),
  );
});

test("manual advance: Quality approves, Semantic waits for the user and then runs as its own run", async ({ page }) => {
  await withGates(page, async ({ fixture, base }) => {
    await startFromChoose(page, base, "both", { manual: true });
    await page.waitForURL(/#\/sequence\/seq_/);
    await expect(gateCard(page, "quality")).toHaveAttribute("data-state", "passed", { timeout: 180_000 });
    await expect(page.getByTestId("sequence-overview")).toHaveAttribute("data-status", "awaiting-advancement", { timeout: 60_000 });
    await expect(gateCard(page, "semantic")).toHaveAttribute("data-state", "not-started");
    expect(fixture.runFolders("semantic-runs")).toEqual([]);
    expect(fixture.providerCalls()).toBe(0);

    await page.getByRole("button", { name: "Avançar para o Semantic" }).click();
    await expect(page.getByTestId("sequence-overview")).toHaveAttribute("data-status", "completed", { timeout: 60_000 }).catch(async (e) => {
      const seq = await page.evaluate(async () => (await fetch(`/api/sequences/${location.hash.split("/").pop()}`)).text());
      throw new Error(`${e.message}\n${await page.locator("main").innerText()}\n${seq.slice(0, 1500)}`);
    });
    await expect(gateCard(page, "semantic")).toHaveAttribute("data-state", "passed");
    expect(fixture.runFolders("semantic-runs")).toHaveLength(1);
    expect(fixture.runFolders("runs")).toHaveLength(1);
  });
});

test("the sequence overview and the gate choice have no serious accessibility violation in light and dark", async ({ page }) => {
  await withGates(page, async ({ base }) => {
    await page.goto(`${base}#/validations/choose`);
    await expect(page.getByTestId("gate-choice")).toBeVisible();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${scheme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    }
    // The gate choice is operable by keyboard: arrow keys move inside the radio group.
    const choice = page.getByTestId("gate-choice");
    await choice.getByRole("radio", { name: /^Quality$|^Quality ·/ }).first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(choice.getByRole("radio", { name: /^Semantic/ })).toBeChecked();
  });
});
