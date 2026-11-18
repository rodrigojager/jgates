// Records a tool's real output from the tools image (PLAN-image.md section 7): npm --prefix jgates run image:probe -- <tool>
//   1. builds, on top of the current jgates-tools:dev, only the install of that tool, with the installer the image build
//      uses (docker/tools/installers/) and the tool's install entry (scripts/image-installs.mjs);
//   2. runs the tool under the step contract (non-root, read-only root, no network unless the descriptor declares it,
//      /tmp a noexec tmpfs, the descriptor's memory and CPUs) on its `bad` and `clean` fixtures:
//      - a linter descriptor (src/builtin/linters/<tool>/): the fixtures tests/fixtures/linters/<tool>/<kind>/ prepared
//        as the per-tool test prepares them (git init, the minimal init), the very calls the engine plans for them
//        (linterCalls of the built engine, inside the image's semantics), written to recorded/<kind>.json as
//        {tool, kind, version, calls: [{args, exit, stdout, stderr, reportPath, report}]};
//      - an existing adapter with recordings in tests/fixtures/lint-stacks/recorded/ (hadolint, shellcheck...): the
//        recorded command on its fixture, compared with the recording ("reproduces" or the difference; --write
//        replaces the recording);
//   3. prints the tool's version, its license files and its installed size (--install-only stops here: any install
//      entry or program name, to check an install before its fixtures exist);
//   4. removes what it created: the probe image has no tag and carries the label jproject.project=jgates, its
//      containers run with --rm, the scratch folders are deleted. No other image is touched.
// Probes are serialized through a named lock (a folder under the scratch root; a lock whose process is gone is taken
// over), so many tool slices in progress never run several builds at once. The scratch root is the container's
// _work/00-tmp/image-probe when it exists, else the system's temporary folder. The JGates CLI must be built
// (npm --prefix jgates run build) for a descriptor; JGATES_PROBE_BASE names another base image.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TOOLS_CONTEXT, findInstall, installIndex, readInstalls, readParts, partsText } from "./image-installs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repositoryRoot = path.resolve(packageRoot, "..");
const runtime = process.env.JGATES_CONTAINER_RUNTIME || "docker";
const BASE = process.env.JGATES_PROBE_BASE || "jgates-tools:dev";
const LABELS = ["jproject.project=jgates", "org.jgates.dev=true", "org.jgates.kind=probe"];
const FIXTURES = path.join(packageRoot, "tests", "fixtures");
const LINTERS_SRC = path.join(packageRoot, "src", "builtin", "linters");
const DIST = path.join(packageRoot, "dist");
const containerWork = path.resolve(repositoryRoot, "..", "_work", "00-tmp");
export const SCRATCH = process.env.JGATES_PROBE_SCRATCH || (fs.existsSync(containerWork) ? path.join(containerWork, "image-probe") : path.join(os.tmpdir(), "jgates-image-probe"));
const LOCK = path.join(SCRATCH, "probe.lock");
const STEP = { memoryMb: 4096, cpus: 2, pids: 256, tmpfsMb: 256 };

class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};
const say = (message) => console.log(`image:probe: ${message}`);

