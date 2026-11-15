import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAIN, createFixture, openApp, startServer, type Fixture } from "./support";

// "Dispensar" on a finding of the result (V2 waivers, PLAN-waivers.md section 7). A stored run with findings of two checks:
// every finding that is not waived has "Dispensar" / "Waive"; the dialog shows the finding, "Até quando?" with 30, 90 and
// 180 days and a date field, "Motivo" with four ready reasons that fill an editable field, and the entry that will be added
// to .jgates/waivers.json; it cannot be saved without a date, with a past date or with a reason under 3 characters. Saving
// writes exactly that entry to the project's file, the card says "Dispensado até <date>" with "Desfazer", the top of the
// result offers "Validar de novo", and undo puts the file back byte for byte. The stored result is never rewritten. A
// finding the run already waived offers "Remover dispensa"; "Dispensar" is disabled with its reason for a finding without a
// fingerprint and in governed mode; a finding of a check that did not complete says so. Focus starts inside the dialog, is
// trapped, and Esc asks before discarding a typed reason. Keyboard only, pt-BR at 1280 px and English at 375 px, axe.

const RUN_ID = "run_20261113T100000Z_bbbbbbbb";
const FILE = ".jgates/waivers.json";
const hex = (c: string) => `jgf1:${c.repeat(64)}`;

interface Texts {
  language: "pt-BR" | "en";
  waive: string;
  until: string;
  presets: string[];
  reasonTitle: string;
  reasons: string[];
  cancel: string;
  undo: string;
  removeWaiver: string;
  validateAgain: string;
  waivedUntil: (date: string) => string;
  summary: (n: number) => string;
  discardTitle: string;
  keepEditing: string;
  discard: string;
  incomplete: RegExp;
  noFingerprint: RegExp;
  governed: RegExp;
  reviewTitle: string;
}

const PT: Texts = {
  language: "pt-BR",
  waive: "Dispensar",
  until: "Até quando?",
  presets: ["30 dias", "90 dias", "180 dias"],
  reasonTitle: "Motivo",
  reasons: ["Falso positivo", "Código legado", "Código de teste ou de exemplo", "Risco aceito"],
  cancel: "Cancelar",
  undo: "Desfazer",
  removeWaiver: "Remover dispensa",
  validateAgain: "Validar de novo",
  waivedUntil: (date) => `Dispensado até ${date}`,
  summary: (n) => (n === 1 ? "1 achado dispensado aqui" : `${n} achados dispensados aqui`),
  discardTitle: "Descartar o que você digitou?",
  keepEditing: "Continuar editando",
  discard: "Descartar",
  incomplete: /não faz essa verificação passar/,
  noFingerprint: /não tem impressão digital/,
  governed: /travadas no modo governado/,
  reviewTitle: "Revisar a validação",
};

const EN: Texts = {
  language: "en",
  waive: "Waive",
  until: "Until when?",
  presets: ["30 days", "90 days", "180 days"],
  reasonTitle: "Reason",
  reasons: ["False positive", "Legacy code", "Test or example code", "Accepted risk"],
  cancel: "Cancel",
  undo: "Undo",
  removeWaiver: "Remove waiver",
  validateAgain: "Validate again",
  waivedUntil: (date) => `Waived until ${date}`,
  summary: (n) => (n === 1 ? "1 finding waived here" : `${n} findings waived here`),
  discardTitle: "Discard what you typed?",
  keepEditing: "Keep editing",
  discard: "Discard",
  incomplete: /does not make that check pass/,
  noFingerprint: /has no fingerprint/,
  governed: /locked in governed mode/,
  reviewTitle: "Review the validation",
};

const pad = (n: number) => String(n).padStart(2, "0");
function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function finding(over: Record<string, unknown>) {
  return { stageId: "ruff#lint", tool: "ruff", ruleId: "F401", category: "style", severity: "warning", normalizedSeverity: "low", message: "os imported but unused", blocking: false, waived: false, ...over };
}

/** Five findings: two waivable, one in a check that did not complete, one without a fingerprint, one waived by the project's file. */
const FINDINGS = [
  finding({ fingerprint: hex("a"), location: { path: "demo/mod.py", line: 1 } }),
  finding({ fingerprint: hex("b"), ruleId: "E711", message: "comparison to None", normalizedSeverity: "medium", location: { path: "demo/mod.py", line: 4 } }),
  finding({ fingerprint: hex("c"), stageId: "pytest#unit", tool: "pytest", ruleId: "collect-error", message: "could not collect the tests", location: { path: "demo/test_mod.py", line: 2 } }),
  finding({ ruleId: "E501", message: "line too long", location: { path: "demo/util.py", line: 9 } }),
  finding({ fingerprint: hex("d"), ruleId: "F841", message: "local variable is assigned to but never used", location: { path: "demo/__init__.py", line: 1 }, waived: true, waiverSource: "project", waiverId: hex("d"), waiverReason: "accepted before", waiverExpires: "2999-12-31" }),
];

