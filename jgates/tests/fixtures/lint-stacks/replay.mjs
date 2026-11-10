// Stand-in for a linter in the tests of the default suite (the JGATES_<TOOL> override of the tools image points at it).
// golangci-lint, ShellCheck and Hadolint are not on every machine that runs `npm test`, so the default suite replays what
// the real tools printed for these fixtures: recorded/<stack>.<kind>.json holds the exit code and the stdout of the real
// linter of the tools image (jgates-tools) for the fixture <stack>/<kind>, run with the very command the plan gives
// (the real engine runs the same fixtures live in tests/docker/adapters-lint.test.js).
// The recording is picked by the CONTENT of the working folder, never by a name or a flag: a folder whose files differ
// from every recorded fixture gets no answer (exit 99), and a command that is not the recorded one gets none either
// (exit 98), so a change of the plan's command or of a fixture cannot go unnoticed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();

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

for (const name of fs.readdirSync(path.join(root, "recorded")).sort()) {
  const [stack, kind] = name.split(".");
  const fixture = path.join(root, stack, kind);
  const files = filesOf(fixture);
  if (hashOf(fixture, files) !== hashOf(cwd, files)) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(root, "recorded", name), "utf8"));
  const args = process.argv.slice(2);
  if (JSON.stringify(args) !== JSON.stringify(rec.args)) {
    process.stderr.write(`replay: the command is not the recorded one\nrecorded: ${JSON.stringify(rec.args)}\ngot:      ${JSON.stringify(args)}\n`);
    process.exit(98);
  }
  // The recording ran at /workspace; the folder of this run is the working folder.
  process.stdout.write(rec.stdout.split("/workspace").join(cwd.split(path.sep).join("/")));
  process.exit(rec.exit);
}
process.stderr.write("replay: the working folder matches no recorded fixture\n");
process.exit(99);
