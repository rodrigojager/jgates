import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAIN, createFixture, openGroups, sha256, startServer, type Fixture, type UiServer } from "./support";

// Validações, Escolher (target, profile cards, "Personalizar esta validação") and Revisar (the three groups, every
// blocker of the list with how to resolve it and Executar disabled, ties, TOOL_UNAVAILABLE per instance, the equivalent command).

const REQUEST_KEY = "jgates.validation.request";
const EDITOR = ".editor-host .cm-content";

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function findGit(): string {
  const exe = process.platform === "win32" ? "git.exe" : "git";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, exe);
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  throw new Error("git not found on the PATH");
}

/** Every file of the workspace outside .git, with its hash: the project must not change because of the panel. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = sha256(fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

const read = (fixture: Fixture, file: string): string => fs.readFileSync(path.join(fixture.dir, file), "utf8");
const write = (fixture: Fixture, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(fixture.dir, file)), { recursive: true });
  fs.writeFileSync(path.join(fixture.dir, file), text);
};
const append = (fixture: Fixture, file: string, text: string): void => fs.appendFileSync(path.join(fixture.dir, file), text);

async function withServer(page: Page, prepare: ((fixture: Fixture) => void) | null, body: (ctx: { fixture: Fixture; server: UiServer }) => Promise<void>) {
  const fixture = createFixture();
  let server: UiServer | null = null;
  try {
    prepare?.(fixture);
    server = await startServer(fixture);
    await page.goto(server.bootstrapUrl);
    await expect(page.locator("h1").first()).toBeVisible();
    await body({ fixture, server });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

/** The project asks for lint outright (the generated profile has it "when available"), so an unavailable Ruff blocks the plan. */
function requireLint(fixture: Fixture): void {
  const file = ".jgates/profiles.yml";
  const text = read(fixture, file);
  const entry = "      capability:lint:\n        enabled: true\n        when: available\n";
  expect(text).toContain(entry);
  write(fixture, file, text.replace(entry, "      capability:lint:\n        enabled: true\n"));
}

const base = (page: Page): string => page.url().split("#")[0] as string;

/** Opens Revisar with a request, as Escolher leaves it. */
async function review(page: Page, request: Record<string, unknown>) {
  await page.evaluate(([key, value]) => window.sessionStorage.setItem(key as string, value as string), [REQUEST_KEY, JSON.stringify(request)]);
  await page.goto(`${base(page)}#/validations/review`);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Revisar a validação", level: 1 })).toBeVisible();
  await expect(page.getByText("Montando o plano...")).toHaveCount(0, { timeout: 60_000 });
  // The groups of the review start closed (counted); the specs read what is inside them.
  await openGroups(page);
}

const REQ = { profile: "minimal", target: "full", path: "", head: "", base: "", skip: [] as string[] };

/** The blocker with this code is listed with a "Como resolver" text, and Executar stays disabled. */
async function expectBlocker(page: Page, code: string, text?: RegExp | string) {
  const blocker = page.locator(`[data-blocker="${code}"]`).first();
  await expect(blocker).toBeVisible();
  await expect(blocker).toContainText("Como resolver:");
  if (text) await expect(blocker).toContainText(text);
  await expect(page.getByRole("button", { name: "Executar" })).toBeDisabled();
}

function addProfile(fixture: Fixture, id: string, extra: string): void {
  append(fixture, ".jgates/profiles.yml", `  ${id}:\n    extends: builtin:minimal\n    checks:\n${extra}`);
}

// ---- Escolher ------------------------------------------------------------------------------------------------------

