import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAIN, createFixture, openApp, reloadPage, startServer, type Fixture } from "./support";
import type { AsvsMap } from "../../ui/src/screens/coverage-asvs";

// The ASVS coverage map (PLAN-asvs.md section 6, V2 slice AS10). Stored runs and a fixture mapping reach the five states;
// the screen shows:
//   - the five counters (a count each, no percentage) that filter the rows and clear again;
//   - a row of each state with its reason, the official text marked as English, and, on opening, the checks behind it
//     (which ran, what each covers and misses), what kind of evidence it awaits, or "no JGates check examines this";
//   - the level switch (70, 253 and 345 rows; it records the project's choice in .jgates/asvs.json);
//   - "Não se aplica" with a required reason (3 to 300 characters), the entry that will be written shown before saving, the
//     write of that entry and nothing else, and the undo that puts the file back byte for byte;
//   - the disabled state, with its reason beside it, in governed mode (nothing is written);
//   - the attribution line, and no percentage and none of the words compliant, conformant or certified;
//   - the links from the Quality result, the Semantic result and the overview, and the entry in the validations area.
// Keyboard only, pt-BR at 1280 px and English at 375 px, axe.

const RUN_ID = "run_20261113T100000Z_bbbbbbbb";
const SEM_ID = "sem_20261113T110000Z_0a0a0a0a";
const FILE = ".jgates/asvs.json";
const COMMIT = "1111111111111111111111111111111111111111";
const MAP_PACK = path.resolve(path.dirname(MAIN), "..", "..", "packs", "asvs", "jgates-asvs-map", "5.0.0");
const DIST = path.resolve(path.dirname(MAIN), "..");

interface Texts {
  language: "pt-BR" | "en";
  title: string;
  statement: RegExp;
  states: Record<"examined" | "unexamined" | "unsupported" | "not-applicable" | "awaiting-evidence", string>;
  na: string;
  cancel: string;
  undo: string;
  attribution: string;
  noCheck: RegExp;
  governed: RegExp;
  noSemanticYet: RegExp;
}

const PT: Texts = {
  language: "pt-BR",
  title: "Mapa de cobertura ASVS",
  statement: /^Este mapa mostra o que foi examinado/,
  states: { examined: "Examinado", unexamined: "Não examinado", unsupported: "Sem suporte", "not-applicable": "Não se aplica", "awaiting-evidence": "Aguardando evidência" },
  na: "Não se aplica",
  cancel: "Cancelar",
  undo: "Desfazer",
  attribution: "© The OWASP Foundation, CC BY-SA 4.0",
  noCheck: /Nenhuma verificação do JGates examina isto/,
  governed: /Modo governado/,
  noSemanticYet: /Nenhuma execução Semantic ainda/,
};

const EN: Texts = {
  language: "en",
  title: "ASVS coverage map",
  statement: /^This map shows what was examined, not whether the project meets the standard\.$/,
  states: { examined: "Examined", unexamined: "Unexamined", unsupported: "Unsupported", "not-applicable": "Not applicable", "awaiting-evidence": "Awaiting evidence" },
  na: "Not applicable",
  cancel: "Cancel",
  undo: "Undo",
  attribution: "© The OWASP Foundation, CC BY-SA 4.0",
  noCheck: /No JGates check examines this/,
  governed: /Governed mode/,
  noSemanticYet: /No Semantic run yet/,
};

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

interface Ids {
  examined: string;
  unexamined: string;
  awaiting: string;
  unsupported: string;
  /** The requirement the tests record as not applicable (unsupported before). */
  target: string;
  /** With `rules`: a requirement with a JavaScript rule and a Go rule, and one with only a Go and a Rust rule. */
  mixed?: string;
  absentOnly?: string;
  jsRule?: string;
  goRule?: string;
  rustRule?: string;
}

/**
 * A copy of the shipped mapping pack where five level-1 requirements, one per section, have exactly the entry the test needs.
 * With `rules`, two more: one checked by a JavaScript and a Go rule, one checked by a Go and a Rust rule only.
 */
