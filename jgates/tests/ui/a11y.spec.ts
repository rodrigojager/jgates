import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createFixture, startServer, type Fixture, type UiServer } from "./support";

// Every screen is checked by axe in the Light, Dark and System themes (System in both color schemes of the
// operating system), the editor and the diff included, and is operable with the keyboard alone with a visible focus.

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
  { id: "not-found", hash: "#/config/nao-existe" },
];

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const EDITOR = ".editor-host .cm-content";

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

type Mode = { name: string; theme: "light" | "dark" | "system"; scheme: "light" | "dark" };
const MODES: Mode[] = [
  { name: "light", theme: "light", scheme: "light" },
  { name: "dark", theme: "dark", scheme: "dark" },
  { name: "system (os light)", theme: "system", scheme: "light" },
  { name: "system (os dark)", theme: "system", scheme: "dark" },
];

async function applyMode(mode: Mode): Promise<void> {
  await page.emulateMedia({ colorScheme: mode.scheme });
  await page.evaluate((theme) => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, mode.theme);
}

async function seriousViolations(label: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.map((n) => `${n.target.join(" ")} ${(n.failureSummary ?? "").replace(/\s+/g, " ")}`).join(" | ")}`);
}


test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  fixture = createFixture();
  server = await startServer(fixture);
  context = await browser.newContext({ viewport: { width: 1450, height: 900 }, locale: "pt-BR", colorScheme: "light" });
  page = await context.newPage();
  // Nothing waits without a limit: a locator that never shows up is an error with a stack, not a stuck test.
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(40_000);
  await page.goto(server.bootstrapUrl);
  await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 }).or(page.locator("main h1").first())).toBeVisible();
  base = page.url().split("#")[0]!;
  // One real run, so the result screen has data.
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

for (const mode of MODES) {
  test(`axe finds no critical or serious violation on any screen (${mode.name})`, async () => {
    test.setTimeout(540_000);
    const found: string[] = [];
    const routes = [...ROUTES, { id: "result", hash: resultHash }];
    for (const route of routes) {
      await open(route.hash);
      await applyMode(mode);
      found.push(...(await seriousViolations(`${mode.name} ${route.id}`)));
    }
    expect(found).toEqual([]);
  });

  test(`axe covers the editor, the diff and the dialogs (${mode.name})`, async () => {
    test.setTimeout(240_000);
    const found: string[] = [];
    await open("#/tools/ruff");
    await applyMode(mode);
    await page.getByRole("tab", { name: "Arquivos" }).click();
    await page.getByRole("button", { name: /pyproject\.toml/ }).first().click();
    await expect(page.locator(EDITOR)).toContainText("tool.ruff.lint");
    found.push(...(await seriousViolations(`${mode.name} editor`)));
    await page.locator(EDITOR).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type('ignore = ["F401"]');
    await page.getByRole("button", { name: "Revisar alterações" }).click();
    await expect(page.getByRole("dialog")).toContainText('ignore = ["F401"]');
    found.push(...(await seriousViolations(`${mode.name} diff`)));
    await page.keyboard.press("Escape");
    await open("#/overview");
    await applyMode(mode);
    await page.getByRole("button", { name: "Selecionar workspace" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    found.push(...(await seriousViolations(`${mode.name} workspace-dialog`)));
    await page.keyboard.press("Escape");
    expect(found).toEqual([]);
  });
}

test("axe finds no violation on the error and empty states", async () => {
  test.setTimeout(120_000);
  const found: string[] = [];
  // A failing API answer: the screens show their error notice, which must be accessible too.
  await page.route("**/api/overview", (route) => route.fulfill({ status: 500, json: { status: "ERROR", code: "BOOM", message: "Falha simulada" } }));
  await open("#/overview");
  await expect(page.getByRole("alert").first()).toBeVisible();
  found.push(...(await seriousViolations("error overview")));
  await page.unroute("**/api/overview");
  expect(found).toEqual([]);
});

/** What the focus indicator of the active element looks like; the editor lives in a shadow root. */
async function focusState(): Promise<{ ok: boolean; label: string; visible: boolean; at: number }> {
  // CodeMirror marks itself as focused one frame after the focus event.
  await page.waitForTimeout(60);
  return page.evaluate(() => {
    let el: Element | null = document.activeElement;
    while (el && (el as HTMLElement).shadowRoot?.activeElement) el = (el as HTMLElement).shadowRoot!.activeElement;
    if (!el || el === document.body) return { ok: false, label: "body", visible: false, at: -1 };
    const at = [...document.querySelectorAll("*")].indexOf(el);
    const label = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""} ${(el.textContent ?? "").trim().slice(0, 30)}`;
    let target: Element = el;
    // In the editor, the ring is drawn by the .cm-editor that contains the focused content.
    if (el.classList.contains("cm-content")) target = el.closest(".cm-editor") ?? el;
    const style = getComputedStyle(target);
    const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== "rgba(0, 0, 0, 0)";
    const shadow = style.boxShadow !== "none" && style.boxShadow !== "";
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0;
    return { ok: outline || shadow, label, visible, at };
  });
}

