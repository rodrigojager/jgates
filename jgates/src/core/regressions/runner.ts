// The Semantic test-file runner: one test file of a prepared tree (a fixture built by host code, fixture.ts) runs in an
// ephemeral container of the tools image, the way a Quality step runs (core/runner): the image pinned by its id, no
// network, a read-only root and a read-only tree, the step user (never root), every limit set, the time limit per
// file, the JGates labels, and removal when it ends, is cancelled or times out. The project folder is never mounted
// (ADR-0006) and nothing a project or a model wrote runs as a host process (ADR-0004). When JGates itself runs inside
// the tools image (in-image mode) the file runs natively there, like Quality steps do. Post-patch validation and
// `jgates regressions validate|incorporate` use it; what a test prints is masked before it is kept or shown.
//
// Each test runner is one entry of TEST_RECIPES (its command, its environment, how its output becomes a verdict, where
// its dependency volume mounts in the tree): adding a runner adds an entry, never a change to the runner itself.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { emptyCounts, maskText, strictMaskRules } from "../../adapters/semantic-gate/mask.js";
import { readVersion } from "../../cli/version.js";
import { readDepsState } from "../deps/state.js";
import { IMAGE_USER, detectEngine, engineLabels, engineRuntime, inspectImage, runInEngine, sourceVolumeName, type EngineContext, type EngineMount } from "../engine/index.js";
import { CONTAINER_WORKSPACE, stepUser } from "../runner/container.js";
import { assertNativeAllowed, stepMode } from "../runner/in-image.js";
import { runSpec, type ExecutionResult } from "../runner/process.js";
import { toolsImageTarget } from "../tools-image/index.js";
import { safeRelative, type Fixture } from "./fixture.js";

/** Longest run of one test file (ms). */
export const TEST_TIMEOUT_MS = 60_000;
/** The limits of a test container. */
export const TEST_LIMITS = { memoryMb: 1024, cpus: 1, pids: 256, tmpfsMb: 64 } as const;
/** The label that marks a test container (its value is the recipe id). */
export const LABEL_TEST_RUNNER = "org.jgates.test-runner";
/** The reason code of a test that needed a package while the workspace's dependencies were not prepared. */
export const DEPENDENCIES_NOT_PREPARED = "DEPENDENCIES_NOT_PREPARED";
const MAX_OUTPUT = 4_000;

/** passed: every test passed. failed: at least one test failed. error: the file did not run to a verdict (load error, no test, a missing package). not-run: nothing was observed (not started, cancelled, or stopped by the time limit). */
export type TestOutcome = "passed" | "failed" | "error" | "not-run";

export interface TestCounts {
  total: number;
  pass: number;
  fail: number;
  cancelled: number;
}

export interface TestDependencyMount {
  volume: string;
  /** Where it is mounted in the container (read-only). */
  target: string;
}

/** Where a test ran: the facts of its container (or of the native run inside the tools image). */
export type TestPlacement =
  | {
      mode: "container";
      /** The tools image id (sha256 digest). */
      image: string;
      name: string;
      network: "none";
      readOnlyTree: true;
      readOnlyRoot: true;
      user: string;
      limits: { memoryMb: number; cpus: number; pids: number; tmpfsMb: number; timeoutSeconds: number };
      dependencies: TestDependencyMount[];
    }
  | { mode: "in-image"; timeoutSeconds: number };

export interface TestRun {
  /** Whether a process was started and ran the file (only then can the outcome be observed). */
  executed: boolean;
  outcome: TestOutcome;
  /** The reason code of a run that was not run (TEST_RUNNER_NOT_SUPPORTED, WORKSPACE_COPY_UNAVAILABLE, TEST_TIMEOUT), else null. */
  code: string | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  tests: TestCounts | null;
  /** The test file, relative to the tree. */
  file: string;
  /** stdout then stderr, masked, with the tree's path replaced by <fixture>, truncated. */
  output: string;
  reason: string | null;
  /** The test needed a package and no dependency volume was mounted (the workspace's dependencies are not prepared). */
  dependenciesMissing: boolean;
  /** The facts of the container the test ran in (null: nothing ran). */
  container: TestPlacement | null;
}

