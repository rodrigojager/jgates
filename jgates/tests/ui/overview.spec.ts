import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAIN, createFixture, startServer, type Fixture } from "./support";

// The Overview shows real data: counts of the discovery, the profile of jgates.yml, the last run with one
// segment per stage, the pending steps and the categories of the resolved profile.

function jgates(fixture: Fixture, ...args: string[]) {
  return spawnSync(process.execPath, [MAIN, ...args, "--cwd", fixture.dir, "--json"], { env: fixture.env, encoding: "utf8", timeout: 170_000 });
}

function lastResult(fixture: Fixture): any {
  const workspaces = path.join(fixture.home, "workspaces");
  const files: Array<{ file: string; mtime: number }> = [];
  for (const w of fs.readdirSync(workspaces)) {
    const runs = path.join(workspaces, w, "runs");
    if (!fs.existsSync(runs)) continue;
    for (const r of fs.readdirSync(runs)) {
      const file = path.join(runs, r, "result.json");
      if (fs.existsSync(file)) files.push({ file, mtime: fs.statSync(file).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return JSON.parse(fs.readFileSync(files[0]!.file, "utf8"));
}

async function open(page: Page, fixture: Fixture, body: () => Promise<void>) {
  const server = await startServer(fixture);
  try {
    await page.goto(server.bootstrapUrl);
    await expect(page.getByRole("heading", { name: "Seu código, sob controle.", level: 1 })).toBeVisible();
    await body();
  } finally {
    await server.stop();
    fixture.cleanup();
  }
}

test("after a run the Overview shows real counts, the profile and one segment per stage, blocked with text", async ({ page }) => {
  const fixture = createFixture();
  const run = jgates(fixture, "run");
  expect([0, 1, 2]).toContain(run.status);
  const result = lastResult(fixture);
  const stages = (result.stages as any[]).filter((s) => s.kind !== "composite");
  const discovery = JSON.parse(jgates(fixture, "discover").stdout);
  const inventory = discovery.inventory ?? discovery;
  await open(page, fixture, async () => {
    const approvable = (inventory.classifications as any[]).filter((c) => c.approvable).length;
    await expect(page.getByTestId("count-components")).toContainText(String(approvable));
    await expect(page.getByTestId("count-languages")).toContainText(String((inventory.languages as string[]).length));
    await expect(page.getByTestId("strip")).toContainText("python");
    await expect(page.getByTestId("profile")).toHaveText("Essencial");

    const segments = page.getByTestId("stage-segments").locator("li");
    await expect(segments).toHaveCount(stages.length);
    for (const s of stages) await expect(page.locator(`[data-testid="stage-segments"] li[data-stage="${s.id}"]`)).toHaveAttribute("data-state", s.state);

    // A blocked stage carries its state as text in the segment itself, not only a color.
    const blocked = stages.find((s) => s.state === "blocked");
    expect(blocked).toBeTruthy();
    await expect(page.locator(`li[data-stage="${blocked.id}"]`)).toContainText("Bloqueada");
    await expect(page.getByTestId("last-run")).toContainText(result.decision === "failed" ? "Reprovado" : "Incompleto");
    await expect(page.getByRole("link", { name: "Ver resultado" })).toHaveAttribute("href", `#/runs/${result.runId}`);
    await expect(page.getByTestId("new-run")).toHaveAttribute("href", "#/validations");

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  });
});

test("an ambiguous component shows the workspace step as pending with the reason", async ({ page }) => {
  const fixture = createFixture();
  fs.mkdirSync(path.join(fixture.dir, "web"));
  fs.writeFileSync(path.join(fixture.dir, "web", "package.json"), '{"name":"web","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(fixture.dir, "web", "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(fixture.dir, "web", "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  await open(page, fixture, async () => {
    const step1 = page.locator('[data-step="01"]');
    await expect(step1).toHaveAttribute("data-pending", "true");
    await expect(step1).toContainText("ambíguo");
    await expect(step1).toContainText("web");
    await expect(step1).toContainText("Pendente");
    await expect(page.locator('[data-step="03"]')).toHaveAttribute("data-pending", "true");
  });
});

test("a category included in the profile without an executable tool is a gap, not Incluído", async ({ page }) => {
  const fixture = createFixture();
  const file = path.join(fixture.dir, ".jgates", "profiles.yml");
  const text = fs.readFileSync(file, "utf8");
  // The profile asks for license checks; no tool of the plan can run them.
  fs.writeFileSync(file, text.replace("    checks:\n      capability:file-size:", "    checks:\n      capability:licenses:\n        enabled: true\n      capability:file-size:"));
  await open(page, fixture, async () => {
    const deps = page.locator('[data-category="dependencies"]');
    await expect(deps).toHaveAttribute("data-state", "gap");
    await expect(deps).toContainText("Lacuna");
    await expect(deps).not.toContainText("Incluído");
    await expect(page.locator('[data-category="quality"]')).toContainText("Incluído");
    await expect(page.getByTestId("uncovered")).toContainText("capability:licenses");
    await expect(page.locator('[data-step="02"]')).toHaveAttribute("data-pending", "true");
  });
});
