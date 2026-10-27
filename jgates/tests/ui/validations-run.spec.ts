import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAIN, createFixture, startServer, type Fixture, type UiServer } from "./support";

// Acompanhar and Resultado: a real run followed by cursor (reload without repeated lines), a real cancellation,
// the translated Resultado with its states (reduced approval, unmeasured metric, architecture coverage), and the agent
// context that the button and `jgates report --agent-context` both give.

const RUN_ID = "run_20261026T100000Z_0a1b2c3d";

async function withServer(page: Page, body: (ctx: { fixture: Fixture; server: UiServer; base: string }) => Promise<void>, prepare?: (fixture: Fixture) => void) {
  const fixture = createFixture();
  let server: UiServer | null = null;
  try {
    prepare?.(fixture);
    server = await startServer(fixture);
    await page.goto(server.bootstrapUrl);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await body({ fixture, server, base: page.url().split("#")[0] as string });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

function jgates(fixture: Fixture, args: string[]) {
  return spawnSync(process.execPath, [MAIN, ...args], { env: fixture.env, encoding: "utf8", timeout: 240_000 });
}

/** A project template with one generic check that stays alive (writes its pid) until it is stopped. */
function addSlowCheck(fixture: Fixture, pidFile: string) {
  const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  fs.mkdirSync(path.join(fixture.dir, ".jgates", "templates"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.dir, ".jgates", "templates", "slow.yml"),
    [
      "schemaVersion: 1",
      "id: slow",
      "extends: [builtin:base]",
      "config:",
      "  tools:",
      "    slow-check:",
      "      adapter: generic-command",
      "      enabled: true",
      "      capabilities: [lint]",
      `      command: ${JSON.stringify(process.execPath)}`,
      `      args: ${JSON.stringify(["-e", script])}`,
      "      config:",
      "        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }",
      "        evidence: { kind: exit-code }",
      "",
    ].join("\n"),
  );
  fs.appendFileSync(path.join(fixture.dir, "jgates.yml"), "  - id: slow\n    source: .jgates/templates/slow.yml\n    activation: always\n");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startFromPlan(page: Page, base: string) {
  await page.goto(`${base}#/plan`);
  await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/, { timeout: 60_000 });
  await page.getByRole("button", { name: "Executar" }).click();
  await expect(page.getByTestId("run-state")).toBeVisible({ timeout: 30_000 });
}

test("cancel from the UI stops the step processes, says that no approval was issued and shows the partial report", async ({ page }) => {
  const pidFile = path.join(os.tmpdir(), `jgates-slow-${process.pid}-${Date.now()}.pid`);
  await withServer(
    page,
    async ({ base, fixture }) => {
      await startFromPlan(page, base);
      await expect.poll(() => fs.existsSync(pidFile), { timeout: 60_000 }).toBe(true);
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(alive(pid)).toBe(true);
      await expect(page.getByTestId("run-progress")).toContainText(/Etapa \d+ de \d+/);

      // A reload in the middle of the run resumes the events by cursor: each sequence appears once.
      await page.reload();
      await expect(page.getByTestId("run-state")).toHaveAttribute("data-state", "running");
      await expect(page.getByRole("log", { name: "Eventos" }).locator("li").first()).toBeVisible();
      const seqs = await page.getByRole("log", { name: "Eventos" }).locator("li").evaluateAll((els) => els.map((e) => e.getAttribute("data-seq")));
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(seqs.length).toBeGreaterThan(0);

      await page.getByRole("button", { name: "Interromper" }).click();
      try {
        await expect(page.getByTestId("run-state")).toHaveAttribute("data-state", "cancelled", { timeout: 60_000 });
      } catch (error) {
        const found = spawnSync("sh", ["-c", `cat ${fixture.home}/workspaces/*/server/server.log; ls -R ${fixture.home}/workspaces/*/server/plans | head -20; cat ${fixture.home}/workspaces/*/server/plans/job_*.events.jsonl | tail -8; ps -eo pid,pgid,stat,cmd | grep -E "main.js run|slow|-e require" | grep -v grep`], { encoding: "utf8" });
        throw new Error(`${(error as Error).message}\n--- debug\n${found.stdout}${found.stderr}`);
      }
      await expect(page.getByText("Nenhuma aprovação foi emitida.")).toBeVisible();
      await expect(page.getByTestId("result-banner")).toHaveAttribute("data-kind", "partial");
      await expect.poll(() => alive(pid), { timeout: 20_000 }).toBe(false);
      const after = await page.getByRole("log", { name: "Eventos" }).locator("li").evaluateAll((els) => els.map((e) => e.getAttribute("data-seq")));
      expect(new Set(after).size).toBe(after.length);
      const text = await page.locator("main, body").first().innerText();
      expect(text).not.toMatch(/\b(failed|blocked|completed)\b/);
    },
    (fixture) => addSlowCheck(fixture, pidFile),
  );
});

test("a finished run lists its steps translated and the agent context of the button is the one of the CLI", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await withServer(page, async ({ fixture, base }) => {
    await startFromPlan(page, base);
    await expect(page.getByTestId("run-state")).toHaveAttribute("data-state", "finished", { timeout: 120_000 });
    await expect(page.getByRole("heading", { name: "Resultado", level: 2 })).toBeVisible();
    const runId = (await page.locator("dd code").filter({ hasText: /^run_/ }).first().textContent()) ?? "";
    expect(runId).toMatch(/^run_/);

    // The steps and decisions come translated: no raw contract words in the visible text.
    const visible = await page.locator("main, body").first().innerText();
    expect(visible).not.toMatch(/\b(failed|blocked|completed|incomplete|not_applicable)\b/);

    await page.getByRole("button", { name: "Copiar para o agente" }).click();
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain("Instrução (política congelada)");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const cli = jgates(fixture, ["report", runId, "--agent-context", "--json", "--cwd", fixture.dir]);
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout).agentContext.text).toBe(copied);
    expect(copied).toContain("Não altere os critérios de aprovação");
    expect(copied).not.toContain("os.path");
  });
});

