import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAIN, createGateFixture, openApp, reloadPage, startGateServer, type GateFixture } from "./support";

// The ASVS review (method asvs-review) in the Semantic screens: it is in the method list and selectable by keyboard, the
// list can select every method at once, the preview shows how many requirements will be reviewed and asks for the cost
// confirmation before Start, a workspace without a Quality run gets the reason instead of a start, and the result of a
// finished run lists the requirements examined and the ones not examinable, as an AI review of the source. The fixture
// has no Quality run and no model is ever called; the stored result is written the way the Semantic executor writes it.
// In pt-BR at 1280 px and in English at 375 px, keyboard only, with axe.

const RUN = "sem_20261114T100000Z_aaaa0008";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const METHOD = "asvs-review";

const TEXT = {
  "pt-BR": {
    label: "Revisão ASVS",
    all: "Selecionar todos os métodos",
    clear: "Limpar a seleção",
    next: "Avançar",
    preview: "Mostrar a prévia",
    start: "Iniciar a revisão",
    confirm: /Confirmo este custo/,
    count: /12 requisitos do ASVS 5\.0\.0, nível 1.*3 capítulos.*até 40 chamadas ao modelo/,
    noQuality: /não tem uma execução Quality concluída|nenhuma validação|valide o projeto primeiro/i,
    ai: /revisão do código por IA/,
    examined: "Examinados",
    notExaminable: "Não examináveis",
    reason: /diz respeito ao sistema em execução/,
  },
  en: {
    label: "ASVS review",
    all: "Select all methods",
    clear: "Clear the selection",
    next: "Next",
    preview: "Show the preview",
    start: "Start the review",
    confirm: /I confirm this cost/,
    count: /12 requirements of ASVS 5\.0\.0, level 1.*3 chapters.*up to 40 model calls/,
    noQuality: /no finished (Quality run|validation)|validate the project first/i,
    ai: /AI review of the source/,
    examined: "Examined",
    notExaminable: "Not examinable",
    reason: /concerns the running system/,
  },
} as const;

async function workspaceIdOf(fixture: GateFixture): Promise<string> {
  const mod = await import(pathToFileURL(path.join(path.dirname(MAIN), "..", "core", "ids", "index.js")).href);
  return mod.workspaceId(fixture.dir);
}

/** A finished asvs-review run: three requirements examined (one with a candidate violation) and two not examinable. */
function writeReviewRun(fixture: GateFixture, workspace: string): void {
  const dir = path.join(fixture.home, "workspaces", workspace, "semantic-runs", RUN);
  fs.mkdirSync(path.join(dir, "evidence", "asvs-review"), { recursive: true });
  const ref = [{ path: "src/core/a.js", startLine: 1, endLine: 1 }];
  const ledger = {
    schemaVersion: 1,
    kind: "asvs-review-ledger",
    method: "asvs-review",
    asvsVersion: "5.0.0",
    level: 1,
    requirements: [
      { id: "V6.2.1", answer: "examined", references: ref, outcome: "no-violation-found" },
      { id: "V6.2.2", answer: "examined", references: ref, outcome: "finding" },
      { id: "V8.1.1", answer: "examined", references: ref, outcome: "no-violation-found" },
      { id: "V13.2.1", answer: "not-examinable", reason: "running-system", detail: "needs the deployed system" },
      { id: "V14.1.1", answer: "not-examinable", reason: "person" },
    ],
  };
  fs.writeFileSync(path.join(dir, "evidence", "asvs-review", "requirements-ledger.json"), JSON.stringify(ledger));
  const result = {
    schemaVersion: 1,
    gate: "semantic",
    decision: "passed",
    complete: true,
    partial: false,
    exitCode: 0,
    startedAt: "2026-11-14T10:00:00.000Z",
    finishedAt: "2026-11-14T10:05:00.000Z",
    summary: "Stored ASVS review.",
    stages: [],
    semanticRun: { methods: [METHOD], outcome: { state: "complete", provider: "mock", model: "scripted-model", calls: 3, conclusion: { findings: [] }, investigation: { module: { id: METHOD }, candidates: [], stages: [], coverage: null } } },
  };
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result));
}

