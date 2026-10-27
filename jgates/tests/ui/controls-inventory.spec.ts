import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture, startServer, type Fixture, type UiServer } from "./support";

// The inventory of controls. Every control that is visible on a screen must either be exercised by a test of
// effect (its accessible name or its data-testid appears in another spec of tests/ui) or carry the mark of unavailable,
// `data-control-unavailable="<reason>"` on the control or on an ancestor. A control with neither fails the inventory. No emoji or
// decorative pictogram may appear on any screen either.

const here = path.dirname(fileURLToPath(import.meta.url));

const ROUTES: Array<{ id: string; hash: string }> = [
  { id: "overview", hash: "#/overview" },
  { id: "workspace", hash: "#/workspace" },
  { id: "environment", hash: "#/environment" },
  { id: "config", hash: "#/config" },
  { id: "config-templates", hash: "#/config/templates" },
  { id: "config-architecture", hash: "#/config/architecture" },
  { id: "config-execution", hash: "#/config/execution" },
  { id: "config-yaml", hash: "#/config/yaml" },
  { id: "tools", hash: "#/tools" },
  { id: "tool", hash: "#/tools/ruff" },
  { id: "pii", hash: "#/tools/builtin-pii" },
  { id: "history", hash: "#/validations" },
  { id: "choose", hash: "#/validations/choose" },
  { id: "review", hash: "#/validations/review" },
  { id: "preferences", hash: "#/preferences" },
  { id: "storage", hash: "#/preferences/storage" },
  { id: "providers", hash: "#/preferences/providers" },
  { id: "help", hash: "#/help" },
  { id: "about", hash: "#/about" },
  { id: "policy", hash: "#/policy" },
];

interface Setup {
  hash: string;
  tab?: string;
  editor?: boolean;
}

interface Control {
  key: string;
  index: number;
  disabled: boolean;
  setup: Setup;
  screen: string;
  kind: string;
  name: string;
  candidates: string[];
  testid: string;
  shell: boolean;
  unavailable: string;
}

/** The text of every other spec of tests/ui: what the tests of effect say about the controls. */
function testSources(): string {
  const own = new Set(["controls-inventory.spec.ts", "a11y.spec.ts", "responsive.spec.ts"]);
  return fs
    .readdirSync(here)
    .filter((f) => f.endsWith(".spec.ts") && !own.has(f))
    .map((f) => fs.readFileSync(path.join(here, f), "utf8"))
    .join("\n")
    .replace(/\\/g, "")
    .toLowerCase();
}

const COLLECT = (mark: number | null) => {
  const out: Array<{ index: number; disabled: boolean; kind: string; name: string; candidates: string[]; testid: string; unavailable: string; shell: boolean }> = [];
  const lines = (text: string) =>
    text
      .split(/\n+/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l.length >= 3);
  const nodes = document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]), select, textarea, [role=switch], [role=tab], [role=button], [role=checkbox], [role=radio], [role=combobox], summary");
  let index = -1;
  for (const el of nodes) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.visibility === "hidden" || style.display === "none" || !el.checkVisibility()) continue;
    if (rect.width === 0 && rect.height === 0 && !el.matches("input[type=checkbox], input[type=radio]")) continue;
    if (el.classList.contains("skip")) continue;
    index++;
    if (mark === index) el.setAttribute("data-inv", "target");
    else el.removeAttribute("data-inv");
    const label = el.id ? document.querySelector<HTMLElement>(`label[for="${CSS.escape(el.id)}"]`) : null;
    const wrapping = el.closest("label");
    const by = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText ?? "")
      .join("\n");
    const aria = el.getAttribute("aria-label") ?? "";
    const candidates = [aria, ...lines(by), ...lines(label?.innerText ?? ""), ...lines(wrapping?.innerText ?? ""), ...lines(el.innerText ?? ""), el.getAttribute("title") ?? "", el.getAttribute("placeholder") ?? "", el.getAttribute("name") ?? ""].map((c) => c.replace(/\s+/g, " ").trim()).filter(Boolean);
    const marked = el.closest("[data-control-unavailable]");
    out.push({
      index,
      disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true",
      kind: el.getAttribute("role") ?? (el.tagName === "INPUT" ? `input:${(el as HTMLInputElement).type}` : el.tagName.toLowerCase()),
      name: candidates[0] ?? "",
      candidates,
      testid: el.getAttribute("data-testid") ?? el.closest("[data-testid]")?.getAttribute("data-testid") ?? "",
      unavailable: marked?.getAttribute("data-control-unavailable") ?? "",
      shell: el.closest(".sidebar, .topbar") !== null,
    });
  }
  return out;
};

