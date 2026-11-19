#!/usr/bin/env node
// A container engine for the tests of the Semantic test-file runner (jgates/tests/semantic-test-runner.test.js): the fake
// engine (jgates/tests/docker/fake-docker.cjs) plus three behaviours, none of which starts a process for a test.
//  - A test container (`run` with the label org.jgates.test-runner=<recipe>) is recorded (one JSON line in
//    FAKE_DOCKER_LOG) and answered with a recorded run (recorded/semantic-test-runner.json, or JGATES_RUNNER_RECORDINGS)
//    chosen by the recipe, the test file, what the mounted tree holds and whether a dependency volume is mounted. The
//    tree is a bind mount (a fixture) or the workspace copy (a volume of FAKE_DOCKER_STATE/volumes). A recording with
//    "hang": true never answers, so the time limit of the runner is what ends it.
//  - The helper that places and removes the file in the workspace copy (label org.jgates.workspace-copy=place|remove) is
//    emulated on the volume's folder with the same rules as its script: it refuses a path that exists, reports the first
//    folder it created, and the removal takes away the file and that folder only.
//  - Everything else goes to the fake engine.
// The recordings are written by hand for now; the real-engine test (tests/docker/semantic-tests-pytest.test.js) records
// what the tools image printed, and that replaces them.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const FAKE = path.resolve(__dirname, "..", "..", "docker", "fake-docker.cjs");
const RECORDINGS = process.env.JGATES_RUNNER_RECORDINGS || path.join(__dirname, "recorded", "semantic-test-runner.json");
const argv = process.argv.slice(2);

const values = (flag) => argv.flatMap((a, i) => (argv[i - 1] === flag ? [a] : []));
const labelOf = (key) => {
  const hit = values("--label").find((l) => l.startsWith(`${key}=`));
  return hit === undefined ? null : hit.slice(key.length + 1);
};
const envOf = (key) => {
  const hit = values("--env").find((l) => l.startsWith(`${key}=`));
  return hit === undefined ? null : hit.slice(key.length + 1);
};
const mounts = values("--mount").map((spec) => {
  const fields = Object.fromEntries(spec.split(",").map((part) => (part.includes("=") ? [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)] : [part, true])));
  return { type: fields.type, source: fields.src, target: fields.dst, readonly: fields.readonly === true };
});

const runner = argv[0] === "run" ? labelOf("org.jgates.test-runner") : null;
const copyStep = argv[0] === "run" ? labelOf("org.jgates.workspace-copy") : null;
if (runner === null && copyStep === null) {
  const r = spawnSync(process.execPath, [FAKE, ...argv], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(argv) + "\n");

const volumeDir = (name) => path.join(process.env.FAKE_DOCKER_STATE, "volumes", name);
const hostOf = (m) => (m.type === "volume" ? volumeDir(m.source) : m.source);

if (copyStep !== null) {
  const dst = mounts.find((m) => m.target === "/dst" && m.type === "volume");
  const file = envOf("JG_FILE");
  if (!dst || dst.readonly || !file) {
    process.stderr.write("replay-engine: the workspace-copy helper needs the copy at /dst (writable) and JG_FILE\n");
    process.exit(125);
  }
  const root = hostOf(dst);
  const target = path.join(root, ...file.split("/"));
  if (copyStep === "place") {
    const stage = mounts.find((m) => m.target === "/stage" && m.type === "bind");
    if (fs.existsSync(target)) {
      process.stderr.write("the path already exists in the workspace copy\n");
      process.exit(3);
    }
    let first = "";
    let d = path.posix.dirname(file);
    while (d !== "." && !fs.existsSync(path.join(root, ...d.split("/")))) {
      first = d;
      d = path.posix.dirname(d);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(stage.source, "test-file"), target);
    process.stdout.write(first);
    process.exit(0);
  }
  fs.rmSync(target, { force: true });
  const created = envOf("JG_CREATED");
  if (created) fs.rmSync(path.join(root, ...created.split("/")), { recursive: true, force: true });
  process.exit(0);
}

const tree = mounts.find((m) => m.target === "/workspace");
const reporterAt = argv.indexOf("--test-reporter=tap");
const file = reporterAt >= 0 ? argv[reporterAt + 1] : argv[argv.length - 1];
if (!tree || !file) {
  process.stderr.write("replay-engine: a test container needs the tree at /workspace and a test file\n");
  process.exit(125);
}
const dependencies = mounts.some((m) => m.type === "volume" && m.target.startsWith("/workspace/") && m.readonly);
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(hostOf(tree), ...rel.split("/")), "utf8");
  } catch {
    return null;
  }
};
const recordings = JSON.parse(fs.readFileSync(RECORDINGS, "utf8")).runs;
const match = recordings.find(
  (r) =>
    r.runner === runner &&
    r.file === file &&
    (r.dependencies === undefined || r.dependencies === dependencies) &&
    (r.when ?? []).every((w) => {
      const text = read(w.path);
      return text !== null && (w.contains === undefined || text.includes(w.contains)) && (w.lacks === undefined || !text.includes(w.lacks));
    }),
);
if (process.env.FAKE_DOCKER_STATE) {
  fs.mkdirSync(process.env.FAKE_DOCKER_STATE, { recursive: true });
  fs.appendFileSync(path.join(process.env.FAKE_DOCKER_STATE, "semantic-test-runner.jsonl"), JSON.stringify({ runner, file, recording: match ? match.id : null, dependencies, treeType: tree.type }) + "\n");
}
if (!match) {
  process.stderr.write(`replay-engine: no recording for ${runner} ${file} on this tree\n`);
  process.exit(1);
}
if (match.hang) {
  // Never answers: the time limit of the runner kills this process.
  setInterval(() => undefined, 1000);
} else {
  process.stdout.write(match.stdout ?? "");
  process.stderr.write(match.stderr ?? "");
  process.exit(match.exitCode);
}
