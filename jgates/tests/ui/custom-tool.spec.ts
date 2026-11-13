import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { expectNoKnownSetAsText } from "./free-text";
import { REPO, createFixture, openApp, pageGet, startServer, type Fixture } from "./support";

// "Adicionar ferramenta" > "Própria": the six-step dialog completed with the keyboard only for a SARIF tool, on the fake
// container engine. The review shows the exact diff of tools.yml and of the Dockerfile (the lines it shows are what lands
// on disk), "Testar agora" builds the extension image and runs the tool once (the fake tool writes a SARIF report that is
// read back), Esc closes the dialog and returns the focus to the button that opened it, and a component declared in a
// language JGates has no checks for offers the same flow. Desktop width and 375 px.

const FAKE = path.join(REPO, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version as string;
const TOOLS_ID = `sha256:${"a".repeat(64)}`;
const SARIF = JSON.stringify({
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "acme-lint", version: "1.0", rules: [{ id: "AC001" }] } },
      results: [{ ruleId: "AC001", level: "error", message: { text: "Do not use eval" }, locations: [{ physicalLocation: { artifactLocation: { uri: "/workspace/app.py" }, region: { startLine: 7, startColumn: 3 } } }] }],
    },
  ],
});

/** A configured project with the fake engine; the fake tool container writes a SARIF report under /output. */
function build(): { fixture: Fixture; engine: string } {
  const fixture = createFixture();
  fs.mkdirSync(path.join(fixture.dir, "native"), { recursive: true });
  fs.writeFileSync(path.join(fixture.dir, "native", "main.cpp"), "int main() { return 0; }\n");
  fs.writeFileSync(path.join(fixture.dir, "app.py"), "def add(a, b):\n    return a + b\n\n\nresult = eval('1')\n");
  const engine = fs.mkdtempSync(path.join(fixture.home, "engine-"));
  const runtime = path.join(engine, "docker.cjs");
  const outputs = { "acme-lint": { "outputs/generic-command/acme-lint/acme-lint.sarif": SARIF } };
  fs.writeFileSync(
    runtime,
    [
      `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};`,
      `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`,
      `process.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};`,
      `process.env.FAKE_DOCKER_IMAGE_ID = ${JSON.stringify(TOOLS_ID)};`,
      `process.env.FAKE_DOCKER_OUTPUT_FILES = ${JSON.stringify(JSON.stringify(outputs))};`,
      `require(${JSON.stringify(FAKE)});`,
      ``,
    ].join("\n"),
  );
  fixture.env.JGATES_IMAGE_JSON = "";
  fixture.env.JGATES_CONTAINER_RUNTIME = runtime;
  fixture.env.JGATES_TOOLS_IMAGE = "jgates-tools:dev";
  fixture.env.JGATES_NO_CACHE = "1";
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language: "pt-BR" }, null, 2)}\n`, { mode: 0o600 });
  return { fixture, engine };
}

const dockerCalls = (engine: string): string[][] => {
  const file = path.join(engine, "calls.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
};

/** Presses Tab until the control has the focus (the keyboard path reaches it), never clicking. */
async function tabTo(page: Page, target: Locator, max = 120): Promise<void> {
  await expect(target).toBeVisible();
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`the keyboard never reached ${await target.evaluate((el) => el.outerHTML.slice(0, 200))}`);
}

async function press(page: Page, target: Locator, key = "Enter"): Promise<void> {
  await expect(target).toBeEnabled();
  await tabTo(page, target);
  await page.keyboard.press(key);
}

/** Types into a field reached with Tab (the field is emptied first). */
async function typeInto(page: Page, target: Locator, text: string): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text);
}

async function noSidewaysScroll(page: Page, where: string): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(0);
}

/** The text of the added lines of a diff block. */
async function addedText(block: Locator): Promise<string> {
  const lines = await block.locator(".diff-line.add > span:last-child").allTextContents();
  return lines.map((l) => l.replace(/^linha adicionada: /, "")).join("\n");
}

for (const width of [1280, 375]) {
  test(`a SARIF tool is added with the keyboard only: exact diff, test on the fake engine, save (${width} px)`, async ({ page }) => {
    const { fixture, engine } = build();
    let server: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      await page.setViewportSize({ width, height: 900 });
      server = await startServer(fixture);
      const base = await openApp(page, server);
      await page.goto(`${base}#/tools`);
      await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();

      const opener = page.getByRole("button", { name: "Adicionar ferramenta", exact: true });
      await press(page, opener);
      const dialog = page.getByRole("dialog");
      // Two paths: the catalog (the default) and an own tool.
      const catalog = dialog.getByRole("radio", { name: /Do catálogo/ });
      await tabTo(page, catalog);
      await expect(catalog).toBeChecked();
      await page.keyboard.press("ArrowDown");
      await expect(dialog.getByRole("radio", { name: /Própria/ })).toBeChecked();
      await press(page, dialog.getByTestId("tools-path-continue"));

      const own = page.getByTestId("custom-tool-dialog");
      await expect(own).toHaveAttribute("data-step", "obtain");
      await expect(own.getByRole("heading", { name: "Passo 1 de 6: Como obter" })).toBeFocused();
      expect(await own.getByRole("navigation").locator("li").allTextContents()).toEqual(["Como obter", "Como executar", "Como ler o resultado", "O que verifica", "Revisão", "Testar agora"]);

      // 1. Como obter: install with pip; the Dockerfile lines come from the same code as the CLI.
      await tabTo(page, own.getByRole("radio", { name: "Instalar no ambiente do JGates" }));
      await expect(own.getByTestId("ctl-method")).toHaveValue("pip");
      await typeInto(page, own.getByLabel("Pacote e versão"), "acme-lint==1.0");
      await expect(own.getByTestId("ctl-lines")).toContainText("uv tool install");
      if (width === 375) await noSidewaysScroll(page, "step 1");
      await press(page, own.getByTestId("ctl-next"));

      // 2. Como executar: the id follows the package, the placeholders are explained inline.
      await expect(own).toHaveAttribute("data-step", "run");
      await expect(own.getByTestId("ctl-id")).toHaveValue("acme-lint");
      await expect(own).toContainText("{output}");
      await typeInto(page, own.getByTestId("ctl-command"), "acme-lint");
      await tabTo(page, own.getByTestId("ctl-args"));
      await page.keyboard.type("--out={output}/acme-lint.sarif");
      await page.keyboard.press("Enter");
      await page.keyboard.type("{workspace}");
      expect(await own.getByTestId("ctl-component").evaluate((el) => el.tagName)).toBe("SELECT");
      if (width === 375) await noSidewaysScroll(page, "step 2");
      await press(page, own.getByTestId("ctl-next"));

      // 3. Como ler o resultado: SARIF is the recommended one and the default.
      await expect(own).toHaveAttribute("data-step", "read");
      const sarif = own.getByRole("radio", { name: /^SARIF/ });
      await tabTo(page, sarif);
      await expect(sarif).toBeChecked();
      await expect(own.getByTestId("ctl-file")).toHaveValue("acme-lint.sarif");
      await expect(own).toContainText("Recomendado");
      await press(page, own.getByTestId("ctl-next"));

      // 4. O que verifica: capabilities of the catalog, grouped by category; SAST is checked with the space bar.
      await expect(own).toHaveAttribute("data-step", "verify");
      await expect(own.getByRole("group", { name: "Segurança" })).toBeVisible();
      await expect(own.getByTestId("ctl-next")).toBeDisabled();
      const sast = own.locator('input[data-capability="sast"]');
      await tabTo(page, sast);
      await page.keyboard.press("Space");
      await expect(sast).toBeChecked();
      if (width === 375) await noSidewaysScroll(page, "step 4");
      await press(page, own.getByTestId("ctl-next"));

      // 5. Revisão: the exact entry and Dockerfile lines, as a diff, before anything is written.
      await expect(own).toHaveAttribute("data-step", "review");
      const toolsDiff = own.locator('[data-testid="ctl-diff"][data-file=".jgates/tools.yml"]');
      const dockerDiff = own.locator('[data-testid="ctl-diff"][data-file=".jgates/image/Dockerfile"]');
      await expect(toolsDiff).toBeVisible();
      await expect(dockerDiff).toBeVisible();
      await expect(toolsDiff).toContainText("acme-lint:");
      await expect(toolsDiff).toContainText("adapter: generic-command");
      await expect(toolsDiff).toContainText("kind: sarif");
      await expect(dockerDiff).toContainText("ARG JGATES_TOOLS");
      await expect(dockerDiff).toContainText("uv tool install");
      await expect(own.getByTestId("ctl-effects")).toContainText("sem rede");
      await expect(own.getByTestId("ctl-effects")).toContainText("não testada");
      const toolsShown = await addedText(toolsDiff);
      const dockerShown = await addedText(dockerDiff);
      const toolsFile = path.join(fixture.dir, ".jgates", "tools.yml");
      const dockerfile = path.join(fixture.dir, ".jgates", "image", "Dockerfile");
      expect(fs.existsSync(dockerfile), "nothing is written before Salvar").toBe(false);
      expect(fs.readFileSync(toolsFile, "utf8")).not.toContain("acme-lint");
      if (width === 375) await noSidewaysScroll(page, "review");
      await press(page, own.getByTestId("ctl-save"));

      // The files on disk are exactly what the review showed.
      await expect(own).toHaveAttribute("data-step", "test");
      await expect(own.getByTestId("ctl-saved")).toContainText("acme-lint foi salvo");
      const dockerText = fs.readFileSync(dockerfile, "utf8");
      expect(dockerText.trimEnd()).toBe(dockerShown.trimEnd());
      const toolsText = fs.readFileSync(toolsFile, "utf8");
      const entry = parseYaml(toolsText) as { tools: Record<string, any> };
      expect(entry.tools["acme-lint"]).toMatchObject({ adapter: "generic-command", image: "extension", command: "acme-lint", capabilities: ["sast"] });
      expect(entry.tools["acme-lint"].config.evidence).toEqual({ kind: "sarif", file: "acme-lint.sarif" });
      for (const line of toolsShown.split("\n").filter((l) => l.trim() !== "")) expect(toolsText, `the line "${line}" of the review is in tools.yml`).toContain(line);
      expect(dockerText).toMatch(/^ARG JGATES_TOOLS\nFROM \$\{JGATES_TOOLS\}\n/);

      // 6. Testar agora: builds the extension, runs the tool once and reads the report.
      await press(page, own.getByTestId("ctl-test"));
      const result = own.getByTestId("ctl-test-result");
      await expect(result).toHaveAttribute("data-state", "findings", { timeout: 120_000 });
      await expect(result).toContainText("1 achado");
      await expect(result).toContainText("AC001");
      await expect(result).toContainText("app.py:7");
      const calls = dockerCalls(engine);
      const builds = calls.filter((c) => c[0] === "build");
      expect(builds).toHaveLength(1);
      expect(builds[0]).toContain("org.jgates.kind=extension-image");
      const steps = calls.filter((c) => c[0] === "run" && c.includes("org.jgates.kind=step"));
      expect(steps).toHaveLength(1);
      expect(steps[0]).not.toContain(TOOLS_ID);
      if (width === 375) await noSidewaysScroll(page, "test result");

      // Done: the dialog closes, the focus is back on the button that opened it, and the tool is listed as an own tool, tested.
      await press(page, own.getByTestId("ctl-done"));
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(opener).toBeFocused();
      const card = page.locator('[data-testid="tool-card"][data-instance="acme-lint"]');
      await expect(card.getByTestId("origin-row")).toHaveAttribute("data-origin", "own");
      await expect(card).toContainText("Ferramenta própria");
      await expect(card).not.toContainText("Não testada");
      const tested = await pageGet<any>(page, "/api/tool-origins");
      expect(Object.keys(tested.tested)).toEqual(["acme-lint"]);
    } finally {
      await server?.stop();
      fixture.cleanup();
    }
  });
}

