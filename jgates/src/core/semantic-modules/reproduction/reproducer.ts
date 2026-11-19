// The host checks of a reproducer the model wrote (confirm-by-reproduction): the file is a test of the runner the
// finding's file needs, it lives directly in the reserved regressions folder, and everything it imports is a readable
// file of the project, the runner itself or the standard library. A file that fails any check is refused and never
// executed. Text checks only: nothing is run here.
import { builtinModules } from "node:module";
import path from "node:path";
import { PROPOSAL_FILE_PATTERN, REGRESSIONS_DIR, sha256 } from "../../regressions/proposals.js";
import { recipeFor, type TestRunnerId } from "../../regressions/runner.js";

/** Longest reproducer (characters). */
export const MAX_REPRODUCER = 20_000;
/** A pytest reproducer file name (pytest's own naming, lowercase). */
export const PYTEST_FILE_PATTERN = /^test_[a-z0-9_]{1,80}\.py$/;

/** What the checks may look at: the files the run may read (workspace-relative). */
export interface ProjectFiles {
  readable(path: string): boolean;
  files: readonly string[];
}

export interface CheckedReproducer {
  /** Workspace-relative: .jgates/regressions/<file>. */
  path: string;
  file: string;
  runner: TestRunnerId;
  content: string;
  sha256: string;
}

/**
 * The standard library modules a pytest reproducer may import (top-level names), and pytest itself. Anything else must
 * be a module of the project the run may read.
 */
const PYTHON_ALLOWED: ReadonlySet<string> = new Set(
  (
    "pytest abc argparse array ast asyncio base64 binascii bisect builtins bz2 calendar cmath codecs collections colorsys contextlib contextvars copy " +
    "csv dataclasses datetime decimal difflib dis email enum errno fnmatch fractions functools gc getpass gettext glob gzip hashlib heapq hmac html " +
    "http inspect io ipaddress itertools json keyword linecache locale logging lzma math mimetypes numbers operator os pathlib pickle platform pprint " +
    "queue random re reprlib secrets select shlex shutil signal socket sqlite3 ssl stat statistics string struct subprocess sys sysconfig tarfile " +
    "tempfile textwrap threading time timeit tokenize traceback types typing unicodedata unittest urllib uuid warnings weakref xml zipfile zlib zoneinfo __future__"
  ).split(" "),
);

const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));

/** Removes block comments and whole-line comments of a JavaScript module (strings are left alone). */
function jsCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

