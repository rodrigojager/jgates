import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { KINDS, TOOLS_CONTEXT, assembledDockerfile, imagePrograms, installIndex, installPins, readInstalls, stageBuildInputs } from "../scripts/image-installs.mjs";
import { acquireLock, legacyRecordings, probeDockerfile, stepArgs } from "../scripts/image-probe.mjs";
import { pinOf, requiredFreeGb } from "../scripts/image-build.mjs";
import { checkDescriptorInstalls, checkDescriptorLicenses, imagePins, loadPolicy, readDescriptors } from "../scripts/image-gates.mjs";

// The tools image's installs as data (PLAN-image.md sections 3 and 7, slice G4): every install entry under
// docker/tools/ is well formed, the entries and runtimes.json together give exactly the programs the image records
// (release/image-tools.json) with the pins it was built with, the Dockerfile the build uses is the base file with the
// parts inserted, the probe builds one entry with the build's own installer and runs it under the step contract, and
// the probes are serialized by a lock that a vanished probe does not hold forever. Nothing here starts an engine.

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const release = JSON.parse(fs.readFileSync(path.join(packageRoot, "release", "image-tools.json"), "utf8"));
const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

test("every install entry under docker/tools/ is well formed and names what it provides", () => {
  const { entries, problems } = readInstalls();
  assert.deepEqual(problems, []);
  assert.ok(entries.length >= 30, `read ${entries.length} entries`);
  for (const kind of KINDS) assert.ok(fs.existsSync(path.join(TOOLS_CONTEXT, kind)), `docker/tools/${kind}/ exists (the Dockerfile copies it)`);
  const kinds = new Set(entries.map((e) => e.kind));
  for (const kind of ["binaries", "go", "cargo", "dotnet", "apt", "python", "node"]) assert.ok(kinds.has(kind), `an entry of kind ${kind}`);
  const check = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "image-installs.mjs"), "check"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("the runtimes and the install entries give exactly the programs of image.json, with the pins it was built with", () => {
  const programs = imagePrograms();
  assert.deepEqual(Object.keys(programs).sort(), Object.keys(release.tools).sort());
  const pins = installPins(readInstalls().entries);
  for (const [name, pin] of Object.entries(pins)) assert.equal(release.tools[name], pin, `${name} is pinned to the version the image records`);
  const all = imagePins();
  for (const tool of ["hadolint", "trivy", "gitleaks", "cargo-audit", "dotnet-ef", "ruff", "eslint", "stryker", "node", "go", "zap"]) assert.equal(all[tool], release.tools[tool], `${tool} has a pin`);
  // The index carries each program's link, version command or library, and pin.
  const index = installIndex(readInstalls().entries);
  const hadolint = index.entries.find((e) => e.name === "hadolint");
  assert.deepEqual(hadolint.provides, [{ name: "hadolint", link: "hadolint", target: "/opt/tools/binaries/hadolint/hadolint", command: ["hadolint", "--version"], pin: release.tools.hadolint }]);
  const eslint = index.entries.find((e) => e.name === "eslint");
  assert.deepEqual(eslint.provides.find((p) => p.name === "typescript-eslint").library, { packageJson: "/opt/tools/node/eslint/node_modules/typescript-eslint/package.json" });
});

test("a malformed entry is named with its problem", () => {
  const context = tmp("jgates-installs-bad-");
  fs.copyFileSync(path.join(TOOLS_CONTEXT, "Dockerfile"), path.join(context, "Dockerfile"));
  fs.mkdirSync(path.join(context, "binaries"));
  fs.writeFileSync(path.join(context, "binaries", "tool.json"), JSON.stringify({ version: "1.0.0", url: "http://example.invalid/x", sha256: "abc", provides: [{ name: "tool", link: "tool" }] }));
  fs.mkdirSync(path.join(context, "node", "other"), { recursive: true });
  fs.writeFileSync(path.join(context, "node", "other", "package.json"), "{}");
  const { problems } = readInstalls(context);
  const text = problems.join("\n");
  assert.match(text, /binaries\/tool\.json: url must be an https URL/);
  assert.match(text, /binaries\/tool\.json: sha256 must be/);
  assert.match(text, /a link needs the path it points to/);
  assert.match(text, /node\/other\/install\.json is missing/);
});

test("the Dockerfile the build uses is docker/tools/Dockerfile with the parts inserted in name order", () => {
  const plain = assembledDockerfile();
  assert.equal(plain, fs.readFileSync(path.join(TOOLS_CONTEXT, "Dockerfile"), "utf8"), "without parts the assembled text is the file");
  // No tool is a list in the Dockerfile any more: the kinds are loops.
  for (const loop of ["/tmp/install/binaries/*.json", "/tmp/install/go/*.json", "/tmp/install/cargo/*.json", "/tmp/install/dotnet/*.json", "/tmp/install/apt/*.json", "/opt/tools/gem/*/Gemfile.lock", "/opt/tools/locks/python/*/*.txt", "/opt/tools/node/*/"]) assert.ok(plain.includes(loop), `the Dockerfile loops over ${loop}`);
  for (const gone of ["HADOLINT_VERSION", "TRIVY_VERSION", "GITLEAKS_VERSION", "DOTNET_STRYKER_VERSION", "link /opt/tools/node/eslint"]) assert.ok(!plain.includes(gone), `${gone} is no longer in the Dockerfile`);

  const context = tmp("jgates-installs-parts-");
  fs.copyFileSync(path.join(TOOLS_CONTEXT, "Dockerfile"), path.join(context, "Dockerfile"));
  fs.mkdirSync(path.join(context, "parts"));
  for (const name of ["zeta", "alpha"]) {
    fs.writeFileSync(path.join(context, "parts", `${name}.Dockerfile`), `FROM fetch AS part-${name}\nRUN mkdir -p /opt/tools/parts/${name}\n`);
    fs.writeFileSync(path.join(context, "parts", `${name}.json`), JSON.stringify({ version: "1.0.0", provides: [{ name, link: name, path: name, version: [name, "--version"] }] }));
  }
  const text = assembledDockerfile(context);
  const alpha = text.indexOf("FROM fetch AS part-alpha");
  const zeta = text.indexOf("FROM fetch AS part-zeta");
  assert.ok(alpha > 0 && zeta > alpha, "the part stages are inserted in name order");
  assert.ok(zeta < text.indexOf("FROM base AS final"), "before the final stage");
  assert.ok(text.indexOf("COPY --from=part-alpha /opt/tools/parts/alpha /opt/tools/parts/alpha") > text.indexOf("FROM base AS final"), "their results are copied into the final stage");
  const { entries, problems } = readInstalls(context);
  assert.deepEqual(problems, []);
  assert.deepEqual(installPins(entries), { alpha: "1.0.0", zeta: "1.0.0" });
  const staged = stageBuildInputs(tmp("jgates-installs-staged-"), context);
  assert.equal(fs.readFileSync(staged.dockerfile, "utf8"), text);
  assert.equal(JSON.parse(fs.readFileSync(path.join(staged.installsDir, "installs.json"), "utf8")).entries.length, 2);
});

test("the probe builds one entry on the built image with the build's installer and runs the tool under the step contract", () => {
  const { entries } = readInstalls();
  const binary = probeDockerfile(entries.find((e) => e.name === "hadolint"), { toolsPython: "3.14.10" });
  assert.match(binary, /^FROM jgates-tools:dev AS base\nUSER root\n/);
  assert.match(binary, /sh \/usr\/local\/share\/jgates-installers\/binary\.sh \/tmp\/install\/binaries\/hadolint\.json/);
  assert.match(binary, /links\.sh \/usr\/share\/jgates\/probe-installs\.json\nUSER 10001:10001\n/);
  const python = probeDockerfile(entries.find((e) => e.name === "ruff"), { toolsPython: "3.14.10" });
  assert.match(python, /TOOLS_PYTHON_VERSION=3\.14\.10 sh \/usr\/local\/share\/jgates-installers\/python\.sh \/tmp\/install\/python\/3\.15\/ruff\.txt/);
  const node = probeDockerfile(entries.find((e) => e.name === "eslint"), { toolsPython: "3.14.10" });
  assert.match(node, /cp -r \/tmp\/install\/node\/eslint \/opt\/tools\/node\/eslint; sh \/usr\/local\/share\/jgates-installers\/node\.sh \/opt\/tools\/node\/eslint/);
  // The installers the probe runs are the files the Dockerfile copies.
  const dockerfile = fs.readFileSync(path.join(TOOLS_CONTEXT, "Dockerfile"), "utf8");
  for (const script of ["binary", "go", "cargo", "dotnet", "apt", "python", "node", "gem", "links"]) assert.ok(dockerfile.includes(`installers/${script}.sh`), `the build uses installers/${script}.sh`);

  const args = stepArgs({ image: "sha256:abc", workspace: "/w", output: "/o", command: ["hadolint", "Dockerfile"] });
  for (const flag of ["--rm", "--read-only", "--init"]) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2), ["--network", "none"]);
  assert.deepEqual(args.slice(args.indexOf("--user"), args.indexOf("--user") + 2), ["--user", "10001:10001"]);
  assert.ok(args.includes("/tmp:rw,noexec,nosuid,size=256m"));
  assert.ok(args.includes("jproject.project=jgates"), "the probe's containers carry the project label");
  assert.deepEqual(args.slice(-3), ["sha256:abc", "hadolint", "Dockerfile"]);
  const withNetwork = stepArgs({ image: "x", workspace: "/w", output: "/o", network: true, resources: { memoryMb: 6144, tmpfsMb: 512 }, command: ["t"] });
  assert.ok(withNetwork.includes("bridge") && withNetwork.includes("6144m") && withNetwork.includes("/tmp:rw,noexec,nosuid,size=512m"));

  const recordings = legacyRecordings("hadolint");
  assert.deepEqual(recordings.map((r) => `${r.stack}.${r.kind}`), ["docker.bad", "docker.clean"]);
});

