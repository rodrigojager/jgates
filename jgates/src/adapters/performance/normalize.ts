// Reads what each benchmark harness writes into one list of benchmarks with their mean time in milliseconds: the JSON
// of pytest-benchmark (--benchmark-json), of vitest bench (--outputJson) and of BenchmarkDotNet (the JSON exporter), the
// text of go test -bench and of criterion (--output-format bencher). Pure functions over the texts. A document that is
// not the harness's report is "not interpreted", never an empty list.
import { isRec, type Rec } from "../playwright/kit.js";

export interface Benchmark {
  name: string;
  /** Mean time of one iteration, in milliseconds. */
  meanMs: number;
}

export interface BenchReading {
  ok: boolean;
  problem?: string;
  benchmarks: Benchmark[];
}

const bad = (problem: string): BenchReading => ({ ok: false, problem, benchmarks: [] });
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

function json(text: string | null, what: string): Rec | BenchReading {
  if (text === null) return bad(`the ${what} report was not written`);
  try {
    const doc = JSON.parse(text) as unknown;
    return isRec(doc) ? doc : bad(`the ${what} report is not a JSON object`);
  } catch {
    return bad(`the ${what} report is not JSON`);
  }
}

/** pytest-benchmark --benchmark-json: benchmarks[].fullname with stats.mean in seconds. */
export function parsePytestBenchmark(text: string | null): BenchReading {
  const doc = json(text, "pytest-benchmark");
  if ("ok" in doc) return doc as BenchReading;
  if (!Array.isArray(doc.benchmarks)) return bad("not a pytest-benchmark report (no benchmarks)");
  const out: Benchmark[] = [];
  for (const b of doc.benchmarks) {
    if (!isRec(b) || !isRec(b.stats)) return bad("a benchmark without stats");
    const mean = num(b.stats.mean);
    const name = typeof b.fullname === "string" ? b.fullname : typeof b.name === "string" ? b.name : null;
    if (mean === null || name === null) return bad("a benchmark without a name or a mean");
    out.push({ name, meanMs: mean * 1000 });
  }
  return { ok: true, benchmarks: out };
}

/**
 * vitest bench: Vitest 4+ writes the JSON reporter's document, whose tests carry `benchmarks[].tasks[]` with
 * latency.mean in milliseconds (named "<test> > <bench>"); Vitest 1-3 wrote --outputJson's files[].groups[].benchmarks[]
 * with mean in milliseconds (named "<group> > <bench>"). A benchmark test that failed is not a measurement.
 */
export function parseVitestBench(text: string | null): BenchReading {
  const doc = json(text, "vitest bench");
  if ("ok" in doc) return doc as BenchReading;
  if (Array.isArray(doc.testResults)) {
    const out: Benchmark[] = [];
    for (const file of doc.testResults) {
      if (!isRec(file)) return bad("a test file that is not an object");
      if (file.status === "failed" && (!Array.isArray(file.assertionResults) || file.assertionResults.length === 0)) return bad(`the benchmark file ${String(file.name ?? "?")} failed: ${String(file.message ?? "")}`.trim());
      for (const test of Array.isArray(file.assertionResults) ? file.assertionResults : []) {
        if (!isRec(test)) continue;
        if (test.status === "failed") return bad(`the benchmark ${String(test.fullName ?? "?")} failed`);
        for (const group of Array.isArray(test.benchmarks) ? test.benchmarks : []) {
          if (!isRec(group) || !Array.isArray(group.tasks)) return bad("a benchmark without tasks");
          for (const task of group.tasks) {
            const mean = isRec(task) && isRec(task.latency) ? num(task.latency.mean) : null;
            if (!isRec(task) || mean === null || typeof task.name !== "string") return bad("a benchmark task without a name or a mean latency");
            out.push({ name: `${typeof test.fullName === "string" ? test.fullName : ""} > ${task.name}`.replace(/^ > /, ""), meanMs: mean });
          }
        }
      }
    }
    return { ok: true, benchmarks: out };
  }
  if (!Array.isArray(doc.files)) return bad("not a vitest bench report (no testResults, no files)");
  const out: Benchmark[] = [];
  for (const file of doc.files) {
    if (!isRec(file) || !Array.isArray(file.groups)) return bad("a file without groups");
    for (const group of file.groups) {
      if (!isRec(group) || !Array.isArray(group.benchmarks)) return bad("a group without benchmarks");
      for (const b of group.benchmarks) {
        const mean = isRec(b) ? num(b.mean) : null;
        if (!isRec(b) || mean === null || typeof b.name !== "string") return bad("a benchmark without a name or a mean");
        out.push({ name: `${typeof group.fullName === "string" ? group.fullName : ""} > ${b.name}`.replace(/^ > /, ""), meanMs: mean });
      }
    }
  }
  return { ok: true, benchmarks: out };
}

