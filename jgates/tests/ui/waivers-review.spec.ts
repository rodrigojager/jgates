import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAIN, createFixture, openApp, startServer, wizardFixture, type Fixture, type UiServer } from "./support";

// The review lists the project's waivers before running, each removable with one click (V2 waivers, PLAN-waivers.md
// section 8). With the Quality gate selected and entries in .jgates/waivers.json the review shows "Dispensas do projeto"
// / "Waivers of the project" between what will run and the terminal command: one row per waiver (tool, rule, file and
// line as last seen, or the rule and path of a hand-written one; reason; date; whether it matched something in the last
// validation), "Remover" removes the entry from the file and "Desfazer" restores it byte for byte. Expired and stale
// entries are marked and do not count; a file that cannot be read shows the warning with the link that opens it; the
// summary counts what will apply. The section is absent without entries and the wizard's review shows it too.
// Keyboard only, pt-BR at 1280 px and English at 375 px, axe on the section.

const REQUEST_KEY = "jgates.validation.request";
const FILE = ".jgates/waivers.json";

interface Texts {
  language: "pt-BR" | "en";
  heading: string;
  remove: string;
  undo: string;
  expired: (date: string) => string;
  stale: string;
  matched: RegExp;
  unmatched: string;
  openFile: RegExp;
  reviewTitle: string;
}

const PT: Texts = {
  language: "pt-BR",
  heading: "Dispensas do projeto",
  remove: "Remover",
  undo: "Desfazer",
  expired: (date) => `venceu em ${date}`,
  stale: "o arquivo mudou",
  matched: /dispensou 1 achado na última validação/,
  unmatched: "não encontrou nada na última validação",
  openFile: /^Abrir \.jgates\/waivers\.json/,
  reviewTitle: "Revisar a validação",
};

const EN: Texts = {
  language: "en",
  heading: "Waivers of the project",
  remove: "Remove",
  undo: "Undo",
  expired: (date) => `expired on ${date}`,
  stale: "the file changed",
  matched: /waived 1 finding in the last validation/,
  unmatched: "found nothing in the last validation",
  openFile: /^Open \.jgates\/waivers\.json/,
  reviewTitle: "Review the validation",
};

function setLanguage(fixture: Fixture, language: "pt-BR" | "en"): void {
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language }, null, 2)}\n`, { mode: 0o600 });
}

const waiverPath = (fixture: Fixture): string => path.join(fixture.dir, FILE);
const readWaivers = (fixture: Fixture): Buffer => fs.readFileSync(waiverPath(fixture));
const entriesOf = (fixture: Fixture): Array<Record<string, unknown>> => {
  const doc = JSON.parse(readWaivers(fixture).toString("utf8"));
  return Array.isArray(doc) ? doc : doc.waivers;
};

function cli(fixture: Fixture, ...args: string[]) {
  return spawnSync(process.execPath, [MAIN, ...args], { env: fixture.env, encoding: "utf8", timeout: 180_000 });
}

/** The newest result.json under the fixture's home (the stored validation the review compares the waivers with). */
function lastResult(fixture: Fixture): any {
  let best: { file: string; time: number } | null = null;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") {
        const time = fs.statSync(full).mtimeMs;
        if (!best || time > best.time) best = { file: full, time };
      }
    }
  };
  walk(fixture.home);
  if (!best) throw new Error("the validation stored no result.json");
  return JSON.parse(fs.readFileSync((best as { file: string }).file, "utf8"));
}

/**
 * A project with one finding waived from the stored result (a live occurrence waiver that matched), a hand-written live
 * waiver that matched nothing, an expired one, a stale one (its anchor no longer matches a line of the same rule and
 * file) and the file shape kept as the command wrote it.
 */
function projectWithWaivers(language: "pt-BR" | "en"): { fixture: Fixture; finding: any } {
  const fixture = createFixture();
  setLanguage(fixture, language);
  cli(fixture, "run", "--cwd", fixture.dir, "--json");
  const finding = (lastResult(fixture).findings as any[]).find((f) => f.fingerprint && f.location?.path);
  expect(finding, "the first validation has a finding to waive").toBeTruthy();
  const short = String(finding.fingerprint).replace(/^jgf1:/, "").slice(0, 12);
  const added = cli(fixture, "waivers", "add", "--cwd", fixture.dir, "--finding", short, "--until", "2999-12-31", "--reason", "accepted for now", "--yes", "--json");
  expect(added.status, `${added.stdout}${added.stderr}`).toBe(0);
  const doc = JSON.parse(readWaivers(fixture).toString("utf8"));
  const list: Array<Record<string, unknown>> = Array.isArray(doc) ? doc : doc.waivers;
  list.push({ rule: "ZZ999", path: "nowhere/**", reason: "written by hand", expires: "2999-12-31" });
  list.push({ rule: "ZZ998", path: "old/**", reason: "an old decision", expires: "2020-01-01" });
  list.push({ tool: finding.tool, rule: finding.ruleId, path: finding.location.path, anchor: `jga1:${"0".repeat(64)}`, line: 1, reason: "the line moved", expires: "2999-12-31" });
  fs.writeFileSync(waiverPath(fixture), `${JSON.stringify(doc, null, 2)}\n`);
  return { fixture, finding };
}

async function tabTo(page: Page, target: Locator, max = 300): Promise<void> {
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

async function openReview(page: Page, server: UiServer, text: Texts, request: Record<string, unknown>): Promise<void> {
  const base = await openApp(page, server);
  await page.evaluate(([key, value]) => window.sessionStorage.setItem(key as string, value as string), [REQUEST_KEY, JSON.stringify(request)]);
  await page.goto(`${base}#/validations/review`);
  await page.reload();
  await expect(page.getByRole("heading", { name: text.reviewTitle, level: 1 })).toBeVisible();
  await expect(page.locator('[role="status"].spinner-text')).toHaveCount(0, { timeout: 90_000 });
}

