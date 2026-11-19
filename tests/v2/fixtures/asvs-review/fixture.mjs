// Shared fixture of the asvs-review cases (jgates/tests/semantic-asvs-review.test.js and V2-99): a Git workspace with two
// source files and a recorded "not applicable" decision, a data folder with one stored Quality run, a mapping pack of its
// own (17 chapter files holding only the entries the cases need) and a scripted reviewer. Every model answer is
// scripted: no test spends model tokens and no provider is called.
//
// The requirements (level 1 unless said otherwise), in two chapters A and B:
//   det      A  reviewed, repository, a capability check that ran in the stored Quality run: examined deterministically
//   ai       A  reviewed, repository, names asvs-review; answered examined, no violation found
//   find     A  reviewed, repository, names asvs-review; answered examined with a finding
//   na       A  reviewed, repository, names asvs-review; recorded "not applicable" in .jgates/asvs.json
//   ne       B  reviewed, repository, names asvs-review; answered not-examinable (person)
//   ghost    B  reviewed, repository, names asvs-review; answered examined with a file that does not exist
//   unnamed  B  pending, repository, no check; answered examined (no reviewed entry names the unit)
//   person   B  reviewed, evidence person: never planned
//   level2      a level-2 requirement with evidence repository: never planned at the project's level 1
import fs from "node:fs";
import path from "node:path";
import { ROOT, load, setupWorkspace } from "../semantic-executor/helpers.mjs";

const asvs = await load("core/coverage/asvs/index.js");
const { buildMatrix } = await load("core/matrix/index.js");
const { touchWorkspace } = await load("core/home/index.js");
export { asvs };

export const QUALITY_RUN = "run_20261115T100000Z_aaaaaaaa";

const data = asvs.loadAsvs("5.0.0");
const level1 = asvs.asvsRequirements(data, { level: 1 });
const chapters = [...new Set(level1.map((r) => r.chapter))].filter((c) => level1.filter((r) => r.chapter === c).length >= 4);
const [A, B] = chapters;
const inA = level1.filter((r) => r.chapter === A);
const inB = level1.filter((r) => r.chapter === B);
/** The requirements of the fixture, by role. */
export const R = {
  det: inA[0],
  ai: inA[1],
  find: inA[2],
  na: inA[3],
  ne: inB[0],
  ghost: inB[1],
  unnamed: inB[2],
  person: inB[3],
  level2: data.requirements.find((r) => r.level === 2 && r.chapter !== A && r.chapter !== B),
};
export const CHAPTERS = { A, B };
/** What the plan must list, in the order of the release file. */
export const PLANNED = [R.ai, R.find, R.ne, R.ghost, R.unnamed].map((r) => r.id);

/** A capability with a validated matrix row (not Semgrep), and a language its row covers. */
const row = buildMatrix().rows.find((r) => r.state === "validated" && r.adapter !== "semgrep");
if (!row) throw new Error("the fixture needs a capability with a validated matrix row");
export const CAPABILITY = { id: `${row.adapter}#${row.capability}`, adapter: row.adapter, capability: row.capability, language: row.stack === "any" ? "javascript" : row.stack };

