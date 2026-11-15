import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAIN, createGateFixture, openApp, startGateServer, type GateFixture } from "./support";

// "Tentar reproduzir" on the Semantic result (confirm-by-reproduction). Stored runs written the way the Semantic
// executor writes them (no model call, nothing executed): an earlier security-audit run with needs-validation
// findings, and the reproduction run that tried two of them. By keyboard, in pt-BR at 1280 px and in English at
// 375 px, with axe. The confirmation shows what the attempt may cost and nothing starts before it is confirmed.

const EARLIER = "sem_20261110T100000Z_aaaa0001";
const REPRODUCTION = "sem_20261112T100000Z_bbbb0002";
const SHA = "ab".repeat(32);
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const TEXT = {
  "pt-BR": {
    try: "Tentar reproduzir",
    all: (n: number) => `Tentar reproduzir todos (${n})`,
    network: /sem rede/,
    calls: /chamadas? ao modelo/,
    findings: /achados? será|serão tentados?/,
    confirmed: "Confirmado por execução",
    attempted: /Reprodução tentada: o teste passou/,
    needs: "Precisa de validação",
    runner: /nenhum executor de testes compatível/,
    engine: /não há motor de contêineres pronto/,
    deps: /dependências do projeto não estão preparadas/,
    prepare: "Preparar dependências",
    show: "Mostrar o teste e a saída",
  },
  en: {
    try: "Try to reproduce",
    all: (n: number) => `Try to reproduce all (${n})`,
    network: /without network/,
    calls: /model calls?/,
    findings: /findings? will? be tried|will be tried/,
    confirmed: "Confirmed by execution",
    attempted: /Reproduction attempted: the test passed/,
    needs: "Needs validation",
    runner: /no supported test runner/,
    engine: /no container engine ready/,
    deps: /dependencies of the project are not prepared/,
    prepare: "Prepare dependencies",
    show: "Show the test and its output",
  },
} as const;

async function workspaceIdOf(fixture: GateFixture): Promise<string> {
  const mod = await import(pathToFileURL(path.join(path.dirname(MAIN), "..", "core", "ids", "index.js")).href);
  return mod.workspaceId(fixture.dir);
}

const candidate = (id: string, title: string, file: string, status: string) => ({ id, title, path: file, line: 1, severity: "important", category: "security", status, rationale: `${title}: needs a test to settle`, details: {} });
const CANDIDATES = [
  candidate("C1", "A value reaches a query unchecked", "src/core/a.js", "needs-validation"),
  candidate("C2", "A path is joined without a check", "src/other/b.js", "needs-validation"),
  candidate("C3", "A request is built from user input", "src/svc/main.go", "needs-validation"),
  candidate("C4", "A secret is logged", "src/core/a.js", "confirmed"),
];

function settledResult(methods: string[], investigation: Record<string, unknown>, findings: Array<Record<string, unknown>>) {
  return {
    schemaVersion: 1,
    gate: "semantic",
    decision: "passed",
    complete: true,
    partial: false,
    exitCode: 0,
    startedAt: "2026-11-10T10:00:00.000Z",
    finishedAt: "2026-11-10T10:05:00.000Z",
    summary: "Stored review.",
    stages: [],
    semanticRun: { methods, outcome: { state: "complete", provider: "mock", model: "scripted-model", calls: 4, conclusion: { findings }, investigation } },
  };
}

/** The earlier run: four findings, three of them needs-validation. */
function writeEarlierRun(fixture: GateFixture, workspace: string): void {
  const dir = path.join(fixture.home, "workspaces", workspace, "semantic-runs", EARLIER);
  fs.mkdirSync(dir, { recursive: true });
  const findings = CANDIDATES.map((c) => ({ severity: c.severity, confirmation: c.status === "confirmed" ? "confirmed" : "needs-validation", category: c.category, message: c.title, path: c.path, line: c.line }));
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(settledResult(["security-audit"], { module: { id: "security-audit" }, candidates: CANDIDATES, stages: [], coverage: null }, findings)));
}

