import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Trivy final-image mode: `trivy image --input <tarball>` normalizes the report; without Trivy (native or container)
// the answer is the structured missing-tool state. The report replayed here is hand-built in the shape of Trivy 0.72
// (the Docker daemon was not available to record a real one).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const IMAGE = path.join(here, "fixtures", "supply-chain", "image");
const TARBALL = path.join(IMAGE, "tiny-image.tar");
const { scanImage, trivyImageArgs } = await import(pathToFileURL(path.join(dist, "adapters", "trivy", "index.js")).href);
const report = fs.readFileSync(path.join(IMAGE, "trivy-image-report.json"), "utf8");

const enoent = { status: null, stdout: "", stderr: "", errorCode: "ENOENT" };

test("trivy image: the saved tarball fixture is a docker archive", () => {
  const head = fs.readFileSync(TARBALL);
  assert.ok(head.length < 64 * 1024, "the fixture stays tiny");
  assert.ok(head.includes(Buffer.from("manifest.json")));
});

test("trivy image: a tarball scan yields normalized findings", () => {
  const calls = [];
  const result = scanImage({ tarball: TARBALL }, { env: {}, run: (exe, args) => (calls.push([exe, args]), { status: 0, stdout: report, stderr: "" }) });
  assert.equal(result.state, "completed");
  assert.equal(result.network, true);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.ruleId, "CVE-2024-0001");
  assert.equal(f.capability, "dependencies");
  assert.equal(f.normalizedSeverity, "high");
  assert.match(f.message, /busybox@1\.36\.1-r0/);
  assert.deepEqual(calls[0][1], trivyImageArgs({ tarball: TARBALL }));
  assert.ok(calls[0][1].includes("--input"));
});

test("trivy image: Trivy is missing natively and in the container runtime -> structured missing-tool state", () => {
  const result = scanImage({ tarball: TARBALL }, { env: { JGATES_TRIVY: "trivy-not-here" }, run: () => enoent });
  assert.equal(result.state, "missing-tool");
  assert.equal(result.tried.length, 2);
  assert.match(result.reason, /not available/);
});

test("trivy image: a stopped container runtime is a missing tool, not a clean scan", () => {
  const run = (exe) => (exe === "trivy" ? enoent : { status: 1, stdout: "", stderr: "failed to connect to the docker API" });
  const result = scanImage({ tarball: TARBALL }, { env: {}, run });
  assert.equal(result.state, "missing-tool");
  assert.match(result.reason, /docker API/);
});

test("trivy image: the container fallback mounts the tarball read-only and labels the container", () => {
  const calls = [];
  const run = (exe, args) => {
    calls.push([exe, args]);
    return exe === "trivy" ? enoent : { status: 0, stdout: report, stderr: "" };
  };
  const result = scanImage({ tarball: TARBALL }, { env: {}, run });
  assert.equal(result.state, "completed");
  assert.equal(result.runner, "container");
  const args = calls[1][1];
  assert.ok(args.includes("--rm") && args.includes("jproject.project=jgates"));
  assert.ok(args.some((a) => a.endsWith(":/input:ro")));
  assert.ok(args.includes("/input/tiny-image.tar"));
});

test("trivy image: a filesystem report is not accepted as an image scan", () => {
  const fsReport = JSON.stringify({ ...JSON.parse(report), ArtifactType: "filesystem" });
  const result = scanImage({ tarball: TARBALL }, { env: {}, run: () => ({ status: 0, stdout: fsReport, stderr: "" }) });
  assert.equal(result.state, "error");
});

test("trivy image: a missing tarball is an error", () => {
  assert.equal(scanImage({ tarball: path.join(IMAGE, "nope.tar") }, { env: {}, run: () => enoent }).state, "error");
});