async function fixtureMapping(rules = false): Promise<{ dir: string; ids: Ids }> {
  const asvs = await import(pathToFileURL(path.join(DIST, "core", "coverage", "asvs", "index.js")).href);
  const data = asvs.loadAsvs("5.0.0");
  const level1 = asvs.asvsRequirements(data, { level: 1 }) as Array<{ id: string; chapter: string; section: string }>;
  const sections: typeof level1 = [];
  for (const r of level1) if (!sections.some((x) => x.section === r.section)) sections.push(r);
  const pick = sections.slice(0, rules ? 7 : 5);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-asvs-map-"));
  const versionDir = path.join(dir, "5.0.0");
  fs.cpSync(MAP_PACK, versionDir, { recursive: true });
  const set = (requirement: { id: string; chapter: string }, patch: Record<string, unknown>) => {
    const file = path.join(versionDir, `${asvs.chapterFileStem(requirement.chapter)}.json`);
    const doc = readJson(file);
    const entry = doc.entries.find((e: any) => e.requirement === requirement.id);
    Object.assign(entry, patch);
    writeJson(file, doc);
  };
  const check = (id: string) => ({ unit: "semantic-method", id, covers: "a construct this check reads", misses: "what it does not model", depth: "partial" });
  const reviewed = (id: string) => ({ status: "reviewed", evidence: "repository", subdimensions: ["business-logic"], checks: [check(id)], why: "It bears on the requirement for a reason of its own.", review: { by: "independent context", date: "2026-11-14" } });
  const [examined, unexamined, awaiting, unsupported, target] = pick as [(typeof level1)[number], (typeof level1)[number], (typeof level1)[number], (typeof level1)[number], (typeof level1)[number]];
  set(examined, reviewed("differential-review"));
  set(unexamined, reviewed("variant-analysis"));
  set(awaiting, { status: "pending", evidence: "deployment", checks: [], subdimensions: [] });
  set(unsupported, { status: "pending", evidence: "repository", checks: [], subdimensions: [] });
  set(target, { status: "pending", evidence: "repository", checks: [], subdimensions: [] });
  const ids: Ids = { examined: examined.id, unexamined: unexamined.id, awaiting: awaiting.id, unsupported: unsupported.id, target: target.id };
  if (rules) {
    const semgrep = await import(pathToFileURL(path.join(DIST, "adapters", "semgrep", "index.js")).href);
    const packRules = semgrep.buildPackIndex(path.resolve(MAP_PACK, "..", "..", "..", "semgrep", "jgates-semgrep", "rules")).rules as Array<{ id: string; language: string; subdimension: string }>;
    const js = packRules.find((r) => r.language === "javascript");
    const go = packRules.find((r) => r.language === "go");
    const rust = packRules.find((r) => r.language === "rust");
    if (!js || !go || !rust) throw new Error("the pack has no JavaScript, Go and Rust rule");
    const ruleCheck = (rule: { id: string }) => ({ unit: "semgrep-rule", id: rule.id, covers: "a construct this rule flags", misses: "what it does not model", depth: "partial" });
    const reviewedRules = (list: Array<{ id: string; subdimension: string }>) => ({ status: "reviewed", evidence: "repository", subdimensions: [list[0]!.subdimension], checks: list.map(ruleCheck), why: "It bears on the requirement for a reason of its own.", review: { by: "independent context", date: "2026-11-14" } });
    const [mixed, absentOnly] = pick.slice(5) as [(typeof level1)[number], (typeof level1)[number]];
    set(mixed, reviewedRules([js, go]));
    set(absentOnly, reviewedRules([go, rust]));
    Object.assign(ids, { mixed: mixed.id, absentOnly: absentOnly.id, jsRule: js.id, goRule: go.id, rustRule: rust.id });
  }
  return { dir, ids };
}

async function workspaceIdOf(fixture: Fixture): Promise<string> {
  const mod = await import(pathToFileURL(path.join(DIST, "core", "ids", "index.js")).href);
  return mod.workspaceId(fixture.dir);
}

const base = { schemaVersion: 1, tool: "jgates", version: "2.0.0", requirements: [], unsatisfied: [], warnings: [], blockingViolations: 0, disabled: [], complete: true, reduced: false };

/** A finished Quality run and a finished Semantic run of the same revision, stored the way the runners store them. */
async function writeRuns(fixture: Fixture, language: "pt-BR" | "en", withSemantic: boolean, projectLanguages: string[] = []): Promise<void> {
  const wsId = await workspaceIdOf(fixture);
  const runDir = path.join(fixture.home, "workspaces", wsId, "runs", RUN_ID);
  fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
  const result = {
    ...base,
    runId: RUN_ID,
    gate: "quality",
    startedAt: "2026-11-13T10:00:00.000Z",
    finishedAt: "2026-11-13T10:00:09.000Z",
    workspace: { id: wsId, path: fixture.dir },
    runDir,
    selection: { adapter: "plan", options: {}, overrides: [], profile: "minimal", scope: "workspace" },
    decision: "passed",
    exitCode: 0,
    stages: [],
    findings: [],
    workspaceChanges: { checked: true, added: [], modified: [], removed: [] },
    artifacts: { result: "result.json", logs: [], outputs: [], plan: "plan.json" },
  };
  writeJson(path.join(runDir, "result.json"), result);
  writeJson(path.join(runDir, "plan.json"), { schemaVersion: 1, kind: "jgates-plan", groups: { willRun: projectLanguages.length > 0 ? [{ id: "semgrep#sast", languages: projectLanguages }] : [], notApplicableOrDisabled: [] } });
  writeJson(path.join(runDir, "run.json"), { schemaVersion: 1, gate: "quality", runId: RUN_ID, source: { commit: COMMIT, dirty: false, dirtyContentHash: null } });
  const event = (sequence: number, type: string) => JSON.stringify({ schemaVersion: 1, runId: RUN_ID, sequence, type, at: "2026-11-13T10:00:01.000Z", data: {} });
  fs.writeFileSync(path.join(runDir, "events.jsonl"), `${event(1, "run-started")}\n${event(2, "run-finished")}\n`);
  if (withSemantic) {
    const dir = path.join(fixture.home, "workspaces", wsId, "semantic-runs", SEM_ID);
    writeJson(path.join(dir, "result.json"), {
      ...base,
      runId: SEM_ID,
      gate: "semantic",
      startedAt: "2026-11-13T11:00:00.000Z",
      finishedAt: "2026-11-13T11:00:00.000Z",
      decision: "passed",
      exitCode: 0,
      stages: [],
      findings: [],
      workspaceChanges: { checked: false, added: [], modified: [], removed: [] },
      artifacts: { result: "result.json", logs: [], outputs: [] },
      semanticRun: { schemaVersion: 1, enforcement: "advisory", methods: ["differential-review"], outcome: { requested: true, state: "completed", separateFromDecision: true, provider: "scripted", model: "fixture" }, source: { id: "fixture", basis: "git", traceable: true }, quality: null },
    });
    writeJson(path.join(dir, "run.json"), { schemaVersion: 1, gate: "semantic", runId: SEM_ID, source: { commit: COMMIT, dirty: false, dirtyContentHash: null } });
  }
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language }, null, 2)}\n`, { mode: 0o600 });
}

async function withProject(page: Page, language: "pt-BR" | "en", body: (ctx: { fixture: Fixture; base: string; ids: Ids }) => Promise<void>, options: { env?: Record<string, string>; semantic?: boolean; languages?: string[]; rules?: boolean } = {}) {
  const fixture = createFixture();
  const mapping = await fixtureMapping(options.rules === true);
  Object.assign(fixture.env, { JGATES_ASVS_MAP_DIR: mapping.dir }, options.env ?? {});
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    await writeRuns(fixture, language, options.semantic !== false, options.languages ?? []);
    server = await startServer(fixture);
    const url = await openApp(page, server);
    await body({ fixture, base: url, ids: mapping.ids });
  } finally {
    await server?.stop();
    fixture.cleanup();
    fs.rmSync(mapping.dir, { recursive: true, force: true });
  }
}

async function tabTo(page: Page, target: Locator, max = 800): Promise<void> {
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  // Backwards (Shift+Tab) when the target comes before the focused control: a long list (345 rows) lies between them otherwise.
  const before = await target.evaluate((el) => {
    const active = document.activeElement;
    return active !== null && active !== document.body && (el.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press(before ? "Shift+Tab" : "Tab");
  }
  throw new Error(`the keyboard never reached ${await target.evaluate((el) => el.outerHTML.slice(0, 200))}`);
}

async function press(page: Page, target: Locator, key = "Enter"): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press(key);
}

async function typeInto(page: Page, field: Locator, text: string): Promise<void> {
  await tabTo(page, field);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text);
}

async function axeClean(page: Page, selector: string): Promise<void> {
  const axe = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, "no horizontal scroll").toBeLessThanOrEqual(0);
}

const row = (page: Page, id: string): Locator => page.locator(`li[data-testid="asvs-row-${id}"]`);
const allRows = (page: Page): Locator => page.locator("li[data-state]");

async function openMap(page: Page, url: string, text: Texts): Promise<void> {
  await page.goto(`${url}#/validations/coverage/asvs`);
  await reloadPage(page);
  await expect(page.getByRole("heading", { name: text.title, level: 1 })).toBeVisible();
  await expect(page.getByTestId("asvs-counters")).toBeVisible();
}

