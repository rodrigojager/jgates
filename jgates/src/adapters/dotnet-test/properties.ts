// Finds the FsCheck property tests of a .NET component among the tests `dotnet test` ran. The TRX file does not say how
// a test was written, so the source files are read (never compiled): a method carrying FsCheck's [Property] attribute
// (FsCheck.Xunit / FsCheck.NUnit), or whose body checks a property (`Prop.ForAll`, `Check.Quick...`, `.QuickCheck...`),
// in a file that uses FsCheck, is a property test. Detection is static and fail-closed.
import fs from "node:fs";
import path from "node:path";
import { listFiles } from "../../core/selection/tests.js";

export interface DotnetPropertyScan {
  uses: boolean;
  /** Method names of the property tests. */
  names: Set<string>;
}

const USES = /^\s*(?:using\s+(?:static\s+)?FsCheck\b|open\s+FsCheck\b)/m;
const CS_METHOD = /^[ \t]*((?:\[[^\]\n]*\][ \t]*\r?\n?[ \t]*)*)(?:(?:public|private|internal|protected|static|async|override|virtual)\s+)+[\w<>[\],.?]+(?:\s*<[^>]*>)?\s+(\w+)\s*\(/gm;
const FS_LET = /^[ \t]*((?:\[<[^\]\n]*>\][ \t]*\r?\n[ \t]*)*)(?:let|member\s+\w+\.)\s*(``[^`]+``|\w+)\s*\(/gm;
const CHECKS = /\bProp\.ForAll\b|\bCheck\.(?:Quick|Verbose|One)\w*\s*\(|\.QuickCheck\w*\s*\(|\.VerboseCheck\w*\s*\(/;

/** The property test methods of one source file. */
export function fsCheckProperties(source: string): { uses: boolean; names: string[] } {
  if (!USES.test(source)) return { uses: false, names: [] };
  const names: string[] = [];
  const decls = [...source.matchAll(CS_METHOD), ...source.matchAll(FS_LET)].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  decls.forEach((d, i) => {
    const attrs = d[1] ?? "";
    const start = d.index ?? 0;
    const end = decls[i + 1]?.index ?? source.length;
    const body = source.slice(start, end);
    const name = (d[2] as string).replace(/^``|``$/g, "");
    if (/\[<?\s*(?:FsCheck\.(?:Xunit|NUnit)\.)?Property\b/.test(attrs) || CHECKS.test(body.slice(d[0].length))) names.push(name);
  });
  return { uses: true, names };
}

export function scanDotnetProperties(dir: string): DotnetPropertyScan {
  const names = new Set<string>();
  let uses = false;
  for (const f of listFiles(dir, (_rel, name) => /\.(?:cs|fs)$/.test(name))) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, ...f.split("/")), "utf8");
    } catch {
      continue;
    }
    const found = fsCheckProperties(text);
    if (found.uses) uses = true;
    for (const n of found.names) names.add(n);
  }
  return { uses, names };
}

/** The method name of a TRX test name (`Ns.Class.Method(x: 1)` -> `Method`). */
export function methodOf(testName: string): string {
  const bare = testName.replace(/\(.*$/s, "");
  return bare.slice(bare.lastIndexOf(".") + 1);
}
