// Builds the JGates tools image locally as jgates-tools:dev (npm --prefix jgates run image:build), from
// jgates/docker/tools/Dockerfile:
// 1. checks that the drive of the repository has enough free space (default 20 GB, JGATES_IMAGE_BUILD_MIN_FREE_GB);
// 2. builds the JGates CLI (npm run build) and stages it, with the workspace manifests, the repository's lock and the
//    quality sidecar sources, as the named build context `jgates-cli` (a temporary folder, removed at the end);
// 3. builds the `image-json` target to read the tool versions the image records (/etc/jgates/image.json), then the
//    `final` target into the engine with one org.jgates.tool.<tool>.version label per tool (the second build reuses
//    the first one's cache);
// 4. prunes only the dangling images of this project, selected by its label (no unfiltered prune);
// 5. verifies the labels and the image.json of the loaded image, and prints its size;
// 6. runs the gates of image-gates.mjs (versions, licenses, forbidden content, size, image scan, smoke) and fails the
//    build when one fails.
// The build runs on the dedicated buildx builder `jgates-dev`, so its cache is JGates's own. The image carries the
// labels org.jgates.dev=true and jproject.project=jgates.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGates } from "./image-gates.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "..");
const context = path.join(packageRoot, "docker", "tools");
const runtime = process.env.JGATES_CONTAINER_RUNTIME || "docker";
const TAG = "jgates-tools:dev";
const BUILDER = "jgates-dev";
const LABELS = ["org.jgates.dev=true", "jproject.project=jgates"];
const TOOL_LABEL = (tool) => `org.jgates.tool.${tool}.version`;
const GB = 1024 ** 3;

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

function checkFreeSpace() {
  const minGb = Number(process.env.JGATES_IMAGE_BUILD_MIN_FREE_GB ?? "20");
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

function buildArgs(version, cliDir, target) {
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
    "--build-context",
    `jgates-cli=${cliDir}`,
    "--build-arg",
    `JGATES_VERSION=${version}`,
    "--build-arg",
    `IMAGE_VERSION=${version}-dev`,
    "--build-arg",
    `SOURCE_REVISION=${sourceRevision()}`,
  ];
}

function readImageJson(version, cliDir, dir) {
  const out = path.join(dir, "image-json");
  run(runtime, [...buildArgs(version, cliDir, "image-json"), "--output", `type=local,dest=${out}`, context]);
  const document = JSON.parse(fs.readFileSync(path.join(out, "image.json"), "utf8"));
  if (!document.tools || Object.keys(document.tools).length === 0) fail("/etc/jgates/image.json lists no tools");
  return document;
}

function loadImage(version, cliDir, document) {
  const toolLabels = Object.entries(document.tools).map(([tool, toolVersion]) => `${TOOL_LABEL(tool)}=${toolVersion}`);
  const labels = [...LABELS, ...toolLabels].flatMap((label) => ["--label", label]);
  run(runtime, [...buildArgs(version, cliDir, "final"), "--load", "--tag", TAG, ...labels, context]);
}

function verify(expected) {
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
}

let work = null;
try {
  checkFreeSpace();
  work = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-image-build-"));
  const cliDir = path.join(work, "jgates-cli");
  fs.mkdirSync(cliDir);
  const version = stageCli(cliDir);
  ensureBuilder();
  const started = Date.now();
  const document = readImageJson(version, cliDir, work);
  loadImage(version, cliDir, document);
  console.log(`image:build: built ${TAG} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  // Only dangling images of this project, selected by its label.
  run(runtime, ["image", "prune", "-f", "--filter", "label=jproject.project=jgates"]);
  verify(document);
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
