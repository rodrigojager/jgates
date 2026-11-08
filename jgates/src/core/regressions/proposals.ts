// Regression proposals: tests a Semantic method proposes (a property test of an invariant, the reproducer of a patch)
// as reviewable material of its run, in evidence/regressions/proposals.json. A proposal is never part of the project:
// nothing here writes outside the run folder, no Quality plan reads it, and it becomes a Quality regression only through
// the explicit incorporation command (incorporate.ts) after a fresh validation. Its content is model output: untrusted
// until a person approves it, and executed only in the sandbox (sandbox.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { semanticRunsDir } from "../semantic/store.js";

export const PROPOSALS_FILE = "evidence/regressions/proposals.json";
/** Where a proposed test lives (workspace-relative folder): in a fixture, and in the project once incorporated. */
export const REGRESSIONS_DIR = ".jgates/regressions";
export const PROPOSAL_RUNNER = "node-test";
/** A proposed test file name: lowercase, ending in .test.mjs (an ES module run by node:test). */
export const PROPOSAL_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,80}\.test\.mjs$/;
const MAX_CONTENT = 20_000;

export interface RegressionProposal {
  /** P1, P2... within the run. */
  id: string;
  kind: "test";
  runner: typeof PROPOSAL_RUNNER;
  /** File name under .jgates/regressions/ (imports of project files are relative to that folder). */
  file: string;
  content: string;
  sha256: string;
  title: string;
  rationale: string;
  origin: { runId: string; method: string; stage: string; candidate: string | null; candidateStatus: string | null; invariant: string | null };
  /** What the method itself observed by executing it (post-patch: before and after the patch); null: never executed by the method. */
  execution: Record<string, unknown> | null;
  status: "proposed";
}

export const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/** A proposed test of an artifact (file name and content), or null with the problem pushed. */
export function checkProposedTest(raw: unknown, problems: string[], where: string): { file: string; content: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const file = String(r.name ?? r.file ?? "").trim();
  const content = typeof r.content === "string" ? r.content.replace(/\r\n/g, "\n") : "";
  if (!PROPOSAL_FILE_PATTERN.test(file)) {
    problems.push(`${where}: the test name ${JSON.stringify(file.slice(0, 80))} must be lowercase and end in .test.mjs; the test is dropped`);
    return null;
  }
  if (content.trim().length < 20 || content.length > MAX_CONTENT || !/node:test/.test(content)) {
    problems.push(`${where}: the test must be a node:test module of at most ${MAX_CONTENT} characters; it is dropped`);
    return null;
  }
  return { file, content };
}

/** The proposals document of a run (written by the module's finalize under evidence/). */
export function proposalsFile(runDir: string, method: string, proposals: Array<Omit<RegressionProposal, "id" | "sha256" | "kind" | "runner" | "status" | "origin"> & { origin: Omit<RegressionProposal["origin"], "runId" | "method"> }>): { path: string; content: string; proposals: RegressionProposal[] } {
  const runId = path.basename(runDir);
  const used = new Set<string>();
  const out: RegressionProposal[] = [];
  for (const p of proposals) {
    // Two proposals never share a file name: a repeated one gets a numeric suffix.
    let file = p.file;
    for (let n = 2; used.has(file); n++) file = p.file.replace(/\.test\.mjs$/, `-${n}.test.mjs`);
    used.add(file);
    out.push({ ...p, id: `P${out.length + 1}`, kind: "test", runner: PROPOSAL_RUNNER, file, sha256: sha256(p.content), origin: { runId, method, ...p.origin }, status: "proposed" });
  }
  const doc = { schemaVersion: 1, kind: "semantic-regression-proposals", runId, method, note: "Proposals only: none is part of the project until `jgates regressions incorporate <run>/<id> --approve`.", proposals: out };
  return { path: PROPOSALS_FILE, content: `${JSON.stringify(doc, null, 2)}\n`, proposals: out };
}

/** The proposals of one Semantic run (empty when it has none or the file is unreadable). */
export function readRunProposals(runDir: string): RegressionProposal[] {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(runDir, ...PROPOSALS_FILE.split("/")), "utf8")) as { proposals?: unknown };
    if (!Array.isArray(doc.proposals)) return [];
    return doc.proposals.filter((p): p is RegressionProposal => !!p && typeof p === "object" && typeof (p as RegressionProposal).id === "string" && typeof (p as RegressionProposal).content === "string" && PROPOSAL_FILE_PATTERN.test(String((p as RegressionProposal).file)));
  } catch {
    return [];
  }
}

export interface ListedProposal {
  /** <run ID>/<proposal ID>, the reference the CLI takes. */
  ref: string;
  runId: string;
  runDir: string;
  proposal: RegressionProposal;
  /** The content changed since the run recorded it (sha256 mismatch): it cannot be incorporated. */
  tampered: boolean;
}

/** Every proposal of the workspace's Semantic runs, newest run first. */
export function listProposals(home: string, workspaceId: string): ListedProposal[] {
  const root = semanticRunsDir(home, workspaceId);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((n) => n.startsWith("sem_"));
  } catch {
    return [];
  }
  const out: ListedProposal[] = [];
  for (const runId of names.sort().reverse()) {
    const runDir = path.join(root, runId);
    for (const proposal of readRunProposals(runDir)) out.push({ ref: `${runId}/${proposal.id}`, runId, runDir, proposal, tampered: sha256(proposal.content) !== proposal.sha256 });
  }
  return out;
}

/** One proposal by reference (<run ID>/<proposal ID>), or null. */
export function findProposal(home: string, workspaceId: string, ref: string): ListedProposal | null {
  return listProposals(home, workspaceId).find((p) => p.ref === ref) ?? null;
}
