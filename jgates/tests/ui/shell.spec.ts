import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAIN, createFixture, sha256, startServer, type Fixture, type UiServer } from "./support";

// The application shell. Navigation by keyboard, skip link, drawer, themes saved in the data folder, branch and
// commit with the dirty mark, workspace switcher, governed badge and the states of the UI itself.

const AREAS = ["Visão geral", "Workspace", "Configuração", "Validações"];

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Absolute path of git: the server runs with an empty PATH (like the other specs), so it gets git by JGATES_GIT. */
function findGit(): string {
  const exe = process.platform === "win32" ? "git.exe" : "git";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, exe);
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  throw new Error("git not found on the PATH");
}

/** A fixture whose workspace is a Git repository with everything committed. */
function committedFixture(): Fixture {
  const fixture = createFixture();
  fixture.env.JGATES_GIT = findGit();
  git(fixture.dir, "init", "-b", "main");
  git(fixture.dir, "add", "-A");
  git(fixture.dir, "commit", "-m", "fixture");
  return fixture;
}

/** Every file of the workspace outside .git, with its hash: the project must not change because of the UI. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = sha256(fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

async function withServer(fixture: Fixture, body: (server: UiServer) => Promise<void>): Promise<void> {
  const server = await startServer(fixture);
  try {
    await body(server);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
}

const bodyBackground = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const LIGHT_BG = "rgb(248, 249, 246)";
const DARK_BG = "rgb(19, 26, 23)";

test("navigation reaches every area by keyboard and the skip link moves focus to the content", async ({ page }) => {
  await withServer(committedFixture(), async (server) => {
    await page.goto(server.bootstrapUrl);
    const nav = page.getByRole("navigation", { name: "Navegação principal" });
    await expect(nav).toBeVisible();

    // Skip link: the first stop of the keyboard, and Enter lands on the content.
    await page.locator("body").press("Tab");
    const skip = page.getByRole("link", { name: "Pular para o conteúdo" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#content")).toBeFocused();

    for (const area of AREAS) {
      await nav.getByRole("link", { name: area }).focus();
      await page.keyboard.press("Enter");
      await expect(nav.getByRole("link", { name: area })).toHaveAttribute("aria-current", "page");
      // The first visit already lands on the Overview, so choosing it again does not change the route or the focus.
      if (area !== "Visão geral") await expect(page.locator("main#content")).toBeFocused();
    }
    for (const [name, hash] of [["Ajuda e CLI", "#/help"], ["Preferências", "#/preferences"]] as const) {
      await page.getByRole("link", { name }).focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => new URL(page.url()).hash).toBe(hash);
      await expect(page.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
    }
  });
});

test("below 700 px the menu is a drawer that traps focus", async ({ page }) => {
  await withServer(committedFixture(), async (server) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto(server.bootstrapUrl);
    const toggle = page.getByRole("button", { name: "Abrir menu" });
    await expect(toggle).toBeVisible();
    await expect(page.locator("#sidebar")).toBeHidden();

    await toggle.click();
    const drawer = page.locator("#sidebar");
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute("role", "dialog");
    const insideDrawer = () => page.evaluate(() => document.activeElement?.closest("#sidebar") !== null);
    expect(await insideDrawer()).toBe(true);
    for (let i = 0; i < 18; i++) {
      await page.keyboard.press("Tab");
      expect(await insideDrawer(), `Tab ${i + 1} stayed in the drawer`).toBe(true);
    }
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await insideDrawer(), `Shift+Tab ${i + 1} stayed in the drawer`).toBe(true);
    }

    // Escape closes it and focus goes back to the button that opened it.
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();

    // Choosing an area closes the drawer too.
    await toggle.click();
    await page.locator("#sidebar").getByRole("link", { name: "Workspace" }).first().click();
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect.poll(() => new URL(page.url()).hash).toBe("#/workspace");

    // Wide again: the menu is a column and the toggle is gone.
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Abrir menu" })).toBeHidden();
  });
});

test("the theme is saved in the data folder, not in the project, and System follows the browser", async ({ page }) => {
  const fixture = committedFixture();
  await withServer(fixture, async (server) => {
    const before = snapshot(fixture.dir);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(server.bootstrapUrl);
    const theme = page.getByRole("combobox", { name: "Tema" });
    await expect(theme).toHaveValue("system");
    expect(await bodyBackground(page)).toBe(LIGHT_BG);

    await theme.selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => bodyBackground(page)).toBe(DARK_BG);
    await expect(page.getByTestId("toasts")).toContainText("Tema Escuro salvo");
    const file = path.join(fixture.home, "preferences.json");
    await expect.poll(() => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).theme : null)).toBe("dark");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(snapshot(fixture.dir)).toEqual(before);

    // The saved preference wins over the browser setting, and survives a reload.
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Tema" })).toHaveValue("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // Dialogs and errors use the same tokens.
    await page.getByRole("button", { name: "Selecionar workspace" }).click();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("dialog")!).backgroundColor)).toBe("rgb(26, 35, 31)");
    await page.keyboard.press("Escape");

    // System follows prefers-color-scheme in both directions.
    await page.getByRole("combobox", { name: "Tema" }).selectOption("system");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    await expect.poll(() => JSON.parse(fs.readFileSync(file, "utf8")).theme).toBe("system");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => bodyBackground(page)).toBe(DARK_BG);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => bodyBackground(page)).toBe(LIGHT_BG);

    await page.getByRole("combobox", { name: "Tema" }).selectOption("light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => bodyBackground(page)).toBe(LIGHT_BG);
    expect(snapshot(fixture.dir)).toEqual(before);
  });
});

test("the top bar shows the real branch and commit, and the dirty mark when the tree has uncommitted changes", async ({ page }) => {
  const fixture = committedFixture();
  await withServer(fixture, async (server) => {
    const commit = git(fixture.dir, "rev-parse", "HEAD");
    await page.goto(server.bootstrapUrl);
    await expect(page.getByTestId("git-branch")).toHaveText("main");
    await expect(page.getByTestId("git-commit")).toHaveText(commit.slice(0, 7));
    await expect(page.getByTestId("git-dirty")).toHaveCount(0);
    await expect(page.getByTestId("local-card")).toContainText("Modo local");
    await expect(page.getByTestId("local-card")).toContainText("Nenhuma execução em andamento");

    fs.writeFileSync(path.join(fixture.dir, "novo.txt"), "mudança\n");
    await page.reload();
    await expect(page.getByTestId("git-dirty")).toHaveText("Árvore suja");
    await expect(page.getByTestId("git-commit")).toHaveText(commit.slice(0, 7));

    // A change to a tracked file counts too, and a clean tree clears the mark.
    fs.rmSync(path.join(fixture.dir, "novo.txt"));
    fs.appendFileSync(path.join(fixture.dir, "pyproject.toml"), "# edit\n");
    await page.reload();
    await expect(page.getByTestId("git-dirty")).toBeVisible();
    git(fixture.dir, "checkout", "--", "pyproject.toml");
    await page.reload();
    await expect(page.getByTestId("git-branch")).toHaveText("main");
    await expect(page.getByTestId("git-dirty")).toHaveCount(0);
  });
});

test("the selector lists the registered workspaces and choosing the other one opens a new session for it", async ({ page, context }) => {
  const fixture = committedFixture();
  const other = createFixture();
  try {
    await withServer(fixture, async (server) => {
      const registered = spawnSync(process.execPath, [MAIN, "workspaces", "add", other.dir], { env: fixture.env, encoding: "utf8" });
      expect(registered.status, registered.stderr).toBe(0);
      // Two runs in the history of the first workspace feed the counter of Validações.
      const runs = path.join(fixture.home, "workspaces", server.info.workspace.id, "runs");
      fs.mkdirSync(path.join(runs, "run_20260101T000000Z_aaaaaaaa"), { recursive: true });
      fs.mkdirSync(path.join(runs, "run_20260102T000000Z_bbbbbbbb"), { recursive: true });

      await page.goto(server.bootstrapUrl);
      await expect(page.getByRole("link", { name: /Validações/ }).locator(".nav-count")).toHaveText("2");
      await page.getByRole("button", { name: "Selecionar workspace" }).click();
      const dialog = page.getByRole("dialog", { name: "Selecionar workspace" });
      const items = dialog.locator(".ws-item");
      await expect(items).toHaveCount(2);
      await expect(items.filter({ hasText: path.basename(fixture.dir) })).toContainText("Aberto");
      await expect(items.filter({ hasText: path.basename(fixture.dir) })).toContainText("main");
      const row = items.filter({ hasText: path.basename(other.dir) });
      await expect(row).toContainText(fs.realpathSync(other.dir));

      const popup = context.waitForEvent("page");
      await row.getByRole("button", { name: /Abrir/ }).click();
      const second = await popup;
      await second.waitForLoadState("domcontentloaded");
      // The new tab is another server (another port) with its own session, on the other workspace.
      await expect(second.getByRole("button", { name: "Selecionar workspace" })).toContainText(path.basename(other.dir));
      expect(new URL(second.url()).port).not.toBe(new URL(page.url()).port);
      await expect(second.getByRole("link", { name: /Validações/ }).locator(".nav-count")).toHaveText("0");
      // The first tab is still on its workspace.
      await expect(dialog).toContainText("Sessão aberta em outra aba");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Selecionar workspace" })).toContainText(path.basename(fixture.dir));

      // An unknown folder is refused with a recovery hint, not a generic error.
      await page.getByRole("button", { name: "Selecionar workspace" }).click();
      await page.getByLabel("Abrir outra pasta").fill(path.join(fixture.dir, "nao-existe"));
      await page.getByRole("button", { name: "Abrir pasta" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "não é uma pasta" })).toBeVisible();
    });
  } finally {
    other.cleanup();
  }
});

test("with the server stopped the UI says so and tells how to recover", async ({ page }) => {
  const fixture = committedFixture();
  const server = await startServer(fixture);
  try {
    await page.goto(server.bootstrapUrl);
    await expect(page.getByTestId("git-branch")).toHaveText("main");
    await server.stop();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const state = page.locator('[data-state="server-stopped"]');
    await expect(state).toBeVisible();
    await expect(state.getByRole("heading", { name: "O servidor local parou" })).toBeVisible();
    await expect(state).toContainText("jgates ui");
    await expect(state).toContainText(fs.realpathSync(fixture.dir));
    await expect(page.getByText("Não foi possível concluir")).toHaveCount(0);
    await state.getByRole("button", { name: "Verificar de novo" }).click();
    await expect(state.getByText("O servidor ainda não responde.")).toBeVisible();
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("a session that the server no longer knows gets its own state", async ({ page }) => {
  await withServer(committedFixture(), async (server) => {
    await page.goto(server.bootstrapUrl);
    await expect(page.getByTestId("git-branch")).toHaveText("main");
    await page.route("**/api/session", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "SESSION_REQUIRED", message: "x" }) }));
    await page.route("**/api/shell", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "SESSION_REQUIRED", message: "x" }) }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const state = page.locator('[data-state="session-expired"]');
    await expect(state.getByRole("heading", { name: "A sessão terminou" })).toBeVisible();
    await expect(state).toContainText("jgates ui");
  });
});