const QUALITY = { gates: "quality", manualAdvance: false, profile: "minimal", target: "full", path: "", head: "", base: "", skip: [] as string[] };

async function noSidewaysScroll(page: Page, where: string): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(0);
}

async function checks(page: Page, fixture: Fixture, finding: any, text: Texts, narrow: boolean): Promise<void> {
  const section = page.getByTestId("waivers-review");
  await expect(section).toBeVisible();
  await expect(section.getByRole("heading", { name: text.heading })).toBeVisible();

  // Between what will run and the terminal command.
  const order = await page.evaluate(() => {
    const ids = ["group-will-run", "waivers-review"];
    const nodes = ids.map((id) => document.querySelector(`[data-testid="${id}"]`));
    const terminal = document.querySelector('[data-testid="equivalent-command"]');
    const follows = (a: Element | null, b: Element | null) => Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return [follows(nodes[0] ?? null, nodes[1] ?? null), follows(nodes[1] ?? null, terminal)];
  });
  expect(order, "the section sits between what will run and the terminal command").toEqual([true, true]);

  // One row per waiver, with what it dismisses.
  const rows = section.getByTestId("waiver-row");
  await expect(rows).toHaveCount(4);
  const live = rows.filter({ hasText: text.matched });
  await expect(live).toHaveCount(1);
  await expect(live.getByTestId("waiver-rule")).toContainText(String(finding.ruleId));
  await expect(live.getByTestId("waiver-place")).toContainText(String(finding.location.path));
  await expect(live.getByTestId("waiver-reason")).toHaveText("accepted for now");
  await expect(live.getByTestId("waiver-meta")).toContainText("2999-12-31");
  const handwritten = rows.filter({ hasText: "ZZ999" });
  await expect(handwritten.getByTestId("waiver-place")).toHaveText("nowhere/**");
  await expect(handwritten.getByTestId("waiver-reason")).toHaveText("written by hand");
  await expect(handwritten.getByTestId("waiver-matched")).toHaveText(text.unmatched);

  // Expired and stale ones are marked, removable and do not apply; the summary counts the two that will apply.
  const expired = rows.filter({ hasText: "ZZ998" });
  await expect(expired).toHaveAttribute("data-state", "expired");
  await expect(expired).toHaveAttribute("data-applies", "false");
  await expect(expired).toContainText(text.expired("2020-01-01"));
  const stale = rows.filter({ hasText: text.stale });
  await expect(stale).toHaveCount(1);
  await expect(stale).toHaveAttribute("data-state", "stale");
  await expect(stale).toHaveAttribute("data-applies", "false");
  await expect(stale.getByRole("button", { name: new RegExp(`^${text.remove}`) })).toBeEnabled();
  await expect(expired.getByRole("button", { name: new RegExp(`^${text.remove}`) })).toBeEnabled();
  await expect(page.getByTestId("review-waivers-count")).toHaveAttribute("data-count", "2");
  await expect(section.getByTestId("waivers-applying")).toBeVisible();
  if (narrow) await noSidewaysScroll(page, "waivers section");

  const axe = await new AxeBuilder({ page }).include('[data-testid="waivers-review"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);

  // One click, from the keyboard: the entry leaves the file; "Desfazer" puts the file back byte for byte.
  const before = readWaivers(fixture);
  expect(entriesOf(fixture)).toHaveLength(4);
  await press(page, live.getByRole("button", { name: new RegExp(`^${text.remove}`) }));
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId("review-waivers-count")).toHaveAttribute("data-count", "1");
  const after = entriesOf(fixture);
  expect(after).toHaveLength(3);
  expect(after.some((e) => e.reason === "accepted for now")).toBe(false);
  const undo = section.getByTestId("waivers-undo");
  await expect(undo).toBeVisible();
  await press(page, undo.getByRole("button", { name: text.undo }));
  await expect(rows).toHaveCount(4);
  expect(readWaivers(fixture).equals(before), "undo restores the file byte for byte").toBe(true);
  await expect(page.getByTestId("review-waivers-count")).toHaveAttribute("data-count", "2");

  // Removing an expired one works the same way.
  await press(page, expired.getByRole("button", { name: new RegExp(`^${text.remove}`) }));
  await expect(rows).toHaveCount(3);
  expect(entriesOf(fixture).some((e) => e.rule === "ZZ998")).toBe(false);
}

