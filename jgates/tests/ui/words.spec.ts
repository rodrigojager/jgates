import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createFixture, startServer } from "./support";

// V2-73 (PLAN-consistency.md sections 1 and 2): the main screens read in one language. The spec walks them in pt-BR and
// in en and fails on text of the other language from a fixed list of the leaks found in the review (template
// descriptions, "Format check", "infrastructure", the CodeQL volume message, step errors) and on raw ids used as the main
// label ("strict", "full", "capability:", "sha256:" hashes, run ids in a button).

const SCREENS = ["/overview", "/workspace", "/environment", "/config", "/config/templates", "/config/architecture", "/config/execution", "/config/services", "/config/image", "/config/dependencies", "/tools", "/tools/ruff", "/validations", "/validations/choose", "/validations/review", "/preferences", "/preferences/storage", "/help"];

/** English that must never show in the Portuguese UI: each one is a leak the review found. */
const ENGLISH_LEAKS: RegExp[] = [
  /Format check/,
  /\binfrastructure\b/,
  /volume is not prepared/i,
  /the report is not JSON/i,
  /\bempty output\b/i,
  /Comes in by evidence/i,
  /Checks the formatting of/i,
  /Lints Dockerfiles/i,
  /Runs go test/i,
  /Type checks (Python|TypeScript)/i,
  /Quality gate \(bridge\)/i,
  /Semgrep \(local rules\)/i,
  /\bPerformance budgets\b/,
];

/** Portuguese that must never show in the English UI. */
const PORTUGUESE_LEAKS: RegExp[] = [/Verificação de formato/, /Infraestrutura/, /\bEssencial\b/, /\bEquilibrado\b/, /\bRigoroso\b/, /Cobertura de testes/, /Componentes (Python|Rust|Go|TypeScript)/, /Verifica a formatação/, /\bnão\b/i, /\bverificações\b/i];

/** Raw ids as the main text of a line, a button or a heading. */
const RAW_IDS: RegExp[] = [/^(strict|standard|minimal|full|diff)$/m, /\bcapability:[a-z]/, /sha256:[0-9a-f]{6,}/, /\b(Alvo|Target): (full|diff)\b/, /\bPlano sha256/, /\bPlan sha256/];
const RUN_ID_IN_BUTTON = /run_\d{8}T\d{6}Z/;

async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [document.querySelector("main")?.innerText ?? ""];
    for (const el of document.querySelectorAll<HTMLElement>("main button, main a[role=button]")) parts.push(`[button] ${(el.innerText || el.getAttribute("aria-label") || "").trim()}`);
    return parts.join("\n");
  });
}

for (const language of ["pt-BR", "en"] as const) {
  test(`the main screens read in ${language} only: no text of the other language from the fixed leak list and no raw id as a label`, async ({ page }) => {
    test.setTimeout(240_000);
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.home, "preferences.json"), JSON.stringify({ schemaVersion: 1, theme: "light", language }));
    const server = await startServer(fixture);
    try {
      await page.goto(server.bootstrapUrl);
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      const origin = new URL(page.url()).origin;
      const leaks = language === "pt-BR" ? ENGLISH_LEAKS : PORTUGUESE_LEAKS;
      const found: string[] = [];
      for (const route of SCREENS) {
        await page.goto(`${origin}/#${route}`);
        await expect(page.locator("main h1").first()).toBeVisible({ timeout: 30_000 });
        await page.waitForLoadState("networkidle").catch(() => undefined);
        const text = await visibleText(page);
        for (const re of leaks) if (re.test(text)) found.push(`${route}: ${re} in "${(re.exec(text)?.[0] ?? "").slice(0, 60)}"`);
        for (const re of RAW_IDS) if (re.test(text)) found.push(`${route}: raw id ${re}`);
        for (const line of text.split("\n")) if (line.startsWith("[button]") && RUN_ID_IN_BUTTON.test(line)) found.push(`${route}: run id in a button: ${line}`);
      }
      expect(found, found.join("\n")).toEqual([]);
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  });
}

test("the leak lists catch a planted leak", () => {
  expect(ENGLISH_LEAKS.some((re) => re.test("Format check (ruff format)"))).toBe(true);
  expect(ENGLISH_LEAKS.some((re) => re.test("the jgates-codeql volume is not prepared (no-volume)"))).toBe(true);
  expect(PORTUGUESE_LEAKS.some((re) => re.test("Perfil Essencial"))).toBe(true);
  expect(RAW_IDS.some((re) => re.test("Alvo: full"))).toBe(true);
  expect(RAW_IDS.some((re) => re.test("Plano sha256:abcdef012345"))).toBe(true);
  expect(RUN_ID_IN_BUTTON.test("Marcar run_20261112T100000Z como baseline")).toBe(true);
});