test("Esc closes the own-tool dialog at any step and gives the focus back to the opener; an untested tool is labelled", async ({ page }) => {
  const { fixture } = build();
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    server = await startServer(fixture);
    const base = await openApp(page, server);
    await page.goto(`${base}#/tools`);
    const opener = page.getByRole("button", { name: "Adicionar ferramenta", exact: true });
    await press(page, opener);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();

    // Again, deep in the own-tool flow.
    await press(page, opener);
    await tabTo(page, page.getByRole("dialog").getByRole("radio", { name: /Do catálogo/ }));
    await page.keyboard.press("ArrowDown");
    await press(page, page.getByTestId("tools-path-continue"));
    const own = page.getByTestId("custom-tool-dialog");
    await expect(own).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(fs.existsSync(path.join(fixture.dir, ".jgates", "image", "Dockerfile")), "closing writes nothing").toBe(false);

    // A tool saved by hand is an own tool that was never tested.
    const toolsFile = path.join(fixture.dir, ".jgates", "tools.yml");
    fs.appendFileSync(toolsFile, "  hand-made:\n    adapter: generic-command\n    command: true\n    capabilities: [lint]\n    config:\n      evidence:\n        kind: exit-code\n");
    await page.reload();
    const card = page.locator('[data-testid="tool-card"][data-instance="hand-made"]');
    await expect(card.getByTestId("origin-row")).toContainText("Ferramenta própria");
    await expect(card.getByTestId("origin-row")).toContainText("Não testada");
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
});

