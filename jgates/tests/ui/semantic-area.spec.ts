import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createGateFixture, openApp, startGateServer, type GateFixture, type UiServer } from "./support";

// The Semantic (AI) area in the browser, without Quality: configuration and prerequisites, the setup with full / selected /
// incremental scope and the impact preview, a Semantic-only run with its result and history, cancellation that keeps partial
// evidence, the reduced motion of the AI mascots, keyboard use, light/dark, a narrow viewport and axe. The model is the
// scripted mock or a local command that never answers (no tokens). A Semantic run never creates or joins a Quality run.

async function withGates(page: Page, body: (ctx: { fixture: GateFixture; server: UiServer; base: string }) => Promise<void>, prepare?: (fixture: GateFixture) => void) {
  const fixture = createGateFixture();
  let server: UiServer | null = null;
  try {
    prepare?.(fixture);
    server = await startGateServer(fixture);
    const base = await openApp(page, server);
    await body({ fixture, server, base });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function serious(page: Page, label: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

/** Setup step 1 -> 2 -> preview with the scope already chosen on the page. */
async function toPreview(page: Page) {
  await page.getByRole("button", { name: "Avançar" }).click();
  await page.getByTestId("semsetup-show-preview").click();
  await expect(page.getByTestId("semsetup-preview")).toBeVisible({ timeout: 60_000 });
}

test("configuration shows the saved settings and the prerequisites, and a workspace without a provider says what is missing", async ({ page }) => {
  await withGates(page, async ({ base }) => {
    await page.goto(`${base}#/semantic/config`);
    await expect(page.getByRole("heading", { name: "Configure a revisão semântica.", level: 1 })).toBeVisible();
    const saved = page.getByTestId("semcfg-saved");
    await expect(saved).toContainText("Configurado");
    await expect(saved).toContainText("mock");
    await expect(page.locator("[data-prerequisite]").first()).toBeVisible();
    // The run-only choices are apart from the saved settings, and the methods are selectable.
    await expect(page.getByTestId("semcfg-run-only")).toBeVisible();
    await expect(page.getByTestId("semcfg-methods").locator("[data-method]").first()).toBeVisible();
    await expect(page.getByTestId("semcfg-modules")).not.toHaveText("-");
  });
  await withGates(
    page,
    async ({ base }) => {
      await page.goto(`${base}#/semantic/config`);
      await expect(page.getByTestId("semcfg-saved")).toContainText("Desligado");
      // At least one required prerequisite is not ready, and it says so in text (not by color alone).
      const missing = page.locator('[data-prerequisite][data-ok="false"]');
      await expect(missing.first()).toBeVisible();
      await expect(missing.first()).toContainText(/Faltando|Opcional/);
    },
    (fixture) => fixture.write("jgates.yml", "schemaVersion: 1\nselection:\n  profile: seq\ntemplates:\n  - id: seq\n    source: .jgates/templates/seq.yml\n    activation: always\n"),
  );
});

test("scope modes: full, selected and incremental each give their own impact preview and start nothing", async ({ page }) => {
  await withGates(page, async ({ base, fixture }) => {
    // An incremental change: b.js changes in a second commit.
    fixture.write("src/other/b.js", "exports.b = () => 3;\n");
    fixture.git("add", "-A");
    fixture.git("commit", "-q", "-m", "change b");
    await page.goto(`${base}#/semantic/setup`);
    await expect(page.getByRole("heading", { name: "Prepare uma revisão semântica.", level: 1 })).toBeVisible();

    // Full: the whole repository, recommended.
    const modes = page.getByRole("radiogroup");
    await modes.getByRole("radio", { name: /Projeto inteiro/ }).check();
    await toPreview(page);
    const total = Number(await page.getByTestId("semsetup-subjects").getAttribute("data-count"));
    expect(total).toBeGreaterThanOrEqual(6);
    await expect(page.getByTestId("semsetup-estimates")).toContainText("arquivos no repositório");
    await expect(page.getByTestId("semsetup-reserve")).toContainText("guardadas para validação");
    await expect(page.getByTestId("semsetup-start")).toBeEnabled();

    // Selected: only what is named.
    await page.getByRole("button", { name: "Escopo", exact: true }).click();
    await modes.getByRole("radio", { name: /Escopo selecionado/ }).check();
    // Without a path the preview is refused with a reason.
    await expect(page.getByRole("status").filter({ hasText: "Indique ao menos um caminho" })).toBeVisible();
    await page.getByRole("textbox", { name: /Caminhos, pastas ou globs/ }).fill("src/core");
    await toPreview(page);
    await expect(page.getByTestId("semsetup-subjects")).toHaveAttribute("data-count", "1");
    await expect(page.getByTestId("semsetup-subjects")).toContainText("src/core/a.js");
    await expect(page.getByTestId("semsetup-subjects")).not.toContainText("src/other/b.js");

    // Incremental: the changed file between a base and the target, never the whole repository.
    await page.getByRole("button", { name: "Escopo", exact: true }).click();
    await modes.getByRole("radio", { name: /Incremental/ }).check();
    await expect(page.getByRole("status").filter({ hasText: "precisa de uma referência base" })).toBeVisible();
    await page.getByPlaceholder("main", { exact: true }).fill("HEAD~1");
    await toPreview(page);
    await expect(page.getByTestId("semsetup-subjects")).toContainText("src/other/b.js");
    expect(Number(await page.getByTestId("semsetup-subjects").getAttribute("data-count"))).toBeLessThan(total);
    await expect(page.getByTestId("semsetup-context")).toBeVisible();
    await expect(page.getByTestId("semsetup-reuse")).toBeVisible();
    await expect(page.getByTestId("semsetup-gaps")).toBeVisible();

    // The previews started no run and no Quality run exists.
    expect(fixture.runFolders("semantic-runs")).toEqual([]);
    expect(fixture.runFolders("runs")).toEqual([]);
    expect(fixture.providerCalls()).toBe(0);
  });
});

test("Semantic only: a full run with no Quality history is followed, finishes, and lands in the Semantic history only", async ({ page }) => {
  test.setTimeout(300_000);
  await withGates(page, async ({ base, fixture }) => {
    await page.goto(`${base}#/semantic`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("tr[data-run]")).toHaveCount(0);

    // By keyboard: the history's call to action opens the setup.
    await page.getByTestId("semhist-new-run").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Prepare uma revisão semântica.", level: 1 })).toBeVisible();
    await page.getByRole("radio", { name: /Projeto inteiro/ }).check();
    await toPreview(page);
    await page.getByTestId("semsetup-start").click();

    await page.waitForURL(/#\/semantic\/runs\/sem_/);
    const runId = decodeURIComponent(page.url().split("/runs/")[1] as string);
    expect(runId).toMatch(/^sem_/);
    await expect(page.getByTestId("semantic-mascots")).toBeVisible();
    await expect(page.getByTestId("semantic-run-state")).toHaveAttribute("data-state", "finished", { timeout: 180_000 });
    await expect(page.getByTestId("semantic-results")).toHaveAttribute("data-decision", "passed");

    // The Quality gate did not run: no Quality run folder, no Quality history entry; the model was called.
    expect(fixture.runFolders("runs")).toEqual([]);
    expect(fixture.runFolders("semantic-runs")).toEqual([runId]);
    expect(fixture.providerCalls()).toBeGreaterThan(0);
    await page.goto(`${base}#/validations`);
    await expect(page.locator("tr[data-run]")).toHaveCount(0);
    const qualityHistory = await page.evaluate(async () => (await fetch("/api/history")).text());
    expect(qualityHistory).not.toContain("sem_");

    await page.goto(`${base}#/semantic`);
    await expect(page.locator("tr[data-run]")).toHaveCount(1);
    await expect(page.locator(`tr[data-run="${runId}"]`)).toHaveAttribute("data-lifecycle", "settled");
    await page.goto(`${base}#/semantic/results/${runId}`);
    await expect(page.getByTestId("semantic-results")).toBeVisible();
    for (const id of ["semres-scope-completion", "semres-repository-coverage", "semres-usage"]) await expect(page.getByTestId(id)).toBeVisible();

    // Accessibility in light and dark, and a narrow viewport without horizontal scrolling, on every Semantic screen.
    const routes = ["#/semantic", "#/semantic/config", "#/semantic/setup", `#/semantic/runs/${runId}`, `#/semantic/results/${runId}`];
    const problems: string[] = [];
    for (const route of routes) {
      await page.goto(`${base}${route}`);
      await page.reload();
      await expect(page.locator("main h1").first()).toBeVisible();
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
        problems.push(...(await serious(page, `${route} ${scheme}`)));
      }
    }
    expect(problems).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    for (const route of routes) {
      await page.goto(`${base}${route}`);
      await page.reload();
      await expect(page.locator("main h1").first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${route} overflows the narrow viewport`).toBeLessThanOrEqual(1);
    }
  });
});

test("methods are the only choice: General review is checked by default, none selected is an error, only Security audit shows its own label", async ({ page }) => {
  test.setTimeout(300_000);
  await withGates(
    page,
    async ({ base }) => {
      // The setup has no purpose control; the methods are checkboxes with the general review checked.
      await page.goto(`${base}#/semantic/setup`);
      await page.getByRole("button", { name: "Avançar" }).click();
      const methods = page.getByTestId("semcfg-methods");
      await expect(methods).toBeVisible();
      await expect(page.getByText("Propósito", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Módulos para este propósito")).toHaveCount(0);
      await expect(methods.locator('[data-method="general-review"] input')).toBeChecked();
      await expect(methods.locator('[data-method="security-audit"] input')).not.toBeChecked();

      // None selected: an inline error and no way forward.
      await methods.locator('[data-method="general-review"] input').uncheck();
      await expect(page.getByTestId("semcfg-methods-error")).toContainText("Escolha ao menos um método");
      await expect(page.getByTestId("semsetup-show-preview")).toBeDisabled();
      const problems = await serious(page, "setup, no method");

      // The configuration screen says the same and refuses to keep an empty selection.
      await page.goto(`${base}#/semantic/config`);
      await expect(page.getByTestId("semcfg-methods")).toBeVisible();
      await expect(page.getByText("Propósito", { exact: true })).toHaveCount(0);
      await page.getByTestId("semcfg-methods").locator('[data-method="general-review"] input').uncheck();
      await expect(page.getByTestId("semcfg-methods-error")).toBeVisible();
      await expect(page.getByRole("button", { name: /Guardar|Manter/ }).first()).toBeDisabled();
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
        problems.push(...(await serious(page, `config, no method, ${scheme}`)));
      }
      expect(problems).toEqual([]);

      // Only the Security audit: that is the one method of the run, and results and history say so.
      await page.goto(`${base}#/semantic/setup`);
      await page.getByRole("button", { name: "Avançar" }).click();
      await page.getByTestId("semcfg-methods").locator('[data-method="security-audit"] input').check();
      await page.getByTestId("semcfg-methods").locator('[data-method="general-review"] input').uncheck();
      await page.getByTestId("semsetup-show-preview").click();
      await expect(page.getByTestId("semsetup-methods").locator("[data-method]")).toHaveCount(1);
      await expect(page.getByTestId("semsetup-methods").locator('[data-method="security-audit"]')).toBeVisible();
      await page.getByTestId("semsetup-start").click();
      await page.waitForURL(/#\/semantic\/runs\/sem_/);
      const runId = decodeURIComponent(page.url().split("/runs/")[1] as string);
      await expect(page.getByTestId("semantic-run-state")).not.toHaveAttribute("data-state", "running", { timeout: 180_000 });
      await page.goto(`${base}#/semantic/results/${runId}`);
      await expect(page.getByTestId("semres-methods")).toHaveText("Auditoria de segurança");
      await expect(page.getByTestId("semantic-results")).not.toContainText("Revisão geral");
      await page.goto(`${base}#/semantic`);
      await expect(page.locator(`tr[data-run="${runId}"] [data-testid="semhist-methods"]`)).toHaveText("Auditoria de segurança");
    },
  );
});

test("cancelling a running Semantic review stops it, keeps partial evidence, and the AI mascots do not animate under reduced motion", async ({ page }) => {
  await withGates(
    page,
    async ({ base, fixture }) => {
      await page.goto(`${base}#/semantic/setup`);
      await page.getByRole("radio", { name: /Projeto inteiro/ }).check();
      await toPreview(page);
      await page.getByTestId("semsetup-start").click();
      await page.waitForURL(/#\/semantic\/runs\/sem_/);
      const runId = decodeURIComponent(page.url().split("/runs/")[1] as string);
      await expect.poll(() => fixture.reviewerStarted(), { timeout: 90_000 }).toBe(true);
      await expect(page.getByTestId("semantic-run-state")).toHaveAttribute("data-state", "running");
      await expect(page.getByTestId("semantic-run-progress")).toBeVisible({ timeout: 30_000 });
      const mascots = page.getByTestId("semantic-mascots");
      await expect(mascots).toHaveAttribute("data-running", "true");
      await expect(mascots.locator('li[data-state="working"]').first()).toBeVisible({ timeout: 30_000 });
      await expect(mascots.locator("li[data-mascot]")).toHaveCount(4);

      // Motion on: a working AI mascot animates (so the check below can fail).
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const animated = () =>
        page.evaluate(() => {
          const out: string[] = [];
          for (const el of document.querySelectorAll('[data-testid="semantic-mascots"] .sem-mascot[data-state="working"] .m-anim')) {
            const name = getComputedStyle(el).animationName;
            if (name && name !== "none") out.push(name);
          }
          return out;
        });
      await expect.poll(animated).not.toEqual([]);
      // Reduced motion: no AI mascot animates at all, in any state.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect.poll(animated).toEqual([]);
      const anyAnimation = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll('[data-testid="semantic-mascots"] svg *')) {
          const style = getComputedStyle(el);
          if (style.animationName !== "none" || style.transitionDuration.split(",").some((d) => parseFloat(d) > 0)) out.push(`${el.tagName}.${el.getAttribute("class")}`);
        }
        return out;
      });
      expect(anyAnimation).toEqual([]);
      await page.emulateMedia({ reducedMotion: "no-preference" });

      // Cancel: only this run stops, the partial evidence stays, the decision is cancelled.
      await page.getByRole("button", { name: "Cancelar a revisão" }).click();
      await expect(page.getByTestId("semantic-run-state")).toHaveAttribute("data-state", "cancelled", { timeout: 90_000 });
      await expect(mascots.locator('li[data-state="working"]')).toHaveCount(0);
      await expect(page.getByTestId("semantic-results")).toHaveAttribute("data-decision", "cancelled");
      const runDir = path.join(fixture.home, "workspaces", fs.readdirSync(path.join(fixture.home, "workspaces"))[0] as string, "semantic-runs", runId);
      expect(fs.existsSync(path.join(runDir, "result.json"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8")).decision).toBe("cancelled");

      // Its own history entry; the Quality side has nothing.
      await page.goto(`${base}#/semantic`);
      await expect(page.locator(`tr[data-run="${runId}"]`)).toBeVisible();
      expect(fixture.runFolders("runs")).toEqual([]);
      await page.goto(`${base}#/validations`);
      await expect(page.locator("tr[data-run]")).toHaveCount(0);
    },
    (fixture) => fixture.useHangingReviewer(),
  );
});

// ---- The provider step ----------------------------------------------------------------------------------------------------
// GET /api/providers/cli-status and POST /api/providers/:name/login are stubbed in the browser: no real CLI runs and no
// terminal opens. Saving goes to the real server and writes the fixture's jgates.yml.

const NO_PROVIDER = "schemaVersion: 1\nselection:\n  profile: seq\ntemplates:\n  - id: seq\n    source: .jgates/templates/seq.yml\n    activation: always\n";
const OPENCODE_MODELS = Array.from({ length: 120 }, (_, i) => `provider-${i % 4}/model-${String(i).padStart(3, "0")}`);

interface CliStub {
  claudeLoggedIn: boolean;
  logins: string[];
  statusCalls: string[];
}

function cliEntry(id: string, name: string, command: string, installed: boolean, login: "logged-in" | "not-logged-in" | "unknown", models: { source: string; list: string[]; configured: string | null; suggestedDefault: string | null } | null, withModels: boolean) {
  return {
    id,
    name,
    command,
    installed,
    path: installed ? `C:/stub/${command}.cmd` : null,
    version: installed ? "1.0.0" : null,
    login: { state: installed ? login : "unknown", reason: installed ? "STATUS_COMMAND" : "NOT_INSTALLED", method: login === "logged-in" ? "stub" : null, checkedWith: `${command} status` },
    models: withModels && models ? { truncated: false, configuredIn: models.configured ? "~/.stub" : null, problem: null, ...models } : null,
    loginCommand: { command, args: ["login"], display: `${command} login` },
    install: `npm install -g ${command}-stub`,
  };
}

async function stubCli(page: Page): Promise<CliStub> {
  const stub: CliStub = { claudeLoggedIn: false, logins: [], statusCalls: [] };
  await page.route("**/api/providers/cli-status**", async (route) => {
    const url = new URL(route.request().url());
    stub.statusCalls.push(url.search);
    const withModels = url.searchParams.get("models") !== "0";
    const only = url.searchParams.get("only");
    const all = [
      cliEntry("claude-code", "Claude Code", "claude", true, stub.claudeLoggedIn ? "logged-in" : "not-logged-in", { source: "suggested", list: ["sonnet", "opus", "haiku"], configured: null, suggestedDefault: "sonnet" }, withModels),
      cliEntry("codex-cli", "Codex CLI", "codex", true, "logged-in", { source: "cli", list: ["gpt-5.5", "gpt-5.5-mini", "gpt-5.4"], configured: "gpt-5.5-mini", suggestedDefault: "gpt-5.5-mini" }, withModels),
      cliEntry("opencode", "OpenCode", "opencode", true, "logged-in", { source: "cli", list: OPENCODE_MODELS, configured: null, suggestedDefault: null }, withModels),
      cliEntry("gemini-cli", "Gemini CLI", "gemini", false, "unknown", null, withModels),
    ];
    const providers = only ? all.filter((p) => p.id === only) : all;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, status: "OK", checkedAt: new Date().toISOString(), timeoutMs: 8000, providers }) });
  });
  await page.route("**/api/providers/*/login", async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3] as string);
    stub.logins.push(name);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, status: "OK", opened: true, method: "terminal", command: { display: "claude auth login" }, reason: null }) });
  });
  return stub;
}

