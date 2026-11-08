// STAND-IN for the CodeQL CLI. The real CodeQL is customer-supplied and is NOT used by the JGates tests.
// It speaks only the three commands the adapter issues and replays a recorded SARIF (../recorded):
//   codeql version --format=terse
//   codeql database create <db> --language=<l> --source-root=. --overwrite [--command=<c>]
//   codeql database analyze <db> <suite> --format=sarif-latest --output=<file> --no-download
// The recorded SARIF is chosen by a naive scan of the source root at `database create`: a Flask handler that passes
// request data to os.system selects command-injection.sarif, anything else clean.sarif. It is not an analyzer.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

// The recorded SARIFs sit in a recorded/ folder next to the executable (the test copies them), or in ../recorded when run as a script.
const FIXTURES = [path.join(path.dirname(process.execPath), "recorded"), path.join(process.argv[1] ? path.dirname(process.argv[1]) : ".", "..", "recorded")].find((d) => fs.existsSync(d));
const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".jgates" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

if (args[0] === "version") {
  process.stdout.write("2.18.4\n");
} else if (args[0] === "database" && args[1] === "create") {
  const db = args[2];
  const root = path.resolve(process.cwd(), opt("--source-root") || ".");
  const sources = walk(root).filter((f) => f.endsWith(".py")).map((f) => fs.readFileSync(f, "utf8"));
  const bad = sources.some((s) => /request\./.test(s) && /os\.system\(/.test(s));
  fs.mkdirSync(db, { recursive: true });
  fs.writeFileSync(path.join(db, "codeql-database.yml"), `language: ${opt("--language")}\nrecorded: ${bad ? "command-injection" : "clean"}\n`);
} else if (args[0] === "database" && args[1] === "analyze") {
  const db = args[2];
  const output = opt("--output");
  const meta = fs.readFileSync(path.join(db, "codeql-database.yml"), "utf8");
  const recorded = /recorded: (\S+)/.exec(meta)[1];
  fs.copyFileSync(path.join(FIXTURES, `${recorded}.sarif`), output);
} else {
  process.stderr.write(`stand-in: unsupported command ${args.join(" ")}\n`);
  process.exit(64);
}
