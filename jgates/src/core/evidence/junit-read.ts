// Shared JUnit XML reader (pytest xunit2, Playwright, and any tool a user registers). Fail-closed: a document that is
// not a JUnit report is "not ok", never an empty list of tests.
import fs from "node:fs";
import path from "node:path";
import { attributes, tags, textBetween } from "./xml.js";

export interface JunitCase {
  /** Dotted module path plus class, as the runner writes it. */
  classname: string;
  name: string;
  outcome: "passed" | "failed" | "error" | "skipped";
  /** First line of the failure message, bounded. */
  message: string;
  /** Failure text (body of the failure or error element), bounded; empty for passing cases. */
  text: string;
  /** Source file when the report says one (`file` attribute of the test case). */
  file?: string;
  line?: number;
  durationSeconds?: number;
}

export interface JunitReport {
  ok: boolean;
  problem?: string;
  total: number;
  failed: number;
  errors: number;
  skipped: number;
  cases: JunitCase[];
}

const MAX_MESSAGE = 240;
const MAX_TEXT = 2000;

const firstLine = (text: string): string => {
  const line = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
  return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line;
};
const positive = (v: string | undefined): number | undefined => {
  const n = v === undefined ? Number.NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const RANK = { passed: 0, skipped: 1, failed: 2, error: 3 } as const;

/** Parses the report. Counts come from the test cases themselves, so the totals always add up. */
export function readJunit(xml: string): JunitReport {
  const empty = { total: 0, failed: 0, errors: 0, skipped: 0, cases: [] as JunitCase[] };
  if (!/<testsuites?[\s/>]/.test(xml)) return { ok: false, problem: "no <testsuite> element", ...empty };
  const cases: JunitCase[] = [];
  let current: JunitCase | null = null;
  let open: { name: string; from: number; outcome: JunitCase["outcome"] } | null = null;
  const suiteFile: string[] = [];
  for (const tag of tags(xml)) {
    const attrs = () => attributes(tag.attrs);
    if (tag.name === "testsuite") {
      if (!tag.closing && !tag.selfClosing) suiteFile.push(attrs().file ?? "");
      else if (tag.closing) suiteFile.pop();
      continue;
    }
    if (tag.name === "testcase") {
      if (tag.closing) {
        if (current) cases.push(current);
        current = null;
        open = null;
        continue;
      }
      if (current) cases.push(current);
      const a = attrs();
      const line = positive(a.line);
      const file = a.file ?? (suiteFile[suiteFile.length - 1] || undefined);
      const duration = positive(a.time);
      current = { classname: a.classname ?? "", name: a.name ?? "", outcome: "passed", message: "", text: "", ...(file ? { file } : {}), ...(line !== undefined ? { line: Math.trunc(line) } : {}), ...(duration !== undefined ? { durationSeconds: duration } : {}) };
      open = null;
      if (tag.selfClosing) {
        cases.push(current);
        current = null;
      }
      continue;
    }
    if (!current) continue;
    if (tag.name === "failure" || tag.name === "error" || tag.name === "skipped") {
      if (tag.closing) {
        if (open && open.name === tag.name) {
          const body = textBetween(xml, open.from, tag.start).trim();
          if (body !== "" && current.outcome === open.outcome && current.text === "") {
            current.text = body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT - 1)}…` : body;
            if (current.message === "") current.message = firstLine(body);
          }
          open = null;
        }
        continue;
      }
      const a = attrs();
      const outcome = tag.name === "failure" ? "failed" : tag.name === "error" ? "error" : "skipped";
      // A failure in the call plus an error in the teardown: the worse one stays.
      if (RANK[outcome] >= RANK[current.outcome]) {
        current.outcome = outcome;
        current.message = firstLine(a.message ?? "");
        current.text = "";
        open = tag.selfClosing ? null : { name: tag.name, from: tag.end, outcome };
      } else open = null;
    }
  }
  if (current) cases.push(current);
  return {
    ok: true,
    total: cases.length,
    failed: cases.filter((c) => c.outcome === "failed").length,
    errors: cases.filter((c) => c.outcome === "error").length,
    skipped: cases.filter((c) => c.outcome === "skipped").length,
    cases,
  };
}

/** The workspace-relative file a JUnit classname points to, when it exists (module path, longest match first). */
export function caseFile(classname: string, cwd: string, workspace: string): string | null {
  const parts = classname.split(".").filter(Boolean);
  for (let n = parts.length; n >= 1; n--) {
    const candidate = path.join(cwd, ...parts.slice(0, n)) + ".py";
    try {
      if (fs.statSync(candidate).isFile()) return path.relative(workspace, candidate).split(path.sep).join("/");
    } catch {
      // try a shorter prefix
    }
  }
  return null;
}