/** A stored run, written the way the runner writes result.json, to see states that are hard to provoke on purpose. */
function writeStoredRun(fixture: Fixture, workspaceId: string, doc: Record<string, unknown>) {
  const dir = path.join(fixture.home, "workspaces", workspaceId, "runs", RUN_ID);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(doc));
}

function storedResult(extra: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    tool: "jgates",
    version: "0.0.0",
    startedAt: "2026-10-26T10:00:00.000Z",
    finishedAt: "2026-10-26T10:00:05.000Z",
    workspace: { id: "ws_x", path: "/tmp/x" },
    runDir: "/tmp/x/run",
    selection: { adapter: "plan", options: {}, overrides: [], profile: "minimal", scope: "workspace" },
    decision: "passed",
    complete: true,
    reduced: false,
    exitCode: 0,
    requirements: [],
    stages: [{ id: "ruff#lint", label: "Ruff", state: "completed", findings: 0 }],
    findings: [],
    unsatisfied: [],
    warnings: [],
    blockingViolations: 0,
    disabled: [],
    workspaceChanges: { checked: true, added: [], modified: [], removed: [] },
    artifacts: { result: "result.json", logs: [], outputs: [] },
    ...extra,
  };
}

async function workspaceIdOf(fixture: Fixture): Promise<string> {
  const mod = await import(pathToFileURL(path.join(path.dirname(MAIN), "..", "core", "ids", "index.js")).href);
  return mod.workspaceId(fixture.dir);
}

test("a reduced approval has its own badge, the list of what was turned off, and an unmeasured metric is not 0%", async ({ page }) => {
  await withServer(page, async ({ fixture, base }) => {
    writeStoredRun(
      fixture,
      await workspaceIdOf(fixture),
      storedResult({
        reduced: true,
        disabled: [
          { id: "pytest#unit", origin: "run", reason: "desligado pelo usuário" },
          { id: "semgrep#security", origin: "template" },
        ],
        stages: [
          { id: "ruff#lint", label: "Ruff", state: "completed", findings: 0, cache: { status: "reused", runId: "run_20261025T100000Z_aaaaaaaa", at: "2026-10-25T10:00:00.000Z" } },
          { id: "pytest#unit", state: "disabled" },
          { id: "dep#architecture", label: "Arquitetura", state: "blocked", execution: { step: "dep", notRun: { cause: "dependency", detail: "x" } } },
        ],
        metrics: [
          { id: "coverage.lines", label: "Cobertura de linhas", unit: "percent", measured: false, reason: "sem relatório de cobertura", scope: "workspace", origin: "pytest" },
          { id: "tests.passed", label: "Testes aprovados", unit: "count", value: 12, scope: "workspace", origin: "pytest" },
        ],
        architecture: [{ tool: "dependency-cruiser", status: "partial", verified: false, nodes: 4, edges: 3, unresolved: 1, unresolvedSample: [{ from: "web/src/alias.ts", specifier: "@app/missing" }] }],
      }),
    );
    await page.goto(`${base}#/validations/result/${RUN_ID}`);
    const banner = page.getByTestId("result-banner");
    await expect(banner).toHaveAttribute("data-kind", "passed-reduced");
    await expect(page.getByTestId("result-banner-title")).toHaveText("Aprovado com 1 verificação desligada nesta execução");
    await expect(page.getByTestId("reduced-list")).toContainText("pytest#unit");
    await expect(page.getByTestId("metric-coverage.lines")).toHaveText(/não medida/);
    await expect(page.getByTestId("metric-coverage.lines")).not.toHaveText(/0\s?%/);
    await expect(page.getByTestId("metric-tests.passed")).toHaveText(/^12/);
    const arch = page.getByTestId("architecture-coverage");
    await expect(arch).toHaveAttribute("data-status", "partial");
    await expect(arch).toContainText("@app/missing");
    await expect(arch).toContainText("Parcial");
    await expect(page.getByTestId("reused")).toContainText("Resultado reutilizado");
    await expect(page.getByTestId("policy-change")).toBeVisible();
    const text = await page.locator("main, body").first().innerText();
    expect(text).not.toMatch(/\b(failed|blocked|completed|disabled)\b/);
    expect(text).toContain("Bloqueada");

    // A full approval has another badge.
    writeStoredRun(fixture, await workspaceIdOf(fixture), storedResult({}));
    await page.reload();
    await expect(banner).toHaveAttribute("data-kind", "passed");
    await expect(page.getByTestId("result-banner-title")).toHaveText("Aprovado");

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});