/** The reproduction run: C1 reproduced (executed, failed, attributed to the defect), C2 attempted (the test passed). */
function writeReproductionRun(fixture: GateFixture, workspace: string): void {
  const dir = path.join(fixture.home, "workspaces", workspace, "semantic-runs", REPRODUCTION);
  fs.mkdirSync(path.join(dir, "evidence", "confirm-by-reproduction"), { recursive: true });
  const finding = (c: (typeof CANDIDATES)[number], n: number) => ({ id: `F${n}`, runId: EARLIER, candidateId: c.id, method: "security-audit", fingerprint: null, title: c.title, path: c.path, line: c.line, severity: c.severity });
  const reproducer = { path: ".jgates/regressions/test_value.test.mjs", runner: "node:test", sha256: SHA };
  const run = (outcome: string, pass: number, fail: number, output: string) => ({ executed: true, outcome, code: null, exitCode: fail > 0 ? 1 : 0, timedOut: false, tests: { total: 1, pass, fail, cancelled: 0 }, reason: null, output });
  const doc = {
    schemaVersion: 1,
    kind: "semantic-reproduction",
    method: "confirm-by-reproduction",
    evidenceBasis: "execution",
    seedRun: { runId: EARLIER, method: "security-audit" },
    findings: [
      { candidate: "C1", finding: finding(CANDIDATES[0]!, 1), outcome: "reproduced", confirmation: "confirmed", evidenceBasis: "execution", reason: null, detail: "the reproducer executed, failed, and the assessment attributes the failure to the defect", reproducer, execution: { executed: true, outcome: "failed", record: "evidence/confirm-by-reproduction/execution.json" }, assessment: { cause: "defect", reason: "the query is built from the value" }, proposal: null },
      { candidate: "C2", finding: finding(CANDIDATES[1]!, 2), outcome: "attempted", confirmation: "needs-validation", evidenceBasis: null, reason: "REPRODUCER_PASSED", detail: "the reproducer passed (1/1): the defect was not shown", reproducer: { ...reproducer, sha256: "cd".repeat(32) }, execution: { executed: true, outcome: "passed", record: "evidence/confirm-by-reproduction/execution.json" }, assessment: null, proposal: null },
    ],
    skipped: [{ runId: EARLIER, candidateId: "C3", title: CANDIDATES[2]!.title, path: CANDIDATES[2]!.path, code: "TEST_RUNNER_NOT_SUPPORTED", reason: "go test is not supported" }],
    counts: { findings: 2, reproduced: 1, attempted: 1, skipped: 1, executed: 2 },
    execution: "evidence/confirm-by-reproduction/execution.json",
    proposals: [],
  };
  fs.writeFileSync(path.join(dir, "evidence", "confirm-by-reproduction", "reproduction.json"), JSON.stringify(doc));
  fs.writeFileSync(
    path.join(dir, "evidence", "confirm-by-reproduction", "execution.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "semantic-reproduction-execution",
      seedRun: { runId: EARLIER, method: "security-audit" },
      executions: [
        { candidate: "C1", finding: { id: "F1", runId: EARLIER, candidateId: "C1", path: "src/core/a.js", line: 1 }, executed: true, reproducer, tree: "workspace-copy", run: run("failed", 0, 1, "not ok 1 - a() must reject the value\n  token=<masked>") },
        { candidate: "C2", finding: { id: "F2", runId: EARLIER, candidateId: "C2", path: "src/other/b.js", line: 1 }, executed: true, reproducer: { ...reproducer, sha256: "cd".repeat(32) }, tree: "workspace-copy", run: run("passed", 1, 0, "ok 1 - b() rejects the path") },
      ],
    }),
  );
  const accepted = { summary: "reproducer", defect: "a() accepts the value", test: { ...reproducer, content: "import test from 'node:test';\nimport assert from 'node:assert';\ntest('a() must reject the value', () => assert.fail('accepted'));\n" } };
  const result = settledResult(["confirm-by-reproduction"], { module: { id: "confirm-by-reproduction" }, candidates: [], stages: [{ id: "reproducer", state: "done", contexts: [{ candidate: "C1", status: "answered", accepted }] }], coverage: null }, []);
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ ...result, startedAt: "2026-11-12T10:00:00.000Z", finishedAt: "2026-11-12T10:05:00.000Z" }));
}

