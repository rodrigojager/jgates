// jest adapter: the project's own Jest in the component, in the step container of the tools image (`jest` of the
// dependency volume's node_modules/.bin), with the JSON results file and, when coverage is selected, the json-summary
// coverage report in the run folder. The unit run leaves the integration selection out (--ignoreProjects or
// --testPathIgnorePatterns); the integration run selects only it (--selectProjects or the path pattern). See
// ../test-common for the shared plan and run.
import fs from "node:fs";
import path from "node:path";
import { jestPathRegex } from "../../core/selection/tests.js";
import { parseLineCoverage, parseVitestReport } from "../vitest/normalize.js";
import { scanProperties } from "../vitest/properties.js";
import { makeTestAdapter, readText, type TestCase, type TestRunnerSpec } from "../test-common/index.js";
import { jestManifest } from "./manifest.js";
import { probeJest } from "./probe.js";

export { jestManifest } from "./manifest.js";
export { declaredJest, probeJest } from "./probe.js";

const CONFIG_FILES = ["jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.ts", "jest.config.json", "package.json"];

/** The tests of Jest's --json results file (the same shape Vitest's JSON reporter writes). */
export function readJestResults(text: string | null, workspaceView: string): { ok: boolean; problem?: string; cases: TestCase[] } {
  if (text === null) return { ok: false, problem: "the Jest results file was not written", cases: [] };
  const report = parseVitestReport(text, workspaceView);
  if (!report.ok) return { ok: false, problem: report.problem ?? "unreadable Jest results", cases: [] };
  const cases: TestCase[] = report.tests.map((r) => {
    const failure = r.status === "failed" ? report.failures.find((f) => !f.suite && f.file === r.file && f.name.endsWith(r.title)) : undefined;
    const status: TestCase["status"] = r.status === "passed" ? "passed" : r.status === "failed" ? "failed" : "skipped";
    return { name: failure?.name ?? r.title, title: r.title, file: r.file, line: failure?.line ?? null, status, message: failure?.message ?? "" };
  });
  for (const f of report.failures.filter((x) => x.suite)) cases.push({ name: f.name, file: f.file, line: null, status: "failed", message: f.message, suite: true });
  return { ok: true, cases };
}

export const jestSpec: TestRunnerSpec = {
  manifest: jestManifest,
  tool: "Jest",
  stack: "node",
  imageTool: null,
  overrideEnv: "JGATES_JEST",
  framework: "fast-check",
  probe: (input, scanDir) => probeJest(input.env, input.dir, scanDir),
  prepare({ scanDir, mode, selection, detection, coverage, out }) {
    const project = selection.kind === "project" ? (selection.value as string) : null;
    const pattern = selection.kind === "pattern" ? jestPathRegex(selection.value as string) : null;
    const common = ["--ci", "--json", `--outputFile=${out}/jest.json`, "--testLocationInResults", "--no-cache", "--watchman=false"];
    const select =
      mode === "integration"
        ? project
          ? [`--selectProjects=${project}`]
          : [pattern as string]
        : !detection.present
          ? []
          : project
            ? [`--ignoreProjects=${project}`]
            : ["--testPathIgnorePatterns=/node_modules/", `--testPathIgnorePatterns=${pattern as string}`];
    const cov = coverage ? ["--coverage", "--coverageReporters=json-summary", `--coverageDirectory=${out}/coverage`] : [];
    return {
      // The positional pattern of the integration run comes last, after every option.
      args: mode === "integration" && !project ? [...common, ...cov, ...select] : [...common, ...select, ...cov],
      env: { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      configFiles: CONFIG_FILES.filter((f) => fs.existsSync(path.join(scanDir, f))),
      coverage: { collected: coverage, problem: null },
    };
  },
  read({ outDir, workspaceView }) {
    const tests = readJestResults(readText(path.join(outDir, "jest.json")), workspaceView);
    const summary = readText(path.join(outDir, "coverage", "coverage-summary.json"));
    const lines = summary === null ? null : parseLineCoverage(summary);
    return {
      tests,
      coverage: lines === null ? { ok: false, problem: "coverage-summary.json was not written" } : lines.ok ? { ok: true, covered: lines.lines.covered, total: lines.lines.total, basis: "lines", format: "istanbul json-summary" } : { ok: false, problem: lines.problem },
    };
  },
  properties(cases, { workspace }) {
    // The test files are read on this side (the paths the runner printed are mapped back to the workspace).
    const host = (rel: string): string => path.join(workspace, ...rel.split("/"));
    const scan = scanProperties(cases.filter((c) => c.file !== null).map((c) => host(c.file as string)));
    return { uses: scan.usesFastCheck, isProperty: (c) => c.file !== null && c.title !== undefined && (scan.byFile.get(host(c.file)) ?? new Set()).has(c.title) };
  },
};

export const jestAdapter = makeTestAdapter(jestSpec);
