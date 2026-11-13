import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { expectNoKnownSetAsText } from "./free-text";
import { REPO, createFixture, openApp, pageGet, startServer, type Fixture } from "./support";

// Configuração > Serviços on the fake container engine: the roles of the services and the application under test are
// chosen with selects, the host effects are said in plain words, the section is previewed as a diff and saved (the file
// content is read back through the API and from disk), "Testar subida" starts the project and always takes it down, and
// no control takes free text where the values are known (R2). Both flows run at desktop width and at 375 px.

const FAKE = path.join(REPO, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version as string;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ab".repeat(32)}`;

const COMPOSE = `services:
  db:
    image: postgres:16
    cap_add: [SYS_ADMIN]
    volumes:
      - /srv/pgdata:/var/lib/postgresql/data
  api:
    build: .
    ports:
      - "8000:8000"
      - "9000:9000"
    depends_on: [db]
    volumes:
      - ./src:/app/src
  worker:
    image: busybox:1
    privileged: true
`;

/** A configured project with a compose file, served with the fake engine (the tools image is there). */
function servicesFixture(): { fixture: Fixture; engine: string } {
  const fixture = createFixture();
  fs.writeFileSync(path.join(fixture.dir, "docker-compose.yml"), COMPOSE);
  fs.mkdirSync(path.join(fixture.dir, "src"), { recursive: true });
  const engine = fs.mkdtempSync(path.join(fixture.home, "engine-"));
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    [
      `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};`,
      `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`,
      `process.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};`,
      `process.env.FAKE_DOCKER_COMPOSE_PS = ${JSON.stringify(['{"Service":"db","State":"running","Health":"healthy"}', '{"Service":"api","State":"running","Health":""}'].join("\n"))};`,
      `process.env.FAKE_DOCKER_COMPOSE_LOGS = "api  | listening on 8000\\n";`,
      `require(${JSON.stringify(FAKE)});`,
      ``,
    ].join("\n"),
  );
  fixture.env.JGATES_IMAGE_JSON = "";
  fixture.env.JGATES_CONTAINER_RUNTIME = runtime;
  fixture.env.JGATES_TOOLS_IMAGE = PINNED;
  fixture.env.JGATES_NO_CACHE = "1";
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language: "pt-BR" }, null, 2)}\n`, { mode: 0o600 });
  return { fixture, engine };
}

const dockerCalls = (engine: string): string[][] => {
  const file = path.join(engine, "calls.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
};

/** The steps of the Stepper: files, roles, target, review. */
const goStep = (page: Page, id: "files" | "roles" | "target" | "review") => page.locator(`button[data-step="${id}"]`).click();

async function noSidewaysScroll(page: Page, where: string): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(0);
}

for (const width of [1280, 375]) {
  test(`roles, the application under test and the host effects are chosen with selects, previewed and saved (${width} px)`, async ({ page }) => {
    const { fixture, engine } = servicesFixture();
    let server: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      await page.setViewportSize({ width, height: 900 });
      server = await startServer(fixture);
      const base = await openApp(page, server);
      await page.goto(`${base}#/config/services`);
      await expect(page.getByRole("heading", { name: "Serviços do projeto", level: 1 })).toBeVisible();

      // The compose file is found and the three services listed with a suggested role.
      await expect(page.getByRole("checkbox", { name: "docker-compose.yml" })).toBeChecked();

      // The sections are the steps of the shared Stepper: files, roles, target, review; one is current at a time.
      const steps = page.getByRole("navigation", { name: "Etapas da configuração dos serviços" });
      await expect(steps.locator("ol.stepper > li button")).toHaveText(["Arquivos", "Papéis", "Alvo", "Revisão"]);
      await expect(steps.locator('[aria-current="step"]')).toHaveAttribute("data-step", "files");
      await page.getByTestId("svc-next").focus();
      await page.keyboard.press("Enter");
      await expect(steps.locator('[aria-current="step"]')).toHaveAttribute("data-step", "roles");
      const cards = page.getByTestId("svc-service");
      await expect(cards).toHaveCount(3);
      await expect(cards.filter({ hasText: "Sugestão: aplicação testada" })).toHaveAttribute("data-service", "api");

      // Host effects in plain words, with warning icons: a folder outside the project, an extra permission, privileged,
      // and the project files that are mounted read-only.
      const db = page.locator('[data-service="db"]');
      await expect(db.getByTestId("svc-effect")).toHaveCount(2);
      await expect(db).toContainText("Usa uma pasta do seu computador, que ele pode ler e alterar:");
      await expect(db).toContainText("Recebe uma permissão extra do sistema:");
      await expect(page.locator('[data-service="worker"]')).toContainText("Roda com acesso quase total à máquina:");
      await expect(page.locator('[data-service="api"]')).toContainText("Usa arquivos do projeto. O JGates monta como somente leitura:");

      // Roles and target: selects only. The worker is not used; the api is the application, on port 8000.
      const role = (name: string) => page.getByTestId(`svc-role-${name}`);
      for (const name of ["db", "api", "worker"]) expect(await role(name).evaluate((el) => el.tagName)).toBe("SELECT");
      await role("worker").selectOption("unused");
      await expect(page.locator('[data-service="worker"]')).toContainText("(não será iniciado)");
      await page.getByTestId("svc-next").click();
      await expect(page.getByTestId("svc-app-service")).toHaveValue("api");
      expect(await page.getByTestId("svc-app-port").evaluate((el) => el.tagName)).toBe("SELECT");
      await expect(page.getByTestId("svc-app-port").locator("option")).toHaveText(["8000", "9000"]);
      await page.getByTestId("svc-app-port").selectOption("8000");
      await page.getByTestId("svc-app-base").fill("/api");
      await page.getByTestId("svc-app-health").fill("/health");
      if (width === 375) await noSidewaysScroll(page, "services before the preview");

      // The services can be started on their own: the isolated project comes up and is always taken down.
      await page.getByTestId("svc-test").click();
      const result = page.getByTestId("svc-test-result");
      await expect(result).toHaveAttribute("data-state", "ready");
      await expect(result).toContainText("Os serviços foram desligados.");
      await expect(result).toContainText("db");
      const calls = dockerCalls(engine);
      const compose = (verb: string) => calls.filter((c) => c[0] === "compose" && c.includes(verb));
      expect(compose("up")).toHaveLength(1);
      expect(compose("up")[0]).not.toContain("worker");
      expect(compose("down").length).toBeGreaterThanOrEqual(1);
      expect(compose("down")[0]).toContain("--volumes");

      // Preview: the diff of jgates.yml; the host effects ask for one acknowledgement before saving.
      await page.getByTestId("svc-next").click();
      await page.getByTestId("svc-preview").click();
      const panel = page.getByTestId("svc-preview-panel");
      await expect(panel).toBeVisible();
      await expect(panel.locator(".diff-line.add")).not.toHaveCount(0);
      await expect(panel).toContainText("service: api");
      await expect(panel).toContainText("port: 8000");
      await expect(panel).toContainText("health: /health");
      await expect(panel).not.toContainText("worker");
      const save = page.getByTestId("svc-save");
      await expect(page.getByTestId("svc-ack-panel")).toBeVisible();
      await expect(save).toBeDisabled();
      expect(fs.readFileSync(path.join(fixture.dir, "jgates.yml"), "utf8")).not.toContain("services:");
      await page.getByTestId("svc-ack").check();
      if (width === 375) await noSidewaysScroll(page, "services preview");
      await save.click();
      await expect(page.getByTestId("svc-saved")).toBeVisible();

      // The file, read back through the API and from disk.
      const written = parseYaml(fs.readFileSync(path.join(fixture.dir, "jgates.yml"), "utf8")) as { services: Record<string, any> };
      expect(written.services.compose).toEqual(["docker-compose.yml"]);
      expect(written.services.start).toEqual(["api", "db"]);
      expect(written.services.target).toEqual({ service: "api", port: 8000, path: "/api", health: "/health" });
      const api = await pageGet<any>(page, "/api/services");
      expect(api.configured).toBe(true);
      expect(api.config.target).toEqual({ service: "api", port: 8000, path: "/api", health: "/health" });
      expect(api.config.start).toEqual(["api", "db"]);
      expect(api.roles).toEqual({ api: "application", db: "dependency", worker: "unused" });
      // The acknowledgement is kept for this selection: no second question for the same files.
      expect(api.acknowledged).toBe(true);
      await goStep(page, "roles");
      await expect(role("worker")).toHaveValue("unused");
      await goStep(page, "review");
      await page.getByTestId("svc-preview").click();
      await expect(page.getByTestId("svc-ack-panel")).toHaveCount(0);
      await expect(page.getByTestId("svc-preview-panel")).toContainText("Nada muda");
    } finally {
      await server?.stop();
      fixture.cleanup();
    }
  });
}