test("a workspace without jgates.yml shows the first-access road in the overview", async ({ page }) => {
  const fixture = createFixture();
  fs.rmSync(path.join(fixture.dir, "jgates.yml"));
  fs.rmSync(path.join(fixture.dir, ".jgates"), { recursive: true, force: true });
  await withServer(fixture, async (server) => {
    await page.goto(server.bootstrapUrl);
    await expect.poll(() => new URL(page.url()).hash).toBe("#/overview");
    const road = page.locator('[data-state="first-access"]');
    await expect(road.getByRole("heading", { name: "Este workspace ainda não tem configuração", level: 1 })).toBeVisible();
    await expect(road.locator("li[data-step]")).toHaveCount(3);
    await expect(road.locator('li[data-step="init"] code')).toContainText("jgates init --cwd");
    await expect(road.locator('li[data-step="init"] code')).toContainText(fs.realpathSync(fixture.dir));
    // The road stays in the overview whichever way the user gets there.
    await page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "Workspace" }).click();
    await page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "Visão geral" }).click();
    await expect(road).toBeVisible();

    // After the init the road gives way (the data of the overview takes its place).
    const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", fixture.dir, "--profile", "minimal", "--no-interactive", "--json"], { env: fixture.env, encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    await road.getByRole("button", { name: "Já rodei o init, verificar de novo" }).click();
    await expect(road).toHaveCount(0);
  });
});

