// Finds the fast-check property tests among the tests Vitest ran. The JSON report does not say how a test was written,
// so the test files are read (never executed): a test whose body runs a fast-check property (`fc.assert(fc.property(..))`,
// or a named import of it), or that is declared with `test.prop(...)` from @fast-check/vitest, is a property test.
// Detection is static and fail-closed: an unreadable file contributes no property test.
import fs from "node:fs";

export interface PropertyScan {
  /** Titles of the property tests, per absolute test file. */
  byFile: Map<string, Set<string>>;
  /** Some scanned file imports fast-check (or @fast-check/vitest). */
  usesFastCheck: boolean;
}

const FC_MODULES = /["'](?:fast-check|@fast-check\/vitest|@fast-check\/jest)["']/;
const API = ["assert", "asyncAssert", "check", "property", "asyncProperty"];
const DECLARATION = /\b(?:test|it)(?:\.[A-Za-z]+)*\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
// test.prop([arbitraries])('title', fn): the title is in the second call.
const PROP_DECLARATION = /\b(?:test|it)(?:\.[A-Za-z]+)*\.prop\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The way the file reaches the fast-check API: namespaces (`fc`, `fastCheck`) and directly imported names. */
function imports(source: string): { namespaces: string[]; names: string[] } {
  const namespaces: string[] = [];
  const names: string[] = [];
  for (const m of source.matchAll(/import\s+(?:\*\s+as\s+(\w+)|(\w+))\s+from\s+["']fast-check["']/g)) namespaces.push((m[1] ?? m[2]) as string);
  for (const m of source.matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s+from\s+["']fast-check["']/g)) {
    for (const part of (m[1] as string).split(",")) {
      const [original, alias] = part.trim().split(/\s+as\s+/);
      if (original && API.includes(original)) names.push(alias ?? original);
    }
  }
  // CommonJS (Jest projects): `const fc = require("fast-check")` and `const { assert, property: p } = require("fast-check")`.
  for (const m of source.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*["']fast-check["']\s*\)/g)) namespaces.push(m[1] as string);
  for (const m of source.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*["']fast-check["']\s*\)/g)) {
    for (const part of (m[1] as string).split(",")) {
      const [original, alias] = part.trim().split(/\s*:\s*/);
      if (original && API.includes(original)) names.push(alias ?? original);
    }
  }
  return { namespaces, names };
}

/** The titles of the tests of one file whose body runs a fast-check property or that are declared with `.prop`. */
export function propertyTitles(source: string): string[] {
  const starts: Array<{ index: number; title: string; prop: boolean }> = [];
  for (const m of source.matchAll(PROP_DECLARATION)) starts.push({ index: m.index ?? 0, title: m[2] as string, prop: true });
  for (const m of source.matchAll(DECLARATION)) {
    const index = m.index ?? 0;
    // `test.prop([...])('title')` is already recorded with its own title.
    if (!starts.some((s) => s.prop && s.index === index)) starts.push({ index, title: m[2] as string, prop: false });
  }
  starts.sort((a, b) => a.index - b.index);
  const { namespaces, names } = imports(source);
  const calls = [
    ...namespaces.map((ns) => new RegExp(`\\b${escapeRe(ns)}\\.(?:${API.join("|")})\\s*\\(`)),
    ...names.map((n) => new RegExp(`(?<![.\\w])${escapeRe(n)}\\s*\\(`)),
  ];
  const titles: string[] = [];
  starts.forEach((s, i) => {
    const end = starts[i + 1]?.index ?? source.length;
    const body = source.slice(s.index, end);
    if (s.prop || calls.some((re) => re.test(body))) titles.push(s.title);
  });
  return titles;
}

/** Reads each file once. */
export function scanProperties(files: Iterable<string>): PropertyScan {
  const byFile = new Map<string, Set<string>>();
  let usesFastCheck = false;
  for (const file of new Set(files)) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (FC_MODULES.test(text)) usesFastCheck = true;
    const titles = propertyTitles(text);
    if (titles.length > 0) byFile.set(file, new Set(titles));
  }
  return { byFile, usesFastCheck };
}
