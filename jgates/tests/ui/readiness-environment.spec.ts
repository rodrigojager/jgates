import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { REPO, createFixture, openApp, simulateHostDisk, startServer, type Fixture } from "./support";

// The overview's readiness line and the Ambiente sections, on the fake container engine: each section shows its state and
// its one primary action in the ready, missing and stale variants, and the overview's first "próximo passo" is the action of
// the first pill that is not ready. Walked with the keyboard only (Tab to reach a control, Enter to use it), at desktop
// width and at 375 px, where nothing may scroll sideways.

const FAKE = path.join(REPO, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version as string;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ab".repeat(32)}`;
const DAY = 86_400_000;

type Variant = "ready" | "missing" | "stale" | "stopped";

interface Built {
  fixture: Fixture;
  engine: string;
}

/** A configured project served with the fake engine (not in-image); the variant decides what the engine holds. */
function build(variant: Variant): Built {
  const fixture = createFixture();
  const engine = fs.mkdtempSync(path.join(fixture.home, "engine-"));
  const runtime = path.join(engine, "docker.cjs");
  const imageThere = variant !== "missing";
  fs.writeFileSync(
    runtime,
    [
      `const fs = require("node:fs");`,
      `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};`,
      `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`,
      `const present = ${imageThere} || fs.existsSync(${JSON.stringify(path.join(engine, "pull-attempts"))});`,
      `process.env.FAKE_DOCKER_LABELS = present ? ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))} : "none";`,
      // The engine of the "stopped" variant starts when the person "opens Docker": the file appears.
      `if (${variant === "stopped"} && !fs.existsSync(${JSON.stringify(path.join(engine, "started"))})) process.env.FAKE_DOCKER_DAEMON = "stopped";`,
      `require(${JSON.stringify(FAKE)});`,
      ``,
    ].join("\n"),
  );
  fixture.env.JGATES_IMAGE_JSON = "";
  fixture.env.JGATES_CONTAINER_RUNTIME = runtime;
  fixture.env.JGATES_TOOLS_IMAGE = PINNED;
  fixture.env.JGATES_NO_CACHE = "1";
  simulateHostDisk(fixture);
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language: "pt-BR" }, null, 2)}\n`, { mode: 0o600 });
  // The advisory data: fresh for the ready variant, three weeks old for the stale one, none otherwise.
  if (variant === "ready" || variant === "stale") {
    const fetchedAt = new Date(Date.now() - (variant === "ready" ? 1 : 21) * DAY).toISOString();
    fs.writeFileSync(path.join(engine, "objects.json"), JSON.stringify({ containers: [], volumes: [{ name: "jgates-data", labels: {} }], networks: [], images: [] }));
    const volume = path.join(engine, "volumes", "jgates-data");
    fs.mkdirSync(volume, { recursive: true });
    const databases = Object.fromEntries(["trivy", "osv", "govulndb", "rustsec"].map((id) => [id, { fetchedAt, source: `fake://${id}` }]));
    fs.writeFileSync(path.join(volume, "jgates-data.json"), JSON.stringify({ schemaVersion: 1, databases }));
  }
  return { fixture, engine };
}

/** Presses Tab until the control has the focus (the keyboard path reaches it), never clicking. */
async function tabTo(page: Page, target: Locator, max = 300): Promise<void> {
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

async function noSidewaysScroll(page: Page, where: string): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(0);
}

const section = (page: Page, id: string): Locator => page.locator(`[data-section="${id}"]`);
const action = (page: Page, id: string): Locator => page.getByTestId(`env-action-${id}`);

interface Expected {
  engine: string;
  image: string;
  data: string;
  /** The pill of the overview that comes first among the not-ready ones, with the visible text of its action. */
  first: { id: string; action: string } | null;
}

const EXPECTED: Record<Variant, Expected> = {
  // Everything but the dependencies (nothing was prepared for this project yet).
  ready: { engine: "ready", image: "ready", data: "fresh", first: { id: "dependencies", action: "Preparar as dependências" } },
  missing: { engine: "ready", image: "missing", data: "missing", first: { id: "image", action: "Baixar as ferramentas" } },
  stale: { engine: "ready", image: "ready", data: "stale", first: { id: "data", action: "Atualizar os dados de segurança" } },
  stopped: { engine: "stopped", image: "unknown", data: "missing", first: { id: "engine", action: "Ver o Docker" } },
};

