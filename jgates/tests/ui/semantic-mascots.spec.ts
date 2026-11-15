import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createFixture, openApp, startServer, type Fixture, type UiServer } from "./support";

// The six animated 3D Semantic mascots (one per phase) on the Semantic run and result screens, laid out like the Quality strip:
// no proper names, each says what it does, its status is the shared icon-and-text status, no cards.
// The run is a fake one: the Semantic run routes are answered in the browser with a run covering the six phases, so each
// mascot can be shown in each of the six states. Each mascot is its own painted canvas, drawn from one shared WebGL
// context: a working mascot keeps moving, a mascot that changes state plays a reaction and then stays still, and nothing
// repaints once nothing moves (never under reduced motion); with WebGL disabled each one is its pre-rendered image; label
// and status are the same either way, in pt-BR and en; old role ids of stored runs still render; no console error.
// JGATES_SEMANTIC_MASCOT_SHOTS names a folder for the review screenshots (1280 and 375 px, light and dark).

const RUN = "sem_20261112T120000Z_5e3a7c01";
const IDS = ["atlas", "trace", "verdict", "fit", "seal", "folio"] as const;
const STATES = ["waiting", "working", "done", "incomplete", "failed", "cancelled"] as const;
const STAGES: Record<(typeof IDS)[number], string> = {
  atlas: "security-audit/reconnaissance",
  trace: "security-audit/hunting",
  verdict: "security-audit/refutation",
  fit: "security-audit/structured-output",
  seal: "security-audit/verification",
  folio: "security-audit/reporting",
};
const TEXT = {
  "pt-BR": {
    roles: { atlas: "Reconhecimento", trace: "Caça guiada pela cobertura", verdict: "Validação dos candidatos", fit: "Saída estruturada", seal: "Verificação independente", folio: "Relatório neutro quanto ao alvo" },
    states: { waiting: "Aguardando a vez", working: "Trabalhando", done: "Concluído", incomplete: "Incompleto", failed: "Falhou", cancelled: "Cancelado" },
  },
  en: {
    roles: { atlas: "Reconnaissance", trace: "Coverage-led hunting", verdict: "Candidate validation", fit: "Structured output", seal: "Independent verification", folio: "Target-neutral reporting" },
    states: { waiting: "Waiting for its turn", working: "Working", done: "Done", incomplete: "Incomplete", failed: "Failed", cancelled: "Cancelled" },
  },
} as const;

// The status tone of each state: the same colours and icon behaviour as Quality's status.
const TONES: Record<(typeof STATES)[number], string> = { waiting: "alert", working: "busy", done: "passed", incomplete: "neutral", failed: "failed", cancelled: "neutral" };

type Snapshot = { schemaVersion: 1; runId: string; running: boolean; cancelled: boolean; mascots: Array<{ mascot: string; state: string; stages: Array<{ id: string; state: string }>; progress: { completed: number; total: number } | null }> };

/** Mascot i in state (i + shift) mod 6: six shifts show every mascot in every state. */
function rotated(shift: number, ids: readonly string[] = IDS): Snapshot {
  return {
    schemaVersion: 1,
    runId: RUN,
    running: true,
    cancelled: false,
    mascots: ids.map((mascot, i) => {
      const state = STATES[(i + shift) % STATES.length] as string;
      const phase = STAGES[(IDS[i] ?? "atlas") as (typeof IDS)[number]];
      return { mascot, state, stages: [{ id: phase, state }], progress: { completed: state === "done" ? 1 : 0, total: 1 } };
    }),
  };
}

function report(lifecycle: string) {
  return {
    runId: RUN, lifecycle, decision: lifecycle === "running" ? null : "passed", complete: lifecycle !== "running", partial: false, reviewState: "completed",
    reason: null, summary: null, rigor: "standard", methods: ["security-audit"], provider: "mock", model: "mock-1", mode: "full",
    units: { examinedNow: ["src/core/a.js"], reused: [], unresolved: [], outOfScope: [], withFindings: [] },
    scope: { subjects: 1, toExamine: 1, covered: 1, repositoryFiles: 2, claim: null, completion: 1, repositoryCoverage: 0.5, inheritedCoverage: null },
    investigation: null, findings: [], confirmation: { confirmed: 0, "needs-validation": 0, rejected: 0 }, severity: {},
    usage: { calls: 6, durationMs: 1200, cost: null, tokens: null, budget: null },
  };
}

interface FakeRun {
  lifecycle: "running" | "settled";
  snapshot: Snapshot;
}