const STAGES = [
  { id: "ruff#lint", label: "Ruff", adapter: "ruff", state: "completed", findings: 4 },
  { id: "pytest#unit", label: "pytest", adapter: "pytest", state: "error", findings: 1 },
];

function storedResult(fixture: Fixture) {
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
    decision: "incomplete",
    complete: false,
    reduced: false,
    exitCode: 2,
    requirements: [],
    stages: STAGES,
    findings: FINDINGS,
    unsatisfied: [],
    warnings: [],
    blockingViolations: 0,
    disabled: [],
    workspaceChanges: { checked: true, added: [], modified: [], removed: [] },
    artifacts: { result: "result.json", logs: [], outputs: [] },
  };
}

async function workspaceIdOf(fixture: Fixture): Promise<string> {
  const mod = await import(pathToFileURL(path.join(path.dirname(MAIN), "..", "core", "ids", "index.js")).href);
  return mod.workspaceId(fixture.dir);
}

/** The stored run, written the way the runner writes it, and the project's file with the entry that waived the last finding. */
async function writeProject(fixture: Fixture, language: "pt-BR" | "en"): Promise<string> {
  const dir = path.join(fixture.home, "workspaces", await workspaceIdOf(fixture), "runs", RUN_ID);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  const resultFile = path.join(dir, "result.json");
  fs.writeFileSync(resultFile, JSON.stringify(storedResult(fixture)));
  const event = (sequence: number, type: string) => JSON.stringify({ schemaVersion: 1, runId: RUN_ID, sequence, type, at: "2026-11-13T10:00:01.000Z", data: {} });
  fs.writeFileSync(path.join(dir, "events.jsonl"), `${event(1, "run-started")}\n${event(2, "run-finished")}\n`);
  fs.mkdirSync(path.join(fixture.dir, ".jgates"), { recursive: true });
  const entry = { tool: "ruff", rule: "F841", path: "demo/__init__.py", line: 1, reason: "accepted before", created: "2026-01-01", expires: "2999-12-31" };
  fs.writeFileSync(path.join(fixture.dir, FILE), `${JSON.stringify({ waivers: [entry] }, null, 2)}\n`);
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language }, null, 2)}\n`, { mode: 0o600 });
  return resultFile;
}

async function withProject(page: Page, language: "pt-BR" | "en", body: (ctx: { fixture: Fixture; base: string; resultFile: string }) => Promise<void>, env: Record<string, string> = {}) {
  const fixture = createFixture();
  Object.assign(fixture.env, env);
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    const resultFile = await writeProject(fixture, language);
    server = await startServer(fixture);
    const base = await openApp(page, server);
    await body({ fixture, base, resultFile });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}


async function tabTo(page: Page, target: Locator, max = 400): Promise<void> {
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`the keyboard never reached ${await target.evaluate((el) => el.outerHTML.slice(0, 200))}`);
}

async function press(page: Page, target: Locator, key = "Enter"): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press(key);
}

/** Types into a field the keyboard reached (no mouse). */
async function typeInto(page: Page, field: Locator, text: string): Promise<void> {
  await tabTo(page, field);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text);
}

/** A date field: the keyboard reaches it, and its value is set whole (the segments of a date input depend on the browser's locale). */
async function fillDate(page: Page, field: Locator, value: string): Promise<void> {
  await tabTo(page, field);
  await field.fill(value);
}

const entriesOf = (fixture: Fixture): Array<Record<string, any>> => {
  const doc = JSON.parse(fs.readFileSync(path.join(fixture.dir, FILE), "utf8"));
  return Array.isArray(doc) ? doc : doc.waivers;
};

const card = (page: Page, rule: string): Locator => page.getByTestId("finding-card").filter({ has: page.locator(`[data-testid="finding-rule"]`, { hasText: new RegExp(`^${rule}$`) }) });

async function openResult(page: Page, base: string): Promise<void> {
  await page.goto(`${base}#/validations/result/${RUN_ID}`);
  await page.reload();
  await expect(page.getByTestId("finding-card")).toHaveCount(FINDINGS.length);
}

async function axeClean(page: Page, selector: string): Promise<void> {
  const axe = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, "no horizontal scroll").toBeLessThanOrEqual(0);
}

const VARIANTS: Array<{ text: Texts; width: number; height: number }> = [
  { text: PT, width: 1280, height: 900 },
  { text: EN, width: 375, height: 800 },
];

