"use strict";

// V2 acceptance harness. Every tests/v2/*.mjs module is a case file that registers its own `test(...)` calls when
// imported; this file only imports them, in name order, so their tests run here as top-level tests. Run it from the
// repository root with `node --test --test-reporter=tap tests/v2.acceptance.test.js` (no `--import` needed). A module that fails to import
// fails the harness test below instead of being skipped. Case tests import the built output (jgates/dist,
// semantic-gate/dist), so build both packages first. JGATES_V2_CASES_DIR points the harness at another folder (used
// by the harness's own tests).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const casesDir = process.env.JGATES_V2_CASES_DIR ? path.resolve(process.env.JGATES_V2_CASES_DIR) : path.join(__dirname, "v2");

const caseFiles = fs.existsSync(casesDir)
  ? fs
      .readdirSync(casesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
      .map((entry) => entry.name)
      .sort()
  : [];

// The node test environment of JGates (in-image mode with the package's image.json mirror and no real engine client by
// default; jgates/tests/setup/in-image.mjs) is loaded here as well, so the harness behaves the same whether it runs
// bare (`node --test tests/v2.acceptance.test.js`) or under `npm test`, which also passes it with `--import`. Cases of
// the container mode clear JGATES_IMAGE_JSON and name the fake engine themselves.
const inImageSetup = path.join(__dirname, "..", "jgates", "tests", "setup", "in-image.mjs");

// The imports start here, outside any test, so the tests a case module registers are top-level tests of this file.
const failures = [];
const loaded = (async () => {
  try {
    await import(pathToFileURL(inImageSetup).href);
  } catch (error) {
    failures.push({ name: "jgates/tests/setup/in-image.mjs", error });
  }
  for (const name of caseFiles) {
    try {
      await import(pathToFileURL(path.join(casesDir, name)).href);
    } catch (error) {
      failures.push({ name, error });
    }
  }
})();

// The root of the run waits for every import before its first test. Otherwise, when a name pattern filters out the
// test below, the root ends while a case test is still running and runs the cases' `after` hooks (their temporary
// folders are removed under the running test).
test.before(() => loaded);

test("acceptance harness imports every case module", async (t) => {
  await loaded;
  t.diagnostic(`case modules found: ${caseFiles.length}, imported: ${caseFiles.length - failures.length}`);
  assert.deepEqual(
    failures.map(({ name, error }) => `${name} failed to import: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`),
    [],
  );
});
