"use strict";

// V2 real-engine acceptance harness. Every tests/v2-docker/*.mjs module is a case file that registers its own
// `test(...)` calls when imported (cases V2-33 to V2-60 that need a real container engine); this file only imports
// them, in name order, so their tests run here as top-level tests. Run it from the repository root with
// `node --test --test-reporter=tap tests/v2.docker-acceptance.test.js`. A module that fails to import fails the
// harness test below instead of being skipped. Case tests import the built output (jgates/dist), so build first.
// JGATES_V2_DOCKER_CASES_DIR points the harness at another folder (used by the harness's own tests).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const casesDir = process.env.JGATES_V2_DOCKER_CASES_DIR ? path.resolve(process.env.JGATES_V2_DOCKER_CASES_DIR) : path.join(__dirname, "v2-docker");

const caseFiles = fs.existsSync(casesDir)
  ? fs
      .readdirSync(casesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
      .map((entry) => entry.name)
      .sort()
  : [];

// The imports start here, outside any test, so the tests a case module registers are top-level tests of this file.
const failures = [];
const loaded = (async () => {
  for (const name of caseFiles) {
    try {
      await import(pathToFileURL(path.join(casesDir, name)).href);
    } catch (error) {
      failures.push({ name, error });
    }
  }
})();

test("docker acceptance harness imports every case module", async (t) => {
  await loaded;
  t.diagnostic(`case modules found: ${caseFiles.length}, imported: ${caseFiles.length - failures.length}`);
  assert.deepEqual(
    failures.map(({ name, error }) => `${name} failed to import: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`),
    [],
  );
});
