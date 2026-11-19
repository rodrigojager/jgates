// Builds the JGates tools image locally as jgates-tools:dev (npm --prefix jgates run image:build), from
// jgates/docker/tools/Dockerfile assembled with its parts (scripts/image-installs.mjs):
// 1. checks that the drive of the repository has enough free space: three times the unpacked size of the previous image
//    (release/tools-image.json), at least 20 GB (JGATES_IMAGE_BUILD_MIN_FREE_GB overrides);
// 2. builds the JGates CLI (npm run build) and stages it, with the workspace manifests, the repository's lock and the
//    quality sidecar sources, as the named build context `jgates-cli`; writes the assembled Dockerfile and the index of
//    the install entries (named context `jgates-installs`) beside it (a temporary folder, removed at the end);
// 3. builds the `image-json` target to read the tool versions the image records (/etc/jgates/image.json), then the
//    `final` target into the engine with one org.jgates.tool.<tool>.version label per tool (the second build reuses
//    the first one's cache);
// 4. prunes only the dangling images of this project, selected by its label (no unfiltered prune);
// 5. verifies the labels and the image.json of the loaded image, measures its size and writes the pin
//    (release/tools-image.json: reference, digest, compressed and unpacked size), so DISK_LOW is computed from the real
//    size of the image;
// 6. runs the gates of image-gates.mjs (versions, licenses, forbidden content, size report, image scan, smoke) and
//    fails the build when one fails (the size is reported, never a failure: ADR-0020).
// The build runs on the dedicated buildx builder `jgates-dev`, so its cache is JGates's own. The image carries the
// labels org.jgates.dev=true and jproject.project=jgates.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGates } from "./image-gates.mjs";
import { stageBuildInputs } from "./image-installs.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "..");
const context = path.join(packageRoot, "docker", "tools");
const runtime = process.env.JGATES_CONTAINER_RUNTIME || "docker";
const TAG = "jgates-tools:dev";
const BUILDER = "jgates-dev";
const LABELS = ["org.jgates.dev=true", "jproject.project=jgates"];
const TOOL_LABEL = (tool) => `org.jgates.tool.${tool}.version`;
const GB = 1024 ** 3;
const PIN_FILE = path.join(packageRoot, "release", "tools-image.json");
/** The free space a build needs: three times the unpacked size of the previous image, never less than this. */
export const MIN_FREE_GB = 20;

class BuildFailure extends Error {}

function fail(message) {
  throw new BuildFailure(message);
}

