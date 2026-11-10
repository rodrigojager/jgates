// Test selection: which tests of a component are integration tests (PLAN-completeness.md section 2). The integration
// step of a stack's test runner runs only this selection and the unit step leaves it out, so no test counts twice.
// The selection is configurable per tool instance (`tools.<id>.selection`); a unit instance without its own selection
// uses the one of the integration instance of the same adapter and component, so both sides always agree. Without any,
// each stack has a default:
//   python (pytest)   the tests/integration folder when it exists, otherwise the `integration` marker;
//   node (vitest/jest) a project named `integration` when the configuration declares one, otherwise the
//                     `*.integration.test.*` / `*.integration.spec.*` files;
//   go                the `integration` build tag (`//go:build integration` test files);
//   rust              the integration test targets of tests/;
//   dotnet            the `Category=Integration` trait.
// Everything here is static: files are listed and read, never executed, so planning stays free of project code.
import fs from "node:fs";
import path from "node:path";

export type TestStack = "python" | "node" | "go" | "rust" | "dotnet";

/** `tools.<id>.selection`: what counts as an integration test (each stack reads the keys that apply to it). */
export interface IntegrationSelectionConfig {
  /** pytest: the marker (`-m <marker>`). */
  marker?: string;
  /** pytest: folders (or files) relative to the component. */
  paths?: string[];
  /** vitest/jest: the project (workspace entry) that holds the integration tests. */
  project?: string;
  /** vitest/jest: a glob of the integration test files, relative to the component. */
  pattern?: string;
  /** go: the build tag of the integration test files. */
  tag?: string;
  /** cargo: the integration test targets (names of the tests/ targets). */
  targets?: string[];
  /** .NET: the value of the Category trait. */
  category?: string;
}

export type SelectionKind = "marker" | "paths" | "project" | "pattern" | "tag" | "targets" | "category";

export interface ResolvedSelection {
  stack: TestStack;
  kind: SelectionKind;
  /** The marker, project, glob, tag or category; the list for paths and targets. */
  value: string | string[];
  /** instance: the tool instance's own selection; sibling: the integration instance's; default: the stack's. */
  source: "instance" | "sibling" | "default";
  /** The instance whose selection applies (source instance or sibling). */
  sourceTool: string | null;
}

export interface IntegrationDetection {
  /** At least one integration test (or target) matches the selection. */
  present: boolean;
  /** Component-relative POSIX paths of the files that hold integration tests (sorted). */
  files: string[];
  /** go: the test functions of the tagged files; rust: the integration targets. */
  names: string[];
  /** go: the packages (./dir) of the tagged files. */
  packages: string[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const strList = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const list = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().replace(/\\/g, "/").replace(/\/+$/, ""));
  return list.length > 0 ? list : undefined;
};

/** The adapter's stack, by manifest id. */
export const STACK_OF_ADAPTER: Readonly<Record<string, TestStack>> = {
  pytest: "python",
  vitest: "node",
  jest: "node",
  "go-test": "go",
  "cargo-test": "rust",
  "dotnet-test": "dotnet",
};

/** The keys a stack reads, in the order they win when several are given. */
const KEYS_OF_STACK: Readonly<Record<TestStack, SelectionKind[]>> = {
  python: ["paths", "marker"],
  node: ["project", "pattern"],
  go: ["tag"],
  rust: ["targets"],
  dotnet: ["category"],
};

export const DEFAULT_NODE_PATTERN = "**/*.integration.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";
const DEFAULT_PYTHON_FOLDER = "tests/integration";

function readSelection(body: unknown, stack: TestStack): { kind: SelectionKind; value: string | string[] } | null {
  if (!isRec(body) || !isRec(body.selection)) return null;
  const sel = body.selection;
  for (const kind of KEYS_OF_STACK[stack]) {
    const value = kind === "paths" || kind === "targets" ? strList(sel[kind]) : str(sel[kind]);
    if (value !== undefined) return { kind, value };
  }
  return null;
}

const capabilitiesOf = (body: unknown): string[] => (isRec(body) && Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === "string") : []);
const componentOf = (body: unknown): string | null => (isRec(body) && typeof body.component === "string" ? body.component : null);
const adapterOf = (body: unknown): string | null => (isRec(body) && typeof body.adapter === "string" ? body.adapter : null);

export interface SelectionInput {
  stack: TestStack;
  /** The resolved configuration (its `tools` map). */
  config: Rec | undefined;
  /** The tool instance being planned. */
  tool: string;
  adapter: string;
  /** The folder the runner works in (the component root, absolute). */
  scanDir: string;
}

/** The integration selection that applies to an instance: its own, else its integration sibling's, else the stack default. */
export function resolveIntegrationSelection(input: SelectionInput): ResolvedSelection {
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const own = readSelection(tools[input.tool], input.stack);
  if (own) return { stack: input.stack, ...own, source: "instance", sourceTool: input.tool };
  const component = componentOf(tools[input.tool]);
  const siblings = Object.keys(tools)
    .filter((id) => id !== input.tool && adapterOf(tools[id]) === input.adapter && componentOf(tools[id]) === component && capabilitiesOf(tools[id]).includes("integration"))
    .sort();
  for (const id of siblings) {
    const found = readSelection(tools[id], input.stack);
    if (found) return { stack: input.stack, ...found, source: "sibling", sourceTool: id };
  }
  return { stack: input.stack, ...defaultSelection(input.stack, input.scanDir), source: "default", sourceTool: null };
}

