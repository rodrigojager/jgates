// A stand-in for an agent CLI (Claude Code) wrapped by the investigation executor, and for a long-running Quality tool.
// Options come first (the wrapper's prefix arguments): --fake-mode=answer|hang, --fake-pids=<file> (hang: writes its
// own pid and its child's), --fake-record=<file> (answer: appends its argv, cwd and the files it sees).
//   --version            prints a Claude Code version
//   hang                 starts a child that never ends, prints a progress line, writes the pids and waits forever
//   answer               reads the prompt on stdin and prints a Claude Code JSON result holding the stage's artifact
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--fake-${name}=`))?.slice(`--fake-${name}=`.length) ?? null;
if (args.includes("--version")) {
  process.stdout.write("2.1.9 (Claude Code)\n");
  process.exit(0);
}
const mode = option("mode") ?? "answer";

if (mode === "hang") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  process.stdout.write("phase: hunting started (a progress claim the host never takes)\n");
  const pids = option("pids");
  if (pids) fs.writeFileSync(pids, JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
} else {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const list = (dir, prefix = "") =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
  const record = option("record");
  if (record) fs.appendFileSync(record, `${JSON.stringify({ argv: args, cwd: process.cwd(), files: list(process.cwd()).sort(), prompt })}\n`);
  const candidate = /Candidate (C\d+) \(reported by another context/.exec(prompt)?.[1];
  const artifact = candidate
    ? { candidateId: candidate, confirmation: option("verdict") ?? "confirmed", reason: "The concatenated id reaches the SQL text.", evidence: [{ path: "src/app.js", line: 1 }] }
    : {
        summary: "Read src/app.js; one injection candidate.",
        examined: ["src/app.js", "src/not-staged.js"],
        candidates: [{ title: "SQL injection in find", path: "src/app.js", line: 1, severity: "blocking", category: "security", rationale: "The id is concatenated." }],
      };
  process.stderr.write("phase: everything validated (a progress claim the host never takes)\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(artifact), usage: { input_tokens: 1200, cache_read_input_tokens: 300, output_tokens: 150 } }));
}
