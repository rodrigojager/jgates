#!/usr/bin/env node
// Controlled test executable for the local runner (timeouts, many logs, child processes, exit codes, malformed
// output). It also answers like Ruff (`--version`, `check ... --output-format json`), so a test can point JGATES_RUFF
// at it and drive a real `jgates run`.
//
// The behaviour comes from `--fake-mode <mode>` or, when absent, from a line `fake-mode: <mode>` in the file given
// with `--config <file>` (how a Ruff instance of tools.yml selects it). Modes:
//   clean               stdout "[]", exit 0
//   violations          one Ruff-shaped finding, exit 1
//   malformed           stdout that is not JSON, exit 0
//   exit:<n>            exit with code n, a line on stderr
//   sleep               never ends on its own
//   children:<file>     starts a tree (2 children, each with a grandchild, one grandchild in its own session),
//                       writes every pid to <file> as JSON when all are up, then waits forever
//   flood:<bytes>       writes <bytes> to stderr, then stdout "[]", exit 0
//   flood-stdout:<bytes> writes <bytes> to stdout (not JSON), exit 0
//   touch:<file>        writes <file> (relative to the cwd), stdout "[]", exit 0
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("ruff 0.17.2\n");
  process.exit(0);
}

function modeOf() {
  const i = argv.indexOf("--fake-mode");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const c = argv.indexOf("--config");
  if (c !== -1 && argv[c + 1]) {
    try {
      const m = /fake-mode:\s*(\S+)/.exec(fs.readFileSync(argv[c + 1], "utf8"));
      if (m) return m[1];
    } catch {
      // fall through to the default
    }
  }
  return "clean";
}

const forever = () => setInterval(() => undefined, 1 << 30);
const [mode, ...rest] = modeOf().split(":");
const arg = rest.join(":");

function writeBytes(stream, total, done) {
  const chunk = Buffer.alloc(64 * 1024, "x");
  let left = total;
  const pump = () => {
    while (left > 0) {
      const part = left >= chunk.length ? chunk : chunk.subarray(0, left);
      left -= part.length;
      if (!stream.write(part)) {
        stream.once("drain", pump);
        return;
      }
    }
    done();
  };
  pump();
}

switch (mode) {
  case "clean":
    process.stdout.write("[]\n");
    break;
  case "violations":
    process.stdout.write(
      JSON.stringify([{ code: "E711", message: "Comparison to `None` should be `cond is None`", filename: path.join(process.cwd(), "demo", "mod.py"), location: { row: 1, column: 4 } }]),
    );
    process.exitCode = 1;
    break;
  case "malformed":
    process.stdout.write("{this is not json");
    break;
  case "exit":
    process.stderr.write(`fake-tool: exiting with ${arg}\n`);
    process.exitCode = Number(arg);
    break;
  case "sleep":
    forever();
    break;
  case "children": {
    const node = process.execPath;
    const grandchild = "setInterval(() => undefined, 1 << 30)";
    const child = (escape) =>
      `const { spawn } = require("node:child_process");` +
      `const g = spawn(${JSON.stringify(node)}, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore", detached: ${escape} });` +
      `process.stdout.write(String(g.pid) + "\\n");` +
      `setInterval(() => undefined, 1 << 30);`;
    const pids = [process.pid];
    const kids = [false, true].map((escape) => spawn(node, ["-e", child(escape)], { stdio: ["ignore", "pipe", "inherit"] }));
    let waiting = kids.length;
    for (const kid of kids) {
      pids.push(kid.pid);
      kid.stdout.once("data", (data) => {
        pids.push(Number(String(data).trim()));
        if (--waiting === 0) {
          fs.writeFileSync(`${arg}.tmp`, JSON.stringify(pids));
          fs.renameSync(`${arg}.tmp`, arg);
          process.stderr.write("fake-tool: tree is up\n");
        }
      });
    }
    forever();
    break;
  }
  case "flood":
    writeBytes(process.stderr, Number(arg), () => process.stdout.write("[]\n"));
    break;
  case "flood-stdout":
    writeBytes(process.stdout, Number(arg), () => undefined);
    break;
  case "touch":
    fs.writeFileSync(path.resolve(arg), "left by fake-tool\n");
    process.stdout.write("[]\n");
    break;
  default:
    process.stderr.write(`fake-tool: unknown mode ${mode}\n`);
    process.exitCode = 2;
}
