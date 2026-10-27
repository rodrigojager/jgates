import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const repo = path.resolve(here, "..", "..");
const mx = await import(path.join(dist, "core", "matrix", "index.js"));
const { builtinManifests } = await import(path.join(dist, "adapters", "manifests.js"));

function cliMatrix() {
  const r = spawnSync(process.execPath, [MAIN, "tools", "matrix", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function docBlock(lang) {
  const text = fs.readFileSync(path.join(repo, "docs", "jgates", `compatibilidade.${lang}.md`), "utf8");
  const a = text.indexOf(mx.MATRIX_START);
  const b = text.indexOf(mx.MATRIX_END);
  assert.ok(a >= 0 && b > a, `markers missing in the ${lang} document`);
  return { text, block: text.slice(a + mx.MATRIX_START.length, b).replace(/^\n/, "") };
}

test("tools matrix --json lists every adapter with capabilities, support level and the test that proves each integrated capability", () => {
  const doc = cliMatrix();
  assert.equal(doc.status, "OK");
  assert.deepEqual(doc.problems, []);
  const ids = doc.matrix.adapters.map((a) => a.id);
  assert.deepEqual(ids, builtinManifests().map((m) => m.id));
  for (const a of doc.matrix.adapters) {
    assert.ok(a.supportLevel, `${a.id} has a support level`);
    for (const c of a.capabilities) {
      if (c.status === "integrated") assert.ok(c.tests.length > 0, `${a.id}#${c.id} names a test`);
    }
  }
  const ruff = doc.matrix.adapters.find((a) => a.id === "ruff");
  assert.equal(ruff.supportLevel, "assisted");
  assert.deepEqual(ruff.capabilities.map((c) => c.id), ["lint"]);
  assert.deepEqual(ruff.runners, ["local", "container"]);
  // Proven by core-followups.test.js (the recorded license report); the bridge scanners are the declared ones now.
  assert.equal(doc.matrix.adapters.find((a) => a.id === "trivy").capabilities.find((c) => c.id === "licenses").status, "integrated");
  assert.equal(doc.matrix.adapters.find((a) => a.id === "quality-bridge").capabilities.find((c) => c.id === "lint").status, "declared");
});

test("every capability a manifest announces has an existing test or a stated reason, and every adapter a limitation", () => {
  const matrix = mx.buildMatrix();
  assert.deepEqual(mx.verifyMatrix(matrix), []);
  for (const m of builtinManifests()) {
    const row = matrix.adapters.find((a) => a.id === m.id);
    assert.deepEqual(row.capabilities.map((c) => c.id), m.capabilities, `${m.id} capabilities come from the manifest`);
    assert.ok(row.limitation.en.length > 0 && row.limitation.ptBR.length > 0, `${m.id} has a limitation in both languages`);
    for (const c of row.capabilities) {
      if (c.status === "integrated") {
        for (const ref of c.tests) {
          const file = fs.readFileSync(path.join(here, ref.file), "utf8");
          assert.ok(file.includes(ref.test), `${m.id}#${c.id}: "${ref.test}" is in ${ref.file}`);
        }
      }
    }
  }
});

test("a manifest that announces a capability with no test reference makes the verification fail", () => {
  const manifests = builtinManifests().map((m) => (m.id === "ruff" ? { ...m, capabilities: [...m.capabilities, "sast"] } : m));
  const problems = mx.verifyMatrix(mx.buildMatrix(manifests));
  assert.ok(problems.some((p) => p.startsWith("ruff#sast")), problems.join("\n"));
});

test("a reference to a test file or title that does not exist fails the verification", () => {
  const matrix = mx.buildMatrix();
  const ruff = matrix.adapters.find((a) => a.id === "ruff");
  ruff.capabilities[0].tests = [{ file: "no-such-file.test.js", test: "x" }, { file: "adapter-ruff.test.js", test: "title that is not there" }];
  const problems = mx.verifyMatrix(matrix);
  assert.ok(problems.some((p) => p.includes("no-such-file.test.js does not exist")));
  assert.ok(problems.some((p) => p.includes("title that is not there")));
});

test("an adapter without a described limitation fails the verification", () => {
  const matrix = mx.buildMatrix();
  matrix.adapters.find((a) => a.id === "jscpd").limitation = { en: "", ptBR: "" };
  assert.ok(mx.verifyMatrix(matrix).some((p) => p.startsWith("jscpd: no limitation")));
});

test("the stacks table declares Go, Rust and .NET as partial support", () => {
  const stacks = cliMatrix().matrix.stacks;
  for (const id of ["go", "rust", "dotnet"]) {
    const s = stacks.find((x) => x.id === id);
    assert.ok(s, `${id} stack`);
    assert.equal(s.support, "partial");
    assert.ok(s.uncovered.length > 0);
  }
  assert.equal(stacks.find((x) => x.id === "python").support, "full");
});

test("the documentation has the matrix in both languages, equal to the tools matrix output, with the macOS note and Go and Rust as partial", () => {
  const matrix = cliMatrix().matrix;
  for (const lang of ["pt-BR", "en"]) {
    const { text, block } = docBlock(lang);
    assert.equal(
      block,
      mx.renderMatrixMarkdown(matrix, lang),
      `the ${lang} table differs from \`jgates tools matrix\`: regenerate the documents with \`npm --prefix jgates run build && npm --prefix jgates run docs:compat\` (or check them with \`node jgates/scripts/gen-compat-docs.mjs --check\`) and commit them`,
    );
    assert.match(text, lang === "en" ? /macOS: not tested on real hardware/ : /macOS: não testado em máquina real/);
    assert.match(text, /Go/);
    assert.match(text, /Rust/);
    assert.match(text, lang === "en" ? /partial support/i : /suporte parcial/i);
  }
});

test("the generator script is wired to `npm run docs:compat` and finds both documents up to date", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts["docs:compat"], "node scripts/gen-compat-docs.mjs");
  const r = spawnSync(process.execPath, [path.join(here, "..", "scripts", "gen-compat-docs.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
