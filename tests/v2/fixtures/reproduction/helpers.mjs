// Fixtures of confirm-by-reproduction (jgates/tests/semantic-reproduction.test.js): a small Python project with three
// findings an earlier security audit left needs-validation, the stored result of that earlier run, the scripted model
// (in-process, no tokens) and the engine that replays the reproducers' container runs. The reproducers never run on the
// host: the replaying engine of the Semantic test-file runner (jgates/tests/fixtures/semantic-test-runner/
// replay-engine.cjs) answers each test container with a recording of recorded/reproduction.json, chosen by the file
// placed in the workspace copy, and emulates the helper that places and removes it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as B from "../complementary-b/helpers.mjs";

export const { ROOT, load, answer, read, recorder, forbidden, treeHash, readJson, containerEnv, engineCalls, testContainers, withoutHostTests, cliFor, TOOLS_IMAGE_ID } = B;
const here = path.dirname(fileURLToPath(import.meta.url));
export const RECORDINGS = path.join(here, "recorded", "reproduction.json");
export const ENGINE = path.join(ROOT, "jgates", "tests", "fixtures", "semantic-test-runner", "replay-engine.cjs");
export const DEPS_VOLUME = "jgates-deps-repro-py";
/** The id of the earlier security-audit run the findings come from. */
export const SEED_RUN = "sem_20261114T100000Z_5eed0001";

export const PRICING = ["# Order pricing.", "", "", "def apply_discount(total, percent):", '    """Total after a percentage discount (0 to 100)."""', "    return total - total * percent / 100", ""].join("\n");
export const INVENTORY = ["# Stock reservations.", "", "", "def reserve(stock, quantity):", '    """Stock left after reserving quantity; never below zero."""', "    if quantity > stock:", '        raise ValueError("not enough stock")', "    return stock - quantity", ""].join("\n");
export const AUTH = ["# Session tokens.", "import time", "", "", "def token_valid(issued_at, ttl_seconds, now=None):", "    now = time.time() if now is None else now", "    return now - issued_at <= ttl_seconds", ""].join("\n");
/** A regression test the project already incorporated (its path exists in the workspace copy). */
export const EXISTING = ["from src.pricing import apply_discount", "", "", "def test_existing():", "    assert apply_discount(10, 0) == 10", ""].join("\n");

export const PROJECT = {
  "src/pricing.py": PRICING,
  "src/inventory.py": INVENTORY,
  "src/auth.py": AUTH,
  "requirements.txt": "six==1.16.0\n",
  ".jgates/regressions/test_existing.py": EXISTING,
};

/** The line of each finding (the faulty statement). */
export const LINES = { "src/pricing.py": 6, "src/inventory.py": 8, "src/auth.py": 7 };

const record = (fingerprint, title, root, plan, priority) => ({ verdict: "needs_validation", fingerprint, title, description: title, claimed_root_cause: root, impact: "an order or a session in a wrong state", priority, trace: [], evidence: [], conditions: [], blockers: ["no caller or test was readable to show it"], validation_plan: { local: plan } });
const nv = (id, p, title, severity, root, plan) => ({
  id,
  title,
  path: p,
  line: LINES[p],
  severity,
  category: "security",
  rationale: `${title}: ${root}.`,
  status: "needs-validation",
  confirmation: "needs-validation",
  reportedBy: { stage: "hunting", context: "hunting" },
  validation: { stage: "verification", context: `verify:${id}`, reason: "The source alone does not settle it; a local test would.", evidence: [] },
  details: { record: record(`repro-${id.toLowerCase()}`, title, root, plan, severity === "blocking" ? "high" : "medium") },
  limitations: [],
});

/** The three needs-validation findings (C1 to C3), a confirmed one and a rejected one (never reproduced). */
export const SEED_CANDIDATES = [
  nv("C1", "src/pricing.py", "A discount above 100% makes the order total negative", "blocking", "apply_discount never bounds percent to 0..100", "call apply_discount(100, 120) and assert the total is not negative"),
  nv("C2", "src/inventory.py", "Reserving more than the stock leaves a negative stock", "important", "reserve may subtract more than the stock", "reserve(3, 5) and assert it is refused"),
  nv("C3", "src/auth.py", "A token stays valid after its expiry second", "important", "the comparison includes the expiry second", "check a token at issued_at + ttl"),
  { ...nv("C4", "src/pricing.py", "Totals are floats", "suggestion", "money as float", "-"), status: "confirmed", confirmation: "confirmed", line: 4 },
  { ...nv("C5", "src/auth.py", "time.time is mocked badly", "nit", "-", "-"), status: "rejected", confirmation: "rejected", line: 2 },
];

/** Writes the stored result of an earlier Semantic run of the workspace (its folder beside the runs to come). */
export async function writeSeedRun(ws, candidates = SEED_CANDIDATES, { runId = SEED_RUN, method = "security-audit" } = {}) {
  const { workspaceId } = await load("core/ids/index.js");
  const { semanticRunsDir } = await load("core/semantic/index.js");
  const dir = path.join(semanticRunsDir(ws.home, workspaceId(ws.dir)), runId);
  fs.mkdirSync(dir, { recursive: true });
  const result = { schemaVersion: 1, runId, gate: "semantic", decision: "failed", semanticRun: { outcome: { requested: true, state: "completed", calls: 9, investigation: { kind: "semantic-investigation", module: { id: method, version: "1", title: method }, candidates } } } };
  const file = path.join(dir, "result.json");
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return { runId, dir, file };
}

