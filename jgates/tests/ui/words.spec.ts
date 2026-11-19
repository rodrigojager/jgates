import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  // The words of the ASVS coverage change (glossary: informational finding, suggestion, hardening, ASVS review).
  /\bInformational findings?\b/i,
  /does not block the validation/i,
  /\bNo sign of\b/,
  /\bASVS review\b/i,
  /\bHardening\b/,
];

/** Portuguese that must never show in the English UI. */
const PORTUGUESE_LEAKS: RegExp[] = [/Verificação de formato/, /Infraestrutura/, /\bEssencial\b/, /\bEquilibrado\b/, /\bRigoroso\b/, /Cobertura de testes/, /Componentes (Python|Rust|Go|TypeScript)/, /Verifica a formatação/, /\bnão\b/i, /\bverificações\b/i, /\bAchados? informativos?\b/i, /\bnenhum sinal\b/i, /\bRevisão ASVS\b/i, /\bEndurecimento\b/i, /\bSugest(ão|ões)\b/i];

/** Words the ASVS map and its documents never use: a claim of conformance, a certification, a percentage of compliance. */
const FORBIDDEN_CLAIMS_EN = /\b(compliant|conformant|certified|compliance percentage|percentage of compliance)\b/i;
const FORBIDDEN_CLAIMS_PT = /\b(conformidade|certificad[oa]s?|percentual de conformidade)\b/i;
const A_PERCENTAGE = /\d\s?%/;

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

test("the ASVS documents and the coverage messages never claim conformance, certification or a percentage", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const jgates = path.join(repo, "jgates");
  const sources: Array<{ file: string; claims: RegExp }> = [
    { file: path.join(repo, "docs", "jgates", "asvs-coverage.en.md"), claims: FORBIDDEN_CLAIMS_EN },
    { file: path.join(repo, "docs", "jgates", "asvs-coverage.pt-BR.md"), claims: FORBIDDEN_CLAIMS_PT },
    { file: path.join(jgates, "src", "i18n", "coverage.en.json"), claims: FORBIDDEN_CLAIMS_EN },
    { file: path.join(jgates, "src", "i18n", "coverage.pt-BR.json"), claims: FORBIDDEN_CLAIMS_PT },
    { file: path.join(jgates, "ui", "src", "screens", "coverage-asvs", "messages.en.json"), claims: FORBIDDEN_CLAIMS_EN },
    { file: path.join(jgates, "ui", "src", "screens", "coverage-asvs", "messages.pt-BR.json"), claims: FORBIDDEN_CLAIMS_PT },
  ];
  const found: string[] = [];
  for (const { file, claims } of sources) {
    const text = fs.readFileSync(file, "utf8");
    // A document may say that the map never says it: only a sentence outside "never"/"nunca"/"no" lines counts.
    for (const line of text.split("\n")) {
      if (claims.test(line) && !/\b(never|nunca)\b/i.test(line)) found.push(`${path.basename(file)}: ${line.trim().slice(0, 100)}`);
      if (A_PERCENTAGE.test(line)) found.push(`${path.basename(file)}: a percentage in "${line.trim().slice(0, 100)}"`);
    }
  }
  expect(found, found.join("\n")).toEqual([]);
});

test("the forbidden claims are caught when planted", () => {
  expect(FORBIDDEN_CLAIMS_EN.test("The project is compliant")).toBe(true);
  expect(FORBIDDEN_CLAIMS_EN.test("This is a conformant build")).toBe(true);
  expect(FORBIDDEN_CLAIMS_EN.test("certified for level 2")).toBe(true);
  expect(FORBIDDEN_CLAIMS_PT.test("O projeto tem conformidade")).toBe(true);
  expect(FORBIDDEN_CLAIMS_PT.test("projeto certificado")).toBe(true);
  expect(A_PERCENTAGE.test("72% of the requirements")).toBe(true);
  expect(A_PERCENTAGE.test("level 2 has 253 requirements")).toBe(false);
});

test("the leak lists catch a planted leak", () => {
  expect(ENGLISH_LEAKS.some((re) => re.test("Informational finding (does not block the validation)"))).toBe(true);
  expect(PORTUGUESE_LEAKS.some((re) => re.test("Achado informativo"))).toBe(true);
  expect(PORTUGUESE_LEAKS.some((re) => re.test("Nenhum sinal de WebSocket neste projeto"))).toBe(true);
  expect(ENGLISH_LEAKS.some((re) => re.test("Format check (ruff format)"))).toBe(true);
  expect(ENGLISH_LEAKS.some((re) => re.test("the jgates-codeql volume is not prepared (no-volume)"))).toBe(true);
  expect(PORTUGUESE_LEAKS.some((re) => re.test("Perfil Essencial"))).toBe(true);
  expect(RAW_IDS.some((re) => re.test("Alvo: full"))).toBe(true);
  expect(RAW_IDS.some((re) => re.test("Plano sha256:abcdef012345"))).toBe(true);
  expect(RUN_ID_IN_BUTTON.test("Marcar run_20261112T100000Z como baseline")).toBe(true);
});
