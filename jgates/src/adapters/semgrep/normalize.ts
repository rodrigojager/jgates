// Normalizes the JSON of `semgrep scan --json` into result findings. Fail-closed: an entry that cannot be read, or a
// scanner error that is not a mere partial parse, makes the whole output uninterpreted.
import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../../core/ids/index.js";
import type { NormalizedSeverity, ResultFinding } from "../../core/run/types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export interface SemgrepParse {
  ok: boolean;
  findings: ResultFinding[];
  /** Non-fatal scanner notices (a target file that did not parse, for instance). */
  warnings: string[];
  /** The paths the scanner says it scanned (`paths.scanned`), as it printed them; null when the output has no such list. */
  scanned?: string[] | null;
  /** Why the output could not be interpreted. */
  problem?: string;
}

const SEVERITY: Record<string, { normalized: NormalizedSeverity; blocking: boolean }> = {
  CRITICAL: { normalized: "critical", blocking: true },
  HIGH: { normalized: "high", blocking: true },
  ERROR: { normalized: "high", blocking: true },
  MEDIUM: { normalized: "medium", blocking: true },
  WARNING: { normalized: "medium", blocking: true },
  LOW: { normalized: "low", blocking: false },
  INFO: { normalized: "low", blocking: false },
  INVENTORY: { normalized: "info", blocking: false },
  EXPERIMENT: { normalized: "info", blocking: false },
};

function relativeTo(roots: string[], cwd: string, filename: string): string {
  const abs = path.isAbsolute(filename) ? filename : path.resolve(cwd, filename);
  for (const root of roots) {
    const rel = path.relative(root, abs);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  }
  return filename.split(path.sep).join("/");
}

/**
 * The requirement ids of a finding of a rule of the bundled pack: Semgrep prefixes the id with the folders of the rule
 * file, so a rule matches by its full id or by the id after a dot. A rule outside the pack gets nothing.
 */
function packRequirementsOf(ruleId: string, packRules: ReadonlyMap<string, readonly string[]> | undefined): string[] | undefined {
  if (!packRules) return undefined;
  const direct = packRules.get(ruleId);
  if (direct) return direct.length > 0 ? [...direct] : undefined;
  for (let at = ruleId.indexOf("."); at >= 0; at = ruleId.indexOf(".", at + 1)) {
    const own = packRules.get(ruleId.slice(at + 1));
    if (own) return own.length > 0 ? [...own] : undefined;
  }
  return undefined;
}

