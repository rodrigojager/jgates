import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { MAIN, createFixture, openApp, pageGet, reloadPage, startServer, type Fixture, type UiServer } from "./support";

// The screens of the linter engine (PLAN-engine.md section 9, slice G5): the tools catalogue by section and group with
// "this project" read from the file census, the profile editor with the tier of a tool (off above the profile's tier, with
// the reason, and a switch that turns it on), the review's "will run" list collapsed by area, the run screen with its steps
// by area and the number of checks at the same time, "what is new since your last validation" on the overview and the
// result, the searchable tool filter of the result, and the explanation of the number in Preferences.
//
// The markdown group (markdownlint on Balanced, markdown-table-formatter and rumdl on Strict) is the engine's first group;
// the specs name it, so they hold while other groups join the catalogue.

test.use({ actionTimeout: 30_000 });

const MARKDOWN_TOOLS = ["markdownlint", "markdown-table-formatter", "rumdl"];

function write(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** The Python fixture with Markdown files in it (the census sees them), in the language given. */
function markdownFixture(language: "pt-BR" | "en" = "pt-BR"): Fixture {
  const fixture = createFixture();
  write(fixture.dir, "README.md", "# Demo\n\nSome text.\n");
  write(fixture.dir, "docs/guide.md", "# Guide\n\n| a | b |\n|--|--|\n| 1 | 2 |\n");
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language }, null, 2)}\n`, { mode: 0o600 });
  return fixture;
}

/** The same fixture with no Markdown file at all: its census holds none. */
function plainFixture(): Fixture {
  const fixture = createFixture();
  const drop = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git" && entry.name !== ".jgates") drop(full);
      } else if (/\.md$/i.test(entry.name)) fs.rmSync(full);
    }
  };
  drop(fixture.dir);
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language: "pt-BR" }, null, 2)}\n`, { mode: 0o600 });
  return fixture;
}

async function withServer(page: Page, fixture: Fixture, body: (ctx: { fixture: Fixture; server: UiServer; base: string }) => Promise<void>): Promise<void> {
  let server: UiServer | null = null;
  try {
    server = await startServer(fixture);
    const base = await openApp(page, server);
    await body({ fixture, server, base });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

function jgates(fixture: Fixture, ...args: string[]) {
  return spawnSync(process.execPath, [MAIN, ...args, "--cwd", fixture.dir, "--json"], { env: fixture.env, encoding: "utf8", timeout: 170_000 });
}

/** Makes `strict` the profile the project uses by default (the tier that switches every tool of the engine on). */
function useStrict(fixture: Fixture): void {
  const file = path.join(fixture.dir, "jgates.yml");
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(/^(\s*profile: )minimal$/m, "$1strict");
  expect(after, "jgates.yml selects the minimal profile").not.toBe(before);
  fs.writeFileSync(file, after);
}

async function openTools(page: Page, base: string): Promise<void> {
  await page.goto(`${base}#/tools`);
  await expect(page.getByRole("heading", { name: "Ferramentas", level: 1 })).toBeVisible();
}

test("the tools catalogue groups the engine's tools by section and group, and 'this project' follows the files", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(page, markdownFixture(), async ({ base }) => {
    const catalog = await pageGet<{ adapters: Array<{ adapter: string; relevance: number; place?: { section: string; group: string; tier: string } }> }>(page, "/api/tool-catalog");
    for (const id of MARKDOWN_TOOLS) {
      const entry = catalog.adapters.find((a) => a.adapter === id);
      expect(entry, id).toBeTruthy();
      expect(entry?.place?.section).toBe("format");
      expect(entry?.place?.group).toBe("markdown");
      // The census of this project holds Markdown files: the group is of this project.
      expect(entry?.relevance).toBe(0);
    }
    await openTools(page, base);
    const section = page.locator('[data-testid="catalog-section"][data-section="format"]');
    await expect(section.getByRole("heading", { level: 3 })).toContainText("Formatos");
    const group = section.locator('[data-testid="catalog-group"][data-group="markdown"]');
    await expect(group).toBeVisible();
    const markdownCount = catalog.adapters.filter((a) => a.place?.section === "format" && a.place.group === "markdown" && a.relevance < 2).length;
    await expect(group.locator("summary")).toContainText(new RegExp(`\\b${markdownCount} ferramentas\\b`));
    await expect(group).not.toHaveAttribute("open", "");
    await group.locator("summary").press("Enter");
    for (const id of MARKDOWN_TOOLS) await expect(group.locator(`[data-testid="catalog-card"][data-adapter="${id}"]`)).toBeVisible();
    await expect(group.locator('[data-adapter="markdownlint"] [data-testid="catalog-tier"]')).toHaveAttribute("data-tier", "main");
    await expect(group.locator('[data-adapter="rumdl"] [data-testid="catalog-tier"]')).toHaveAttribute("data-tier", "extended");
    await expect(group.locator('[data-adapter="rumdl"] [data-testid="catalog-purpose"]')).not.toBeEmpty();

    // The search box looks through the whole catalogue and opens the groups.
    await page.getByRole("searchbox", { name: "Buscar ferramenta ou linguagem" }).pressSequentially("rumdl");
    await expect(page.locator('[data-testid="catalog-card"][data-adapter="rumdl"]')).toBeVisible();
    await expect(page.locator('[data-testid="catalog-card"][data-adapter="markdownlint"]')).toHaveCount(0);
  });
});

test("a project without Markdown files does not see the Markdown group until 'All' is chosen", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(page, plainFixture(), async ({ base }) => {
    await openTools(page, base);
    await expect(page.locator('[data-testid="catalog-group"][data-group="markdown"]')).toHaveCount(0);
    await page.locator('input[name="tools-scope"][value="all"]').press("Space");
    await expect(page.locator('[data-testid="catalog-group"][data-group="markdown"]')).toBeVisible();
    await expect.poll(() => page.getByTestId("catalog-card").count()).toBeGreaterThanOrEqual(140);
    await page.locator('input[name="tools-scope"][value="project"]').press("Space");
    await expect(page.locator('[data-testid="catalog-group"][data-group="markdown"]')).toHaveCount(0);
    await expect(page.getByTestId("tools-scope-hidden")).toBeVisible();
  });
});

