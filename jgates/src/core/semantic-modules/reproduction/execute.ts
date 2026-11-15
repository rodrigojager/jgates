// The execution of a reproducer (confirm-by-reproduction): host code, never a model. With a container engine the
// project is synchronized into its workspace copy once per run, the reproducer is placed in the copy and run there by
// the Semantic test-file runner in an ephemeral container of the tools image (--network none, the copy and the prepared
// dependency volumes read-only, the step user, the limits, the time limit per file), and removed afterwards whatever
// the outcome. Inside the tools image (no copy exists) it runs from a fixture of the files the run may read. Every
// execution is recorded in evidence/confirm-by-reproduction/execution.json, like execution.json of post-patch: the
// facts of its container (image digest, network none, read-only tree and root, user, limits, dependency volumes) and
// the masked output. The project folder is never mounted or changed (ADR-0004, ADR-0006).
import fs from "node:fs";
import path from "node:path";
import { readVersion } from "../../../cli/version.js";
import { loadWorkspaceSettings } from "../../discovery/index.js";
import { resolveHome } from "../../home/index.js";
import { workspaceId } from "../../ids/index.js";
import { removeFixture, writeFixture, type FixtureFile } from "../../regressions/fixture.js";
import { TEST_RECIPES, WORKSPACE_COPY_UNAVAILABLE, dependencyMountPoints, notRunTest, runTestFile, runTestFileInWorkspaceCopy, testEnvironment, type TestEnvironment, type TestRun } from "../../regressions/runner.js";
import { syncProject } from "../../sync/index.js";
import type { ArtifactCheckContext } from "../../semantic-executor/index.js";
import type { CheckedReproducer } from "./reproducer.js";
import type { ReproductionSeed } from "./seeds.js";

export const EXECUTION_FILE = "evidence/confirm-by-reproduction/execution.json";

/** One execution of a reproducer, as the record keeps it. */
export interface ReproductionExecution {
  /** The candidate of this run (C1...) and the finding of the earlier run it reproduces. */
  candidate: string;
  finding: { id: string; runId: string; candidateId: string; path: string; line: number | null };
  executedAt: string;
  /** Whether the test file ran (only then is its outcome observed). */
  executed: boolean;
  reason: string | null;
  code: string | null;
  reproducer: { path: string; runner: string; sha256: string };
  /** Where it ran: placed in the workspace copy (container engine) or in a fixture (inside the tools image); null: nowhere. */
  tree: "workspace-copy" | "fixture" | null;
  /** The workspace copy: synchronized before the run, the file placed, and nothing of it left afterwards. */
  workspaceCopy: { synchronized: boolean; placed: boolean; removed: boolean } | null;
  /** The run with the facts of its container (null container: nothing ran) and its masked output. */
  run: TestRun;
}

export interface ExecutionInputs {
  workspacePath: string;
  env: NodeJS.ProcessEnv;
  seedRun: { runId: string; method: string | null };
}

/** Executions already made for a run, by candidate and reproducer hash (a repeated settle never runs anything twice). */
const done = new Map<string, ReproductionExecution>();
/** The executions of each run, in order (written to execution.json after each one). */
const byRun = new Map<string, ReproductionExecution[]>();
/** The synchronization of the workspace copy, once per run. */
const synced = new Map<string, Promise<{ ok: true } | { ok: false; reason: string }>>();

/** The executions recorded for a run so far. */
export function executionsOf(runDir: string): readonly ReproductionExecution[] {
  return byRun.get(runDir) ?? [];
}

/** The execution of a candidate of a run, or null. */
export function executionFor(runDir: string, candidate: string): ReproductionExecution | null {
  return [...executionsOf(runDir)].reverse().find((e) => e.candidate === candidate) ?? null;
}

/** Forgets what a run executed (after its report). */
export function forgetRun(runDir: string): void {
  byRun.delete(runDir);
  synced.delete(runDir);
  for (const key of [...done.keys()]) if (key.startsWith(`${runDir}\u0000`)) done.delete(key);
}

