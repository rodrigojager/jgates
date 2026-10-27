import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAIN, createFixture, startServer, type Fixture, type UiServer } from "./support";

// History with comparison (resolved findings, the warning when the policy differs), baseline and preserved marks
// seen by `jgates gc --dry-run`, Storage (a workspace whose path is gone, relink, delete only after the confirmation and
// only inside the data folder), Preferences, Help and About.

const FIXED_MODULE = "def check(value):\n    return value is None\n";

function cli(fixture: Fixture, ...args: string[]): { code: number | null; doc: any; out: string; err: string } {
  const r = spawnSync(process.execPath, [MAIN, ...args], { env: fixture.env, encoding: "utf8", timeout: 120_000 });
  let doc: any = null;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    doc = null;
  }
  return { code: r.status, doc, out: r.stdout, err: r.stderr };
}

// Only the Ruff instance: it is the one tool of the fixture that runs without a container or the network.
const run = (fixture: Fixture) => cli(fixture, "run", "--cwd", fixture.dir, "--only", "tool:ruff", "--no-interactive", "--json");

async function withServer(fixture: Fixture, body: (server: UiServer) => Promise<void>): Promise<void> {
  const server = await startServer(fixture);
  try {
    await body(server);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
}

/** Runs the fixture before and after the correction: the first run fails with two findings, the second passes. */
function beforeAndAfter(fixture: Fixture): { before: string; after: string } {
  const first = run(fixture);
  expect(first.doc?.findings?.length, first.out + first.err).toBe(2);
  fs.writeFileSync(path.join(fixture.dir, "demo", "mod.py"), FIXED_MODULE);
  const second = run(fixture);
  expect(second.doc?.decision, second.out + second.err).toBe("passed");
  return { before: first.doc.runId, after: second.doc.runId };
}

function workspaceId(fixture: Fixture): string {
  return cli(fixture, "history", "--cwd", fixture.dir, "--json").doc.workspace.id;
}

function gcRuns(fixture: Fixture): string[] {
  return cli(fixture, "gc", "--dry-run", "--max-age-days", "0", "--json").doc.runs.map((r: { runId: string }) => r.runId);
}

/** Enters through the bootstrap link (the server answers with a refresh to the application), then goes to a screen. */
async function open(page: Page, server: UiServer, hash: string): Promise<void> {
  await page.goto(server.bootstrapUrl);
  await expect(page.getByRole("navigation", { name: "Navegação principal" })).toBeVisible();
  await page.evaluate((h) => (window.location.hash = h), hash);
}

const row = (page: Page, runId: string) => page.locator(`tr[data-run="${runId}"]`);

async function expectNoAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

test("comparing the run before and after the correction lists the resolved findings; a different policy shows the warning", async ({ page }) => {
  const fixture = createFixture();
  const { before, after } = beforeAndAfter(fixture);
  await withServer(fixture, async (server) => {
    await open(page, server, "#/validations");
    await expect(page.getByRole("heading", { level: 1, name: "Cada validação conta uma história." })).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await expect(row(page, before)).toContainText("Ajustes necessários");
    await expect(row(page, after)).toContainText("Aprovado");
    await expectNoAxeViolations(page);

    // Filters: only the run with pending items, then only the approved one.
    await page.getByRole("button", { name: "Com pendências" }).click();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(row(page, before)).toBeVisible();
    await page.getByRole("button", { name: "Aprovadas" }).click();
    await expect(row(page, after)).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await page.getByRole("button", { name: "Todas", exact: true }).click();
    await page.getByLabel("Severidade").selectOption({ index: 1 });
    await expect(row(page, before)).toBeVisible();
    await expect(row(page, after)).toHaveCount(0);
    await page.getByLabel("Severidade").selectOption({ index: 0 });

    const compare = page.getByRole("button", { name: "Comparar as duas escolhidas" });
    await expect(compare).toBeDisabled();
    await page.getByLabel(`Escolher a validação ${after} para comparar`).check();
    await page.getByLabel(`Escolher a validação ${before} para comparar`).check();
    await compare.click();
    const panel = page.getByTestId("history-compare");
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-compare="resolved"]')).toContainText("Resolvidos");
    await expect(panel.locator('[data-compare="resolved"] li')).toHaveCount(2);
    await expect(panel.locator('[data-compare="new"] li')).toHaveCount(0);
    await expect(panel.locator('[data-compare="kept"] li')).toHaveCount(0);
    // Both runs switched checks off for that run only (--only), so the screen says the pair is not like for like.
    const warning = page.getByTestId("history-compare-warning");
    await expect(warning.locator("li")).toHaveText(["Um dos runs desligou verificações só naquela rodada: é uma rodada parcial."]);
    await expectNoAxeViolations(page);

    // The next two steps edit the stored results to stand for full runs: first with one policy (no warning), then with two.
    const runs = path.join(fixture.home, "workspaces", workspaceId(fixture), "runs");
    const setPolicy = (policies: Record<string, string>) => {
      for (const [id, hash] of Object.entries(policies)) {
        const file = path.join(runs, id, "result.json");
        const doc = JSON.parse(fs.readFileSync(file, "utf8"));
        doc.reduced = false;
        doc.provenance = { ...(doc.provenance ?? {}), hashes: { ...(doc.provenance?.hashes ?? {}), policy: hash } };
        fs.writeFileSync(file, JSON.stringify(doc));
      }
    };
    const comparePair = async () => {
      await page.reload();
      await page.getByLabel(`Escolher a validação ${before} para comparar`).check();
      await page.getByLabel(`Escolher a validação ${after} para comparar`).check();
      await page.getByRole("button", { name: "Comparar as duas escolhidas" }).click();
    };
    setPolicy({ [before]: "policy-a", [after]: "policy-a" });
    await comparePair();
    await expect(page.getByTestId("history-compare")).toContainText("Os dois runs usaram a mesma política");
    await expect(warning).toHaveCount(0);
    await expect(page.locator('[data-compare="resolved"] li')).toHaveCount(2);

    // The policy changed between the two runs: the lists stay, with the warning.
    setPolicy({ [before]: "policy-a", [after]: "policy-b" });
    await comparePair();
    await expect(warning).toBeVisible();
    await expect(warning.locator('[data-warning="POLICY_CHANGED"]')).toHaveText("A política é diferente entre os dois runs.");
    await expect(page.locator('[data-compare="resolved"] li')).toHaveCount(2);
  });
});