test("making another service the application moves the role, a missing port blocks the preview, and the API refuses a stale revision and an unknown service", async ({ page }) => {
  const { fixture } = servicesFixture();
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    server = await startServer(fixture);
    const base = await openApp(page, server);
    await page.goto(`${base}#/config/services`);
    await goStep(page, "roles");
    await expect(page.getByTestId("svc-service")).toHaveCount(3);

    // Making a second service the application moves the role: only one service is under test.
    await page.getByTestId("svc-role-worker").selectOption("application");
    await expect(page.getByTestId("svc-role-api")).toHaveValue("dependency");
    await goStep(page, "target");
    await expect(page.getByTestId("svc-app-service")).toHaveValue("worker");
    // The worker declares no port: a number field appears, and the preview waits for it.
    expect(await page.getByTestId("svc-app-port").evaluate((el) => el.tagName)).toBe("INPUT");
    await goStep(page, "review");
    await expect(page.getByTestId("svc-preview")).toBeDisabled();
    await goStep(page, "target");
    await page.getByTestId("svc-app-port").fill("8080");
    await goStep(page, "review");
    await expect(page.getByTestId("svc-preview")).toBeEnabled();

    // The API refuses a stale revision and an unknown service with their codes.
    const refused = await page.evaluate(async () => {
      const session = (await (await fetch("/api/session")).json()) as { csrfHeader: string; csrfToken: string };
      const current = ((await (await fetch("/api/services")).json()) as { revision: string }).revision;
      const put = async (body: unknown) => {
        const r = await fetch("/api/services", { method: "PUT", headers: { "content-type": "application/json", [session.csrfHeader]: session.csrfToken }, body: JSON.stringify(body) });
        return { status: r.status, code: ((await r.json()) as { code?: string }).code };
      };
      return {
        stale: await put({ compose: ["docker-compose.yml"], roles: { api: "dependency" }, revision: "0".repeat(64) }),
        unknown: await put({ compose: ["docker-compose.yml"], roles: { ghost: "dependency" }, revision: current }),
      };
    });
    expect(refused.stale.status).toBe(409);
    expect(refused.stale.code).toBe("REVISION_CONFLICT");
    expect(refused.unknown).toEqual({ status: 422, code: "SERVICE_UNKNOWN" });
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
});