function syncOnce(runDir: string, environment: TestEnvironment, workspacePath: string, workspace: string, home: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const hit = synced.get(runDir);
  if (hit) return hit;
  const runtime = environment.runtime;
  const started =
    runtime.mode !== "container"
      ? Promise.resolve({ ok: false as const, reason: "inside the tools image there is no workspace copy" })
      : syncProject({ projectDir: workspacePath, workspace, image: runtime.image, version: environment.labels.version, run: environment.labels.run, home, context: runtime.engine, excludePatterns: loadWorkspaceSettings(workspacePath).settings.exclude })
          .then(() => ({ ok: true as const }))
          .catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message.slice(0, 300) : String(error) }));
  synced.set(runDir, started);
  return started;
}

function writeRecord(runDir: string, inputs: ExecutionInputs): void {
  try {
    const file = path.join(runDir, ...EXECUTION_FILE.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, kind: "semantic-reproduction-execution", seedRun: inputs.seedRun, executions: executionsOf(runDir) }, null, 2)}\n`);
  } catch {
    // The accepted artifact still carries the execution (reproduction.json repeats it).
  }
}

/** Runs one reproducer for one finding and records it. */
export async function executeReproducer(ctx: ArtifactCheckContext, inputs: ExecutionInputs, seed: ReproductionSeed, candidate: string, reproducer: CheckedReproducer, signal: AbortSignal): Promise<ReproductionExecution> {
  const run = ctx.run!;
  const key = `${run.runDir}\u0000${candidate}\u0000${reproducer.sha256}`;
  const cached = done.get(key);
  if (cached) return cached;
  const recipe = TEST_RECIPES[reproducer.runner];
  const entry: ReproductionExecution = {
    candidate,
    finding: { id: seed.id, runId: seed.source.runId, candidateId: seed.source.candidateId, path: seed.path, line: seed.line },
    executedAt: new Date().toISOString(),
    executed: false,
    reason: null,
    code: null,
    reproducer: { path: reproducer.path, runner: reproducer.runner, sha256: reproducer.sha256 },
    tree: null,
    workspaceCopy: null,
    run: notRunTest(reproducer.path, "not started"),
  };
  const fixtureDir = path.join(run.runDir, "work", "reproduction", candidate.toLowerCase());
  try {
    const home = resolveHome({ env: inputs.env });
    const workspace = workspaceId(inputs.workspacePath);
    const prepared = await testEnvironment({ env: inputs.env, home, workspace, run: path.basename(run.runDir), version: readVersion() });
    if (!prepared.ok) {
      entry.run = notRunTest(reproducer.path, `${prepared.code}: ${prepared.reason}`, prepared.code);
    } else if (prepared.environment.runtime.mode === "container") {
      const { environment } = prepared;
      const sync = await syncOnce(run.runDir, environment, inputs.workspacePath, workspace, home);
      if (!sync.ok) {
        entry.workspaceCopy = { synchronized: false, placed: false, removed: true };
        entry.run = notRunTest(reproducer.path, `${WORKSPACE_COPY_UNAVAILABLE}: the project could not be synchronized into its workspace copy (${sync.reason})`, WORKSPACE_COPY_UNAVAILABLE);
      } else {
        entry.tree = "workspace-copy";
        const r = await runTestFileInWorkspaceCopy(environment, { workspace, file: reproducer.path, content: reproducer.content, stageDir: path.join(run.runDir, "work", "reproduction") }, { recipe, signal });
        const { placed, removed, ...rest } = r;
        entry.workspaceCopy = { synchronized: true, placed, removed };
        entry.run = rest;
      }
    } else {
      // Inside the tools image: a fixture of the files the run may read, with the reproducer at its place.
      const { environment } = prepared;
      const files: FixtureFile[] = [];
      for (const p of run.scope.guard.readable().filter((f) => ctx.readable(f) && f !== reproducer.path)) {
        const text = run.readFile(p);
        if (text !== null) files.push({ path: p, content: text });
      }
      files.push({ path: reproducer.path, content: reproducer.content });
      const fixture = writeFixture(fixtureDir, files, { mountPoints: dependencyMountPoints(environment, recipe) });
      entry.tree = "fixture";
      entry.run = await runTestFile(environment, fixture, reproducer.path, { recipe, signal });
    }
  } catch (error) {
    entry.run = notRunTest(reproducer.path, `the reproducer could not be executed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
  } finally {
    removeFixture(fixtureDir);
  }
  entry.executed = entry.run.executed;
  entry.reason = entry.run.reason;
  entry.code = entry.run.code;
  done.set(key, entry);
  byRun.set(run.runDir, [...executionsOf(run.runDir), entry]);
  writeRecord(run.runDir, inputs);
  return entry;
}
