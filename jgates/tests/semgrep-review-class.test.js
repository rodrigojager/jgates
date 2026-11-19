import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parseSemgrepOutput, buildPackIndex } = await import(pathToFileURL(path.join(root, "dist/adapters/semgrep/index.js")).href);
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020").default;
const recorded = (id, severity = "INFO") => JSON.stringify({
  results: [{ check_id: id, path: "src/app.py", start: { line: 2, col: 1 }, end: { line: 2, col: 9 }, extra: { message: "Check the regular expression.", severity, metadata: { class: "review" } } }],
  errors: [],
});
const options = { stageId: "semgrep#sast", version: "1.182.1", workspace: root, cwd: root };
const temp = () => fs.mkdtempSync(path.join(process.env.JGATES_TEST_TMP ?? os.tmpdir(), "jgates-review-"));

test("Review from the pack is non-blocking, distinct from ordinary INFO, and resolves Semgrep prefixes", () => {
  const dir = temp();
  try {
    const source = parse(fs.readFileSync(path.join(root, "packs/semgrep/jgates-semgrep/rules/python-encoding.yaml"), "utf8")).rules[0];
    source.severity = "INFO";
    source.metadata.class = "review";
    fs.writeFileSync(path.join(dir, "python-encoding.yaml"), stringify({ rules: [source] }));
    const index = buildPackIndex(dir);
    assert.deepEqual(index.problems, []);
    assert.equal(index.rules[0].class, "review");
    const packReviewRules = new Set(index.rules.filter((r) => r.class === "review").map((r) => r.id));
    const [ordinary] = parseSemgrepOutput(recorded(source.id), { ...options, packReviewRules: new Set() }).findings;
    assert.equal(ordinary.informational, true, "the same INFO result without the pack class stays informational");
    assert.equal(Object.hasOwn(ordinary, "review"), false);
    for (const id of [source.id, `tmp.rules.python.${source.id}`]) {
      for (const severity of ["INFO", "WARNING", "ERROR"]) {
        const parsed = parseSemgrepOutput(recorded(id, severity), { ...options, packReviewRules });
        assert.equal(parsed.ok, true, parsed.problem);
        const [finding] = parsed.findings;
        assert.equal(finding.review, true);
        assert.equal(finding.blocking, false);
        assert.equal(Object.hasOwn(finding, "blockingReason"), false);
        assert.equal(Object.hasOwn(finding, "informational"), false);
      }
    }
    // Scanner metadata alone cannot declare an outside rule Review.
    for (const extra of [{}, { packReviewRules: new Set() }, { packReviewRules }]) {
      const [finding] = parseSemgrepOutput(recorded("outside.info-rule"), { ...options, ...extra }).findings;
      assert.equal(finding.informational, true);
      assert.equal(Object.hasOwn(finding, "review"), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the finding schema accepts Review and documents its exclusion of informational", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas/result/result.schema.json"), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/finding`);
  assert.ok(validate);
  const [finding] = parseSemgrepOutput(recorded("jgates.python.sample"), { ...options, packReviewRules: new Set(["jgates.python.sample"]) }).findings;
  assert.ok(validate(finding), ajv.errorsText(validate.errors));
  assert.match(schema.$defs.finding.properties.review.description, /excludes informational/);
});

// Opt in because this is a real engine check, not part of the engine-free normalizer unit tests.
test("pack:check accepts Review on a copied pack and names all four invalid declarations", { skip: process.env.JGATES_TEST_REVIEW_PACK !== "1", timeout: 240_000 }, () => {
  const dir = temp();
  const copy = (rel) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.cpSync(path.join(root, rel), path.join(dir, rel), { recursive: true });
  };
  try {
    for (const rel of ["src/adapters/semgrep/pack-lists.json", "vendor/owasp-asvs/5.0.0", "tests/fixtures/semgrep-pack"]) copy(rel);
    const rel = "packs/semgrep/jgates-semgrep/rules/python-encoding.yaml";
    copy(rel);
    copy(rel.replace(".yaml", ".py"));
    const [original, ...otherRules] = parse(fs.readFileSync(path.join(dir, rel), "utf8")).rules;
    const run = (rule) => {
      fs.writeFileSync(path.join(dir, rel), stringify({ rules: [rule, ...otherRules] }));
      return spawnSync(process.execPath, [path.join(root, "scripts/pack-check.mjs"), "python", "encoding"], {
        encoding: "utf8", timeout: 90_000, env: { ...process.env, JGATES_PACK_CHECK_ROOT: dir },
      });
    };
    const review = { ...original, severity: "INFO", metadata: { ...original.metadata, class: "review" } };
    const valid = run(review);
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    for (const [rule, message] of [
      [{ ...review, severity: "WARNING" }, "severity INFO"],
      [{ ...review, metadata: { ...review.metadata, class: "unknown" } }, "class must be review"],
      [{ ...review, metadata: { ...review.metadata, signal: "jwt" } }, "signal rule cannot have class"],
      [{ ...original, id: `${original.id}-by-default` }, "must have class: review"],
    ]) {
      const result = run(rule);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok((result.stdout + result.stderr).includes(`${rule.id}:`), result.stdout + result.stderr);
      assert.ok((result.stdout + result.stderr).includes(message), result.stdout + result.stderr);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