test("the profile editor shows a tool above the profile's tier as off with its reason, and its switch turns it on", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(page, markdownFixture(), async ({ fixture }) => {
    await page.getByRole("link", { name: "Configuração", exact: true }).first().press("Enter");
    await expect(page.getByRole("heading", { name: "Perfis do projeto" })).toBeVisible();
    const editBalanced = page.getByRole("button", { name: "Editar o perfil Equilibrado" });
    await editBalanced.press("Enter");
    await expect(editBalanced).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Abrir a categoria Qualidade" }).press("Enter");
    await page.locator('li.capability[data-capability="lint"] .tools-toggle').press("Enter");
    const block = page.locator('.tool-block[data-tool="rumdl"]');
    const row = block.locator('[data-selector="tool:rumdl"]');
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-enabled", "false");
    const note = block.getByTestId("tool-tier");
    await expect(note).toHaveAttribute("data-above", "true");
    await expect(note).toHaveAttribute("data-tier", "extended");
    await expect(note).toContainText("Rigoroso");

    // The switch is the user's own choice: it turns the tool on in this profile, written into the profile file.
    await row.getByRole("switch").press("Space");
    await expect(row).toHaveAttribute("data-enabled", "true");
    const profilesFile = path.join(fixture.dir, ".jgates", "profiles.yml");
    await expect.poll(() => parseYaml(fs.readFileSync(profilesFile, "utf8")).profiles.standard.checks["tool:rumdl"]?.enabled).toBe(true);
    await expect(row.getByRole("switch")).toBeFocused();
    const changes = page.locator('[data-profile="standard"] .profile-changes');
    await changes.locator("summary").press("Enter");
    await expect(changes.getByRole("listitem").filter({ hasText: "tool:rumdl" })).toContainText("ligado");
  });
});

