import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAIN, createFixture, openApp, startServer, type Fixture } from "./support";

// PLAN-waivers section 7: a validation that passed with waivers reads "Aprovado com N dispensas" / "Approved with N waivers"
// wherever a decision is shown (the result, the ended run, the history, the overview tile, the Quality step of a sequence),
// with its own tone and icon and never as a plain approval. A finding the run waived shows the pill "Dispensado" / "Waived"
// with who dismissed it, why and until when. Stored runs, keyboard only, pt-BR and en, 1280 and 375 px, axe.

const RUN_ID = "run_20261113T100000Z_bbbbbbbb";
const SEQUENCE_ID = "seq_20261113T100500Z_cccccccc";

type Kind = "waivers" | "old" | "plain";

const WORDS = {
  "pt-BR": { waivers: "Aprovado com 2 dispensas", more: "Aprovado com 1 dispensa (3 achados)", plain: "Aprovado", pill: "Dispensado", noWaiverText: "Com waiver" },
  en: { waivers: "Approved with 2 waivers", more: "Approved with 1 waiver (3 findings)", plain: "Approved", pill: "Waived", noWaiverText: "Com waiver" },
} as const;

function finding(over: Record<string, unknown>) {
  return { stageId: "ruff#lint", tool: "ruff", ruleId: "F401", category: "style", severity: "warning", normalizedSeverity: "low", message: "os imported but unused", blocking: false, waived: false, fingerprint: "jgf1:aaaa", ...over };
}

const WAIVED_A = finding({ fingerprint: "jgf1:a1", ruleId: "E711", message: "Comparison to None", blocking: true, waived: true, waiverId: "w1", waiverReason: "False positive", waiverSource: "project", waiverExpires: "2027-03-01", location: { path: "demo/mod.py", line: 4 } });
const WAIVED_B = finding({ fingerprint: "jgf1:b2", ruleId: "F401", blocking: true, waived: true, waiverId: "w2", waiverReason: "Legacy code", waiverSource: "flag", location: { path: "demo/__init__.py", line: 1 } });
const ACTIVE = finding({ fingerprint: "jgf1:c3", ruleId: "E501", message: "Line too long", location: { path: "demo/util.py", line: 9 } });

function storedResult(fixture: Fixture, kind: Kind) {
  const withWaivers = kind !== "plain";
  const findings = withWaivers ? [WAIVED_A, WAIVED_B, ACTIVE] : [ACTIVE];
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    tool: "jgates",
    version: "0.0.0",
    startedAt: "2026-11-13T10:00:00.000Z",
    finishedAt: "2026-11-13T10:00:09.000Z",
    workspace: { id: "ws_x", path: fixture.dir },
    runDir: path.join(fixture.dir, "run"),
    selection: { adapter: "plan", options: {}, overrides: [], profile: "minimal", scope: "workspace" },
    decision: "passed",
    complete: true,
    reduced: false,
    exitCode: 0,
    requirements: [],
    stages: [{ id: "ruff#lint", label: "Ruff", adapter: "ruff", state: "completed", findings: findings.length, execution: { step: "ruff", durationMs: 1200 } }],
    findings,
    unsatisfied: [],
    warnings: [],
    blockingViolations: 0,
    disabled: [],
    // An old stored result has no `waivers` block: it is counted from its waived findings.
    ...(kind === "waivers" ? { waivers: { count: 2, findings: 2, applied: [], unmatched: [], stale: [], expired: [], refused: [] } } : {}),
    workspaceChanges: { checked: true, added: [], modified: [], removed: [] },
    artifacts: { result: "result.json", logs: [], outputs: [] },
  };
}

async function coreModule(name: string) {
  return import(pathToFileURL(path.join(path.dirname(MAIN), "..", "core", name)).href);
}

async function workspaceIdOf(fixture: Fixture): Promise<string> {
  return (await coreModule("ids/index.js")).workspaceId(fixture.dir);
}

