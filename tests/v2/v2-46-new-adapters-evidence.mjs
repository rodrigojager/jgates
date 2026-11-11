import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-46: every adapter this release added (format-check x5, file-size, golangci-lint, clippy, .NET analyzers, shellcheck,
// hadolint, go test, dotnet test, Jest, cargo-test coverage and integration, Playwright, Stryker.NET, migration drift,
// performance budgets, dotnet list package --vulnerable) detects its known-bad fixture and stays clean on the clean one,
// on each stack it declares validated. The proof is the matrix evidence (core/matrix/evidence.ts): a test whose title
// carries `[proves: <adapter>#<capability>]` for each validated capability-by-stack row, and for each stack both a
// known-bad verdict and a clean one. The matrix verifier checks the files and the titles exist; this case also pins which
// stacks each adapter must have, so dropping a row or its evidence fails here.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = (...parts) => import(pathToFileURL(path.join(root, "jgates", "dist", ...parts)).href);

/** adapter -> the stacks it must declare validated (the adapters added in this run). */
const ADDED = {
  "format-check": ["python", "typescript", "go", "rust", "csharp"],
  "file-size": ["any"],
  "golangci-lint": ["go"],
  clippy: ["rust"],
  "dotnet-analyzers": ["csharp"],
  shellcheck: ["any"],
  hadolint: ["any"],
  "go-test": ["go"],
  "dotnet-test": ["csharp"],
  jest: ["javascript"],
  "cargo-test": ["rust"],
  playwright: ["typescript", "python"],
  mutation: ["csharp"],
  "migration-drift": ["python", "typescript", "csharp", "any"],
  performance: ["python", "typescript", "go", "rust", "csharp"],
  "dotnet-vulnerable": ["csharp"],
};

// What a title says about the verdict of its fixture: the known-bad one is detected, the clean twin stays clean.
const BAD = /\b(flags?|fail(s|ed|ing)?|findings?|survivors?|weak|reports|drift|over|below|vulnerable|risky|leaves)\b/i;
const CLEAN = /\b(clean|twin|passes|agrees|safe|fast|strong|patched)\b/i;

test("V2-46: every adapter added in this run has registered [proves:] evidence for its known-bad and clean fixtures, per declared stack", async () => {
  const { buildMatrix, verifyMatrix, provedBy } = await load("core", "matrix", "index.js");
  const matrix = buildMatrix();
  // The whole matrix is consistent: every cited test file and title exists and carries its [proves: ...] marker.
  assert.deepEqual(verifyMatrix(matrix), []);

  const problems = [];
  for (const [adapter, stacks] of Object.entries(ADDED)) {
    const rows = matrix.rows.filter((r) => r.adapter === adapter && r.state === "validated");
    for (const stack of stacks) {
      const forStack = rows.filter((r) => r.stack === stack);
      if (forStack.length === 0) {
        problems.push(`${adapter}@${stack}: no validated row`);
        continue;
      }
      const titles = forStack.flatMap((r) => r.evidence.tests.map((ref) => ref.test));
      if (titles.length === 0) problems.push(`${adapter}@${stack}: validated without evidence tests`);
      if (!titles.some((title) => BAD.test(title))) problems.push(`${adapter}@${stack}: no test of the known-bad fixture (${titles.join(" | ")})`);
      if (!titles.some((title) => CLEAN.test(title))) problems.push(`${adapter}@${stack}: no test of the clean fixture (${titles.join(" | ")})`);
    }
    // Every validated row of the adapter has evidence that names the adapter's capability in a [proves: ...] marker.
    for (const row of rows) {
      assert.ok(row.evidence.tests.length > 0, `${row.key}: evidence tests`);
      assert.ok(row.evidence.tests.every((ref) => ref.file.endsWith(".test.js")), `${row.key}: evidence lives in the node test suite`);
    }
  }
  assert.deepEqual(problems, []);

  // The markers really sit in the titles of the cited tests (not only in the table): read them back from the test files.
  const fs = await import("node:fs");
  const { testTitles } = await load("core", "matrix", "index.js");
  const testsDir = path.join(root, "jgates", "tests");
  for (const adapter of Object.keys(ADDED)) {
    for (const row of matrix.rows.filter((r) => r.adapter === adapter && r.state === "validated" && (ADDED[adapter]).includes(r.stack))) {
      for (const ref of row.evidence.tests) {
        const titles = testTitles(fs.readFileSync(path.join(testsDir, ref.file), "utf8")).filter((title) => title.includes(ref.test));
        assert.ok(titles.length > 0, `${row.key}: "${ref.test}" is a test in ${ref.file}`);
        assert.ok(
          titles.some((title) => provedBy(title).some((m) => m === `${adapter}#${row.capability}` || m === row.key)),
          `${row.key}: the cited test says it proves ${adapter}#${row.capability}`,
        );
      }
    }
  }
});
