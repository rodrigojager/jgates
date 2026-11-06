import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// What `jgates run` prints while it runs: pretty for a person at a terminal, plain (no ANSI, no decoration) for an
// agent, a log or CI, with a "still running" line a minute so a long step never looks hung.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (...p) => pathToFileURL(path.resolve(here, "..", "dist", ...p)).href;
const { terminalStyle, formatElapsed, RunProgress, paint } = await import(dist("cli", "terminal.js"));

const ANSI = /\u001b\[/;
const event = (type, data) => ({ schemaVersion: 1, runId: "run_x", sequence: 0, type, at: new Date().toISOString(), data });

test("pretty only at a terminal with nothing asking for plain; --pretty forces it, --plain, NO_COLOR, CI and dumb terminals turn it off", () => {
  assert.deepEqual(terminalStyle({}, {}, true), { color: true, live: true });
  assert.deepEqual(terminalStyle({}, {}, false), { color: false, live: false });
  assert.deepEqual(terminalStyle({ plain: true }, {}, true), { color: false, live: false });
  assert.deepEqual(terminalStyle({}, { NO_COLOR: "1" }, true), { color: false, live: false });
  assert.deepEqual(terminalStyle({}, { CI: "true" }, true), { color: false, live: false });
  assert.deepEqual(terminalStyle({}, { CI: "false" }, true), { color: true, live: true });
  assert.deepEqual(terminalStyle({}, { TERM: "dumb" }, true), { color: false, live: false });
  assert.deepEqual(terminalStyle({ pretty: true }, { NO_COLOR: "1" }, false), { color: true, live: true });
  assert.equal(paint({ color: false, live: false }, "red", "x"), "x");
  assert.match(paint({ color: true, live: true }, "red", "x"), ANSI);
});

test("elapsed times read as a person would say them", () => {
  assert.equal(formatElapsed(820), "820 ms");
  assert.equal(formatElapsed(14_200), "14s");
  assert.equal(formatElapsed(125_000), "2m 05s");
  assert.equal(formatElapsed(3_780_000), "1h 03m");
});

test("plain progress: one undecorated line per event, and a still-running line a minute with the last output", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "jg-term-"));
  fs.mkdirSync(path.join(runDir, "outputs"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "outputs", "YAML_YAMLLINT-SUCCESS.log"), "ok");
  let clock = 1_000_000;
  const lines = [];
  const progress = new RunProgress((text) => lines.push(text), { color: false, live: false }, () => clock);
  progress.onEvent(event("run-started", { runDir }));
  progress.onEvent(event("step-started", { step: "quality-bridge" }));
  clock += 61_000;
  progress.tick();
  progress.onEvent(event("step-finished", { step: "quality-bridge", status: "completed", durationMs: 136_225 }));
  progress.onEvent(event("step-skipped", { step: "eslint", cause: "fail-fast" }));
  progress.stop();
  const text = lines.join("");
  assert.doesNotMatch(text, ANSI);
  assert.doesNotMatch(text, /[✓✗›–⠋]/);
  const out = text.trim().split("\n");
  assert.equal(out.length, 4, text);
  assert.match(out[0], /^quality-bridge: /);
  assert.match(out[1], /^quality-bridge: .*1m 01s.*YAML_YAMLLINT-SUCCESS\.log/);
  assert.match(out[2], /^quality-bridge: completed .*2m 16s/);
  assert.match(out[3], /^eslint: .*fail-fast/);
});

test("pretty progress: colored marks and a live line that is cleared before every printed line", () => {
  let clock = 0;
  const writes = [];
  const progress = new RunProgress((text) => writes.push(text), { color: true, live: true }, () => clock);
  progress.onEvent(event("step-started", { step: "ruff" }));
  clock += 3_000;
  progress.tick();
  progress.onEvent(event("step-finished", { step: "ruff", status: "failed", durationMs: 3_000 }));
  progress.stop();
  const text = writes.join("");
  assert.match(text, ANSI);
  assert.match(text, /✗/);
  assert.match(text, /\r\u001b\[2K/, "the live line is erased before the next line");
  assert.ok(!text.endsWith("…"), "nothing is left on the live line after stop()");
});
