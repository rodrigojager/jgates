import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { REPO, createFixture, startServer, type Fixture, type UiServer } from "./support";

// The layout at four widths (1450, 1100, 900 and 700 px) never scrolls horizontally, on every screen.

const WIDTHS = [1450, 1100, 900, 700];
const HEIGHT = 900;

/** A screen of the interface: an id for the error message and the hash it opens at ("RESULT" is the run's result). */
interface Screen {
  id: string;
  hash: string;
}

const SCREENS: Screen[] = [
  { id: "visao-geral", hash: "#/overview" },
  { id: "workspace", hash: "#/workspace" },
  { id: "ambiente", hash: "#/environment" },
  { id: "config-perfil", hash: "#/config" },
  { id: "config-templates", hash: "#/config/templates" },
  { id: "config-arquitetura", hash: "#/config/architecture" },
  { id: "config-execucao", hash: "#/config/execution" },
  { id: "config-yaml", hash: "#/config/yaml" },
  { id: "ferramentas", hash: "#/tools" },
  { id: "ferramenta", hash: "#/tools/ruff" },
  { id: "historico", hash: "#/validations" },
  { id: "escolher", hash: "#/validations/choose" },
  { id: "revisar", hash: "#/validations/review" },
  { id: "resultado", hash: "RESULT" },
  { id: "ajuda", hash: "#/help" },
  { id: "preferencias", hash: "#/preferences" },
  { id: "armazenamento", hash: "#/preferences/storage" },
  { id: "providers-e-chaves", hash: "#/preferences/providers" },
  { id: "sobre", hash: "#/about" },
  { id: "politica-ci", hash: "#/policy" },
];

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


test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  fixture = createFixture();
  server = await startServer(fixture);
  context = await browser.newContext({ viewport: { width: 1450, height: HEIGHT }, locale: "pt-BR", colorScheme: "light" });
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

/** How far the page reaches past the viewport; anything above 0 is a horizontal scrollbar. */
const overflow = () =>
  page.evaluate(() => {
    const root = document.documentElement;
    const widest = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((e) => e.getBoundingClientRect().right > root.clientWidth + 1 && getComputedStyle(e).position !== "fixed")
      .filter((e) => {
        // An element is only a problem when no ancestor clips or scrolls it by itself.
        for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return false;
        }
        return true;
      })
      .slice(0, 3)
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)}`);
    return { extra: root.scrollWidth - root.clientWidth, bodyExtra: document.body.scrollWidth - root.clientWidth, widest };
  });

for (const width of WIDTHS) {
  test(`no screen scrolls horizontally at ${width} px`, async () => {
    test.setTimeout(540_000);
    await page.setViewportSize({ width, height: HEIGHT });
    const problems: string[] = [];
    for (const screen of SCREENS) {
      await open(screen.hash === "RESULT" ? resultHash : screen.hash);
      const o = await overflow();
      if (o.extra > 0 || o.bodyExtra > 0) problems.push(`${screen.id}: ${Math.max(o.extra, o.bodyExtra)} px past the viewport (${o.widest.join(", ")})`);
    }
    // The editor and the diff of the tool area are the widest states.
    await open("#/tools/ruff");
    await page.getByRole("tab", { name: "Arquivos" }).click();
    await page.getByRole("button", { name: /pyproject\.toml/ }).first().click();
    await expect(page.locator(".editor-host .cm-content")).toContainText("tool.ruff.lint");
    let o = await overflow();
    if (o.extra > 0 || o.bodyExtra > 0) problems.push(`editor: ${Math.max(o.extra, o.bodyExtra)} px (${o.widest.join(", ")})`);
    await page.locator(".editor-host .cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type('ignore = ["F401"]');
    await page.getByRole("button", { name: "Revisar alterações" }).click();
    await expect(page.getByRole("dialog")).toContainText('ignore = ["F401"]');
    o = await overflow();
    if (o.extra > 0 || o.bodyExtra > 0) problems.push(`diff: ${Math.max(o.extra, o.bodyExtra)} px (${o.widest.join(", ")})`);
    await page.keyboard.press("Escape");
    // The open forms of Providers e chaves (Configurar, a key being typed, a new connection) and the card of the
    // semantic gate in edit mode.
    await open("#/preferences/providers");
    await page.getByRole("button", { name: "Configurar openai-compatible", exact: true }).click();
    await page.getByRole("button", { name: "Gravar chave OPENAI_API_KEY", exact: true }).click();
    await page.getByRole("button", { name: "Acrescentar conexão" }).click();
    await expect(page.getByTestId("add-connection-form")).toBeVisible();
    o = await overflow();
    if (o.extra > 0 || o.bodyExtra > 0) problems.push(`providers forms: ${Math.max(o.extra, o.bodyExtra)} px (${o.widest.join(", ")})`);
    await open("#/tools");
    await page.getByRole("button", { name: "Editar o semantic gate" }).click();
    await expect(page.getByTestId("semantic-form")).toBeVisible();
    o = await overflow();
    if (o.extra > 0 || o.bodyExtra > 0) problems.push(`semantic form: ${Math.max(o.extra, o.bodyExtra)} px (${o.widest.join(", ")})`);
    expect(problems).toEqual([]);
  });
}

test("the UI build has no chunk above 500 kB: the screens are loaded on demand", () => {
  const assets = path.join(REPO, "jgates", "dist", "ui", "assets");
  const scripts = fs.readdirSync(assets).filter((f) => f.endsWith(".js"));
  const big = scripts.filter((f) => fs.statSync(path.join(assets, f)).size > 500 * 1000);
  expect(big).toEqual([]);
  // Each screen is a chunk of its own, apart from the entry.
  for (const screen of ["workspace", "history", "config-profiles", "validations-review", "tool"]) {
    expect(scripts.some((f) => f.startsWith(`${screen}-`)), screen).toBe(true);
  }
  const entry = scripts.find((f) => f.startsWith("index-"));
  expect(entry).toBeTruthy();
  expect(fs.readFileSync(path.join(assets, entry!), "utf8")).not.toContain("tool.ruff");
});