/** Answers the Semantic run routes of RUN in the browser; everything else goes to the real server. */
async function fakeRun(page: Page, run: FakeRun): Promise<void> {
  await page.route((url) => url.pathname.startsWith(`/api/semantic/runs/${RUN}`), async (route) => {
    const url = new URL(route.request().url());
    const tail = url.pathname.slice(`/api/semantic/runs/${RUN}`.length);
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (tail === "/events") return json({ events: [], cursor: 0, live: false, done: true });
    if (tail === "/mascots") return json({ lifecycle: run.lifecycle, mascots: run.snapshot });
    if (tail === "/report") return json({ report: report(run.lifecycle), mascots: run.snapshot });
    if (tail === "") return json({ run: { runId: RUN, lifecycle: run.lifecycle, decision: run.lifecycle === "running" ? null : "passed", startedAt: "2026-11-12T12:00:00.000Z" } });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "RUN_NOT_FOUND" }) });
  });
}

/** Counts the WebGL contexts of the page by the class of their canvas; with `disable`, the page has no WebGL at all. */
async function watchGraphics(page: Page, disable: boolean): Promise<void> {
  await page.addInitScript((off) => {
    const created: string[] = [];
    (window as unknown as { __glContexts: string[] }).__glContexts = created;
    const original = HTMLCanvasElement.prototype.getContext;
    const seen = new WeakSet<object>();
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type.includes("webgl") && off) return null;
      const context = (original as (...a: unknown[]) => unknown).call(this, type, ...args);
      if (type.includes("webgl") && context && !seen.has(context as object)) { seen.add(context as object); created.push(this.className || "(none)"); }
      return context;
    } as typeof original;
  }, disable);
}

async function preferences(page: Page, base: string, prefs: { language?: "pt-BR" | "en"; theme?: "light" | "dark" }): Promise<void> {
  await page.evaluate(async (body) => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/preferences", { method: "PUT", headers: { "Content-Type": "application/json", [session.csrfHeader]: session.csrfToken }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`preferences: ${response.status}`);
    if (body.language) localStorage.setItem("jgates.language", body.language);
  }, prefs);
  await page.goto(`${base}#/`);
  await page.reload();
}

/** Each mascot: one of the six, what it does, its label and status in the given language and state, its picture (canvas or image). */
async function expectMascots(page: Page, locale: "pt-BR" | "en", states: Record<string, string>, render: "webgl" | "fallback") {
  const strip = page.getByTestId("semantic-mascots");
  await expect(strip.locator("li[data-mascot]")).toHaveCount(6);
  // Like Quality: no card around the strip or around a mascot, and no proper name anywhere.
  expect(await strip.evaluate((el) => el.matches(".card") || el.querySelector(".card") !== null)).toBe(false);
  for (const name of ["Atlas", "Trace", "Verdict", "Fit", "Seal", "Folio"]) await expect(strip).not.toContainText(new RegExp(`\\b${name}\\b`));
  await expect(strip.locator(".sem3d-badge")).toHaveCount(0);
  expect(await strip.locator("li[data-mascot]").evaluateAll((els) => els.map((e) => e.getAttribute("data-mascot")))).toEqual([...IDS]);
  const text = TEXT[locale];
  for (const id of IDS) {
    const state = states[id] as (typeof STATES)[number];
    const item = strip.locator(`li[data-mascot="${id}"]`);
    await expect(item).toHaveAttribute("data-state", state);
    const figure = item.locator(".sem3d");
    await expect(figure).toHaveAttribute("role", "img");
    await expect(figure).toHaveAttribute("aria-label", `${text.roles[id]}: ${text.states[state]}`);
    await expect(figure).toHaveAttribute("data-render", render);
    // The picture is as big as a Quality mascot (190 px high, 180 on a phone).
    expect(Math.round((await figure.boundingBox())!.height)).toBe(page.viewportSize()!.width <= 520 ? 180 : 190);
    const status = item.getByTestId("semantic-mascot-state");
    await expect(status).toHaveText(text.states[state]);
    await expect(status).toHaveClass(/\bmascot-strip-status\b/);
    await expect(status).toHaveAttribute("data-tone", TONES[state]);
    await expect(status.locator(`svg.icon`)).toBeVisible();
    await expect(item.locator("strong")).toHaveText(text.roles[id]);
    if (render === "webgl") {
      await expect(item.locator("canvas.sem3d-model")).toHaveAttribute("data-painted", /^[1-9]/);
      await expect(item.locator("img")).toHaveCount(0);
    } else {
      await expect(item.locator("canvas")).toHaveCount(0);
      await expect.poll(() => item.locator("img.sem3d-model").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    }
  }
}

/** Every mascot picture has drawn pixels, and the six pictures are different. */
async function expectSixDistinctPictures(page: Page, selector: string) {
  const pictures = await page.locator(`[data-testid="semantic-mascots"] ${selector}`).evaluateAll((els) =>
    els.map((el) => {
      const source = el as HTMLCanvasElement | HTMLImageElement;
      const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
      const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
      const copy = document.createElement("canvas");
      copy.width = width; copy.height = height;
      const ctx = copy.getContext("2d")!;
      ctx.drawImage(source, 0, 0);
      const data = ctx.getImageData(0, 0, width, height).data;
      let filled = 0;
      let hash = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 16) { filled++; hash = (hash * 31 + data[i - 3]! + data[i - 2]! * 7 + data[i - 1]! * 13) >>> 0; }
      return { width, height, filled: filled / (width * height), hash };
    }),
  );
  expect(pictures).toHaveLength(6);
  for (const p of pictures) {
    expect(p.width).toBeGreaterThan(50);
    expect(p.filled, "a mascot picture is not empty").toBeGreaterThan(0.08);
  }
  expect(new Set(pictures.map((p) => p.hash)).size, "six distinct mascots").toBe(6);
}

