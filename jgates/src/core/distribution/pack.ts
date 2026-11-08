// Distribution check of shippable packs (rules, queries, prompts, skills, configurations, datasets). A pack is a
// folder with a provenance record (jgates-pack.json) next to its content. The check reads every file of the folder
// itself, not only the record: a restricted marker anywhere rejects the pack, whatever the record claims.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DISTRIBUTION_MODES, type DistributionMode } from "../catalog/index.js";
import { isRestrictedSource, requiresShareAlike, restrictedMarkersIn, spdxEligible } from "./license.js";
import { problem, type DistributionProblem, type DistributionProblemCode, type ProblemExtra } from "./problems.js";

/** File name of the provenance record of a pack. */
export const PACK_RECORD_FILE = "jgates-pack.json";

/** Larger files are not read whole; the check rejects them instead of skipping them. */
export const MAX_SCAN_BYTES = 16 * 1024 * 1024;

export type PackReview = "approved" | "candidate" | "rejected";

/** The provenance record of a pack (PLAN-distribution: source, revision, identity, SPDX, notices, review). */
export interface PackRecord {
  schemaVersion: 1;
  id: string;
  /** rules, queries, prompts, skills, configuration, dataset... */
  kind: string;
  distribution: DistributionMode;
  source: { url: string; revision: string };
  /** Optional pinned identity of the content; when present it must match the computed one. */
  artifact?: { sha256: string };
  spdx: string;
  /** Notice files of the pack (paths relative to the pack folder) that travel with it. */
  notices: string[];
  modifications?: string;
  /**
   * How the license's obligations are met. Required for ShareAlike licenses (CC-BY-SA-*): how attribution is given and
   * which adapted files carry the same license, next to a non-empty `modifications`.
   */
  obligations?: { attribution?: string; shareAlike?: string };
  dependencies?: Array<{ name: string; spdx: string; sourceUrl?: string }>;
  review: PackReview;
}

export interface PackReport {
  /** The record id, or the folder (file) name when there is no usable record. */
  id: string;
  dir: string;
  ok: boolean;
  /** sha256 of the content (record excluded): relative paths and file hashes, text line endings normalized. */
  identity: string | null;
  record: PackRecord | null;
  files: string[];
  problems: DistributionProblem[];
}

type Push = (code: DistributionProblemCode, extra?: ProblemExtra) => void;

interface Listed {
  rel: string;
  abs: string;
  kind: "file" | "symlink" | "other";
  size: number;
}

const byName = (a: fs.Dirent, b: fs.Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function listFiles(root: string): Listed[] {
  const out: Listed[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (entry.isSymbolicLink()) out.push({ rel, abs, kind: "symlink", size: 0 });
      else if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push({ rel, abs, kind: "file", size: fs.statSync(abs).size });
      else out.push({ rel, abs, kind: "other", size: 0 });
    }
  };
  walk(root);
  return out;
}

/** Text hashes with LF line endings, so a CRLF checkout keeps the identity; binary bytes hash as they are. */
function fileHash(bytes: Buffer): string {
  const normalized = bytes.includes(0) ? bytes : Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/** Reads one file and reports the restricted markers it carries; null when it cannot be scanned (reported). */
function scanFile(f: Listed, push: Push): Buffer | null {
  if (f.kind !== "file") {
    push("UNSCANNABLE_FILE", { file: f.rel, detail: f.kind });
    return null;
  }
  if (f.size > MAX_SCAN_BYTES) {
    push("UNSCANNABLE_FILE", { file: f.rel, detail: `${f.size} bytes` });
    return null;
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(f.abs);
  } catch (error) {
    push("UNSCANNABLE_FILE", { file: f.rel, detail: (error as Error).message });
    return null;
  }
  // latin1 keeps every byte, so an ASCII marker is found in any ASCII-compatible encoding.
  for (const marker of restrictedMarkersIn(bytes.toString("latin1"))) push("RESTRICTED_MATERIAL", { file: f.rel, detail: marker.reason });
  return bytes;
}

const isString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function readRecord(file: string, push: Push): PackRecord | null {
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    push("PROVENANCE_INVALID", { file: PACK_RECORD_FILE, detail: (error as Error).message.split("\n")[0] ?? "" });
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || (doc as { schemaVersion?: unknown }).schemaVersion !== 1) {
    push("PROVENANCE_INVALID", { file: PACK_RECORD_FILE, detail: "an object with schemaVersion 1 is expected" });
    return null;
  }
  return doc as PackRecord;
}

