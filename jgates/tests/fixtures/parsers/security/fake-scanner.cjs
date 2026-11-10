#!/usr/bin/env node
// Stand-in for the four security scanners (gitleaks, trivy, osv-scanner, checkov) of the tests that run JGates "inside
// the image" (tests/setup/in-image.mjs): the scanner starts natively, and this script writes a recorded report where the
// tool would, like the real one. The test embeds the scenario in the variables before requiring it:
//   FAKE_LOG            one JSON line per call (the argv)
//   FAKE_REPORT         file copied to the report path of the command line (default name results_json.json inside the
//                       --output-file-path folder for Checkov); unset: no report
//   FAKE_REPORT_BYTES   copies only the first N bytes (a cut report)
//   FAKE_DB_META        file copied to <--cache-dir>/db/metadata.json, next to a dummy trivy.db, as Trivy does when it
//                       downloads; with --skip-db-update nothing is downloaded and the database must already be there
//   FAKE_STDERR         text written to stderr; FAKE_EXIT: exit code (default 0)
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify([path.basename(process.argv[1] ?? ""), ...argv]) + "\n");

const after = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
// Checkov names a folder (--output-file-path, and `--output json` is a format); the others name the report file.
const reportDir = after("--output-file-path");
const reportPath = reportDir ? undefined : (after("--report-path") ?? after("--output") ?? after("--output-file"));
if (process.env.FAKE_REPORT) {
  let bytes = fs.readFileSync(process.env.FAKE_REPORT);
  if (process.env.FAKE_REPORT_BYTES) bytes = bytes.subarray(0, Number(process.env.FAKE_REPORT_BYTES));
  const target = reportPath ?? (reportDir ? path.join(reportDir, "results_json.json") : null);
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}
const cacheDir = after("--cache-dir");
if (cacheDir && process.env.FAKE_DB_META) {
  const db = path.join(cacheDir, "db");
  if (argv.includes("--skip-db-update")) {
    if (!fs.existsSync(path.join(db, "trivy.db")) || !fs.existsSync(path.join(db, "metadata.json"))) {
      process.stderr.write("FATAL\t--skip-db-update cannot be specified on the first run\n");
      process.exit(1);
    }
  } else {
    fs.mkdirSync(db, { recursive: true });
    fs.copyFileSync(process.env.FAKE_DB_META, path.join(db, "metadata.json"));
    fs.writeFileSync(path.join(db, "trivy.db"), "dummy database");
    if (process.env.FAKE_DOWNLOADS) fs.appendFileSync(process.env.FAKE_DOWNLOADS, "download\n");
  }
}
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
process.exit(Number(process.env.FAKE_EXIT || 0));