/** What the screen says, leaving out the official requirement text (it is the standard's own wording, not ours). */
async function ownText(page: Page): Promise<string> {
  return page.getByTestId("asvs-screen").evaluate((root) => {
    const copy = root.cloneNode(true) as HTMLElement;
    for (const el of Array.from(copy.querySelectorAll("[lang='en']"))) el.remove();
    return copy.textContent ?? "";
  });
}

const VARIANTS: Array<{ text: Texts; width: number; height: number }> = [
  { text: PT, width: 1280, height: 900 },
  { text: EN, width: 375, height: 800 },
];

// Stored map answers isolate the screen contract from pack contents. In particular this does not
// invent a rule for an omitted family or claim that a Review-only requirement was examined.
for (const text of [PT, EN]) {
  for (const width of [1280, 375]) {
    for (const colorScheme of ["light", "dark"] as const) {
      test(`Review checks and language notes stay separate (${text.language}, ${width} px, ${colorScheme}, keyboard)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        await withProject(page, text.language, async ({ base: url, ids }) => {
          const response = await page.request.get(new URL(`/api/coverage/asvs?lang=${text.language}`, url).href);
          expect(response.ok()).toBe(true);
          const stored = await response.json() as AsvsMap;
          const mixed = stored.requirements.find((r) => r.id === ids.examined)!;
          const only = stored.requirements.find((r) => r.id === ids.unsupported)!;
          const template = mixed.checks[0]!;
          const review = {
            ...template, id: "fixture.review-check", unit: "semgrep-rule", basis: "deterministic",
            class: "review" as const, status: "ran", ran: true, relevant: true, runId: RUN_ID,
            openFindings: 7, openBlocking: 0, openInformational: 0, openReview: 7,
          };
          mixed.checks = [{ ...template, unit: "semgrep-rule", basis: "deterministic", openFindings: 5, openBlocking: 2, openInformational: 3, openReview: 0 }, review];
          mixed.notes = [];
          only.checks = [review];
          only.state = "unsupported";
          only.code = "UNSUPPORTED_REVIEW_ONLY";
          only.basis = null;
          only.reason = text.language === "pt-BR"
            ? "Só há verificações para revisar; nenhuma examina este requisito."
            : "Only checks to review are available; none examines this requirement.";
          only.notes = [
            { language: "rust", kind: "protected-by-library", family: "xml-external-entity", label: "not a UI label",
              why: "The XML libraries commonly used in Rust resolve no external entity." },
            { language: "rust", kind: "not-applicable-to-language", family: "prototype-pollution", label: "not a UI label",
              why: "Rust has no JavaScript prototype chain." },
          ];
          await page.route("**/api/coverage/asvs?*", (route) => route.fulfill({ json: stored }));
          await openMap(page, url, text);

          const mixedRow = row(page, ids.examined);
          const onlyRow = row(page, ids.unsupported);
          await expect(mixedRow.getByTestId("asvs-row-notes")).toHaveCount(0);
          await expect(row(page, ids.unexamined).getByTestId("asvs-row-notes")).toHaveCount(0);
          await expect(onlyRow).toHaveAttribute("data-state", "unsupported");
          await expect(onlyRow.getByTestId("asvs-row-state")).toHaveText(text.states.unsupported);
          await expect(onlyRow.getByTestId("asvs-row-reason")).toHaveText(only.reason);
          const labels = text.language === "pt-BR"
            ? ["Protegido pela própria biblioteca (não verificado pelo JGates)", "Não se aplica a esta linguagem"]
            : ["Protected by the library itself (not checked by JGates)", "Not applicable to this language"];
          const notes = onlyRow.getByTestId("asvs-language-note");
          await expect(notes).toHaveCount(2);
          for (let i = 0; i < 2; i++) {
            await expect(notes.nth(i).locator("strong")).toHaveText(labels[i]!);
            await expect(notes.nth(i).locator('[lang="en"]')).toHaveText(only.notes[i]!.why);
          }
          // Notes follow the reason, without changing the row's state or requiring an open panel.
          expect(await onlyRow.getByTestId("asvs-row-reason").evaluate((el) =>
            Boolean(el.nextElementSibling?.matches('[data-testid="asvs-row-notes"]')))).toBe(true);

          await press(page, page.getByTestId(`asvs-toggle-${ids.examined}`));
          await expect(page.getByTestId(`asvs-toggle-${ids.examined}`)).toBeFocused();
          const checks = mixedRow.getByTestId("asvs-check");
          await expect(checks).toHaveCount(2);
          await expect(checks.nth(0).getByTestId("asvs-check-review-label")).toHaveCount(0);
          for (const [index, counts] of [[0, [2, 3, 0]], [1, [0, 0, 7]]] as const) {
            for (const [i, kind] of ["blocking", "informational", "review"].entries()) {
              await expect(checks.nth(index).getByTestId(`asvs-check-${kind}`)).toHaveAttribute("data-count", String(counts[i]));
            }
          }
          const reviewLabel = text.language === "pt-BR" ? "para revisar" : "to review";
          await expect(checks.nth(1).getByTestId("asvs-check-review-label")).toHaveText(reviewLabel);
          await expect(checks.nth(1).getByTestId("asvs-check-review")).toContainText(`7 ${reviewLabel}`);
          await press(page, page.getByTestId(`asvs-toggle-${ids.unsupported}`), "Space");
          await expect(onlyRow.getByTestId("asvs-check-review-label")).toHaveText(reviewLabel);
          await expect(onlyRow.getByTestId("asvs-check-blocking")).toHaveAttribute("data-count", "0");
          await expect(onlyRow.getByTestId("asvs-check-informational")).toHaveAttribute("data-count", "0");
          await expect(onlyRow.getByTestId("asvs-check-review")).toHaveAttribute("data-count", "7");
          await noSidewaysScroll(page);
          await axeClean(page, '[data-testid="asvs-screen"]');
          await press(page, page.getByTestId(`asvs-toggle-${ids.unsupported}`));
          await expect(page.getByTestId(`asvs-detail-${ids.unsupported}`)).toHaveCount(0);
        });
      });
    }
  }
}

for (const { text, width, height } of VARIANTS) {
  test(`the map: five counters that filter, a row of each state with its reason, the checks of an opened row, the English text and the attribution (${text.language}, ${width} px, keyboard only)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await withProject(page, text.language, async ({ base: url, ids }) => {
      await openMap(page, url, text);
      await expect(page.getByTestId("asvs-statement")).toHaveText(text.statement);
      await noSidewaysScroll(page);

      // One row of each state, each with a reason of its own.
      const wanted: Array<[string, keyof Texts["states"]]> = [
        [ids.examined, "examined"],
        [ids.unexamined, "unexamined"],
        [ids.awaiting, "awaiting-evidence"],
        [ids.unsupported, "unsupported"],
      ];
      for (const [id, state] of wanted) {
        const r = row(page, id);
        await expect(r).toHaveAttribute("data-state", state);
        await expect(r.getByTestId("asvs-row-state")).toHaveText(text.states[state]);
        expect(((await r.getByTestId("asvs-row-reason").textContent()) ?? "").trim().length, `${id} has a reason`).toBeGreaterThan(10);
      }
      await expect(row(page, ids.examined).getByTestId("asvs-row-reason")).toContainText("differential-review");
      await expect(row(page, ids.unexamined).getByTestId("asvs-row-reason")).toContainText("variant-analysis");

      // The five counters: a count each, and each one filters the rows (and clears again).
      const states = ["examined", "unexamined", "unsupported", "not-applicable", "awaiting-evidence"] as const;
      for (const state of states) {
        const counter = page.getByTestId(`asvs-counter-${state}`);
        await expect(counter).toContainText(text.states[state]);
        expect(await counter.getAttribute("data-count")).toMatch(/^\d+$/);
      }
      await expect(page.getByTestId("asvs-counter-not-applicable")).toHaveAttribute("data-count", "0");
      for (const state of ["examined", "awaiting-evidence"] as const) {
        const counter = page.getByTestId(`asvs-counter-${state}`);
        const count = Number(await counter.getAttribute("data-count"));
        expect(count, `${state} has at least the fixture row`).toBeGreaterThan(0);
        await press(page, counter, "Space");
        await expect(counter).toHaveAttribute("aria-pressed", "true");
        await expect(allRows(page)).toHaveCount(count);
        for (const s of await allRows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-state")))) expect(s).toBe(state);
        await press(page, counter, "Space");
        await expect(counter).toHaveAttribute("aria-pressed", "false");
        await expect(allRows(page)).toHaveCount(70);
      }

      // An opened row: the checks behind it (which ran, what each covers and misses), or what it awaits, or that nothing examines it.
      await press(page, row(page, ids.examined).getByTestId(`asvs-toggle-${ids.examined}`));
      const detail = page.getByTestId(`asvs-detail-${ids.examined}`);
      await expect(detail.getByTestId("asvs-check")).toHaveCount(1);
      await expect(detail.getByTestId("asvs-check")).toHaveAttribute("data-status", "ran");
      await expect(detail.getByTestId("asvs-check")).toContainText("differential-review");
      await expect(detail.getByTestId("asvs-check")).toContainText("a construct this check reads");
      await expect(detail.getByTestId("asvs-check")).toContainText("what it does not model");
      await press(page, row(page, ids.unexamined).getByTestId(`asvs-toggle-${ids.unexamined}`));
      await expect(page.getByTestId(`asvs-detail-${ids.unexamined}`).getByTestId("asvs-check")).toHaveAttribute("data-status", "not-run");
      await press(page, row(page, ids.awaiting).getByTestId(`asvs-toggle-${ids.awaiting}`));
      await expect(page.getByTestId(`asvs-detail-${ids.awaiting}`).getByTestId("asvs-awaits")).toBeVisible();
      await press(page, row(page, ids.unsupported).getByTestId(`asvs-toggle-${ids.unsupported}`));
      await expect(page.getByTestId(`asvs-detail-${ids.unsupported}`).getByTestId("asvs-no-check")).toHaveText(text.noCheck);
      await press(page, row(page, ids.examined).getByTestId(`asvs-toggle-${ids.examined}`));
      await expect(row(page, ids.examined).getByTestId("asvs-toggle-" + ids.examined)).toHaveAttribute("aria-expanded", "false");

      // The official text is marked as English and shown with its attribution.
      const sample = row(page, ids.examined).getByTestId("asvs-row-text");
      await expect(sample).toHaveAttribute("lang", "en");
      expect(((await sample.textContent()) ?? "").trim().length).toBeGreaterThan(20);
      await expect(page.getByTestId("asvs-attribution")).toContainText(text.attribution);
      await expect(page.getByTestId("asvs-attribution").getByRole("link", { name: "CC BY-SA 4.0" })).toHaveAttribute("href", /creativecommons\.org/);

      // The runs the map reads link to their results; no percentage and no claim of compliance anywhere on the screen.
      await expect(page.getByTestId("asvs-run-quality")).toHaveText(RUN_ID);
      await expect(page.getByTestId("asvs-run-semantic")).toHaveText(SEM_ID);
      const own = await ownText(page);
      expect(own).not.toMatch(/\d\s*%/);
      expect(own).not.toMatch(/\b(compliant|conformant|certified|compliance|conformidade|certificad[oa]s?)\b/i);
      await noSidewaysScroll(page);
      await axeClean(page, '[data-testid="asvs-screen"]');
    });
  });

  test(`the level switch shows 70, 253 and 345 rows and records the project's choice in ${FILE} (${text.language}, ${width} px, keyboard only)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await withProject(page, text.language, async ({ fixture, base: url }) => {
      await openMap(page, url, text);
      const file = path.join(fixture.dir, FILE);
      await expect(page.getByTestId("asvs-level-1")).toHaveAttribute("aria-pressed", "true");
      await expect(allRows(page)).toHaveCount(70);
      expect(fs.existsSync(file), "nothing recorded yet").toBe(false);
      for (const [level, rows] of [[2, 253], [3, 345], [1, 70]] as const) {
        await press(page, page.getByTestId(`asvs-level-${level}`), "Space");
        await expect(page.getByTestId(`asvs-level-${level}`)).toHaveAttribute("aria-pressed", "true");
        await expect(allRows(page)).toHaveCount(rows);
        await expect(page.getByTestId("asvs-counters")).toBeVisible();
        await expect.poll(() => (fs.existsSync(file) ? readJson(file).level : null)).toBe(level);
      }
    });
  });

  test(`"${text.na}" asks for a reason, shows the entry first, writes that entry only, and undo puts the file back byte for byte (${text.language}, ${width} px, keyboard only)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await withProject(page, text.language, async ({ fixture, base: url, ids }) => {
      await openMap(page, url, text);
      const file = path.join(fixture.dir, FILE);
      const before = '{\n  "$comment": "team file",\n  "notApplicable": []\n}\n';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, before);
      await page.reload();
      await expect(page.getByTestId("asvs-counters")).toBeVisible();

      const target = row(page, ids.target);
      await expect(target).toHaveAttribute("data-state", "unsupported");
      await press(page, target.getByTestId(`asvs-na-${ids.target}`));
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((el) => el.contains(document.activeElement)), "focus starts inside the dialog").toBe(true);
      await expect(dialog.getByTestId("asvs-na-entry")).toContainText(FILE);
      await axeClean(page, "dialog");

      // A reason is required: none or two characters keeps "save" disabled and shows no entry.
      const save = dialog.getByTestId("asvs-na-save");
      await expect(save).toBeDisabled();
      await expect(dialog.getByTestId("asvs-na-entry-wait")).toBeVisible();
      await typeInto(page, dialog.getByTestId("asvs-na-reason"), "ab");
      await expect(save, "reason too short").toBeDisabled();
      expect(fs.readFileSync(file, "utf8")).toBe(before);

      // A valid reason: the entry that will be written is shown (the diff of the file), nothing is written yet.
      await typeInto(page, dialog.getByTestId("asvs-na-reason"), "no such feature in this product");
      const diff = dialog.getByTestId("asvs-na-diff");
      await expect(diff).toContainText(ids.target);
      await expect(diff).toContainText("no such feature in this product");
      await expect(save).toBeEnabled();
      expect(fs.readFileSync(file, "utf8"), "the preview writes nothing").toBe(before);
      await axeClean(page, "dialog");

      // Esc asks before throwing away a typed reason.
      await page.keyboard.press("Escape");
      await expect(dialog.getByTestId("asvs-na-discard")).toBeVisible();
      await press(page, dialog.getByTestId("asvs-na-keep"));
      await expect(dialog.getByTestId("asvs-na-reason")).toHaveValue("no such feature in this product");

      // Save: the file changes by that entry and nothing else; the row, the counter and the undo follow.
      await press(page, save);
      await expect(dialog).toHaveCount(0);
      const after = readJson(file);
      expect(after.$comment).toBe("team file");
      expect(after.notApplicable).toHaveLength(1);
      expect(after.notApplicable[0]).toMatchObject({ id: ids.target, reason: "no such feature in this product" });
      expect(after.notApplicable[0].recorded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await expect(target).toHaveAttribute("data-state", "not-applicable");
      await expect(target.getByTestId("asvs-row-state")).toHaveText(text.states["not-applicable"]);
      await expect(target.getByTestId("asvs-row-reason")).toContainText("no such feature in this product");
      await expect(page.getByTestId("asvs-counter-not-applicable")).toHaveAttribute("data-count", "1");
      // The row's own decision: "Não se aplica" gives way to the action that takes the decision back.
      await expect(page.getByTestId(`asvs-na-${ids.target}`)).toHaveCount(0);
      await expect(target.getByTestId(`asvs-applicable-${ids.target}`)).toBeEnabled();

      await press(page, page.getByTestId("asvs-undo"));
      await expect(target).toHaveAttribute("data-state", "unsupported");
      expect(fs.readFileSync(file, "utf8"), "undo restores the file byte for byte").toBe(before);
      await expect(page.getByTestId("asvs-undo-bar")).toHaveCount(0);
      await expect(page.getByTestId("asvs-counter-not-applicable")).toHaveAttribute("data-count", "0");
      await noSidewaysScroll(page);
    });
  });
}

