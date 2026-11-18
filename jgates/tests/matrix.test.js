import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const repo = path.resolve(here, "..", "..");
const mx = await import(pathToFileURL(path.join(dist, "core", "matrix", "index.js")).href);
const { builtinManifests } = await import(pathToFileURL(path.join(dist, "adapters", "manifests.js")).href);
const linterEngine = await import(pathToFileURL(path.join(dist, "adapters", "linter", "index.js")).href);

function cliMatrix() {
  const r = spawnSync(process.execPath, [MAIN, "tools", "matrix", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function docBlock(lang) {
  const text = fs.readFileSync(path.join(repo, "docs", "jgates", `compatibility.${lang}.md`), "utf8");
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
  // Container-first: every adapter runs in the JGates tools image's step container.
  assert.deepEqual(ruff.runners, ["container"]);
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
          // linters.test.js makes one test per linter descriptor, titled by linterTestTitle: those titles are generated.
          const generated = ref.file === linterEngine.LINTERS_TEST_FILE ? linterEngine.loadLinters().map((l) => linterEngine.linterTestTitle(l.descriptor)).join("\n") : "";
          const file = fs.readFileSync(path.join(here, ref.file), "utf8") + generated;
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

const STATES = ["validated", "customer-setup-required", "unsupported", "not-applicable"];

test("tools matrix --json lists capability-by-stack rows keyed by adapter, capability and stack, each with a state and an evidence reference", () => {
  const doc = cliMatrix();
  const rows = doc.matrix.rows;
  assert.ok(rows.length > 0);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, "row keys are unique");
  for (const r of rows) {
    assert.equal(r.key, `${r.adapter}#${r.capability}@${r.stack}`);
    assert.ok(STATES.includes(r.state), r.key);
    assert.ok(Array.isArray(r.evidence.tests), `${r.key} has an evidence reference`);
    if (r.state === "validated") assert.ok(r.evidence.tests.length > 0, `${r.key} is validated by a test`);
    else assert.ok(r.limitations.length > 0, `${r.key} states what it does not cover`);
  }
  const row = (key) => rows.find((r) => r.key === key);
  assert.equal(row("ruff#lint@python").state, "validated");
  assert.deepEqual(row("ruff#lint@python").evidence.tests.map((x) => x.file), ["adapter-ruff.test.js"]);
  assert.equal(row("ruff#lint@python").distribution, "customer-supplied");
  assert.equal(row("eslint#lint@typescript").state, "validated");
  assert.equal(row("eslint#lint@javascript").state, "customer-setup-required");
  assert.equal(row("gitleaks#secrets@any").state, "validated");
  // The eight languages of the bundled Semgrep pack are validated, each by the test of its own twin; any other stays customer setup.
  for (const stack of ["python", "javascript", "typescript", "go", "csharp", "rust", "java", "php"]) assert.equal(row(`semgrep#sast@${stack}`).state, "validated", stack);
  for (const stack of ["go", "csharp", "rust", "java", "php"]) assert.ok(row(`semgrep#sast@${stack}`).evidence.tests.every((x) => x.file === "adapter-semgrep.test.js"), stack);
  assert.equal(row("semgrep#sast@any").state, "customer-setup-required");
  assert.match(row("semgrep#sast@any").limitations.join(" "), /Java and PHP/);
  const bridgeLint = row("quality-bridge#lint@any");
  assert.equal(bridgeLint.state, "customer-setup-required");
  assert.deepEqual(bridgeLint.evidence.tests, []);
  assert.match(bridgeLint.evidence.note.en, /Docker smoke of the bridge/);
  // Every capability a manifest announces has at least one row.
  for (const a of doc.matrix.adapters) for (const c of a.capabilities) assert.ok(rows.some((r) => r.adapter === a.id && r.capability === c.id), `${a.id}#${c.id} has a row`);
  for (const a of doc.matrix.adapters) assert.ok(a.distribution && a.distribution.mode, `${a.id} has distribution metadata`);
});

test("a row claiming validated support without an evidence test makes verifyMatrix fail", () => {
  // A manifest that claims Ruff lint is validated on Go, with no test for that stack in the evidence table.
  const manifests = builtinManifests().map((m) => (m.id === "ruff" ? { ...m, stackSupport: [...m.stackSupport, { capability: "lint", stack: "go", state: "validated" }] } : m));
  const problems = mx.verifyMatrix(mx.buildMatrix(manifests));
  assert.ok(problems.some((p) => p.startsWith("ruff#lint@go: validated without an evidence test")), problems.join("\n"));

  // The same row with its evidence removed from the matrix document.
  const matrix = mx.buildMatrix();
  matrix.rows.find((r) => r.key === "pytest#unit@python").evidence.tests = [];
  assert.ok(mx.verifyMatrix(matrix).some((p) => p.startsWith("pytest#unit@python: validated without an evidence test")));

  // Evidence that cites a test whose title does not say it proves the capability does not count.
  const cited = mx.buildMatrix();
  cited.rows.find((r) => r.key === "ruff#lint@python").evidence.tests = [{ file: "adapters-security.test.js", test: "Checkov 3.3.8" }];
  assert.ok(mx.verifyMatrix(cited).some((p) => p.startsWith("ruff#lint@python") && p.includes("[proves: ruff#lint]")));
});

test("a capability without a stack row, a non-validated row without a limitation and an adapter without distribution metadata fail the verification", () => {
  const manifests = builtinManifests().map((m) => {
    if (m.id === "ruff") return { ...m, stackSupport: [] };
    if (m.id === "eslint") return { ...m, stackSupport: m.stackSupport.map((r) => ({ ...r, limitations: [] })) };
    if (m.id === "jscpd") {
      const { distribution, ...rest } = m;
      return rest;
    }
    return m;
  });
  const problems = mx.verifyMatrix(mx.buildMatrix(manifests));
  assert.ok(problems.some((p) => p.startsWith("ruff#lint: no capability-by-stack row")), problems.join("\n"));
  assert.ok(problems.some((p) => p.startsWith("eslint#lint@javascript: state customer-setup-required without a stated limitation")), problems.join("\n"));
  assert.ok(problems.some((p) => p.startsWith("jscpd: no distribution metadata")), problems.join("\n"));
});

test("tools matrix --units gives each unit of a mixed repository the rows of its own stack plus the stack-independent ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-matrix-units-"));
  try {
    const write = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    write("api/pyproject.toml", '[project]\nname = "api"\nversion = "0.1.0"\n');
    write("api/app.py", "print('api')\n");
    write("web/package.json", JSON.stringify({ name: "web", private: true, devDependencies: { typescript: "^5.0.0" } }) + "\n");
    write("web/tsconfig.json", "{}\n");
    write("web/src/index.ts", "export const x = 1;\n");
    const r = spawnSync(process.execPath, [MAIN, "tools", "matrix", "--units", "--json", "--cwd", dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    const api = doc.applicability.find((u) => u.componentRoot === "api");
    const web = doc.applicability.find((u) => u.componentRoot === "web");
    assert.ok(api && web, JSON.stringify(doc.applicability.map((u) => [u.componentRoot, u.language])));
    assert.equal(api.language, "python");
    assert.equal(web.language, "typescript");
    const keys = (u) => u.rows.map((x) => x.key);
    assert.ok(keys(api).includes("ruff#lint@python") && !keys(api).includes("eslint#lint@typescript"));
    assert.ok(keys(web).includes("eslint#lint@typescript") && !keys(web).includes("ruff#lint@python"));
    for (const u of [api, web]) assert.ok(keys(u).includes("gitleaks#secrets@any"), `${u.componentRoot} gets the stack-independent rows`);
    assert.ok(api.validated.includes("architecture") && web.validated.includes("architecture"));
    for (const u of [api, web]) for (const gap of u.gaps) assert.ok(!u.validated.includes(gap));
    // Without --units the document has no applicability (the matrix alone stays machine-independent).
    assert.equal(cliMatrix().applicability, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tools matrix --units shows sast validated for a Java unit and a PHP unit, and for them only the stack-independent rows besides", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-matrix-units-jp-"));
  try {
    const write = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    write("svc/pom.xml", "<project><modelVersion>4.0.0</modelVersion></project>\n");
    write("svc/src/Main.java", "class Main {}\n");
    write("site/composer.json", '{"name":"acme/site"}\n');
    write("site/index.php", "<?php echo 'ok';\n");
    const r = spawnSync(process.execPath, [MAIN, "tools", "matrix", "--units", "--json", "--cwd", dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    for (const [root, language] of [["svc", "java"], ["site", "php"]]) {
      const unit = doc.applicability.find((u) => u.componentRoot === root);
      assert.ok(unit, JSON.stringify(doc.applicability.map((u) => [u.componentRoot, u.language])));
      assert.equal(unit.language, language);
      assert.ok(unit.validated.includes("sast"), `${language} has sast validated`);
      assert.ok(unit.rows.some((x) => x.key === `semgrep#sast@${language}` && x.state === "validated"));
      assert.ok(!unit.validated.includes("lint") || unit.rows.every((x) => x.capability !== "lint" || x.stack === "any"), `${language} has no language lint row`);
      assert.ok(unit.gaps.includes("unit") || unit.gaps.includes("tests") || unit.gaps.length > 0, `${language} keeps its gaps visible`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the tools API returns the same capability-by-stack matrix and the applicability of the served project", async () => {
  const { routes } = await import(pathToFileURL(path.join(dist, "server", "routes", "tools.js")).href);
  const route = routes.find((r) => r.method === "GET" && r.path === "/api/tool-matrix");
  assert.ok(route, "GET /api/tool-matrix exists");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-matrix-api-"));
  try {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "x"\nversion = "0.1.0"\n');
    const res = await route.handler({ server: { projectDir: dir, log() {} }, params: {}, query: {}, body: undefined });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.problems, []);
    assert.deepEqual(res.json.matrix.rows, cliMatrix().matrix.rows);
    assert.ok(res.json.applicability.some((u) => u.language === "python" && u.rows.some((x) => x.key === "pytest#unit@python")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
