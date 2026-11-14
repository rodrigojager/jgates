import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createFixture, startServer, wizardFixture, type Fixture, type UiServer } from "./support";
import { scanAll, type Scan } from "./look-scan";

// V2-74 (PLAN-consistency.md X9-X19): one look and working access on every non-semantic screen, walked at 1280 and 375 px
// in the light and the dark theme: every disabled control has a reason, every target is at least 24 px high, no table
// column is cut and no page scrolls sideways, no native unstyled select, input, progress or fieldset is left, a select
// with one option is text, there is one primary button per screen, and the focus ring never wraps the whole content area.
// The dialogs focus their first field and offer one way to cancel. The mascots are where their subject is on screen.

interface Screen {
  id: string;
  hash: string;
}

const SCREENS: Screen[] = [
  { id: "overview", hash: "#/overview" },
  { id: "workspace", hash: "#/workspace" },
  { id: "environment", hash: "#/environment" },
  { id: "config-profile", hash: "#/config" },
  { id: "config-templates", hash: "#/config/templates" },
  { id: "config-architecture", hash: "#/config/architecture" },
  { id: "config-execution", hash: "#/config/execution" },
  { id: "config-yaml", hash: "#/config/yaml" },
  { id: "tools", hash: "#/tools" },
  { id: "tool", hash: "#/tools/ruff" },
  { id: "pii", hash: "#/tools/builtin-pii" },
  { id: "dependencies", hash: "#/config/dependencies" },
  { id: "extension-image", hash: "#/config/image" },
  { id: "services", hash: "#/config/services" },
  { id: "history", hash: "#/validations" },
  { id: "choose", hash: "#/validations/choose" },
  { id: "review", hash: "#/validations/review" },
  { id: "result", hash: "RESULT" },
  { id: "preferences", hash: "#/preferences" },
  { id: "storage", hash: "#/preferences/storage" },
  { id: "providers", hash: "#/preferences/providers" },
  { id: "help", hash: "#/help" },
  { id: "about", hash: "#/about" },
  { id: "policy", hash: "#/policy" },
];

let fixture: Fixture;
let server: UiServer;
let context: BrowserContext;
let page: Page;
let base = "";
let resultHash = "";

async function settle(): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  // The screens ask for their data after the first paint; a spinner on screen means it has not arrived.
  await expect(page.locator("main .spinner-text, main [aria-busy=true]")).toHaveCount(0, { timeout: 20_000 }).catch(() => undefined);
}

async function open(hash: string): Promise<void> {
  await page.goto(`${base}${hash === "RESULT" ? resultHash : hash}`);
  await page.reload();
  await expect(page.locator("main h1").first()).toBeVisible();
  await settle();
}

/** The bootstrap link works once: the one page of the spec changes its width and theme instead of a new context. */
async function look(width: number, scheme: "light" | "dark"): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: scheme });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  fixture = createFixture();
  server = await startServer(fixture);
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "pt-BR", colorScheme: "light" });
  page = await context.newPage();
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

/** The rules of the scan that hold on every screen; each line names the screen it was found on. */
function offenders(found: Map<string, Scan>): string[] {
  const lines: string[] = [];
  for (const [id, scan] of found) {
    for (const rule of ["disabled", "targets", "cut", "native", "single", "sideways", "layout"] as const) {
      for (const line of scan[rule]) lines.push(`${id} ${rule}: ${line}`);
    }
    if (scan.primary.length > 1) lines.push(`${id} primary: ${scan.primary.join(" | ")}`);
  }
  return lines;
}

const COMBINATIONS: Array<{ width: number; scheme: "light" | "dark" }> = [
  { width: 1280, scheme: "light" },
  { width: 375, scheme: "light" },
  { width: 1280, scheme: "dark" },
  { width: 375, scheme: "dark" },
];

for (const { width, scheme } of COMBINATIONS) {
  test(`every screen at ${width} px, ${scheme} theme: access, targets, columns, controls and one primary button`, async () => {
    test.setTimeout(600_000);
    await look(width, scheme);
    const found = new Map<string, Scan>();
    for (const screen of SCREENS) {
      await open(screen.hash);
      found.set(screen.id, await page.evaluate(scanAll));
    }
    expect(offenders(found)).toEqual([]);
  });
}