test("in governed mode \"Não se aplica\" is disabled with its reason beside it, the level only changes the view, and nothing is written", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withProject(
    page,
    "pt-BR",
    async ({ fixture, base: url, ids }) => {
      await openMap(page, url, PT);
      await expect(page.getByTestId(`asvs-na-${ids.target}`)).toBeDisabled();
      await expect(page.getByTestId("asvs-governed-note")).toContainText(PT.governed);
      await expect(page.getByTestId(`asvs-na-${ids.target}`)).toHaveAttribute("aria-describedby", "asvs-governed-note");
      await expect(page.getByTestId("asvs-level-source")).toContainText(PT.governed);
      await press(page, page.getByTestId("asvs-level-2"), "Space");
      await expect(allRows(page)).toHaveCount(253);
      expect(fs.existsSync(path.join(fixture.dir, FILE)), "nothing was recorded").toBe(false);
      // The server refuses the write too.
      const status = await page.evaluate(async () => {
        const session = await (await fetch("/api/session", { credentials: "same-origin" })).json();
        const response = await fetch("/api/coverage/asvs/decisions", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", [session.csrfHeader]: session.csrfToken }, body: JSON.stringify({ action: "level", level: 3 }) });
        return { status: response.status, code: (await response.json()).code };
      });
      expect(status).toEqual({ status: 403, code: "GOVERNED_LOCKED" });
      expect(fs.existsSync(path.join(fixture.dir, FILE))).toBe(false);
    },
    { env: { JGATES_POLICY_DIR: "/etc/policies/company-policy", JGATES_POLICY_SHA256: "a".repeat(64) } },
  );
});

