import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { concludeExit, loadLinters } from "../dist/adapters/linter/index.js";
import { readerOf } from "../dist/adapters/linter/readers.js";

test("v8r distinguishes files excluded by ignore rules from an unreadable report", async () => {
  const { descriptor } = loadLinters({}).find(({ descriptor }) => descriptor.id === "v8r");
  const recording = JSON.parse(fs.readFileSync(new URL("./fixtures/linters/v8r/recorded/ignored.json", import.meta.url), "utf8"));
  const read = await readerOf(descriptor);
  const input = { text: recording.stdout, other: recording.stderr, exitCode: recording.exit };
  const result = read(input, descriptor.output);
  assert.deepEqual(result, { ok: true, findings: [] });
  assert.equal(concludeExit(result.findings.length, input.exitCode, descriptor.run.exit), null);
  assert.equal(read({ ...input, other: "" }, descriptor.output).ok, false);
});
