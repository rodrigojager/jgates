import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { REPO, createFixture, startServer, type Fixture, type UiServer } from "./support";

// Configuração > YAML (PLAN-config-editing.md section 5): a link opens the file with the cursor on the key, the structure
// is checked while typing (markers in the text and a list that jumps to the line), Salvar is off while the file has
// problems unless Salvar mesmo assim is chosen, the files that do not exist are offered with Criar, and no link of the
// screens points to the YAML screen without a file.

const TOOLS = ["schemaVersion: 1", "tools:", "  ruff:", "    adapter: ruff", "    config: pyproject.toml", "  zap:", "    adapter: zap", "    target: https://example.test", ""].join("\n");

async function withServer(run: (ctx: { fixture: Fixture; server: UiServer }) => Promise<void>, prepare?: (fixture: Fixture) => void): Promise<void> {
  const fixture = createFixture();
  let server: UiServer | null = null;
  try {
    fs.writeFileSync(path.join(fixture.dir, ".jgates", "tools.yml"), TOOLS);
    prepare?.(fixture);
    server = await startServer(fixture);
    await run({ fixture, server });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

async function enter(page: Page, server: UiServer, hash: string): Promise<void> {
  if (!page.url().includes("#")) {
    await page.goto(server.bootstrapUrl);
    await expect(page.locator("main h1").first()).toBeVisible();
  }
  await page.goto(`${page.url().split("#")[0]}#${hash}`);
  await page.reload();
}

const activeLine = (page: Page) => page.locator(".cm-lineNumbers .cm-activeLineGutter");

test("a link with file and key opens that file with the cursor on the line of the key", async ({ page }) => {
  await withServer(async ({ server }) => {
    await enter(page, server, "/config/yaml?file=.jgates/tools.yml&path=tools.zap.target");
    await expect(page.getByTestId("yaml-pane")).toHaveAttribute("data-file", ".jgates/tools.yml");
    await expect(activeLine(page)).toHaveText("8");
    await expect(page.locator(".cm-activeLine")).toContainText("target: https://example.test");

    // A key that is not written lands on its closest section and says so.
    await enter(page, server, "/config/yaml?file=.jgates/tools.yml&path=tools.zap.mode");
    await expect(page.getByTestId("key-missing")).toBeVisible();
    await expect(activeLine(page)).toHaveText("6");

    // A line in the link (the form of the unrecognized settings) is honored too.
    await enter(page, server, "/config/yaml?file=.jgates/tools.yml&line=4");
    await expect(activeLine(page)).toHaveText("4");
  });
});

test("errors appear while typing with markers and a list that jumps to the line; Salvar waits for the fix", async ({ page }) => {
  await withServer(async ({ fixture, server }) => {
    const root = path.join(fixture.dir, "jgates.yml");
    const original = fs.readFileSync(root, "utf8");
    await enter(page, server, "/config/yaml?file=jgates.yml");
    await expect(page.getByTestId("check-ok")).toBeVisible();
    await expect(page.getByRole("button", { name: "Salvar mesmo assim" })).toHaveCount(0);

    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\nnetwork_typo: true\n");

    // No button was pressed: the problem is listed with file, key and line, and marked in the text.
    const errors = page.getByTestId("check-errors");
    await expect(errors).toBeVisible();
    await expect(errors.getByTestId("diag-file").first()).toHaveText("jgates.yml");
    await expect(errors.getByTestId("diag-path").first()).toContainText("network_typo");
    await expect(page.locator(".cm-diag-line")).toHaveCount(1);
    await expect(page.locator("[data-diag-mark]:visible")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Salvar", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Salvar mesmo assim" })).toBeVisible();

    // The list jumps to the line, also from another place of the text.
    const shown = (await errors.locator("li").first().textContent()) ?? "";
    const line = /linha (\d+)/.exec(shown)?.[1];
    expect(line).toBeTruthy();
    await page.keyboard.press("Control+Home");
    await expect(activeLine(page)).toHaveText("1");
    await errors.getByTestId("diag-goto").first().click();
    await expect(activeLine(page)).toHaveText(line as string);
    expect(fs.readFileSync(root, "utf8")).toBe(original);

    // Removing the typo clears the problems and Salvar works again.
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("check-ok")).toBeVisible();
    await expect(page.getByRole("button", { name: "Salvar", exact: true })).toBeEnabled();
  });
});