// ---- The mascots are where their subject is on screen (X9, X10) ------------------------------------------------------------
const strip = () => page.getByTestId("quality-mascots");

test("the doctor is on Ambiente and the overview; the quality strip is on Perfil, the tools catalogue, Templates and the own-tool step", async () => {
  test.setTimeout(240_000);
  await look(1280, "light");
  await open("#/environment");
  await expect(page.getByTestId("env-head").locator('[data-mascot="doctor"]')).toHaveCount(1);
  // The overview has the Doctor once: in the prerequisites bar while it shows, in the readiness card once it leaves.
  await open("#/overview");
  await expect.poll(() => page.locator('main [data-mascot="doctor"]').count(), { timeout: 30_000 }).toBe(1);
  for (const hash of ["#/config", "#/config/templates", "#/tools"]) {
    await open(hash);
    await expect(strip(), hash).toBeVisible({ timeout: 90_000 });
    await expect(strip().locator("[data-domain]"), hash).toHaveCount(6);
  }
  // On the tools catalogue the strip is also the category filter: a category in it lists that category's tools.
  const category = page.locator("main select").first();
  await strip().locator('[data-domain="quality"] .quality-mascot-details').click();
  await expect(category).toHaveValue("quality");
  await strip().locator('[data-domain="quality"] .quality-mascot-details').click();
  await expect(category).toHaveValue("");
  // The own-tool step "O que verifica" shows it too.
  await open("#/tools?custom=1");
  const own = page.getByTestId("custom-tool-dialog");
  await expect(own).toBeVisible();
  await own.getByRole("radio", { name: "Instalar no ambiente do JGates" }).check();
  await own.getByLabel("Pacote e versão").fill("acme-lint==1.0");
  await own.getByTestId("ctl-next").click();
  await own.getByTestId("ctl-command").fill("acme-lint");
  await own.getByTestId("ctl-component").selectOption({ index: 0 });
  await own.getByTestId("ctl-next").click();
  await own.getByTestId("ctl-next").click();
  await expect(own).toHaveAttribute("data-step", "verify");
  await expect(own.getByTestId("quality-mascots")).toBeVisible({ timeout: 90_000 });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

test("the strip's states do not look like buttons, and it holds its room while it loads (no jump on Escolher)", async () => {
  test.setTimeout(240_000);
  for (const width of [1280, 375]) {
    await look(width, "light");
    await open("#/config");
    await expect(strip()).toBeVisible({ timeout: 90_000 });
    const status = await strip().locator(".quality-mascot-status").first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopWidth, radius: s.borderTopLeftRadius, background: s.backgroundColor, cursor: s.cursor, button: el.closest("button, a, [role=button]") !== null };
    });
    expect(status, `at ${width} px`).toEqual({ border: "0px", radius: "0px", background: "rgba(0, 0, 0, 0)", cursor: "default", button: false });
    // Escolher: the preview of the plan arrives late; the button under the strip stays where it is.
    await page.route("**/api/plans", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue();
    });
    await page.goto(`${base}#/validations/choose`);
    await page.reload();
    const reserved = page.getByTestId("quality-mascots-reserved");
    await expect(reserved).toBeVisible({ timeout: 30_000 });
    const before = await page.locator("main button.btn.primary").first().boundingBox();
    await expect(strip()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(500);
    const after = await page.locator("main button.btn.primary").first().boundingBox();
    expect(before && after ? Math.abs(after.y - before.y) : 999, `the primary button moved at ${width} px (${before?.y} -> ${after?.y})`).toBeLessThanOrEqual(4);
    await page.unroute("**/api/plans");
  }
});

// ---- Dialogs: the first field has the focus and there is one way to cancel (X16) ---------------------------------------------
const DIALOGS: Array<{ id: string; hash: string; open: (p: Page) => Promise<void> }> = [
  { id: "workspace switcher", hash: "#/overview", open: async (p) => {
      if (!(await p.locator(".workspace-switch").isVisible())) await p.locator(".mobile-toggle").click();
      await p.locator(".workspace-switch").click();
    },
  },
  { id: "create a profile", hash: "#/config", open: (p) => p.getByRole("button", { name: /^Criar perfil/ }).first().click() },
  { id: "rename a tool", hash: "#/tools", open: (p) => p.getByRole("button", { name: /^Renomear / }).first().click() },
  { id: "add a tool", hash: "#/tools", open: (p) => p.getByRole("button", { name: "Adicionar ferramenta", exact: true }).click() },
  { id: "own tool", hash: "#/tools?custom=1", open: async () => undefined },
  { id: "create a template", hash: "#/config/templates", open: (p) => p.getByRole("button", { name: "Criar template" }).click() },
  { id: "declare a component", hash: "#/workspace", open: (p) => p.getByRole("button", { name: "Declarar componente" }).first().click() },
];