test("turning off 'Testes unitários' in the panel warns that the validation will be reduced and changes no project file", async ({ page }) => {
  await withServer(page, null, async ({ fixture }) => {
    const before = snapshot(fixture.dir);
    await page.goto(`${base(page)}#/validations/choose`);
    await expect(page.getByRole("heading", { name: "Escolher a validação", level: 1 })).toBeVisible();
    await page.locator('[data-profile="strict"]').click();
    await page.getByTestId("customize").locator("summary").click();
    const unit = page.getByRole("checkbox", { name: /Testes unitários/ });
    await expect(unit).toBeChecked({ timeout: 60_000 });
    await expect(page.getByTestId("reduced-warning")).toHaveCount(0);
    await unit.uncheck();
    const warning = page.getByTestId("reduced-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Esta validação sairá reduzida");
    await expect(warning).toContainText("Testes unitários");
    expect(snapshot(fixture.dir)).toEqual(before);
  });
});

test("'Salvar como perfil' creates the profile in profiles.yml and the new card shows up in Escolher", async ({ page }) => {
  await withServer(page, null, async ({ fixture }) => {
    await page.goto(`${base(page)}#/validations/choose`);
    await page.locator('[data-profile="strict"]').click();
    await page.getByTestId("customize").locator("summary").click();
    await page.getByRole("checkbox", { name: /Testes unitários/ }).uncheck();
    expect(read(fixture, ".jgates/profiles.yml")).not.toContain("sem-unitarios");
    await page.getByRole("button", { name: "Salvar como perfil" }).click();
    await page.getByLabel("Identificador do novo perfil").fill("sem-unitarios");
    await page.getByRole("button", { name: "Criar perfil" }).click();
    await expect(page.locator('[data-profile="sem-unitarios"]')).toBeVisible();
    const profiles = read(fixture, ".jgates/profiles.yml");
    expect(profiles).toContain("sem-unitarios:");
    expect(profiles).toMatch(/sem-unitarios:[\s\S]*extends: strict[\s\S]*capability:unit:[\s\S]*enabled: false/);
  });
});

// ---- Revisar: the three groups, the blockers -----------------------------------------------------------------------

test("the group 'requisitos sem cobertura' is shown even when everything that runs is green", async ({ page }) => {
  await withServer(page, null, async () => {
    await review(page, REQ);
    await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/);
    await expect(page.getByTestId("blockers")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Executar" })).toBeEnabled();
    const group = page.getByTestId("group-uncovered");
    await expect(group).toContainText("Requisitos sem cobertura (0)");
    await expect(group).toContainText("Nenhum requisito ficou sem cobertura.");
    await expect(page.getByTestId("group-will-run")).toContainText("Vai executar");
    await openGroups(page);
    await expect(page.getByTestId("group-not-applicable")).toBeVisible();
  });
});

test("blocker: nenhuma verificação selecionada", async ({ page }) => {
  await withServer(page, null, async () => {
    await review(page, { ...REQ, skip: ["capability:file-size", "capability:lint", "capability:secrets", "capability:architecture", "capability:properties", "capability:integration"] });
    await expectBlocker(page, "PLAN_EMPTY", /nenhuma verificação/i);
  });
});

test("blocker: template obrigatório sem componente compatível", async ({ page }) => {
  const prepare = (fixture: Fixture) => {
    write(fixture, ".jgates/templates/go.yml", "schemaVersion: 1\nid: go\nlabel: Go\nmatch:\n  languages: [go]\n");
    append(fixture, "jgates.yml", "  - id: go\n    source: .jgates/templates/go.yml\n    activation: always\n");
  };
  await withServer(page, prepare, async () => {
    await review(page, REQ);
    await expectBlocker(page, "TEMPLATE_INCOMPATIBLE", /template go/);
  });
});

test("blocker: alvo ausente (diretório sem caminho)", async ({ page }) => {
  await withServer(page, null, async () => {
    await review(page, { ...REQ, target: "paths", path: "" });
    await expectBlocker(page, "TARGET_MISSING");
  });
});

test("blocker: alvo ausente (referência que não existe no repositório)", async ({ page }) => {
  const prepare = (fixture: Fixture) => {
    fixture.env.JGATES_GIT = findGit();
    git(fixture.dir, "init", "-b", "main");
    git(fixture.dir, "add", "-A");
    git(fixture.dir, "commit", "-m", "fixture");
  };
  await withServer(page, prepare, async () => {
    await review(page, { ...REQ, target: "commit", head: "no-such-ref" });
    await expectBlocker(page, "TARGET_MISSING", /no-such-ref/);
  });
});