function defaultSelection(stack: TestStack, scanDir: string): { kind: SelectionKind; value: string | string[] } {
  switch (stack) {
    case "python":
      return isDir(path.join(scanDir, ...DEFAULT_PYTHON_FOLDER.split("/"))) ? { kind: "paths", value: [DEFAULT_PYTHON_FOLDER] } : { kind: "marker", value: "integration" };
    case "node":
      return nodeProjects(scanDir).includes("integration") ? { kind: "project", value: "integration" } : { kind: "pattern", value: DEFAULT_NODE_PATTERN };
    case "go":
      return { kind: "tag", value: "integration" };
    case "rust":
      return { kind: "targets", value: [] };
    case "dotnet":
      return { kind: "category", value: "Integration" };
  }
}

/** A short text of the selection for plans and messages ("pytest marker integration", "tests/ targets api, db"). */
export function describeSelection(sel: ResolvedSelection): string {
  const list = (v: string | string[]): string => (Array.isArray(v) ? v.join(", ") : v);
  switch (sel.kind) {
    case "marker":
      return `-m ${list(sel.value)}`;
    case "paths":
      return list(sel.value);
    case "project":
      return `project ${list(sel.value)}`;
    case "pattern":
      return list(sel.value);
    case "tag":
      return `-tags=${list(sel.value)}`;
    case "targets":
      return Array.isArray(sel.value) && sel.value.length > 0 ? `--test ${sel.value.join(" --test ")}` : "tests/*.rs";
    case "category":
      return `Category=${list(sel.value)}`;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function read(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Folders no test listing enters: dependencies, build output, caches and tool state. */
const SKIPPED = new Set(["node_modules", "vendor", "target", "bin", "obj", "dist", "build", "out", "venv", ".venv", "__pycache__", "coverage", "third_party"]);
const MAX_FILES = 5000;

/** Component-relative POSIX paths of the files `accept` takes, sorted. */
export function listFiles(dir: string, accept: (rel: string, name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > 12 || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    for (const e of entries) {
      const next = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIPPED.has(e.name)) continue;
        walk(path.join(abs, e.name), next, depth + 1);
      } else if (e.isFile() && accept(next, e.name)) out.push(next);
    }
  };
  walk(dir, "", 0);
  return out;
}

/** A glob (`**`, `*`, `?`, `{a,b}`) as a regular expression over component-relative POSIX paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches any number of folders, including none.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Names of the projects a Vitest or Jest configuration of the folder declares (`name:` / `displayName:` literals). */
export function nodeProjects(scanDir: string): string[] {
  const names = new Set<string>();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(scanDir);
  } catch {
    entries = [];
  }
  for (const file of entries.filter((n) => /^(?:vitest|vite|jest)\.(?:config|workspace)\.[cm]?[jt]s$|^vitest\.workspace\.json$|^jest\.config\.json$/.test(n))) {
    const text = read(path.join(scanDir, file)) ?? "";
    for (const m of text.matchAll(/\b(?:name|displayName)\s*:\s*(['"`])([^'"`]+)\1/g)) names.add(m[2] as string);
  }
  const pkg = read(path.join(scanDir, "package.json"));
  if (pkg) {
    try {
      const doc = JSON.parse(pkg) as Rec;
      const jest = isRec(doc.jest) ? doc.jest : null;
      for (const p of jest && Array.isArray(jest.projects) ? jest.projects : []) {
        if (isRec(p) && typeof p.displayName === "string") names.add(p.displayName);
        if (isRec(p) && isRec(p.displayName) && typeof p.displayName.name === "string") names.add(p.displayName.name);
      }
    } catch {
      // not JSON: no project
    }
  }
  return [...names].sort();
}

const PY_TEST = /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/;
const NODE_TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The Go build constraint of a file (`//go:build ...` before the package clause) names the tag as a positive term. */
export function goFileHasTag(source: string, tag: string): boolean {
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("package ")) return false;
    const m = /^\/\/go:build\s+(.+)$/.exec(trimmed);
    if (m) return new RegExp(`(?<![!\\w])${escapeRe(tag)}(?![\\w])`).test(m[1] as string);
  }
  return false;
}

/** The `func TestXxx(t *testing.T)` names of a Go test file. */
export function goTestNames(source: string): string[] {
  return [...source.matchAll(/^func\s+(Test[A-Za-z0-9_]*)\s*\(\s*\w+\s+\*testing\.T\s*\)/gm)].map((m) => m[1] as string);
}

/** The integration test targets of a crate: tests/<name>.rs, tests/<name>/main.rs and [[test]] entries of Cargo.toml. */
export function rustTestTargets(scanDir: string): string[] {
  const names = new Set<string>();
  const tests = path.join(scanDir, "tests");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(tests, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".rs")) names.add(e.name.slice(0, -3));
    else if (e.isDirectory() && fs.existsSync(path.join(tests, e.name, "main.rs"))) names.add(e.name);
  }
  const toml = read(path.join(scanDir, "Cargo.toml")) ?? "";
  for (const block of toml.split(/^\s*\[\[test\]\]\s*$/m).slice(1)) {
    const m = /^\s*name\s*=\s*"([^"]+)"/m.exec(block.split(/^\s*\[/m)[0] ?? "");
    if (m) names.add(m[1] as string);
  }
  return [...names].sort();
}

