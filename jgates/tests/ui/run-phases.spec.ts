import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { REPO, createFixture, openApp, openGroups, pageGet, simulateHostDisk, startServer, type Fixture } from "./support";

// The preparation phases in the interface, on the fake container engine: the review's "Preparação" group with the network
// of each step and the single TOOL_MISSING blocker with its download; the run screen's five phases, each with its log
// block; the result's provenance. Walked with the keyboard only, at desktop width and at 375 px.

const FAKE = path.join(REPO, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version as string;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ab".repeat(32)}`;

/** A configured project with the fake engine; `imageThere: false` leaves the tools image to be downloaded. */
function build(imageThere: boolean): { fixture: Fixture; engine: string } {
  const fixture = createFixture();
  const engine = fs.mkdtempSync(path.join(fixture.home, "engine-"));
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    [
      `const fs = require("node:fs");`,
      `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};`,
      `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`,
      `const present = ${imageThere} || fs.existsSync(${JSON.stringify(path.join(engine, "pull-attempts"))});`,
      `process.env.FAKE_DOCKER_LABELS = present ? ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))} : "none";`,
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
  return { fixture, engine };
}

async function tabTo(page: Page, target: Locator, max = 400): Promise<void> {
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

for (const width of [1280, 375]) {
  test(`the review blocks on the missing tools with one download, then shows the preparation (${width} px, keyboard only)`, async ({ page }) => {
    const { fixture } = build(false);
    let server: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      await page.setViewportSize({ width, height: 900 });
      server = await startServer(fixture);
      const base = await openApp(page, server);
      await page.goto(`${base}#/validations/review`);

      // One shared blocker, whatever the number of checks, with the download right in it.
      const blocker = page.getByTestId("blockers").locator("li");
      await expect(blocker).toHaveCount(1);
      await expect(blocker).toHaveAttribute("data-blocker", /^(IMAGE_MISSING|TOOL_MISSING)$/);
      await expect(blocker).toContainText("Faltam as ferramentas do JGates");
      if (width === 375) await noSidewaysScroll(page, "review with the blocker");
      await press(page, blocker.getByRole("button", { name: "Baixar as ferramentas do JGates" }));
      // The plan is built again when the download ends: no blocker, and the Preparação group is there.
      await expect(page.getByTestId("blockers")).toHaveCount(0, { timeout: 120_000 });
      await expectPreparation(page, width);
    } finally {
      await server?.stop();
      fixture.cleanup();
    }
  });
}

/** The Preparação group: the sync step with no network, and the network said for each step of the plan. */
async function expectPreparation(page: Page, width: number): Promise<void> {
  const group = page.getByTestId("preparation");
  await expect(group).toBeVisible();
  const sync = group.locator('[data-prep="sync"]');
  await expect(sync).toHaveAttribute("data-network", "none");
  await expect(sync.getByTestId("prep-network")).toHaveText("sem rede (garantido)");
  // Every check says its network too.
  const items = page.getByTestId("plan-item");
  await openGroups(page);
  await expect(items.first()).toBeVisible();
  const count = await items.count();
  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const kind = await item.getAttribute("data-network");
    await expect(item).toContainText(kind === "bridge" ? "com rede:" : "sem rede (garantido)");
  }
  if (width === 375) await noSidewaysScroll(page, "review with the preparation");
}

for (const width of [1280, 375]) {
  test(`the run shows its five phases with a log block each, and the result shows what it used (${width} px, keyboard only)`, async ({ page }) => {
    const { fixture } = build(true);
    let server: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      await page.setViewportSize({ width, height: 900 });
      server = await startServer(fixture);
      const base = await openApp(page, server);
      await page.goto(`${base}#/validations/review`);
      await expectPreparation(page, width);

      await press(page, page.getByRole("button", { name: "Executar", exact: true }));
      await expect.poll(() => new URL(page.url()).hash).toMatch(/^#\/runs\/job_[0-9a-f]{16}$/);

      // The five phases, in order, each with its own log block.
      const phases = page.getByTestId("run-phases");
      await expect(phases).toBeVisible();
      const order = ["sync", "deps", "services", "checks", "services-down"];
      await expect(phases.locator("li[data-phase]")).toHaveCount(5);
      for (let i = 0; i < order.length; i++) {
        const item = phases.locator("li[data-phase]").nth(i);
        await expect(item).toHaveAttribute("data-phase", order[i] as string);
        await expect(item.getByTestId("phase-log")).toHaveCount(1);
      }
      if (width === 375) await noSidewaysScroll(page, "run phases");

      // The run ends; the sync phase succeeded and its log (the files it copied) opens with the keyboard.
      await expect(page.getByTestId("run-state")).not.toHaveAttribute("data-state", "running", { timeout: 150_000 });
      await expect(phases.locator('li[data-phase="sync"]')).toHaveAttribute("data-state", "succeeded");
      const syncLog = phases.locator('li[data-phase="sync"]').getByTestId("phase-log");
      await press(page, syncLog.locator("summary"));
      await expect(syncLog.locator('[data-log-file="sync.log"]')).toBeVisible();
      await expect(syncLog.locator("pre")).not.toHaveText("");
      if (width === 375) await noSidewaysScroll(page, "run phases with the sync log");

      // The result: what the run used besides the project.
      const provenance = page.getByTestId("provenance");
      await expect(provenance).toBeVisible();
      const job = new URL(page.url()).hash.slice("#/runs/".length);
      const runId = (await pageGet(page, `/api/runs/${job}/progress?cursor=0`)).runId as string;
      expect(runId).toMatch(/^run_/);
      const result = (await pageGet(page, `/api/results/${runId}`)).result;
      const container = result?.provenance?.container;
      expect(container, "the result records the container inputs").toBeTruthy();
      await expect(provenance.getByTestId("prov-version")).toHaveText(String(result.provenance.producerVersion));
      if (container.toolsImage) await expect(provenance.getByTestId("prov-image")).toContainText(String(container.toolsImage).replace("sha256:", "").slice(0, 12));
      await expect(provenance.getByTestId("prov-data")).toBeVisible();
      await expect(provenance.getByTestId("prov-dependencies")).toBeVisible();
      await expect(provenance.getByTestId("prov-services")).toBeVisible();
      if (width === 375) await noSidewaysScroll(page, "result provenance");
    } finally {
      await server?.stop();
      fixture.cleanup();
    }
  });
}
