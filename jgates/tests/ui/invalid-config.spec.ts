import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { PYPROJECT, createFixture, sha256, startServer, type Fixture, type UiServer } from "./support";

// A broken Ruff section shows its error with the line, the typed text survives a reload as a draft in the
// data folder, saving the invalid file on purpose blocks the next plan, and a draft of a document the plan uses is
// either saved or left out, with the run using exactly that version.

const EDITOR = ".editor-host .cm-content";

async function withServer(page: Page, body: (ctx: { fixture: Fixture; server: UiServer }) => Promise<void>) {
  const fixture = createFixture();
  let server: UiServer | null = null;
  try {
    server = await startServer(fixture);
    await page.goto(server.bootstrapUrl);
    // The bootstrap page redirects to the application, which opens on the overview; these specs start from the Tools tab.
    await page.waitForURL((url) => !url.pathname.startsWith("/session"));
    await page.goto(page.url().split("#")[0] + "#/tools");
    await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();
    await body({ fixture, server });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

async function openRuffConfig(page: Page) {
  await page.getByRole("link", { name: "Abrir ruff" }).click();
  // The area opens on the Options tab; the file editor is the Files tab.
  await page.getByRole("tab", { name: "Arquivos" }).click();
  await page.getByRole("button", { name: /pyproject\.toml/ }).first().click();
  await expect(page.locator(EDITOR)).toBeVisible();
  await expect(page.locator(EDITOR)).toContainText("tool.ruff.lint");
}

async function type(page: Page, text: string) {
  await page.locator(EDITOR).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

function draftFiles(home: string): string[] {
  const out: string[] = [];
  const workspaces = path.join(home, "workspaces");
  for (const w of fs.readdirSync(workspaces)) {
    const dir = path.join(workspaces, w, "drafts");
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) out.push(path.join(dir, f));
  }
  return out;
}

function resultOf(home: string, planHash: string): any {
  const workspaces = path.join(home, "workspaces");
  for (const w of fs.readdirSync(workspaces)) {
    const runs = path.join(workspaces, w, "runs");
    if (!fs.existsSync(runs)) continue;
    for (const r of fs.readdirSync(runs)) {
      const file = path.join(runs, r, "result.json");
      if (!fs.existsSync(file)) continue;
      const result = JSON.parse(fs.readFileSync(file, "utf8"));
      if (result.selection?.planHash === planHash) return { result, plan: JSON.parse(fs.readFileSync(path.join(runs, r, "plan.json"), "utf8")) };
    }
  }
  throw new Error(`no run for ${planHash}`);
}

const planHashOf = async (page: Page): Promise<string> => ((await page.getByTestId("plan-hash").textContent()) ?? "").trim();

async function runCurrentPlan(page: Page): Promise<string[]> {
  await page.getByRole("button", { name: "Executar" }).click();
  await expect(page.getByTestId("run-state")).toHaveAttribute("data-state", "finished", { timeout: 120_000 });
  return (await page.getByRole("table", { name: "Achados" }).locator("tbody tr td:nth-child(2)").allTextContents()).map((s) => s.trim());
}

test("a broken Ruff section shows the line, the typed text survives a reload as a draft and the file stays untouched; saving it on purpose blocks the plan", async ({ page }) => {
  await withServer(page, async ({ fixture }) => {
    const original = fs.readFileSync(fixture.pyproject);
    await openRuffConfig(page);
    await type(page, '\nignore = ["F401"');

    // The error, with the line, appears while typing; the visual form is suspended.
    const error = page.locator(".notice.error", { hasText: "Linha" });
    await expect(error).toContainText("A sintaxe tem erro");
    await expect(error).toContainText(/Linha \d+, coluna \d+/);
    await expect(page.getByTestId("visual-suspended")).toBeVisible();
    await expect(page.getByTestId("draft-state")).toHaveAttribute("data-state", "saved");

    // The draft is in the data folder; the project file did not change.
    expect(draftFiles(fixture.home)).toHaveLength(1);
    expect(fs.readFileSync(fixture.pyproject)).toEqual(original);

    // Reload the page: the text comes back from the draft, with the same error.
    await page.reload();
    // The page reloads on the tool area (the route is in the hash), on its Options tab: open the same file again.
    await page.getByRole("tab", { name: "Arquivos" }).click();
    await page.getByRole("button", { name: /pyproject\.toml/ }).first().click();
    await expect(page.locator(EDITOR)).toContainText('ignore = ["F401"');
    await expect(page.getByTestId("draft-restored")).toBeVisible();
    await expect(page.locator(".notice.error", { hasText: "Linha" })).toContainText(/Linha \d+, coluna \d+/);
    expect(fs.readFileSync(fixture.pyproject)).toEqual(original);

    // Saving the invalid file is an explicit choice of the text editor.
    await page.getByRole("button", { name: "Revisar alterações" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Salvar", exact: true })).toBeDisabled();
    await dialog.getByLabel("Salvar mesmo com erro de sintaxe").check();
    await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByText(/Arquivo salvo\. Nova revisão/)).toBeVisible();
    expect(fs.readFileSync(fixture.pyproject, "utf8")).toContain('ignore = ["F401"');
    expect(draftFiles(fixture.home)).toHaveLength(0);

    // The next plan is blocked with the file in the reason, and Executar is disabled.
    await page.goto(page.url().split("#")[0] + "#/plan");
    await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/, { timeout: 60_000 });
    await expect(page.getByRole("alert").filter({ hasText: "pyproject.toml" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Executar" })).toBeDisabled();
  });
});

test("an unsaved edit of a document of the plan: use the saved version, or save it, and the run uses exactly that hash", async ({ page }) => {
  await withServer(page, async ({ fixture }) => {
    const original = fs.readFileSync(fixture.pyproject);
    await openRuffConfig(page);
    await type(page, '\nignore = ["F401"]');
    await expect(page.getByTestId("draft-state")).toHaveAttribute("data-state", "saved");

    // The review offers the choice; Executar waits for it.
    await page.goto(page.url().split("#")[0] + "#/plan");
    await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/, { timeout: 60_000 });
    const pending = page.getByTestId("pending-drafts");
    await expect(pending).toContainText("pyproject.toml");
    await expect(pending.getByRole("button", { name: "Salvar e usar a nova versão" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Executar" })).toBeDisabled();

    // Use the saved version: the run is the plan of the file on disk, which is still the original.
    await pending.getByRole("button", { name: "Usar a versão salva", exact: true }).click();
    await expect(page.getByRole("button", { name: "Executar" })).toBeEnabled();
    const hashSaved = await planHashOf(page);
    const rulesSaved = await runCurrentPlan(page);
    expect(rulesSaved.join(" ")).toContain("F401");
    const a = resultOf(fixture.home, hashSaved);
    expect(a.plan.inputs.configFiles.find((f: any) => f.file === "pyproject.toml").sha256).toBe(`sha256:${sha256(original)}`);
    expect(fs.readFileSync(fixture.pyproject)).toEqual(original);
    expect(draftFiles(fixture.home)).toHaveLength(1);

    // Save the draft: the plan is built again with the new hash, and the next run ignores F401.
    await page.goto(page.url().split("#")[0] + "#/plan");
    await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/, { timeout: 60_000 });
    await page.getByTestId("pending-drafts").getByRole("button", { name: "Salvar e usar a nova versão" }).click();
    await expect(page.getByTestId("pending-drafts")).toHaveCount(0);
    // The plan is built again after the save: wait for the new hash instead of reading the old one still on screen.
    await expect(page.getByTestId("plan-hash")).not.toHaveText(hashSaved, { timeout: 60_000 });
    await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/, { timeout: 60_000 });
    const hashNew = await planHashOf(page);
    expect(hashNew).not.toBe(hashSaved);
    const saved = fs.readFileSync(fixture.pyproject);
    expect(saved.toString("utf8")).toContain('ignore = ["F401"]');
    expect(saved.toString("utf8").startsWith(PYPROJECT.trimEnd())).toBe(true);
    expect(draftFiles(fixture.home)).toHaveLength(0);
    await expect(page.getByRole("button", { name: "Executar" })).toBeEnabled();
    const rulesNew = await runCurrentPlan(page);
    expect(rulesNew.join(" ")).not.toContain("F401");
    const b = resultOf(fixture.home, hashNew);
    expect(b.plan.inputs.configFiles.find((f: any) => f.file === "pyproject.toml").sha256).toBe(`sha256:${sha256(saved)}`);
  });
});