for (const width of [1280, 375]) {
  for (const variant of ["ready", "missing", "stale", "stopped"] as const) {
    test(`${variant}: the readiness line, the first step and the Ambiente sections (${width} px, keyboard only)`, async ({ page }) => {
      const { fixture, engine } = build(variant);
      let server: Awaited<ReturnType<typeof startServer>> | null = null;
      const expected = EXPECTED[variant];
      try {
        await page.setViewportSize({ width, height: 900 });
        server = await startServer(fixture);
        const base = await openApp(page, server);
        await page.goto(`${base}#/overview`);

        // The overview: one pill per element, and the first next step is the first pill that is not ready.
        const readiness = page.getByTestId("readiness");
        await expect(readiness).toBeVisible();
        for (const id of ["engine", "image", "data", "dependencies"]) await expect(readiness.locator(`[data-readiness="${id}"]`)).toHaveCount(1);
        await expect(readiness.locator('[data-readiness="services"]')).toHaveCount(0);
        const first = page.getByTestId("next-steps").locator("li").first();
        if (expected.first) {
          await expect(first).toHaveAttribute("data-step", "readiness");
          await expect(first).toHaveAttribute("data-readiness", expected.first.id);
          await expect(readiness.locator(`[data-readiness="${expected.first.id}"]`)).toHaveAttribute("data-ready", "false");
          await expect(first.getByTestId("readiness-action")).toHaveText(expected.first.action);
        }
        if (width === 375) await noSidewaysScroll(page, "overview");

        // The action of that first step leads to its section of Ambiente.
        await press(page, first.getByTestId("readiness-action"));
        await expect(page.getByRole("heading", { name: "Ambiente", level: 1 })).toBeVisible();
        await expect(page.locator(`#env-h-${expected.first?.id}`)).toBeFocused();
        if (width === 375) await noSidewaysScroll(page, "ambiente");

        // Every section: its state and its one primary action.
        for (const id of ["engine", "image", "data", "dependencies", "extension", "services", "codeql"]) await expect(section(page, id)).toHaveCount(1);
        await expect(section(page, "engine")).toHaveAttribute("data-state", expected.engine);
        await expect(section(page, "image")).toHaveAttribute("data-state", expected.image);
        await expect(section(page, "data")).toHaveAttribute("data-state", expected.data);
        await expect(section(page, "extension")).toHaveAttribute("data-state", "none");
        await expect(section(page, "services")).toHaveAttribute("data-state", "none");
        await expect(action(page, "extension").getByRole("link", { name: "Adicionar ferramenta própria" })).toBeVisible();
        await expect(action(page, "services").getByRole("link", { name: "Configurar serviços" })).toBeVisible();
        // CodeQL: the terms link and an explicit acceptance come before the button works.
        await expect(action(page, "codeql").getByRole("link", { name: "Ler os termos do CodeQL no GitHub" })).toBeVisible();
        const accept = action(page, "codeql").getByRole("checkbox", { name: /aceito os termos/ });
        await expect(accept).not.toBeChecked();
        await expect(action(page, "codeql").getByRole("button", { name: "Preparar o CodeQL" })).toBeDisabled();
        // No per-tool "Preparar" any more: tools come with the image.
        await expect(page.getByRole("button", { name: /^Preparar (semgrep|ruff|eslint)/ })).toHaveCount(0);

        if (variant === "ready") {
          await expect(action(page, "engine").getByRole("button", { name: "Verificar de novo" })).toBeVisible();
          await expect(action(page, "image").getByRole("button", { name: "Verificar integridade" })).toBeVisible();
          await expect(action(page, "data").getByRole("button", { name: "Atualizar agora" })).toBeVisible();
          // The image's tools can be searched.
          await section(page, "image").getByText("Detalhes").click();
          await page.getByLabel("Buscar ferramenta").fill("ruff");
          await expect(page.getByLabel("Ferramentas da imagem").locator("li")).not.toHaveCount(0);
          // Dependências: "Preparar" runs the job and the section turns ready.
          await expect(section(page, "dependencies")).toHaveAttribute("data-state", "not-ready");
          await press(page, action(page, "dependencies").getByRole("button", { name: "Preparar" }));
          await expect(section(page, "dependencies")).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
          // The overview no longer has a readiness step.
          await page.goto(`${base}#/overview`);
          await expect(page.getByTestId("readiness").locator("[data-ready='false']")).toHaveCount(0);
          await expect(page.getByTestId("next-steps").locator("li").first()).not.toHaveAttribute("data-step", "readiness");
        }

        if (variant === "missing") {
          await expect(action(page, "image").getByRole("button", { name: "Baixar" })).toBeEnabled();
          await expect(action(page, "data").getByRole("button", { name: "Atualizar agora" })).toBeDisabled();
          await expect(action(page, "dependencies").getByRole("button", { name: "Preparar" })).toBeDisabled();
          await press(page, action(page, "image").getByRole("button", { name: "Baixar" }));
          await expect(section(page, "image")).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
          expect(fs.existsSync(path.join(engine, "pull-attempts"))).toBe(true);
          await expect(action(page, "image").getByRole("button", { name: "Verificar integridade" })).toBeVisible();
        }

        if (variant === "stale") {
          await expect(section(page, "data")).toContainText("21 dias");
          await press(page, action(page, "data").getByRole("button", { name: "Atualizar agora" }));
          await expect(section(page, "data")).toHaveAttribute("data-state", "fresh", { timeout: 120_000 });
        }

        if (variant === "stopped") {
          // The sentence of the catalogue and the commands to copy; the engine starts, the person checks again.
          await expect(section(page, "engine")).toContainText("parado");
          await expect(action(page, "engine").getByTestId("recipe")).toBeVisible();
          await expect(action(page, "image").getByRole("button", { name: "Baixar" }).or(action(page, "image").getByRole("button", { name: "Verificar integridade" }))).toBeVisible();
          fs.writeFileSync(path.join(engine, "started"), "1");
          await press(page, action(page, "engine").getByRole("button", { name: "Verificar de novo" }));
          await expect(section(page, "engine")).toHaveAttribute("data-state", "ready");
        }
        if (width === 375) await noSidewaysScroll(page, "ambiente after the action");
      } finally {
        await server?.stop();
        fixture.cleanup();
      }
    });
  }
}