/** Records the prepared Python dependency volume of the project root, as `jgates deps prepare` does. */
export async function prepareDependencies(ws) {
  const { workspaceId } = await load("core/ids/index.js");
  const { depsStateFile } = await load("core/deps/index.js");
  const file = depsStateFile(ws.home, workspaceId(ws.dir));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, units: { py: { volume: DEPS_VOLUME, key: "0".repeat(64), manager: "pip", installRoot: ".", installedAt: "2026-11-14T00:00:00.000Z" } }, failures: {} }, null, 2));
  return file;
}

/** A workspace with the project, the replaying engine, prepared dependencies and the earlier run. */
export async function reproductionWorkspace(prefix, { files = PROJECT, candidates = SEED_CANDIDATES, deps = true } = {}) {
  const ws = B.setupWorkspace(prefix, files);
  Object.assign(ws.env, containerEnv(ws, { engine: ENGINE, env: { JGATES_RUNNER_RECORDINGS: RECORDINGS } }));
  if (deps) await prepareDependencies(ws);
  const seed = candidates ? await writeSeedRun(ws, candidates) : null;
  const { workspaceId } = await load("core/ids/index.js");
  const { sourceVolumeName } = await load("core/engine/index.js");
  const copy = path.join(ws.root, "engine-state", "volumes", sourceVolumeName(workspaceId(ws.dir)));
  return { ws, seed, copy };
}

/** Runs the module through the real executor and the Semantic run service, with the scripted model. */
export async function runReproduction(ws, module, { script, rigor = "standard", budget = null, env = ws.env } = {}) {
  const { buildSemanticPlan, executeSemanticRun } = await load("core/semantic/index.js");
  const plan = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env, rigor, budget });
  const result = await executeSemanticRun({ workspacePath: ws.dir, home: ws.home, env, version: "0.0.0-test", plan, cancelPollMs: 50, investigation: { module, deps: { script } } });
  return { plan, result, outcome: result.semanticRun.outcome, investigation: result.semanticRun.outcome.investigation };
}

// ---- reproducers the scripted analyst writes (each carries the marker its recording matches) ---------------------------

const py = (...lines) => [...lines, ""].join("\n");
export const TESTS = {
  discountBound: { name: "test_discount_bound.py", content: py("# case: discount-bound", "from src.pricing import apply_discount", "", "", "def test_discount_never_makes_the_total_negative():", "    assert apply_discount(100, 120) >= 0") },
  reserveLimit: { name: "test_reserve_limit.py", content: py("# case: reserve-limit", "import pytest", "", "from src.inventory import reserve", "", "", "def test_reserving_more_than_the_stock_is_refused():", "    with pytest.raises(ValueError):", "        reserve(3, 5)") },
  tokenExpiry: { name: "test_token_expiry.py", content: py("# case: token-expiry", "from src.auth import expire_token", "", "", "def test_token_expires_at_its_ttl():", "    assert expire_token(0, 10, now=10) is False") },
  discountRounding: { name: "test_discount_rounding.py", content: py("# case: discount-rounding", "from src.pricing import apply_discount", "", "", "def test_discount_rounds_to_cents():", "    assert apply_discount(10, 33) == 6.7") },
  reserveClock: { name: "test_reserve_clock.py", content: py("# case: reserve-clock", "import time", "", "from src.inventory import reserve", "", "", "def test_reserve_is_fast():", "    started = time.monotonic()", "    reserve(5, 1)", "    assert time.monotonic() - started < 0.000001") },
  existing: { name: "test_existing.py", content: py("# case: existing", "from src.inventory import reserve", "", "", "def test_reserve_three():", "    assert reserve(3, 3) == 0") },
  outside: { path: "tests/test_discount.py", content: py("from src.pricing import apply_discount", "", "", "def test_discount():", "    assert apply_discount(100, 120) >= 0") },
};

/**
 * The analyst: in the reproducer context of a finding it reads the finding's file (when readFirst) and writes the test
 * `tests[path]`; in an assessment context it reads the file and attributes the failure to `causes[path]`. It decides
 * from the brief the host gave it (the candidate's path and ID), never from the test's state.
 */
export function reproductionAnalyst({ tests, causes = {}, readFirst = true }) {
  return recorder((stage, request, turn, brief) => {
    const p = /"path": "([^"]+)"/.exec(brief)?.[1];
    const id = /"candidateId": "([^"]+)"/.exec(brief)?.[1];
    if (stage === "reproducer") {
      if (readFirst && turn === 0) return read([p]);
      const test = tests[p];
      return answer({ summary: `One reproducer for the finding in ${p}.`, defect: `the behavior the finding in ${p} describes`, test });
    }
    if (stage === "assessment") {
      if (readFirst && turn === 0) return read([p]);
      const cause = causes[p] ?? "unknown";
      return answer({ candidateId: id, cause, reason: cause === "defect" ? "The failing assertion is the wrong behavior the finding describes, on the line it cites." : `The failure comes from the ${cause}, not from the code of the finding.`, evidence: [{ path: p, line: LINES[p], note: "the statement of the finding" }] });
    }
    return { text: "" };
  });
}