test("a single-language project's opened requirement lists no check of an absent language, and a requirement with only such checks names the languages in its reason", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withProject(
    page,
    "en",
    async ({ base: url, ids }) => {
      await openMap(page, url, EN);
      const mixed = ids.mixed!;
      const absentOnly = ids.absentOnly!;

      // A JavaScript project: the opened requirement lists the JavaScript rule and nothing of Go.
      await press(page, row(page, mixed).getByTestId(`asvs-toggle-${mixed}`));
      const detail = page.getByTestId(`asvs-detail-${mixed}`);
      await expect(detail.getByTestId("asvs-check")).toHaveCount(1);
      await expect(detail.getByTestId("asvs-check")).toContainText(ids.jsRule!);
      await expect(detail).not.toContainText(ids.goRule!);

      // Only Go and Rust rules: no check is listed, the row is unsupported and its reason names the project's language and the others.
      const only = row(page, absentOnly);
      await expect(only).toHaveAttribute("data-state", "unsupported");
      const reason = (await only.getByTestId("asvs-row-reason").textContent()) ?? "";
      expect(reason).toContain("JavaScript");
      expect(reason).toContain("Go");
      expect(reason).toContain("Rust");
      await press(page, only.getByTestId(`asvs-toggle-${absentOnly}`));
      const detailOnly = page.getByTestId(`asvs-detail-${absentOnly}`);
      await expect(detailOnly.getByTestId("asvs-check")).toHaveCount(0);
      await expect(detailOnly.getByTestId("asvs-no-check")).toHaveText(/in the languages of this project/);
      await expect(detailOnly).not.toContainText(ids.goRule!);
      await expect(detailOnly).not.toContainText(ids.rustRule!);
    },
    { languages: ["javascript"], rules: true },
  );
});

