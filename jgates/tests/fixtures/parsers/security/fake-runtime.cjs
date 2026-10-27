#!/usr/bin/env node
// Fake container runtime of the security adapters' tests: answers `image inspect` with the version labels of the
// security image, and on `run` writes a recorded report into the folder mounted at /output, like the real scanner.
//   FAKE_LOG            one JSON line per call (the argv)
//   FAKE_LABELS         the labels `image inspect` reports ("none": no such image); with --format it prints them, without
//                       it prints the JSON array of the runtime (Id, RepoDigests, Config.Labels), as `tools prepare` reads
//   FAKE_IMAGE_ID       the image id of that array (default: sha256 of the labels); FAKE_REPO_DIGESTS: JSON list
//   FAKE_REPORT         file copied to <output mount>/<FAKE_REPORT_NAME> (default report.json); unset: no report
//   FAKE_REPORT_BYTES   copies only the first N bytes (a cut report)
//   FAKE_DB_META        file copied to <output mount>/cache/db/metadata.json, next to a dummy trivy.db, as Trivy does
//                       when it downloads; with --skip-db-update nothing is downloaded and the database must already be
//                       there (Trivy fails otherwise). Each download appends a line to FAKE_DOWNLOADS
//   FAKE_STDERR         text written to stderr; FAKE_EXIT: exit code of `run` (default 0)
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(argv) + "\n");

if (argv[0] === "image" && argv[1] === "inspect") {
  const labels =
    process.env.FAKE_LABELS ||
    JSON.stringify({
      "org.jgates.tool.gitleaks.version": "8.30.1",
      "org.jgates.tool.trivy.version": "0.72.0",
      "org.jgates.tool.osv-scanner.version": "2.4.0",
      "org.jgates.tool.checkov.version": "3.3.8",
    });
  if (labels === "none") {
    process.stderr.write("Error: No such image\n");
    process.exit(1);
  }
  if (argv.includes("--format")) process.stdout.write(labels + "\n");
  else {
    const id = process.env.FAKE_IMAGE_ID || `sha256:${crypto.createHash("sha256").update(labels).digest("hex")}`;
    const repoDigests = JSON.parse(process.env.FAKE_REPO_DIGESTS || "[]");
    process.stdout.write(JSON.stringify([{ Id: id, RepoDigests: repoDigests, Config: { Labels: JSON.parse(labels) } }]) + "\n");
  }
  process.exit(0);
}
if (argv[0] !== "run") process.exit(0);

const mount = argv.find((a) => a.startsWith("type=bind,") && a.endsWith(",dst=/output"));
const output = mount ? mount.slice("type=bind,src=".length, -",dst=/output".length) : null;
if (output && process.env.FAKE_REPORT) {
  let bytes = fs.readFileSync(process.env.FAKE_REPORT);
  if (process.env.FAKE_REPORT_BYTES) bytes = bytes.subarray(0, Number(process.env.FAKE_REPORT_BYTES));
  fs.writeFileSync(path.join(output, process.env.FAKE_REPORT_NAME || "report.json"), bytes);
}
if (output && process.env.FAKE_DB_META) {
  const db = path.join(output, "cache", "db");
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
