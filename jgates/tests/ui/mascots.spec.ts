import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createFixture, startServer, type Fixture } from "./support";

/** Real server/core/runner; the fixture's explicit Node checks need no optional scanners. */
function checksFixture(): Fixture {
  const f = createFixture();
  fs.mkdirSync(path.join(f.dir, ".jgates", "templates"), { recursive: true });
  fs.writeFileSync(path.join(f.dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools: {}\n");
  const tools: Record<string, unknown> = {};
  for (const [id, delay, exit] of [["first", 100, 1], ["second", 7000, 0]] as const) {
    tools[id] = { adapter: "generic-command", enabled: true, capabilities: ["lint"], command: process.execPath,
      args: ["-e", `setTimeout(()=>process.exit(${exit}),${delay})`], config: {
        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }, evidence: { kind: "exit-code" },
      } };
  }
  fs.writeFileSync(path.join(f.dir, ".jgates", "templates", "mascots.yml"), JSON.stringify({ schemaVersion: 1, id: "mascots", config: { tools } }));
  fs.writeFileSync(path.join(f.dir, "jgates.yml"), JSON.stringify({ schemaVersion: 1, extends: [".jgates/profiles.yml"], selection: { profile: "mascots" }, templates: [{ id: "mascots", source: ".jgates/templates/mascots.yml", activation: "always" }] }));
  fs.writeFileSync(path.join(f.dir, ".jgates", "profiles.yml"), JSON.stringify({ schemaVersion: 1, profiles: { mascots: { checks: { "capability:lint": { enabled: true }, "tool:quality-bridge": { enabled: false } } } } }));
  return f;
}

test("six transparent mascots follow real checks, replay and frozen historical evidence", async ({ page }, testInfo) => {
  const fixture = checksFixture();
  const server = await startServer(fixture);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(server.bootstrapUrl);
    const strip = page.getByTestId("quality-mascots");
    await expect(strip.locator("[data-domain]")).toHaveCount(6);
    await expect(strip.locator('[data-domain="quality"]')).toHaveAttribute("data-selection", "partial");
    await expect(strip.locator("canvas")).toBeVisible();
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>(".quality-mascots-canvas")!.width > 0);
    expect(await strip.locator(".quality-mascot").first().evaluate((el) => ({ background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderWidth, shadow: getComputedStyle(el).boxShadow }))).toEqual({ background: "rgba(0, 0, 0, 0)", border: "0px", shadow: "none" });

    await expect(strip.locator("canvas")).toHaveAttribute("data-statuses", /waiting,disabled,disabled,disabled,incomplete,disabled/);
    await expect(strip.locator("canvas")).toHaveAttribute("data-animating", "false");
    await strip.screenshot({ path: testInfo.outputPath("configuration-desktop.png") });
    await page.evaluate(() => { window.scrollTo(0, 0); });
    await page.screenshot({ path: testInfo.outputPath("configuration-full.png"), fullPage: true });

    // Build and start the same plan the review submits, using the authenticated local session.
    const started = await page.evaluate(async () => {
      const session = await (await fetch("/api/session")).json();
      const headers = { "Content-Type": "application/json", [session.csrfHeader]: session.csrfToken };
      const built = await (await fetch("/api/plans", { method: "POST", headers, body: JSON.stringify({ scope: "full" }) })).json();
      if (!built.approvable) throw new Error(JSON.stringify(built.plan?.blockers ?? built));
      return (await fetch("/api/runs", { method: "POST", headers, body: JSON.stringify({ planHash: built.planHash }) })).json();
    });
    const base = new URL(page.url()).origin + "/";
    await page.goto(`${base}#/runs/${started.run.id}`);
    const quality = strip.locator('[data-domain="quality"]');
    await expect(quality).toHaveAttribute("data-status", "processing");
    await expect(quality).toContainText("Problema encontrado");
    await expect(quality).toContainText("1 de 2");
    const progress = page.getByRole("progressbar", { name: "Andamento por etapa", exact: true });
    await expect(progress).toHaveAttribute("value", "1");
    await expect(progress).toHaveAttribute("max", "2");
    await expect(page.locator(".run-summary-spinner")).toBeVisible();
    await expect(page.getByTestId("run-progress")).toContainText("Etapa 2 de 2");
    await strip.screenshot({ path: testInfo.outputPath("running-findings.png") });
    await page.evaluate(() => { window.scrollTo(0, 0); });
    await page.screenshot({ path: testInfo.outputPath("running-full.png"), fullPage: true });
    await page.reload();
    await expect(quality).toHaveAttribute("data-status", "processing");
    await expect(quality).toContainText("1 de 2");
    await expect(quality).toHaveAttribute("data-status", "failed", { timeout: 30000 });
    await expect(quality).toContainText("2 de 2");
    await expect(progress).toHaveAttribute("value", "2");
    await expect(page.locator(".run-summary-spinner")).toHaveCount(0);
    await expect(strip).toHaveCount(1);
    await expect(page.getByTestId("result-banner")).toBeVisible();
    await strip.getByRole("button", { name: "Ver verificações de Qualidade", exact: true }).click();
    await expect(strip.locator(".quality-mascot-evidence")).toContainText("first");
    await expect(page.getByRole("button", { name: "Limpar filtro de domínio", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Limpar filtro de domínio", exact: true }).click();
    const resultId = await page.locator("dd code").filter({ hasText: /^run_/ }).first().textContent();
    // Change the current configuration; the stored run must continue showing its original checks.
    fs.writeFileSync(path.join(fixture.dir, ".jgates", "profiles.yml"), JSON.stringify({ schemaVersion: 1, profiles: { mascots: { checks: { "capability:lint": { enabled: false } } } } }));
    await page.goto(`${base}#/validations/result/${resultId}`);
    await expect(page.getByRole("heading", { name: "Detalhes da validação", exact: true })).toBeVisible();
    await expect(quality).toHaveAttribute("data-status", "failed");
    await expect(quality).toContainText("2 de 2");
    await expect(strip.locator("canvas")).toHaveAttribute("data-animating", "false");
    await strip.screenshot({ path: testInfo.outputPath("result-historical.png") });
    expect(errors).toEqual([]);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  } finally { await server.stop(); fixture.cleanup(); }
});

test("responsive labels and reduced motion survive unavailable WebGL", async ({ page }) => {
  const fixture = checksFixture(); const server = await startServer(fixture);
  try {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type: string, ...args: any[]) {
        if (type.includes("webgl")) return null;
        return (original as any).call(this, type, ...args);
      } as any;
    });
    await page.goto(server.bootstrapUrl);
    const strip = page.getByTestId("quality-mascots");
    await expect(strip.locator("[data-domain]")).toHaveCount(6);
    await expect(strip).toContainText("Animação indisponível");
    await expect(strip.getByRole("button", { name: "Tentar animação novamente" })).toBeVisible();
    expect(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  } finally { await server.stop(); fixture.cleanup(); }
});

