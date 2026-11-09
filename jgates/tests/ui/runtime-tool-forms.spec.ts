import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { createFixture, startServer, type Fixture, type UiServer } from "./support";

// Runtime checks (ZAP, Schemathesis, oasdiff) from the strict review: "Adicionar <tool>" creates the instance and lands
// on its guided options form with the missing setting focused and highlighted; the form checks the value before saving
// and writes only that key to .jgates/tools.yml; the plan is built again with it. "Preparar <tool>" installs what is
// missing right from the review (the prerequisites routes are stubbed here) and shows the result in place.

const REQUEST_KEY = "jgates.validation.request";
const STRICT = { profile: "strict", target: "full", path: "", head: "", base: "", skip: [] as string[] };
const capRow = (page: Page, cap: string) => page.locator(`[data-testid="capability-states"] [data-testid="capability-state"][data-capability="${cap}"]`);
/** A Schemathesis instance with its target and capability: what is left missing is the tool itself (empty test PATH). */
const SCHEMATHESIS = "  schemathesis:\n    adapter: schemathesis\n    capabilities: [api-contract]\n    target: http://localhost:8000\n";
const tools = (fixture: Fixture): any => parse(fs.readFileSync(path.join(fixture.dir, ".jgates", "tools.yml"), "utf8"));

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

async function review(page: Page) {
  await page.evaluate(([key, value]) => window.sessionStorage.setItem(key as string, value as string), [REQUEST_KEY, JSON.stringify(STRICT)]);
  await page.goto(`${base(page)}#/validations/review`);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Revisar a validação", level: 1 })).toBeVisible();
  await expect(page.getByText("Montando o plano...")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("capability-states")).toBeVisible();
}

/** "Adicionar <tool>" from the review, then "Criar instância" in the dialog it opens. */
async function addFromReview(page: Page, cap: string, tool: string, href: string) {
  const link = capRow(page, cap).getByRole("link", { name: new RegExp(`^Adicionar ${tool}`) });
  await expect(link).toHaveAttribute("href", href);
  await link.click();
  await expect(page.getByRole("dialog")).toContainText(`Nova instância de ${tool}`);
  await page.getByRole("dialog").getByRole("button", { name: "Criar instância" }).click();
  await expect(page.getByTestId("settings-form")).toBeVisible({ timeout: 30_000 });
}

test("'Adicionar ZAP' lands on the ZAP form with the target focused; an invalid URL is refused inline, a valid one is saved and planned", async ({ page }) => {
  await withServer(page, null, async ({ fixture }) => {
    await review(page);
    await addFromReview(page, "dast", "ZAP", "#/tools?add=zap&focus=target");
    expect(page.url()).toContain("#/tools/zap?focus=target");
    const form = page.getByTestId("settings-form");
    const target = form.getByLabel(/^URL do alvo/);
    await expect(target).toBeFocused();
    await expect(form.locator('[data-field="target"]')).toHaveAttribute("data-missing", "true");
    await expect(form.getByTestId("rtf-needed")).toContainText("URL do alvo");
    await expect(form).toContainText("O JGates não inicia a sua aplicação");
    // Scan mode: passive by default, active explained and gated by its own confirmation.
    await expect(form.getByRole("radio", { name: /^Passivo/ })).toBeChecked();
    await expect(form.getByRole("radio", { name: /^Ativo/ })).not.toBeChecked();
    await expect(form.getByRole("checkbox", { name: /permitir a varredura ativa/ })).toHaveCount(0);

    await target.fill("localhost:8000");
    await form.getByRole("button", { name: "Salvar" }).click();
    await expect(form.getByTestId("rtf-error")).toContainText("http://");
    await expect(target).toHaveAttribute("aria-invalid", "true");
    expect(tools(fixture).tools.zap.target).toBeUndefined();

    // Active without the confirmation is refused too; the confirmation appears with it.
    await form.getByRole("radio", { name: /^Ativo/ }).check();
    await expect(form.getByRole("checkbox", { name: /permitir a varredura ativa/ })).toBeVisible();
    await target.fill("http://localhost:8000");
    await form.getByRole("button", { name: "Salvar" }).click();
    await expect(form.locator('[data-field="allowActive"] [data-testid="rtf-error"]')).toContainText("confirme");
    await form.getByRole("radio", { name: /^Passivo/ }).check();

    await form.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByTestId("rtf-saved")).toContainText(".jgates/tools.yml");
    const zap = tools(fixture).tools.zap;
    expect(zap).toEqual({ adapter: "zap", capabilities: ["dast"], target: "http://localhost:8000" });

    // The plan is built again with the target: ZAP runs, or (no Docker here) its tool is missing with "Preparar".
    await page.getByRole("link", { name: /Voltar para a revisão/ }).click();
    await expect(page.getByText("Montando o plano...")).toHaveCount(0, { timeout: 60_000 });
    const row = capRow(page, "dast");
    await expect(row).not.toContainText("a URL do alvo em execução (target)");
    const state = await row.getAttribute("data-state");
    if (state === "na") await expect(row.getByRole("button", { name: /^Preparar/ })).toBeVisible();
    else expect(state).toBe("run");
  });
});