async function withReproduction(language: "pt-BR" | "en", options: { withReproductionRun: boolean }, body: (ctx: { page: Page; base: string; fixture: GateFixture }) => Promise<void>, page: Page): Promise<void> {
  const fixture = createGateFixture();
  const server = await (async () => {
    // A source file no test runner of the container recipes runs: its finding cannot be tried.
    fixture.write("src/svc/main.go", "package main\n\nfunc main() {}\n");
    fixture.git("add", "-A");
    fixture.git("commit", "-q", "-m", "add go file");
    fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ language }, null, 2)}\n`, { mode: 0o600 });
    const workspace = await workspaceIdOf(fixture);
    writeEarlierRun(fixture, workspace);
    if (options.withReproductionRun) writeReproductionRun(fixture, workspace);
    return startGateServer(fixture);
  })();
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

const row = (page: Page, candidate: string) => page.locator(`[data-testid="repro-cell"][data-candidate="${candidate}"]`);

for (const [language, width] of [["pt-BR", 1280], ["en", 375]] as const) {
  const words = TEXT[language];

  test(`${language} at ${width}px: each needs-validation finding offers the action, the cost is shown first and nothing starts before it is confirmed`, async ({ page }) => {
    await withReproduction(language, { withReproductionRun: false }, async ({ page, base, fixture }) => {
      await page.setViewportSize({ width, height: 900 });
      // The stored earlier run already counts its own model calls: nothing here may add one.
      const callsBefore = fixture.providerCalls();
      const started: string[] = [];
      await page.route("**/api/semantic/runs", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        started.push(route.request().postData() ?? "");
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, status: "OK", gate: "semantic", run: { runId: "sem_20261113T100000Z_cccc0003", lifecycle: "running" }, methods: [] }) });
      });
      await page.goto(`${base}#/semantic/results/${EARLIER}`);
      await expect(page.getByTestId("semantic-results")).toBeVisible();

      // The two findings a runner exists for offer the action; the one in Go shows it disabled with the reason; the confirmed one has none.
      await expect(row(page, "C1").getByTestId("repro-try")).toBeEnabled();
      await expect(row(page, "C2").getByTestId("repro-try")).toBeEnabled();
      await expect(row(page, "C1").getByRole("button", { name: words.try })).toBeVisible();
      await expect(row(page, "C3").getByTestId("repro-try")).toBeDisabled();
      await expect(row(page, "C3").getByTestId("repro-blocked")).toContainText(words.runner);
      await expect(row(page, "C4").getByTestId("repro-try")).toHaveCount(0);
      const all = page.getByTestId("repro-try-all");
      await expect(all).toHaveText(words.all(2));

      // By keyboard: the list action opens the confirmation with the cost, and Esc gives the focus back.
      await all.focus();
      await page.keyboard.press("Enter");
      const confirm = page.getByTestId("repro-confirm");
      await expect(confirm).toBeVisible();
      await expect(page.getByTestId("repro-cost-findings")).toHaveAttribute("data-count", "2");
      await expect(page.getByTestId("repro-cost-findings")).toContainText(words.findings);
      await expect(page.getByTestId("repro-cost-calls")).toContainText(words.calls);
      expect(Number(await page.getByTestId("repro-cost-calls").getAttribute("data-calls"))).toBeGreaterThan(0);
      await expect(page.getByTestId("repro-cost-container")).toContainText(words.network);
      expect(started).toEqual([]);
      expect(fixture.runFolders("semantic-runs")).toEqual([EARLIER]);
      expect(await serious(page, `confirmation ${language} ${width}`)).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(confirm).toHaveCount(0);
      await expect(all).toBeFocused();
      expect(started).toEqual([]);

      // One finding: the same cost for one finding; confirming starts one reproduction run of that finding.
      await row(page, "C2").getByTestId("repro-try").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("repro-cost-findings")).toHaveAttribute("data-count", "1");
      await page.getByTestId("repro-confirm-start").focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => started.length).toBe(1);
      expect(JSON.parse(started[0] as string)).toEqual({ methods: ["confirm-by-reproduction"], reproduction: { from: EARLIER, finding: "C2" } });
      await expect.poll(() => new URL(page.url()).hash).toMatch(/^#\/semantic\/runs\/sem_/);
      expect(fixture.providerCalls()).toBe(callsBefore);
    }, page);
  });

  test(`${language} at ${width}px: after the reproduction run the result shows the confirmed finding with its test and masked output, and the other as attempted`, async ({ page }) => {
    await withReproduction(language, { withReproductionRun: true }, async ({ page, base }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}#/semantic/results/${EARLIER}`);
      await expect(page.getByTestId("semantic-results")).toBeVisible();

      const c1 = row(page, "C1");
      await expect(c1).toHaveAttribute("data-state", "confirmed");
      await expect(c1).toContainText(words.confirmed);
      await expect(page.locator('tr[data-confirmation="confirmed"]')).toHaveCount(2);
      await expect(c1.getByRole("link").first()).toHaveAttribute("href", `#/semantic/results/${REPRODUCTION}`);
      await c1.getByRole("button", { name: words.show }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("repro-test-C1")).toContainText("a() must reject the value");
      await expect(page.getByTestId("repro-output-C1")).toContainText("not ok 1");
      await expect(page.getByTestId("repro-output-C1")).toContainText("<masked>");

      // The other one stays needs-validation, with the reason, and is never rejected.
      const c2 = row(page, "C2");
      await expect(c2).toHaveAttribute("data-state", "attempted");
      await expect(c2.getByTestId("repro-attempted")).toContainText(words.attempted);
      await expect(page.locator('tr[data-confirmation="needs-validation"]').filter({ has: page.locator('[data-candidate="C2"]') })).toHaveCount(1);
      await expect(page.locator('tr[data-confirmation="rejected"]')).toHaveCount(0);
      expect(words.needs.length).toBeGreaterThan(0);
      await expect(page.getByTestId("semres-confirmation")).toContainText(`${words.needs}: 2`);
      expect(await serious(page, `result ${language} ${width}`)).toEqual([]);

      // The reproduction run itself names the run it started from, and the history shows both.
      await page.goto(`${base}#/semantic/results/${REPRODUCTION}`);
      await expect(page.getByTestId("repro-reproduces")).toContainText(EARLIER);
      await expect(page.getByTestId("repro-try")).toHaveCount(0);
      await page.goto(`${base}#/semantic`);
      await expect(page.locator(`tr[data-run="${REPRODUCTION}"]`).getByTestId("semhist-reproduces")).toContainText(EARLIER);
      await expect(page.locator(`tr[data-run="${EARLIER}"]`).getByTestId("semhist-reproduction")).toBeVisible();
    }, page);
  });
}

