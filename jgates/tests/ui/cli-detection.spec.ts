import { expect, test, type Page } from "@playwright/test";
import { createFixture, startServer, type Fixture, type UiServer } from "./support";

// The detection of the agent CLIs is cached by the server (DC1). On both screens (the provider step of the Semantic
// setup and Provedores e chaves) the button "Detectar de novo" / "Detect again" sits at the top of the list, the text
// "Detectado às <time>" / "Detected at <time>" says when the detection was made, the cards show their checking state
// while it runs, and "Verificar de novo" on one card still exists. GET /api/providers/cli-status is stubbed in the
// browser: no real CLI runs. A held request lets the test see the checking state.

interface Stub {
  calls: string[];
  /** While set, a refresh=1 request waits for it (the cards are in their checking state meanwhile). */
  hold: Promise<void> | null;
  /** Number of detections: it moves the time of the answer, as a real detection would. */
  detections: number;
}

function entry(id: string, name: string, command: string, installed: boolean, login: "logged-in" | "not-logged-in" | "unknown", checkedAt: string) {
  return {
    id,
    name,
    command,
    installed,
    path: installed ? `C:/stub/${command}.cmd` : null,
    version: installed ? "1.0.0" : null,
    login: { state: installed ? login : "unknown", reason: installed ? "STATUS_COMMAND" : "NOT_INSTALLED", method: null, checkedWith: `${command} status` },
    models: installed ? { source: "suggested", list: ["alpha", "beta"], truncated: false, configured: null, configuredIn: null, suggestedDefault: "alpha", problem: null } : null,
    loginCommand: { command, args: ["login"], display: `${command} login` },
    install: `npm install -g ${command}-stub`,
    checkedAt,
  };
}

async function stubCli(page: Page): Promise<Stub> {
  const stub: Stub = { calls: [], hold: null, detections: 0 };
  // The first detection was made at 10:15:30 UTC of a fixed day; every new detection is a minute later. The text on screen
  // is the local time, so the tests compare against the formatter's own output for the same instant.
  let current = Date.UTC(2026, 10, 14, 10, 15, 30);
  await page.route("**/api/providers/cli-status**", async (route) => {
    const url = new URL(route.request().url());
    stub.calls.push(url.search);
    if (url.searchParams.get("refresh") === "1") {
      if (stub.hold) await stub.hold;
      stub.detections += 1;
      current += 60_000;
    }
    const at = new Date(current).toISOString();
    const only = url.searchParams.get("only");
    const all = [
      entry("claude-code", "Claude Code", "claude", true, "logged-in", at),
      entry("codex-cli", "Codex CLI", "codex", true, "logged-in", at),
      entry("opencode", "OpenCode", "opencode", true, "not-logged-in", at),
      entry("gemini-cli", "Gemini CLI", "gemini", false, "unknown", at),
    ];
    const providers = only ? all.filter((p) => p.id === only) : all;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, status: "OK", checkedAt: at, timeoutMs: 8000, providers }) });
  });
  return stub;
}

/** The time the page shows for a detection: the same local formatter the product uses (medium time of the language). */
async function shown(page: Page, language: string, ms: number): Promise<string> {
  return page.evaluate(([lang, at]) => new Date(at as number).toLocaleTimeString(lang as string, { timeStyle: "medium" }), [language, ms] as const);
}

const FIRST = Date.UTC(2026, 10, 14, 10, 15, 30);
const AFTER = FIRST + 60_000;

const SCREENS = [
  { name: "provider step", route: "#/semantic/setup?step=provider", ready: { pt: "Quem vai fazer a revisão por IA?", en: "Who will do the AI review?" }, bar: "semprov-detect", card: (page: Page, id: string) => page.locator(`[data-testid="semprov-step"] .semprov-card[data-provider="${id}"]`), recheck: (name: string, language: "pt" | "en") => (language === "pt" ? `Verificar de novo o ${name}` : `Check ${name} again`) },
  { name: "Provedores e chaves", route: "#/preferences/providers", ready: { pt: "Provedores e chaves", en: "Providers and keys" }, bar: "pk-cli-detect", card: (page: Page, id: string) => page.getByTestId(`provider-${id}`), recheck: (name: string, language: "pt" | "en") => (language === "pt" ? `Verificar de novo o ${name}` : `Check ${name} again`) },
] as const;