for (const width of [1280, 375]) {
  test(`every dialog focuses its first field and has one cancel action at ${width} px`, async () => {
    test.setTimeout(300_000);
    await look(width, "light");
    const problems: string[] = [];
    for (const dialog of DIALOGS) {
      await open(dialog.hash);
      await dialog.open(page);
      const box = page.locator("dialog[open]");
      await expect(box, dialog.id).toBeVisible();
      // Content that loads after the first paint gets the focus too, within a moment.
      await page.waitForTimeout(800);
      const state = await box.evaluate((el) => {
        const active = document.activeElement as HTMLElement | null;
        const names = (el as HTMLElement).querySelectorAll<HTMLElement>("button");
        const cancels = [...names].filter((b) => /^(cancelar|fechar|cancel|close)$/i.test((b.textContent ?? "").trim()));
        const fields = [...el.querySelectorAll<HTMLElement>("input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled)")].filter((f) => f.offsetParent !== null);
        return {
          inside: active !== null && el.contains(active),
          onCancel: active !== null && cancels.includes(active),
          firstField: fields[0] === active,
          hasFields: fields.length > 0,
          onTitle: active?.id === "dialog-title" || active?.id === "ctl-step-title",
          onStepTitle: active?.id === "ctl-step-title",
          cancels: cancels.length,
          active: active?.outerHTML.slice(0, 90) ?? "none",
          first: fields[0]?.outerHTML.slice(0, 90) ?? "none",
        };
      });
      if (!state.inside) problems.push(`${dialog.id}: focus is outside the dialog`);
      if (state.onCancel) problems.push(`${dialog.id}: the focus is on the cancel button`);
      // A stepped dialog (the own tool) puts the focus on the title of the step it opens at, which is announced.
      if (state.hasFields && !state.firstField && !state.onStepTitle) problems.push(`${dialog.id}: the focus is not on the first field (on ${state.active}; first ${state.first})`);
      if (!state.hasFields && !state.onTitle) problems.push(`${dialog.id}: with no field the focus is not on the title`);
      if (state.cancels !== 1) problems.push(`${dialog.id}: ${state.cancels} cancel actions`);
      await page.keyboard.press("Escape");
      // The own-tool dialog asks before it goes; nothing typed here, so it closes at once.
      await expect(page.locator("dialog[open]"), `${dialog.id} closes with Escape`).toHaveCount(0);
    }
    expect(problems).toEqual([]);
  });
}

// ---- The focus ring and the layout rules (X12, X13) --------------------------------------------------------------------------
test("after a keyboard navigation the ring is on the control, not around the content area; cards use the width", async () => {
  test.setTimeout(240_000);
  await look(1280, "light");
  await open("#/overview");
  const link = page.locator(".sidebar a.nav-item:not([aria-current])").first();
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("main h1").first()).toBeVisible();
  const main = await page.locator("main").evaluate((el) => ({ focused: document.activeElement === el, outline: getComputedStyle(el).outlineStyle }));
  expect(main.outline, "no ring around the content area").toBe("none");
  // The ring of a control stays.
  await link.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  expect(await link.evaluate((el) => getComputedStyle(el).outlineStyle), "the focused control keeps its ring").not.toBe("none");

  // Perfil: the open category takes the width of its card; Workspace: a single component card takes the row.
  await open("#/config");
  await page.locator("section.category").first().getByRole("button", { name: /^Abrir a categoria/ }).click();
  const widths = await page.locator("section.category").first().evaluate((el) => ({ category: el.getBoundingClientRect().width, box: (el.parentElement as HTMLElement).getBoundingClientRect().width }));
  expect(widths.category / widths.box).toBeGreaterThan(0.9);
  await open("#/workspace");
  await expect(page.locator(".ws-card").first()).toBeVisible();
  const cards = await page.locator(".ws-cards").evaluate((el) => ({ count: el.children.length, card: el.children[0]!.getBoundingClientRect().width, row: el.getBoundingClientRect().width }));
  expect(cards.card * cards.count / cards.row, "the component cards share the whole row").toBeGreaterThan(0.85);
});

