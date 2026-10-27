// The normalized import graph of a Python project, built with grimp (the graph engine of Import Linter) by a small
// helper that runs in the Import Linter environment. The helper also lists the imports of the project's own packages
// that do not resolve to a module (grimp folds them into the nearest existing parent, which would hide them): they
// are reported as unresolved dependencies, a gap in coverage and never the absence of a violation.
import fs from "node:fs";
import path from "node:path";
import type { NormalizedGraph } from "../../core/architecture/index.js";
import { runSpec } from "../../core/runner/index.js";
import { toolPath } from "./probe.js";

export interface PythonRoot {
  /** Top-level package name. */
  name: string;
  /** Folder that holds the package, relative to the workspace ("." for the workspace itself). */
  sourceRoot: string;
}

const SKIP_DIRS = new Set(["node_modules", "__pycache__", "site-packages", "dist", "build", "venv", "env"]);
const MAX_DIRS = 20000;

const slash = (p: string): string => p.split(path.sep).join("/");

/** Top-level Python packages (a directory with __init__.py whose parent has none) under `base`. */
export function discoverPythonRoots(workspace: string, base: string): { roots: PythonRoot[]; truncated: boolean } {
  const roots: PythonRoot[] = [];
  let visited = 0;
  let truncated = false;
  const walk = (dir: string): void => {
    if (visited++ >= MAX_DIRS) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith(".") || SKIP_DIRS.has(e.name) || e.name.endsWith(".egg-info")) continue;
      const child = path.join(dir, e.name);
      if (fs.existsSync(path.join(child, "__init__.py"))) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name)) roots.push({ name: e.name, sourceRoot: slash(path.relative(workspace, dir)) || "." });
      } else walk(child);
    }
  };
  walk(base);
  return { roots, truncated };
}

/** Source of the helper (embedded: the build copies only JSON assets). Reads one JSON argument, prints the graph as JSON. */
export const GRAPH_HELPER = String.raw`
import ast, json, os, sys

def main():
    req = json.loads(sys.argv[1])
    ws = req["workspace"]
    roots = req["roots"]
    out = {"nodes": [], "edges": [], "unresolved": [], "coverage": {"extractor": "import-linter", "complete": True}}
    problems = []
    names, seen, kept = [], set(), []
    for r in roots:
        if r["name"] in seen:
            problems.append("package %s found in more than one folder (%s ignored)" % (r["name"], r["sourceRoot"]))
            continue
        seen.add(r["name"]); names.append(r["name"]); kept.append(r)
        sys.path.insert(0, os.path.join(ws, r["sourceRoot"]))
    try:
        import grimp
        from importlib.metadata import version
        out["coverage"]["version"] = "grimp " + version("grimp")
        graph = grimp.build_graph(*names)
    except Exception as error:
        out["coverage"]["complete"] = False
        out["coverage"]["reason"] = "%s: %s" % (type(error).__name__, error)
        print(json.dumps(out)); return 0
    modules = set(graph.modules)
    root_dir = {r["name"]: os.path.join(ws, r["sourceRoot"]) for r in kept}
    files = {}
    for m in sorted(modules):
        base = os.path.join(root_dir[m.split(".")[0]], *m.split("."))
        for cand in (base + ".py", os.path.join(base, "__init__.py")):
            if os.path.isfile(cand):
                files[m] = cand; break
    rel = lambda p: os.path.relpath(p, ws).replace(os.sep, "/")
    for m in sorted(modules):
        node = {"id": m, "kind": "module", "language": "python"}
        if m in files: node["path"] = rel(files[m])
        out["nodes"].append(node)
    for m in sorted(modules):
        for t in sorted(graph.find_modules_directly_imported_by(m)):
            if t not in modules: continue
            details = graph.get_import_details(importer=m, imported=t)
            origin = "%s:%d" % (rel(files[m]), details[0]["line_number"]) if details and m in files else None
            edge = {"from": m, "to": t}
            if origin: edge["origin"] = origin
            out["edges"].append(edge)
    top = set(names)
    def add_unresolved(m, spec):
        out["unresolved"].append({"from": m, "specifier": spec, "reason": "module-not-found"})
    for m, f in files.items():
        try:
            with open(f, "rb") as fh:
                tree = ast.parse(fh.read(), filename=f)
        except Exception as error:
            problems.append("%s could not be read: %s" % (rel(f), type(error).__name__))
            continue
        pkg = m if os.path.basename(f) == "__init__.py" else m.rpartition(".")[0]
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                for a in n.names:
                    if a.name.split(".")[0] in top and a.name not in modules: add_unresolved(m, a.name)
            elif isinstance(n, ast.ImportFrom):
                if n.level == 0:
                    if n.module and n.module.split(".")[0] in top and n.module not in modules: add_unresolved(m, n.module)
                else:
                    parts = pkg.split(".") if pkg else []
                    if n.level - 1 > len(parts):
                        add_unresolved(m, "." * n.level + (n.module or "")); continue
                    base = parts[:len(parts) - (n.level - 1)]
                    if n.module:
                        target = ".".join(base + [n.module])
                        if target not in modules: add_unresolved(m, "." * n.level + n.module)
    if problems:
        out["coverage"]["complete"] = False
        out["coverage"]["reason"] = "; ".join(problems)
    print(json.dumps(out))
    return 0

sys.exit(main())
`;

export interface GraphResult {
  ok: boolean;
  graph: NormalizedGraph;
  problem?: string;
}

const emptyGraph = (reason: string): NormalizedGraph => ({ nodes: [], edges: [], unresolved: [], coverage: { extractor: "import-linter", complete: false, reason } });

/** Builds the normalized graph. Never throws: a helper that fails gives an empty, incomplete graph and the reason. */
export async function buildImportGraph(options: {
  python: string;
  workspace: string;
  roots: PythonRoot[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  outFile: string;
  errFile: string;
  timeoutMs: number;
}): Promise<GraphResult> {
  const request = JSON.stringify({ workspace: options.workspace, roots: options.roots });
  const result = await runSpec(
    {
      executable: options.python,
      // -I: no user site, no PYTHONPATH, no cwd on sys.path: only the roots the helper adds itself.
      args: ["-I", "-c", GRAPH_HELPER, request],
      cwd: options.cwd,
      env: { PATH: toolPath(options.env.PATH), PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdin: null,
      timeoutMs: options.timeoutMs,
      stdoutFile: options.outFile,
      stderrFile: options.errFile,
    },
    { parentEnv: options.env },
  );
  if (result.spawnError) return { ok: false, graph: emptyGraph(result.spawnError.message), problem: result.spawnError.message };
  if (result.timedOut) return { ok: false, graph: emptyGraph("the graph helper timed out"), problem: "timeout" };
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(options.outFile, "utf8"));
  } catch {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-2).join(" ") || `exit ${result.exitCode ?? "-"}`;
    return { ok: false, graph: emptyGraph(`the graph helper gave no JSON: ${detail}`), problem: detail };
  }
  const graph = doc as NormalizedGraph;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.unresolved)) return { ok: false, graph: emptyGraph("the graph helper answered an unexpected document"), problem: "shape" };
  if (result.truncated) graph.coverage = { ...graph.coverage, complete: false, reason: "the graph output was truncated" };
  return { ok: true, graph };
}