test("the governed mode shows its badge and the locked fields with the reason", async ({ page }) => {
  const fixture = committedFixture();
  fixture.env.JGATES_POLICY_DIR = "/etc/policies/company-policy";
  fixture.env.JGATES_POLICY_SHA256 = "a".repeat(64);
  await withServer(fixture, async (server) => {
    await page.goto(server.bootstrapUrl);
    await expect(page.getByTestId("local-card")).toContainText("Modo governado");
    await page.getByTestId("governed-badge").click();
    const dialog = page.getByRole("dialog", { name: "Modo governado" });
    const locked = dialog.locator('[data-locked="true"]');
    await expect(locked).toHaveCount(3);
    const policy = dialog.getByRole("textbox", { name: "Pasta da política" });
    await expect(policy).toHaveAttribute("aria-readonly", "true");
    await expect(policy).toContainText("company-policy");
    // Only the file name reaches the browser, never the folder.
    await expect(dialog).not.toContainText("/etc/policies");
    await expect(policy).toHaveAccessibleDescription(/não é editável aqui/);
    await expect(dialog.getByRole("textbox", { name: "SHA-256 da política" })).toContainText("Fixado pelo ambiente");
  });
});

test("a run in progress is announced after a reload and links back to it", async ({ page }) => {
  await withServer(committedFixture(), async (server) => {
    await page.route("**/api/shell", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.runs.active = { id: "job_0123456789abcdef", startedAt: new Date().toISOString() };
      await route.fulfill({ response, json });
    });
    await page.goto(server.bootstrapUrl);
    const banner = page.locator('[data-state="run-in-progress"]');
    await expect(banner).toContainText("Há uma execução em andamento");
    await expect(banner.getByRole("link", { name: "Acompanhar execução" })).toHaveAttribute("href", "#/runs/job_0123456789abcdef");
    await expect(page.getByTestId("local-card")).toContainText("Execução em andamento");
  });
});

test("the shell has no automatic accessibility violations in the light and dark themes", async ({ page }) => {
  await withServer(committedFixture(), async (server) => {
    await page.goto(server.bootstrapUrl);
    await expect(page.getByTestId("git-branch")).toHaveText("main");
    for (const theme of ["light", "dark"] as const) {
      await page.getByRole("combobox", { name: "Tema" }).selectOption(theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(result.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => `${n.target.join(" ")} ${n.failureSummary ?? ""}`).join(" | ")}`)).toEqual([]);
    }
    await page.getByRole("button", { name: "Selecionar workspace" }).click();
    const withDialog = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(withDialog.violations.map((v) => v.id)).toEqual([]);
  });
});