test("the review collapses the 'will run' list by area with a count on each header", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(page, markdownFixture(), async ({ base }) => {
    await page.evaluate(() => window.sessionStorage.setItem("jgates.validation.request", JSON.stringify({ gates: "quality", profile: "strict", target: "full" })));
    await page.goto(`${base}#/validations/review`);
    const willRun = page.getByTestId("group-will-run");
    await expect(willRun).toBeVisible();
    const heading = await willRun.getByRole("heading", { level: 2 }).innerText();
    expect(Number(heading.match(/\((\d+)\)$/)?.[1])).toBeGreaterThanOrEqual(40);
    // The category holding the linters opens; the areas inside it stay closed, each with the number of its checks.
    const quality = willRun.locator('[data-category-group="quality"]');
    const area = quality.locator('[data-testid="area-group"][data-area="markdown"]');
    await quality.locator(":scope > summary").press("Enter");
    await expect(area).toBeVisible();
    await expect(area.locator("summary")).toContainText(/\d/);
    await expect(area).not.toHaveAttribute("open", "");
    await expect(area.getByTestId("plan-item").first()).toBeHidden();
    await area.locator("summary").press("Enter");
    await expect(area.locator('[data-testid="plan-item"]').first()).toBeVisible();
  });
});

test("the run screen groups the steps by area, opens the one that failed or runs, and says how many run at once", async ({ page }) => {
  test.setTimeout(300_000);
  await withServer(page, markdownFixture(), async ({ fixture, base }) => {
    const run = jgates(fixture, "run", "--profile", "strict");
    expect([0, 1, 2]).toContain(run.status);
    const runId = (JSON.parse(run.stdout) as { runId: string }).runId;
    await page.goto(`${base}#/runs/${encodeURIComponent(runId)}`);
    await expect(page.getByTestId("run-state")).toBeVisible();
    const line = page.getByTestId("run-concurrency");
    await expect(line).toBeVisible();
    expect(Number(await line.getAttribute("data-limit"))).toBeGreaterThanOrEqual(1);
    const area = page.locator('[data-testid="run-area"][data-area="markdown"]');
    await expect(area).toBeVisible();
    await expect(area.locator("summary")).toContainText(/\d+ de \d+/);
    // A group with a failed step starts open; one without stays closed until it is opened.
    if ((await area.getAttribute("data-failed")) === "true") await expect(area).toHaveAttribute("open", "");
    else {
      await area.locator("summary").press("Enter");
      await expect(area.locator("tbody tr").first()).toBeVisible();
    }
  });
});

test("a live run opens the active and failed areas and counts overlapping steps at 375 px in English", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.addInitScript(() => localStorage.setItem("jgates.language", "en"));
  await withServer(page, markdownFixture("en"), async ({ base }) => {
    const runId = "run_20261026T100000Z_aaaaaaaa";
    const steps = [
      { id: "actionlint#lint", label: "actionlint" },
      { id: "markdownlint#lint", label: "markdownlint" },
      { id: "rumdl#lint", label: "rumdl" },
    ];
    const records = [
      ...steps.map((step) => ({ type: "step-started", data: { step: step.id, label: step.label, concurrency: 4 } })),
      { type: "step-finished", data: { step: "actionlint#lint", status: "failed", durationMs: 200 } },
    ];
    const events = records.map((event, index) => ({
      ...event, schemaVersion: 1, runId, sequence: index + 1, at: "2026-10-26T10:00:01.000Z",
    }));
    // Hold the executor's progress at the point where one area has failed and two steps overlap.
    await page.route(`**/api/runs/${runId}/progress?*`, async (route) => {
      const first = new URL(route.request().url()).searchParams.get("cursor") === "0";
      await route.fulfill({ json: { runId, steps, events: first ? events : [], cursor: events.length, done: false } });
    });
    await page.goto(`${base}#/runs/${runId}`);
    await expect(page.getByTestId("run-concurrency")).toHaveText("2 of up to 4 checks are running at the same time.");
    const active = page.locator('[data-testid="run-area"][data-area="markdown"]');
    const failed = page.locator('[data-testid="run-area"][data-area="github-actions"]');
    await expect(active).toHaveAttribute("data-live", "true");
    await expect(active).toHaveAttribute("open", "");
    await expect(active.locator('tr[data-state="running"]')).toHaveCount(2);
    await expect(failed).toHaveAttribute("data-failed", "true");
    await expect(failed).toHaveAttribute("data-live", "false");
    await expect(failed.getByRole("rowheader", { name: "actionlint" })).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(375);
    const axe = await new AxeBuilder({ page }).include('section[aria-labelledby="vrun-steps"]').withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.map(({ id }) => id)).toEqual([]);
  });
});

