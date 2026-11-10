// Finds the property tests of a Go module among the tests `go test` ran. The report does not say how a test was written,
// so the test files are read (never executed): a `func TestXxx(t *testing.T)` whose body runs a property of
// pgregory.net/rapid (`rapid.Check(t, ...)`) or of the standard testing/quick (`quick.Check(...)`, `quick.CheckEqual(...)`)
// is a property test. Detection is static and fail-closed: an unreadable file contributes no property test.
import fs from "node:fs";
import path from "node:path";
import { listFiles } from "../../core/selection/tests.js";

export interface GoPropertyScan {
  /** Some test file imports rapid or testing/quick. */
  uses: boolean;
  /** Names of the property test functions. */
  names: Set<string>;
}

const IMPORT_ALIAS = /(?:^|\s)(?:(\w+)\s+)?"(pgregory\.net\/rapid|testing\/quick)"/gm;

/** The property test functions of one Go test file. */
export function goPropertyTests(source: string): { uses: boolean; names: string[] } {
  const aliases: string[] = [];
  let uses = false;
  const imports = /^import\s*(?:\(([\s\S]*?)\)|("[^"]+"|\w+\s+"[^"]+"))/gm;
  for (const block of source.matchAll(imports)) {
    const text = block[1] ?? block[2] ?? "";
    for (const m of text.matchAll(IMPORT_ALIAS)) {
      uses = true;
      aliases.push(m[1] ?? (m[2] === "testing/quick" ? "quick" : "rapid"));
    }
  }
  if (!uses) return { uses: false, names: [] };
  const calls = new RegExp(`\\b(?:${aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\.(?:Check|CheckEqual|MakeCheck|MakeCustom)\\s*\\(`);
  const names: string[] = [];
  const funcs = [...source.matchAll(/^func\s+(Test[A-Za-z0-9_]*)\s*\(\s*\w+\s+\*testing\.T\s*\)/gm)];
  for (const f of funcs) {
    const start = f.index ?? 0;
    const next = source.slice(start + 1).search(/^func\s/m);
    const body = next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
    if (calls.test(body)) names.push(f[1] as string);
  }
  return { uses, names };
}

/** Reads every *_test.go file of the module folder once. */
export function scanGoProperties(dir: string): GoPropertyScan {
  const names = new Set<string>();
  let uses = false;
  for (const f of listFiles(dir, (_rel, name) => name.endsWith("_test.go"))) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, ...f.split("/")), "utf8");
    } catch {
      continue;
    }
    const found = goPropertyTests(text);
    if (found.uses) uses = true;
    for (const n of found.names) names.add(n);
  }
  return { uses, names };
}
