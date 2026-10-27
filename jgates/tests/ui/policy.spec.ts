import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFixture, sha256, startServer, type Fixture, type UiServer } from "./support";

// The CI policy in the interface. `jgates ui --policy <folder>` opens the policy folder as the editing area: a fixed band
// says so, Configuração and Ferramentas edit the policy, the Política de CI screen shows the fingerprint of the set, the
// files and the ready GitHub Actions and GitLab CI snippets, and "Testar contra um projeto" builds the plan of a local
// project without writing anything. In a project governed by JGATES_POLICY_DIR the configuration is locked.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const WIDTHS = [1450, 1100, 900, 700];

function treeHash(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) parts.push(`${path.relative(dir, p)}:${sha256(fs.readFileSync(p))}`);
    }
  };
  walk(dir);
  return sha256(parts.join("\n"));
}

async function withPolicy(run: (ctx: { fixture: Fixture; server: UiServer }) => Promise<void>): Promise<void> {
  const fixture = createFixture();
  let server: UiServer | null = null;
  try {
    server = await startServer(fixture, { policy: true });
    await run({ fixture, server });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
}

async function serious(page: Page, label: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

test("the policy mode opens on the CI policy screen with the fixed band, and a profile saved in Configuração changes the file and the hash", async ({ page }) => {
  await withPolicy(async ({ fixture, server }) => {
    await page.goto(server.bootstrapUrl);
    await expect(page.getByRole("heading", { name: "Política de CI", level: 1 })).toBeVisible();
    const band = page.getByTestId("policy-band");
    await expect(band).toContainText("Editando a política de CI");
    await expect(page.getByTestId("local-card")).toContainText("Editando a política de CI");
    const before = (await page.getByTestId("pol-hash").textContent()) ?? "";
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    await expect(page.getByTestId("pol-files")).toContainText("jgates.yml");
    await expect(page.getByTestId("pol-files")).toContainText(".jgates/profiles.yml");

    // The band is on every screen, and Configuração edits the policy folder.
    await page.getByRole("link", { name: "Configuração" }).first().click();
    await expect(page.getByRole("heading", { name: "Perfis do projeto" })).toBeVisible();
    await expect(band).toBeVisible();
    const profiles = path.join(fixture.dir, ".jgates", "profiles.yml");
    const fileBefore = fs.readFileSync(profiles, "utf8");
    await page.getByRole("button", { name: "Criar perfil" }).click();
    await page.getByLabel("Criar a partir de").selectOption("standard");
    await page.getByLabel("Identificador do perfil").fill("ci-estrito");
    await page.getByRole("button", { name: "Criar", exact: true }).click();
    await expect(page.locator('[data-profile="ci-estrito"]')).toBeVisible();
    expect(fs.readFileSync(profiles, "utf8")).not.toBe(fileBefore);
    expect(fs.readFileSync(profiles, "utf8")).toContain("ci-estrito:");

    await page.getByRole("link", { name: "Política de CI", exact: true }).first().click();
    await expect(page.getByTestId("pol-hash")).not.toHaveText(before);
    const after = (await page.getByTestId("pol-hash").textContent()) ?? "";
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    await expect(page.getByTestId("pol-snippet-github")).toContainText(after);
    await expect(page.getByTestId("pol-snippet-gitlab")).toContainText(after);
    // Recalculating reads the same value again.
    await page.getByTestId("pol-reload").click();
    await expect(page.getByTestId("pol-hash")).toHaveText(after);
  });
});

test("the snippets bring the current hash and the jgates ci command, and the buttons copy them", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await withPolicy(async ({ server }) => {
    await page.goto(server.bootstrapUrl);
    const hash = (await page.getByTestId("pol-hash").textContent()) ?? "";
    await expect(page.getByTestId("pol-variables")).toContainText("JGATES_POLICY_SHA256");
    await expect(page.getByTestId("pol-variables")).toContainText("JGATES_POLICY_DIR");
    await expect(page.getByTestId("pol-variables")).toContainText(hash);
    await expect(page.getByTestId("pol-command")).toHaveText('jgates ci --policy "$JGATES_POLICY_DIR" --sarif jgates.sarif');
    for (const id of ["github", "gitlab"]) {
      const snippet = page.getByTestId(`pol-snippet-${id}`);
      await expect(snippet).toContainText(hash);
      await expect(snippet).toContainText('jgates ci --policy "$JGATES_POLICY_DIR" --sarif jgates.sarif');
    }
    await expect(page.getByTestId("pol-snippet-github")).toContainText("actions/checkout");
    await expect(page.getByTestId("pol-snippet-gitlab")).toContainText("CI_JOB_TOKEN");

    const text = async () => page.evaluate(() => navigator.clipboard.readText());
    await page.getByTestId("pol-copy-hash").click();
    await expect.poll(text).toBe(hash);
    await page.getByTestId("pol-copy-ci-command").click();
    await expect.poll(text).toBe('jgates ci --policy "$JGATES_POLICY_DIR" --sarif jgates.sarif');
    await page.getByTestId("pol-copy-github").click();
    await expect.poll(text).toContain("name: JGates");
    await expect.poll(text).toContain(hash);
    await page.getByTestId("pol-copy-gitlab").click();
    await expect.poll(text).toContain("script:");
    await expect.poll(text).toContain(hash);
  });
});

test("testing against a project shows the plan and changes no file of the project or of the policy", async ({ page }) => {
  const project = createFixture();
  try {
    await withPolicy(async ({ fixture, server }) => {
      await page.goto(server.bootstrapUrl);
      const policyBefore = treeHash(fixture.dir);
      const projectBefore = treeHash(project.dir);
      await page.getByLabel("Pasta do projeto (caminho completo)").fill(project.dir);
      await page.getByTestId("pol-test-run").click();
      const result = page.getByTestId("pol-test-result");
      await expect(result).toBeVisible();
      await expect(result).toContainText("Somente leitura");
      await expect(result).toContainText(project.dir);
      await expect(page.getByTestId("pol-test-count")).toContainText("rodam");
      await expect(page.getByTestId("pol-test-profile")).not.toBeEmpty();
      expect(treeHash(fixture.dir)).toBe(policyBefore);
      expect(treeHash(project.dir)).toBe(projectBefore);

      // A folder that does not exist is reported with the reason and nothing is shown as a plan.
      await page.getByLabel("Pasta do projeto (caminho completo)").fill(path.join(os.tmpdir(), "jgates-nao-existe-xyz"));
      await page.getByTestId("pol-test-run").click();
      await expect(page.getByRole("alert")).toContainText("não existe");
      await expect(result).toHaveCount(0);
    });
  } finally {
    project.cleanup();
  }
});

test("the screens that validate a project are unavailable in the policy mode, with the reason", async ({ page }) => {
  await withPolicy(async ({ server }) => {
    await page.goto(server.bootstrapUrl);
    await page.getByRole("link", { name: "Validações" }).first().click();
    const note = page.getByTestId("policy-unavailable");
    await expect(note).toBeVisible();
    await expect(note).toContainText("não é um projeto");
    await page.goto(`${page.url().split("#")[0]}#/validations/review`);
    await expect(page.getByTestId("policy-unavailable")).toBeVisible();
    // The server refuses to run anything on a policy as well.
    const status = await page.evaluate(async () => {
      const session = await (await fetch("/api/session", { credentials: "same-origin" })).json();
      const r = await fetch("/api/plans", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", [session.csrfHeader]: session.csrfToken }, body: "{}" });
      return { status: r.status, body: await r.json() };
    });
    expect(status.status).toBe(409);
    expect(status.body.code).toBe("POLICY_MODE_UNAVAILABLE");
  });
});

test("the policy screens pass axe in light and dark, are operable by keyboard and never scroll sideways", async ({ browser }) => {
  test.setTimeout(240_000);
  await withPolicy(async ({ server }) => {
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1450, height: 900 }, locale: "pt-BR", colorScheme: "light" });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    try {
      await page.goto(server.bootstrapUrl);
      await expect(page.getByTestId("pol-hash")).toBeVisible();
      await page.getByLabel("Pasta do projeto (caminho completo)").fill(os.tmpdir());
      await page.getByTestId("pol-test-run").click();
      await expect(page.getByTestId("pol-test-result").or(page.getByRole("alert"))).toBeVisible();
      const base = page.url().split("#")[0];
      const found: string[] = [];
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const hash of ["#/policy", "#/config", "#/validations"]) {
          await page.goto(`${base}${hash}`);
          await page.reload();
          await expect(page.locator("main h1").first()).toBeVisible();
          found.push(...(await serious(page, `${scheme} ${hash}`)));
        }
      }
      expect(found).toEqual([]);

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${base}#/policy`);
        await page.reload();
        await expect(page.getByTestId("pol-hash")).toBeVisible();
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(over, `horizontal scroll at ${width}px`).toBeLessThanOrEqual(0);
      }

      // Keyboard: the copy buttons and the test button take focus in order and show a focus ring.
      await page.setViewportSize({ width: 1450, height: 900 });
      await page.goto(`${base}#/policy`);
      await page.reload();
      await page.getByTestId("pol-copy-hash").focus();
      await expect(page.getByTestId("pol-copy-hash")).toBeFocused();
      const outline = await page.getByTestId("pol-copy-hash").evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(outline).not.toBe("none");
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("pol-reload")).toBeFocused();
    } finally {
      await context.close();
    }
  });
});