let fixture: Fixture;
let server: UiServer;
let context: BrowserContext;
let page: Page;
let base = "";
let resultHash = "";

async function open(hash: string): Promise<void> {
  await page.goto(`${base}${hash}`);
  await page.reload();
  await expect(page.locator("main h1").first()).toBeVisible();
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
}

async function collect(screen: string, setup: Setup, into: Map<string, Control>): Promise<void> {
  for (const c of await page.evaluate(COLLECT, null)) {
    const where = c.shell ? "shell" : screen;
    const key = `${where}|${c.kind}|${c.name}`;
    if (!into.has(key)) into.set(key, { key, screen: where, setup, ...c });
  }
}


async function setup(c: Control): Promise<void> {
  await page.goto(`${base}${c.setup.hash}`);
  await page.reload();
  await expect(page.locator("main h1").first()).toBeVisible();
  if (c.setup.tab) {
    await page.getByRole("tab", { name: c.setup.tab, exact: true }).first().click();
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  }
  if (c.setup.editor) {
    await page.getByRole("tab", { name: "Arquivos" }).click();
    await page.getByRole("button", { name: /pyproject\.toml/ }).first().click();
    await expect(page.locator(".editor-host .cm-content")).toContainText("tool.ruff.lint");
  }
}

/** Operates the control and reports whether anything observable changed. */
async function probe(c: Control): Promise<{ ok: boolean; why: string }> {
  if (process.env.JGATES_INV_DEBUG) console.log("probe", c.key);
  await setup(c);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  // The screens load their data after the first paint: wait for the control to come back.
  let where = -1;
  for (let attempt = 0; attempt < 20 && where < 0; attempt++) {
    const now = await page.evaluate(COLLECT, null);
    where = now.findIndex((n) => n.kind === c.kind && n.name === c.name);
    if (where < 0) await page.waitForTimeout(500);
  }
  if (where < 0) return { ok: false, why: "the control could not be found again" };
  await page.evaluate(COLLECT, where);
  const target = page.locator('[data-inv="target"]');
  if ((await target.count()) !== 1) return { ok: false, why: "the control could not be found again" };
  await page.evaluate(() => {
    const w = window as any;
    w.__fx = { mut: 0, clip: 0 };
    w.__mo?.disconnect();
    w.__mo = new MutationObserver((records) => {
      w.__fx.mut += records.filter((r) => !(r.type === "attributes" && r.attributeName === "data-inv")).length;
    });
    w.__mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      navigator.clipboard.writeText = async () => {
        w.__fx.clip++;
      };
    } catch {
      // The clipboard can be read-only; a copy button then shows its own toast.
    }
  });
  // A control that shows the state the screen is already in (the current page, the selected filter, the checked option)
  // has nothing left to change when it is operated; the other options of its group are probed on their own.
  const current = await target.evaluate((el) => {
    const link = el as HTMLAnchorElement;
    return el.getAttribute("aria-current") === "page" || el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-selected") === "true" || (el.matches("input[type=radio]") && (el as HTMLInputElement).checked) || (link.tagName === "A" && link.getAttribute("href") === location.hash);
  });
  if (current) return { ok: true, why: "" };
  const requests: string[] = [];
  const onRequest = (r: { url(): string; method(): string }) => {
    if (r.url().includes("/api/")) requests.push(`${r.method()} ${r.url()}`);
  };
  let downloads = 0;
  const onDownload = () => downloads++;
  page.on("request", onRequest);
  page.on("download", onDownload);
  const snapshot = () =>
    target.evaluate((el) => {
      const e = el as HTMLInputElement & HTMLSelectElement;
      return JSON.stringify({ hash: location.hash, checked: e.checked, value: e.value, pressed: el.getAttribute("aria-pressed"), ariaChecked: el.getAttribute("aria-checked"), expanded: el.getAttribute("aria-expanded"), selected: el.getAttribute("aria-selected"), open: (el.closest("details") as HTMLDetailsElement | null)?.open ?? null });
    });
  try {
    const before = await snapshot();
    const tag = await target.evaluate((el) => `${el.tagName.toLowerCase()}:${(el as HTMLInputElement).type ?? ""}`);
    if (tag.startsWith("select")) {
      const values = await target.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      const current = await target.inputValue();
      const other = values.find((v) => v !== current);
      if (other === undefined) return { ok: false, why: "a select with a single option" };
      await target.selectOption(other, { timeout: 5000 });
    } else if (tag === "input:number" || tag === "input:text" || tag === "textarea:textarea" || tag === "input:" || tag === "input:search") {
      const current = await target.inputValue();
      await target.fill(tag === "input:number" ? (current === "7" ? "8" : "7") : `${current}x`, { timeout: 5000 });
    } else if (tag === "input:radio" || tag === "input:checkbox") {
      await target.evaluate((el) => (el as HTMLInputElement).click());
    } else {
      await target.click({ timeout: 5000 });
    }
    await page.waitForTimeout(350);
    const after = (await target.count()) > 0 ? await snapshot() : "gone";
    const fx = await page.evaluate(() => (window as any).__fx as { mut: number; clip: number });
    const changed = after !== before;
    if (changed || fx.mut > 0 || fx.clip > 0 || requests.length > 0 || downloads > 0) return { ok: true, why: "" };
    return { ok: false, why: "operated and nothing changed" };
  } catch (e) {
    return { ok: false, why: `could not be operated: ${String(e).split("\n")[0]}` };
  } finally {
    page.off("request", onRequest);
    page.off("download", onDownload);
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(420_000);
  fixture = createFixture();
  server = await startServer(fixture);
  context = await browser.newContext({ viewport: { width: 1450, height: 900 }, locale: "pt-BR", colorScheme: "light" });
  page = await context.newPage();
  // Nothing waits without a limit: a locator that never shows up is an error with a stack, not a stuck test.
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(40_000);
  await page.goto(server.bootstrapUrl);
  await expect(page.locator("main h1").first()).toBeVisible();
  base = page.url().split("#")[0]!;
  await page.goto(`${base}#/plan`);
  await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/, { timeout: 60_000 });
  await page.getByRole("button", { name: "Executar" }).click();
  await expect(page.getByTestId("run-state")).toHaveAttribute("data-state", "finished", { timeout: 120_000 });
  resultHash = new URL(page.url()).hash;
});

