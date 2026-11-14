// Anchor of a finding (jga1): the identity a waiver made from one finding points at. The fingerprint v1 never changes
// (baselines and SARIF keep matching); the anchor is a second value, for waivers only. It hashes the tool, the rule, the
// normalized path, the text of the flagged line with its white space collapsed, and the position of the finding among
// the findings of the same tool, rule and file whose line has that same text. So it survives lines inserted above and
// other findings of the rule fixed or added in the file, and it changes when the flagged line itself changes. The line is
// read from the tree that was analyzed and only the hash is kept. Findings without a line, in a file that cannot be read,
// or of the secrets and personal-data categories (the line is the sensitive value) get no anchor.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ResultFinding } from "../run/types.js";
import { normalizeFindingPath } from "./fingerprint.js";

export const ANCHOR_VERSION = 1;
export const ANCHOR_PREFIX = "jga1:";

/** Categories whose flagged line is the sensitive value itself: identified by the fingerprint v1 plus a count guard. */
export const UNANCHORED_CATEGORIES: ReadonlySet<string> = new Set(["secrets", "secret", "pii", "personal-data"]);

/** A file larger than this is not read for anchors (its findings keep the fingerprint only). */
const MAX_ANCHOR_FILE_BYTES = 8 * 1024 * 1024;

/** The text of one line of a file of the analyzed tree, or null when it cannot be read. */
export type LineOf = (findingPath: string, line: number) => string | null;

export function collapseWhiteSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function anchorOf(input: { tool: string; ruleId: string; path: string; lineText: string; position: number }): string {
  const body = JSON.stringify([ANCHOR_VERSION, input.tool, input.ruleId, normalizeFindingPath(input.path), collapseWhiteSpace(input.lineText), input.position]);
  return ANCHOR_PREFIX + crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 32);
}

/** Whether a finding may carry an anchor at all (never for a secret or personal data). */
export function anchorable(finding: ResultFinding): boolean {
  if (finding.category && UNANCHORED_CATEGORIES.has(finding.category.toLowerCase())) return false;
  const line = finding.location?.line;
  return typeof finding.location?.path === "string" && finding.location.path !== "" && typeof line === "number" && Number.isInteger(line) && line >= 1;
}

/**
 * Reads lines of the analyzed tree, caching each file. A path that leaves the root, a missing or oversized file and a
 * line past the end give null. Paths of a container mount (/workspace/...) are read from the root.
 */
export function createLineReader(root: string): LineOf & { prime: (findings: ResultFinding[]) => void } {
  const files = new Map<string, string[] | null>();
  const base = path.resolve(root);
  const fileOf = (findingPath: string): string | null => {
    let rel = findingPath.replace(/\\/g, "/");
    if (rel.startsWith("/workspace/")) rel = rel.slice("/workspace/".length);
    const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(base, rel);
    const inside = path.relative(base, abs);
    if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) return null;
    return abs;
  };
  const linesOf = (findingPath: string): string[] | null => {
    const key = normalizeFindingPath(findingPath);
    if (files.has(key)) return files.get(key) ?? null;
    let lines: string[] | null = null;
    const file = fileOf(findingPath);
    if (file) {
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.size <= MAX_ANCHOR_FILE_BYTES) lines = fs.readFileSync(file, "utf8").split(/\r\n|\n|\r/);
      } catch {
        lines = null;
      }
    }
    files.set(key, lines);
    return lines;
  };
  const reader = ((findingPath: string, line: number): string | null => {
    const lines = linesOf(findingPath);
    if (!lines || line < 1 || line > lines.length) return null;
    return lines[line - 1] ?? null;
  }) as LineOf & { prime: (findings: ResultFinding[]) => void };
  // Reads every file the findings name now (before a snapshot of the analyzed commit is removed).
  reader.prime = (findings) => {
    for (const f of findings) if (anchorable(f)) linesOf(f.location!.path);
  };
  return reader;
}

/** Gives every anchorable finding whose line can be read its jga1 anchor; the others are returned without one. */
export function assignAnchors(findings: ResultFinding[], lineOf: LineOf | undefined): ResultFinding[] {
  if (!lineOf) return findings;
  const texts = findings.map((f) => (anchorable(f) ? lineOf(f.location!.path, f.location!.line!) : null));
  const groups = new Map<string, number[]>();
  findings.forEach((f, index) => {
    const text = texts[index];
    if (text === null || text === undefined) return;
    const key = JSON.stringify([f.tool, f.ruleId, normalizeFindingPath(f.location!.path), collapseWhiteSpace(text)]);
    const list = groups.get(key);
    if (list) list.push(index);
    else groups.set(key, [index]);
  });
  const out = findings.map((f) => {
    if (f.anchor === undefined) return f;
    const { anchor: _drop, ...rest } = f;
    return rest as ResultFinding;
  });
  for (const indexes of groups.values()) {
    const ordered = [...indexes].sort(
      (a, b) =>
        (findings[a]!.location?.line ?? 0) - (findings[b]!.location?.line ?? 0) ||
        (findings[a]!.location?.column ?? 0) - (findings[b]!.location?.column ?? 0) ||
        a - b,
    );
    ordered.forEach((index, position) => {
      const f = findings[index]!;
      out[index] = { ...out[index]!, anchor: anchorOf({ tool: f.tool, ruleId: f.ruleId, path: f.location!.path, lineText: texts[index]!, position }) };
    });
  }
  return out;
}