export type TestRunnerId = "node:test" | "pytest";

/** The reason code of a file whose test runner has no recipe: nothing is started. */
export const TEST_RUNNER_NOT_SUPPORTED = "TEST_RUNNER_NOT_SUPPORTED";
/** The reason code of a workspace-copy run that cannot happen (no engine, no copy, a file already there). */
export const WORKSPACE_COPY_UNAVAILABLE = "WORKSPACE_COPY_UNAVAILABLE";
/** The reason code of a run stopped by its time limit. */
export const TEST_TIMEOUT = "TEST_TIMEOUT";

export interface TestVerdict {
  outcome: Exclude<TestOutcome, "not-run">;
  tests: TestCounts | null;
  reason: string | null;
}

export interface TestRecipe {
  id: TestRunnerId;
  /** The `runner` a regression proposal names for this recipe. */
  proposalRunner: string;
  /** The test files the recipe runs. */
  files: RegExp;
  /** The command, run with the tree as working directory. */
  command(file: string): string[];
  /** The only variables the test sees (on top of the container's HOME). */
  env: Readonly<Record<string, string>>;
  /** The counts a (possibly partial) standard output reports, or null when it never reached a summary. */
  counts(stdout: string): TestCounts | null;
  /** The package managers whose dependency volume the recipe mounts, and the folder of an install root it mounts on. */
  dependencies: { managers: readonly string[]; folder: string };
  /** The verdict of a run that ended (not timed out) from its standard output and exit code. */
  verdict(stdout: string, exitCode: number | null): TestVerdict;
  /** The package a run could not load (a bare specifier), or null. */
  missingPackage(output: string): string | null;
}

/** The TAP summary of node:test (`# tests N`, `# pass N`...), or null when the file never reached it. */
export function tapSummary(stdout: string): TestCounts | null {
  const num = (name: string): number | null => {
    const m = new RegExp(`^# ${name} (\\d+)\\s*$`, "m").exec(stdout);
    return m ? Number(m[1]) : null;
  };
  const total = num("tests");
  if (total === null) return null;
  return { total, pass: num("pass") ?? 0, fail: num("fail") ?? 0, cancelled: num("cancelled") ?? 0 };
}

const NODE_TEST: TestRecipe = {
  id: "node:test",
  proposalRunner: "node-test",
  files: /\.(mjs|cjs|js)$/,
  command: (file) => ["node", "--test-reporter=tap", file],
  env: { NODE_ENV: "test", NO_COLOR: "1" },
  counts: tapSummary,
  dependencies: { managers: ["npm", "pnpm", "yarn"], folder: "node_modules" },
  verdict(stdout, exitCode) {
    const tests = tapSummary(stdout);
    if (!tests) return { outcome: "error", tests, reason: "the file did not run to a test verdict (it failed to load, or it is not a node:test file)" };
    if (tests.total === 0) return { outcome: "error", tests, reason: "the file declares no test" };
    if (tests.fail > 0) return { outcome: "failed", tests, reason: null };
    if (exitCode === 0 && tests.cancelled === 0) return { outcome: "passed", tests, reason: null };
    return { outcome: "error", tests, reason: `no test failed but the run ended with exit ${String(exitCode)}${tests.cancelled > 0 ? ` and ${tests.cancelled} cancelled test(s)` : ""}` };
  },
  missingPackage(output) {
    const m = /Cannot find (?:package|module) '([^'\s]+)'/.exec(output);
    const name = m?.[1];
    if (!name || name.startsWith(".") || name.startsWith("/") || name.startsWith("node:") || /^[A-Za-z]:/.test(name)) return null;
    return name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : (name.split("/")[0] ?? name);
  },
};

