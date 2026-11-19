// Stand-in for the tools of the linter engine in the default suite (the JGATES_LINTER_<ID> override of the tools image
// points at it). The tools are not on every machine that runs `npm test`, so the per-tool tests replay what the REAL
// tool of the tools image printed for its fixtures.
//
// The recordings: <fixtures>/<id>/recorded/<kind>.json for the fixture folder <fixtures>/<id>/<kind>/ (kind: bad or
// clean), written by the image probe (`npm --prefix jgates run image:probe -- <id>`) from the tool running in the image
// with the very command the plan gives:
//   { "tool": "<id>", "kind": "bad", "calls": [ { "args": [...], "exit": 1, "stdout": "...", "stderr": "...", "reportPath": "/output/linters/<id>/report.sarif", "report": "..." } ] }
// One call per process the run starts (one for the files and project modes, one per file for each-file, one per batch).
// `args` are the tool's own arguments as the plan gives them, with the workspace as /workspace and the run folder as
// /output (paths inside the step container); `report` is the content of the report file the tool wrote at `reportPath`,
// for a tool that writes one.
// The fixture folders searched: tests/fixtures/linters/ (the descriptors of src/builtin/linters) and
// tests/fixtures/linter-engine/fixtures/ (the invented tools of the engine's own tests).
//
// The recording is picked by the CONTENT of the working folder, never by a name or a flag: a folder whose files differ
// from every recorded fixture gets no answer (exit 99), and a command that is not a recorded one gets none either
// (exit 98), so a change of the plan's command or of a fixture cannot go unnoticed. A file named
// .jgates-replay-flood in the working folder makes the replay print more than the runner keeps (the truncation case).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [here, path.resolve(here, "..", "linter-engine", "fixtures")];
const cwd = process.cwd();
const slash = (p) => p.split(path.sep).join("/");

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

/** Whether an actual argument is the recorded one; for a recorded /output path, the actual path it stands for. */
function argMatches(recorded, actual) {
  const a = slash(actual);
  const ws = slash(cwd);
  if (recorded.includes("/output/")) {
    const at = recorded.indexOf("/output/");
    const prefix = recorded.slice(0, at);
    const suffix = recorded.slice(at + "/output".length);
    return a.startsWith(prefix) && a.endsWith(suffix) ? { output: actual.slice(prefix.length), recorded: recorded.slice(at) } : null;
  }
  return recorded.split("/workspace").join(ws) === a || recorded === a ? {} : null;
}

function callMatches(call, args) {
  if (call.args.length !== args.length) return null;
  let report = null;
  for (let i = 0; i < args.length; i += 1) {
    const m = argMatches(call.args[i], args[i]);
    if (m === null) return null;
    if (m.output && call.reportPath && m.recorded === call.reportPath) report = m.output;
  }
  return { report };
}

const args = process.argv.slice(2);
let contentMatched = false;
for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const id of fs.readdirSync(root).sort()) {
    const recordedDir = path.join(root, id, "recorded");
    if (!fs.existsSync(recordedDir)) continue;
    for (const name of fs.readdirSync(recordedDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const kind = name.slice(0, -".json".length);
      const fixture = path.join(root, id, kind);
      if (!fs.existsSync(fixture)) continue;
      const files = filesOf(fixture);
      if (hashOf(fixture, files) !== hashOf(cwd, files)) continue;
      contentMatched = true;
      const rec = JSON.parse(fs.readFileSync(path.join(recordedDir, name), "utf8"));
      for (const call of rec.calls ?? []) {
        const m = callMatches(call, args);
        if (m === null) continue;
        const ws = slash(cwd);
        if (m.report !== null && typeof call.report === "string") {
          fs.mkdirSync(path.dirname(m.report), { recursive: true });
          fs.writeFileSync(m.report, call.report.split("/workspace").join(ws));
        }
        const out = (call.stdout ?? "").split("/workspace").join(ws);
        if (fs.existsSync(path.join(cwd, ".jgates-replay-flood"))) {
          const chunk = "x".repeat(1024 * 1024);
          for (let i = 0; i < 80; i += 1) process.stdout.write(chunk);
        }
        process.stdout.write(out);
        process.stderr.write((call.stderr ?? "").split("/workspace").join(ws));
        process.exitCode = call.exit;
        // Let the streams drain before the process ends.
        await new Promise((resolve) => process.stdout.write("", resolve));
        process.exit(call.exit);
      }
    }
  }
}
if (contentMatched) {
  process.stderr.write(`replay: the command is not a recorded one\ngot: ${JSON.stringify(args)}\n`);
  process.exit(98);
}
process.stderr.write("replay: the working folder matches no recorded fixture\n");
process.exit(99);