test("blocker: categoria incluída sem verificação", async ({ page }) => {
  await withServer(page, (fixture) => addProfile(fixture, "pede-e2e", "      capability:e2e:\n        enabled: true\n"), async () => {
    await review(page, { ...REQ, profile: "pede-e2e" });
    await expectBlocker(page, "CATEGORY_EMPTY", /capability:e2e/);
  });
});

/** A project template, always active, with tool instances of the template defaults (not required by the profile). */
function templateTools(fixture: Fixture, ...tools: Array<[string, string]>) {
  const body = tools.map(([id, capability]) => `      ${id}:\n        adapter: ${id}\n        enabled: true\n        capabilities: [${capability}]\n`).join("");
  write(fixture, ".jgates/templates/local-tools.yml", `schemaVersion: 1\nid: local-tools\nconfig:\n  tools:\n${body}`);
  append(fixture, "jgates.yml", "  - id: local-tools\n    source: .jgates/templates/local-tools.yml\n    activation: always\n");
}

test("blocker: arquitetura incluída sem regra ativa", async ({ page }) => {
  const prepare = (fixture: Fixture) => {
    addProfile(fixture, "com-arquitetura", "      capability:architecture:\n        enabled: true\n");
    // The architecture tool of a template (the built-in one enters only with a contract).
    templateTools(fixture, ["import-linter", "architecture"]);
  };
  await withServer(page, prepare, async () => {
    await review(page, { ...REQ, profile: "com-arquitetura" });
    await expectBlocker(page, "ARCHITECTURE_NO_RULES", /architecture\.yml/);
  });
});

test("blocker: configuração inválida, com o arquivo", async ({ page }) => {
  await withServer(page, (fixture) => append(fixture, "pyproject.toml", "\n[tool.ruff.lint\nselect = \n"), async () => {
    await review(page, REQ);
    await expectBlocker(page, "CONFIG_INVALID", /pyproject\.toml/);
  });
});

