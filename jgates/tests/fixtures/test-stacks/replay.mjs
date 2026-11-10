// Stand-in for a test runner in the default suite (the JGATES_GO, JGATES_DOTNET, JGATES_CARGO, JGATES_JEST, JGATES_PYTEST
// and JGATES_VITEST overrides of the tools image point at it, directly or through a package folder made by the test).
// go, dotnet, cargo, Jest, pytest and Vitest are not on every machine that runs `npm test`, so the default suite replays
// what the REAL runner of the tools image printed and wrote for these fixtures: recorded/<stack>.<kind>.<tool>.json holds
// the command the plan gave, the exit code, the standard output and the files the runner wrote into the run folder,
// recorded by tests/docker/adapters-tests.test.js (JGATES_TEST_STACKS_RECORD=1), which runs the same fixtures live.
// The recording is picked by the CONTENT of the working folder and by the command: a folder whose files differ from
// every fixture gets no answer (exit 99), and a command that is not a recorded one gets none either (exit 98), so a change
// of the plan's command or of a fixture cannot go unnoticed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const posix = (p) => p.split(path.sep).join("/");

function filesOf(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), next);
      else out.push(next);
    }
  };
  walk(dir, "");
  return out;
}

/** Hash of the named files of a folder (a missing file hashes as absent). */
function hashOf(dir, files) {
  const h = crypto.createHash("sha256");
  for (const f of files) {
    const abs = path.join(dir, ...f.split("/"));
    h.update(`${f}\0`).update(fs.existsSync(abs) ? fs.readFileSync(abs) : "<absent>");
  }
  return h.digest("hex");
}

/** The run folder of this run (the part before /outputs/ of an output path in the arguments), and the arguments with it as {runDir}. */
let runDir = null;
const args = process.argv.slice(2).map((a) => {
  const slashed = a.replace(/\\/g, "/");
  const at = slashed.indexOf("/outputs/");
  if (at < 0) return a;
  // The path starts at its drive letter or first slash after the option's own prefix (`--cov-report=json:`).
  const start = /(?:[A-Za-z]:)?\/[^=;]*$/.exec(slashed.slice(0, at));
  if (!start) return a;
  runDir ??= start[0];
  return `${slashed.slice(0, start.index)}{runDir}${slashed.slice(at)}`;
});

const recordings = fs.existsSync(path.join(root, "recorded")) ? fs.readdirSync(path.join(root, "recorded")).sort() : [];
let matchedFolder = false;
for (const name of recordings) {
  const rec = JSON.parse(fs.readFileSync(path.join(root, "recorded", name), "utf8"));
  const fixture = path.join(root, rec.stack, rec.kind);
  const files = filesOf(fixture);
  if (hashOf(fixture, files) !== hashOf(cwd, files)) continue;
  matchedFolder = true;
  if (JSON.stringify(args) !== JSON.stringify(rec.args)) continue;
  // The recording ran at /workspace with the run folder at /output; here they are the working folder and this run's folder.
  const here = posix(cwd);
  const out = runDir ?? posix(cwd);
  const map = (text) => text.split("/output/").join(`${out}/`).split("/workspace").join(here);
  for (const [rel, content] of Object.entries(rec.files ?? {})) {
    const target = path.join(out, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, map(content));
  }
  process.stdout.write(map(rec.stdout));
  process.exit(rec.exit);
}
if (matchedFolder) {
  process.stderr.write(`replay: the command is not a recorded one\ngot: ${JSON.stringify(args)}\n`);
  process.exit(98);
}
process.stderr.write("replay: the working folder matches no recorded fixture\n");
process.exit(99);