test.describe("the detection cache on both screens", () => {
  let fixture: Fixture;
  let server: UiServer;

  test.beforeEach(async () => {
    fixture = createFixture();
    server = await startServer(fixture);
  });

  test.afterEach(async () => {
    await server?.stop();
    fixture?.cleanup();
  });

  async function open(page: Page, route: string): Promise<string> {
    await page.goto(server.bootstrapUrl);
    await page.waitForURL((u) => !u.pathname.startsWith("/session"));
    const base = page.url().split("#")[0] as string;
    await page.goto(`${base}${route}`);
    return base;
  }

  for (const screen of SCREENS) {
    test(`${screen.name} (pt-BR): Detectar de novo at the top, Detectado às, the checking state, the keyboard and Verificar de novo`, async ({ page }) => {
      const stub = await stubCli(page);
      await open(page, screen.route);
      await expect(page.getByRole("heading", { name: screen.ready.pt })).toBeVisible();
      const bar = page.getByTestId(screen.bar);
      const button = bar.getByRole("button", { name: "Detectar de novo" });
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
      // The text names the time of the detection, with the product's formatter.
      await expect(page.getByTestId(`${screen.bar}-at`)).toHaveText(`Detectado às ${await shown(page, "pt-BR", FIRST)}`);
      // The bar is above the cards of the CLIs.
      const barBox = await bar.boundingBox();
      const cardBox = await screen.card(page, "claude-code").boundingBox();
      expect(barBox && cardBox && barBox.y < cardBox.y).toBe(true);
      // Opening the screen asked once, without refresh.
      expect(stub.calls.filter((q) => q.includes("refresh=1"))).toEqual([]);

      // Keyboard: the button is reached and pressed without the mouse; while it runs the cards say they are checking.
      let release!: () => void;
      stub.hold = new Promise<void>((resolve) => (release = resolve));
      await button.focus();
      await page.keyboard.press("Enter");
      for (const id of ["claude-code", "codex-cli", "opencode", "gemini-cli"]) await expect(screen.card(page, id)).toHaveAttribute("data-state", "checking");
      await expect(button).toBeDisabled();
      release();
      stub.hold = null;
      await expect(screen.card(page, "claude-code")).toHaveAttribute("data-state", "ready");
      await expect(button).toBeEnabled();
      expect(stub.calls.filter((q) => q.includes("refresh=1") && !q.includes("only="))).toHaveLength(1);
      await expect(page.getByTestId(`${screen.bar}-at`)).toHaveText(`Detectado às ${await shown(page, "pt-BR", AFTER)}`);

      // "Verificar de novo" on one card still exists and asks for that CLI alone.
      const recheck = page.getByRole("button", { name: screen.recheck("Gemini CLI", "pt") });
      await expect(recheck).toBeVisible();
      await recheck.click();
      await expect.poll(() => stub.calls.some((q) => q.includes("only=gemini-cli") && q.includes("refresh=1"))).toBe(true);
    });

    test(`${screen.name} (English): Detect again, Detected at and Check again`, async ({ page }) => {
      const stub = await stubCli(page);
      const base = await open(page, "#/preferences");
      await page.getByTestId("prefs-language").selectOption("en");
      await expect(page.getByRole("heading", { name: "Preferences", level: 1 })).toBeVisible();
      await page.goto(`${base}${screen.route}`);
      await expect(page.getByRole("heading", { name: screen.ready.en })).toBeVisible();
      const bar = page.getByTestId(screen.bar);
      const button = bar.getByRole("button", { name: "Detect again" });
      await expect(button).toBeVisible();
      await expect(page.getByTestId(`${screen.bar}-at`)).toHaveText(`Detected at ${await shown(page, "en", FIRST)}`);
      await button.focus();
      await page.keyboard.press("Space");
      await expect(page.getByTestId(`${screen.bar}-at`)).toHaveText(`Detected at ${await shown(page, "en", AFTER)}`);
      expect(stub.detections).toBe(1);
      await expect(page.getByRole("button", { name: screen.recheck("Gemini CLI", "en") })).toBeVisible();
      // No catalog key shows up raw.
      expect(await page.locator("main").innerText()).not.toMatch(/\bsemprov_[a-z_]+\b/);
    });
  }
});
