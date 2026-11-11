import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectNoKnownSetAsText } from "./free-text";
import { REPO, createFixture, openApp, startServer, type Fixture } from "./support";

// Preferências > Armazenamento on the fake container engine (never the real one): sizes by category, "Limpar" and
// "Remover tudo do JGates…" show the exact list and sizes first, Esc cancels and gives the focus back to the button that
// opened the dialog, the uninstall needs the typed word, and only labelled objects are ever removed. Desktop and 375 px.

const FAKE = path.join(REPO, "jgates", "tests", "docker", "fake-docker.cjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version as string;
const sha = (c: string) => "sha256:" + c.repeat(64);
const managed = (kind: string, extra: Record<string, string> = {}) => ({ "org.jgates.managed": "true", "org.jgates.kind": kind, "org.jgates.version": VERSION, ...extra });

function storageFixture(): { fixture: Fixture; engine: string } {
  const fixture = createFixture();
  const engine = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ui-engine-"));
  fs.writeFileSync(
    path.join(engine, "objects.json"),
    JSON.stringify({
      images: [
        { id: sha("a"), name: "jgates-tools", tag: "dev", labels: managed("step"), sizeBytes: 800e6, sharedBytes: 700e6, built: true },
        { id: sha("b"), name: "jgates-tools", tag: "0.0.1", labels: managed("step", { "org.jgates.version": "0.0.1" }), sizeBytes: 900e6, sharedBytes: 700e6, built: true },
        { id: sha("9"), name: "someone/else", tag: "1", labels: {}, sizeBytes: 100e6, built: true },
      ],
      containers: [],
      networks: [],
      volumes: [
        { name: "jgates-cache", labels: managed("deps"), sizeBytes: 300e6 },
        { name: "jgates-data", labels: managed("data"), sizeBytes: 2000e6 },
        { name: "jgates-toolchains", labels: managed("toolchain"), sizeBytes: 1000e6 },
        { name: "someone-elses-volume", labels: {}, sizeBytes: 500e6 },
      ],
    }),
  );
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(runtime, [`process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};`, `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`, `require(${JSON.stringify(FAKE)});`, ``].join("\n"));
  fixture.env.JGATES_IMAGE_JSON = "";
  fixture.env.JGATES_CONTAINER_RUNTIME = runtime;
  fixture.env.JGATES_TOOLS_IMAGE = "jgates-tools:dev";
  fixture.env.JGATES_NO_CACHE = "1";
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language: "pt-BR" }, null, 2)}\n`, { mode: 0o600 });
  return { fixture, engine };
}

const volumes = (engine: string): string[] => (JSON.parse(fs.readFileSync(path.join(engine, "objects.json"), "utf8")).volumes as Array<{ name: string }>).map((v) => v.name);
const images = (engine: string): string[] => (JSON.parse(fs.readFileSync(path.join(engine, "objects.json"), "utf8")).images as Array<{ name: string; tag: string }>).map((i) => `${i.name}:${i.tag}`);

async function noSidewaysScroll(page: Page, where: string): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(0);
}

for (const width of [1280, 375]) {
  test(`storage lists sizes by category and every removal shows its list first; Esc cancels and returns the focus (${width} px)`, async ({ page }) => {
    const { fixture, engine } = storageFixture();
    const server = await startServer(fixture);
    try {
      await page.setViewportSize({ width, height: 900 });
      await openApp(page, server);
      await page.evaluate(() => (window.location.hash = "#/preferences/storage"));
      await expect(page.getByRole("heading", { level: 1, name: "Armazenamento" })).toBeVisible();
      const table = page.getByTestId("storage-categories");
      await expect(table).toBeVisible();
      await expect(table.locator('tr[data-category="data"]')).toContainText("Dados de segurança");
      await expect(table.locator('tr[data-category="data"]')).toContainText("2 GB");
      await expect(table.locator('tr[data-category="toolchains"]')).toContainText("1 GB");
      await expect(table.locator('tr[data-category="caches"]')).toContainText("300 MB");
      await expect(table.locator('tr[data-category="tools-0.0.1"]')).toContainText("versão anterior");
      if (width === 375) await noSidewaysScroll(page, "storage");

      // "Limpar" on the caches: the list comes first, Esc cancels, nothing was removed, the focus is back.
      const clean = table.locator('tr[data-category="caches"]').getByRole("button", { name: /Limpar/ });
      await clean.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("cleanup-list")).toContainText("jgates-cache");
      await expect(page.getByTestId("cleanup-list")).not.toContainText("someone-elses-volume");
      await expect(page.getByTestId("cleanup-summary")).toContainText("1 item será removido");
      if (width === 375) await noSidewaysScroll(page, "storage dialog");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(clean).toBeFocused();
      expect(volumes(engine)).toContain("jgates-cache");

      // Confirming removes the listed volume only.
      await clean.click();
      await expect(page.getByTestId("cleanup-list")).toContainText("jgates-cache");
      await page.getByTestId("cleanup-confirm").click();
      await expect(page.getByTestId("cleanup-result")).toContainText("1 item removido");
      expect(volumes(engine)).not.toContain("jgates-cache");
      expect(volumes(engine)).toEqual(expect.arrayContaining(["jgates-data", "jgates-toolchains", "someone-elses-volume"]));
      await page.getByRole("dialog").getByRole("button", { name: "Fechar" }).last().click();
      await expect(table.locator('tr[data-category="caches"]')).toContainText("0 B");
    } finally {
      await server.stop();
      fixture.cleanup();
      fs.rmSync(engine, { recursive: true, force: true });
    }
  });

  test(`"Remover tudo do JGates…" lists everything and needs the typed word, and leaves unlabelled objects alone (${width} px)`, async ({ page }) => {
    const { fixture, engine } = storageFixture();
    const server = await startServer(fixture);
    try {
      await page.setViewportSize({ width, height: 900 });
      await openApp(page, server);
      await page.evaluate(() => (window.location.hash = "#/preferences/storage"));
      const open = page.getByTestId("uninstall-open");
      await open.click();
      const dialog = page.getByRole("dialog");
      await expect(page.getByTestId("cleanup-list")).toContainText("jgates-data");
      await expect(page.getByTestId("cleanup-list")).toContainText("jgates-toolchains");
      await expect(page.getByTestId("cleanup-list")).not.toContainText("someone");
      await expectNoKnownSetAsText(page, "dialog", "uninstall dialog");
      if (width === 375) await noSidewaysScroll(page, "uninstall dialog");

      // Esc cancels and returns the focus.
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(open).toBeFocused();

      await open.click();
      const confirm = page.getByTestId("cleanup-confirm");
      await expect(confirm).toBeDisabled();
      await page.getByTestId("uninstall-word").fill("remover");
      await expect(confirm).toBeDisabled();
      expect(volumes(engine)).toContain("jgates-data");
      await page.getByTestId("uninstall-word").fill("desinstalar");
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(page.getByTestId("cleanup-result")).toContainText("removidos");
      expect(volumes(engine)).toEqual(["someone-elses-volume"]);
      expect(images(engine)).toEqual(["someone/else:1"]);
    } finally {
      await server.stop();
      fixture.cleanup();
      fs.rmSync(engine, { recursive: true, force: true });
    }
  });
}
