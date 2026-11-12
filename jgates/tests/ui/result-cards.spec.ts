import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAIN, createFixture, openApp, pageGet, startServer, type Fixture } from "./support";

// PLAN-guided-flows sections 5 and 6: the result reads at a glance. A stored run with one check in each state (passed,
// failed, incomplete, blocked, not applicable) and findings of three tools: every check is a card with its own icon and
// word, every finding a card with severity, tool, rule, message and a file:line link, filters by category (the mascot
// strip), severity and tool, the exports and "Copiar para o agente" on the screen; the run page is short with its logs
// closed and one step table that becomes cards at 375 px; the overview names the next step and its tiles; Ambiente
// opens with the doctor; History rows are cards at 375 px. Keyboard only, in pt-BR and en.

const RUN_ID = "run_20261112T100000Z_aaaaaaaa";

/** Name, tool, state and findings of the five checks (the same order as the stages of the stored run). */
const CHECKS = [
  { id: "ruff#lint", label: "Ruff", tool: "ruff", state: "completed", card: "passed", findings: 0, durationMs: 1200, duration: "1,2 s" },
  { id: "mypy#types", label: "Mypy", tool: "mypy", state: "completed", card: "failed", findings: 2, durationMs: 3400, duration: "3,4 s" },
  { id: "pytest#unit", label: "pytest", tool: "pytest", state: "error", card: "incomplete", findings: 0, durationMs: 800, duration: "800 ms" },
  { id: "codeql#sast", label: "CodeQL", tool: "codeql", state: "blocked", card: "blocked", findings: 0 },
  { id: "cargo#audit", label: "cargo audit", tool: "cargo-audit", state: "not_applicable", card: "not_applicable", findings: 0 },
] as const;

const WORDS = {
  "pt-BR": { passed: "Aprovada", failed: "Reprovada", incomplete: "Incompleta", blocked: "Bloqueada", not_applicable: "Não se aplica" },
  en: { passed: "Passed", failed: "Failed", incomplete: "Incomplete", blocked: "Blocked", not_applicable: "Not applicable" },
} as const;

function finding(over: Record<string, unknown>) {
  return { stageId: "mypy#types", tool: "mypy", ruleId: "assignment", category: "quality", severity: "error", normalizedSeverity: "high", message: "Incompatible types in assignment", blocking: true, waived: false, fingerprint: "fp", ...over };
}

const FINDINGS = [
  finding({ fingerprint: "f1", location: { path: "demo/mod.py", line: 7, column: 5 }, remediation: "Annotate the value with the declared type." }),
  finding({ fingerprint: "f2", ruleId: "return-value", normalizedSeverity: "medium", message: "Incompatible return value type", location: { path: "demo/util.py", line: 21 } }),
  finding({ fingerprint: "f3", stageId: "ruff#lint", tool: "ruff", ruleId: "F401", category: "style", normalizedSeverity: "low", severity: "warning", blocking: false, message: "os imported but unused", location: { path: "demo/__init__.py", line: 1 } }),
];

function storedResult(fixture: Fixture) {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    tool: "jgates",
    version: "0.0.0",
    startedAt: "2026-11-12T10:00:00.000Z",
    finishedAt: "2026-11-12T10:00:09.000Z",
    workspace: { id: "ws_x", path: fixture.dir },
    runDir: path.join(fixture.dir, "run"),
    selection: { adapter: "plan", options: {}, overrides: [], profile: "minimal", scope: "workspace" },
    decision: "failed",
    complete: false,
    reduced: false,
    exitCode: 1,
    requirements: [],
    stages: CHECKS.map((c) => ({
      id: c.id,
      label: c.label,
      adapter: c.tool,
      state: c.state,
      findings: c.findings,
      ...(c.card === "failed" ? { blockingViolations: 2 } : {}),
      ...(c.card === "blocked" ? { reason: "CodeQL ainda não foi preparado" } : {}),
      ..."durationMs" in c ? { execution: { step: c.tool, durationMs: c.durationMs } } : {},
    })),
    findings: FINDINGS,
    unsatisfied: [],
    warnings: [],
    blockingViolations: 2,
    disabled: [],
    workspaceChanges: { checked: true, added: [], modified: [], removed: [] },
    artifacts: { result: "result.json", logs: [], outputs: [] },
  };
}