for (const [text, width, height] of [
  [PT, 1280, 900],
  [EN, 375, 800],
] as const) {
  test(`the review lists the project's waivers and removes them with one click (${text.language}, ${width}px)`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width, height });
    const { fixture, finding } = projectWithWaivers(text.language);
    let server: UiServer | null = null;
    try {
      server = await startServer(fixture);
      await openReview(page, server, text, QUALITY);
      await checks(page, fixture, finding, text, width < 600);

      // Only the Semantic gate is selected: the section is not there.
      await page.evaluate(([key, value]) => window.sessionStorage.setItem(key as string, value as string), [REQUEST_KEY, JSON.stringify({ ...QUALITY, gates: "semantic" })]);
      await page.reload();
      await expect(page.getByRole("heading", { name: text.reviewTitle, level: 1 })).toBeVisible();
      await expect(page.getByTestId("waivers-review")).toHaveCount(0);
    } finally {
      await server?.stop();
      fixture.cleanup();
    }
  });

  test(`a waiver file that cannot be read shows the warning with the link that opens it, and no file means no section (${text.language}, ${width}px)`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width, height });
    const fixture = createFixture();
    setLanguage(fixture, text.language);
    let server: UiServer | null = null;
    try {
      server = await startServer(fixture);
      // No file: the section is absent.
      await openReview(page, server, text, QUALITY);
      await expect(page.getByTestId("group-will-run")).toBeVisible();
      await expect(page.getByTestId("waivers-review")).toHaveCount(0);

      // A file that is not JSON: the warning names it, and its link opens the file in the editor.
      fs.mkdirSync(path.dirname(waiverPath(fixture)), { recursive: true });
      fs.writeFileSync(waiverPath(fixture), "{ not json");
      const broken = readWaivers(fixture);
      await page.reload();
      await expect(page.getByRole("heading", { name: text.reviewTitle, level: 1 })).toBeVisible();
      const problem = page.getByTestId("waivers-problem");
      await expect(problem).toBeVisible({ timeout: 90_000 });
      const link = problem.getByRole("link", { name: text.openFile });
      await expect(link).toHaveAttribute("href", /#\/config\/yaml\?file=\.jgates%2Fwaivers\.json/);
      await expect(page.getByTestId("waivers-review").getByTestId("waiver-row")).toHaveCount(0);
      await press(page, link);
      await expect(page).toHaveURL(/#\/config\/yaml\?file=/);
      expect(readWaivers(fixture).equals(broken), "a file that cannot be read is never rewritten").toBe(true);
    } finally {
      await server?.stop();
      fixture.cleanup();
    }
  });
}

test("the wizard's review step shows the waivers when there is something to show (pt-BR)", async ({ page }) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const fixture = wizardFixture("pt-BR");
  let server: UiServer | null = null;
  try {
    fs.mkdirSync(path.join(fixture.dir, ".jgates"), { recursive: true });
    fs.writeFileSync(waiverPath(fixture), `${JSON.stringify({ waivers: [{ rule: "ZZ999", path: "nowhere/**", reason: "written by hand", expires: "2999-12-31" }] }, null, 2)}\n`);
    server = await startServer(fixture);
    await openApp(page, server);
    const wizard = page.locator('[data-state="wizard"]');
    const nav = wizard.getByTestId("wizard-nav");
    const heading = wizard.getByRole("heading", { level: 1 });
    const steps = ["Docker", "Ferramentas", "Projeto", "Perfil", "Dependências", "Revisão"];
    await expect(heading).toHaveText(`Passo 1 de 6 · ${steps[0]}`);
    await expect(wizard.getByTestId("wizard-engine")).toHaveAttribute("data-engine", "ready");
    for (const n of [2, 3, 4]) {
      await press(page, nav.getByRole("button", { name: "Continuar" }));
      await expect(heading).toHaveText(`Passo ${n} de 6 · ${steps[n - 1]}`);
    }
    await press(page, nav.getByRole("button", { name: "Salvar e continuar" }));
    await expect(heading).toHaveText(`Passo 5 de 6 · ${steps[4]}`, { timeout: 60_000 });
    await press(page, nav.getByRole("button", { name: "Pular por agora" }));
    await expect(heading).toHaveText(`Passo 6 de 6 · ${steps[5]}`);
    const section = wizard.getByTestId("waivers-review");
    await expect(section).toBeVisible({ timeout: 90_000 });
    await expect(section.getByRole("heading", { name: PT.heading })).toBeVisible();
    await expect(section.getByTestId("waiver-row")).toHaveCount(1);
    await expect(section.getByRole("button", { name: new RegExp(`^${PT.remove}`) })).toBeEnabled();
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
});