test("no screen of the services flow takes free text where the values are known (R2)", async ({ page }) => {
  const { fixture } = servicesFixture();
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    await page.setViewportSize({ width: 375, height: 900 });
    server = await startServer(fixture);
    const base = await openApp(page, server);
    await page.goto(`${base}#/config/services`);
    // The known sets are selects (role, service, port, timeout) or checkboxes (files, services, effects); every step is checked.
    await expect(page.getByRole("checkbox", { name: "docker-compose.yml" })).toBeVisible();
    expect(await expectNoKnownSetAsText(page, "body", "services files")).toBeGreaterThan(0);
    await goStep(page, "roles");
    await expect(page.getByTestId("svc-service")).toHaveCount(3);
    for (const testid of ["svc-role-db", "svc-role-api", "svc-role-worker"]) expect(await page.getByTestId(testid).evaluate((el) => el.tagName), testid).toBe("SELECT");
    await expectNoKnownSetAsText(page, "body", "services roles");
    await goStep(page, "target");
    for (const testid of ["svc-app-service", "svc-app-port"]) expect(await page.getByTestId(testid).evaluate((el) => el.tagName), testid).toBe("SELECT");
    expect(await expectNoKnownSetAsText(page, "body", "services target")).toBeGreaterThan(0);
    await goStep(page, "review");
    await page.getByTestId("svc-customize").locator("summary").click();
    expect(await page.getByTestId("svc-timeout").evaluate((el) => el.tagName)).toBe("SELECT");
    await expectNoKnownSetAsText(page, "body", "services review");

    // The declare-component dialog of the workspace (a language is chosen, never typed, unless "Outro…").
    await page.goto(`${base}#/workspace`);
    const declare = page.getByRole("button", { name: "Declarar componente" });
    await expect(declare).toBeVisible();
    await declare.click();
    const form = page.getByTestId("declare-form");
    await expect(form).toBeVisible();
    expect(await expectNoKnownSetAsText(page, '[data-testid="declare-form"]', "declare dialog")).toBeGreaterThan(0);
    expect(await form.locator("#ws-decl-language").evaluate((el) => el.tagName)).toBe("SELECT");
    expect(await form.locator("#ws-decl-framework").evaluate((el) => el.tagName)).toBe("SELECT");
  } finally {
    await server?.stop();
    fixture.cleanup();
  }
});