test("without a Semantic run the map says so, and the route answers the same as the command", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withProject(
    page,
    "en",
    async ({ base: url, ids }) => {
      await openMap(page, url, EN);
      await expect(page.getByTestId("asvs-no-semantic")).toHaveText(EN.noSemanticYet);
      await expect(row(page, ids.examined)).toHaveAttribute("data-state", "unexamined");
      const answer = await page.evaluate(async () => (await fetch("/api/coverage/asvs?level=1", { headers: { accept: "application/json" } })).json());
      expect(answer.kind).toBe("asvs-coverage-map");
      expect(answer.requirements).toHaveLength(70);
    },
    { semantic: false },
  );
});

test("the Quality result, the Semantic result and the overview link to the map, and the map is in the validations area of the navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withProject(page, "en", async ({ base: url }) => {
    for (const [route, href] of [
      [`#/validations/result/${RUN_ID}`, `#/validations/coverage/asvs?run=${RUN_ID}`],
      [`#/semantic/results/${SEM_ID}`, `#/validations/coverage/asvs?semanticRun=${SEM_ID}`],
      ["#/overview", "#/validations/coverage/asvs"],
    ] as const) {
      await page.goto(`${url}${route}`);
      await reloadPage(page);
      const link = page.getByTestId("asvs-link");
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", href);
      await press(page, link);
      await expect(page.getByRole("heading", { name: EN.title, level: 1 })).toBeVisible();
      expect(new URL(page.url()).hash.startsWith("#/validations/coverage/asvs")).toBe(true);
    }
    // In the navigation, under the validations area.
    await expect(page.getByRole("navigation").getByRole("link", { name: EN.title, exact: true })).toHaveAttribute("aria-current", "page");
  });
});

