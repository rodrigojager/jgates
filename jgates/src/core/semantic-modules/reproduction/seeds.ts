// The findings confirm-by-reproduction starts from: the needs-validation candidates of one earlier Semantic run of the
// workspace (named by the caller, or the newest one that has any), each with the test runner its file needs and, on a
// machine with a container engine, the prepared dependencies of its component. Host-only reads; nothing is sent.
import fs from "node:fs";
import path from "node:path";
import { normalizeScopePath } from "../../semantic-scope/index.js";
import { discoverWorkspace } from "../../discovery/index.js";
import { readDepsState } from "../../deps/state.js";
import { DEPENDENCIES_NOT_PREPARED, TEST_RECIPES, TEST_RUNNER_NOT_SUPPORTED, type TestRunnerId } from "../../regressions/runner.js";
import type { ModuleApplicabilityInput } from "../../semantic-executor/index.js";
import { isObj, list, priorSemanticRuns, str, strings } from "../complementary/shared.js";

/** The methods whose findings are never re-examined: they do not read source code, or they are this method itself. */
export const INELIGIBLE_SEED_METHODS: ReadonlySet<string> = new Set(["supply-chain-assessment", "post-patch-validation", "confirm-by-reproduction"]);
/** At most this many findings are reproduced in one run (the others are listed as skipped). */
export const MAX_FINDINGS = 10;

/** A needs-validation finding of an earlier run, with what the reproducer needs. */
export interface ReproductionSeed {
  /** F1, F2... within the run. */
  id: string;
  /** Where it comes from: the earlier run, its candidate and the method that reported it. */
  source: { runId: string; candidateId: string; method: string | null };
  title: string;
  path: string;
  line: number | null;
  severity: string;
  category: string;
  rationale: string;
  fingerprint: string | null;
  claimedRootCause: string | null;
  impact: string | null;
  blockers: string[];
  /** The record's validation plan (security-audit records): the local step is what a reproducer can do. */
  validationPlan: { local?: string; deployment?: string } | null;
  /** The earlier verdict's reason (why it stayed needs-validation). */
  validation: { reason: string } | null;
  runner: TestRunnerId;
}

/** A finding that is not reproduced, with the reason code. */
export interface SkippedFinding {
  runId: string;
  candidateId: string;
  title: string;
  path: string;
  code: string;
  reason: string;
}

export interface SeedSelection {
  /** The run to start from (sem_...); absent: the newest earlier run with a needs-validation finding. */
  from?: string;
  /** Only these candidates of that run (C1, C2...); absent: every needs-validation finding. */
  findings?: readonly string[];
}

/** The test runner of a source file, or why none runs it (the first slice runs pytest and node:test only). */
export function runnerForSource(file: string): { runner: TestRunnerId } | { code: string; reason: string } {
  if (/\.py$/.test(file)) return { runner: "pytest" };
  if (/\.(?:js|mjs|cjs)$/.test(file)) return { runner: "node:test" };
  const known = /\.go$/.test(file) ? "go test" : /\.rs$/.test(file) ? "cargo test" : /\.cs$/.test(file) ? "dotnet test" : /\.(?:ts|mts|cts|tsx|jsx)$/.test(file) ? "Jest or Vitest (TypeScript and JSX sources need a build step)" : null;
  const supported = Object.keys(TEST_RECIPES).join(" and ");
  return { code: TEST_RUNNER_NOT_SUPPORTED, reason: `${TEST_RUNNER_NOT_SUPPORTED}: ${known ? `${known} is not supported` : `no test runner runs ${file}`} (a reproducer runs under ${supported} only)` };
}

interface StoredRun {
  runId: string;
  method: string | null;
  candidates: Array<Record<string, unknown>>;
}

const SEM_ID = /^sem_[A-Za-z0-9_-]{1,80}$/;

function storedRun(runId: string, result: Record<string, unknown>): StoredRun {
  const outcome = (result.semanticRun as { outcome?: { investigation?: { module?: { id?: unknown }; candidates?: unknown } } } | undefined)?.outcome;
  const inv = outcome?.investigation;
  return { runId, method: str(inv?.module?.id, 80) || null, candidates: list(inv?.candidates).filter(isObj) };
}

const needsValidation = (run: StoredRun): Array<Record<string, unknown>> => (run.method !== null && INELIGIBLE_SEED_METHODS.has(run.method) ? [] : run.candidates.filter((c) => c.status === "needs-validation"));