test("oasdiff from the strict review: template, then its settings form with the base as a Git ref, the OpenAPI file offered, fail level as a select", async ({ page }) => {
  const prepare = (fixture: Fixture) => fs.writeFileSync(path.join(fixture.dir, "openapi.yaml"), "openapi: 3.0.0\ninfo: {title: demo, version: '1'}\npaths: {}\n");
  await withServer(page, prepare, async ({ fixture }) => {
    await review(page);
    // With an OpenAPI file the built-in template comes first; then the instance still needs its reference.
    await capRow(page, "api-compatibility").getByRole("button", { name: /^Ativar o template/ }).click();
    // The template declares the oasdiff instance without its reference, and the binary is missing here too: the row
    // links to the settings form first and says the tool is prepared next (configure, then prepare).
    const configure = capRow(page, "api-compatibility").getByRole("link", { name: /^Configurar oasdiff/ });
    await expect(configure).toBeVisible({ timeout: 60_000 });
    await expect(configure).toHaveAttribute("href", "#/tools/oasdiff?focus=baseRef");
    await expect(capRow(page, "api-compatibility")).toContainText("Depois, prepare");
    // The instance comes from the template (no entry in tools.yml yet): its page still opens the settings form.
    await configure.click();
    await expect(page.getByTestId("tool-declared")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("settings-form")).toBeVisible();
    const form = page.getByTestId("settings-form");
    const choice = form.locator('[data-choice="base"]');
    await expect(choice).toHaveAttribute("data-missing", "true");
    await expect(choice.getByRole("radio", { name: /^Uma ref do Git/ })).toBeChecked();
    const ref = form.getByLabel(/^Ref do Git/);
    await expect(ref).toBeFocused();
    await expect(form.getByLabel(/^Especificação OpenAPI/)).toContainText("openapi.yaml");
    await expect(form.getByLabel(/^Reprova com/).locator("option")).toHaveText(["Padrão (Mudanças incompatíveis (ERR))", "Mudanças incompatíveis (ERR)", "Também avisos (WARN)"]);

    // Saving without a reference is refused: the check cannot run without one.
    await form.getByRole("button", { name: "Salvar" }).click();
    await expect(form.locator('[data-field="baseRef"] [data-testid="rtf-error"]')).toContainText("Obrigatório");
    await ref.fill("--upload-pack=x");
    await form.getByRole("button", { name: "Salvar" }).click();
    await expect(form.locator('[data-field="baseRef"] [data-testid="rtf-error"]')).toContainText("branch");

    await ref.fill("main");
    await form.getByLabel(/^Especificação OpenAPI/).selectOption("openapi.yaml");
    await form.getByLabel(/^Reprova com/).selectOption("WARN");
    await form.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByTestId("rtf-saved")).toBeVisible();
    expect(tools(fixture).tools.oasdiff).toEqual({ adapter: "oasdiff", capabilities: ["api-compatibility"], baseRef: "main", spec: "openapi.yaml", failOn: "WARN" });

    // Switching to a reference file removes the git ref: the two never coexist.
    await form.getByRole("radio", { name: /^Um arquivo de referência/ }).check();
    await page.getByLabel(/^Arquivo de referência/).selectOption("openapi.yaml");
    await page.getByTestId("settings-form").getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByTestId("rtf-saved")).toBeVisible();
    await expect.poll(() => tools(fixture).tools.oasdiff).toEqual({ adapter: "oasdiff", capabilities: ["api-compatibility"], baseSpec: "openapi.yaml", spec: "openapi.yaml", failOn: "WARN" });

    await review(page);
    await expect(capRow(page, "api-compatibility")).not.toContainText("(baseRef)");
    // Configured: what is left is the tool itself.
    await expect(capRow(page, "api-compatibility").getByRole("button", { name: /^Preparar oasdiff/ })).toBeVisible({ timeout: 60_000 });
  });
});