test("in a project governed by JGATES_POLICY_DIR the screens lock and the server refuses the write; without the variable it is editable", async ({ page }) => {
  const governed = createFixture();
  governed.env.JGATES_POLICY_DIR = "/etc/policies/company-policy";
  governed.env.JGATES_POLICY_SHA256 = "b".repeat(64);
  const local = createFixture();
  local.env.JGATES_POLICY_DIR = "";
  local.env.JGATES_POLICY_SHA256 = "";
  const write = (): Promise<number> =>
    page.evaluate(async () => {
      const session = await (await fetch("/api/session", { credentials: "same-origin" })).json();
      const r = await fetch("/api/profiles", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", [session.csrfHeader]: session.csrfToken }, body: JSON.stringify({ id: "novo-perfil", from: "standard" }) });
      return r.status;
    });
  let server: UiServer | null = null;
  try {
    server = await startServer(governed);
    await page.goto(server.bootstrapUrl);
    await expect(page.locator("main h1").first()).toBeVisible();
    await page.goto(`${page.url().split("#")[0]}#/policy`);
    await page.reload();
    await expect(page.getByTestId("pol-governed-note")).toContainText("company-policy");
    await expect(page.getByTestId("policy-band")).toHaveCount(0);
    expect(await write()).toBe(403);
    expect(fs.readFileSync(path.join(governed.dir, ".jgates", "profiles.yml"), "utf8")).not.toContain("novo-perfil");
    await server.stop();

    server = await startServer(local);
    await page.goto(server.bootstrapUrl);
    await expect(page.locator("main h1").first()).toBeVisible();
    await page.goto(`${page.url().split("#")[0]}#/policy`);
    await page.reload();
    await expect(page.getByTestId("pol-governed-note")).toHaveCount(0);
    await expect(page.getByTestId("pol-copy-command")).toBeVisible();
    await page.getByTestId("pol-copy-command").click();
    expect(await write()).toBe(201);
    expect(fs.readFileSync(path.join(local.dir, ".jgates", "profiles.yml"), "utf8")).toContain("novo-perfil");
  } finally {
    await server?.stop();
    governed.cleanup();
    local.cleanup();
  }
});