/** The earlier run to start from, or why there is none. */
export function seedRunFor(runDir: string, selection: SeedSelection): { run: StoredRun } | { code: string; missing: string; reason: string } {
  if (selection.from !== undefined) {
    const from = selection.from.trim();
    if (!SEM_ID.test(from) || from === path.basename(runDir)) return { code: "REPRODUCTION_SEED_RUN_NOT_FOUND", missing: "earlier Semantic run", reason: `${JSON.stringify(from.slice(0, 90))} is not an earlier Semantic run of this workspace` };
    try {
      const result = JSON.parse(fs.readFileSync(path.join(path.dirname(runDir), from, "result.json"), "utf8")) as Record<string, unknown>;
      return { run: storedRun(from, result) };
    } catch {
      return { code: "REPRODUCTION_SEED_RUN_NOT_FOUND", missing: "earlier Semantic run", reason: `the Semantic run ${from} has no readable result in this workspace` };
    }
  }
  for (const prior of priorSemanticRuns(runDir, 50)) {
    const run = storedRun(prior.runId, prior.result);
    if (needsValidation(run).length > 0) return { run };
  }
  return { code: "REPRODUCTION_NO_NEEDS_VALIDATION", missing: "needs-validation finding", reason: "no earlier Semantic run of this workspace has a needs-validation finding of a method that reads source code" };
}

/** The seeds of a run (and the findings skipped, with their reason), or why none can be reproduced. */
export function collectSeeds(
  input: Pick<ModuleApplicabilityInput, "runDir" | "readable" | "readFile">,
  selection: SeedSelection,
): { seedRun: { runId: string; method: string | null }; seeds: ReproductionSeed[]; skipped: SkippedFinding[] } | { code: string; missing: string; reason: string } {
  const found = seedRunFor(input.runDir, selection);
  if ("code" in found) return found;
  const { run } = found;
  let open = needsValidation(run);
  if (selection.findings && selection.findings.length > 0) {
    const wanted = new Set(selection.findings.map((f) => f.trim()));
    open = open.filter((c) => wanted.has(String(c.id ?? "")));
  }
  if (open.length === 0) {
    const what = selection.findings && selection.findings.length > 0 ? `the findings ${selection.findings.join(", ")} are not needs-validation findings` : "it has no needs-validation finding";
    const method = run.method !== null && INELIGIBLE_SEED_METHODS.has(run.method) ? ` (${run.method} findings are not reproduced)` : "";
    return { code: "REPRODUCTION_NO_NEEDS_VALIDATION", missing: "needs-validation finding", reason: `the Semantic run ${run.runId} cannot be reproduced: ${what}${method}` };
  }
  const seeds: ReproductionSeed[] = [];
  const skipped: SkippedFinding[] = [];
  const keys = new Set<string>();
  for (const c of open) {
    const candidateId = String(c.id ?? "");
    const title = str(c.title, 200);
    const raw = String(c.path ?? "");
    const skip = (code: string, reason: string, at = raw): void => {
      skipped.push({ runId: run.runId, candidateId, title, path: at, code, reason });
    };
    const p = normalizeScopePath(raw);
    if (!p || title === "") {
      skip("REPRODUCTION_FINDING_UNUSABLE", "the record has no usable path or title");
      continue;
    }
    const line = typeof c.line === "number" && Number.isInteger(c.line) && c.line > 0 ? c.line : null;
    const key = `${p}\u0000${line ?? "-"}\u0000${title.toLowerCase()}`;
    if (keys.has(key)) continue;
    if (!input.readable(p)) {
      skip("REPRODUCTION_FINDING_NOT_READABLE", "its file is not readable in this scope", p);
      continue;
    }
    const text = input.readFile(p);
    const lines = text === null ? 0 : text.split(/\r?\n/).length;
    if (line !== null && line > lines) {
      skip("REPRODUCTION_FINDING_NOT_READABLE", `its line ${line} no longer exists (the file has ${lines})`, p);
      continue;
    }
    const runner = runnerForSource(p);
    if ("code" in runner) {
      skip(runner.code, runner.reason, p);
      continue;
    }
    if (seeds.length >= MAX_FINDINGS) {
      skip("REPRODUCTION_TOO_MANY_FINDINGS", `at most ${MAX_FINDINGS} findings are reproduced per run`, p);
      continue;
    }
    keys.add(key);
    const details = isObj(c.details) ? c.details : {};
    const record = isObj(details.record) ? details.record : {};
    const plan = isObj(record.validation_plan) ? record.validation_plan : isObj(details.validation_plan) ? details.validation_plan : null;
    const local = plan ? str(plan.local, 1500) : "";
    const deployment = plan ? str(plan.deployment, 1500) : "";
    const validation = isObj(c.validation) ? str(c.validation.reason, 1000) : "";
    seeds.push({
      id: `F${seeds.length + 1}`,
      source: { runId: run.runId, candidateId, method: run.method },
      title,
      path: p,
      line,
      severity: String(c.severity ?? "important"),
      category: String(c.category ?? "security"),
      rationale: str(c.rationale, 1500),
      fingerprint: str(record.fingerprint ?? details.fingerprint ?? details.root_cause_key, 200) || null,
      claimedRootCause: str(record.claimed_root_cause ?? details.root_cause, 1000) || null,
      impact: str(record.impact, 1000) || null,
      blockers: strings(record.blockers, 500, 5),
      validationPlan: local || deployment ? { ...(local ? { local } : {}), ...(deployment ? { deployment } : {}) } : null,
      validation: validation ? { reason: validation } : null,
      runner: runner.runner,
    });
  }
  if (seeds.length === 0) {
    const codes = [...new Set(skipped.map((s) => s.code))];
    const code = codes.length === 1 ? (codes[0] as string) : "REPRODUCTION_NO_REPRODUCIBLE_FINDING";
    return { code, missing: code === TEST_RUNNER_NOT_SUPPORTED ? "supported test runner" : "reproducible finding", reason: `no needs-validation finding of ${run.runId} can be reproduced: ${skipped.map((s) => `${s.candidateId} ${s.path}: ${s.reason}`).join("; ").slice(0, 900)}` };
  }
  return { seedRun: { runId: run.runId, method: run.method }, seeds, skipped };
}