test.afterAll(async () => {
  await context?.close();
  await server?.stop();
  fixture?.cleanup();
});

/** Collects the controls of one screen: its first state, each of its tabs and, for the tool area, the open editor. */
async function collectGroup(group: string): Promise<Control[]> {
  const controls = new Map<string, Control>();
  const route = group === "result" ? { id: "result", hash: resultHash } : ROUTES.find((r) => r.id === group)!;
  const hash = route.hash;
  await open(hash);
  // A screen may reopen on the tab used last, so the first state names its tab too.
  const first = ((await page.getByRole("tab", { selected: true }).first().textContent().catch(() => null)) ?? "").trim();
  await collect(route.id, first ? { hash, tab: first } : { hash }, controls);
  // Each tab of the screen is a state of its own.
  const tabs = await page.getByRole("tab").allTextContents();
  for (const name of tabs.map((n) => n.trim()).filter(Boolean)) {
    await page.getByRole("tab", { name, exact: true }).first().click();
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    await collect(`${route.id}/${name}`, { hash, tab: name }, controls);
  }
  if (group === "tool") {
    // The editor and its review.
    await open("#/tools/ruff");
    await page.getByRole("tab", { name: "Arquivos" }).click();
    await page.getByRole("button", { name: /pyproject\.toml/ }).first().click();
    await expect(page.locator(".editor-host .cm-content")).toContainText("tool.ruff.lint");
    await collect("tool/editor", { hash: "#/tools/ruff", editor: true }, controls);
  }
  return [...controls.values()];
}

