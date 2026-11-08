// Finds the Hypothesis property tests among the tests pytest ran. JUnit does not say how a test was generated, so the
// test files are read (never executed): a test function carrying a `@given(...)` decorator (imported from hypothesis)
// is a property test. Detection is static and fail-closed: a file that cannot be read contributes no property test,
// never a guessed one.
import fs from "node:fs";

export interface PropertyScan {
  /** Test function names decorated with `@given`, per workspace-relative file. */
  byFile: Map<string, Set<string>>;
  /** Files that import hypothesis (even without a `@given` test yet). */
  usesHypothesis: boolean;
}

const IMPORT = /^\s*(?:from\s+hypothesis(?:\.\w+)*\s+import\b|import\s+hypothesis\b)/m;
const GIVEN = /^\s*@\s*(?:\w+\s*\.\s*)*given\b/;
const DEF = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;

/** The functions of one test file that carry `@given`. Decorators may span lines; the next `def` is the decorated one. */
export function givenFunctions(source: string): string[] {
  const names: string[] = [];
  let pending = false;
  for (const line of source.split(/\r?\n/)) {
    if (GIVEN.test(line)) {
      pending = true;
      continue;
    }
    const def = DEF.exec(line);
    if (def) {
      if (pending) names.push(def[1] as string);
      pending = false;
    }
  }
  return names;
}

export function usesHypothesis(source: string): boolean {
  return IMPORT.test(source);
}

/** Reads each file once (`resolve` maps a workspace-relative path to a path to read). */
export function scanProperties(files: Iterable<string>, resolve: (file: string) => string): PropertyScan {
  const byFile = new Map<string, Set<string>>();
  let any = false;
  for (const file of new Set(files)) {
    let text: string;
    try {
      text = fs.readFileSync(resolve(file), "utf8");
    } catch {
      continue;
    }
    if (usesHypothesis(text)) any = true;
    const names = givenFunctions(text);
    if (names.length > 0) byFile.set(file, new Set(names));
  }
  return { byFile, usesHypothesis: any };
}

/** The test name without the parametrization suffix pytest appends (`test_x[1-2]`). */
export const baseTestName = (name: string): string => name.replace(/\[.*$/s, "");