test("Salvar mesmo assim writes a file with problems; the limits and the pattern read in plain words", async ({ page }) => {
  await withServer(async ({ fixture, server }) => {
    const root = path.join(fixture.dir, "jgates.yml");
    await enter(page, server, "/config/yaml?file=jgates.yml");
    await expect(page.getByTestId("check-ok")).toBeVisible();
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\nexecution:\n  concurrency: 0\n");
    const errors = page.getByTestId("check-errors");
    await expect(errors).toBeVisible();
    await expect(errors.getByTestId("diag-path").first()).toContainText("execution.concurrency");
    await expect(errors).toContainText("no mínimo 1");
    await expect(page.getByRole("button", { name: "Salvar", exact: true })).toBeDisabled();

    await page.getByRole("button", { name: "Salvar mesmo assim" }).click();
    await expect(page.getByTestId("yaml-state")).toHaveText("Salvo");
    expect(fs.readFileSync(root, "utf8")).toContain("concurrency: 0");
  });
});

test("the file list offers the files that do not exist with Criar", async ({ page }) => {
  await withServer(
    async ({ fixture, server }) => {
      const policy = path.join(fixture.dir, ".jgates", "policy.yml");
      expect(fs.existsSync(policy)).toBe(false);
      await enter(page, server, "/config/yaml?file=.jgates/policy.yml");
      const row = page.locator('[data-missing=".jgates/policy.yml"]');
      await expect(row).toBeVisible();
      await expect(page.getByTestId("yaml-missing")).toHaveAttribute("data-file", ".jgates/policy.yml");

      await row.getByTestId("create-file").click();
      await expect(page.getByTestId("yaml-pane")).toHaveAttribute("data-file", ".jgates/policy.yml");
      expect(fs.readFileSync(policy, "utf8")).toContain("schemaVersion: 1");
      await expect(page.locator('[data-missing=".jgates/policy.yml"]')).toHaveCount(0);
      await expect(page.locator('[data-file=".jgates/policy.yml"]').first()).toBeVisible();
    },
    (fixture) => fs.rmSync(path.join(fixture.dir, ".jgates", "policy.yml"), { force: true }),
  );
});

test("no link of the screens points to the YAML screen without a file", async ({ page }) => {
  await withServer(async ({ server }) => {
    await page.goto(server.bootstrapUrl);
    await expect(page.locator("main h1").first()).toBeVisible();
    const base = page.url().split("#")[0];
    const bare: string[] = [];
    const scan = async (where: string) => {
      const hrefs = await page.locator('main a[href^="#/config/yaml"]').evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
      for (const href of hrefs) if (!/[?&]file=[^&]+/.test(href)) bare.push(`${where}: ${href}`);
      return hrefs.length;
    };
    let seen = 0;
    for (const hash of ["/config", "/config/architecture", "/config/templates", "/config/services", "/config/execution", "/config/dependencies", "/policy", "/tools", "/tools/ruff", "/tools/builtin-pii", "/semantic/config"]) {
      await page.goto(`${base}#${hash}`);
      await expect(page.locator("main").first()).toBeVisible();
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
      // These screens always carry the link: it has to be on screen, with its file and key.
      if (["/config/architecture", "/config/execution"].includes(hash)) await expect(page.locator(`main a[href^="#/config/yaml?file="]`).first()).toBeAttached();
      seen += await scan(hash);
      // The tabs of a tool page are screens of their own.
      const tabs = page.getByRole("tab");
      const count = await tabs.count();
      for (let i = 0; i < count; i++) {
        await tabs.nth(i).click();
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
        seen += await scan(`${hash} tab ${i}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(bare).toEqual([]);
  });
});

test("the sources of the screens have no link to a bare #/config/yaml", () => {
  const src = path.join(REPO, "jgates", "ui", "src");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && /href=["']#\/config\/yaml["']|hash = ["']#\/config\/yaml["']/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(src, full));
    }
  };
  walk(src);
  expect(offenders).toEqual([]);
});