async function withServer(page: Page, body: (ctx: { base: string; fixture: Fixture; errors: string[] }) => Promise<void>) {
  const fixture = createFixture();
  let server: UiServer | null = null;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  try {
    server = await startServer(fixture);
    const base = await openApp(page, server);
    await body({ base, fixture, errors });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

test("run and result screens: six distinct 3D mascots, one WebGL context, painted on demand, label and status for every state in pt-BR and en", async ({ page }) => {
  test.setTimeout(300_000);
  await watchGraphics(page, false);
  const run: FakeRun = { lifecycle: "running", snapshot: rotated(0) };
  await fakeRun(page, run);
  await withServer(page, async ({ base, errors }) => {
    for (const locale of ["pt-BR", "en"] as const) {
      await preferences(page, base, { language: locale });
      run.lifecycle = "running";
      run.snapshot = rotated(0);
      await page.goto(`${base}#/semantic/runs/${RUN}`);
      // The run screen follows the run: every shift puts every mascot in another state, until each was in all six.
      for (let shift = 0; shift < STATES.length; shift++) {
        run.snapshot = rotated(shift);
        await expectMascots(page, locale, Object.fromEntries(run.snapshot.mascots.map((m) => [m.mascot, m.state])), "webgl");
      }
      await expectSixDistinctPictures(page, "canvas.sem3d-model");
      // One shared context for the six.
      expect(await page.evaluate(() => (window as unknown as { __glContexts: string[] }).__glContexts.filter((c) => c === "semantic-mascots-gl").length)).toBe(1);
      const painted = () => page.locator('[data-testid="semantic-mascots"] canvas.sem3d-model').evaluateAll((els) => els.map((e) => e.getAttribute("data-painted")));
      const moving = () => page.locator('[data-testid="semantic-mascots"] li[data-mascot]').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute("data-state"), e.querySelector("canvas")?.getAttribute("data-animating")])));
      // The mascot at work keeps moving; the others played the reaction of the state they entered and are still again.
      await expect.poll(moving, { timeout: 90_000 }).toEqual({ cancelled: "false", waiting: "false", working: "true", done: "false", incomplete: "false", failed: "false" });
      const before = await painted();
      await page.waitForTimeout(1500);
      const after = await painted();
      const states = run.snapshot.mascots.map((m) => m.state);
      states.forEach((state, i) => {
        // Working is redrawn frame after frame, and the waiting one breathes beside it; a settled mascot is not drawn again.
        if (state === "working") expect(Number(after[i]), "the working mascot moves").toBeGreaterThan(Number(before[i]));
        else if (state !== "waiting") expect(after[i], state + " is still").toBe(before[i]);
      });

      // The result screen of the same run, settled.
      run.lifecycle = "settled";
      run.snapshot = { ...rotated(2), running: false };
      await page.goto(`${base}#/semantic/results/${RUN}`);
      await expect(page.getByTestId("semantic-results")).toBeVisible();
      await expectMascots(page, locale, Object.fromEntries(run.snapshot.mascots.map((m) => [m.mascot, m.state])), "webgl");
      await expectSixDistinctPictures(page, "canvas.sem3d-model");
      // A mascot that is first shown appears in its state as it is: no reaction is played and it is not drawn again.
      // (The fake snapshot still has one mascot at work, which moves.)
      expect(await moving()).toEqual({ done: "false", incomplete: "false", failed: "false", cancelled: "false", waiting: "false", working: "true" });
      const shown = await painted();
      await page.waitForTimeout(1000);
      const later = await painted();
      run.snapshot.mascots.forEach((m, i) => { if (m.state !== "working" && m.state !== "waiting") expect(later[i], m.state + " is still").toBe(shown[i]); });

      // A stored run with the four old role ids: each resolves to its phase mascot.
      run.snapshot = { ...rotated(0, ["scout", "tracker", "challenger", "fit", "verifier", "folio"]), running: false };
      await page.reload();
      await expect(page.getByTestId("semantic-results")).toBeVisible();
      await expectMascots(page, locale, Object.fromEntries(rotated(0).mascots.map((m) => [m.mascot, m.state])), "webgl");
    }
    expect(errors).toEqual([]);
  });
});