test("marking a run as baseline or preserved takes it out of the list `jgates gc --dry-run` would remove", async ({ page }) => {
  const fixture = createFixture();
  const { before, after } = beforeAndAfter(fixture);
  await withServer(fixture, async (server) => {
    expect(gcRuns(fixture).sort()).toEqual([before, after].sort());
    await open(page, server, "#/validations");

    await page.getByRole("button", { name: `Marcar ${before} como baseline` }).click();
    await expect(row(page, before)).toContainText("Baseline");
    expect(gcRuns(fixture)).toEqual([after]);
    expect(cli(fixture, "baseline", "show", "--cwd", fixture.dir, "--json").doc.baseline).toBe(before);

    // Baseline is one per workspace: marking the other one moves it.
    await page.getByRole("button", { name: `Marcar ${after} como baseline` }).click();
    await expect(row(page, after)).toContainText("Baseline");
    await expect(row(page, before)).not.toContainText("Baseline");
    expect(gcRuns(fixture)).toEqual([before]);

    await page.getByRole("button", { name: `Preservar ${before} da retenção` }).click();
    await expect(row(page, before)).toContainText("Preservado");
    expect(gcRuns(fixture)).toEqual([]);
    expect(cli(fixture, "history", "--cwd", fixture.dir, "--json").doc.runs.find((r: any) => r.runId === before).preserved).toBe(true);

    await page.getByRole("button", { name: `Deixar de preservar ${before}` }).click();
    await expect(row(page, before)).not.toContainText("Preservado");
    expect(gcRuns(fixture)).toEqual([before]);
  });
});

