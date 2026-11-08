import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
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

const MAIN = path.join(dist, "cli", "main.js");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A workspace with the trivy instance configured with `settings` (YAML lines), initialized by the real CLI. */
function setup(settings, env = {}) {
  const dir = tmp("jgates-ti-ws-");
  const home = tmp("jgates-ti-home-");
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  fs.copyFileSync(TARBALL, path.join(dir, "app.tar"));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  const runEnv = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1", ...env };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: runEnv, input: "", timeout: 240_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const init = cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), `schemaVersion: 1\ntools:\n  trivy-image:\n    adapter: trivy\n    capabilities: [dependencies]\n${settings}`);
  return {
    dir,
    plan: () => cli(["plan", "--cwd", dir, "--only", "tool:trivy-image", "--json"]),
    run: () => cli(["run", "--cwd", dir, "--only", "tool:trivy-image", "--no-interactive", "--json"]),
    cleanup: () => [dir, home].forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
  };
}
const imageItem = (planned) => [...planned.doc.plan.groups.willRun, ...planned.doc.plan.groups.notApplicableOrDisabled].find((i) => i.tool === "trivy-image") ?? assert.fail(planned.out + planned.err);

test("trivy final-image setting: imageRef and imageTarball select the image mode in the plan", () => {
  const ref = setup("    imageRef: registry.example/app:1.0\n");
  const tar = setup("    imageTarball: app.tar\n");
  const both = setup("    imageRef: a:1\n    imageTarball: app.tar\n");
  const plain = setup("");
  try {
    const byRef = imageItem(ref.plan());
    assert.equal(byRef.adapter, "trivy");
    assert.equal(byRef.command.args[0], "image");
    assert.equal(byRef.command.args.at(-1), "registry.example/app:1.0");
    assert.equal(byRef.network, true);
    assert.equal(byRef.category, "dependencies");
    const byTar = imageItem(tar.plan());
    assert.equal(byTar.command.args[0], "image");
    assert.equal(byTar.command.args[byTar.command.args.indexOf("--input") + 1], "{workspace}/app.tar");
    // Both at once is refused, never a silent choice.
    const refused = imageItem(both.plan());
    assert.equal(refused.availability.status, "unavailable");
    assert.match(refused.availability.reason, /only one of imageRef and imageTarball|apenas um/);
    // Without the settings the instance stays the filesystem scan.
    assert.notEqual(imageItem(plain.plan()).command.args[0], "image");
  } finally {
    [ref, tar, both, plain].forEach((w) => w.cleanup());
  }
});

test("trivy final-image run: a missing Trivy and container runtime is a blocked stage, never a clean image", () => {
  // No Docker daemon is needed (nor started): both executables are pointed at names that do not exist, which is also
  // the honest result on a machine where the daemon is stopped.
  const ws = setup("    imageTarball: app.tar\n", { JGATES_TRIVY: "trivy-does-not-exist", JGATES_CONTAINER_RUNTIME: "runtime-does-not-exist" });
  try {
    const ran = ws.run();
    const stage = ran.doc.stages.find((s) => s.id === "trivy-image#dependencies");
    assert.ok(stage, ran.out + ran.err);
    assert.equal(stage.state, "blocked");
    assert.match(stage.reason, /runtime-does-not-exist|trivy-does-not-exist/);
    assert.notEqual(ran.doc.decision, "passed");
    assert.equal(ran.doc.findings.filter((f) => f.tool === "trivy").length, 0);
  } finally {
    ws.cleanup();
  }
});

test("trivy final-image run: a Trivy that answers with the recorded image report yields normalized findings (POSIX stand-in)", (t) => {
  if (process.platform === "win32") {
    t.diagnostic("a shell stand-in for the Trivy executable cannot be spawned directly on Windows; the report parsing is covered by the scanImage tests above, and no real Trivy image smoke ran (the Docker daemon was not available)");
    return;
  }
  const bin = tmp("jgates-ti-bin-");
  const stand = path.join(bin, "trivy");
  fs.writeFileSync(stand, `#!/bin/sh\ncat "${path.join(IMAGE, "trivy-image-report.json")}"\n`, { mode: 0o755 });
  const ws = setup("    imageTarball: app.tar\n", { JGATES_TRIVY: stand });
  try {
    const ran = ws.run();
    const found = ran.doc.findings.filter((f) => f.tool === "trivy");
    assert.equal(found.length, 1, ran.out + ran.err);
    assert.equal(found[0].ruleId, "CVE-2024-0001");
    assert.equal(ran.doc.stages.find((s) => s.id === "trivy-image#dependencies").state, "completed");
  } finally {
    ws.cleanup();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});