function run(executable, args, { capture = false, allowFailure = false, cwd } = {}) {
  let command = [executable, args, false];
  if (executable === "npm") {
    // Under `npm run`, npm's own script runs with this Node; otherwise npm (a .cmd script on Windows) goes through a shell.
    const npmCli = process.env.npm_execpath;
    command = npmCli && /\.c?js$/.test(npmCli) ? [process.execPath, [npmCli, ...args], false] : [["npm", ...args].join(" "), [], true];
  }
  const [file, argv, shell] = command;
  const result = spawnSync(file, argv, { cwd, shell, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) fail(`${executable} could not start: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) fail(`${executable} ${args.join(" ")} exited with ${result.status}${capture ? `: ${(result.stderr || result.stdout).trim()}` : ""}`);
  return { code: result.status, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

/** Three times the previous image's unpacked size (the pin), at least MIN_FREE_GB; in GB. */
export function requiredFreeGb(pin) {
  const unpacked = Number(pin?.uncompressedBytes ?? 0);
  return Math.max(MIN_FREE_GB, Math.ceil((3 * (Number.isFinite(unpacked) ? unpacked : 0)) / GB));
}

function readPin() {
  try {
    return JSON.parse(fs.readFileSync(PIN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function checkFreeSpace() {
  const minGb = Number(process.env.JGATES_IMAGE_BUILD_MIN_FREE_GB ?? String(requiredFreeGb(readPin())));
  if (!Number.isFinite(minGb) || minGb < 0) fail(`JGATES_IMAGE_BUILD_MIN_FREE_GB must be a non-negative number, got ${process.env.JGATES_IMAGE_BUILD_MIN_FREE_GB}`);
  const stats = fs.statfsSync(packageRoot);
  const freeGb = (stats.bavail * stats.bsize) / GB;
  if (freeGb < minGb) fail(`only ${freeGb.toFixed(1)} GB free on the drive of ${packageRoot}; the build needs at least ${minGb} GB`);
  console.log(`image:build: ${freeGb.toFixed(1)} GB free (minimum ${minGb} GB)`);
}

function sourceRevision() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

// The files of the JGates CLI the image needs, relative to the repository: the workspace manifests and lock (npm ci of
// the jgates workspace), the built package, and the quality sidecar (PII, file size, tomlkit helper) with its schemas.
const CLI_FILES = [
  "package.json",
  "package-lock.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "jgates/package.json",
  "jgates/dist",
  "jgates/schemas",
  "jgates/packs",
  "jgates/vendor",
  "jgates/release",
  "jgates/skill",
  "semantic-gate/package.json",
  "quality-gate/package.json",
  "quality-gate/pyproject.toml",
  "quality-gate/sidecar",
  "quality-gate/schemas",
];

function stageCli(dir) {
  run("npm", ["run", "build"], { cwd: packageRoot });
  const skip = (source) => /(^|[\\/])(__pycache__|node_modules)([\\/]|$)/.test(source) || source.endsWith(".pyc");
  for (const relative of CLI_FILES) {
    const source = path.join(repositoryRoot, relative);
    if (!fs.existsSync(source)) fail(`${relative} is missing: the image needs it`);
    fs.cpSync(source, path.join(dir, relative), { recursive: true, filter: (from) => !skip(path.relative(repositoryRoot, from)) });
  }
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  console.log(`image:build: staged the JGates CLI ${version}`);
  return version;
}

// The builder runs with docker/tools/buildkitd.toml (one build step at a time). A `jgates-dev` builder created without
// it (by an earlier version of this script) is recreated with --keep-state, so its build cache survives. Only this
// builder is ever touched.
const BUILDKITD_CONFIG = path.join(context, "buildkitd.toml");
const BUILDER_CONTAINER = `buildx_buildkit_${BUILDER}0`;

function builderConfigured() {
  const shown = run(runtime, ["exec", BUILDER_CONTAINER, "cat", "/etc/buildkit/buildkitd.toml"], { capture: true, allowFailure: true });
  return shown.code === 0 && /max-parallelism\s*=\s*1\b/.test(shown.out);
}

function ensureBuilder() {
  const exists = run(runtime, ["buildx", "inspect", "--bootstrap", BUILDER], { capture: true, allowFailure: true }).code === 0;
  if (exists && builderConfigured()) return;
  if (exists) {
    console.log(`image:build: recreating the builder ${BUILDER} with ${path.basename(BUILDKITD_CONFIG)} (cache kept)`);
    run(runtime, ["buildx", "rm", "--keep-state", BUILDER]);
  }
  run(runtime, ["buildx", "create", "--name", BUILDER, "--driver", "docker-container", "--buildkitd-config", BUILDKITD_CONFIG, "--bootstrap"]);
  if (!builderConfigured()) fail(`the builder ${BUILDER} does not run with ${BUILDKITD_CONFIG}`);
}

function buildArgs(version, inputs, target) {
  return [
    "buildx",
    "build",
    "--builder",
    BUILDER,
    "--platform",
    "linux/amd64",
    "--provenance=false",
    "--sbom=false",
    "--progress",
    process.env.JGATES_IMAGE_BUILD_PROGRESS || "plain",
    "--target",
    target,
    "--file",
    inputs.dockerfile,
    "--build-context",
    `jgates-cli=${inputs.cliDir}`,
    "--build-context",
    `jgates-installs=${inputs.installsDir}`,
    "--build-arg",
    `JGATES_VERSION=${version}`,
    "--build-arg",
    `IMAGE_VERSION=${version}-dev`,
    "--build-arg",
    `SOURCE_REVISION=${sourceRevision()}`,
  ];
}

function readImageJson(version, inputs, dir) {
  const out = path.join(dir, "image-json");
  run(runtime, [...buildArgs(version, inputs, "image-json"), "--output", `type=local,dest=${out}`, context]);
  const document = JSON.parse(fs.readFileSync(path.join(out, "image.json"), "utf8"));
  if (!document.tools || Object.keys(document.tools).length === 0) fail("/etc/jgates/image.json lists no tools");
  return document;
}

function loadImage(version, inputs, document) {
  const toolLabels = Object.entries(document.tools).map(([tool, toolVersion]) => `${TOOL_LABEL(tool)}=${toolVersion}`);
  const labels = [...LABELS, ...toolLabels].flatMap((label) => ["--label", label]);
  run(runtime, [...buildArgs(version, inputs, "final"), "--load", "--tag", TAG, ...labels, context]);
}

/**
 * The pin of the built image (release/tools-image.json), from what the engine measured: the engine's image size is
 * what a pull transfers (compressed layers), the sum of the history entries is the unpacked size. The fields a person
 * keeps (published, name) are carried over.
 */
export function pinOf({ previous, inspect, uncompressedBytes, version, document }) {
  const compressedBytes = Number(inspect.Size);
  return {
    schemaVersion: 1,
    name: previous?.name ?? "jgates-tools",
    reference: TAG,
    digest: inspect.Id,
    imageVersion: document.imageVersion ?? `${version}-dev`,
    jgatesVersion: version,
    platform: "linux/amd64",
    sizeBytes: compressedBytes,
    compressedBytes,
    uncompressedBytes,
    published: previous?.published ?? false,
  };
}

function verify(expected, version) {
  const inspect = JSON.parse(run(runtime, ["image", "inspect", TAG], { capture: true }).out)[0];
  const labels = inspect.Config?.Labels ?? {};
  for (const label of LABELS) {
    const [key, value] = label.split("=");
    if (labels[key] !== value) fail(`the image lacks the label ${label}`);
  }
  const shown = run(runtime, ["run", "--rm", "--pull", "never", "--network", "none", TAG, "cat", "/etc/jgates/image.json"], { capture: true }).out;
  let document;
  try {
    document = JSON.parse(shown);
  } catch {
    fail(`/etc/jgates/image.json is not JSON: ${shown.slice(0, 200)}`);
  }
  for (const [tool, version] of Object.entries(document.tools ?? {})) {
    if (expected.tools[tool] !== version) fail(`image.json of the loaded image differs from the exported one for ${tool}`);
    if (labels[TOOL_LABEL(tool)] !== version) fail(`the label ${TOOL_LABEL(tool)} is ${labels[TOOL_LABEL(tool)]}, image.json says ${version}`);
  }
  const layers = run(runtime, ["history", "--no-trunc", "--human=false", "--format", "{{.Size}}", TAG], { capture: true }).out.split(/\s+/).filter(Boolean);
  const uncompressed = layers.reduce((sum, size) => sum + Number(size), 0);
  console.log(`image:build: ${TAG} ${inspect.Id}`);
  console.log(`image:build: size ${(inspect.Size / 1e9).toFixed(2)} GB (engine image size), ${(uncompressed / 1e9).toFixed(2)} GB uncompressed (sum of the layers)`);
  console.log(`image:build: ${Object.keys(document.tools).length} tools ${JSON.stringify(document.tools)}`);
  const pin = pinOf({ previous: readPin(), inspect, uncompressedBytes: uncompressed, version, document });
  fs.writeFileSync(PIN_FILE, `${JSON.stringify(pin, null, 2)}\n`);
  console.log(`image:build: wrote ${path.relative(repositoryRoot, PIN_FILE)} (${pin.compressedBytes} bytes compressed, ${pin.uncompressedBytes} unpacked)`);
}

async function main() {
  let work = null;
  try {
    checkFreeSpace();
    work = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-image-build-"));
    const cliDir = path.join(work, "jgates-cli");
    fs.mkdirSync(cliDir);
    let staged;
    try {
      staged = stageBuildInputs(work, context);
    } catch (error) {
      fail(error.message);
    }
    const inputs = { cliDir, dockerfile: staged.dockerfile, installsDir: staged.installsDir };
    console.log(`image:build: ${staged.entries.length} install entries`);
    const version = stageCli(cliDir);
    ensureBuilder();
    const started = Date.now();
    const document = readImageJson(version, inputs, work);
    loadImage(version, inputs, document);
    console.log(`image:build: built ${TAG} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    // Only dangling images of this project, selected by its label.
    run(runtime, ["image", "prune", "-f", "--filter", "label=jproject.project=jgates"]);
    verify(document, version);
    // The gates of PLAN-image.md section 5 on the loaded image; the reports go to _work/00-tmp/v2-container-image/.
    const gates = await runGates({ image: TAG });
    console.log(`image:build: gates ${gates.passed ? "passed" : "FAILED"}; reports in ${gates.outDir}`);
    if (!gates.passed) fail("the image failed a build gate (see above and gates-report.json)");
  } catch (error) {
    if (!(error instanceof BuildFailure)) throw error;
    console.error(`image:build: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