for (const { text, width, height } of VARIANTS) {
  test(`dismissing a finding: the dialog, the exact entry, the card, "${text.validateAgain}" and undo, byte for byte (${text.language}, ${width} px, keyboard only)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await withProject(page, text.language, async ({ fixture, base, resultFile }) => {
      await openResult(page, base);
      const before = { result: fs.readFileSync(resultFile), waivers: fs.readFileSync(path.join(fixture.dir, FILE)) };
      const apiResult = () => page.evaluate(async (id) => (await fetch(`/api/results/${id}`, { headers: { accept: "application/json" } })).json(), RUN_ID);
      const storedBefore = (await apiResult()).result;

      // Every finding that is not waived has the button; the one without a fingerprint has it disabled, with the reason beside it.
      const waivable = ["F401", "E711", "collect-error"];
      for (const rule of waivable) await expect(card(page, rule).getByTestId("waive-button")).toBeEnabled();
      await expect(card(page, "F841").getByTestId("waive-button")).toHaveCount(0);
      const blocked = card(page, "E501");
      await expect(blocked.getByTestId("waive-button")).toBeDisabled();
      await expect(blocked.getByTestId("waive-blocked")).toHaveText(text.noFingerprint);
      await noSidewaysScroll(page);

      // A finding of a check that did not complete says that a waiver does not make the check pass.
      const incomplete = card(page, "collect-error");
      await press(page, incomplete.getByTestId("waive-button"));
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByTestId("waive-incomplete")).toHaveText(text.incomplete);
      await press(page, dialog.getByRole("button", { name: text.cancel }));
      await expect(dialog).toHaveCount(0);

      // The dialog of a finding: what it shows, focus inside, focus trapped.
      const first = card(page, "F401");
      await press(page, first.getByTestId("waive-button"));
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("waive-incomplete")).toHaveCount(0);
      await expect(dialog.getByTestId("waive-finding-tool")).toHaveText("ruff");
      await expect(dialog.getByTestId("waive-finding-rule")).toHaveText("F401");
      await expect(dialog.getByTestId("waive-finding-message")).toHaveText("os imported but unused");
      await expect(dialog.getByTestId("waive-finding-location")).toHaveText("demo/mod.py:1");
      await expect(dialog.getByText(text.until)).toBeVisible();
      for (const preset of text.presets) await expect(dialog.getByRole("button", { name: preset, exact: true })).toBeVisible();
      await expect(dialog.getByTestId("waive-date")).toBeVisible();
      await expect(dialog.getByText(text.reasonTitle, { exact: true })).toBeVisible();
      for (const reason of text.reasons) await expect(dialog.getByRole("button", { name: reason, exact: true })).toBeVisible();
      await expect(dialog.getByTestId("waive-entry")).toContainText(FILE);
      expect(await dialog.evaluate((el) => el.contains(document.activeElement)), "focus starts inside the dialog").toBe(true);
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab");
        expect(await dialog.evaluate((el) => el.contains(document.activeElement)), `focus stays inside after ${i + 1} Tab presses`).toBe(true);
      }
      await axeClean(page, "dialog");

      // Not saved without a date, with a past date, or with a reason under 3 characters.
      const save = dialog.getByTestId("waive-save");
      await expect(save).toBeDisabled();
      await typeInto(page, dialog.getByTestId("waive-reason"), "ab");
      await press(page, dialog.getByRole("button", { name: text.presets[0] as string, exact: true }));
      await expect(save, "reason too short").toBeDisabled();
      await typeInto(page, dialog.getByTestId("waive-reason"), "long enough");
      await expect(save).toBeEnabled();
      await fillDate(page, dialog.getByTestId("waive-date"), localDate(-1));
      await expect(dialog.getByTestId("waive-date-problem")).toBeVisible();
      await expect(save, "past date").toBeDisabled();
      await fillDate(page, dialog.getByTestId("waive-date"), "");
      await expect(save, "no date").toBeDisabled();

      // Esc asks before throwing away a typed reason; "keep editing" keeps it, "discard" closes.
      await page.keyboard.press("Escape");
      await expect(dialog.getByTestId("waive-discard")).toContainText(text.discardTitle);
      await press(page, dialog.getByRole("button", { name: text.keepEditing }));
      await expect(dialog.getByTestId("waive-reason")).toHaveValue("long enough");
      await page.keyboard.press("Escape");
      await press(page, dialog.getByRole("button", { name: text.discard, exact: true }));
      await expect(dialog).toHaveCount(0);
      expect(fs.readFileSync(path.join(fixture.dir, FILE)).equals(before.waivers), "nothing written yet").toBe(true);

      // The ready reasons fill the editable field; the 90 days preset sets the date; the entry is shown before saving.
      await press(page, first.getByTestId("waive-button"));
      await press(page, dialog.getByRole("button", { name: text.presets[1] as string, exact: true }));
      await expect(dialog.getByTestId("waive-date")).toHaveValue(localDate(90));
      await press(page, dialog.getByRole("button", { name: text.reasons[0] as string, exact: true }));
      await expect(dialog.getByTestId("waive-reason")).toHaveValue(text.reasons[0] as string);
      await typeInto(page, dialog.getByTestId("waive-reason"), `${text.reasons[0]} here`);
      const diff = dialog.getByTestId("waive-entry-diff");
      await expect(diff).toContainText("F401");
      await expect(diff).toContainText(localDate(90));
      await expect(diff).toContainText(`${text.reasons[0]} here`);
      await axeClean(page, "dialog");
      await press(page, dialog.getByTestId("waive-save"));
      await expect(dialog).toHaveCount(0);

      // The file holds exactly that entry; the card says until when and offers "Desfazer".
      const list = entriesOf(fixture);
      expect(list).toHaveLength(2);
      expect(list[1]).toMatchObject({ tool: "ruff", rule: "F401", path: "demo/mod.py", fingerprint: hex("a"), line: 1, reason: `${text.reasons[0]} here`, expires: localDate(90) });
      expect(fs.readFileSync(resultFile).equals(before.result), "result.json is not rewritten").toBe(true);
      const state = first.getByTestId("waive-state");
      await expect(state).toContainText(text.waivedUntil(localDate(90)));
      await expect(first.getByTestId("waive-button")).toHaveCount(0);
      const stored = (await apiResult()).result;
      expect({ decision: stored.decision, findings: stored.findings, exitCode: stored.exitCode }).toEqual({ decision: storedBefore.decision, findings: storedBefore.findings, exitCode: storedBefore.exitCode });
      await expect(page.getByTestId("waive-summary-text")).toHaveText(text.summary(1));

      // Undo restores the file byte for byte, and the summary goes away.
      await press(page, first.getByTestId("waive-undo"));
      await expect(first.getByTestId("waive-button")).toBeVisible();
      expect(fs.readFileSync(path.join(fixture.dir, FILE)).equals(before.waivers), "undo restores the file byte for byte").toBe(true);
      await expect(page.getByTestId("waive-summary")).toHaveCount(0);

      // Dismiss two findings; the top says how many and "Validar de novo" opens the review (same gate, target and profile).
      for (const [rule, preset] of [["F401", 0], ["E711", 2]] as const) {
        await press(page, card(page, rule).getByTestId("waive-button"));
        await press(page, dialog.getByRole("button", { name: text.presets[preset] as string, exact: true }));
        await typeInto(page, dialog.getByTestId("waive-reason"), "needed for now");
        await press(page, dialog.getByTestId("waive-save"));
        await expect(dialog).toHaveCount(0);
      }
      expect(entriesOf(fixture)).toHaveLength(3);
      await expect(page.getByTestId("waive-summary-text")).toHaveText(text.summary(2));
      await press(page, page.getByTestId("waive-validate-again"));
      await expect(page.getByRole("heading", { name: text.reviewTitle, level: 1 })).toBeVisible();
      const request = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem("jgates.validation.request") ?? "{}"));
      expect(request).toMatchObject({ gates: "quality", profile: "minimal", target: "full" });
      await noSidewaysScroll(page);
    });
  });
}

test("a finding the run already waived: Remover dispensa takes its entry out of the project's file, and Desfazer puts it back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withProject(page, "pt-BR", async ({ fixture, base }) => {
    await openResult(page, base);
    const original = fs.readFileSync(path.join(fixture.dir, FILE));
    const waived = card(page, "F841");
    await expect(waived.getByTestId("waive-button")).toHaveCount(0);
    await press(page, waived.getByTestId("waive-remove"));
    await expect(waived.getByTestId("waive-state")).toContainText("Dispensa removida");
    expect(entriesOf(fixture)).toHaveLength(0);
    await press(page, waived.getByTestId("waive-undo-remove"));
    await expect(waived.getByTestId("waive-remove")).toBeVisible();
    expect(fs.readFileSync(path.join(fixture.dir, FILE)).equals(original), "undo restores the file byte for byte").toBe(true);
  });
});

test("in governed mode Dispensar is disabled with the reason beside it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withProject(
    page,
    "en",
    async ({ fixture, base }) => {
      const original = fs.readFileSync(path.join(fixture.dir, FILE));
      await openResult(page, base);
      const first = card(page, "F401");
      await expect(first.getByTestId("waive-button")).toBeDisabled();
      await expect(first.getByTestId("waive-blocked")).toHaveText(EN.governed);
      expect(fs.readFileSync(path.join(fixture.dir, FILE)).equals(original)).toBe(true);
    },
    { JGATES_POLICY_DIR: "/etc/policies/company-policy", JGATES_POLICY_SHA256: "a".repeat(64) },
  );
});
