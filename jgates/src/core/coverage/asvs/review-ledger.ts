// The ledger of the Semantic method `asvs-review` (evidence/asvs-review/requirements-ledger.json): one answer per
// requirement the run reviewed. Its shape is schemas/coverage/asvs-review-ledger.schema.json; this module validates a
// stored ledger against that schema and against the workspace, for the ASVS map (a `semantic-requirement` check ran for a
// requirement only when its answer here is valid and `examined`) and for the method that writes it.
//
// What makes the whole ledger unusable: it is missing, it is not valid against its schema, it names a requirement twice,
// or it is for another ASVS version than the map. What makes one answer count for nothing: a file reference that is not
// a regular file inside the workspace (a missing file, a path that leaves the workspace, a link out of it), a line range
// that ends before it starts, or no workspace to check the references against. A `not-examinable` answer never counts.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { insideBySegments } from "../../documents/paths.js";

/** Where the ledger sits in a Semantic run folder. */
export const ASVS_REVIEW_LEDGER_FILE = "evidence/asvs-review/requirements-ledger.json";

export const ASVS_REVIEW_ANSWERS = ["examined", "not-examinable"] as const;
export const ASVS_REVIEW_OUTCOMES = ["no-violation-found", "finding"] as const;
export const ASVS_REVIEW_NOT_EXAMINABLE_REASONS = ["running-system", "person", "outside-scope"] as const;

export interface AsvsReviewReference {
  /** Relative to the workspace root, forward slashes. */
  path: string;
  startLine: number;
  endLine: number;
}

export interface AsvsReviewAnswer {
  id: string;
  unit?: string;
  answer: (typeof ASVS_REVIEW_ANSWERS)[number];
  references?: AsvsReviewReference[];
  outcome?: (typeof ASVS_REVIEW_OUTCOMES)[number];
  findings?: string[];
  reason?: (typeof ASVS_REVIEW_NOT_EXAMINABLE_REASONS)[number];
  detail?: string;
}

export interface AsvsReviewLedger {
  schemaVersion: 1;
  kind: "asvs-review-ledger";
  method: "asvs-review";
  asvsVersion: string;
  level: 1 | 2 | 3;
  requirements: AsvsReviewAnswer[];
}

/** The schema file, found from dist/core/coverage/asvs (src/ sits at the same depth). */
export function asvsReviewLedgerSchemaFile(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "schemas", "coverage", "asvs-review-ledger.schema.json");
}

type Validator = ((doc: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };
let validator: Validator | null = null;

function ledgerValidator(): Validator {
  if (validator) return validator;
  const require = createRequire(import.meta.url);
  const mod = require("ajv/dist/2020") as { default: new (opts: object) => { compile(schema: unknown): Validator } };
  const ajv = new mod.default({ strict: true, allErrors: true, allowUnionTypes: true, strictTypes: false });
  validator = ajv.compile(JSON.parse(fs.readFileSync(asvsReviewLedgerSchemaFile(), "utf8")));
  return validator;
}

/** The problems of a ledger document against its schema and its own rules (one answer per id); empty when valid. */
export function asvsReviewLedgerProblems(doc: unknown): string[] {
  const validate = ledgerValidator();
  if (!validate(doc)) return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const answer of (doc as AsvsReviewLedger).requirements) {
    if (seen.has(answer.id)) problems.push(`${answer.id} is answered more than once`);
    seen.add(answer.id);
  }
  return problems;
}

/** Why one reference does not count, or null when it names a regular file inside the workspace with a sound line range. */
export function referenceProblem(reference: AsvsReviewReference, workspaceDir: string): string | null {
  if (reference.endLine < reference.startLine) return `${reference.path}: the line range ends before it starts`;
  const parts = reference.path.split("/");
  if (path.isAbsolute(reference.path) || /^[A-Za-z]:/.test(reference.path) || parts.some((p) => p === "" || p === "." || p === "..")) return `${reference.path}: not a path inside the workspace`;
  let root: string;
  let real: string;
  try {
    root = fs.realpathSync.native(workspaceDir);
    real = fs.realpathSync.native(path.join(workspaceDir, ...parts));
  } catch {
    return `${reference.path}: no such file in the workspace`;
  }
  if (!insideBySegments(root, real)) return `${reference.path}: it leads outside the workspace`;
  try {
    if (!fs.statSync(real).isFile()) return `${reference.path}: not a file`;
  } catch {
    return `${reference.path}: no such file in the workspace`;
  }
  return null;
}