test("'Preparar' installs the missing tool from the review after a confirmation, shows the result and builds the plan again", async ({ page }) => {
  // A Schemathesis instance with its target: the tool itself is what is missing (the test PATH is empty).
  const prepare = (fixture: Fixture) => {
    fs.writeFileSync(path.join(fixture.dir, "openapi.yaml"), "openapi: 3.0.0\ninfo: {title: demo, version: '1'}\npaths: {}\n");
    fs.appendFileSync(path.join(fixture.dir, ".jgates", "tools.yml"), SCHEMATHESIS);
  };
  await withServer(page, prepare, async () => {
    const fixes: unknown[] = [];
    let prerequisites = 0;
    await page.route("**/api/prerequisites", (route) => {
      prerequisites += 1;
      return route.fulfill({
        json: {
          schemaVersion: 1,
          status: "OK",
          ready: false,
          platform: "linux",
          items: [{ id: "tools", kind: "tools-install", classification: "optional", names: ["schemathesis"], commands: ["python -m pip install schemathesis==4.33.1"], action: "run", hosts: ["pypi.org"], message: null, fix: null }],
        },
      });
    });
    await page.route("**/api/prerequisites/fix", async (route) => {
      fixes.push(route.request().postDataJSON());
      await new Promise((r) => setTimeout(r, 300));
      return route.fulfill({ json: { schemaVersion: 1, status: "OK", outcome: { id: "tools", status: "done", message: null, outcomes: [] }, ready: true, platform: "linux", items: [] } });
    });
    await review(page);
    const row = capRow(page, "api-contract");
    await expect(row).toHaveAttribute("data-state", "na");
    const button = row.getByRole("button", { name: /^Preparar/ });
    await expect(button).toBeVisible();
    await expect(row.getByRole("link", { name: /^Ver detalhes/ })).toHaveAttribute("href", "#/environment");
    await button.click();
    // The commands and the network are shown before anything runs.
    await expect(row.getByTestId("prepare-action")).toHaveAttribute("data-step", "confirm");
    await expect(row).toContainText("python -m pip install schemathesis==4.33.1");
    await expect(row).toContainText("pypi.org");
    expect(fixes).toEqual([]);
    await row.getByRole("button", { name: /^Instalar agora/ }).click();
    await expect(row.getByTestId("prepare-action")).toHaveAttribute("data-step", "running");
    await expect(row.getByTestId("prepare-result")).toHaveAttribute("data-status", "done", { timeout: 10_000 });
    expect(fixes).toEqual([{ id: "tools" }]);
    expect(prerequisites).toBeGreaterThan(0);
  });
});

test("'Preparar' for a tool JGates cannot install says so plainly, with the install link", async ({ page }) => {
  const prepare = (fixture: Fixture) => {
    fs.writeFileSync(path.join(fixture.dir, "openapi.yaml"), "openapi: 3.0.0\ninfo: {title: demo, version: '1'}\npaths: {}\n");
    fs.appendFileSync(path.join(fixture.dir, ".jgates", "tools.yml"), SCHEMATHESIS);
  };
  await withServer(page, prepare, async () => {
    await page.route("**/api/prerequisites", (route) =>
      route.fulfill({
        json: {
          schemaVersion: 1,
          status: "OK",
          ready: false,
          platform: "win32",
          items: [{ id: "manual:tool:schemathesis", kind: "manual", classification: "optional", names: ["schemathesis"], commands: [], action: null, hosts: [], message: "Python 3.10+ was not found.", fix: "Install Python 3.10 or later." }],
        },
      }),
    );
    await review(page);
    const row = capRow(page, "api-contract");
    await row.getByRole("button", { name: /^Preparar/ }).click();
    const manual = row.getByTestId("prepare-manual");
    await expect(manual).toContainText("O JGates não consegue preparar");
    await expect(manual).toContainText("Python 3.10+ was not found.");
    await expect(row.getByRole("link", { name: /^Como instalar/ })).toHaveAttribute("href", /^https:\/\//);
  });
});