test("with no container engine every finding shows the action disabled with the reason; with dependencies not prepared it offers to prepare them", async ({ page }) => {
  await withReproduction("pt-BR", { withReproductionRun: false }, async ({ page, base }) => {
    const words = TEXT["pt-BR"];
    let state = { notReady: ["engine"] };
    await page.route("**/api/environment/state", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, status: "OK", ready: false, ...state }) }));
    await page.goto(`${base}#/semantic/results/${EARLIER}`);
    await expect(page.getByTestId("semantic-results")).toBeVisible();
    for (const id of ["C1", "C2", "C3"]) {
      await expect(row(page, id).getByTestId("repro-try")).toBeDisabled();
    }
    await expect(row(page, "C1").getByTestId("repro-blocked")).toContainText(words.engine);
    await expect(page.getByTestId("repro-try-all")).toBeDisabled();
    await expect(page.getByTestId("repro-try-all")).toHaveText(words.all(0));
    expect(await serious(page, "no engine")).toEqual([]);

    state = { notReady: ["dependencies"] };
    // The history screen is shown before the result opens again, so the result asks the environment state anew.
    await page.goto(`${base}#/semantic`);
    await expect(page.locator(`tr[data-run="${EARLIER}"]`)).toBeVisible();
    await page.goto(`${base}#/semantic/results/${EARLIER}`);
    await expect(row(page, "C1").getByTestId("repro-blocked")).toContainText(words.deps);
    const prepare = row(page, "C1").getByRole("link", { name: words.prepare });
    await expect(prepare).toHaveAttribute("href", "#/environment?section=dependencies");
    // The finding in Go keeps its own reason: the runner, not the dependencies.
    await expect(row(page, "C3").getByTestId("repro-blocked")).toContainText(words.runner);
    await expect(page.getByTestId("repro-try-all")).toBeDisabled();
  }, page);
});