// ---- The wizard, step by step (X9: the doctor on steps 1-2, the strip on 4 and 6) ----------------------------------------------
for (const width of [1280, 375]) {
  test(`the wizard at ${width} px: every step scanned, the doctor on steps 1 and 2, the strip on steps 4 and 6`, async ({ browser }) => {
    test.setTimeout(540_000);
    const fx = wizardFixture("pt-BR");
    const srv = await startServer(fx);
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: "pt-BR", colorScheme: "light" });
    const wp = await ctx.newPage();
    wp.setDefaultTimeout(30_000);
    try {
      await wp.goto(srv.bootstrapUrl);
      const wizard = wp.locator('[data-state="wizard"]');
      await expect(wizard).toBeVisible();
      const next = (name: string) => wizard.getByTestId("wizard-nav").getByRole("button", { name, exact: true });
      const found = new Map<string, Scan>();
      const scan = async (step: number) => {
        await expect(wp.locator("main .spinner-text")).toHaveCount(0, { timeout: 20_000 }).catch(() => undefined);
        found.set(`wizard step ${step}`, await wp.evaluate(scanAll));
      };
      // 1 Docker
      await expect(wizard.getByTestId("wizard-engine")).toHaveAttribute("data-engine", "ready");
      await expect(wizard.locator('[data-mascot="doctor"]')).toHaveCount(1);
      await scan(1);
      await next("Continuar").click();
      // 2 Ferramentas
      await expect(wizard.getByTestId("wizard-step-tools")).toBeVisible();
      await expect(wizard.locator('[data-mascot="doctor"]')).toHaveCount(1);
      await scan(2);
      await wizard.getByRole("button", { name: "Baixar as ferramentas do JGates" }).click();
      await expect(wizard.getByTestId("wizard-download")).toHaveAttribute("data-state", "ready");
      await next("Continuar").click();
      // 3 Projeto
      await expect(wizard.getByTestId("wizard-step-project")).toBeVisible();
      await scan(3);
      await next("Continuar").click();
      // 4 Perfil
      await expect(wizard.getByTestId("wizard-step-profile")).toBeVisible();
      await expect(wizard.getByTestId("quality-mascots")).toBeVisible({ timeout: 90_000 });
      await scan(4);
      await next("Salvar e continuar").click();
      // 5 Dependências
      await expect(wizard.getByTestId("wizard-step-dependencies")).toBeVisible();
      await wizard.getByRole("button", { name: "Preparar dependências" }).click();
      await expect(wizard.getByTestId("wizard-deps-status")).toHaveAttribute("data-state", "done");
      await scan(5);
      await next("Continuar").click();
      // 6 Revisão
      await expect(wizard.getByTestId("wizard-plan")).toBeVisible({ timeout: 90_000 });
      await expect(wizard.getByTestId("quality-mascots")).toBeVisible({ timeout: 90_000 });
      await scan(6);
      expect(offenders(found)).toEqual([]);
    } finally {
      await ctx.close();
      await srv.stop();
      fx.cleanup();
    }
  });
}

// Long pages: Ferramentas, Templates and Revisar default to the project's languages, with groups collapsed and counted. On
// the Python fixture at 1280 px each is under a third of the height it had before (21 200, 8 750 and 7 400 px).
const BEFORE = { tools: 21_200, "config-templates": 8_750, review: 7_400 };
test("the long pages default to the project's languages: under a third of their old height at 1280 px", async () => {
  test.setTimeout(240_000);
  await look(1280, "light");
  const heights: Record<string, number> = {};
  for (const [id, hash] of [["tools", "#/tools"], ["config-templates", "#/config/templates"], ["review", "#/validations/review"]] as const) {
    await open(hash);
    heights[id] = await page.evaluate(() => document.documentElement.scrollHeight);
  }
  const over = Object.entries(BEFORE).filter(([id, before]) => (heights[id] ?? 0) * 3 >= before).map(([id, before]) => `${id}: ${heights[id]} px, limit ${Math.floor(before / 3)} px`);
  expect(over).toEqual([]);
});