const card = (page: Page, id: string) => page.locator(`[data-testid="semprov-step"] .semprov-card[data-provider="${id}"]`);

test("without a provider the setup opens on 'Quem vai fazer a revisão por IA?': CLI cards with their states, Entrar re-checks on focus, Codex CLI + a model is saved and the setup goes on", async ({ page }) => {
  await withGates(
    page,
    async ({ base, fixture }) => {
      const stub = await stubCli(page);
      await page.goto(`${base}#/semantic/setup`);
      const step = page.getByTestId("semprov-step");
      await expect(step.getByRole("heading", { name: "Quem vai fazer a revisão por IA?" })).toBeVisible();
      // The later steps wait for a provider.
      await expect(page.getByRole("button", { name: "Escopo", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Provedor", exact: true })).toHaveAttribute("aria-current", "step");

      // The four agent CLIs with what was detected.
      await expect(card(page, "claude-code")).toHaveAttribute("data-state", "login");
      await expect(card(page, "claude-code")).toContainText("Falta entrar");
      await expect(card(page, "codex-cli")).toHaveAttribute("data-state", "ready");
      await expect(card(page, "codex-cli")).toContainText("Pronto");
      await expect(card(page, "opencode")).toHaveAttribute("data-state", "ready");
      await expect(card(page, "gemini-cli")).toHaveAttribute("data-state", "missing");
      await expect(card(page, "gemini-cli")).toContainText("Não instalado");
      // Not installed: how to install, with a copy button and Verificar de novo.
      await expect(card(page, "gemini-cli").getByText("npm install -g gemini-stub")).toBeVisible();
      await expect(page.getByTestId("semprov-install-copy-gemini-cli")).toBeVisible();
      await expect(page.getByRole("button", { name: "Verificar de novo o Gemini CLI" })).toBeVisible();
      // The first ready CLI is preselected, with the model its own configuration names.
      await expect(step.getByRole("radio", { name: /Codex CLI/ })).toBeChecked();
      const model = page.getByTestId("semprov-model");
      await expect(model.getByLabel("Modelo", { exact: true })).toHaveValue("gpt-5.5-mini");
      await expect(model).toContainText("Configurado no Codex CLI: gpt-5.5-mini.");

      // Choosing a CLI that is not installed says why it cannot be saved yet.
      await step.getByRole("radio", { name: /Gemini CLI/ }).check();
      await expect(page.getByTestId("semprov-why")).toHaveText("Instale o Gemini CLI primeiro (veja como no cartão).");
      await expect(page.getByTestId("semprov-save")).toBeDisabled();

      // Entrar opens the CLI's own login (stubbed) and the card is checked again when the window gets the focus back.
      await step.getByRole("radio", { name: /Claude Code/ }).check();
      await expect(page.getByTestId("semprov-why")).toContainText("Entre no Claude Code primeiro");
      await page.getByRole("button", { name: "Entrar no Claude Code" }).click();
      await expect(page.getByTestId("semprov-login-note-claude-code")).toContainText("Abrimos um terminal com claude auth login");
      expect(stub.logins).toEqual(["claude-code"]);
      stub.claudeLoggedIn = true;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(card(page, "claude-code")).toHaveAttribute("data-state", "ready");
      expect(stub.statusCalls.some((q) => q.includes("only=claude-code") && q.includes("refresh=1"))).toBe(true);
      await expect(page.getByTestId("semprov-save")).toBeEnabled();

      // Keyboard: the cards are one radio group (arrows move the choice).
      await step.getByRole("radio", { name: /Claude Code/ }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(step.getByRole("radio", { name: /Codex CLI/ })).toBeChecked();
      await expect(step.getByRole("radio", { name: /Codex CLI/ })).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(step.getByRole("radio", { name: /OpenCode/ })).toBeChecked();
      // OpenCode lists many models: a combobox that filters as you type; Esc closes the list only.
      const combo = model.getByRole("combobox", { name: "Modelo" });
      await combo.fill("model-11");
      await expect(page.getByRole("listbox")).toBeVisible();
      await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(10);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(combo).toHaveValue("provider-3/model-111");
      await combo.fill("model-0");
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(page.getByTestId("semprov-step")).toBeVisible();
      // A name outside the list is accepted as typed.
      await combo.fill("my-own/model");
      await expect(page.getByRole("listbox")).toContainText("“my-own/model” será usado como está");
      await page.keyboard.press("Escape");

      // Back to Codex CLI with the keyboard; the model is a labelled select with "Outro…".
      await step.getByRole("radio", { name: /OpenCode/ }).focus();
      await page.keyboard.press("ArrowLeft");
      await expect(step.getByRole("radio", { name: /Codex CLI/ })).toBeChecked();
      const select = model.getByLabel("Modelo", { exact: true });
      await select.selectOption({ label: "Outro…" });
      await expect(model.getByLabel("Nome do modelo")).toBeVisible();
      await select.selectOption("gpt-5.5");
      await expect(model.getByLabel("Nome do modelo")).toHaveCount(0);

      // 375 px: nothing wider than the screen.
      await page.setViewportSize({ width: 375, height: 800 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await page.setViewportSize({ width: 1280, height: 900 });
      expect(await serious(page, "provider step")).toEqual([]);

      // Save: jgates.yml gets the provider and model, and the setup goes on with the summary and "trocar".
      await page.getByTestId("semprov-save").click();
      await expect(page.getByTestId("semprov-summary")).toContainText("Provedor: Codex CLI · modelo gpt-5.5");
      await expect(page.getByRole("button", { name: "Escopo", exact: true })).toHaveAttribute("aria-current", "step");
      const yml = fs.readFileSync(path.join(fixture.dir, "jgates.yml"), "utf8");
      expect(yml).toContain("semantic-gate:");
      expect(yml).toContain("provider: codex-cli");
      expect(yml).toContain("model: gpt-5.5");
      expect(yml).toContain("selection:\n  profile: seq");
      // The preview no longer says nobody is set to review.
      await toPreview(page);
      await expect(page.locator('[data-blocker="SEMANTIC_NOT_CONFIGURED"]')).toHaveCount(0);
      await expect(page.getByTestId("semsetup-preview")).not.toContainText("Nenhum provedor está configurado");

      // "trocar" goes back to the provider step with the saved choice; "Manter o atual" returns.
      await page.getByTestId("semprov-change").click();
      await expect(page.getByTestId("semprov-step").getByRole("radio", { name: /Codex CLI/ })).toBeChecked();
      await page.getByTestId("semprov-cancel").click();
      await expect(page.getByTestId("semprov-summary")).toBeVisible();
      expect(fixture.providerCalls()).toBe(0);
    },
    (fixture) => fixture.write("jgates.yml", NO_PROVIDER),
  );
});

test("every 'no provider' message leads to the provider step: the configuration screen and ?step=provider", async ({ page }) => {
  await withGates(
    page,
    async ({ base }) => {
      await stubCli(page);
      // Configuration: the provider is a control, not "-", and the missing prerequisite opens the same step.
      await page.goto(`${base}#/semantic/config`);
      await expect(page.getByTestId("semcfg-provider")).toContainText("Nenhum ainda");
      await expect(page.locator('[data-prerequisite="provider"]')).toContainText("Ainda não há quem faça a revisão.");
      await page.getByTestId("semcfg-prereq-provider").click();
      await expect(page.getByTestId("semprov-step")).toBeVisible();
      await expect(card(page, "codex-cli")).toHaveAttribute("data-state", "ready");
      await page.getByTestId("semprov-step").getByRole("radio", { name: /Claude Code/ }).check();
      await page.getByTestId("semprov-cancel").click();
      await expect(page.getByTestId("semprov-step")).toHaveCount(0);
      await page.getByTestId("semcfg-provider-change").click();
      await page.getByTestId("semprov-step").getByRole("radio", { name: /Codex CLI/ }).check();
      await page.getByTestId("semprov-save").click();
      await expect(page.getByTestId("semcfg-provider")).toContainText("Codex CLI · modelo gpt-5.5-mini");
      await expect(page.getByTestId("semcfg-saved")).toContainText("Configurado");

      // ?step=provider (the link of the tools card and of the Providers screen) opens the step even with a provider.
      await page.goto(`${base}#/semantic/setup?step=provider`);
      await expect(page.getByTestId("semprov-step")).toBeVisible();
      await expect(page.getByTestId("semprov-step").getByRole("radio", { name: /Codex CLI/ })).toBeChecked();
      await expect(page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "Nova revisão" })).toHaveAttribute("aria-current", "page");
    },
    (fixture) => fixture.write("jgates.yml", NO_PROVIDER),
  );
});

