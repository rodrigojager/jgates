import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAIN, createFixture, sha256, startServer, type Fixture, type UiServer } from "./support";

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

const base = (page: Page): string => page.url().split("#")[0] as string;

/** Opens Revisar with a request, as Escolher leaves it. */
async function review(page: Page, request: Record<string, unknown>) {
  await page.evaluate(([key, value]) => window.sessionStorage.setItem(key as string, value as string), [REQUEST_KEY, JSON.stringify(request)]);
  await page.goto(`${base(page)}#/validations/review`);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Revisar a validação", level: 1 })).toBeVisible();
  await expect(page.getByText("Montando o plano...")).toHaveCount(0, { timeout: 60_000 });
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
    await expect(page.getByTestId("group-not-applicable")).toBeVisible();
  });
});

test("blocker: nenhuma verificação selecionada", async ({ page }) => {
  await withServer(page, null, async () => {
    await review(page, { ...REQ, skip: ["capability:file-size", "capability:lint", "capability:secrets", "capability:architecture"] });
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
  await withServer(page, (fixture) => { fixture.env.JGATES_RUFF = path.join(os.tmpdir(), "jgates-no-such-ruff"); }, async () => {
    await review(page, REQ);
    await expectBlocker(page, "TOOL_UNAVAILABLE", /ruff/i);
    // The same instance is listed with the way to resolve it.
    await expect(page.locator('[data-unavailable="ruff#lint"]')).toContainText("Como resolver:");
  });
});

test("blocker: versão da ferramenta fora da faixa", async ({ page }) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-fake-ruff-"));
  try {
    const fake = path.join(bin, "ruff");
    fs.writeFileSync(fake, '#!/bin/sh\necho "ruff 0.0.1"\n', { mode: 0o755 });
    await withServer(page, (fixture) => { fixture.env.JGATES_RUFF = fake; }, async () => {
      await review(page, REQ);
      await expectBlocker(page, "VERSION_OUT_OF_RANGE", /Versão incompatível/);
    });
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
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
    // The TypeScript component brings ESLint with no eslint.config.
    const eslint = section.locator('[data-unavailable="eslint#lint"]');
    await expect(eslint).toContainText("eslint.config");
    await expect(eslint).toContainText("Como resolver:");
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