/** The stored run written the way the runner writes it, and a settled sequence whose Quality step is that run. */
async function writeStored(fixture: Fixture, kind: Kind) {
  const workspaceId = await workspaceIdOf(fixture);
  const dir = path.join(fixture.home, "workspaces", workspaceId, "runs", RUN_ID);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(storedResult(fixture, kind)));
  const at = "2026-11-13T10:00:01.000Z";
  const event = (sequence: number, type: string, data: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, runId: RUN_ID, sequence, type, at, data });
  const lines = [event(1, "run-started", {}), event(2, "step-started", { step: "ruff#lint", label: "Ruff" }), event(3, "stage", { step: "ruff#lint", stageId: "ruff#lint", state: "completed" }), event(4, "step-finished", { step: "ruff#lint", status: "succeeded", durationMs: 1200 }), event(5, "run-finished", { decision: "passed" })];
  fs.writeFileSync(path.join(dir, "events.jsonl"), `${lines.join("\n")}\n`);

  const store = await coreModule("sequence/store.js");
  const seqDir = store.sequenceDir(fixture.home, workspaceId, SEQUENCE_ID);
  store.writeSequence(
    seqDir,
    { schemaVersion: 1, sequenceId: SEQUENCE_ID, createdAt: "2026-11-13T10:05:00.000Z", selectedGates: ["quality"], runs: [{ gate: "quality", runId: RUN_ID }], advancement: { condition: "none" }, status: "completed" },
    {
      schemaVersion: 1,
      sequenceId: SEQUENCE_ID,
      workspace: { id: workspaceId, path: fixture.dir },
      selection: { gates: ["quality"] },
      request: {},
      plans: { quality: null, semantic: null },
      quality: { runId: RUN_ID, decision: "passed", complete: true, reduced: false, exitCode: 0, runDir: dir, reuse: null },
      assessment: null,
      semantic: null,
      coverage: null,
      preflight: [],
      timeline: [],
    },
  );
}