/** go test -bench text: `BenchmarkX-2   1000   1234 ns/op`, named "<package>/<BenchmarkX>" (the GOMAXPROCS suffix dropped). */
export function parseGoBench(text: string): BenchReading {
  const out: Benchmark[] = [];
  let pkg = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const p = /^pkg:\s+(\S+)/.exec(line);
    if (p) {
      pkg = p[1] as string;
      continue;
    }
    const m = /^(Benchmark\S+?)(?:-\d+)?\s+\d+\s+([\d.]+)\s+ns\/op\b/.exec(line);
    if (m) out.push({ name: pkg ? `${pkg}/${m[1]}` : (m[1] as string), meanMs: Number(m[2]) / 1e6 });
  }
  if (out.length === 0 && !/^(?:ok|PASS)\b/m.test(text)) return bad("no benchmark line and no PASS in the go test output");
  return { ok: true, benchmarks: out };
}

/** criterion --output-format bencher: `test name ... bench:  26,123 ns/iter (+/- 1,234)`. */
export function parseBencher(text: string): BenchReading {
  const out: Benchmark[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^test\s+(.+?)\s+\.\.\.\s+bench:\s+([\d,.]+)\s+ns\/iter/.exec(raw.trim());
    if (m) out.push({ name: m[1] as string, meanMs: Number((m[2] as string).replace(/,/g, "")) / 1e6 });
  }
  return { ok: true, benchmarks: out };
}

/** BenchmarkDotNet JSON exporter: Benchmarks[].FullName with Statistics.Mean in nanoseconds (one report per type). */
export function parseBenchmarkDotNet(texts: string[]): BenchReading {
  if (texts.length === 0) return bad("BenchmarkDotNet wrote no JSON report");
  const out: Benchmark[] = [];
  for (const text of texts) {
    const doc = json(text, "BenchmarkDotNet");
    if ("ok" in doc) return doc as BenchReading;
    if (!Array.isArray(doc.Benchmarks)) return bad("not a BenchmarkDotNet report (no Benchmarks)");
    for (const b of doc.Benchmarks) {
      if (!isRec(b)) return bad("a benchmark that is not an object");
      const mean = isRec(b.Statistics) ? num(b.Statistics.Mean) : null;
      const name = typeof b.FullName === "string" ? b.FullName : null;
      // A benchmark that did not run (failed build or exception) has no statistics: the report proves nothing about it.
      if (name === null || mean === null) return bad(`the benchmark ${name ?? "?"} has no statistics (it did not run)`);
      out.push({ name, meanMs: mean / 1e6 });
    }
  }
  return { ok: true, benchmarks: out };
}

export interface BudgetCheck {
  kind: "budget" | "regression" | "unmatched";
  name: string;
  meanMs: number | null;
  limitMs: number;
  /** The budget pattern or the baseline value it was compared with. */
  rule: string;
}

/** `*` in a budget name matches any run of characters. */
export function matchesName(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  return new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name);
}

/**
 * The budget breaches (mean over the budget), the regressions (mean over the baseline by more than the allowed percent)
 * and the budgets that match no benchmark that ran (a budget nothing verified is not a pass).
 */
export function compareBenchmarks(benchmarks: Benchmark[], budgets: Record<string, number>, baseline: Record<string, number> | null, maxRegressionPercent: number): BudgetCheck[] {
  const out: BudgetCheck[] = [];
  for (const [pattern, limit] of Object.entries(budgets)) {
    const hits = benchmarks.filter((b) => matchesName(pattern, b.name));
    if (hits.length === 0) out.push({ kind: "unmatched", name: pattern, meanMs: null, limitMs: limit, rule: pattern });
    for (const b of hits) if (b.meanMs > limit) out.push({ kind: "budget", name: b.name, meanMs: b.meanMs, limitMs: limit, rule: pattern });
  }
  if (baseline) {
    for (const b of benchmarks) {
      const before = baseline[b.name];
      if (typeof before !== "number" || before <= 0) continue;
      const limit = before * (1 + maxRegressionPercent / 100);
      if (b.meanMs > limit) out.push({ kind: "regression", name: b.name, meanMs: b.meanMs, limitMs: limit, rule: String(before) });
    }
  }
  return out;
}
