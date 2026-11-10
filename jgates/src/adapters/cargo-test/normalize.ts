// Reads the stable libtest text output of `cargo test`: the `test <name> ... ok|FAILED|ignored` lines, the
// `---- <name> stdout ----` failure sections (panic location, message, the proptest minimal failing input) and the
// `test result:` summary of each test binary. Fail-closed: without a summary line nothing proves the tests ran.

export interface LibtestFailure {
  name: string;
  /** The panic message (first line), or an empty string when the section has none. */
  message: string;
  /** Path and line of the panic, as printed (relative to the crate or absolute). */
  file: string | null;
  line: number | null;
  column: number | null;
  /** proptest: the text after "minimal failing input:". */
  minimalInput: string | null;
}

export interface LibtestReport {
  ok: boolean;
  problem?: string;
  /** Name -> status of every test line, in order (the same name in two binaries keeps the worse status). */
  tests: Array<{ name: string; status: "ok" | "failed" | "ignored" }>;
  failures: LibtestFailure[];
  counts: { passed: number; failed: number; ignored: number };
  /** Number of `test result:` summary lines (one per test binary and doctest run). */
  summaries: number;
}

const TEST_LINE = /^test (.+?) \.\.\. (ok|FAILED|ignored|bench:.*)(?:, .*)?\s*$/;
const SUMMARY = /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/;
const HEADER = /^---- (.+) stdout ----\s*$/;
const PANIC = /panicked at (?:'.*', )?(.+?):(\d+):(\d+):?\s*$/;
const MINIMAL = /minimal failing input:[ \t]*(.*?)[ \t]*$/m;

export function parseLibtestOutput(stdout: string): LibtestReport {
  const lines = stdout.split(/\r?\n/);
  const tests: LibtestReport["tests"] = [];
  const counts = { passed: 0, failed: 0, ignored: 0 };
  let summaries = 0;
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header) {
      current = [];
      sections.set(header[1] as string, current);
      continue;
    }
    if (line === "failures:") {
      current = null;
      continue;
    }
    const summary = SUMMARY.exec(line);
    if (summary) {
      summaries++;
      counts.passed += Number(summary[2]);
      counts.failed += Number(summary[3]);
      counts.ignored += Number(summary[4]);
      current = null;
      continue;
    }
    const test = TEST_LINE.exec(line);
    if (test && !current) {
      const raw = test[2] as string;
      tests.push({ name: test[1] as string, status: raw === "ok" ? "ok" : raw === "FAILED" ? "failed" : "ignored" });
      continue;
    }
    if (current) current.push(line);
  }
  const failures: LibtestFailure[] = [];
  const failedNames = new Set(tests.filter((t) => t.status === "failed").map((t) => t.name));
  for (const name of failedNames) {
    const body = sections.get(name) ?? [];
    const joined = body.join("\n");
    let file: string | null = null;
    let lineNo: number | null = null;
    let column: number | null = null;
    let message = "";
    const at = body.findIndex((l) => PANIC.test(l));
    if (at !== -1) {
      const m = PANIC.exec(body[at] as string) as RegExpExecArray;
      file = m[1] as string;
      lineNo = Number(m[2]);
      column = Number(m[3]);
      message = (body.slice(at + 1).find((l) => l.trim() !== "") ?? "").trim();
    } else {
      message = (body.find((l) => l.trim() !== "") ?? "").trim();
    }
    const minimal = MINIMAL.exec(joined);
    failures.push({ name, message, file, line: lineNo, column, minimalInput: minimal ? (minimal[1] as string) : null });
  }
  if (summaries === 0) return { ok: false, problem: "no libtest summary line (test result: ...) in the output", tests, failures, counts, summaries };
  return { ok: true, tests, failures, counts, summaries };
}

/** The last path segment of a test name (`tests::prop_x` -> `prop_x`). */
export const lastSegment = (name: string): string => name.slice(name.lastIndexOf("::") + 2);

/** Line coverage of the JSON summary cargo llvm-cov writes (`--json --summary-only`: data[].totals.lines). */
export function parseLlvmCovSummary(text: string | null): { ok: true; covered: number; total: number } | { ok: false; problem: string } {
  if (text === null) return { ok: false, problem: "the cargo llvm-cov report was not written" };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, problem: `not JSON: ${(error as Error).message}` };
  }
  const data = typeof doc === "object" && doc !== null && Array.isArray((doc as { data?: unknown }).data) ? ((doc as { data: unknown[] }).data as Array<{ totals?: { lines?: { count?: unknown; covered?: unknown } } }>) : null;
  if (!data || data.length === 0) return { ok: false, problem: "no data in the llvm-cov export" };
  let covered = 0;
  let total = 0;
  for (const d of data) {
    const lines = d.totals?.lines;
    if (typeof lines?.count !== "number" || typeof lines.covered !== "number") return { ok: false, problem: "no totals.lines in the llvm-cov export" };
    covered += lines.covered;
    total += lines.count;
  }
  return { ok: true, covered, total };
}