async function withApp(language: "pt-BR" | "en", body: (ctx: { page: Page; base: string; fixture: GateFixture }) => Promise<void>, page: Page): Promise<void> {
  const fixture = createGateFixture();
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ language }, null, 2)}\n`, { mode: 0o600 });
  writeReviewRun(fixture, await workspaceIdOf(fixture));
  const server = await startGateServer(fixture);
  try {
    const base = await openApp(page, server);
    await body({ page, base, fixture });
  } finally {
    await server.stop();
    fixture.cleanup();
  }
}

async function serious(page: Page, label: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

/** The Choices step of the setup screen, by keyboard: the scope step first, then "Next". */
async function openChoices(page: Page, base: string, words: (typeof TEXT)[keyof typeof TEXT]): Promise<void> {
  await page.goto(`${base}#/semantic/setup`);
  // The first visit in a language other than the cached one reloads the app once: settle that reload first.
  await reloadPage(page);
  const next = page.getByRole("button", { name: words.next, exact: true });
  await expect(next).toBeVisible();
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("semcfg-methods")).toBeVisible();
}

for (const [language, width] of [["pt-BR", 1280], ["en", 375]] as const) {
  const words = TEXT[language];

  test(`${language} at ${width}px: the method list has the ASVS review, selectable by keyboard, and every method can be selected at once`, async ({ page }) => {
    await withApp(language, async ({ page, base }) => {
      await page.setViewportSize({ width, height: 900 });
      await openChoices(page, base, words);
      const entry = page.locator(`[data-method="${METHOD}"]`);
      await expect(entry).toBeVisible();
      await expect(entry).toContainText(words.label);
      const box = entry.getByRole("checkbox");
      await expect(box).not.toBeChecked();
      await box.focus();
      await page.keyboard.press("Space");
      await expect(box).toBeChecked();
      // The fixture has no finished Quality run: the choice already says the review cannot start, and why.
      await expect(page.getByTestId("semcfg-asvs-no-quality")).toBeVisible();
      await page.keyboard.press("Space");
      await expect(box).not.toBeChecked();
      await expect(page.getByTestId("semcfg-asvs-no-quality")).toHaveCount(0);

      // Select all: every method the build can run, then the list is cleared the same way.
      const all = page.getByRole("button", { name: words.all, exact: true });
      await all.focus();
      await page.keyboard.press("Enter");
      const available = page.locator('[data-testid="semcfg-methods"] input[type="checkbox"]:not([disabled])');
      const total = await available.count();
      expect(total).toBeGreaterThan(1);
      for (let i = 0; i < total; i++) await expect(available.nth(i)).toBeChecked();
      await expect(box).toBeChecked();
      await expect(all).toBeDisabled();
      expect(await serious(page, `methods ${language} ${width}`)).toEqual([]);
      const clear = page.getByRole("button", { name: words.clear, exact: true });
      await clear.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator('[data-testid="semcfg-methods"] input[type="checkbox"]:checked')).toHaveCount(0);
    }, page);
  });

  test(`${language} at ${width}px: without a Quality run the preview gives the reason and the review cannot start`, async ({ page }) => {
    await withApp(language, async ({ page, base, fixture }) => {
      await page.setViewportSize({ width, height: 900 });
      const started: string[] = [];
      await page.route("**/api/semantic/runs", async (route) => {
        if (route.request().method() === "POST") started.push(route.request().postData() ?? "");
        return route.continue();
      });
      const callsBefore = fixture.providerCalls();
      await openChoices(page, base, words);
      const box = page.locator(`[data-method="${METHOD}"]`).getByRole("checkbox");
      await box.focus();
      await page.keyboard.press("Space");
      // General review stays selected beside it: the refusal of one method refuses the plan, with its code.
      const show = page.getByTestId("semsetup-show-preview");
      await show.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("semsetup-preview")).toBeVisible();
      const blocker = page.locator('[data-testid="semsetup-blockers"] [data-blocker="ASVS_REVIEW_NO_QUALITY_RUN"]');
      await expect(blocker).toBeVisible();
      await expect(blocker).toContainText(words.noQuality);
      await expect(page.getByTestId("semsetup-start")).toBeDisabled();
      // Nothing to confirm: the cost section only exists when there is something to review.
      await expect(page.getByTestId("semsetup-asvs")).toHaveCount(0);
      expect(await serious(page, `refusal ${language} ${width}`)).toEqual([]);
      expect(started).toEqual([]);
      expect(fixture.providerCalls()).toBe(callsBefore);
    }, page);
  });

  test(`${language} at ${width}px: the preview shows the number of requirements and the cost, and Start waits for the confirmation`, async ({ page }) => {
    await withApp(language, async ({ page, base, fixture }) => {
      await page.setViewportSize({ width, height: 900 });
      const started: string[] = [];
      await page.route("**/api/semantic/runs", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        started.push(route.request().postData() ?? "");
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, status: "OK", gate: "semantic", run: { runId: "sem_20261114T110000Z_bbbb0009", lifecycle: "running" }, methods: [] }) });
      });
      // The scope preview of a workspace that has a finished Quality run: the real answer, made ready, with the plan of the review.
      await page.route("**/api/semantic/scope/preview", async (route) => {
        const real = await route.fetch();
        const json = await real.json();
        json.ready = true;
        json.blockers = [];
        json.asvsReview = { qualityRun: "run_20261114T090000Z_cccc0001", asvsVersion: "5.0.0", level: 1, count: 12, requirements: [], units: [{ id: "V6" }, { id: "V8" }, { id: "V13" }], budget: { maxCalls: 40, maxTokens: null } };
        return route.fulfill({ response: real, json });
      });
      const callsBefore = fixture.providerCalls();
      await openChoices(page, base, words);
      const box = page.locator(`[data-method="${METHOD}"]`).getByRole("checkbox");
      await box.focus();
      await page.keyboard.press("Space");
      const show = page.getByTestId("semsetup-show-preview");
      await show.focus();
      await page.keyboard.press("Enter");

      const section = page.getByTestId("semsetup-asvs");
      await expect(section).toBeVisible();
      await expect(section).toHaveAttribute("data-count", "12");
      await expect(page.getByTestId("semsetup-asvs-count")).toContainText(words.count);
      await expect(section).toContainText(words.ai);
      const start = page.getByTestId("semsetup-start");
      await expect(start).toBeDisabled();
      expect(await serious(page, `confirmation ${language} ${width}`)).toEqual([]);

      const confirm = page.getByTestId("semsetup-asvs-confirm");
      await expect(page.getByText(words.confirm)).toBeVisible();
      await confirm.focus();
      await page.keyboard.press("Space");
      await expect(start).toBeEnabled();
      expect(started).toEqual([]);
      await start.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => started.length).toBe(1);
      expect(JSON.parse(started[0] as string).methods).toContain(METHOD);
      await expect.poll(() => new URL(page.url()).hash).toMatch(/^#\/semantic\/runs\/sem_/);
      expect(fixture.providerCalls()).toBe(callsBefore);
    }, page);
  });

  test(`${language} at ${width}px: the result lists the requirements examined and not examinable with their reasons, as an AI review of the source`, async ({ page }) => {
    await withApp(language, async ({ page, base }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}#/semantic/results/${RUN}`);
      await reloadPage(page);
      await expect(page.getByTestId("semantic-results")).toBeVisible();
      const section = page.getByTestId("semres-asvsr");
      await expect(section).toBeVisible();
      await expect(page.getByTestId("semres-asvsr-ai")).toContainText(words.ai);
      const examined = page.getByTestId("semres-asvsr-examined");
      await expect(examined).toHaveAttribute("data-count", "3");
      await expect(examined).toContainText(words.examined);
      await expect(examined.locator('[data-requirement="V6.2.2"]')).toHaveAttribute("data-outcome", "finding");
      await expect(examined.locator('[data-requirement="V6.2.1"]')).toHaveAttribute("data-outcome", "no-violation-found");
      const not = page.getByTestId("semres-asvsr-not-examinable");
      await expect(not).toHaveAttribute("data-count", "2");
      await expect(not).toContainText(words.notExaminable);
      await expect(not.locator('[data-requirement="V13.2.1"]')).toContainText(words.reason);
      await expect(not.locator('[data-requirement="V14.1.1"]')).toHaveAttribute("data-reason", "person");
      // The official requirement text is never shown here: only the ids.
      await expect(section).not.toContainText(/Verify that/i);
      await expect(page.getByTestId("semres-methods")).toContainText(words.label);
      expect(await serious(page, `result ${language} ${width}`)).toEqual([]);
    }, page);
  });
}

test("the Help screen and the history name the ASVS review in both languages", async ({ page }) => {
  for (const language of ["pt-BR", "en"] as const) {
    await withApp(language, async ({ page, base }) => {
      await page.goto(`${base}#/help`);
      await reloadPage(page);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText(`jgates semantic run --method ${METHOD}`)).toBeVisible();
      await page.goto(`${base}#/semantic`);
      await expect(page.locator(`tr[data-run="${RUN}"]`).getByTestId("semhist-methods")).toContainText(TEXT[language].label);
    }, page);
  }
});
