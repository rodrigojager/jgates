// A controllable Quality check for the sequence cases, run by the generic-command adapter (never through a shell).
// argv: <outputDir> <modeFile> <workspace>. The mode file (outside the workspace, so changing it never changes the
// source) says what the check does this time:
//   pass        writes a valid evidence file and exits 0             -> stage completed, decision passed
//   fail        exits 1                                               -> one blocking violation, decision failed
//   error       exits 0 without the evidence file                     -> stage error (output not interpreted)
//   timeout     sleeps past the instance's timeoutSeconds             -> stage timeout, decision incomplete
//   incomplete  changes an analyzed file of the workspace, then passes -> inputs changed, decision incomplete
//   hang        writes <modeFile>.started and waits ~60 s              -> for cancellation
import fs from "node:fs";
import path from "node:path";

const [outputDir, modeFile, workspace] = process.argv.slice(2);
const mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, "utf8").trim() : "pass";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = () => {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "evidence.json"), JSON.stringify({ ok: true }));
};

switch (mode) {
  case "fail":
    process.stdout.write("seq-check: a blocking problem\n");
    process.exit(1);
    break;
  case "error":
    process.exit(0);
    break;
  case "timeout":
    await sleep(20_000);
    evidence();
    process.exit(0);
    break;
  case "incomplete":
    fs.appendFileSync(path.join(workspace, "src", "core", "a.js"), "// changed while the check ran\n");
    evidence();
    process.exit(0);
    break;
  case "hang":
    fs.writeFileSync(`${modeFile}.started`, String(process.pid));
    await sleep(60_000);
    evidence();
    process.exit(0);
    break;
  default:
    evidence();
    process.exit(0);
}