test("with reduced motion no mascot moves: every state is a still pose, also right after a state change", async ({ page }) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const run: FakeRun = { lifecycle: "running", snapshot: rotated(0) };
  await fakeRun(page, run);
  await withServer(page, async ({ base, errors }) => {
    await preferences(page, base, { language: "pt-BR" });
    await page.goto(base + "#/semantic/runs/" + RUN);
    const canvases = page.locator('[data-testid="semantic-mascots"] canvas.sem3d-model');
    const painted = () => canvases.evaluateAll((els) => els.map((e) => e.getAttribute("data-painted")));
    for (const shift of [0, 1]) {
      run.snapshot = rotated(shift);
      await expectMascots(page, "pt-BR", Object.fromEntries(run.snapshot.mascots.map((m) => [m.mascot, m.state])), "webgl");
      await expect(page.locator('[data-testid="semantic-mascots"] canvas.sem3d-model[data-animating="true"]')).toHaveCount(0);
      await expect.poll(async () => (await canvases.evaluateAll((els) => els.map((e) => e.getAttribute("data-picture")))).map((p) => p?.split(":")[1])).toEqual(run.snapshot.mascots.map((m) => m.state));
      const before = await painted();
      await page.waitForTimeout(1200);
      expect(await painted(), "nothing is drawn again").toEqual(before);
    }
    await expectSixDistinctPictures(page, "canvas.sem3d-model");
    expect(errors).toEqual([]);
  });
});

test("without WebGL each mascot shows its pre-rendered image with the same label and status", async ({ page }) => {
  test.setTimeout(180_000);
  await watchGraphics(page, true);
  const run: FakeRun = { lifecycle: "running", snapshot: rotated(0) };
  await fakeRun(page, run);
  await withServer(page, async ({ base, errors }) => {
    for (const locale of ["pt-BR", "en"] as const) {
      await preferences(page, base, { language: locale });
      run.lifecycle = "running";
      run.snapshot = rotated(0);
      await page.goto(`${base}#/semantic/runs/${RUN}`);
      for (let shift = 0; shift < STATES.length; shift++) {
        run.snapshot = rotated(shift);
        await expectMascots(page, locale, Object.fromEntries(run.snapshot.mascots.map((m) => [m.mascot, m.state])), "fallback");
      }
      await expectSixDistinctPictures(page, "img.sem3d-model");
      run.lifecycle = "settled";
      run.snapshot = { ...rotated(3), running: false };
      await page.goto(`${base}#/semantic/results/${RUN}`);
      await expect(page.getByTestId("semantic-results")).toBeVisible();
      await expectMascots(page, locale, Object.fromEntries(run.snapshot.mascots.map((m) => [m.mascot, m.state])), "fallback");
      await expectSixDistinctPictures(page, "img.sem3d-model");
    }
    expect(await page.evaluate(() => (window as unknown as { __glContexts: string[] }).__glContexts.length)).toBe(0);
    expect(errors).toEqual([]);
  });
});

test("the six mascots at 1280 and 375 px, light and dark, without horizontal scrolling", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const run: FakeRun = { lifecycle: "running", snapshot: rotated(0) };
  await fakeRun(page, run);
  const shots = process.env.JGATES_SEMANTIC_MASCOT_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  await withServer(page, async ({ base, errors }) => {
    for (const theme of ["light", "dark"] as const) {
      await preferences(page, base, { language: "pt-BR", theme });
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${base}#/semantic/runs/${RUN}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expectMascots(page, "pt-BR", Object.fromEntries(run.snapshot.mascots.map((m) => [m.mascot, m.state])), "webgl");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${width} px overflows`).toBeLessThanOrEqual(0);
        // The strip alone on the wide screen; the whole page on the narrow one, where the sticky bar would cover a part.
        const file = `semantic-mascots-${width}-${theme}.png`;
        const target = shots ? path.join(shots, file) : testInfo.outputPath(file);
        if (width === 375) await page.screenshot({ path: target, fullPage: true });
        else await page.getByTestId("semantic-mascots").screenshot({ path: target });
      }
    }
    expect(errors).toEqual([]);
  });
});