/** A control is covered when another spec names it (accessible name or data-testid) or it carries the mark of unavailable. */
function covered(c: Control, sources: string): boolean {
  if (c.unavailable) return true;
  if (c.testid && sources.includes(c.testid.toLowerCase())) return true;
  // A name that carries data (an instance, a profile, a file) is found by its fixed beginning: words are dropped from the
  // end until two remain.
  const said = (text: string): boolean => {
    const words = text.toLowerCase().replace(/\s+/g, " ").split(" ");
    for (let n = words.length; n >= Math.min(2, words.length); n--) {
      const part = words.slice(0, n).join(" ");
      if (part.length >= 6 && sources.includes(part)) return true;
    }
    return false;
  };
  return c.candidates.some(said);
}

// A control no other spec names is probed here: it is operated for real and must change something (the page, the address,
// a request to the API, the clipboard, a download or its own state). A control that does nothing fails. One test per
// screen keeps each run short.
const GROUPS = [...ROUTES.map((r) => r.id), "result"];
for (const group of GROUPS) {
  test(`every visible control of ${group} has a test of effect or the mark of unavailable`, async () => {
    test.setTimeout(420_000);
    const sources = testSources();
    const mine = await collectGroup(group);
    expect(mine.length, `no control found on ${group}`).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const c of mine) {
      if (covered(c, sources) || c.disabled) continue;
      const effect = await probe(c);
      if (!effect.ok) missing.push(`${c.key}${c.testid ? ` [${c.testid}]` : ""}: ${effect.why}`);
    }
    expect(missing).toEqual([]);
  });
}

test("a control marked as unavailable always says why", async () => {
  const bad: string[] = [];
  for (const route of ["#/config/execution", "#/config", "#/preferences"]) {
    await open(route);
    const marked = await page.evaluate(() => [...document.querySelectorAll("[data-control-unavailable]")].map((e) => ({ reason: e.getAttribute("data-control-unavailable") ?? "", text: (e.textContent ?? "").trim().slice(0, 40) })));
    for (const m of marked) if (m.reason.trim().length < 12) bad.push(`${route}: ${m.text}`);
  }
  expect(bad).toEqual([]);
});

test("no screen carries an emoji or a decorative pictogram", async () => {
  test.setTimeout(240_000);
  const found: string[] = [];
  for (const route of [...ROUTES, { id: "result", hash: resultHash }]) {
    await open(route.hash);
    const hits = await page.evaluate(() => {
      const rx = /[\p{Extended_Pictographic}\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F]/u;
      const text = document.body.innerText;
      const attrs = [...document.querySelectorAll("[aria-label], [title], [placeholder]")].map((e) => `${e.getAttribute("aria-label") ?? ""} ${e.getAttribute("title") ?? ""} ${e.getAttribute("placeholder") ?? ""}`).join(" ");
      return [...`${text} ${attrs}`].filter((ch) => rx.test(ch));
    });
    if (hits.length) found.push(`${route.id}: ${[...new Set(hits)].join(" ")}`);
  }
  expect(found).toEqual([]);
});