test("the overview and the result name the checks that are new since the last validation", async ({ page }) => {
  test.setTimeout(420_000);
  await withServer(page, markdownFixture(), async ({ fixture, base }) => {
    // A first validation with the minimal profile, then a project that moves to Strict: the Markdown tools are new.
    const first = jgates(fixture, "run");
    expect([0, 1, 2]).toContain(first.status);
    useStrict(fixture);
    await page.goto(`${base}#/overview`);
    await reloadPage(page);
    const onOverview = page.locator('[data-testid="new-checks"][data-where="overview"]');
    await expect(onOverview).toBeVisible();
    await onOverview.locator("summary").press("Enter");
    for (const id of MARKDOWN_TOOLS) await expect(onOverview.locator(`li[data-tool="${id}"]`)).toBeVisible();

    const second = jgates(fixture, "run");
    expect([0, 1, 2]).toContain(second.status);
    const runId = (JSON.parse(second.stdout) as { runId: string }).runId;
    await page.goto(`${base}#/validations/result/${encodeURIComponent(runId)}`);
    const onResult = page.locator('[data-testid="new-checks"][data-where="result"]');
    await expect(onResult).toBeVisible();
    await onResult.locator("summary").press("Enter");
    await expect(onResult.locator('li[data-tool="rumdl"]')).toBeVisible();

    // Nothing new once the project has validated with them: the overview no longer says it.
    await page.goto(`${base}#/overview`);
    await expect(page.locator('[data-testid="new-checks"][data-where="overview"]')).toHaveCount(0);
  });
});

test("Preferences explains the number of checks at the same time, in both languages", async ({ page }) => {
  test.setTimeout(240_000);
  for (const language of ["pt-BR", "en"] as const) {
    await withServer(page, markdownFixture(language), async ({ base }) => {
      await page.goto(`${base}#/preferences`);
      const card = page.getByTestId("prefs-concurrency");
      await expect(card).toBeVisible();
      await expect(card.getByRole("heading", { level: 2 })).toHaveText(language === "pt-BR" ? "Verificações ao mesmo tempo" : "Checks at the same time");
      const value = card.getByTestId("prefs-concurrency-value");
      await expect(value).toBeVisible();
      expect(Number(await value.getAttribute("data-value"))).toBeGreaterThanOrEqual(1);
      expect(Number(await value.getAttribute("data-value"))).toBeLessThanOrEqual(8);
      await expect(value).toHaveAttribute("data-source", "automatic");
      // The link leads to the setting; the explanation names the ceiling.
      await expect(card.getByTestId("prefs-concurrency-link")).toHaveAttribute("href", "#/config/execution");
      await expect(card).toContainText("8");
    });
  }
});

test("the result's tool filter can be searched when many tools reported", async ({ page }) => {
  test.setTimeout(240_000);
  await withServer(page, markdownFixture(), async ({ fixture, base }) => {
    const run = jgates(fixture, "run");
    expect([0, 1, 2]).toContain(run.status);
    const { runId, runDir } = JSON.parse(run.stdout) as { runId: string; runDir: string };
    const resultFile = path.join(runDir, "result.json");
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    const sample = result.findings.find((finding: { tool: string }) => finding.tool === "ruff");
    expect(sample).toBeDefined();
    const otherTools = ["actionlint", "hadolint", "markdownlint", "rumdl", "shellcheck", "yamllint", "taplo", "lychee"];
    result.findings.push(...otherTools.map((tool, index) => ({
      ...sample,
      tool,
      origin: tool,
      fingerprint: `jgf1:${String(index + 1).repeat(64)}`,
    })));
    fs.writeFileSync(resultFile, JSON.stringify(result));
    await page.goto(`${base}#/validations/result/${encodeURIComponent(runId)}`);
    const select = page.getByTestId("filter-tool");
    const search = page.getByTestId("filter-tool-search");
    await expect(search).toBeVisible();
    await search.pressSequentially("ruff");
    await expect(select.locator("option")).toHaveCount(2);
    await expect(select.locator('option[value="ruff"]')).toHaveCount(1);
  });
});