test("a refused install, an existing name and the image check are said in words; no step takes free text where the values are known (R2)", async ({ page }) => {
  const { fixture } = build();
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    await page.setViewportSize({ width: 375, height: 900 });
    server = await startServer(fixture);
    const base = await openApp(page, server);
    await page.goto(`${base}#/tools?custom=1`);
    const own = page.getByTestId("custom-tool-dialog");
    await expect(own).toBeVisible();
    let seen = 0;

    // Step 1 with a ready image: the image is checked with the engine.
    await own.getByRole("radio", { name: "Já existe uma imagem pronta" }).check();
    seen += await expectNoKnownSetAsText(page, '[data-testid="custom-tool-dialog"]', "step 1 (image)");
    await own.getByLabel("Imagem", { exact: true }).fill("ghcr.io/acme/scanner:2.1");
    await own.getByRole("button", { name: "Verificar imagem" }).click();
    await expect(own.getByTestId("ctl-image-check")).toBeVisible();
    // The install route: a binary asks for a https address and a SHA-256.
    await own.getByRole("radio", { name: "Instalar no ambiente do JGates" }).check();
    await own.getByTestId("ctl-method").selectOption("binary");
    seen += await expectNoKnownSetAsText(page, '[data-testid="custom-tool-dialog"]', "step 1 (binary)");
    await expect(own.getByTestId("ctl-next")).toBeDisabled();
    await own.getByLabel("Endereço https do arquivo").fill("https://example.com/tool-linux-amd64");
    await own.getByLabel("SHA-256 do arquivo").fill("0".repeat(64));
    await expect(own.getByTestId("ctl-lines")).toContainText("ADD --checksum=sha256:");
    await own.getByTestId("ctl-next").click();

    seen += await expectNoKnownSetAsText(page, '[data-testid="custom-tool-dialog"]', "step 2");
    await own.getByTestId("ctl-command").fill("tool");
    await own.getByTestId("ctl-component").selectOption({ index: 0 });
    await own.getByTestId("ctl-next").click();
    seen += await expectNoKnownSetAsText(page, '[data-testid="custom-tool-dialog"]', "step 3");
    expect(await own.getByRole("radio").count()).toBe(4);
    await own.getByTestId("ctl-next").click();
    seen += await expectNoKnownSetAsText(page, '[data-testid="custom-tool-dialog"]', "step 4");
    // A new capability of the person's own, named by hand, lives in the custom category.
    await own.getByLabel("Nome da capacidade").fill("Licença interna");
    await own.getByRole("button", { name: "Adicionar capacidade" }).click();
    await expect(own.locator('input[data-capability="x-custom:licen-a-interna"], input[data-capability^="x-custom:"]')).toBeChecked();
    await own.getByTestId("ctl-next").click();
    await expect(own.getByTestId("ctl-diff").first()).toBeVisible();
    await expect(own.getByTestId("ctl-diff").filter({ hasText: "ADD --checksum=sha256:" })).toHaveCount(1);
    expect(seen).toBeGreaterThan(5);

    // A name that already exists is refused in words by the review; nothing changed on disk.
    fs.appendFileSync(path.join(fixture.dir, ".jgates", "tools.yml"), "  tool-linux-amd64:\n    adapter: generic-command\n    command: true\n    capabilities: [lint]\n    config:\n      evidence:\n        kind: exit-code\n");
    await own.getByRole("button", { name: "Voltar" }).click();
    await own.getByRole("button", { name: "Próximo" }).click();
    await expect(own.getByTestId("ctl-error")).toContainText("Já existe uma ferramenta chamada tool-linux-amd64");
    await expect(own.getByTestId("ctl-save")).toBeDisabled();
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
});