test("configuration saves refresh selection, and review/cancellation retain the same domain scope", async ({ page }) => {
  const fixture = checksFixture(); const server = await startServer(fixture);
  try {
    await page.goto(server.bootstrapUrl);
    const base = new URL(page.url()).origin + "/";
    const strip = page.getByTestId("quality-mascots");
    const quality = strip.locator('[data-domain="quality"]');
    await page.goto(`${base}#/config`);
    await expect(page.getByTestId("category-quality")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("category-quality").click();
    await expect(quality).toHaveAttribute("data-status", "disabled");
    await page.getByTestId("category-quality").click();
    await expect(quality).toHaveAttribute("data-selection", "partial");
    await page.goto(`${base}#/validations/choose`);
    await expect(strip).toHaveCount(1);
    await page.getByRole("button", { name: "Revisar o plano", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Revisar a validação", exact: true })).toBeVisible();
    await expect(quality).toHaveAttribute("data-selection", "partial");
    // Enabling a whole category also requires its uncovered capabilities. Preserve that
    // blocker, then restore the fixture's intentionally lint-only profile before running.
    await expect(quality).toHaveAttribute("data-status", "blocked");
    await expect(page.getByRole("button", { name: "Executar", exact: true })).toBeDisabled();
    fs.writeFileSync(path.join(fixture.dir, ".jgates", "profiles.yml"), JSON.stringify({ schemaVersion: 1, profiles: { mascots: { checks: { "capability:lint": { enabled: true }, "tool:quality-bridge": { enabled: false } } } } }));
    await page.getByRole("button", { name: "Atualizar plano", exact: true }).click();
    await expect(quality).toHaveAttribute("data-status", "waiting");
    await page.getByRole("button", { name: "Executar", exact: true }).click();
    await expect(quality).toHaveAttribute("data-status", "processing");
    await page.getByRole("button", { name: "Interromper", exact: true }).click();
    await expect(page.getByTestId("run-state")).toHaveAttribute("data-state", "cancelled");
    await expect(quality).not.toHaveAttribute("data-status", "processing");
    await expect(page.getByTestId("result-banner")).toBeVisible();
    await expect(strip).toHaveCount(1);
  } finally { await server.stop(); fixture.cleanup(); }
});

test("reduced motion stops idle frames, resize redraws, and graphics context loss can be retried", async ({ page }, testInfo) => {
  const fixture = checksFixture(); const server = await startServer(fixture);
  try {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await page.goto(server.bootstrapUrl);
    const strip = page.getByTestId("quality-mascots");
    const canvas = strip.locator("canvas");
    await expect(canvas).toHaveAttribute("data-animating", "false");
    const frames = await canvas.getAttribute("data-frames");
    // Measure scheduling across several browser frames, rather than assume static poses stop rendering.
    await page.evaluate(() => new Promise<void>((resolve) => { let count = 0; function tick() { if (++count === 8) resolve(); else requestAnimationFrame(tick); } requestAnimationFrame(tick); }));
    expect(await canvas.getAttribute("data-frames")).toBe(frames);
    await page.setViewportSize({ width: 390, height: 844 });
    await strip.scrollIntoViewIfNeeded();
    await expect.poll(() => canvas.getAttribute("data-frames")).not.toBe(frames);
    await expect(strip.locator('[data-domain="security"]')).toHaveAttribute("data-status", "disabled");
    await strip.screenshot({ path: testInfo.outputPath("configuration-dark-mobile.png") });
    await canvas.evaluate((el) => (el as HTMLCanvasElement).getContext("webgl2")!.getExtension("WEBGL_lose_context")!.loseContext());
    await expect(strip).toContainText("Animação indisponível");
    await strip.getByRole("button", { name: "Tentar animação novamente" }).click();
    await expect(canvas).toHaveAttribute("data-animating", "false");
    await expect(strip).not.toContainText("Animação indisponível");
    await expect(strip.locator('[data-domain="security"]')).toHaveAttribute("data-status", "disabled");
  } finally { await server.stop(); fixture.cleanup(); }
});

test("navigation releases graphics contexts and the English preference localizes all domain labels", async ({ page }) => {
  const fixture = checksFixture(); const server = await startServer(fixture);
  try {
    await page.addInitScript(() => {
      const contexts = new WeakSet<object>();
      // `graphics` counts every WebGL context of the page (the Doctor of the prerequisites bar has its own); `strip`
      // counts those of the quality mascots' canvas only.
      (window as any).graphics = { created: 0, lost: 0 };
      (window as any).strip = { created: 0, lost: 0 };
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type: string, ...args: any[]) {
        const context = (original as any).call(this, type, ...args);
        if (type.includes("webgl") && context && !contexts.has(context)) {
          contexts.add(context);
          const counters = [(window as any).graphics, ...(this.classList.contains("quality-mascots-canvas") ? [(window as any).strip] : [])];
          for (const c of counters) c.created++;
          this.addEventListener("webglcontextlost", () => { for (const c of counters) c.lost++; }, { once: true });
        }
        return context;
      } as any;
    });
    await page.goto(server.bootstrapUrl);
    await expect(page.getByTestId("quality-mascots").locator("canvas")).toHaveAttribute("data-statuses", /disabled/);
    await page.evaluate(async () => {
      const session = await (await fetch("/api/session")).json();
      const saved = await fetch("/api/preferences", { method: "PUT", headers: { "Content-Type": "application/json", [session.csrfHeader]: session.csrfToken }, body: JSON.stringify({ language: "en" }) });
      if (!saved.ok) throw new Error("Preference save failed");
    });
    await page.reload();
    const strip = page.getByTestId("quality-mascots");
    await expect(strip).toHaveAttribute("aria-label", "Current Quality Gate configuration");
    await expect(strip.locator("strong")).toHaveText(["Quality", "Security", "Dependencies", "Tests", "Architecture", "Infrastructure"]);
    for (const route of ["config", "overview", "validations/choose", "overview"]) {
      await page.evaluate((route) => { window.location.hash = `#/${route}`; }, route);
      await expect(strip.locator("canvas")).toHaveAttribute("data-statuses", /disabled/);
      await expect.poll(() => page.evaluate(() => (window as any).strip.created - (window as any).strip.lost)).toBe(1);
    }
    // One gallery for the whole navigation: the mascots were built once, not once per screen.
    expect(await page.evaluate(() => (window as any).strip.created)).toBe(1);
    await page.evaluate(() => { window.location.hash = "#/help"; });
    await expect(strip).toHaveCount(0);
    // With no strip on screen the shared gallery is released after its grace period, and the Doctor's context too.
    await expect.poll(() => page.evaluate(() => (window as any).strip.created - (window as any).strip.lost), { timeout: 30_000 }).toBe(0);
    await expect.poll(() => page.evaluate(() => (window as any).graphics.created - (window as any).graphics.lost), { timeout: 30_000 }).toBe(0);
  } finally { await server.stop(); fixture.cleanup(); }
});