async function withRun(page: Page, kind: Kind, body: (ctx: { fixture: Fixture; base: string }) => Promise<void>) {
  const fixture = createFixture();
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    await writeStored(fixture, kind);
    server = await startServer(fixture);
    const base = await openApp(page, server);
    await body({ fixture, base });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

function setLanguage(fixture: Fixture, language: "pt-BR" | "en") {
  const prefs = path.join(fixture.home, "preferences.json");
  const stored = fs.existsSync(prefs) ? JSON.parse(fs.readFileSync(prefs, "utf8")) : { schemaVersion: 1, theme: "system" };
  fs.writeFileSync(prefs, `${JSON.stringify({ ...stored, language }, null, 2)}\n`, { mode: 0o600 });
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

const iconOf = async (locator: Locator) => locator.locator("svg").first().innerHTML();

for (const language of ["pt-BR", "en"] as const) {
  const words = WORDS[language];

  test(`the result banner of a run that passed with waivers reads approved with 2 waivers, apart from a plain approval, and links to the dismissed findings (${language}, keyboard only)`, async ({ page }) => {
    let plainIcon = "";
    await withRun(page, "plain", async ({ fixture, base }) => {
      setLanguage(fixture, language);
      await page.goto(`${base}#/validations/result/${RUN_ID}`);
      await page.reload();
      const banner = page.getByTestId("result-banner");
      await expect(banner).toHaveAttribute("data-kind", "passed");
      await expect(page.getByTestId("result-banner-title")).toHaveText(words.plain);
      await expect(page.getByTestId("banner-waived-link")).toHaveCount(0);
      plainIcon = await iconOf(banner);
    });
    await withRun(page, "waivers", async ({ fixture, base }) => {
      setLanguage(fixture, language);
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${base}#/validations/result/${RUN_ID}`);
        await page.reload();
        const banner = page.getByTestId("result-banner");
        await expect(banner).toHaveAttribute("data-kind", "passed-waivers");
        await expect(page.getByTestId("result-banner-title")).toHaveText(words.waivers);
        // Its own tone and icon: not the green approval.
        await expect(banner).not.toHaveClass(/\bok\b/);
        expect(await iconOf(banner), "the icon differs from the plain approval").not.toBe(plainIcon);
        await noSidewaysScroll(page, `result at ${width}px`);
      }
      await page.setViewportSize({ width: 1280, height: 900 });

      // The link filters the findings to the dismissed ones, by keyboard.
      const cards = page.getByTestId("finding-card");
      await expect(cards).toHaveCount(3);
      await press(page, page.getByTestId("banner-waived-link"));
      await expect(cards).toHaveCount(2);
      await expect(page.getByTestId("filter-waived")).toBeChecked();
      for (const card of await cards.all()) await expect(card).toContainText(words.pill);
      await press(page, page.getByTestId("filter-waived"), "Space");
      await expect(cards).toHaveCount(3);

      // A waived finding: the pill, who dismissed it, why and until when; "Com waiver" is gone.
      const projectOne = page.locator('[data-testid="finding-card"][data-rule="E711"]');
      const info = projectOne.getByTestId("finding-waiver");
      await expect(info).toContainText(words.pill);
      await expect(info).toContainText("False positive");
      await expect(info).toContainText("2027-03-01");
      await expect(info).toContainText(language === "en" ? "project file" : "arquivo do projeto");
      const flagged = page.locator('[data-testid="finding-card"][data-rule="F401"]').getByTestId("finding-waiver");
      await expect(flagged).toContainText("Legacy code");
      await expect(flagged).toContainText("--waiver");
      await expect(page.locator('[data-testid="finding-card"][data-rule="E501"]').getByTestId("finding-waiver")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(words.noWaiverText);

      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    });
  });

  test(`the ended run, the history row, the overview tile and the Quality step of a sequence say approved with waivers, also for an old stored result (${language})`, async ({ page }) => {
    for (const kind of ["waivers", "old"] as const) {
      await withRun(page, kind, async ({ fixture, base }) => {
        setLanguage(fixture, language);

        // The ended state of the run screen.
        await page.goto(`${base}#/runs/${RUN_ID}`);
        await page.reload();
        await expect(page.getByTestId("run-state")).toHaveText(words.waivers, { timeout: 30_000 });
        await expect(page.getByTestId("result-banner-title")).toHaveText(words.waivers);

        // The history row.
        await page.goto(`${base}#/validations`);
        const decision = page.getByTestId("history-decision");
        await expect(decision).toHaveCount(1);
        await expect(decision).toHaveText(words.waivers);
        await expect(decision).toHaveAttribute("data-kind", "passed-waivers");

        // The last-validation tile of the overview.
        await page.goto(`${base}#/overview`);
        await expect(page.getByTestId("last-run-decision")).toHaveText(words.waivers);
        await expect(page.getByTestId("last-run-decision")).toHaveAttribute("data-kind", "passed-waivers");

        // The Quality step of a sequence.
        await page.goto(`${base}#/sequence/${SEQUENCE_ID}`);
        await expect(page.getByTestId("sequence-quality-state")).toHaveText(words.waivers);
        await expect(page.getByTestId("sequence-quality")).toHaveAttribute("data-approval", "with-waivers");
      });
    }
  });

  test(`a run without waivers keeps the plain approval everywhere (${language})`, async ({ page }) => {
    await withRun(page, "plain", async ({ fixture, base }) => {
      setLanguage(fixture, language);
      await page.goto(`${base}#/runs/${RUN_ID}`);
      await page.reload();
      await expect(page.getByTestId("result-banner-title")).toHaveText(words.plain);
      await page.goto(`${base}#/validations`);
      await expect(page.getByTestId("history-decision")).toHaveAttribute("data-kind", "passed");
      await page.goto(`${base}#/overview`);
      await expect(page.getByTestId("last-run-decision")).toHaveAttribute("data-kind", "passed");
      await page.goto(`${base}#/sequence/${SEQUENCE_ID}`);
      await expect(page.getByTestId("sequence-quality")).toHaveAttribute("data-approval", "");
    });
  });
}

test("the wording keeps the findings when they are more than the waivers", async ({ page }) => {
  await withRun(page, "waivers", async ({ fixture, base }) => {
    // One waiver that dismissed three findings (the ICU plural and the "(3 findings)" note).
    const dir = path.join(fixture.home, "workspaces", await workspaceIdOf(fixture), "runs", RUN_ID, "result.json");
    const doc = JSON.parse(fs.readFileSync(dir, "utf8"));
    doc.waivers = { count: 1, findings: 3, applied: [], unmatched: [], stale: [], expired: [], refused: [] };
    fs.writeFileSync(dir, JSON.stringify(doc));
    setLanguage(fixture, "en");
    await page.goto(`${base}#/validations/result/${RUN_ID}`);
    await page.reload();
    await expect(page.getByTestId("result-banner-title")).toHaveText(WORDS.en.more);
    setLanguage(fixture, "pt-BR");
    await page.reload();
    await expect(page.getByTestId("result-banner-title")).toHaveText(WORDS["pt-BR"].more);
  });
});
