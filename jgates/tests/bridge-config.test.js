// The sidecar of the quality gate (kept by the governed path and the legacy commands) still refuses a scanner
// configuration outside the workspace root. The per-scanner configuration bindings of the bridge instance in
// .jgates/tools.yml are retired with the bridge (the individual adapters bind their own configuration), so the
// plan-side tests of those bindings are gone; tests/bridge-retirement.test.js covers the migration.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const bridgeApi = await import(pathToFileURL(path.join(dist, "core", "bridge", "index.js")).href);

const VENV_PYTHON = path.resolve(here, "..", "..", ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");

function requirePython() {
  assert.ok(fs.existsSync(VENV_PYTHON), `the repository .venv is required: python3 -m venv .venv && .venv/bin/pip install -e quality-gate (looked for ${VENV_PYTHON})`);
  return VENV_PYTHON;
}

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("the bridge refuses a configuration path outside the workspace root with a structured error", async () => {
  const python = requirePython();
  const work = tmp("jgates-bridge-outside-");
  try {
    const target = path.join(work, "target");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "app.py"), "print('x')\n");
    fs.writeFileSync(path.join(work, "outside.toml"), 'title = "outside"\n');
    const request = { schemaVersion: 1, target, outputDir: path.join(work, "out"), mode: "full", secrets: true, subchecks: ["gitleaks"], toolConfigs: { gitleaks: "../outside.toml" } };
    const outcome = await bridgeApi.callBridge(request, { cwd: work, env: { PATH: "/usr/bin:/bin", JGATES_PYTHON: python, JGATES_IMAGE_JSON: process.env.JGATES_IMAGE_JSON } });
    assert.equal(outcome.kind, "response", outcome.message);
    assert.equal(outcome.exitCode, 3);
    assert.equal(outcome.response.ok, false);
    assert.deepEqual(outcome.response.error, {
      code: "config-outside-target",
      message: outcome.response.error.message,
      tool: "gitleaks",
      path: "../outside.toml",
    });
    assert.match(outcome.response.error.message, /outside the workspace root/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