export const FILES = {
  "src/auth.js": ["function login(user, password) {", "  if (!user) return false;", "  return password === user.password;", "}", "module.exports = { login };", ""].join("\n"),
  "src/session.js": ["const sessions = new Map();", "exports.open = (id) => sessions.set(id, Date.now());", ""].join("\n"),
  ".jgates/asvs.json": `${JSON.stringify({ notApplicable: [{ id: R.na.id, reason: "no such feature in this product", recorded: "2026-11-15" }] }, null, 2)}\n`,
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** The mapping pack of the fixture: 17 chapter files with only the entries of the cases, no unmapped rule. */
export function writeMapping(dir) {
  const versionDir = path.join(dir, "5.0.0");
  const check = (unit, id) => ({ unit, id, covers: "what this check reads of the requirement", misses: "what it does not read", depth: "partial" });
  const reviewed = (requirement, checks, evidence = "repository") => ({ requirement, status: "reviewed", evidence, subdimensions: ["business-logic"], checks, why: "It bears on the requirement for a reason of its own.", review: { by: "independent context", date: "2026-11-15" } });
  const review = check("semantic-requirement", "asvs-review");
  const entries = [
    reviewed(R.det.id, [check("capability", CAPABILITY.id)]),
    reviewed(R.ai.id, [review]),
    reviewed(R.find.id, [review]),
    reviewed(R.na.id, [review]),
    reviewed(R.ne.id, [review]),
    reviewed(R.ghost.id, [review]),
    { requirement: R.unnamed.id, status: "pending", evidence: "repository", subdimensions: [], checks: [] },
    reviewed(R.person.id, [], "person"),
    reviewed(R.level2.id, [review]),
  ];
  for (let i = 1; i <= 17; i++) {
    const chapter = `V${i}`;
    writeJson(path.join(versionDir, `${asvs.chapterFileStem(chapter)}.json`), { version: "5.0.0", chapter, entries: entries.filter((e) => e.requirement.startsWith(`${chapter}.`)) });
  }
  writeJson(path.join(versionDir, "unmapped-rules.json"), { version: "5.0.0", rules: [] });
  return dir;
}

const stamp = { schemaVersion: 1, tool: "jgates", version: "2.0.0", requirements: [], unsatisfied: [], warnings: [], blockingViolations: 0, disabled: [], complete: true, reduced: false, findings: [] };

/** One finished Quality run in which the fixture's capability ran to completion. */
export function storeQualityRun(home, wsId) {
  const dir = path.join(home, "workspaces", wsId, "runs", QUALITY_RUN);
  const stageId = CAPABILITY.id;
  writeJson(path.join(dir, "result.json"), {
    ...stamp,
    runId: QUALITY_RUN,
    gate: "quality",
    startedAt: "2026-11-15T10:00:00.000Z",
    finishedAt: "2026-11-15T10:00:01.000Z",
    decision: "passed",
    exitCode: 0,
    stages: [{ id: stageId, adapter: CAPABILITY.adapter, state: "completed", interpreted: true }],
    workspaceChanges: { checked: true, added: [], modified: [], removed: [] },
    artifacts: { result: "result.json", logs: [], outputs: [], plan: "plan.json" },
  });
  writeJson(path.join(dir, "plan.json"), { schemaVersion: 1, kind: "jgates-plan", groups: { willRun: [{ id: stageId, adapter: CAPABILITY.adapter, tool: CAPABILITY.adapter, capabilities: [CAPABILITY.capability], languages: [CAPABILITY.language] }], notApplicableOrDisabled: [] } });
  return dir;
}

/**
 * The workspace, its data folder and the fixture mapping (named by JGATES_ASVS_MAP_DIR in the run's environment).
 * `quality: false` leaves the data folder without a Quality run.
 */
export function setupAsvsReview(prefix, { quality = true } = {}) {
  const ws = setupWorkspace(prefix, FILES);
  const mappingDir = writeMapping(path.join(ws.root, "map"));
  ws.env.JGATES_ASVS_MAP_DIR = mappingDir;
  const wsId = touchWorkspace(ws.dir, { home: ws.home }).id;
  if (quality) storeQualityRun(ws.home, wsId);
  return { ...ws, wsId, mappingDir };
}

const read = (paths) => ({ toolCalls: paths.map((p) => ({ name: "read_file", arguments: { path: p } })) });
const answer = (value) => ({ text: JSON.stringify(value), usage: { inputTokens: 100, outputTokens: 50 } });

/** The scripted reviewer of the fixture: one answer per review unit, a validation that answers `validation`. */
export function scriptedReviewer({ validation = "confirmed", requests = [] } = {}) {
  return (request) => {
    requests.push({ label: request.contextLabel, brief: request.messages[0].text, system: request.system });
    const [stage, target] = request.contextLabel.split(":");
    const turn = request.messages.filter((m) => m.role === "assistant").length;
    if (stage === "requirement-review" && target === A) {
      if (turn === 0) return read(["src/auth.js"]);
      return answer({
        summary: "The login helper.",
        requirements: [
          { id: R.ai.id, answer: "examined", references: [{ path: "src/auth.js", startLine: 1, endLine: 4 }], outcome: "no-violation-found" },
          { id: R.find.id, answer: "examined", references: [{ path: "src/auth.js", startLine: 3, endLine: 3 }], outcome: "finding" },
        ],
        candidates: [{ requirement: R.find.id, title: "Password compared in plain text", path: "src/auth.js", line: 3, severity: "important", rationale: "The stored password is compared directly with the one given." }],
      });
    }
    if (stage === "requirement-review" && target === B) {
      if (turn === 0) return read(["src/session.js"]);
      return answer({
        summary: "The session store.",
        requirements: [
          { id: R.ne.id, answer: "not-examinable", reason: "person", detail: "it asks for a documented decision" },
          { id: R.ghost.id, answer: "examined", references: [{ path: "src/missing.js", startLine: 1, endLine: 2 }], outcome: "no-violation-found" },
          { id: R.unnamed.id, answer: "examined", references: [{ path: "src/session.js", startLine: 1, endLine: 2 }], outcome: "no-violation-found" },
        ],
        candidates: [],
      });
    }
    if (stage === "requirement-validation") {
      if (turn === 0) return read(["src/auth.js"]);
      return answer({ candidateId: target, confirmation: validation, reason: "The comparison has no hashing in what was read.", evidence: [{ path: "src/auth.js", line: 3, note: "direct comparison" }] });
    }
    return { text: "" };
  };
}

/** Builds the plan of asvs-review and runs it with the scripted reviewer. */
export async function runAsvsReview(ws, { script }) {
  const { buildSemanticPlan, executeSemanticRun } = await load("core/semantic/index.js");
  const plan = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env, methods: ["asvs-review"] });
  if (!plan.ready) throw new Error(`the plan is not ready: ${JSON.stringify(plan.blockers)}`);
  const result = await executeSemanticRun({ workspacePath: ws.dir, home: ws.home, env: ws.env, version: "0.0.0-test", plan, cancelPollMs: 50, investigation: { deps: { script } } });
  return { plan, result, outcome: result.semanticRun.outcome };
}

/** The map of the workspace, read as `jgates coverage asvs` reads it. */
export function mapOf(ws, extra = {}) {
  return asvs.buildAsvsMap({ home: ws.home, workspaceId: ws.wsId, projectDir: ws.dir, mappingDir: ws.mappingDir, ...extra });
}

export const LEDGER_SCHEMA = path.join(ROOT, "jgates", "schemas", "coverage", "asvs-review-ledger.schema.json");