function checkRecord(record: PackRecord, files: Set<string>, push: Push): void {
  const missing: string[] = [];
  if (!isString(record.id)) missing.push("id");
  if (!isString(record.kind)) missing.push("kind");
  if (!isString(record.source?.url)) missing.push("source.url");
  if (!isString(record.source?.revision)) missing.push("source.revision");
  if (!isString(record.spdx)) missing.push("spdx");
  if (!DISTRIBUTION_MODES.includes(record.distribution)) missing.push("distribution");
  if (!["approved", "candidate", "rejected"].includes(record.review)) missing.push("review");
  if (missing.length > 0) push("PROVENANCE_INCOMPLETE", { file: PACK_RECORD_FILE, detail: missing.join(", ") });

  if (isString(record.source?.url) && isRestrictedSource(record.source.url)) push("RESTRICTED_SOURCE", { detail: record.source.url });
  if (isString(record.spdx) && !spdxEligible(record.spdx)) push("LICENSE_NOT_ELIGIBLE", { detail: record.spdx });
  // A ShareAlike license is eligible only with its obligations recorded: what was modified, how attribution is given and
  // that the adaptations carry the same license.
  if (isString(record.spdx) && requiresShareAlike(record.spdx)) {
    const unmet: string[] = [];
    if (!isString(record.modifications)) unmet.push("modifications");
    if (!isString(record.obligations?.attribution)) unmet.push("obligations.attribution");
    if (!isString(record.obligations?.shareAlike)) unmet.push("obligations.shareAlike");
    if (unmet.length > 0) push("PROVENANCE_INCOMPLETE", { file: PACK_RECORD_FILE, detail: `${record.spdx} (ShareAlike) needs ${unmet.join(", ")}` });
  }
  for (const dep of Array.isArray(record.dependencies) ? record.dependencies : []) {
    const name = isString(dep?.name) ? dep.name : "?";
    if (!isString(dep?.spdx) || !spdxEligible(dep.spdx)) push("LICENSE_NOT_ELIGIBLE", { detail: `${name}: ${isString(dep?.spdx) ? dep.spdx : "no SPDX"}` });
    if (isString(dep?.sourceUrl) && isRestrictedSource(dep.sourceUrl)) push("RESTRICTED_SOURCE", { detail: `${name}: ${dep.sourceUrl}` });
  }

  const notices = Array.isArray(record.notices) ? record.notices.filter(isString) : [];
  if (notices.length === 0) push("NOTICE_MISSING", { detail: "notices" });
  for (const notice of notices) if (!files.has(notice.replace(/\\/g, "/"))) push("NOTICE_MISSING", { file: notice });

  if (DISTRIBUTION_MODES.includes(record.distribution) && record.distribution !== "shipped") push("NOT_SHIPPABLE", { detail: record.distribution });
  if (record.review === "candidate" || record.review === "rejected") push("REVIEW_PENDING", { detail: record.review });
}

/** Checks one pack folder. Never throws for the content of the folder: what cannot be read is a problem. */
export function checkPack(dir: string): PackReport {
  const abs = path.resolve(dir);
  const raw: Array<[DistributionProblemCode, ProblemExtra]> = [];
  const push: Push = (code, extra = {}) => raw.push([code, extra]);
  let listed: Listed[] = [];
  try {
    listed = listFiles(abs);
  } catch (error) {
    push("UNSCANNABLE_FILE", { file: ".", detail: (error as Error).message });
  }
  const hashes: string[] = [];
  for (const f of listed) {
    const bytes = scanFile(f, push);
    if (bytes && f.rel !== PACK_RECORD_FILE) hashes.push(`${f.rel}\0${fileHash(bytes)}\n`);
  }
  const identity = `sha256:${crypto.createHash("sha256").update(hashes.join("")).digest("hex")}`;
  const files = listed.filter((f) => f.kind === "file").map((f) => f.rel);
  const fileSet = new Set(files);

  let record: PackRecord | null = null;
  if (!fileSet.has(PACK_RECORD_FILE)) push("PROVENANCE_MISSING", { file: PACK_RECORD_FILE });
  else record = readRecord(path.join(abs, PACK_RECORD_FILE), push);
  if (record) {
    checkRecord(record, fileSet, push);
    if (isString(record.artifact?.sha256) && record.artifact.sha256 !== identity) push("ARTIFACT_MISMATCH", { detail: `${record.artifact.sha256} != ${identity}` });
  }
  const id = record && isString(record.id) ? record.id : path.basename(abs);
  const problems = raw.map(([code, extra]) => problem(code, id, extra));
  return { id, dir: abs, ok: problems.length === 0, identity, record, files, problems };
}

/**
 * Checks every pack under a shipping root: each subfolder is a pack; a loose file at the root is shippable content
 * without provenance.
 */
export function checkPackRoot(root: string): PackReport[] {
  const abs = path.resolve(root);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true }).sort(byName);
  } catch (error) {
    const name = path.basename(abs);
    return [{ id: name, dir: abs, ok: false, identity: null, record: null, files: [], problems: [problem("UNSCANNABLE_FILE", name, { file: ".", detail: (error as Error).message })] }];
  }
  return entries.map((entry) => {
    const child = path.join(abs, entry.name);
    if (entry.isDirectory()) return checkPack(child);
    const raw: Array<[DistributionProblemCode, ProblemExtra]> = [["PROVENANCE_MISSING", { file: entry.name }]];
    const kind = entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : "other";
    scanFile({ rel: entry.name, abs: child, kind, size: kind === "file" ? fs.statSync(child).size : 0 }, (code, extra = {}) => raw.push([code, extra]));
    const problems = raw.map(([code, extra]) => problem(code, entry.name, extra));
    return { id: entry.name, dir: child, ok: false, identity: null, record: null, files: [entry.name], problems };
  });
}
