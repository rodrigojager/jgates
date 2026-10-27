// Suppressions written in the analyzed code, found by jgates ci. Where the tool lets the gate turn them off (ESLint
// --no-inline-config, Ruff --ignore-noqa, Semgrep --disable-nosem, Gitleaks --ignore-gitleaks-allow) the run does,
// and each comment is reported as an informational finding: the result shows that the project tried. Where the tool
// keeps honoring them (a ShellCheck directive, a jscpd ignore block), the comment may hide a finding, so it is a
// blocking finding of the policy: only a waiver of the policy accepts it. A stage that is already self-reported (the
// C# linters, which run MSBuild) gets the comment as information only.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { translator } from "../../i18n/index.js";
import type { ResultFinding } from "../run/types.js";

export const SUPPRESSIONS_STAGE = "jgates-ci.suppressions";
export const SUPPRESSION_RULE_PREFIX = "suppression.";

export interface SuppressionKind {
  id: string;
  /** Tool that understands the comment (for the message). */
  tool: string;
  pattern: RegExp;
  /** Files where the comment means something (by name); absent: any text file. */
  files?: RegExp;
}

export const SUPPRESSION_KINDS: readonly SuppressionKind[] = [
  { id: "eslint", tool: "ESLint", pattern: /\beslint-disable(?:-next-line|-line)?\b|\/\*\s*eslint\s+[@\w][\w@/-]*\s*:/, files: /\.(?:[cm]?[jt]sx?|vue|svelte|html?)$/i },
  { id: "noqa", tool: "Ruff", pattern: /#\s*(?:noqa\b|ruff\s*:\s*noqa\b|flake8\s*:\s*noqa\b)/i, files: /\.pyi?$/i },
  { id: "nosem", tool: "Semgrep", pattern: /\bnosem(?:grep)?\b/ },
  { id: "gitleaks", tool: "Gitleaks", pattern: /\bgitleaks:allow\b/ },
  { id: "trivy", tool: "Trivy", pattern: /\btrivy:ignore\b/ },
  { id: "checkov", tool: "Checkov", pattern: /\bcheckov:skip=/ },
  { id: "jscpd", tool: "jscpd", pattern: /\bjscpd:ignore-(?:start|end)\b/ },
  { id: "shellcheck", tool: "ShellCheck", pattern: /#\s*shellcheck\s+disable=/ },
  { id: "csharp", tool: "C# analyzers", pattern: /#pragma\s+warning\s+disable\b|\bSuppressMessage(?:Attribute)?\s*\(/, files: /\.(?:cs|vb|fs|csx)$/i },
];

/** What jgates ci does with one kind of comment in this run. */
export type SuppressionStatus =
  /** The tool runs with the flag that ignores the comment, or reports what it suppressed. */
  | { state: "neutralized"; how: string }
  /** A stage of this run still honors it. blocking: the stage is trusted (a self-reported stage proves nothing anyway). */
  | { state: "honored"; by: string; blocking: boolean }
  /** No stage of this run reads it. */
  | { state: "unused" };

export interface SuppressionHit {
  kind: string;
  path: string;
  line: number;
  status: SuppressionStatus;
}

export interface TreeListing {
  /** Paths relative to the root, forward slashes, sorted. */
  files: string[];
  /** The walk stopped at the file limit: what was not listed was not checked. */
  truncated: boolean;
}

const SKIPPED_DIRS = new Set([".git"]);
export const MAX_LISTED_FILES = 200_000;
export const MAX_SCANNED_BYTES = 8 * 1024 * 1024;

/** Every regular file under `root` (symlinks are not followed), bounded by MAX_LISTED_FILES. */
export function listTree(root: string, limit: number = MAX_LISTED_FILES): TreeListing {
  const files: string[] = [];
  let truncated = false;
  const walk = (dir: string, rel: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) walk(path.join(dir, e.name), childRel);
      } else if (e.isFile()) {
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        files.push(childRel);
      }
    }
  };
  walk(root, "");
  return { files, truncated };
}

/** Text of a file, or null for a binary, unreadable or too large one. */
function readText(abs: string): string | null {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_SCANNED_BYTES) return null;
    const bytes = fs.readFileSync(abs);
    if (bytes.subarray(0, 8192).includes(0)) return null;
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

/** Every suppression comment of the listed files, with what this run does with it. */
export function findSuppressions(root: string, files: string[], statusOf: (kind: string) => SuppressionStatus): { hits: SuppressionHit[]; skipped: string[] } {
  const hits: SuppressionHit[] = [];
  const skipped: string[] = [];
  for (const rel of files) {
    const kinds = SUPPRESSION_KINDS.filter((k) => !k.files || k.files.test(rel));
    if (kinds.length === 0) continue;
    const text = readText(path.join(root, ...rel.split("/")));
    if (text === null) {
      try {
        if (fs.statSync(path.join(root, ...rel.split("/"))).size > MAX_SCANNED_BYTES) skipped.push(rel);
      } catch {
        // gone: nothing to report
      }
      continue;
    }
    if (!kinds.some((k) => k.pattern.test(text))) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const kind of kinds) if (kind.pattern.test(line)) hits.push({ kind: kind.id, path: rel, line: index + 1, status: statusOf(kind.id) });
    });
  }
  return { hits, skipped };
}

/** The finding of one comment, in the vocabulary of result.json. */
export function suppressionFinding(hit: SuppressionHit): ResultFinding {
  const t = translator("governed");
  const kind = SUPPRESSION_KINDS.find((k) => k.id === hit.kind);
  const tool = kind?.tool ?? hit.kind;
  const blocking = hit.status.state === "honored" && hit.status.blocking;
  const message =
    hit.status.state === "neutralized"
      ? t("governed_suppression_neutralized", { tool, how: hit.status.how })
      : hit.status.state === "honored"
        ? t(hit.status.blocking ? "governed_suppression_honored" : "governed_suppression_honored_untrusted", { tool, by: hit.status.by })
        : t("governed_suppression_unused", { tool });
  const ruleId = `${SUPPRESSION_RULE_PREFIX}${hit.kind}`;
  return {
    stageId: SUPPRESSIONS_STAGE,
    tool: "jgates",
    ruleId,
    category: "policy",
    severity: blocking ? "high" : "info",
    normalizedSeverity: blocking ? "high" : "info",
    message,
    location: { path: hit.path, line: hit.line },
    fingerprint: "sha256:" + crypto.createHash("sha256").update(JSON.stringify(["jgates", ruleId, hit.path, hit.line])).digest("hex"),
    origin: "jgates-ci",
    blocking,
    ...(blocking ? { blockingReason: "blocking-tool" as const } : {}),
    waived: false,
  };
}