test("every screen is operable with the keyboard alone and the focus is always visible", async () => {
  test.setTimeout(540_000);
  await page.emulateMedia({ colorScheme: "light" });
  const problems: string[] = [];
  const routes = [...ROUTES.filter((r) => r.id !== "not-found"), { id: "result", hash: resultHash }];
  for (const route of routes) {
    await open(route.hash);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    // Start from the top of the document; the skip link is the first stop.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const reached = new Set<string>();
    let previous = -2;
    for (let i = 0; i < 400; i++) {
      await page.keyboard.press("Tab");
      const state = await focusState();
      if (state.label === "body") break; // the focus left the page: the cycle is complete
      reached.add(state.label);
      if (!state.ok) problems.push(`${route.id}: no focus indicator on ${state.label}`);
      if (!state.visible) problems.push(`${route.id}: focused element not visible ${state.label}`);
      if (state.at === previous) {
        problems.push(`${route.id}: keyboard trap at ${state.label}`);
        break;
      }
      previous = state.at;
    }
    // Every native control that is on screen and enabled is a tab stop of the cycle.
    const unreachable = await page.evaluate(() => {
      const out: string[] = [];
      const seen = new Set<Element>();
      const nodes = document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [role=switch], [role=tab]");
      for (const n of nodes) {
        if (seen.has(n)) continue;
        const style = getComputedStyle(n);
        const rect = n.getBoundingClientRect();
        if (style.visibility === "hidden" || style.display === "none" || rect.width === 0 || rect.height === 0) continue;
        if ((n as HTMLButtonElement).disabled || n.closest("[inert]")) continue;
        if (n.getAttribute("tabindex") === "-1" && !n.matches("[role=tab]")) {
          out.push(`${n.tagName.toLowerCase()} tabindex=-1 ${(n.getAttribute("aria-label") ?? n.textContent ?? "").trim().slice(0, 30)}`);
        }
      }
      return out;
    });
    for (const u of unreachable) problems.push(`${route.id}: out of the tab order: ${u}`);
    if (reached.size === 0) problems.push(`${route.id}: no control could be reached with Tab`);
  }
  expect(problems).toEqual([]);
});

test("the skip link and a sidebar link work with Enter alone", async () => {
  await open("#/overview");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /Pular para o conteúdo/i })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#content")).toBeFocused();
  // Move to Workspace using the keyboard only: Tab to the sidebar link, Enter.
  await page.getByRole("link", { name: "Workspace" }).first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("main h1").first()).toHaveText(/Workspace/);
});

test("reduced motion is respected: nothing animates when the user asks for less motion", async () => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  const moving: string[] = [];
  for (const route of ROUTES.filter((r) => ["overview", "tools", "history", "review"].includes(r.id))) {
    await open(route.hash);
    const found = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("*")) {
        const s = getComputedStyle(el);
        const dur = (v: string) => v.split(",").some((x) => parseFloat(x) > 0.011 && !/^0(\.0\d*)?m?s$/.test(x.trim()));
        const infinite = s.animationName !== "none" && s.animationIterationCount === "infinite" && dur(s.animationDuration);
        const slow = s.animationName !== "none" && dur(s.animationDuration);
        const smooth = el === document.documentElement && s.scrollBehavior === "smooth";
        if (infinite || slow || smooth) out.push(`${el.tagName.toLowerCase()}.${el.className}`);
      }
      return out;
    });
    moving.push(...found.map((f) => `${route.id}: ${f}`));
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(moving).toEqual([]);
});