test("storage shows a workspace whose path is gone; relink and delete work, delete only after the confirmation and only in the data folder", async ({ page }) => {
  const fixture = createFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-storage-"));
  const ghostDir = (name: string) => {
    const dir = path.join(outside, name);
    fs.mkdirSync(dir);
    const id = cli(fixture, "workspaces", "add", dir, "--json").doc.workspace.id as string;
    const runDir = path.join(fixture.home, "workspaces", id, "runs", "run_20260101T000000Z_deadbeef");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({ runId: "run_20260101T000000Z_deadbeef", decision: "passed", startedAt: "2026-01-01T00:00:00.000Z", findings: [] }));
    fs.rmSync(dir, { recursive: true });
    return { id, dir, folder: path.join(fixture.home, "workspaces", id) };
  };
  const ghost = ghostDir("moved-away");
  const relinked = ghostDir("moved-again");
  // A file of the user outside the data folder, and the folder of another workspace: neither may be touched.
  const sentinel = path.join(outside, "keep-me.txt");
  fs.writeFileSync(sentinel, "mine");
  const currentFolder = path.join(fixture.home, "workspaces", workspaceId(fixture));
  fs.mkdirSync(currentFolder, { recursive: true });

  await withServer(fixture, async (server) => {
    await open(page, server, "#/preferences");
    await page.getByRole("link", { name: "Abrir Armazenamento" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Armazenamento" })).toBeVisible();
    await expect(page.getByTestId("storage-home")).toHaveText(fixture.home);
    const missing = page.locator(`tr[data-workspace="${ghost.id}"]`);
    await expect(missing).toContainText("Caminho não existe mais");
    await expect(missing).toContainText("moved-away");
    await expect(page.locator(`tr[data-workspace="${workspaceId(fixture)}"]`)).toContainText("Aberto agora");
    await expectNoAxeViolations(page);

    // The server refuses a delete without the confirmation, and one aimed at a workspace that still exists.
    const status = (body: unknown) =>
      page.evaluate(async (payload) => {
        const session = await (await fetch("/api/session", { credentials: "same-origin" })).json();
        const response = await fetch("/api/storage/delete-artifacts", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", [session.csrfHeader]: session.csrfToken },
          body: JSON.stringify(payload),
        });
        return response.status;
      }, body);
    expect(await status({ id: ghost.id, dryRun: false })).toBe(400);
    expect(await status({ id: ghost.id, dryRun: false, confirm: "something-else" })).toBe(400);
    expect(await status({ id: workspaceId(fixture), dryRun: false, confirm: workspaceId(fixture) })).toBe(409);
    expect(fs.existsSync(ghost.folder)).toBe(true);
    expect(fs.existsSync(currentFolder)).toBe(true);

    // Cancel keeps everything; the preview names what would go.
    await missing.getByRole("button", { name: /Apagar artefatos/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("delete-preview")).toContainText("1 runs");
    await expectNoAxeViolations(page);
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    expect(fs.existsSync(ghost.folder)).toBe(true);

    await missing.getByRole("button", { name: /Apagar artefatos/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Apagar definitivamente" }).click();
    await expect(page.locator(`tr[data-workspace="${ghost.id}"]`)).toHaveCount(0);
    expect(fs.existsSync(ghost.folder)).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.existsSync(currentFolder)).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, "workspaces", relinked.id))).toBe(true);

    // Relink to the project that moved: the history follows it.
    const other = page.locator(`tr[data-workspace="${relinked.id}"]`);
    await other.getByRole("button", { name: /Religar a outro caminho/ }).click();
    await page.getByRole("dialog").getByLabel("Caminho novo do projeto").fill(fixture.dir);
    await page.getByRole("dialog").getByRole("button", { name: "Religar" }).click();
    await expect(page.locator(`tr[data-workspace="${relinked.id}"]`)).toHaveCount(0);
    const history = cli(fixture, "history", "--cwd", fixture.dir, "--json").doc.runs.map((r: any) => r.runId);
    expect(history).toContain("run_20260101T000000Z_deadbeef");
  });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("preferences, help and about show real content and no mockup talk", async ({ page }) => {
  const fixture = createFixture();
  await withServer(fixture, async (server) => {
    await open(page, server, "#/preferences");
    await expect(page.getByRole("heading", { level: 1, name: "Preferências" })).toBeVisible();
    await page.getByRole("radio", { name: "Escuro" }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expectNoAxeViolations(page);
    await page.getByRole("radio", { name: "Claro" }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expectNoAxeViolations(page);
    const saved = JSON.parse(fs.readFileSync(path.join(fixture.home, "preferences.json"), "utf8"));
    expect(saved.theme).toBe("light");

    await page.evaluate(() => (window.location.hash = "#/help"));
    await expect(page.getByRole("heading", { level: 1, name: "No navegador ou no terminal." })).toBeVisible();
    for (const command of ["jgates init --cwd ./meu-projeto", "jgates ui --cwd ./meu-projeto", "jgates plan --profile strict --json", "jgates run --profile standard --json", "jgates run --no-cache --json"]) {
      await expect(page.locator("code", { hasText: command }).first()).toBeVisible();
    }
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/protótipo|demonstração|dados de exemplo|dados fictícios/i);
    await expectNoAxeViolations(page);

    await page.getByRole("link", { name: "Sobre" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Sobre o JGates" })).toBeVisible();
    await expect(page.getByTestId("about-version")).not.toHaveText("-");
    await expect(page.getByTestId("about-mode")).toContainText("Local");
    await expect(page.getByTestId("about-path")).toContainText(path.basename(fixture.dir));
    await expect(page.locator("code", { hasText: "docs/jgates/compatibilidade.pt-BR.md" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
