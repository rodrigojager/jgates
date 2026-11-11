// Reads what the e2e runners write: the JSON report of Playwright Test (--reporter=json, PLAYWRIGHT_JSON_OUTPUT_NAME) and
// the JUnit XML of pytest with pytest-playwright (--junitxml). Pure functions over the texts: no process, no file access
// except the module lookup of a pytest classname. A document that is not a report is "not interpreted", never an empty
// list of tests.
import path from "node:path";
import { caseFile, parseJunit } from "../pytest/junit.js";
import { firstLine, isRec, type Rec } from "./kit.js";

export interface E2eCase {
  name: string;
  /** Workspace-relative POSIX path of the test file, or null. */
  file: string | null;
  line: number | null;
  status: "passed" | "failed" | "skipped" | "flaky";
  message: string;
  /** An error outside any test (configuration, global setup, a file that did not load). */
  suite?: boolean;
}

export interface E2eReading {
  ok: boolean;
  problem?: string;
  cases: E2eCase[];
}

const posix = (p: string): string => p.replace(/\\/g, "/");

/**
 * The tests of a Playwright Test JSON report. `place` maps an absolute path as the runner printed it to the
 * workspace-relative path (null outside the workspace); spec files are relative to the report's config.rootDir.
 */
export function parsePlaywrightReport(text: string | null, place: (absolute: string) => string | null): E2eReading {
  if (text === null) return { ok: false, problem: "the Playwright JSON report was not written", cases: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, problem: "the Playwright JSON report is not JSON", cases: [] };
  }
  if (!isRec(doc) || !Array.isArray(doc.suites) || !isRec(doc.stats)) return { ok: false, problem: "not a Playwright JSON report (no suites / stats)", cases: [] };
  const config = isRec(doc.config) ? doc.config : {};
  const rootDir = typeof config.rootDir === "string" ? posix(config.rootDir) : "";
  const fileOf = (rel: unknown): string | null => {
    if (typeof rel !== "string" || rel === "") return null;
    const abs = rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel) ? posix(rel) : path.posix.join(rootDir, posix(rel));
    return place(abs);
  };
  const cases: E2eCase[] = [];
  const walk = (suite: Rec, titles: string[]): void => {
    const here = typeof suite.title === "string" && suite.title !== "" && suite.title !== suite.file ? [...titles, suite.title] : titles;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isRec(spec)) continue;
      for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
        if (!isRec(test)) continue;
        const results = Array.isArray(test.results) ? test.results.filter(isRec) : [];
        const outcome = typeof test.status === "string" ? test.status : "";
        const status: E2eCase["status"] = outcome === "expected" ? "passed" : outcome === "flaky" ? "flaky" : outcome === "skipped" ? "skipped" : "failed";
        const failing = [...results].reverse().find((r) => isRec(r.error) || (Array.isArray(r.errors) && r.errors.length > 0));
        const error = failing ? (isRec(failing.error) ? failing.error : (failing.errors as unknown[]).find(isRec)) : undefined;
        const location = isRec(failing?.errorLocation) ? failing.errorLocation : isRec(error?.location) ? error.location : null;
        const project = typeof test.projectName === "string" && test.projectName !== "" ? `[${test.projectName}] ` : "";
        cases.push({
          name: `${project}${[...here, typeof spec.title === "string" ? spec.title : "(untitled)"].join(" › ")}`,
          file: location && typeof location.file === "string" ? place(posix(location.file)) : fileOf(spec.file ?? suite.file),
          line: location && typeof location.line === "number" ? location.line : typeof spec.line === "number" ? spec.line : null,
          status,
          message: status === "failed" ? firstLine(typeof error?.message === "string" ? error.message : outcome || "failed") : "",
        });
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) if (isRec(child)) walk(child, here);
  };
  for (const suite of doc.suites) if (isRec(suite)) walk(suite, []);
  for (const error of Array.isArray(doc.errors) ? doc.errors : []) {
    if (!isRec(error)) continue;
    const location = isRec(error.location) ? error.location : null;
    cases.push({
      name: "(outside the tests)",
      file: location && typeof location.file === "string" ? place(posix(location.file)) : null,
      line: location && typeof location.line === "number" ? location.line : null,
      status: "failed",
      message: firstLine(typeof error.message === "string" ? error.message : "error"),
      suite: true,
    });
  }
  return { ok: true, cases };
}

/** The tests of pytest's JUnit XML; classnames are mapped to the test modules of the working folder. */
export function parsePytestJunit(text: string | null, cwd: string, workspace: string): E2eReading {
  if (text === null) return { ok: false, problem: "the JUnit report was not written", cases: [] };
  const report = parseJunit(text);
  if (!report.ok) return { ok: false, problem: report.problem ?? "unreadable JUnit report", cases: [] };
  return {
    ok: true,
    cases: report.cases.map((c) => ({
      name: c.classname ? `${c.classname}::${c.name}` : c.name,
      file: caseFile(c.classname, cwd, workspace),
      line: null,
      status: c.outcome === "passed" ? "passed" : c.outcome === "skipped" ? "skipped" : "failed",
      message: c.outcome === "failed" || c.outcome === "error" ? c.message : "",
      ...(c.outcome === "error" && c.classname === "" ? { suite: true } : {}),
    })),
  };
}