test("declaring a component in a language JGates has no checks for offers the own-tool flow with the component preselected", async ({ page }) => {
  const { fixture } = build();
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    server = await startServer(fixture);
    const base = await openApp(page, server);
    await page.goto(`${base}#/workspace`);
    await page.getByRole("button", { name: "Declarar componente" }).click();
    const dialog = page.getByRole("dialog", { name: "Declarar componente" });
    await dialog.getByLabel("Caminho", { exact: true }).selectOption({ label: "Outro..." });
    await dialog.getByLabel("Outro valor de Caminho").fill("native");
    await dialog.getByLabel("Linguagem", { exact: true }).selectOption({ label: "C++ (sem ferramentas ainda)" }).catch(async () => {
      const options = await dialog.getByLabel("Linguagem", { exact: true }).locator("option").allTextContents();
      const unsupported = options.find((o) => /sem ferramentas/i.test(o));
      expect(unsupported, `an unsupported language is offered: ${options.join(" | ")}`).toBeTruthy();
      await dialog.getByLabel("Linguagem", { exact: true }).selectOption({ label: unsupported as string });
    });
    await dialog.getByRole("button", { name: "Gravar no workspace.yml" }).click();
    const offer = dialog.getByTestId("own-tool-offer");
    await expect(offer).toContainText("O JGates ainda não tem verificações para");
    await offer.getByRole("link", { name: "Adicionar ferramenta própria" }).click();
    const own = page.getByTestId("custom-tool-dialog");
    await expect(own).toBeVisible();
    await own.getByRole("radio", { name: "Instalar no ambiente do JGates" }).check();
    await own.getByLabel("Pacote e versão").fill("cppcheck");
    await own.getByRole("button", { name: "Próximo" }).click();
    await expect(own.getByTestId("ctl-component")).toHaveValue("native");
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
});
