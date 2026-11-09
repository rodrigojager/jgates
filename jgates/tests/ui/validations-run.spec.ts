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

/**
 * The text JGates itself shows on the page. The step logs are left out: they are the tools' own output, in the tools'
 * own words (a failed step opens its log by itself).
 */
function uiText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const logs = [...document.querySelectorAll<HTMLElement>(".step-log")];
    for (const l of logs) l.style.display = "none";
    const text = (document.querySelector("main") ?? document.body).innerText;
    for (const l of logs) l.style.display = "";
    return text;
  });
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
      const text = await uiText(page);
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
    const visible = await uiText(page);
    expect(visible).not.toMatch(/\b(failed|blocked|completed|incomplete|not_applicable)\b/);

    await page.getByRole("button", { name: "Copiar para o agente" }).click();
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain("Instrução (política congelada)");
    // The Windows clipboard turns line breaks into CRLF.
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n");
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
    const text = await uiText(page);
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

/** The logs of a stored run, written the way the runner writes them: the command header and footer in the error stream. */
function writeStepLogs(fixture: Fixture, workspaceId: string) {
  const dir = path.join(fixture.home, "workspaces", workspaceId, "runs", RUN_ID);
  const logs = path.join(dir, "logs");
  const header = (exe: string, args: string[]) => `executable: ${exe}\nargs: ${JSON.stringify(args)}\ncwd: /work/project\n---\n`;
  const footer = (code: number, ms: number) => `\n---\nexit code: ${code}\nsignal: (none)\nduration ms: ${ms}\n`;
  const files: Record<string, string> = {
    "ruff.stdout.log": "All checks passed!\n",
    "ruff.stderr.log": `${header("/tools/ruff", ["check", "--output-format", "json", "."])}${footer(0, 191)}`,
    "import-linter.stdout.log": "Contracts: 1 kept, 0 broken.\n",
    "import-linter.stderr.log": `${header("/tools/lint-imports", ["--no-cache"])}${footer(0, 289)}`,
    "import-linter.graph.stderr.log": `${header("/tools/python", ["-I", "-c", "print(1)"])}${footer(0, 215)}`,
    "pytest.stdout.log": "1 failed, 3 passed\n",
    "pytest.stderr.log": `${header("/usr/bin/python", ["-m", "pytest"])}DeprecationWarning: something old\n${footer(1, 1695)}`,
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(logs, name), text);
  const steps: Array<[string, string, string]> = [
    ["ruff", "Ruff", "succeeded"],
    ["import-linter", "Import Linter", "succeeded"],
    ["pytest", "pytest", "failed"],
  ];
  let sequence = 0;
  const event = (type: string, data: Record<string, unknown>) =>
    JSON.stringify({ schemaVersion: 1, runId: RUN_ID, sequence: ++sequence, type, at: "2026-10-26T10:00:01.000Z", data });
  const lines = [event("run-started", {})];
  for (const [step, label, status] of steps) lines.push(event("step-started", { step, label }), event("step-finished", { step, status, durationMs: 200 }));
  fs.writeFileSync(path.join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
}

test("step logs: one block per tool with both streams, the command collapsed, '(sem saída)' and the failed step opened", async ({ page }) => {
  await withServer(page, async ({ fixture, base }) => {
    const ws = await workspaceIdOf(fixture);
    writeStoredRun(fixture, ws, storedResult({}));
    writeStepLogs(fixture, ws);
    await page.goto(`${base}#/runs/${RUN_ID}`);
    await expect(page.locator('tr[data-step="ruff"]')).toBeVisible({ timeout: 30_000 });

    // The failed step shows its log by itself, highlighted; the others wait for a click.
    const pytestLog = page.getByRole("region", { name: "Log de pytest" });
    await expect(pytestLog).toBeVisible();
    await expect(pytestLog.getByTestId("log-block").first()).toHaveAttribute("data-failed", "true");
    await expect(pytestLog).toContainText("Esta etapa falhou");
    await expect(pytestLog.locator('[data-stream="stderr"] pre')).toHaveText("DeprecationWarning: something old\n");
    await expect(page.getByRole("region", { name: "Log de Ruff" })).toHaveCount(0);

    // Ruff: one block named after the tool; its error stream had only the JGates header, so it reads "(sem saída)".
    const show = page.getByRole("button", { name: "Ver log de Ruff" });
    await expect(show).toHaveAttribute("aria-expanded", "false");
    await show.focus();
    await page.keyboard.press("Enter");
    const ruffLog = page.getByRole("region", { name: "Log de Ruff" });
    await expect(page.getByRole("button", { name: "Ocultar log de Ruff" })).toHaveAttribute("aria-expanded", "true");
    const blocks = ruffLog.getByTestId("log-block");
    await expect(blocks).toHaveCount(1);
    const ruff = blocks.first();
    await expect(ruff).toHaveAttribute("data-invocation", "ruff");
    await expect(ruff.locator("summary").first()).toHaveText(/Ruff\s*ruff/);
    await expect(ruff.locator('[data-stream="stdout"] pre')).toHaveText("All checks passed!\n");
    await expect(ruff.locator('[data-stream="stderr"]').getByTestId("log-none")).toHaveText("(sem saída)");
    await expect(ruffLog.getByTestId("log-note")).toHaveText(/Muitas ferramentas escrevem progresso e avisos na saída de erro.*não o texto do log\./);

    // The header is never shown as error output: only inside the collapsed "Comando executado".
    const command = ruff.getByTestId("log-command");
    await expect(command.locator("summary")).toHaveText("Comando executado");
    await expect(command).not.toHaveAttribute("open", "");
    expect(await ruffLog.innerText()).not.toContain("executable:");
    expect(await ruffLog.innerText()).not.toContain("/tools/ruff");
    await command.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(command).toHaveAttribute("open", "");
    await expect(command).toContainText("Programa");
    await expect(command).toContainText("/tools/ruff");
    await expect(command).toContainText("check --output-format json .");
    await expect(command).toContainText("Código de saída");
    await expect(command).toContainText("191 ms");

    // Two files of one invocation share a block; a sub-invocation (import-linter.graph) has its own, after it.
    await page.getByRole("button", { name: "Ver log de Import Linter" }).click();
    const lint = page.getByRole("region", { name: "Log de Import Linter" }).getByTestId("log-block");
    await expect(lint).toHaveCount(2);
    await expect(lint.nth(0)).toHaveAttribute("data-invocation", "import-linter");
    await expect(lint.nth(0).locator(".log-stream")).toHaveCount(2);
    await expect(lint.nth(0).locator('[data-stream="stdout"] pre')).toHaveText("Contracts: 1 kept, 0 broken.\n");
    await expect(lint.nth(1)).toHaveAttribute("data-invocation", "import-linter.graph");
    await expect(lint.nth(1).locator("summary").first()).toContainText("Import Linter · grafo de imports");
    await expect(lint.nth(1)).not.toHaveAttribute("open", "");
    await lint.nth(1).locator("summary").first().click();
    await expect(lint.nth(1).locator('[data-stream="stderr"]').getByTestId("log-none")).toHaveText("(sem saída)");

    // Closing by keyboard hides the log again.
    await page.getByRole("button", { name: "Ocultar log de Ruff" }).focus();
    await page.keyboard.press("Space");
    await expect(ruffLog).toHaveCount(0);

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

    // At 375 px the logs stay inside the screen (long arguments wrap instead of pushing the table).
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(pytestLog).toBeVisible();
    const right = (selector: string) => page.locator(selector).first().evaluate((e) => e.getBoundingClientRect().right);
    const card = await right(".vrun-steps-card");
    expect(await right(".vrun-steps-card table")).toBeLessThanOrEqual(card + 0.5);
    expect(await right('tr[data-step="ruff"] button')).toBeLessThanOrEqual(card);
    expect(await right('[aria-label="Log de pytest"] [data-testid="log-block"]')).toBeLessThanOrEqual(card);
    expect(card).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    // In English: the same labels.
    const prefs = path.join(fixture.home, "preferences.json");
    const stored = fs.existsSync(prefs) ? JSON.parse(fs.readFileSync(prefs, "utf8")) : { schemaVersion: 1, theme: "system" };
    fs.writeFileSync(prefs, `${JSON.stringify({ ...stored, language: "en" }, null, 2)}\n`, { mode: 0o600 });
    await page.reload();
    const enLog = page.getByRole("region", { name: "Log of pytest" });
    await expect(enLog.getByTestId("log-note")).toHaveText(/error output; that is normal\. Whether the step failed is told by its state/);
    await page.getByRole("button", { name: "Show log of Ruff" }).click();
    const enRuff = page.getByRole("region", { name: "Log of Ruff" });
    await expect(enRuff.locator('[data-stream="stderr"]').getByTestId("log-none")).toHaveText("(no output)");
    await expect(enRuff.getByTestId("log-command").locator("summary")).toHaveText("Command executed");
  });
});