test("probes are serialized by a named lock, and the lock of a probe that is gone is taken over", () => {
  const dir = tmp("jgates-probe-lock-");
  const lock = path.join(dir, "probe.lock");
  const release = acquireLock("first", { lock, waitMs: 1000 });
  assert.ok(fs.existsSync(path.join(lock, "owner.json")));
  assert.throws(() => acquireLock("second", { lock, waitMs: 100 }), /still held/);
  release();
  assert.equal(fs.existsSync(lock), false);
  // A lock left by a process that no longer runs.
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), tool: "gone" }));
  const again = acquireLock("third", { lock, waitMs: 1000 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).tool, "third");
  again();
});

test("the build needs three times the previous image's unpacked size free (at least 20 GB) and writes the measured pin", () => {
  assert.equal(requiredFreeGb(null), 20);
  assert.equal(requiredFreeGb({ uncompressedBytes: 6 * 1024 ** 3 }), 20);
  assert.equal(requiredFreeGb({ uncompressedBytes: 13 * 1024 ** 3 }), 39);
  const pin = pinOf({ previous: { name: "jgates-tools", published: false, sizeBytes: 1 }, inspect: { Id: "sha256:" + "a".repeat(64), Size: 4_500_000_000 }, uncompressedBytes: 12_000_000_000, version: "0.4.0", document: { imageVersion: "0.4.0-dev" } });
  assert.deepEqual(pin, { schemaVersion: 1, name: "jgates-tools", reference: "jgates-tools:dev", digest: "sha256:" + "a".repeat(64), imageVersion: "0.4.0-dev", jgatesVersion: "0.4.0", platform: "linux/amd64", sizeBytes: 4_500_000_000, compressedBytes: 4_500_000_000, uncompressedBytes: 12_000_000_000, published: false });
});

test("every linter descriptor names an install entry that provides its program, and declares a license the policy accepts", () => {
  const descriptors = readDescriptors();
  const { entries } = readInstalls();
  assert.deepEqual(checkDescriptorInstalls({ descriptors, entries }).findings, []);
  assert.deepEqual(checkDescriptorLicenses({ descriptors, policy: loadPolicy(), entries }).findings, []);
});