function run(executable, args, { capture = true, allowFailure = false, timeout = 60 * 60_000, input } = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: capture ? ["pipe", "pipe", "pipe"] : ["ignore", "inherit", "inherit"], input, maxBuffer: 512 * 1024 * 1024, timeout });
  if (result.error) fail(`${executable} could not start: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) fail(`${executable} ${args.slice(0, 3).join(" ")} exited with ${result.status}${capture ? `: ${(result.stderr || result.stdout || "").trim().slice(-1500)}` : ""}`);
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

// ---------------------------------------------------------------------------------------------------------------------
// The named lock
// ---------------------------------------------------------------------------------------------------------------------

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Takes the probe lock, waiting for the probe that holds it; a lock of a process that is gone is taken over. */
export function acquireLock(tool, { lock = LOCK, waitMs = 90 * 60_000 } = {}) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const started = Date.now();
  let told = false;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, host: os.hostname(), tool, since: new Date().toISOString() })}\n`);
      return () => fs.rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
    } catch {
      owner = null;
    }
    const age = Date.now() - fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
    if ((owner && owner.host === os.hostname() && !alive(owner.pid)) || (!owner && age > 60_000)) {
      say(`taking over the lock of a probe that is gone (${owner ? `${owner.tool}, pid ${owner.pid}` : "no owner"})`);
      fs.rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (!told) {
      say(`waiting for the probe of ${owner?.tool ?? "another tool"} (pid ${owner?.pid ?? "?"}) to finish: probes run one at a time`);
      told = true;
    }
    if (Date.now() - started > waitMs) fail(`the probe lock ${lock} is still held after ${Math.round(waitMs / 60_000)} minutes`);
    sleep(2000);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The probe image
// ---------------------------------------------------------------------------------------------------------------------

/** The files of one entry, relative to the tools context, and the commands that install it in the probe image. */
function entryInstall(entry, toolsPython) {
  const I = "/usr/local/share/jgates-installers";
  const files = [];
  let steps = [];
  switch (entry.kind) {
    case "binaries":
    case "go":
    case "cargo":
    case "dotnet":
    case "apt": {
      files.push(`${entry.kind}/${entry.name}.json`);
      const script = { binaries: "binary", go: "go", cargo: "cargo", dotnet: "dotnet", apt: "apt" }[entry.kind];
      steps = [`sh ${I}/${script}.sh /tmp/install/${entry.kind}/${entry.name}.json`];
      break;
    }
    case "python":
      for (const suffix of ["in", "txt", "json"]) files.push(`python/${entry.python}/${entry.name}.${suffix}`);
      steps = [`UV_PYTHON_INSTALL_DIR=/opt/tools/python-runtime TOOLS_PYTHON_VERSION=${toolsPython} sh ${I}/python.sh /tmp/install/python/${entry.python}/${entry.name}.txt`];
      break;
    case "node":
    case "gem":
      files.push(`${entry.kind}/${entry.name}`);
      steps = [`rm -rf ${entry.dir}`, `mkdir -p /opt/tools/${entry.kind}`, `cp -r /tmp/install/${entry.kind}/${entry.name} ${entry.dir}`, `sh ${I}/${entry.kind}.sh ${entry.dir}`];
      break;
    case "parts":
      break;
    default:
      fail(`unknown install kind ${entry.kind}`);
  }
  return { files, steps };
}

/** The Dockerfile of the probe image: the base image, the entry's install, its links; root only while installing. */
export function probeDockerfile(entry, { base = BASE, toolsPython, parts = [] } = {}) {
  const { steps } = entryInstall(entry, toolsPython);
  const part = entry.kind === "parts" ? parts.find((p) => p.name === entry.name) : null;
  if (entry.kind === "parts" && !part) fail(`parts/${entry.name}.Dockerfile is missing`);
  const { stages, copies } = partsText(part ? [part] : []);
  return [
    `FROM ${base} AS base`,
    "USER root",
    "FROM base AS fetch",
    "COPY --chmod=0555 fetch.sh /usr/local/bin/fetch",
    ...(stages ? [stages] : []),
    "FROM fetch AS probe",
    "COPY installers/ /usr/local/share/jgates-installers/",
    "COPY install/ /tmp/install/",
    ...(steps.length > 0 ? [`RUN set -eux; ${steps.join("; ")}; rm -rf /tmp/install`] : ["RUN rm -rf /tmp/install"]),
    ...(copies ? [copies] : []),
    "COPY installs.json /usr/share/jgates/probe-installs.json",
    "RUN sh /usr/local/share/jgates-installers/links.sh /usr/share/jgates/probe-installs.json",
    "USER 10001:10001",
    "WORKDIR /workspace",
    "",
  ].join("\n");
}

function builderName() {
  if (process.env.JGATES_PROBE_BUILDER) return process.env.JGATES_PROBE_BUILDER;
  // The builder of the current context uses the engine's own image store, so the local jgates-tools:dev is the base.
  const shown = run(runtime, ["context", "show"], { allowFailure: true });
  return shown.code === 0 && shown.out.trim() ? shown.out.trim() : "default";
}

function buildImage(entry, toolsPython, scratch) {
  const ctx = fs.mkdtempSync(path.join(scratch, "build-"));
  fs.copyFileSync(path.join(TOOLS_CONTEXT, "fetch.sh"), path.join(ctx, "fetch.sh"));
  fs.cpSync(path.join(TOOLS_CONTEXT, "installers"), path.join(ctx, "installers"), { recursive: true });
  fs.mkdirSync(path.join(ctx, "install"), { recursive: true });
  for (const relative of entryInstall(entry, toolsPython).files) fs.cpSync(path.join(TOOLS_CONTEXT, ...relative.split("/")), path.join(ctx, "install", ...relative.split("/")), { recursive: true });
  fs.writeFileSync(path.join(ctx, "installs.json"), `${JSON.stringify(installIndex([entry]), null, 2)}\n`);
  fs.writeFileSync(path.join(ctx, "Dockerfile"), probeDockerfile(entry, { toolsPython, parts: readParts() }));
  const iid = path.join(scratch, "image.id");
  const started = Date.now();
  say(`building the install of ${entry.file} on ${BASE}`);
  const labels = LABELS.flatMap((label) => ["--label", label]);
  run(runtime, ["buildx", "build", "--builder", builderName(), "--load", "--progress", process.env.JGATES_PROBE_PROGRESS || "quiet", "--iidfile", iid, ...labels, "--label", `org.jgates.probe=${entry.name}`, "-f", path.join(ctx, "Dockerfile"), ctx], { capture: process.env.JGATES_PROBE_PROGRESS === undefined });
  const id = fs.readFileSync(iid, "utf8").trim();
  say(`built ${id.slice(0, 19)} in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  return id;
}

/** `docker run` under the step contract (as the runner starts a step container), with the workspace and the run folder. */
export function stepArgs({ image, workspace, output, network = false, resources = {}, env = {}, command }) {
  const memory = resources.memoryMb ?? STEP.memoryMb;
  return [
    "run",
    "--rm",
    "--init",
    "--pull",
    "never",
    "--read-only",
    "--network",
    network ? "bridge" : "none",
    "--memory",
    `${memory}m`,
    "--memory-swap",
    `${memory}m`,
    "--cpus",
    String(resources.cpus ?? STEP.cpus),
    "--pids-limit",
    String(STEP.pids),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,size=${resources.tmpfsMb ?? STEP.tmpfsMb}m`,
    "--user",
    "10001:10001",
    "--mount",
    `type=bind,src=${path.resolve(workspace)},dst=/workspace`,
    "--mount",
    `type=bind,src=${path.resolve(output)},dst=/output`,
    "--workdir",
    "/workspace",
    ...LABELS.flatMap((label) => ["--label", label]),
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    image,
    ...command,
  ];
}

/** The version, the license files and the installed size of the entry, from the probe image (as root, no network). */
function describe(image, entry, toolName) {
  const provide = entry.provides.find((p) => p.name === toolName) ?? entry.provides.find((p) => p.version);
  const quote = (word) => `'${String(word).replace(/'/g, "'\\''")}'`;
  const version = provide?.version ? provide.version.map(quote).join(" ") : "true";
  const own = entry.kind === "dotnet" ? `/opt/dotnet-tools/.store/${String(entry.meta.package).toLowerCase()}` : entry.dir;
  const where = entry.kind === "apt" ? entry.meta.packages.map((p) => `/usr/share/doc/${p}`).join(" ") : own;
  const size = entry.kind === "apt" ? `dpkg-query -W -f '\${Installed-Size}\\n' ${entry.meta.packages.join(" ")} | awk '{s+=$1} END {print s*1024}'` : `du -sb ${own} | cut -f1`;
  const script = [
    `printf '\\036version\\n'; ${version} 2>&1 || true`,
    `printf '\\036licenses\\n'; find ${where} -maxdepth 6 -type f \\( -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'COPYING*' -o -iname 'copyright' -o -iname 'NOTICE*' \\) 2>/dev/null | head -n 20`,
    `printf '\\036size\\n'; ${size}`,
  ].join("; ");
  const shown = run(runtime, ["run", "--rm", "--pull", "never", "--network", "none", "--user", "0", "--entrypoint", "sh", ...LABELS.flatMap((l) => ["--label", l]), image, "-c", script], { allowFailure: true });
  const parts = Object.fromEntries(shown.out.split("\u001e").filter(Boolean).map((chunk) => [chunk.slice(0, chunk.indexOf("\n")), chunk.slice(chunk.indexOf("\n") + 1).trim()]));
  const match = provide?.version ? new RegExp(provide.pattern ?? "(\\d+\\.\\d+(?:\\.\\d+)?)", "m").exec(parts.version ?? "") : null;
  const licenseFiles = (parts.licenses ?? "").split("\n").filter(Boolean);
  let licenseHead = "";
  if (licenseFiles[0]) licenseHead = run(runtime, ["run", "--rm", "--pull", "never", "--network", "none", "--user", "0", "--entrypoint", "head", ...LABELS.flatMap((l) => ["--label", l]), image, "-n", "3", licenseFiles[0]], { allowFailure: true }).out.trim();
  return { version: match ? match[1] : null, versionText: (parts.version ?? "").slice(0, 300), licenseFiles, licenseHead, sizeBytes: Number(parts.size) || null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures and calls
// ---------------------------------------------------------------------------------------------------------------------

const exitOf = (code) => (code === null ? -1 : code);

/**
 * Copies a fixture folder into a probe workspace with the content the repository holds: a tracked text file that git
 * stores with LF but checked out with CRLF (core.autocrlf on Windows) is written with LF, so the tool sees what a Linux
 * checkout and the image's smoke see, and the recording does not depend on the machine that made it.
 */
export function copyFixture(from, to) {
  fs.cpSync(from, to, { recursive: true });
  const listed = spawnSync("git", ["ls-files", "--eol", "-z", "--", "."], { cwd: from, encoding: "utf8" });
  if (listed.status !== 0) return [];
  const converted = [];
  for (const record of listed.stdout.split("\0").filter(Boolean)) {
    const match = /^i\/(\S+)\s+w\/(\S+)\s+attr\/\S*\s*\t(.+)$/.exec(record);
    if (!match || match[1] !== "lf" || match[2] !== "crlf") continue;
    const file = path.join(to, ...match[3].split("/"));
    if (!fs.existsSync(file)) continue;
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
    converted.push(match[3]);
  }
  return converted;
}

function runCall(image, { workspace, output, network, resources, env, executable, args, timeoutSeconds }) {
  const result = spawnSync(runtime, stepArgs({ image, workspace, output, network, resources, env, command: [executable, ...args] }), { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: (timeoutSeconds ?? 600) * 1000 });
  if (result.error) fail(`${runtime} run could not start: ${result.error.message}`);
  return { exit: exitOf(result.status), stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The recordings of the existing adapters (tests/fixtures/lint-stacks/recorded/<stack>.<kind>.json) that name the tool. */
export function legacyRecordings(tool, root = path.join(FIXTURES, "lint-stacks")) {
  const dir = path.join(root, "recorded");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^[^.]+\.[^.]+\.json$/.test(name))
    .sort()
    .map((name) => {
      const [stack, kind] = name.split(".");
      const file = path.join(dir, name);
      return { file, stack, kind, fixture: path.join(root, stack, kind), recording: JSON.parse(fs.readFileSync(file, "utf8")) };
    })
    .filter((entry) => entry.recording.tool === tool && fs.existsSync(entry.fixture));
}

function probeLegacy(image, tool, recordings, scratch, write) {
  let same = true;
  for (const item of recordings) {
    const workspace = fs.mkdtempSync(path.join(scratch, `ws-${item.kind}-`));
    const output = fs.mkdtempSync(path.join(scratch, `out-${item.kind}-`));
    copyFixture(item.fixture, workspace);
    const rec = item.recording;
    const got = runCall(image, { workspace, output, executable: rec.executable ?? tool, args: rec.args, env: { NO_COLOR: "1" } });
    const differences = [];
    if (got.exit !== rec.exit) differences.push(`exit ${got.exit}, recorded ${rec.exit}`);
    if (got.stdout !== rec.stdout) differences.push(`stdout differs:\n    got:      ${JSON.stringify(got.stdout).slice(0, 600)}\n    recorded: ${JSON.stringify(rec.stdout).slice(0, 600)}`);
    if (rec.stderr !== undefined && got.stderr !== rec.stderr) differences.push(`stderr differs:\n    got:      ${JSON.stringify(got.stderr).slice(0, 400)}\n    recorded: ${JSON.stringify(rec.stderr).slice(0, 400)}`);
    const shown = path.relative(repositoryRoot, item.file).split(path.sep).join("/");
    if (differences.length === 0) say(`${item.stack}/${item.kind}: reproduces ${shown} (exit ${got.exit}, ${got.stdout.length} bytes of stdout)`);
    else {
      same = false;
      say(`${item.stack}/${item.kind}: DIFFERS from ${shown}:\n  ${differences.join("\n  ")}`);
      if (got.stderr && rec.stderr === undefined) say(`  stderr: ${got.stderr.trim().slice(0, 400)}`);
      if (write) {
        fs.writeFileSync(item.file, `${JSON.stringify({ ...rec, exit: got.exit, stdout: got.stdout }, null, 1)}\n`);
        say(`  wrote ${shown}`);
      }
    }
  }
  return same;
}

async function engineModules() {
  const engineFile = path.join(DIST, "adapters", "linter", "index.js");
  if (!fs.existsSync(engineFile)) fail("the JGates CLI is not built: run npm --prefix jgates run build first");
  const engine = await import(pathToFileURL(engineFile).href);
  if (typeof engine.linterCalls !== "function") fail("the built JGates CLI is older than this probe: run npm --prefix jgates run build first");
  const { planInit, writeInit } = await import(pathToFileURL(path.join(DIST, "core", "init", "index.js")).href);
  const { buildPlan } = await import(pathToFileURL(path.join(DIST, "core", "plan", "index.js")).href);
  return { engine, planInit, writeInit, buildPlan };
}

/** The descriptor folders of dist follow src (copy-assets copies them; a stale copy is refreshed, the code is not). */
function refreshDescriptors() {
  const out = path.join(DIST, "builtin", "linters");
  const same = (a, b) => {
    if (!fs.existsSync(b)) return false;
    for (const entry of fs.readdirSync(a, { withFileTypes: true })) {
      const left = path.join(a, entry.name);
      const right = path.join(b, entry.name);
      if (entry.isDirectory() ? !same(left, right) : !fs.existsSync(right) || !fs.readFileSync(left).equals(fs.readFileSync(right))) return false;
    }
    return true;
  };
  if (!same(LINTERS_SRC, out)) {
    say("the descriptors of dist/ are older than src/: copying them (node scripts/copy-assets.mjs)");
    run(process.execPath, [path.join(here, "copy-assets.mjs")]);
  }
}

async function probeDescriptor(image, descriptor, linter, version, scratch) {
  const { engine, planInit, writeInit, buildPlan } = await engineModules();
  const id = descriptor.id;
  const release = JSON.parse(fs.readFileSync(path.join(packageRoot, "release", "image-tools.json"), "utf8"));
  const imageJson = path.join(scratch, "image.json");
  fs.writeFileSync(imageJson, `${JSON.stringify({ ...release, tools: { ...release.tools, [descriptor.program.tool]: version ?? release.tools[descriptor.program.tool] ?? "0.0.0" } }, null, 2)}\n`);
  const home = fs.mkdtempSync(path.join(scratch, "home-"));
  // The plan is built as the per-tool test builds it (tests/setup/linter-harness.mjs): inside the image's semantics,
  // with an override that only stands for the program (the calls carry the image's command instead).
  const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1", JGATES_LOCALE: "en", JGATES_IMAGE_JSON: imageJson, JGATES_LINTERS_EXTRA_DIR: "", [engine.linterOverrideEnv(id)]: process.execPath };
  const executable = descriptor.program.command ?? descriptor.program.tool;
  const recordedDir = path.join(FIXTURES, "linters", id, "recorded");
  for (const kind of ["bad", "clean"]) {
    const fixture = path.join(FIXTURES, "linters", id, kind);
    if (!fs.existsSync(fixture)) fail(`tests/fixtures/linters/${id}/${kind}/ is missing: the probe runs the tool on the bad and clean fixtures`);
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(scratch, `ws-${kind}-`)));
    const output = fs.mkdtempSync(path.join(scratch, `out-${kind}-`));
    copyFixture(fixture, workspace);
    if (spawnSync("git", ["init", "-q"], { cwd: workspace }).status !== 0) fail("git init failed in the probe workspace");
    writeInit(workspace, planInit(workspace, "minimal"));
    const built = buildPlan(workspace, { only: [`tool:${id}`], env, home, compare: false, version: "probe" });
    if (!built.ok) fail(`the plan of ${id} on the ${kind} fixture failed: ${JSON.stringify(built.errors ?? built.error).slice(0, 600)}`);
    const invocation = built.plan.invocations.find((i) => i.id === id);
    if (!invocation) fail(`the plan of the ${kind} fixture has no step of ${id}: does its activation pick the fixture's files?`);
    const contract = invocation.contract;
    if (contract.defaultConfig) {
      const target = path.join(output, "linters", id, contract.defaultConfig);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(linter.dir, contract.defaultConfig), target);
    }
    const calls = engine.linterCalls(descriptor, contract, { executable, args: invocation.command.args }, { runDir: "/output", workspace: "/workspace" }, false);
    const callEnv = Object.fromEntries(Object.entries(invocation.command.env ?? {}).map(([k, v]) => [k, String(v).split("{runDir}").join("/output").split("{workspace}").join("/workspace")]));
    const recorded = [];
    for (const call of calls) {
      if (call.report) fs.mkdirSync(path.join(output, ...path.posix.dirname(call.report).replace(/^\/output\/?/, "").split("/").filter(Boolean)), { recursive: true });
      const got = runCall(image, { workspace, output, network: descriptor.run.network, resources: descriptor.run.resources ?? {}, env: callEnv, executable: call.executable, args: call.args, timeoutSeconds: descriptor.run.timeoutSeconds });
      const entry = { args: call.args, exit: got.exit, stdout: got.stdout, stderr: got.stderr };
      if (call.report) {
        const host = path.join(output, ...call.report.replace(/^\/output\/?/, "").split("/"));
        entry.reportPath = call.report;
        entry.report = fs.existsSync(host) ? fs.readFileSync(host, "utf8") : null;
      }
      recorded.push(entry);
    }
    fs.mkdirSync(recordedDir, { recursive: true });
    const file = path.join(recordedDir, `${kind}.json`);
    const document = { tool: id, kind, version, calls: recorded };
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    const text = `${JSON.stringify(document, null, 1)}\n`;
    fs.writeFileSync(file, text);
    say(`${kind}: ${recorded.length} call(s), exit ${recorded.map((c) => c.exit).join(",")}; ${before === null ? "wrote" : before === text ? "unchanged" : "rewrote"} ${path.relative(repositoryRoot, file).split(path.sep).join("/")}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------------------------

async function main(argv) {
  const tool = argv.find((a) => !a.startsWith("--"));
  const write = argv.includes("--write");
  const installOnly = argv.includes("--install-only");
  if (!tool) {
    console.error("usage: npm --prefix jgates run image:probe -- <tool> [--write | --install-only]\n  <tool>: a linter descriptor id (src/builtin/linters/<tool>), a tool of an existing adapter with recordings in tests/fixtures/lint-stacks/recorded, or (--install-only) any install entry or program of docker/tools/");
    return 2;
  }
  const { entries, problems } = readInstalls();
  if (problems.length > 0) fail(`the install entries have problems:\n  ${problems.join("\n  ")}`);
  const descriptorFile = path.join(LINTERS_SRC, tool, "linter.json");
  const descriptor = fs.existsSync(descriptorFile) ? JSON.parse(fs.readFileSync(descriptorFile, "utf8")) : null;
  const legacy = descriptor ? [] : legacyRecordings(tool);
  if (!descriptor && legacy.length === 0 && !installOnly) fail(`${tool} is neither a linter descriptor (src/builtin/linters/${tool}/linter.json) nor a tool with recordings in tests/fixtures/lint-stacks/recorded/`);
  const toolName = descriptor ? descriptor.program.tool : tool;
  const entry = descriptor ? entries.find((e) => e.name === descriptor.install) : findInstall(entries, tool);
  if (!entry) fail(`no install entry ${descriptor ? `named ${descriptor.install}` : `provides ${tool}`} under jgates/docker/tools/ (PLAN-image.md section 3)`);
  let linter = null;
  if (descriptor && !installOnly) {
    refreshDescriptors();
    const { engine } = await engineModules();
    try {
      linter = engine.loadLinters({ ...process.env, JGATES_LINTERS_EXTRA_DIR: "" }).find((l) => l.descriptor.id === tool);
    } catch (error) {
      fail(`the engine refuses the descriptors: ${error.message}`);
    }
    if (!linter) fail(`the engine does not load ${tool}: check its descriptor (node --test jgates/tests/linter-engine.test.js names the problem)`);
  }
  if (run(runtime, ["image", "inspect", BASE], { allowFailure: true }).code !== 0) fail(`${BASE} is not in the engine: build it first (npm --prefix jgates run image:build)`);

  const release = acquireLock(tool);
  fs.mkdirSync(SCRATCH, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(SCRATCH, `${tool}-`));
  let image = null;
  const cleanup = () => {
    if (image) run(runtime, ["image", "rm", "--force", image], { allowFailure: true });
    image = null;
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    release();
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const baseJson = JSON.parse(run(runtime, ["run", "--rm", "--pull", "never", "--network", "none", ...LABELS.flatMap((l) => ["--label", l]), BASE, "cat", "/etc/jgates/image.json"]).out);
    image = buildImage(entry, baseJson.toolsPython ?? "3.14.10", scratch);
    const about = describe(image, entry, toolName);
    say(`${toolName} ${about.version ?? "(no version read)"}${about.version ? "" : `: ${about.versionText}`}`);
    say(`license files: ${about.licenseFiles.length > 0 ? about.licenseFiles.join(", ") : "none found in the install folder"}${about.licenseHead ? `\n    ${about.licenseHead.split("\n").join("\n    ")}` : ""}`);
    say(`installed size: ${about.sizeBytes === null ? "?" : `${(about.sizeBytes / 1024 ** 2).toFixed(1)} MB`} (${entry.kind === "apt" ? entry.meta.packages.join(", ") : entry.dir})`);
    if (installOnly) return about.version ? 0 : 1;
    if (descriptor) {
      await probeDescriptor(image, descriptor, linter, about.version, scratch);
      return 0;
    }
    return probeLegacy(image, tool, legacy, scratch, write) ? 0 : 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof ProbeFailure)) throw error;
    console.error(`image:probe: ${error.message}`);
    process.exitCode = 1;
  }
}