// ---- Suggestions of "not applicable", the two numbers of open findings, the AI review unit, the route to a row ----
// The answer of the server is patched in the browser (the suggestion, the split counts and the unit kinds are the server's
// own, tested elsewhere): the screen is what is under test here.

interface SuggestionTexts {
  reasonRow: string;
  reasonSection: string;
  suggestion: (reason: string) => string;
  action: string;
  blocking: RegExp;
  informational: RegExp;
  noBlockWords: RegExp;
  html: string;
  config: string;
  aiTitle: RegExp;
  onlySuggestion: string;
  governedWhy: RegExp;
}

const SUGGEST: Record<"pt-BR" | "en", SuggestionTexts> = {
  "pt-BR": {
    reasonRow: "nenhum sinal de GraphQL neste projeto",
    reasonSection: "nenhum sinal de WebSocket neste projeto",
    suggestion: (reason) => `Sugestão: ${reason}`,
    action: "Marcar como não se aplica",
    blocking: /2 achados que bloqueiam/,
    informational: /3 achados informativos \(não bloqueia a validação\)/,
    noBlockWords: /não bloqueia a validação/,
    html: "arquivos HTML",
    config: "arquivos de configuração",
    aiTitle: /Revisão do código por IA/,
    onlySuggestion: "Só requisitos com sugestão",
    governedWhy: /Modo governado/,
  },
  en: {
    reasonRow: "no sign of GraphQL in this project",
    reasonSection: "no sign of WebSocket in this project",
    suggestion: (reason) => `Suggestion: ${reason}`,
    action: "Mark as not applicable",
    blocking: /2 blocking findings/,
    informational: /3 informational findings \(does not block the validation\)/,
    noBlockWords: /does not block the validation/,
    html: "HTML files",
    config: "configuration files",
    aiTitle: /AI review of the source/,
    onlySuggestion: "Only requirements with a suggestion",
    governedWhy: /Governed mode/,
  },
};

/** Patches the map's answer: a suggestion on one row, one shared by a whole section, split counts and two more checks on an examined row. */
async function patchMap(page: Page, ids: Ids, s: SuggestionTexts): Promise<void> {
  await page.route(/\/api\/coverage\/asvs\?/, async (route) => {
    // The server filters by `withSuggestion` itself, before the suggestions added here exist: ask it for the whole map and
    // apply the filter after the patch.
    const requested = new URL(route.request().url());
    const withSuggestion = requested.searchParams.get("withSuggestion") === "true";
    requested.searchParams.delete("withSuggestion");
    const response = await route.fetch({ url: requested.toString() });
    const body = await response.json();
    const rowOf = (id: string) => body.requirements.find((r: { id: string }) => r.id === id);
    const target = rowOf(ids.target);
    if (target) target.suggestion = { kind: "technology", tags: ["graphql"], reason: s.reasonRow };
    const shared = rowOf(ids.unexamined);
    if (shared) {
      const suggestion = { kind: "technology", tags: ["websocket"], reason: s.reasonSection };
      for (const chapter of body.chapters) for (const section of chapter.sections) if (section.id === shared.section) section.suggestion = suggestion;
      for (const r of body.requirements) if (r.section === shared.section) r.suggestion = suggestion;
    }
    const examined = rowOf(ids.examined);
    if (examined && examined.checks.length > 0) {
      // The row may carry only an AI review of the source: the numbers go on deterministic checks added here, listed first,
      // and the existing checks are left as they are.
      const base = { ...examined.checks[0], ran: true, status: "ran", relevant: true };
      examined.checks.unshift({ ...base, unit: "semgrep-rule", id: "html-rule", basis: "deterministic", language: "html", openFindings: 5, openBlocking: 2, openInformational: 3 });
      examined.checks.push({ ...base, unit: "semantic-requirement", id: "asvs-review", basis: "ai-source-review", language: undefined, openFindings: 0, openBlocking: 0, openInformational: 0 });
      examined.checks.push({ ...base, unit: "semgrep-rule", id: "config-rule", basis: "deterministic", language: "config", openFindings: 0, openBlocking: 0, openInformational: 0 });
    }
    if (withSuggestion) body.requirements = body.requirements.filter((r: { suggestion?: unknown }) => r.suggestion !== undefined);
    await route.fulfill({ response, json: body });
  });
}

