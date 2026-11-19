#!/usr/bin/env node
// A container engine for the tests of the Semantic test-file runner (post-patch validation, `jgates regressions
// validate|incorporate`). A test container (`run` with the label org.jgates.test-runner) is not executed: the engine
// records the call (one JSON line in FAKE_DOCKER_LOG, like the fake engine) and replays a recorded run of the same test
// file on the same tree, chosen from recorded/semantic-tests.json (or JGATES_TEST_RECORDINGS) by what the mounted tree
// holds: the test file, the files a recording names and whether a dependency volume is mounted. It never starts a
// process for the test. Every other call (info, image inspect, rm...) goes to the fake engine
// (jgates/tests/docker/fake-docker.cjs).
//
// The recordings are written by hand for now; a real-engine test replaces them with what the tools image printed.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const FAKE = path.resolve(__dirname, "..", "..", "..", "..", "jgates", "tests", "docker", "fake-docker.cjs");
const RECORDINGS = process.env.JGATES_TEST_RECORDINGS || path.join(__dirname, "recorded", "semantic-tests.json");
const argv = process.argv.slice(2);

const labelOf = (key) => {
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "--label" && argv[i + 1].startsWith(`${key}=`)) return argv[i + 1].slice(key.length + 1);
  return null;
};

if (argv[0] !== "run" || labelOf("org.jgates.test-runner") === null) {
  const r = spawnSync(process.execPath, [FAKE, ...argv], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}

if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(argv) + "\n");
const mounts = [];
for (let i = 0; i < argv.length - 1; i++) {
  if (argv[i] !== "--mount") continue;
  const fields = Object.fromEntries(
    argv[i + 1].split(",").map((part) => {
      const at = part.indexOf("=");
      return at < 0 ? [part, true] : [part.slice(0, at), part.slice(at + 1)];
    }),
  );
  mounts.push({ type: fields.type, source: fields.src, target: fields.dst, readonly: fields.readonly === true });
}
const tree = mounts.find((m) => m.target === "/workspace" && m.type === "bind");
const reporterAt = argv.indexOf("--test-reporter=tap");
const file = reporterAt >= 0 ? argv[reporterAt + 1] : null;
if (!tree || !file) {
  process.stderr.write("replay-engine: a test container needs the tree at /workspace and a node:test file\n");
  process.exit(125);
}
const dependencies = mounts.some((m) => m.type === "volume" && m.target.startsWith("/workspace/") && m.readonly);
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(tree.source, ...rel.split("/")), "utf8");
  } catch {
    return null;
  }
};
const recordings = JSON.parse(fs.readFileSync(RECORDINGS, "utf8")).runs;
const match = recordings.find(
  (r) =>
    r.file === file &&
    (r.dependencies === undefined || r.dependencies === dependencies) &&
    (r.when ?? []).every((w) => {
      const text = read(w.path);
      return text !== null && (w.contains === undefined || text.includes(w.contains)) && (w.lacks === undefined || !text.includes(w.lacks));
    }),
);
if (process.env.FAKE_DOCKER_STATE) {
  fs.mkdirSync(process.env.FAKE_DOCKER_STATE, { recursive: true });
  fs.appendFileSync(path.join(process.env.FAKE_DOCKER_STATE, "semantic-tests.jsonl"), JSON.stringify({ file, recording: match ? match.id : null, dependencies }) + "\n");
}
if (!match) {
  process.stderr.write(`replay-engine: no recording for ${file} on this tree\n`);
  process.exit(1);
}
process.stdout.write(match.stdout ?? "");
process.stderr.write(match.stderr ?? "");
process.exit(match.exitCode);
