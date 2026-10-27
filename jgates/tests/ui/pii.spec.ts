import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAIN, PYTHON, REPO, sha256, startServer, type Fixture } from "./support";

// The PII screen in the browser: turn one entity off, and the pii.yml on disk says so (and only that).

const require = createRequire(import.meta.url);
const { createPiiFixture, removePiiFixture } = require(path.join(REPO, "tests", "fixtures", "jgates", "pii-fixture.js"));

function piiWorkspace(): { fixture: Fixture; values: Record<string, string>; piiFile: string } {
  const pii = createPiiFixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ui-pii-home-"));
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ui-pii-bin-"));
  const env: NodeJS.ProcessEnv = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, PATH: emptyBin };
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", pii.dir, "--profile", "standard", "--no-interactive", "--json"], { env, encoding: "utf8", timeout: 120_000 });
  if (init.status !== 0) throw new Error(`jgates init failed: ${init.stdout}${init.stderr}`);
  const piiFile = path.join(pii.dir, ".jgates", "pii.yml");
  // A comment the patch must keep.
  fs.writeFileSync(piiFile, "# PII settings of the demo workspace\nschemaVersion: 1\nentities:\n  cnpj:\n    severity: high # keep this\n");
  const fixture: Fixture = {
    dir: pii.dir,
    home,
    pyproject: "",
    env,
    cleanup() {
      removePiiFixture(pii.dir);
      for (const d of [home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
  return { fixture, values: pii.values, piiFile };
}

test("turn the CPF entity off in the PII screen: pii.yml on disk changes only there, comments stay, no raw value reaches the API", async ({ page }) => {
  const { fixture, values, piiFile } = piiWorkspace();
  const server = await startServer(fixture);
  try {
    await page.goto(server.bootstrapUrl);
    await expect(page.getByRole("navigation", { name: "Navegação principal" })).toBeVisible();
    await page.goto(page.url().split("#")[0] + "#/tools/builtin-pii");
    await expect(page.getByRole("heading", { name: "Dados pessoais (PII)", level: 1 })).toBeVisible();

    const table = page.getByRole("table", { name: "Entidades de PII" });
    // Phone is off by default; the entity with no detector is "not supported" and has no switch.
    await expect(table.getByRole("checkbox", { name: "Detectar Telefone" })).not.toBeChecked();
    await expect(table.getByRole("checkbox", { name: "Detectar CPF" })).toBeChecked();
    const unsupported = table.locator('tr[data-entity="email"]');
    await expect(unsupported).toContainText("Não suportado");
    await expect(unsupported.getByRole("checkbox")).toHaveCount(0);
    // Options the detector cannot honor are shown as unavailable, never as a working switch.
    await expect(page.getByRole("checkbox", { name: "Mascarar o valor encontrado" })).toBeDisabled();
    await expect(page.getByLabel("Modo de remediação")).toBeDisabled();
    await expect(page.locator('option[value="en-US"]')).toHaveAttribute("disabled", "");

    const before = fs.readFileSync(piiFile, "utf8");
    await table.getByRole("checkbox", { name: "Detectar CPF" }).click();
    await expect(page.getByTestId("pii-status")).toContainText("Alteração gravada em .jgates/pii.yml");
    await expect(table.getByRole("checkbox", { name: "Detectar CPF" })).not.toBeChecked();

    const after = fs.readFileSync(piiFile, "utf8");
    expect(after).not.toBe(before);
    expect(after).toContain("# PII settings of the demo workspace");
    expect(after).toContain("severity: high # keep this");
    expect(after).toMatch(/cpf:\s*\n\s+enabled: false/);
    // Nothing else changed: removing the cpf block gives the original back.
    expect(after.replace(/\n  cpf:\n    enabled: false/, "")).toBe(before);
    expect(sha256(after)).not.toBe(sha256(before));

    // The API answers with the state and never with a raw value.
    const response = await page.request.get(new URL("/api/pii", page.url()).href);
    const text = await response.text();
    for (const value of Object.values(values)) {
      expect(text).not.toContain(value);
      expect(text).not.toContain(value.replace(/\D/g, ""));
    }
    expect(JSON.parse(text).entities.find((e: any) => e.id === "cpf").enabled).toBe(false);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