for (const { text, width, height } of VARIANTS) {
  const s = SUGGEST[text.language];
  test(`suggestions: a row, a section, the filter, the dialog prefilled, the two numbers, the AI review apart (${text.language}, ${width} px, keyboard only)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await withProject(page, text.language, async ({ fixture, base: url, ids }) => {
      await patchMap(page, ids, s);
      await openMap(page, url, text);
      const file = path.join(fixture.dir, FILE);

      // The suggestion sits under the reason of the row, with its action.
      const target = row(page, ids.target);
      await expect(target.getByTestId(`asvs-suggestion-${ids.target}`)).toContainText(s.suggestion(s.reasonRow));
      await expect(target.getByTestId(`asvs-suggestion-action-${ids.target}`)).toHaveText(s.action);

      // A section whose rows all carry one suggestion shows it once, in its header, and not on the rows.
      const unexamined = row(page, ids.unexamined);
      const sectionTestId = (await unexamined.evaluate((el) => el.closest("[data-testid^='asvs-section-']")?.getAttribute("data-testid"))) ?? "";
      const sectionKey = sectionTestId.replace("asvs-section-", "");
      await expect(page.getByTestId(`asvs-suggestion-${sectionKey}`)).toContainText(s.reasonSection);
      await expect(unexamined.getByTestId(`asvs-suggestion-${ids.unexamined}`)).toHaveCount(0);

      // The two numbers of open findings, apart from each other; html and configuration files in words; the AI review apart.
      const examined = row(page, ids.examined);
      await press(page, examined.getByTestId(`asvs-toggle-${ids.examined}`));
      const detail = page.getByTestId(`asvs-detail-${ids.examined}`);
      await expect(detail.getByTestId("asvs-check-blocking").first()).toHaveText(s.blocking);
      await expect(detail.getByTestId("asvs-check-informational").first()).toHaveText(s.informational);
      await expect(detail.getByTestId("asvs-check-informational").first()).toContainText(s.noBlockWords);
      await expect(detail.getByTestId("asvs-checks-deterministic")).toContainText(s.html);
      await expect(detail.getByTestId("asvs-checks-deterministic")).toContainText(s.config);
      await expect(detail.getByTestId("asvs-checks-ai")).toContainText(s.aiTitle);
      await expect(detail.getByTestId("asvs-checks-ai")).toContainText("asvs-review");
      await expect(detail.getByTestId("asvs-checks-deterministic")).not.toContainText("asvs-review");
      await axeClean(page, "[data-testid='asvs-screen']");
      await noSidewaysScroll(page);

      // The filter leaves only the rows with a suggestion.
      await expect(page.getByLabel(s.onlySuggestion)).toBeVisible();
      await tabTo(page, page.getByTestId("asvs-with-suggestion"));
      await page.keyboard.press("Space");
      await expect(row(page, ids.examined)).toHaveCount(0);
      await expect(row(page, ids.target)).toHaveCount(1);
      await page.keyboard.press("Space");
      await expect(row(page, ids.examined)).toHaveCount(1);

      // Confirming the row's suggestion: the dialog opens with the reason filled in and editable, and the entry shown.
      await press(page, page.getByTestId(`asvs-suggestion-action-${ids.target}`));
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("asvs-na-reason")).toHaveValue(s.reasonRow);
      await expect(dialog.getByTestId("asvs-na-diff")).toContainText(ids.target);
      expect(fs.existsSync(file), "nothing is written before the confirmation").toBe(false);
      await typeInto(page, dialog.getByTestId("asvs-na-reason"), `${s.reasonRow}!`);
      await expect(dialog.getByTestId("asvs-na-diff")).toContainText(`${s.reasonRow}!`);
      await press(page, dialog.getByTestId("asvs-na-save"));
      await expect(dialog).toHaveCount(0);
      expect(readJson(file).notApplicable[0]).toMatchObject({ id: ids.target, reason: `${s.reasonRow}!` });
      await expect(page.getByTestId("asvs-undo-bar")).toBeVisible();
      await press(page, page.getByTestId("asvs-undo"));
      await expect(page.getByTestId("asvs-undo-bar")).toHaveCount(0);

      // The section's suggestion is one confirmation for the whole section.
      await press(page, page.getByTestId(`asvs-suggestion-action-${sectionKey}`));
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("asvs-na-reason")).toHaveValue(s.reasonSection);
      await expect(dialog.getByTestId("asvs-na-diff")).toContainText(sectionKey);
      await press(page, dialog.getByTestId("asvs-na-cancel"));
      await expect(dialog).toHaveCount(0);
    });
  });

  test(`the route opens the requirement's row, opened and focused, from requirement=<id> (${text.language}, ${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await withProject(page, text.language, async ({ base: url, ids }) => {
      await page.goto(`${url}#/validations/coverage/asvs?requirement=${ids.examined}`);
      await reloadPage(page);
      await expect(page.getByTestId("asvs-counters")).toBeVisible();
      await expect(page.getByTestId(`asvs-toggle-${ids.examined}`)).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId(`asvs-toggle-${ids.examined}`)).toBeFocused();
      await expect(page.getByTestId(`asvs-detail-${ids.examined}`)).toBeVisible();
    });
  });
}

test("in governed mode the suggestion's action is disabled and says why, and nothing is written", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const s = SUGGEST.en;
  await withProject(
    page,
    "en",
    async ({ fixture, base: url, ids }) => {
      await patchMap(page, ids, s);
      await openMap(page, url, EN);
      const action = page.getByTestId(`asvs-suggestion-action-${ids.target}`);
      await expect(action).toBeDisabled();
      await expect(page.getByTestId(`asvs-suggestion-governed-${ids.target}`)).toContainText(s.governedWhy);
      await expect(action).toHaveAttribute("aria-describedby", `asvs-sug-why-${ids.target}`);
      expect(fs.existsSync(path.join(fixture.dir, FILE))).toBe(false);
    },
    { env: { JGATES_POLICY_DIR: "/etc/policies/company-policy", JGATES_POLICY_SHA256: "a".repeat(64) } },
  );
});

test("the map says nothing of compliance and shows no percentage, with suggestions and split counts on screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withProject(page, "en", async ({ base: url, ids }) => {
    await patchMap(page, ids, SUGGEST.en);
    await openMap(page, url, EN);
    await press(page, row(page, ids.examined).getByTestId(`asvs-toggle-${ids.examined}`));
    const own = await ownText(page);
    expect(own).not.toMatch(/\b(compliant|conformant|certified)\b/i);
    expect(own).not.toMatch(/\d\s*%/);
  });
});
