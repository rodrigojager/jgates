// Stand-in for the tools of the e2e, migration drift, performance, Stryker.NET and vulnerable-package checks in the
// default suite (the JGATES_PLAYWRIGHT, JGATES_MIGRATION_TOOL, JGATES_BENCHMARK, JGATES_DOTNET_STRYKER and JGATES_DOTNET
// overrides of the tools image point at it). Playwright, Alembic, Prisma, dotnet-ef, the benchmark harnesses,
// Stryker.NET and the .NET SDK are not on every machine that runs `npm test`, so the default suite replays what the
// REAL tools printed and wrote for these fixtures, through the real engine and the project's compose services:
// recorded/<case>.<kind>.<tool>.json holds, per command of the step, the arguments the plan gave, the exit code, the
// standard output and the files the tool wrote into the run folder, recorded by tests/docker/adapters-services-checks.test.js
// (JGATES_SERVICES_CHECKS_RECORD=1), which runs the same fixtures live.
// The recording is picked by the CONTENT of the working folder and by the command: a folder whose files differ from every
// fixture gets no answer (exit 99), and a command that is not a recorded one gets none either (exit 98), so a change of
// the plan's command or of a fixture cannot go unnoticed.
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

/** Hash of the named files of a folder (a missing file hashes as absent; line ends do not count). */
function hashOf(dir, files) {
  const h = crypto.createHash("sha256");
  for (const f of files) {
    const abs = path.join(dir, ...f.split("/"));
    h.update(`${f}\0`).update(fs.existsSync(abs) ? fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n") : "<absent>");
  }
  return h.digest("hex");
}

/** The run folder of this run (the part before /outputs/ of an output path in the arguments), and the arguments with it as {runDir}. */
let runDir = null;
const args = process.argv.slice(2).map((a) => {
  const slashed = a.replace(/\\/g, "/");
  const at = slashed.indexOf("/outputs/");
  if (at < 0) return a;
  const start = /(?:[A-Za-z]:)?\/[^=;]*$/.exec(slashed.slice(0, at));
  if (!start) return a;
  runDir ??= start[0];
  return `${slashed.slice(0, start.index)}{runDir}${slashed.slice(at)}`;
});

const dir = path.join(root, "recorded");
const recordings = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : [];
let matchedFolder = false;
for (const name of recordings) {
  const rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  const fixture = path.join(root, rec.case, rec.kind);
  const files = filesOf(fixture);
  if (hashOf(fixture, files) !== hashOf(cwd, files)) continue;
  matchedFolder = true;
  const run = rec.runs.find((r) => JSON.stringify(r.args) === JSON.stringify(args));
  if (!run) continue;
  // The recording ran at /workspace with the run folder at /output; here they are the working folder and this run's folder.
  const here = posix(cwd);
  const out = runDir ?? here;
  // One pass, so a mapped run folder (".../workspaces/...") is never mapped again.
  const map = (text) => text.replace(/\/output\/|\/workspace(?![\w.-])/g, (m) => (m === "/output/" ? `${out}/` : here));
  // Files go into the run folder only (a command without an output path in its arguments wrote none of its own).
  for (const [rel, content] of runDir ? Object.entries(run.files ?? {}) : []) {
    const target = path.join(out, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, map(content));
  }
  process.stdout.write(map(run.stdout));
  process.stderr.write(map(run.stderr ?? ""));
  process.exit(run.exit);
}
if (matchedFolder) {
  process.stderr.write(`replay: the command is not a recorded one\ngot: ${JSON.stringify(args)}\n`);
  process.exit(98);
}
process.stderr.write("replay: the working folder matches no recorded fixture\n");
process.exit(99);
