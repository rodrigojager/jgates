// Reads the coverage.py JSON report (pytest-cov --cov-report=json:...) into line coverage with its denominator.
// A report with no measured statements is "not measured", never 0%.
import fs from "node:fs";
import path from "node:path";

export interface CoverageReading {
  ok: boolean;
  problem?: string;
  covered: number;
  statements: number;
  excluded: number;
  files: number;
  branch: boolean;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

export function parseCoverageJson(text: string): CoverageReading {
  const bad = (problem: string): CoverageReading => ({ ok: false, problem, covered: 0, statements: 0, excluded: 0, files: 0, branch: false });
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return bad(error instanceof Error ? error.message : String(error));
  }
  if (!isRec(doc) || !isRec(doc.totals)) return bad("no totals");
  const covered = count(doc.totals.covered_lines);
  const statements = count(doc.totals.num_statements);
  if (covered === null || statements === null) return bad("totals without covered_lines or num_statements");
  if (covered > statements) return bad("covered_lines is larger than num_statements");
  const meta = isRec(doc.meta) ? doc.meta : {};
  return {
    ok: true,
    covered,
    statements,
    excluded: count(doc.totals.excluded_lines) ?? 0,
    files: isRec(doc.files) ? Object.keys(doc.files).length : 0,
    branch: meta.branch_coverage === true,
  };
}

const COVERAGE_FILES: Array<{ name: string; declares: (text: string) => boolean }> = [
  { name: ".coveragerc", declares: (t) => sectionHas(t, /^\[run\]/m, /^\s*source(_pkgs)?\s*=/m) },
  { name: "pyproject.toml", declares: (t) => sectionHas(t, /^\[tool\.coverage\.run\]/m, /^\s*source(_pkgs)?\s*=/m) },
  { name: "setup.cfg", declares: (t) => sectionHas(t, /^\[coverage:run\]/m, /^\s*source(_pkgs)?\s*=/m) },
  { name: "tox.ini", declares: (t) => sectionHas(t, /^\[coverage:run\]/m, /^\s*source(_pkgs)?\s*=/m) },
];

/** The body of the section that starts at `header` (up to the next section), tested with `key`. */
function sectionHas(text: string, header: RegExp, key: RegExp): boolean {
  const start = header.exec(text);
  if (!start) return false;
  const rest = text.slice(start.index + start[0].length);
  const next = rest.search(/^\[/m);
  return key.test(next === -1 ? rest : rest.slice(0, next));
}

export interface CoverageConfig {
  /** Workspace-relative file that declares the coverage source, or null. */
  file: string | null;
  /** Coverage configuration files present in the component (they decide behaviour, so the plan hashes them). */
  present: string[];
}

/** Whether the component's own coverage configuration already chooses what to measure (then `--cov` takes no path). */
export function findCoverageConfig(workspace: string, componentRoot: string | null): CoverageConfig {
  const dir = path.join(workspace, componentRoot && componentRoot !== "." ? componentRoot : "");
  const present: string[] = [];
  let file: string | null = null;
  for (const c of COVERAGE_FILES) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, c.name), "utf8");
    } catch {
      continue;
    }
    const hasSection = c.name === ".coveragerc" || /\[(tool\.coverage|coverage:)/.test(text);
    if (!hasSection) continue;
    const rel = path.relative(workspace, path.join(dir, c.name)).split(path.sep).join("/");
    present.push(rel);
    if (file === null && c.declares(text)) file = rel;
  }
  return { file, present };
}