async function workspaceIdOf(fixture: Fixture): Promise<string> {
  const mod = await import(pathToFileURL(path.join(path.dirname(MAIN), "..", "core", "ids", "index.js")).href);
  return mod.workspaceId(fixture.dir);
}

/** The stored run, written the way the runner writes it: result.json, a log folder and the events of its steps. */
async function writeStoredRun(fixture: Fixture) {
  const dir = path.join(fixture.home, "workspaces", await workspaceIdOf(fixture), "runs", RUN_ID);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(storedResult(fixture)));
  let sequence = 0;
  const event = (type: string, data: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, runId: RUN_ID, sequence: ++sequence, type, at: "2026-11-12T10:00:01.000Z", data });
  const lines = [event("run-started", {})];
  for (const c of CHECKS) {
    if (c.state === "blocked" || c.state === "not_applicable") {
      lines.push(event("step-skipped", { step: c.id, cause: "preflight" }));
      continue;
    }
    lines.push(event("step-started", { step: c.id, label: c.label }), event("stage", { step: c.id, stageId: c.id, state: c.state }));
    lines.push(event("step-finished", { step: c.id, status: c.state === "error" ? "failed" : "succeeded", durationMs: c.durationMs }));
    fs.writeFileSync(path.join(dir, "logs", `${c.tool}.stdout.log`), `${c.label} output\n`);
  }
  lines.push(event("run-finished", { decision: "failed" }));
  fs.writeFileSync(path.join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
}

async function withServer(page: Page, body: (ctx: { fixture: Fixture; base: string }) => Promise<void>) {
  const fixture = createFixture();
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    await writeStoredRun(fixture);
    server = await startServer(fixture);
    const base = await openApp(page, server);
    await body({ fixture, base });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

/** Focuses the control and presses the key: the keyboard path, never a mouse click. */
async function press(page: Page, locator: Locator, key = "Enter") {
  await locator.focus();
  await page.keyboard.press(key);
}

async function noSidewaysScroll(page: Page, what: string) {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, `${what}: no horizontal scroll`).toBeLessThanOrEqual(0);
}

function setLanguage(fixture: Fixture, language: "pt-BR" | "en") {
  const prefs = path.join(fixture.home, "preferences.json");
  const stored = fs.existsSync(prefs) ? JSON.parse(fs.readFileSync(prefs, "utf8")) : { schemaVersion: 1, theme: "system" };
  fs.writeFileSync(prefs, `${JSON.stringify({ ...stored, language }, null, 2)}\n`, { mode: 0o600 });
}