/** The lib and bin targets of a crate (by its files and Cargo.toml), which the unit run selects with --lib / --bins. */
export function rustUnitTargets(scanDir: string): { lib: boolean; bins: boolean } {
  const toml = read(path.join(scanDir, "Cargo.toml")) ?? "";
  return {
    lib: fs.existsSync(path.join(scanDir, "src", "lib.rs")) || /^\s*\[lib\]\s*$/m.test(toml),
    bins: fs.existsSync(path.join(scanDir, "src", "main.rs")) || isDir(path.join(scanDir, "src", "bin")) || /^\s*\[\[bin\]\]\s*$/m.test(toml),
  };
}

/** The attribute that puts a .NET test in the category (xUnit Trait, NUnit Category, MSTest TestCategory). */
export function dotnetCategoryPattern(category: string): RegExp {
  const v = escapeRe(category);
  return new RegExp(`(?:Trait\\s*\\(\\s*"Category"\\s*,\\s*"${v}"\\s*\\)|(?:Test)?Category\\s*\\(\\s*"${v}"\\s*\\))`);
}

/** Which integration tests the selection matches in the folder, by reading (never running) the test files. */
export function detectIntegration(scanDir: string, sel: ResolvedSelection): IntegrationDetection {
  const none: IntegrationDetection = { present: false, files: [], names: [], packages: [] };
  const value = sel.value;
  switch (sel.kind) {
    case "paths": {
      const roots = (value as string[]).map((p) => p.replace(/^\.\//, ""));
      const files = listFiles(scanDir, (rel) => PY_TEST.test(rel) && roots.some((r) => rel === r || rel.startsWith(`${r}/`)));
      return { ...none, present: files.length > 0, files };
    }
    case "marker": {
      const mark = new RegExp(`pytest\\.mark\\.${escapeRe(value as string)}\\b`);
      const files = listFiles(scanDir, (rel) => PY_TEST.test(rel)).filter((f) => mark.test(read(path.join(scanDir, ...f.split("/"))) ?? ""));
      return { ...none, present: files.length > 0, files };
    }
    case "pattern": {
      const re = globToRegExp(value as string);
      const files = listFiles(scanDir, (rel) => re.test(rel));
      return { ...none, present: files.length > 0, files };
    }
    case "project": {
      const present = nodeProjects(scanDir).includes(value as string);
      return { ...none, present };
    }
    case "tag": {
      const files: string[] = [];
      const names: string[] = [];
      const packages = new Set<string>();
      for (const f of listFiles(scanDir, (_rel, name) => name.endsWith("_test.go"))) {
        const text = read(path.join(scanDir, ...f.split("/"))) ?? "";
        if (!goFileHasTag(text, value as string)) continue;
        const found = goTestNames(text);
        if (found.length === 0) continue;
        files.push(f);
        names.push(...found);
        const dir = path.posix.dirname(f);
        packages.add(dir === "." ? "." : `./${dir}`);
      }
      return { present: names.length > 0, files, names: [...new Set(names)].sort(), packages: [...packages].sort() };
    }
    case "targets": {
      const all = rustTestTargets(scanDir);
      const chosen = (value as string[]).length > 0 ? (value as string[]).filter((t) => all.includes(t)) : all;
      return { ...none, present: chosen.length > 0, names: chosen, files: chosen.map((t) => (fs.existsSync(path.join(scanDir, "tests", `${t}.rs`)) ? `tests/${t}.rs` : `tests/${t}/main.rs`)) };
    }
    case "category": {
      const re = dotnetCategoryPattern(value as string);
      const files = listFiles(scanDir, (_rel, name) => /\.(?:cs|fs|vb)$/.test(name)).filter((f) => re.test(read(path.join(scanDir, ...f.split("/"))) ?? ""));
      return { ...none, present: files.length > 0, files };
    }
  }
}

/** A Jest path regex for a selection glob (Jest matches its patterns against absolute paths). */
export function jestPathRegex(glob: string): string {
  // RegExp#source escapes the slashes; Jest takes the pattern as a string, where they need no escape.
  const source = globToRegExp(glob).source.replace(/^\^/, "").replace(/\\\//g, "/");
  // The glob is component-relative: anchor it after a folder separator instead of the start of the absolute path.
  return source.startsWith("(?:.*/)?") ? `/${source.slice("(?:.*/)?".length)}` : `/${source}`;
}

/** Whether a test file is one Node runners pick up by default (`*.test.*` / `*.spec.*`). */
export const isNodeTestFile = (rel: string): boolean => NODE_TEST.test(rel);