/** The reason of a `not-examinable` answer in words (English, as a run's own record). */
const NOT_EXAMINABLE_WORDS: Readonly<Record<(typeof ASVS_REVIEW_NOT_EXAMINABLE_REASONS)[number], string>> = {
  "running-system": "it needs a running system",
  person: "it needs a person (a document, a process or an operational setting)",
  "outside-scope": "it needs code outside the reviewed scope",
};

export type AsvsReviewLedgerCode = "REVIEW_LEDGER_MISSING" | "REVIEW_LEDGER_INVALID" | "REVIEW_LEDGER_OTHER_VERSION";

/** What one answer is worth for the map. */
export interface AsvsReviewVerdict {
  id: string;
  /** examined: it counts; not-examinable: the model said the source cannot answer it; invalid: an examined answer whose references do not hold. */
  state: "examined" | "not-examinable" | "invalid";
  /** REFERENCE_MISSING, REFERENCES_UNVERIFIED or NOT_EXAMINABLE; null when it counts. */
  code: "REFERENCE_MISSING" | "REFERENCES_UNVERIFIED" | "NOT_EXAMINABLE" | null;
  /** Why it does not count (English, for the record); null when it counts. */
  reason: string | null;
  /** not-examinable: the reason id. */
  notExaminable?: AsvsReviewAnswer["reason"];
  references: number;
  outcome: AsvsReviewAnswer["outcome"] | null;
  /** The fingerprints of the findings the answer raised. */
  findings: string[];
}

export type AsvsReviewRead = { ok: true; ledger: AsvsReviewLedger; verdicts: Map<string, AsvsReviewVerdict> } | { ok: false; code: AsvsReviewLedgerCode; reason: string };

/**
 * Reads a stored ledger for the map: the whole ledger (missing, invalid, another version) and each answer against the
 * workspace. `workspaceDir` null: the references cannot be checked, so no examined answer counts.
 */
export function readAsvsReviewLedger(doc: unknown, options: { workspaceDir: string | null; asvsVersion?: string }): AsvsReviewRead {
  if (doc === null || doc === undefined) return { ok: false, code: "REVIEW_LEDGER_MISSING", reason: "the ASVS review has no requirements ledger" };
  const problems = asvsReviewLedgerProblems(doc);
  if (problems.length > 0) return { ok: false, code: "REVIEW_LEDGER_INVALID", reason: `the requirements ledger of the ASVS review is not valid: ${problems.slice(0, 3).join("; ")}` };
  const ledger = doc as AsvsReviewLedger;
  if (options.asvsVersion !== undefined && ledger.asvsVersion !== options.asvsVersion) {
    return { ok: false, code: "REVIEW_LEDGER_OTHER_VERSION", reason: `the requirements ledger is for ASVS ${ledger.asvsVersion}, not ${options.asvsVersion}` };
  }
  const verdicts = new Map<string, AsvsReviewVerdict>();
  for (const a of ledger.requirements) {
    const base = { id: a.id, references: a.references?.length ?? 0, outcome: a.outcome ?? null, findings: a.findings ?? [] };
    if (a.answer === "not-examinable") {
      const why = a.reason ? NOT_EXAMINABLE_WORDS[a.reason] : "the source cannot answer it";
      verdicts.set(a.id, { ...base, state: "not-examinable", code: "NOT_EXAMINABLE", reason: a.detail ? `${why}: ${a.detail}` : why, ...(a.reason ? { notExaminable: a.reason } : {}) });
      continue;
    }
    if (options.workspaceDir === null) {
      verdicts.set(a.id, { ...base, state: "invalid", code: "REFERENCES_UNVERIFIED", reason: "the workspace is not known, so the file references cannot be checked" });
      continue;
    }
    const wrong = (a.references ?? []).map((r) => referenceProblem(r, options.workspaceDir as string)).find((p) => p !== null);
    if (wrong) verdicts.set(a.id, { ...base, state: "invalid", code: "REFERENCE_MISSING", reason: wrong });
    else verdicts.set(a.id, { ...base, state: "examined", code: null, reason: null });
  }
  return { ok: true, ledger, verdicts };
}