export function parseSemgrepOutput(
  text: string,
  opts: {
    stageId: string;
    version: string | null;
    workspace: string;
    cwd: string;
    /** The rules of the bundled pack in the run (rule id to the requirement ids it was written for); absent without the pack. */
    packRules?: ReadonlyMap<string, readonly string[]>;
  },
): SemgrepParse {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, findings: [], warnings: [], problem: error instanceof Error ? error.message : String(error) };
  }
  if (!isRec(doc) || !Array.isArray(doc.results)) return { ok: false, findings: [], warnings: [], problem: "the document has no results list" };
  const warnings: string[] = [];
  if (Array.isArray(doc.errors)) {
    for (const [index, e] of doc.errors.entries()) {
      if (!isRec(e)) return { ok: false, findings: [], warnings, problem: `error ${index} is not an object` };
      const level = String(e.level ?? "error").toLowerCase();
      const message = String(e.message ?? e.type ?? "error");
      // A target file Semgrep could not parse is a warning (the rest was scanned); anything else proves nothing.
      if (level === "warn" || level === "warning") warnings.push(message);
      else return { ok: false, findings: [], warnings, problem: message };
    }
  }
  const roots = [opts.workspace];
  for (const r of [opts.workspace, opts.cwd]) {
    try {
      roots.push(fs.realpathSync(r));
    } catch {
      // keep the lexical root only
    }
  }
  const findings: ResultFinding[] = [];
  for (const [index, entry] of doc.results.entries()) {
    if (!isRec(entry) || typeof entry.check_id !== "string" || typeof entry.path !== "string" || !isRec(entry.extra) || typeof entry.extra.message !== "string") {
      return { ok: false, findings: [], warnings, problem: `result ${index} has no check_id, path or message` };
    }
    const start = isRec(entry.start) ? entry.start : {};
    const line = typeof start.line === "number" && start.line >= 1 ? start.line : undefined;
    const column = typeof start.col === "number" && start.col >= 1 ? start.col : undefined;
    const file = relativeTo(roots, opts.cwd, entry.path);
    const native = typeof entry.extra.severity === "string" ? entry.extra.severity.toUpperCase() : "WARNING";
    const level = SEVERITY[native] ?? { normalized: "medium" as const, blocking: true };
    const asvsRequirements = packRequirementsOf(entry.check_id, opts.packRules);
    findings.push({
      stageId: opts.stageId,
      tool: "semgrep",
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: entry.check_id,
      category: "sast",
      severity: native,
      normalizedSeverity: level.normalized,
      message: entry.extra.message,
      location: { path: file, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) },
      fingerprint: contentHash({ tool: "semgrep", rule: entry.check_id, file, line: line ?? null, column: column ?? null, message: entry.extra.message }),
      origin: "semgrep",
      blocking: level.blocking,
      ...(level.blocking ? { blockingReason: "blocking-tool" as const } : {}),
      // INFO is an informational finding (a policy of the standard, not a vulnerability): it never blocks.
      ...(native === "INFO" ? { informational: true } : {}),
      waived: false,
      ...(asvsRequirements ? { asvsRequirements } : {}),
    });
  }
  const paths = isRec(doc.paths) ? doc.paths : null;
  const scanned = paths && Array.isArray(paths.scanned) ? paths.scanned.filter((p): p is string => typeof p === "string") : null;
  return { ok: true, findings, warnings, scanned };
}

/** File extension (lower case, with the dot) to the language name the scanned-languages record uses. */
const SCANNED_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py": "python",
  ".go": "go",
  ".cs": "csharp",
  ".rs": "rust",
  ".java": "java",
  ".php": "php",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".rb": "ruby",
  ".swift": "swift",
  ".scala": "scala",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".lua": "lua",
  // The two kinds of file of the JGates pack that are not a programming language.
  ".html": "html",
  ".htm": "html",
};

/** Extensions of the configuration files the pack reads (web servers, PHP, Java properties). */
const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([".conf", ".properties", ".ini"]);

/** Whether a scanned path is a configuration file of the pack: by extension, by file name or by the framework's folder. */
export function isConfigFile(file: string): boolean {
  const unix = file.replace(/\\/g, "/");
  const base = (unix.split("/").pop() ?? "").toLowerCase();
  if (CONFIG_EXTENSIONS.has(path.extname(base))) return true;
  if (base === ".htaccess" || base === "web.config" || /^web\.[a-z0-9_-]+\.config$/.test(base)) return true;
  // Spring (application.yml, application-dev.yaml) and .NET (appsettings.json, appsettings.Production.json).
  if (/^application(-[a-z0-9_.-]+)?\.ya?ml$/.test(base) || /^appsettings(\.[a-z0-9_-]+)?\.json$/.test(base)) return true;
  // Symfony (config/packages, config/services, config/routes) and Laravel (config/<name>.php).
  if (/(^|\/)config\/(packages\/.+|services|routes|bundles)\.(ya?ml|xml|php)$/i.test(unix)) return true;
  return /(^|\/)config\/[^/]+\.php$/i.test(unix);
}

/**
 * How many files of each language the scan covered, from the scanner's own list of scanned paths. Every language in
 * `include` is present (0 when no file of it was scanned); any other language appears only when a file of it was scanned.
 */
export function scannedLanguageCounts(scanned: readonly string[], include: readonly string[] = []): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const language of include) counts[language] = 0;
  for (const file of scanned) {
    const language = SCANNED_LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()];
    if (language) counts[language] = (counts[language] ?? 0) + 1;
    // A configuration file is counted as such as well (a Laravel config/app.php is also a PHP file the PHP rules read).
    if (isConfigFile(file)) counts.config = (counts.config ?? 0) + 1;
  }
  return counts;
}