/**
 * The summary line of a quiet pytest run (`1 failed, 2 passed in 0.12s`, `no tests ran in 0.01s`, `1 error in 0.10s`), or
 * null when the run never reached one. Tests that errored (a setup error, a file that did not load) are `cancelled`:
 * they gave no verdict.
 */
export function pytestSummary(stdout: string): TestCounts | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] as string).replace(/^=+\s*/, "").replace(/\s*=+$/, "").trim();
    if (!/^(?:no tests ran|\d+ [a-z]+(?:, \d+ [a-z]+)*) in \d+(?:\.\d+)?s\b/.test(line)) continue;
    const n = (name: RegExp): number => [...line.matchAll(new RegExp(`(\\d+) (?:${name.source})\\b`, "g"))].reduce((sum, m) => sum + Number(m[1]), 0);
    const pass = n(/passed/);
    const fail = n(/failed/);
    const cancelled = n(/errors?/);
    return { total: pass + fail + cancelled + n(/skipped|xfailed|xpassed/), pass, fail, cancelled };
  }
  return null;
}

/** The ids of the failing tests the short summary of a pytest run lists (`FAILED tests/test_x.py::test_name - message`). */
export function pytestFailures(stdout: string): string[] {
  return [...new Set([...stdout.matchAll(/^FAILED (\S+?)(?: - .*)?\s*$/gm)].map((m) => m[1] as string))];
}

const PYTEST_LAUNCH = [
  'for d in .venv/lib/python*/site-packages */.venv/lib/python*/site-packages; do if [ -d "$d" ]; then PYTHONPATH="$PYTHONPATH:$d"; fi; done',
  "export PYTHONPATH",
  'exec pytest -p no:cacheprovider -q --no-header -rfE --color=no --tb=short "$1"',
].join("; ");

const PYTEST: TestRecipe = {
  id: "pytest",
  proposalRunner: "pytest",
  // A pytest file by pytest's own naming: a module of the project (src/format.py) is never a test.
  files: /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/,
  // The image's pytest through a small launcher: the project's packages come from the site-packages of the `.venv` its dependency
  // volume provides (created by the image's Python, whatever its minor version; the project root or one folder below it), after
  // the project's src folder and root, as the Quality step has them. Nothing is written in the tree (no cache provider, no bytecode).
  command: (file) => ["sh", "-c", PYTEST_LAUNCH, "pytest", file],
  env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", NO_COLOR: "1", PYTHONPATH: "src:." },
  counts: pytestSummary,
  dependencies: { managers: ["uv", "pip"], folder: ".venv" },
  verdict(stdout, exitCode) {
    const tests = pytestSummary(stdout);
    if (!tests) return { outcome: "error", tests, reason: "the file did not run to a test verdict (it failed to load, or it is not a pytest file)" };
    if (tests.fail > 0) {
      const names = pytestFailures(stdout);
      return { outcome: "failed", tests, reason: names.length > 0 ? `failing: ${names.join(", ")}` : null };
    }
    if (tests.cancelled > 0) {
      const first = /^ERROR (\S+)/m.exec(stdout)?.[1];
      return { outcome: "error", tests, reason: `${tests.cancelled} error(s) before a verdict${first ? ` (${first})` : ""}: the file failed to load or a fixture failed` };
    }
    if (tests.total === 0) return { outcome: "error", tests, reason: "the file declares no test" };
    if (exitCode === 0 && tests.pass > 0) return { outcome: "passed", tests, reason: null };
    return { outcome: "error", tests, reason: tests.pass === 0 ? "no test passed (every test was skipped)" : `no test failed but the run ended with exit ${String(exitCode)}` };
  },
  missingPackage(output) {
    const name = /ModuleNotFoundError: No module named '([^'\s]+)'/.exec(output)?.[1];
    return name && !name.startsWith(".") ? (name.split(".")[0] ?? name) : null;
  },
};

/** The test runners the Semantic side executes, one entry each. */
export const TEST_RECIPES: Readonly<Record<TestRunnerId, TestRecipe>> = { "node:test": NODE_TEST, pytest: PYTEST };

