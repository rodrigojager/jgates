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
import { emptyCounts, maskText, strictMaskRules } from "../../adapters/semantic-gate/mask.js";
import { readVersion } from "../../cli/version.js";
import { readDepsState } from "../deps/state.js";
import { detectEngine, engineLabels, engineRuntime, inspectImage, runInEngine, type EngineContext, type EngineMount } from "../engine/index.js";
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

/** passed: every test passed. failed: at least one test failed. error: the file did not run to a verdict (load error, no test, timeout, a missing package). not-run: nothing was executed. */
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

export type TestRunnerId = "node:test";

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

/** The test runners the Semantic side executes, one entry each. */
export const TEST_RECIPES: Readonly<Record<TestRunnerId, TestRecipe>> = { "node:test": NODE_TEST };

/** The recipe of a test file (and of a proposal's runner, when given), or null when no runner runs it. */
export function recipeFor(file: string, proposalRunner?: string): TestRecipe | null {
  return Object.values(TEST_RECIPES).find((r) => (proposalRunner === undefined || r.proposalRunner === proposalRunner) && r.files.test(file)) ?? null;
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

/** A run that executed nothing. */
export function notRunTest(file: string, reason: string): TestRun {
  return { executed: false, outcome: "not-run", exitCode: null, timedOut: false, durationMs: 0, tests: null, file, output: "", reason, dependenciesMissing: false, container: null };
}

/**
 * Runs one test file of a fixture with its recipe: in a container of the tools image (or natively inside the image).
 * The fixture is mounted read-only at /workspace, the prepared dependency volumes read-only on its mount points.
 */
export async function runTestFile(environment: TestEnvironment, fixture: Fixture, file: string, options: { recipe?: TestRecipe; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TestRun> {
  const recipe = options.recipe ?? recipeFor(file);
  const rel = safeRelative(file);
  if (!recipe || !rel) return notRunTest(file, `no test runner runs ${file} (the runners are ${Object.keys(TEST_RECIPES).join(", ")})`);
  if (options.signal?.aborted) return notRunTest(file, "the run was cancelled before the test started");
  const timeoutMs = options.timeoutMs ?? TEST_TIMEOUT_MS;
  const command = recipe.command(rel);
  const { runtime } = environment;
  let result: ExecutionResult & { runtimeFailure?: boolean };
  let placement: TestPlacement;
  let mounted: TestDependencyMount[] = [];
  if (runtime.mode === "container") {
    const deps = dependencyMounts(environment, recipe).filter((d) => fixture.mountPoints.includes(d.mountPoint));
    mounted = deps.map((d) => ({ volume: d.volume, target: `${CONTAINER_WORKSPACE}/${d.mountPoint}` }));
    const mounts: EngineMount[] = [{ type: "bind", source: fixture.dir, target: CONTAINER_WORKSPACE, readonly: true }, ...mounted.map((m) => ({ type: "volume" as const, source: m.volume, target: m.target, readonly: true }))];
    const name = `jgates-test-${randomBytes(6).toString("hex")}`;
    const user = stepUser();
    placement = { mode: "container", image: runtime.image, name, network: "none", readOnlyTree: true, readOnlyRoot: true, user, limits: { ...TEST_LIMITS, timeoutSeconds: Math.round(timeoutMs / 1000) }, dependencies: mounted };
    result = await runInEngine(
      {
        image: runtime.image,
        command,
        name,
        labels: engineLabels({ kind: "step", version: environment.labels.version, workspace: environment.labels.workspace, run: environment.labels.run, extra: { [LABEL_TEST_RUNNER]: recipe.id } }),
        mounts,
        network: "none",
        user,
        env: { ...recipe.env },
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
    result = await runSpec({ executable: command[0] as string, args: command.slice(1), cwd: fixture.dir, env: { ...recipe.env }, timeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
  }
  const output = maskOutput(`${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`, [fixture.dir, CONTAINER_WORKSPACE]);
  const base = { exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, file: rel, output, dependenciesMissing: false, container: placement };
  if (result.cancelled) return { ...base, executed: false, outcome: "not-run", tests: null, reason: "the run was cancelled before the test finished" };
  if (result.spawnError) return { ...base, executed: false, outcome: "not-run", tests: null, reason: `the test could not start (${result.spawnError.code}: ${result.spawnError.message.slice(0, 200)})` };
  if (result.runtimeFailure) {
    return { ...base, executed: false, outcome: "not-run", tests: null, reason: `the engine could not run the test container (exit ${String(result.exitCode)}): ${result.stderr.trim().split("\n").pop()?.slice(0, 200) ?? "-"}` };
  }
  if (result.timedOut) return { ...base, executed: true, outcome: "error", tests: tapSummary(result.stdout), reason: `the test did not finish within ${Math.round(timeoutMs / 1000)} s` };
  const verdict = recipe.verdict(result.stdout, result.exitCode);
  if (verdict.outcome !== "passed" && mounted.length === 0) {
    const missing = recipe.missingPackage(`${result.stdout}\n${result.stderr}`);
    if (missing) {
      return { ...base, executed: true, outcome: "error", tests: verdict.tests, dependenciesMissing: true, reason: `${DEPENDENCIES_NOT_PREPARED}: the test needs the package ${missing} and the workspace's dependencies are not prepared (jgates deps prepare)` };
    }
  }
  return { ...base, executed: true, outcome: verdict.outcome, tests: verdict.tests, reason: verdict.reason };
}
