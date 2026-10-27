// Reads the JUnit XML pytest writes (--junitxml, junit_family=xunit2) into the tests that ran. Fail-closed: a document
// that is not a JUnit report is "not interpreted", never an empty list of tests.
import fs from "node:fs";
import path from "node:path";

export interface JunitCase {
  /** Dotted module path plus class, as pytest writes it. */
  classname: string;
  name: string;
  outcome: "passed" | "failed" | "error" | "skipped";
  /** First line of the failure message, bounded. */
  message: string;
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

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1] as string] = decode((m[3] ?? m[4]) as string);
  return out;
}

const firstLine = (text: string): string => {
  const line = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
  return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line;
};

/** Parses the report. Counts come from the test cases themselves, so the totals always add up. */
export function parseJunit(xml: string): JunitReport {
  const empty = { total: 0, failed: 0, errors: 0, skipped: 0, cases: [] as JunitCase[] };
  if (!/<testsuites?[\s>]/.test(xml)) return { ok: false, problem: "no <testsuite> element", ...empty };
  const cases: JunitCase[] = [];
  let current: { classname: string; name: string; outcome: JunitCase["outcome"]; message: string } | null = null;
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  for (const m of xml.matchAll(tag)) {
    const closing = m[1] === "/";
    const name = m[2] as string;
    const selfClosing = m[4] === "/";
    if (name === "testcase") {
      if (closing) {
        if (current) cases.push(current);
        current = null;
        continue;
      }
      if (current) cases.push(current);
      const a = attributes(m[3] as string);
      current = { classname: a.classname ?? "", name: a.name ?? "", outcome: "passed", message: "" };
      if (selfClosing) {
        cases.push(current);
        current = null;
      }
      continue;
    }
    if (!current || closing) continue;
    if (name === "failure" || name === "error" || name === "skipped") {
      const a = attributes(m[3] as string);
      const outcome = name === "failure" ? "failed" : name === "error" ? "error" : "skipped";
      // A failure in the call plus an error in the teardown: the worse one stays.
      const rank = { passed: 0, skipped: 1, failed: 2, error: 3 } as const;
      if (rank[outcome] >= rank[current.outcome]) {
        current.outcome = outcome;
        current.message = firstLine(a.message ?? "");
      }
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
