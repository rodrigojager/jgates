import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { concludeExit, loadLinters } from "../dist/adapters/linter/index.js";
import { readerOf } from "../dist/adapters/linter/readers.js";

const recording = (name) => JSON.parse(fs.readFileSync(
  new URL(`./fixtures/linters/git-diff-check/recorded/${name}.json`, import.meta.url), "utf8",
));

test("git diff check ignores repository metadata and keeps source findings", async () => {
  const { descriptor } = loadLinters({}).find(({ descriptor }) => descriptor.id === "git-diff-check");
  const read = await readerOf(descriptor);
  const metadata = recording("metadata");
  const result = read({ text: metadata.stdout, other: metadata.stderr, exitCode: metadata.exit }, descriptor.output);
  assert.deepEqual(result, { ok: true, findings: [] });
  assert.equal(concludeExit(result.findings.length, metadata.exit, descriptor.run.exit), null);

  const source = recording("bad").calls[0];
  const mixed = read({ text: source.stdout + metadata.stdout, other: source.stderr, exitCode: source.exit }, descriptor.output);
  assert.equal(mixed.ok, true);
  assert.equal(mixed.findings.length, 4);
  assert.ok(mixed.findings.every(({ file }) => file === "./merge-notes.txt"));
  assert.equal(read({ text: "", other: "", exitCode: 3 }, descriptor.output).ok, false);
});