/** The recipe of a test file (and of a proposal's runner, when given), or null when no runner runs it. */
export function recipeFor(file: string, proposalRunner?: string): TestRecipe | null {
  return Object.values(TEST_RECIPES).find((r) => (proposalRunner === undefined || r.proposalRunner === proposalRunner) && r.files.test(file)) ?? null;
}

/** Test runners the Quality side runs but the Semantic side has no recipe for: their files are answered as not supported. */
const UNSUPPORTED_RUNNERS: ReadonlyArray<{ name: string; aliases: readonly string[]; files: RegExp | null }> = [
  { name: "Jest", aliases: ["jest"], files: null },
  { name: "Vitest", aliases: ["vitest"], files: null },
  { name: "Jest or Vitest", aliases: [], files: /\.(?:test|spec)\.(?:[mc]?[jt]s|[jt]sx)$|(?:^|\/)__tests__\// },
  { name: "go test", aliases: ["go-test", "go test", "gotest", "go"], files: /_test\.go$/ },
  { name: "cargo test", aliases: ["cargo-test", "cargo test", "cargo"], files: /(?:^|\/)tests\/[^/]+\.rs$/ },
  { name: "dotnet test", aliases: ["dotnet-test", "dotnet test", "dotnet", "xunit", "nunit", "mstest"], files: /(?:Tests?|Spec)\.cs$/ },
];

/** The unsupported runner a file (or a proposal's runner name) belongs to, or null. */
export function unsupportedRunner(file: string, runner?: string): string | null {
  const wanted = runner?.trim().toLowerCase();
  for (const u of UNSUPPORTED_RUNNERS) if (wanted !== undefined && wanted !== "" && u.aliases.includes(wanted)) return u.name;
  if (wanted !== undefined && wanted !== "") return null;
  return UNSUPPORTED_RUNNERS.find((u) => u.files?.test(file))?.name ?? null;
}

// ---- where tests run ------------------------------------------------------------------------------------------------

export type TestRuntime =
  | { ok: true; mode: "container"; image: string; reference: string; engine: EngineContext }
  | { ok: true; mode: "in-image" }
  | { ok: false; code: string; reason: string };

/**
 * Whether tests can run on this machine: inside the tools image always; outside it, a container engine that answers
 * and the tools image in it. A missing one gives the reason code the Quality side gives (ENGINE_NOT_INSTALLED,
 * ENGINE_STOPPED, UNSUPPORTED_PLATFORM, IMAGE_MISSING). Asynchronous: it never blocks the process that asks.
 */
export async function testRuntime(env: NodeJS.ProcessEnv = process.env): Promise<TestRuntime> {
  if (stepMode(env) === "in-image") return { ok: true, mode: "in-image" };
  const engine: EngineContext = { runtime: engineRuntime(env), runnerOptions: { parentEnv: env } };
  const detection = await detectEngine({ requiredMemoryMb: 0, requiredDiskMb: 0 }, engine);
  if (detection.code) return { ok: false, code: detection.code, reason: `tests run in containers of the JGates tools image and the container engine is not usable (${detection.code}: ${detection.details.slice(0, 300)})` };
  const reference = toolsImageTarget(env).reference;
  const image = await inspectImage(reference, engine);
  if (!image) return { ok: false, code: "IMAGE_MISSING", reason: `tests run in containers of the JGates tools image and the image ${reference} is not in the engine (jgates setup gets it)` };
  return { ok: true, mode: "container", image: image.id, reference, engine };
}

export interface TestEnvironment {
  env: NodeJS.ProcessEnv;
  runtime: Extract<TestRuntime, { ok: true }>;
  /** The labels of every test container. */
  labels: { version: string; workspace: string; run: string };
  /** The workspace's prepared dependency volumes (jgates deps prepare), as the data folder records them. */
  dependencies: Array<{ volume: string; installRoot: string; manager: string }>;
}

/** The runtime, the labels and the prepared dependency volumes for the test runs of one workspace and run. */
export async function testEnvironment(input: { env: NodeJS.ProcessEnv; home: string; workspace: string; run: string; version?: string }): Promise<{ ok: true; environment: TestEnvironment } | { ok: false; code: string; reason: string }> {
  const runtime = await testRuntime(input.env);
  if (!runtime.ok) return runtime;
  const dependencies =
    runtime.mode === "container"
      ? Object.values(readDepsState(input.home, input.workspace).units)
          .filter((u) => typeof u.volume === "string" && typeof u.installRoot === "string")
          .map((u) => ({ volume: u.volume, installRoot: u.installRoot, manager: u.manager }))
      : [];
  return { ok: true, environment: { env: input.env, runtime, labels: { version: input.version ?? readVersion(), workspace: input.workspace, run: input.run }, dependencies } };
}

/** The dependency volumes a recipe mounts in a tree, with their mount points relative to the tree. */
export function dependencyMounts(environment: TestEnvironment, recipe: TestRecipe): Array<{ volume: string; mountPoint: string }> {
  const out: Array<{ volume: string; mountPoint: string }> = [];
  for (const d of environment.dependencies) {
    if (!recipe.dependencies.managers.includes(d.manager)) continue;
    const mountPoint = safeRelative(d.installRoot === "." || d.installRoot === "" ? recipe.dependencies.folder : `${d.installRoot}/${recipe.dependencies.folder}`);
    if (mountPoint && !out.some((o) => o.mountPoint === mountPoint)) out.push({ volume: d.volume, mountPoint });
  }
  return out;
}

/** The mount points to create in a fixture for a recipe (empty when the dependencies are not prepared). */
export const dependencyMountPoints = (environment: TestEnvironment, recipe: TestRecipe): string[] => dependencyMounts(environment, recipe).map((m) => m.mountPoint);

function maskOutput(text: string, roots: readonly string[]): string {
  const rules = strictMaskRules();
  // The tree's location (on the host, in the container, with either slash or escaped in TAP's YAML) says nothing about the test.
  let withoutPaths = text;
  for (const root of roots) {
    for (const form of [...new Set([root.split("\\").join("\\\\"), root, root.split("\\").join("/")])].sort((a, b) => b.length - a.length)) {
      if (form !== "") withoutPaths = withoutPaths.split(form).join("<fixture>");
    }
  }
  const masked = maskText(withoutPaths, emptyCounts(rules), rules);
  return masked.length > MAX_OUTPUT ? `${masked.slice(0, MAX_OUTPUT)}\n... (${masked.length - MAX_OUTPUT} more characters)` : masked;
}

/** A run that executed nothing (with the reason code, when the reason has one). */
export function notRunTest(file: string, reason: string, code: string | null = null): TestRun {
  return { executed: false, outcome: "not-run", code, exitCode: null, timedOut: false, durationMs: 0, tests: null, file, output: "", reason, dependenciesMissing: false, container: null };
}

/** The answer for a file no recipe runs: not supported, with its reason code, and nothing is started. */
export function notSupportedTest(file: string, runner?: string): TestRun {
  const known = unsupportedRunner(file, runner);
  const runners = Object.keys(TEST_RECIPES).join(" and ");
  const what = known ? `${known} is not supported` : `no test runner runs ${file}`;
  return notRunTest(file, `${TEST_RUNNER_NOT_SUPPORTED}: ${what} (the Semantic side runs ${runners} files only)`, TEST_RUNNER_NOT_SUPPORTED);
}

/** How a file is run: the tree the container sees, or the host folder a native run (inside the tools image) works in. */
interface RunTree {
  /** The mounts of a container run (the tree, then the dependency volumes, all read-only). */
  mounts: EngineMount[];
  mounted: TestDependencyMount[];
  /** Host folder of a native run inside the tools image; null: no native run (the workspace copy lives in a volume). */
  nativeCwd: string | null;
  /** Locations to hide from the output. */
  maskRoots: string[];
}

async function executeTest(environment: TestEnvironment, recipe: TestRecipe, rel: string, tree: RunTree, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<TestRun> {
  const timeoutMs = options.timeoutMs ?? TEST_TIMEOUT_MS;
  const command = recipe.command(rel);
  const { runtime } = environment;
  const env = { ...recipe.env };
  let result: ExecutionResult & { runtimeFailure?: boolean };
  let placement: TestPlacement;
  if (runtime.mode === "container") {
    const name = `jgates-test-${randomBytes(6).toString("hex")}`;
    const user = stepUser();
    placement = { mode: "container", image: runtime.image, name, network: "none", readOnlyTree: true, readOnlyRoot: true, user, limits: { ...TEST_LIMITS, timeoutSeconds: Math.round(timeoutMs / 1000) }, dependencies: tree.mounted };
    result = await runInEngine(
      {
        image: runtime.image,
        command,
        name,
        labels: engineLabels({ kind: "step", version: environment.labels.version, workspace: environment.labels.workspace, run: environment.labels.run, extra: { [LABEL_TEST_RUNNER]: recipe.id } }),
        mounts: tree.mounts,
        network: "none",
        user,
        env,
        workdir: CONTAINER_WORKSPACE,
        resources: { ...TEST_LIMITS },
        timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      runtime.engine,
    );
  } else {
    // Inside the tools image the test runs natively, like a Quality step there (refused anywhere else).
    assertNativeAllowed(environment.env, command[0]);
    placement = { mode: "in-image", timeoutSeconds: Math.round(timeoutMs / 1000) };
    result = await runSpec({ executable: command[0] as string, args: command.slice(1), cwd: tree.nativeCwd as string, env, timeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
  }
  const output = maskOutput(`${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`, [...tree.maskRoots, CONTAINER_WORKSPACE]);
  const base = { code: null, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, file: rel, output, dependenciesMissing: false, container: placement };
  if (result.cancelled) return { ...base, executed: false, outcome: "not-run", tests: null, reason: "the run was cancelled before the test finished" };
  if (result.spawnError) return { ...base, executed: false, outcome: "not-run", tests: null, reason: `the test could not start (${result.spawnError.code}: ${result.spawnError.message.slice(0, 200)})` };
  if (result.runtimeFailure) {
    return { ...base, executed: false, outcome: "not-run", tests: null, reason: `the engine could not run the test container (exit ${String(result.exitCode)}): ${result.stderr.trim().split("\n").pop()?.slice(0, 200) ?? "-"}` };
  }
  // A time limit is not a verdict: the file did not finish, so nothing was observed (not run, never passed or failed).
  if (result.timedOut) return { ...base, code: TEST_TIMEOUT, executed: false, outcome: "not-run", tests: recipe.counts(result.stdout), reason: `the test did not finish within ${Math.round(timeoutMs / 1000)} s (the time limit)` };
  const verdict = recipe.verdict(result.stdout, result.exitCode);
  if (verdict.outcome !== "passed" && tree.mounted.length === 0) {
    const missing = recipe.missingPackage(`${result.stdout}\n${result.stderr}`);
    if (missing) {
      return { ...base, executed: true, outcome: "error", tests: verdict.tests, dependenciesMissing: true, reason: `${DEPENDENCIES_NOT_PREPARED}: the test needs the package ${missing} and the workspace's dependencies are not prepared (jgates deps prepare)` };
    }
  }
  return { ...base, executed: true, outcome: verdict.outcome, tests: verdict.tests, reason: verdict.reason };
}

/**
 * Runs one test file of a fixture with its recipe: in a container of the tools image (or natively inside the image).
 * The fixture is mounted read-only at /workspace, the prepared dependency volumes read-only on its mount points.
 * `runner` is the runner a proposal names (a runner without a recipe is answered as not supported).
 */
export async function runTestFile(environment: TestEnvironment, fixture: Fixture, file: string, options: { recipe?: TestRecipe; runner?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TestRun> {
  const recipe = options.recipe ?? recipeFor(file, options.runner);
  const rel = safeRelative(file);
  if (!recipe || !rel) return notSupportedTest(file, options.runner);
  if (options.signal?.aborted) return notRunTest(file, "the run was cancelled before the test started");
  const deps = environment.runtime.mode === "container" ? dependencyMounts(environment, recipe).filter((d) => fixture.mountPoints.includes(d.mountPoint)) : [];
  const mounted = deps.map((d) => ({ volume: d.volume, target: `${CONTAINER_WORKSPACE}/${d.mountPoint}` }));
  const mounts: EngineMount[] = [{ type: "bind", source: fixture.dir, target: CONTAINER_WORKSPACE, readonly: true }, ...mounted.map((m) => ({ type: "volume" as const, source: m.volume, target: m.target, readonly: true }))];
  return executeTest(environment, recipe, rel, { mounts, mounted, nativeCwd: fixture.dir, maskRoots: [fixture.dir] }, options);
}

// ---- a file placed in the workspace copy ----------------------------------------------------------------------------

/** The label of the helper container that places or removes the file in the workspace copy (its value: place or remove). */
export const LABEL_WORKSPACE_COPY = "org.jgates.workspace-copy";
const STAGE_MOUNT = "/stage";
const COPY_MOUNT = "/dst";
const STAGED_NAME = "test-file";

/**
 * Places the staged file in the copy: refuses a path that already exists (a file of the project is never replaced) and
 * prints the first folder it had to create (empty when none), so the removal takes exactly that away.
 */
const PLACE_SCRIPT = `set -e
cd ${COPY_MOUNT}
if [ -e "$JG_FILE" ] || [ -L "$JG_FILE" ]; then echo "the path already exists in the workspace copy" >&2; exit 3; fi
first=""
d=$(dirname "$JG_FILE")
while [ "$d" != "." ] && [ ! -e "$d" ]; do first="$d"; d=$(dirname "$d"); done
mkdir -p "$(dirname "$JG_FILE")"
cp ${STAGE_MOUNT}/${STAGED_NAME} "$JG_FILE"
printf '%s' "$first"
`;

/** Removes the placed file and the folders the placement created, and nothing else. */
const REMOVE_SCRIPT = `set -e
cd ${COPY_MOUNT}
rm -f -- "$JG_FILE"
if [ -n "$JG_CREATED" ]; then rm -rf -- "$JG_CREATED"; fi
`;

export interface WorkspaceCopyInput {
  /** Workspace id (ws_<16 hex>): selects the workspace copy `jgates-<ws>-src` the Quality steps use. */
  workspace: string;
  /** Where the file goes in the copy (relative, forward slashes). */
  file: string;
  content: string | Buffer;
  /** The folder the staged file waits in while the helper copies it (the data folder's, never the project's). */
  stageDir: string;
}

export interface WorkspaceCopyRun extends TestRun {
  /** The file was put in the workspace copy. */
  placed: boolean;
  /** The workspace copy has nothing of the placement left (true when nothing was placed). */
  removed: boolean;
}

/**
 * Runs one test file that is not in the project: it is placed in the workspace copy (the synchronized volume of the
 * Quality steps), runs there in a container without network with the copy and the workspace's prepared dependency
 * volumes read-only, and is removed afterwards, whatever the outcome. The project folder is never mounted or changed
 * (ADR-0006); the helper that places and removes the file works in the copy only, without network.
 */
export async function runTestFileInWorkspaceCopy(environment: TestEnvironment, input: WorkspaceCopyInput, options: { recipe?: TestRecipe; runner?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WorkspaceCopyRun> {
  const outcome = (run: TestRun, placed: boolean, removed: boolean): WorkspaceCopyRun => ({ ...run, placed, removed });
  const recipe = options.recipe ?? recipeFor(input.file, options.runner);
  const rel = safeRelative(input.file);
  if (!recipe || !rel) return outcome(notSupportedTest(input.file, options.runner), false, true);
  if (options.signal?.aborted) return outcome(notRunTest(input.file, "the run was cancelled before the test started"), false, true);
  const { runtime } = environment;
  if (runtime.mode !== "container") return outcome(notRunTest(rel, `${WORKSPACE_COPY_UNAVAILABLE}: inside the tools image the project is not copied to a volume; the file runs from a fixture there`, WORKSPACE_COPY_UNAVAILABLE), false, true);

  const volume = sourceVolumeName(input.workspace);
  const labels = (step: "place" | "remove"): Record<string, string> => engineLabels({ kind: "helper", version: environment.labels.version, workspace: environment.labels.workspace, run: environment.labels.run, extra: { [LABEL_WORKSPACE_COPY]: step } });
  const helper = (step: "place" | "remove", mounts: EngineMount[], env: Record<string, string>) =>
    runInEngine({ image: runtime.image, command: ["sh", "-c", step === "place" ? PLACE_SCRIPT : REMOVE_SCRIPT], labels: labels(step), mounts, network: "none", user: IMAGE_USER, env, resources: { memoryMb: 256, cpus: 1, pids: 64 }, timeoutMs: 60_000 }, runtime.engine);
  const stage = fs.mkdtempSync(path.join(ensureDir(input.stageDir), "place-"));
  let created = "";
  let placed = false;
  let removalFailure: string | null = null;
  try {
    fs.writeFileSync(path.join(stage, STAGED_NAME), input.content, { mode: 0o600 });
    const place = await helper("place", [{ type: "bind", source: stage, target: STAGE_MOUNT, readonly: true }, { type: "volume", source: volume, target: COPY_MOUNT }], { JG_FILE: rel });
    if (place.exitCode !== 0 || place.spawnError) {
      const why = place.exitCode === 3 ? "the path already exists in the workspace copy" : place.stderr.trim().split("\n").pop()?.slice(0, 200) || place.spawnError?.message.slice(0, 200) || `exit ${String(place.exitCode)}`;
      return outcome(notRunTest(rel, `${WORKSPACE_COPY_UNAVAILABLE}: the file could not be placed in the workspace copy (${why})`, WORKSPACE_COPY_UNAVAILABLE), false, true);
    }
    placed = true;
    created = place.stdout.trim();
    const deps = dependencyMounts(environment, recipe);
    const mounted = deps.map((d) => ({ volume: d.volume, target: `${CONTAINER_WORKSPACE}/${d.mountPoint}` }));
    const mounts: EngineMount[] = [{ type: "volume", source: volume, target: CONTAINER_WORKSPACE, readonly: true }, ...mounted.map((m) => ({ type: "volume" as const, source: m.volume, target: m.target, readonly: true }))];
    const run = await executeTest(environment, recipe, rel, { mounts, mounted, nativeCwd: null, maskRoots: [] }, options);
    // The removal is not cancellable: a cancelled run still leaves nothing behind.
    const removal = await helper("remove", [{ type: "volume", source: volume, target: COPY_MOUNT }], { JG_FILE: rel, JG_CREATED: created });
    if (removal.exitCode !== 0 || removal.spawnError) removalFailure = removal.stderr.trim().split("\n").pop()?.slice(0, 200) || `exit ${String(removal.exitCode)}`;
    else placed = false;
    return removalFailure === null ? outcome(run, true, true) : outcome({ ...run, reason: `${run.reason ?? ""}${run.reason ? "; " : ""}the placed file could not be removed from the workspace copy (${removalFailure})` }, true, false);
  } catch (error) {
    if (placed) {
      // An unexpected failure between placing and removing: remove anyway, then report it.
      await helper("remove", [{ type: "volume", source: volume, target: COPY_MOUNT }], { JG_FILE: rel, JG_CREATED: created }).catch(() => undefined);
    }
    throw error;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
