// Builds the JGates tools image locally as jgates-tools:dev (npm --prefix jgates run image:build).
// The image carries the labels org.jgates.dev=true and jproject.project=jgates; after the build the dangling images of
// the project are pruned by that label only (nothing of another project is touched, no unfiltered prune). The build
// runs on the dedicated buildx builder `jgates-dev`, so its cache is JGates's own. Before building, the drive of the
// repository must have enough free space (default 20 GB, JGATES_IMAGE_BUILD_MIN_FREE_GB). At the end the image's
// /etc/jgates/image.json is read in a `--network none --pull never` container and must list its tools.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = path.join(packageRoot, "docker", "tools");
const runtime = process.env.JGATES_CONTAINER_RUNTIME || "docker";
const TAG = "jgates-tools:dev";
const BUILDER = "jgates-dev";
const LABELS = ["org.jgates.dev=true", "jproject.project=jgates"];
const REQUIRED_TOOLS = ["ruff", "pytest", "uv"];
const GB = 1024 ** 3;

function fail(message) {
  console.error(`image:build: ${message}`);
  process.exit(1);
}

function run(executable, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", maxBuffer: 64 * 1024 * 1024 });
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

function ensureBuilder() {
  if (run(runtime, ["buildx", "inspect", BUILDER], { capture: true, allowFailure: true }).code === 0) return;
  run(runtime, ["buildx", "create", "--name", BUILDER, "--driver", "docker-container", "--bootstrap"]);
}

function build() {
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  const revision = sourceRevision();
  const args = [
    "buildx",
    "build",
    "--builder",
    BUILDER,
    "--load",
    "--provenance=false",
    "--sbom=false",
    "--progress",
    process.env.JGATES_IMAGE_BUILD_PROGRESS || "plain",
    "--tag",
    TAG,
    ...LABELS.flatMap((label) => ["--label", label]),
    "--build-arg",
    `JGATES_VERSION=${version}`,
    "--build-arg",
    `IMAGE_VERSION=${version}-dev`,
    "--build-arg",
    `SOURCE_REVISION=${revision}`,
    context,
  ];
  const started = Date.now();
  run(runtime, args);
  console.log(`image:build: built ${TAG} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

function verify() {
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
  const missing = REQUIRED_TOOLS.filter((tool) => typeof document.tools?.[tool] !== "string");
  if (missing.length > 0) fail(`/etc/jgates/image.json lacks the tools ${missing.join(", ")}`);
  console.log(`image:build: ${TAG} ${inspect.Id}`);
  console.log(`image:build: tools ${JSON.stringify(document.tools)}`);
}

checkFreeSpace();
ensureBuilder();
build();
// Only dangling images of this project, selected by its label.
run(runtime, ["image", "prune", "-f", "--filter", "label=jproject.project=jgates"]);
verify();