for (const language of ["pt-BR", "en"] as const) {
  test(`the result: a card per check with its own icon and word, a card per finding, filters, exports and the agent copy (${language}, keyboard only)`, async ({ page }) => {
    await withServer(page, async ({ fixture, base }) => {
      setLanguage(fixture, language);
      await page.goto(`${base}#/validations/result/${RUN_ID}`);
      await page.reload();
      const words = WORDS[language];

      // The checks: one card each, the state as an icon and a word, the tool, the duration and the findings.
      const cards = page.getByTestId("check-card");
      await expect(cards).toHaveCount(CHECKS.length);
      const icons = new Set<string>();
      for (const c of CHECKS) {
        const card = page.locator(`[data-testid="check-card"][data-stage="${c.id}"]`);
        await expect(card).toHaveAttribute("data-state", c.card);
        await expect(card).toContainText(words[c.card]);
        await expect(card.getByTestId("check-tool")).toHaveText(c.tool);
        await expect(card.getByTestId("check-findings")).toContainText(String(c.findings));
        if ("duration" in c) await expect(card.getByTestId("check-duration")).toContainText(c.duration);
        const pill = card.locator(".pill").first();
        await expect(pill.locator("svg")).toHaveCount(1);
        icons.add(await pill.locator("svg").innerHTML());
      }
      expect(icons.size, "each state has its own icon").toBe(CHECKS.length);

      // The findings: severity, tool, rule, message and a file:line link that opens the file at that line.
      const findings = page.getByTestId("finding-card");
      await expect(findings).toHaveCount(FINDINGS.length);
      const first = findings.first();
      await expect(first.getByTestId("finding-severity")).toHaveText(language === "en" ? "High" : "Alta");
      await expect(first.getByTestId("finding-tool")).toHaveText("mypy");
      await expect(first.getByTestId("finding-rule")).toHaveText("assignment");
      await expect(first.getByTestId("finding-message")).toHaveText("Incompatible types in assignment");
      const location = first.getByTestId("finding-location");
      await expect(location).toHaveText("demo/mod.py:7");
      await expect(location).toHaveAttribute("data-file", "demo/mod.py");
      await expect(location).toHaveAttribute("data-line", "7");
      const href = (await location.getAttribute("href")) as string;
      expect(href).toMatch(/^vscode:\/\/file\/.+demo\/mod\.py:7$/);
      expect(href.replace(/%20/g, " ")).toContain(fixture.dir.replace(/\\/g, "/").replace(/^\//, ""));
      await expect(first.getByTestId("finding-remediation")).toContainText("Annotate the value");

      // Filters by severity and by tool, by keyboard; the count follows.
      const severity = page.getByTestId("filter-severity");
      await severity.focus();
      await page.keyboard.press("ArrowDown");
      await expect(findings).toHaveCount(1);
      await expect(page.getByTestId("filter-count")).toContainText("1");
      await severity.selectOption("");
      await expect(findings).toHaveCount(FINDINGS.length);
      const tool = page.getByTestId("filter-tool");
      await tool.focus();
      await tool.selectOption("ruff");
      await expect(findings).toHaveCount(1);
      await expect(findings.first().getByTestId("finding-rule")).toHaveText("F401");
      await tool.selectOption("");
      await expect(findings).toHaveCount(FINDINGS.length);

      // The category filter is the mascot strip: choosing a category narrows the checks and the findings to it.
      const strip = page.getByTestId("quality-mascots");
      await expect(strip).toBeVisible();
      const detail = await pageGet(page, `/api/results/${RUN_ID}`);
      const domain = (detail.mascots?.domains ?? []).find((d: any) => d.checks.some((c: any) => CHECKS.some((k) => k.id === c.id)));
      if (domain) {
        const ids = domain.checks.map((c: any) => c.id);
        await press(page, strip.locator(`.quality-mascot[data-domain="${domain.domain}"] .quality-mascot-details`));
        await expect(cards).toHaveCount(CHECKS.filter((c) => ids.includes(c.id)).length);
        await expect(findings).toHaveCount(FINDINGS.filter((f) => ids.includes(f.stageId)).length);
        await press(page, page.getByRole("button", { name: language === "en" ? "Clear filter" : "Limpar filtro" }));
        await expect(cards).toHaveCount(CHECKS.length);
      }

      // Exports and the agent copy are on the screen.
      await expect(page.getByRole("button", { name: language === "en" ? "Export JSON" : "Exportar JSON" })).toBeVisible();
      await expect(page.getByRole("button", { name: language === "en" ? "Export SARIF" : "Exportar SARIF" })).toBeVisible();
      await expect(page.getByRole("button", { name: language === "en" ? "Copy for the agent" : "Copiar para o agente" })).toBeVisible();

      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    });
  });
}

for (const width of [1280, 375]) {
  test(`the run page is a summary, one step table and closed logs; it is short and nothing is cut (${width} px)`, async ({ page }) => {
    await withServer(page, async ({ base }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}#/runs/${RUN_ID}`);
      await expect(page.locator('tr[data-step="ruff#lint"]')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("result-banner")).toBeVisible();

      // A summary first, then one step table; the checks are not listed a second time.
      await expect(page.getByTestId("run-state")).toBeVisible();
      await expect(page.getByTestId("check-cards")).toHaveCount(0);
      await expect(page.getByRole("table")).toHaveCount(1);
      const summaryTop = await page.locator(".run-summary").evaluate((e) => e.getBoundingClientRect().top);
      const tableTop = await page.locator(".vrun-steps-card").evaluate((e) => e.getBoundingClientRect().top);
      expect(summaryTop).toBeLessThan(tableTop);

      // Logs stay closed until opened, also the one of the step that errored.
      await expect(page.locator(".step-log")).toHaveCount(0);
      await expect(page.getByRole("region", { name: /^Log de / })).toHaveCount(0);
      const toggle = page.getByRole("button", { name: "Ver log de pytest" });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await press(page, toggle);
      await expect(page.getByRole("region", { name: "Log de pytest" })).toBeVisible();
      await press(page, page.getByRole("button", { name: "Ocultar log de pytest" }), "Space");
      await expect(page.getByRole("region", { name: "Log de pytest" })).toHaveCount(0);

      await noSidewaysScroll(page, "run page");
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      if (width === 1280) expect(height, "height of the run page at 1280 px").toBeLessThan(3000);

      // No column is cut: every cell is inside the card of the table.
      const card = await page.locator(".vrun-steps-card").evaluate((e) => e.getBoundingClientRect().right);
      const cells = await page.locator(".vrun-steps-card td, .vrun-steps-card th").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
      for (const right of cells) expect(right).toBeLessThanOrEqual(card + 0.5);

      if (width === 375) {
        // The table becomes stacked cards: each row a block, each value under its label.
        expect(await page.locator('tr[data-step="ruff#lint"]').evaluate((e) => getComputedStyle(e).display)).toBe("block");
        expect(await page.locator('tr[data-step="ruff#lint"] td').first().evaluate((e) => getComputedStyle(e, "::before").content)).toMatch(/Estado/);
      } else {
        expect(await page.locator('tr[data-step="ruff#lint"]').evaluate((e) => getComputedStyle(e).display)).toBe("table-row");
      }
    });
  });
}

test("the overview names the next step after a validation that did not pass, its tiles name the checks, and Ambiente opens with the doctor", async ({ page }) => {
  await withServer(page, async ({ base }) => {
    await page.goto(`${base}#/overview`);
    await expect(page.getByTestId("last-run")).toBeVisible();

    // The first step (after the environment's, when it has one) is to open the result.
    const step = page.locator('[data-testid="next-steps"] li[data-step="result"]');
    await expect(step).toBeVisible();
    await expect(step).toContainText("Reprovado");
    const open = step.getByRole("link", { name: "Abrir o resultado" });
    await expect(open).toHaveAttribute("href", `#/validations/result/${RUN_ID}`);
    await expect(page.locator('[data-testid="next-steps"] li[data-step="03"]')).toHaveAttribute("data-pending", "false");
    await expect(page.getByText("Em dia", { exact: true })).toHaveCount(0);

    // The tiles carry the name of the check and its state in words.
    for (const c of CHECKS) {
      const tile = page.locator(`[data-testid="stage-segments"] li[data-stage="${c.id}"]`);
      await expect(tile).toContainText(c.label);
      await expect(tile).toHaveAttribute("data-state", c.state);
    }
    await expect(page.locator('li[data-stage="codeql#sast"]')).toContainText("Bloqueada");
    await press(page, open);
    await expect(page).toHaveURL(new RegExp(`#/validations/result/${RUN_ID}`));
    await expect(page.getByTestId("result-banner")).toBeVisible();

    // Ambiente: the doctor is its header, and the CodeQL link of the doctor card lands on its section.
    await page.goto(`${base}#/environment?section=codeql`);
    const head = page.getByTestId("env-head");
    await expect(head).toBeVisible();
    await expect(head.locator('[data-mascot="doctor"]')).toHaveCount(1);
    await expect(head.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("#env-h-codeql")).toBeFocused();
  });
});

test("History rows are stacked cards at 375 px and a table at 1280 px", async ({ page }) => {
  await withServer(page, async ({ base }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base}#/validations`);
    const row = page.locator(`tr[data-run="${RUN_ID}"]`);
    await expect(row).toBeVisible();
    expect(await row.evaluate((e) => getComputedStyle(e).display)).toBe("table-row");

    await page.setViewportSize({ width: 375, height: 800 });
    expect(await row.evaluate((e) => getComputedStyle(e).display)).toBe("block");
    expect(await page.locator("thead").first().evaluate((e) => e.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    await expect(row.locator("td[data-label]").first()).toBeVisible();
    const box = await row.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(375);
    await noSidewaysScroll(page, "history");
    // The link of the run is still reachable by keyboard and opens its result.
    await press(page, row.getByRole("link", { name: RUN_ID }));
    await expect(page).toHaveURL(new RegExp(`#/validations/result/${RUN_ID}`));
  });
});
