// Reads what Vitest writes (the JSON reporter file and the coverage json-summary file) into tests, counts, failures
// and the line coverage with its numerator and denominator. Pure functions: no process, no file access.
import path from "node:path";

export interface VitestTestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface VitestFailure {
  /** Full name of the test (suite titles and title), or the file when the suite itself could not run. */
  name: string;
  /** Workspace-relative path with forward slashes, or null when it cannot be told. */
  file: string | null;
  line: number | null;
  column: number | null;
  /** First line of the failure message, bounded. */
  message: string;
  /** The suite failed to load (import error, syntax error) rather than an assertion failing. */
  suite: boolean;
}

export interface VitestReport {
  ok: boolean;
  problem?: string;
  success: boolean;
  counts: VitestTestCounts;
  failures: VitestFailure[];
}

export interface LineCoverage {
  covered: number;
  total: number;
}

const MAX_MESSAGE = 300;
const slash = (p: string): string => p.split(path.sep).join("/").split("\\").join("/");
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function relativeTo(workspace: string, file: string): string | null {
  if (!file) return null;
  const abs = path.isAbsolute(file) ? file : path.resolve(workspace, file);
  const rel = path.relative(workspace, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return slash(rel);
}

/** First meaningful line of a failure message (without ANSI colors), bounded. */
export function firstLine(message: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = message.replace(/\u001b\[[0-9;]*m/g, "");
  const line = plain.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const text = line.trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

/** `file:line:col` of the first stack entry inside the test file, when the failure message has one. */
function locate(messages: string[], absFile: string): { line: number | null; column: number | null } {
  const escaped = absFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}:(\\d+):(\\d+)`);
  for (const m of messages) {
    const hit = re.exec(m);
    if (hit) return { line: Number(hit[1]), column: Number(hit[2]) };
  }
  return { line: null, column: null };
}

/** Parses the JSON reporter file; `workspace` makes the file paths relative. Never throws. */
export function parseVitestReport(text: string, workspace: string): VitestReport {
  const empty: VitestReport = { ok: false, success: false, counts: { total: 0, passed: 0, failed: 0, skipped: 0 }, failures: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ...empty, problem: `not JSON: ${(error as Error).message}` };
  }
  if (!isRec(doc) || !Array.isArray(doc.testResults)) return { ...empty, problem: "no testResults list" };
  const failures: VitestFailure[] = [];
  const counts: VitestTestCounts = {
    total: num(doc.numTotalTests),
    passed: num(doc.numPassedTests),
    failed: num(doc.numFailedTests),
    skipped: num(doc.numPendingTests) + num(doc.numTodoTests),
  };
  for (const file of doc.testResults) {
    if (!isRec(file)) continue;
    const abs = typeof file.name === "string" ? file.name : "";
    const rel = relativeTo(workspace, abs);
    const results = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    let any = false;
    for (const t of results) {
      if (!isRec(t) || t.status !== "failed") continue;
      any = true;
      const messages = Array.isArray(t.failureMessages) ? t.failureMessages.filter((m): m is string => typeof m === "string") : [];
      const where = locate(messages, abs);
      failures.push({
        name: typeof t.fullName === "string" && t.fullName !== "" ? t.fullName : typeof t.title === "string" ? t.title : "(unnamed test)",
        file: rel,
        line: where.line,
        column: where.column,
        message: firstLine(messages[0] ?? ""),
        suite: false,
      });
    }
    // A file that failed without any failed test did not load: report the file, never swallow it.
    if (!any && file.status === "failed") {
      failures.push({
        name: rel ?? (abs || "(unknown file)"),
        file: rel,
        line: null,
        column: null,
        message: firstLine(typeof file.message === "string" ? file.message : ""),
        suite: true,
      });
    }
  }
  return { ok: true, success: doc.success === true, counts, failures };
}

/** The `lines` total of a coverage json-summary file. */
export function parseLineCoverage(text: string): { ok: true; lines: LineCoverage } | { ok: false; problem: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, problem: `not JSON: ${(error as Error).message}` };
  }
  const lines = isRec(doc) && isRec(doc.total) && isRec(doc.total.lines) ? doc.total.lines : null;
  if (!lines || typeof lines.total !== "number" || typeof lines.covered !== "number") return { ok: false, problem: "no total.lines in the summary" };
  return { ok: true, lines: { covered: lines.covered, total: lines.total } };
}

/** The coverage threshold complaint of Vitest in its error output, when it printed one. */
export function thresholdMessage(stderr: string): string | null {
  // eslint-disable-next-line no-control-regex
  const plain = stderr.replace(/\u001b\[[0-9;]*m/g, "");
  const line = plain.split(/\r?\n/).find((l) => /coverage for .*threshold/i.test(l));
  return line ? line.trim().slice(0, MAX_MESSAGE) : null;
}
