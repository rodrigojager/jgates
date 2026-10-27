import { expect, test } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAIN, createFixture, startServer } from "./support";

// The Environment screen shows the same diagnosis as `jgates doctor`, and "Preparar" shows the versions and the
// network before it downloads the rules, stores them by hash and pins the hash in the lock file.

const RULES = "rules:\n  - id: no-eval\n    message: no eval\n    severity: ERROR\n    languages: [python]\n    pattern: eval(...)\n";

async function startRegistry(): Promise<{ url: string; stop(): void }> {
  const script = `const http=require("http");const s=http.createServer((q,r)=>{r.setHeader("Content-Type","application/yaml");r.end(${JSON.stringify(RULES)});});s.listen(0,"127.0.0.1",()=>console.log("port "+s.address().port));`;
  const child: ChildProcess = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    let seen = "";
    child.stdout?.on("data", (d) => {
      seen += String(d);
      const m = /port (\d+)/.exec(seen);
      if (m) resolve(Number(m[1]));
    });
  });
  return { url: `http://127.0.0.1:${port}/c/p/default`, stop: () => void child.kill() };
}

test("Ambiente shows the doctor diagnosis and Preparar shows versions and network before it downloads", async ({ page }) => {
  const fixture = createFixture();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ui-semgrep-"));
  const registry = await startRegistry();
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    const fake = path.join(bin, "semgrep");
    fs.writeFileSync(fake, '#!/bin/sh\necho "semgrep 1.120.0"\n', { mode: 0o755 });
    fixture.env.JGATES_SEMGREP = fake;
    fixture.env.JGATES_SEMGREP_RULES_URL = registry.url;
    fs.writeFileSync(
      path.join(fixture.dir, ".jgates", "tools.yml"),
      "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    config: pyproject.toml\n  semgrep:\n    adapter: semgrep\n    capabilities: [sast]\n",
    );
    server = await startServer(fixture);
    await page.goto(server.bootstrapUrl);
    await page.getByRole("link", { name: "Ambiente" }).click();
    await expect(page.getByRole("heading", { name: "Ambiente", level: 1 })).toBeVisible();

    // The same states as the CLI doctor.
    const doctor = spawnSync(process.execPath, [MAIN, "doctor", "--cwd", fixture.dir, "--json"], { env: fixture.env, encoding: "utf8" });
    const diagnosis = JSON.parse(doctor.stdout);
    const label: Record<string, string> = { ready: "Pronto", absent: "Ausente", incompatible: "Versão incompatível", not_checked: "Não verificado" };
    for (const r of diagnosis.runtimes) {
      await expect(page.locator(`tr[data-runtime="${r.id}"]`)).toContainText(label[r.state] as string);
    }
    for (const x of diagnosis.tools) {
      const row = page.locator(`tr[data-tool="${x.instance}"]`);
      await expect(row).toContainText(label[x.state] as string);
      if (x.version) await expect(row).toContainText(x.version);
    }
    await expect(page.getByTestId("env-summary")).toContainText(diagnosis.environmentReady ? "Ambiente pronto." : "pendências");

    // Preparar: versions and network first, nothing written yet.
    expect(fs.existsSync(path.join(fixture.dir, ".jgates", "lock.json"))).toBe(false);
    await page.getByRole("button", { name: "Preparar semgrep" }).click();
    await expect(page.getByTestId("prepare-versions")).toContainText("1.120.0");
    await expect(page.getByTestId("prepare-versions")).toContainText(">=1.100.0");
    await expect(page.getByTestId("prepare-network")).toContainText(registry.url);
    expect(fs.existsSync(path.join(fixture.dir, ".jgates", "lock.json"))).toBe(false);

    await page.getByRole("button", { name: "Baixar e fixar" }).click();
    await expect(page.getByTestId("prepare-done")).toBeVisible();
    const lock = JSON.parse(fs.readFileSync(path.join(fixture.dir, ".jgates", "lock.json"), "utf8"));
    const hash = lock.tools.semgrep.rules[0].hash as string;
    expect(fs.existsSync(path.join(fixture.home, "tools", hash, "p-default.yml"))).toBe(true);
    await page.getByRole("button", { name: "Fechar" }).first().click();
    await expect(page.locator('tr[data-tool="semgrep"]')).toContainText(hash.slice(0, 12));
  } finally {
    await server?.stop();
    registry.stop();
    fixture.cleanup();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