/** The language ecosystem whose dependency volume a runner mounts. */
const ECOSYSTEM: Readonly<Record<TestRunnerId, string>> = { pytest: "python", "node:test": "node" };

/**
 * The seeds whose component has its dependencies prepared (a container engine only: the dependency volumes of
 * `jgates deps prepare`). A component without declared dependencies needs none. Discovery reads files only.
 */
export function seedsWithDependencies(input: { workspacePath: string; home: string; workspace: string }, seeds: readonly ReproductionSeed[]): { ready: ReproductionSeed[]; skipped: SkippedFinding[] } {
  let classifications: ReturnType<typeof discoverWorkspace>["inventory"]["classifications"] = [];
  try {
    classifications = discoverWorkspace(input.workspacePath).inventory.classifications;
  } catch {
    classifications = [];
  }
  const units = Object.values(readDepsState(input.home, input.workspace).units);
  const ready: ReproductionSeed[] = [];
  const skipped: SkippedFinding[] = [];
  const within = (root: string, file: string): boolean => root === "." || root === "" || file === root || file.startsWith(`${root}/`);
  for (const seed of seeds) {
    const ecosystem = ECOSYSTEM[seed.runner];
    const component = classifications
      .filter((c) => c.dependencies?.ecosystem === ecosystem && within(c.componentRoot, seed.path))
      .sort((a, b) => b.componentRoot.length - a.componentRoot.length)[0];
    if (!component?.dependencies) {
      ready.push(seed);
      continue;
    }
    const root = component.dependencies.installRoot === "" ? "." : component.dependencies.installRoot;
    const managers = TEST_RECIPES[seed.runner].dependencies.managers;
    const prepared = units.some((u) => (u.installRoot === "" ? "." : u.installRoot) === root && managers.includes(u.manager));
    if (prepared) ready.push(seed);
    else {
      skipped.push({
        runId: seed.source.runId,
        candidateId: seed.source.candidateId,
        title: seed.title,
        path: seed.path,
        code: DEPENDENCIES_NOT_PREPARED,
        reason: `${DEPENDENCIES_NOT_PREPARED}: the ${ecosystem} dependencies of the component at ${component.componentRoot} (install root ${root}) are not prepared for ${seed.runner} (jgates deps prepare, then try again)`,
      });
    }
  }
  return { ready, skipped };
}