test("blocker: documento com alterações não salvas, até salvar ou usar a versão salva", async ({ page }) => {
  await withServer(page, null, async ({ fixture }) => {
    await page.goto(`${base(page)}#/tools/ruff`);
    await page.getByRole("tab", { name: "Arquivos" }).click();
    await page.getByRole("button", { name: /pyproject\.toml/ }).first().click();
    await expect(page.locator(EDITOR)).toContainText("tool.ruff.lint");
    await page.locator(EDITOR).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type('\nignore = ["F401"]');
    await expect(page.getByTestId("draft-state")).toHaveAttribute("data-state", "saved");
    await review(page, REQ);
    await expect(page.getByTestId("plan-hash")).toHaveText(/^\S{16,}$/);
    await expectBlocker(page, "UNSAVED_DOCUMENT", /pyproject\.toml|documento/);
    await page.getByTestId("pending-drafts").getByRole("button", { name: "Usar a versão salva", exact: true }).click();
    await expect(page.getByTestId("blockers")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Executar" })).toBeEnabled();
    expect(read(fixture, "pyproject.toml")).not.toContain("F401");
  });
});

test("blocker: ferramenta obrigatória indisponível", async ({ page }) => {
  await withServer(page, (fixture) => { fixture.env.JGATES_RUFF = path.join(os.tmpdir(), "jgates-no-such-ruff"); requireLint(fixture); }, async () => {
    await review(page, REQ);
    await expectBlocker(page, "TOOL_UNAVAILABLE", /ruff/i);
    // The same instance is listed with the way to resolve it.
    await expect(page.locator('[data-unavailable="ruff#lint"]')).toContainText("Como resolver:");
  });
});

test("blocker: versão da ferramenta fora da faixa", async ({ page }) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-fake-ruff-"));
  try {
    // A Node script answers --version the same way on every system (a #! shell script cannot run on Windows).
    const fake = path.join(bin, "ruff.cjs");
    fs.writeFileSync(fake, 'console.log("ruff 0.0.1");\n');
    await withServer(page, (fixture) => { fixture.env.JGATES_RUFF = fake; requireLint(fixture); }, async () => {
      await review(page, REQ);
      await expectBlocker(page, "VERSION_OUT_OF_RANGE", /Versão incompatível/);
    });
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// ---- Revisar and Escolher: every capability with its state ---------------------------------------------------------

const STRICT = { ...REQ, profile: "strict" };
const capRow = (page: Page, cap: string) => page.locator(`[data-testid="capability-states"] [data-testid="capability-state"][data-capability="${cap}"]`);

test("Revisar with strict lists every capability of the catalog: will run, not applicable here with the reason and the action, never a blocker", async ({ page }) => {
  await withServer(page, null, async () => {
    await review(page, STRICT);
    const states = page.getByTestId("capability-states");
    await expect(states).toBeVisible();
    await expect(states.getByTestId("capability-summary")).toContainText("não se aplica");
    // Every capability of the catalog is listed, none silently missing.
    await expect(states.getByTestId("capability-state")).toHaveCount(28);
    await expect(capRow(page, "lint")).toHaveAttribute("data-state", "run");
    await expect(capRow(page, "lint")).toContainText("Vai rodar");
    // Integration runs: the pytest template brings its own integration instance (it has nothing to run here).
    await expect(capRow(page, "integration")).toHaveAttribute("data-state", "run");
    // e2e, performance and migration have tools for Python: not applicable here until they are set up, never a blocker.
    for (const cap of ["mutation", "dast", "e2e", "performance", "migration", "api-contract", "api-compatibility"]) {
      await expect(capRow(page, cap), cap).toHaveAttribute("data-state", "na");
      await expect(capRow(page, cap), cap).toContainText("Não se aplica aqui");
    }
    // A tool that needs a running target: the missing setting is named and the one action adds the tool.
    await expect(capRow(page, "dast")).toContainText("a URL do alvo em execução (target)");
    await expect(capRow(page, "dast").getByRole("link", { name: /^Adicionar ZAP/ })).toHaveAttribute("href", "#/tools?add=zap&focus=target");
    // Property tests run with pytest (Hypothesis) in a Python project.
    await expect(capRow(page, "properties")).toContainText("com pytest");
    // The plan's own group names them too, and none of them blocks.
    await expect(page.getByTestId("group-not-applicable-requirements")).toContainText("Mutação");
    await page.getByTestId("group-not-applicable-requirements").getByRole("button", { name: "Ver o motivo e como ligar cada uma" }).click();
    await expect(page.locator("#vrev-caps")).toBeFocused();
    await expect(page.locator('[data-blocker="CATEGORY_EMPTY"]')).toHaveCount(0);
    // Details keep the adapter's own prerequisites as secondary text.
    await capRow(page, "dast").locator("details.capst-more > summary").click();
    await expect(capRow(page, "dast").locator("details [lang=en]").first()).toBeVisible();
  });
});

test("'Adicionar ZAP' opens the tool creation for zap", async ({ page }) => {
  await withServer(page, null, async () => {
    await review(page, STRICT);
    await capRow(page, "dast").getByRole("link", { name: /^Adicionar ZAP/ }).click();
    await expect(page.getByRole("dialog")).toContainText("Nova instância de ZAP");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test("'Ativar' adds the missing template to jgates.yml and the plan is built again", async ({ page }) => {
  await withServer(page, null, async ({ fixture }) => {
    await review(page, STRICT);
    // Whichever capability still waits for a built-in template in this project (init already adds the common ones).
    const button = page.locator('[data-testid="capability-states"] [data-testid="capability-state"]').getByRole("button", { name: /^Ativar/ }).first();
    await expect(button).toBeVisible();
    const name = String(await button.getAttribute("aria-label"));
    const capability = String(await button.locator("xpath=ancestor::li[@data-capability][1]").getAttribute("data-capability"));
    const before = read(fixture, "jgates.yml");
    await button.click();
    await expect(page.getByText(/Template .* ativado no jgates\.yml\./)).toBeVisible();
    const after = read(fixture, "jgates.yml");
    // A patch: what was there stays, one template entry more.
    expect(after).toContain(before.trimEnd().split("\n").slice(0, 3).join("\n"));
    expect((after.match(/source: builtin:/g) ?? []).length).toBe((before.match(/source: builtin:/g) ?? []).length + 1);
    // The new plan no longer asks for that template: the row moved on (runs, or names what is still missing).
    await expect(capRow(page, capability).getByRole("button", { name })).toHaveCount(0, { timeout: 60_000 });
  });
});

test("a capability switched off by the profile file says so and 'Ligar neste perfil' writes it on, where a tool exists", async ({ page }) => {
  const prepare = (fixture: Fixture) => {
    const file = ".jgates/profiles.yml";
    const text = read(fixture, file);
    const entry = "      capability:format-check:\n        enabled: true\n        when: available\n";
    expect(text).toContain(entry);
    write(fixture, file, text.replace(entry, "      capability:format-check:\n        enabled: false\n"));
  };
  await withServer(page, prepare, async ({ fixture }) => {
    await review(page, STRICT);
    const row = capRow(page, "format-check");
    await expect(row).toHaveAttribute("data-state", "off");
    await expect(row).toContainText("Desligada neste perfil (pelo seu arquivo .jgates/profiles.yml).");
    await row.getByRole("button", { name: /^Ligar neste perfil: / }).click();
    await expect(row).not.toHaveAttribute("data-state", "off", { timeout: 60_000 });
    expect(read(fixture, ".jgates/profiles.yml")).toMatch(/capability:format-check:\n {8}enabled: true\n {8}when: available/);
  });
});

test("a capability switched off for this run only can be included again from the review", async ({ page }) => {
  await withServer(page, null, async () => {
    await review(page, { ...STRICT, skip: ["capability:secrets"] });
    const row = capRow(page, "secrets");
    // secrets is required by the profile: switched off for this run it has no check, and the review says how to undo it.
    await expect(row).toHaveAttribute("data-state", "blocked");
    await expect(row).toContainText("Sem verificação");
    await expect(page.getByTestId("equivalent-command")).toContainText("--skip capability:secrets");
    await row.getByRole("button", { name: /^Incluir nesta execução: / }).click();
    await expect(row).toHaveAttribute("data-state", "run", { timeout: 60_000 });
    await expect(page.getByTestId("equivalent-command")).not.toContainText("--skip");
  });
});

test("Escolher lists every capability too: not applicable ones with the reason, off ones with the way to turn them on", async ({ page }) => {
  await withServer(page, null, async () => {
    await page.goto(`${base(page)}#/validations/choose`);
    await page.locator('[data-profile="strict"]').click();
    await page.getByTestId("customize").locator("summary").click();
    const customize = page.getByTestId("customize");
    await expect(customize.getByTestId("capability-state")).toHaveCount(28, { timeout: 60_000 });
    await expect(customize.locator('[data-capability="e2e"]')).toContainText("Não se aplica aqui");
    await expect(customize.locator('[data-capability="mutation"]')).toContainText("Não se aplica aqui");
    await expect(customize.getByTestId("capability-summary")).toContainText("vão rodar");
    await expect(page.getByRole("checkbox", { name: /Testes unitários/ })).toBeChecked();
  });
});

test("the capability states fit 375 px and work with the keyboard", async ({ page }) => {
  await withServer(page, null, async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await review(page, STRICT);
    await expect(page.getByTestId("capability-states")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // A category closes and opens from the keyboard.
    const summary = page.locator('[data-testid="capability-states"] details[data-category="tests"] > summary');
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="capability-states"] details[data-category="tests"]')).not.toHaveAttribute("open", "");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="capability-states"] details[data-category="tests"]')).toHaveAttribute("open", "");
  });
});

// ---- Revisar: ties, TOOL_UNAVAILABLE per instance, the equivalent command ------------------------------------------

test("a tie between selectors of the same layer appears in the review with the explanation (not only in the config JSON)", async ({ page }) => {
  const prepare = (fixture: Fixture) => {
    write(fixture, ".jgates/tools.yml", "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    capabilities: [lint]\n    component: root\n");
    addProfile(fixture, "empate", "      capability:lint:\n        enabled: true\n      component:root:\n        enabled: false\n");
  };
  await withServer(page, prepare, async () => {
    await review(page, { ...REQ, profile: "empate" });
    const ties = page.getByTestId("ties");
    await expect(ties).toBeVisible();
    await expect(ties).toContainText("Empate entre decisões");
    await expect(ties).toContainText("component:root");
    await expect(ties).toContainText("resolvido para ligado");
    await expect(page.getByRole("button", { name: "Executar" })).toBeEnabled();
  });
});

test("TOOL_UNAVAILABLE is shown per instance with the way to resolve it (eslint.config, architecture.yml)", async ({ page }) => {
  const prepare = (fixture: Fixture) => {
    write(fixture, "web/package.json", '{ "name": "demo-web", "version": "0.0.0" }\n');
    write(fixture, "web/tsconfig.json", '{ "compilerOptions": { "strict": true } }\n');
    write(fixture, "web/src/index.ts", "export const value: number = 1;\n");
    // init ran before the TypeScript files existed: the template is added the way `jgates init` would have written it.
    append(fixture, "jgates.yml", "  - id: typescript\n    source: builtin:typescript\n    activation: detected\n    match:\n      languages:\n        - typescript\n");
    // The built-in templates bring ESLint and Import Linter only with their configuration (match.files):
    // a project template declares both, the way the built-in ones did, without an eslint.config or an architecture.yml.
    templateTools(fixture, ["eslint", "lint"], ["import-linter", "architecture"]);
  };
  await withServer(page, prepare, async () => {
    await review(page, REQ);
    const section = page.getByTestId("unavailable");
    await expect(section).toBeVisible();
    // Python's architecture tool has no contract: the path is .jgates/architecture.yml.
    await expect(section.locator('[data-unavailable="import-linter#architecture"]')).toContainText("architecture.yml");
    // ESLint no longer shows here: it runs from the tools image, and a missing eslint.config is the adapter's finding at run time.
    await expect(section.locator('[data-unavailable="eslint#lint"]')).toHaveCount(0);
    // They are tool instances, not requirements of the profile: the plan stays reviewable and Executar is not blocked by them.
    await expect(page.getByRole("button", { name: "Executar" })).toBeEnabled();
  });
});

test("the equivalent command shown in the review, run by the CLI, gives a plan with the same hash", async ({ page }) => {
  await withServer(page, null, async ({ fixture }) => {
    await review(page, { ...REQ, skip: ["capability:secrets"] });
    const hash = ((await page.getByTestId("plan-hash").textContent()) ?? "").trim();
    expect(hash).toMatch(/^sha256:/);
    const shown = ((await page.getByTestId("equivalent-command").textContent()) ?? "").trim();
    expect(shown).toMatch(/^jgates run /);
    expect(shown).toContain("--skip capability:secrets");
    expect(shown).not.toContain("'");
    const argv = shown.split(" ").slice(1);
    const ran = spawnSync(process.execPath, [MAIN, ...argv], { env: fixture.env, encoding: "utf8", timeout: 170_000, maxBuffer: 64 * 1024 * 1024 });
    const result = JSON.parse(ran.stdout) as { selection?: { planHash?: string } };
    expect(result.selection?.planHash, ran.stdout + ran.stderr).toBe(hash);
  });
});