const literal = (arg: string): string | null => {
  const m = /^\s*(["'`])([^"'`$]*)\1\s*$/.exec(arg);
  return m ? (m[2] as string) : null;
};

/** The specifiers a JavaScript reproducer loads, and the dynamic loads that cannot be checked. */
export function jsImports(text: string): { specifiers: string[]; dynamic: string[] } {
  const code = jsCode(text);
  const specifiers: string[] = [];
  const dynamic: string[] = [];
  for (const m of code.matchAll(/\bimport\s+(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"']+)["']/g)) specifiers.push(m[1] as string);
  for (const m of code.matchAll(/\bexport\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s+["']([^"']+)["']/g)) specifiers.push(m[1] as string);
  for (const m of code.matchAll(/(?<![\w$.])(import|require)\s*\(([^)]*)\)/g)) {
    const spec = literal(m[2] as string);
    if (spec === null) dynamic.push(`${m[1] as string}(${(m[2] as string).trim().slice(0, 60)})`);
    else specifiers.push(spec);
  }
  return { specifiers: [...new Set(specifiers)], dynamic };
}

/** The modules a Python reproducer imports (dotted names; a relative import keeps its leading dots), and the dynamic ones. */
export function pythonImports(text: string): { modules: string[]; dynamic: string[] } {
  const modules: string[] = [];
  const dynamic: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const imp = /^import\s+(.+)$/.exec(line);
    if (imp) {
      for (const part of (imp[1] as string).split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim() ?? "";
        if (name) modules.push(name);
      }
      continue;
    }
    const from = /^from\s+(\.*[\w.]*)\s+import\b/.exec(line);
    if (from) modules.push(from[1] as string);
  }
  for (const m of text.matchAll(/(?:__import__|import_module)\s*\(([^),]*)/g)) {
    const spec = literal(m[1] as string);
    if (spec === null) dynamic.push(`${m[0].split("(")[0] as string}(${(m[1] as string).trim().slice(0, 60)})`);
    else modules.push(spec);
  }
  return { modules: [...new Set(modules)], dynamic };
}

/** Whether a relative import of a module in the regressions folder reaches a readable project file. */
function readableModule(spec: string, project: ProjectFiles): string | null {
  const target = path.posix.normalize(path.posix.join(REGRESSIONS_DIR, spec));
  if (target.startsWith("..") || path.posix.isAbsolute(target)) return null;
  const tries = [target, ...[".js", ".mjs", ".cjs", ".json"].map((e) => `${target}${e}`), ...["index.js", "index.mjs", "index.cjs"].map((f) => `${target}/${f}`)];
  return tries.find((p) => project.readable(p)) ?? null;
}

/** Whether a dotted Python module is a module or package of the project (the runner puts src and the root on the path). */
function readablePython(name: string, project: ProjectFiles): boolean {
  const rel = name.split(".").join("/");
  for (const root of ["", "src/"]) {
    const base = `${root}${rel}`;
    if (project.readable(`${base}.py`) || project.readable(`${base}/__init__.py`)) return true;
    if (project.files.some((f) => f.startsWith(`${base}/`) && f.endsWith(".py") && project.readable(f))) return true;
  }
  return false;
}

/** The problems of what a reproducer imports (empty: every import is allowed). */
export function importProblems(content: string, runner: TestRunnerId, project: ProjectFiles): string[] {
  const problems: string[] = [];
  if (runner === "node:test") {
    const { specifiers, dynamic } = jsImports(content);
    for (const d of dynamic) problems.push(`the reproducer loads ${d}: a load whose target is not a string cannot be checked`);
    for (const spec of specifiers) {
      if (spec.startsWith("node:")) {
        if (!/^node:[a-z_][a-z0-9_/]*$/.test(spec)) problems.push(`the reproducer imports ${JSON.stringify(spec)}, which is not a Node.js module`);
        continue;
      }
      if (spec.startsWith("./") || spec.startsWith("../")) {
        if (!readableModule(spec, project)) problems.push(`the reproducer imports ${JSON.stringify(spec)}, which is not a readable file of the project (imports are relative to ${REGRESSIONS_DIR}/)`);
        continue;
      }
      if (NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(spec.split("/")[0] as string)) continue;
      problems.push(`the reproducer imports ${JSON.stringify(spec.slice(0, 100))}, which is outside the readable project files (only project files, node:test and the Node.js standard library may be imported)`);
    }
    return problems;
  }
  const { modules, dynamic } = pythonImports(content);
  for (const d of dynamic) problems.push(`the reproducer loads ${d}: a load whose target is not a string cannot be checked`);
  for (const name of modules) {
    if (name.startsWith(".")) {
      problems.push(`the reproducer makes the relative import ${JSON.stringify(name)}: it lives alone in ${REGRESSIONS_DIR}/ and imports project modules by name`);
      continue;
    }
    if (PYTHON_ALLOWED.has(name.split(".")[0] as string)) continue;
    if (!readablePython(name, project)) problems.push(`the reproducer imports ${JSON.stringify(name.slice(0, 100))}, which is outside the readable project files (only project modules, pytest and the Python standard library may be imported)`);
  }
  return problems;
}

const strField = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Checks the test of a reproducer artifact for the finding's runner: `{name}` (or a `path` in the reserved folder) and
 * `content`. Refused, with the problems: a file that is not a test of that runner, a file outside the reserved
 * regressions folder, a file that imports something outside the readable project files.
 */
export function checkReproducerTest(raw: unknown, runner: TestRunnerId, project: ProjectFiles): { ok: true; reproducer: CheckedReproducer; problems: string[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problems: ["test is required: {\"name\": ..., \"content\": ...}"] };
  const r = raw as Record<string, unknown>;
  const given = strField(r.path).replace(/\\/g, "/").replace(/^\.\//, "");
  const name = strField(r.name ?? r.file).replace(/\\/g, "/");
  let file = "";
  if (given !== "") {
    const folder = path.posix.dirname(path.posix.normalize(given));
    if (folder !== REGRESSIONS_DIR) problems.push(`the test ${JSON.stringify(given.slice(0, 120))} lives outside the reserved regressions folder ${REGRESSIONS_DIR}/; it is refused`);
    else file = path.posix.basename(given);
  } else if (name.includes("/")) {
    problems.push(`the test ${JSON.stringify(name.slice(0, 120))} names a folder: it lives directly in the reserved regressions folder ${REGRESSIONS_DIR}/; it is refused`);
  } else file = name;
  if (problems.length > 0) return { ok: false, problems };
  const pattern = runner === "pytest" ? PYTEST_FILE_PATTERN : PROPOSAL_FILE_PATTERN;
  const rel = `${REGRESSIONS_DIR}/${file}`;
  if (!pattern.test(file) || recipeFor(rel)?.id !== runner) {
    problems.push(`${JSON.stringify(file.slice(0, 100))} is not a ${runner} test file: the finding's file runs under ${runner}, whose reproducer is named ${runner === "pytest" ? "test_<name>.py" : "<name>.test.mjs"} (lowercase)`);
  }
  const content = typeof r.content === "string" ? r.content.replace(/\r\n/g, "\n") : "";
  if (content.trim().length < 20 || content.length > MAX_REPRODUCER) problems.push(`the test must have content of at most ${MAX_REPRODUCER} characters`);
  else if (runner === "pytest" ? !/^\s*(?:async\s+)?def\s+test_\w*\s*\(/m.test(content) : !/["']node:test["']/.test(content)) {
    problems.push(runner === "pytest" ? "the content is not a pytest test: it declares no test_ function" : "the content is not a node:test module: it does not use node:test");
  }
  if (problems.length > 0) return { ok: false, problems };
  const imports = importProblems(content, runner, project);
  if (imports.length > 0) return { ok: false, problems: imports };
  return { ok: true, reproducer: { path: rel, file, runner, content, sha256: sha256(content) }, problems };
}
