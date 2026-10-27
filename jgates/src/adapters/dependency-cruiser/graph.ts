// Turns the JSON of `depcruise --output-type json` into the normalized graph of the architecture evaluator.
// Fail-closed: a document that is not the expected shape is not a graph. An import the tool could not resolve is
// recorded as unresolved (a gap of coverage), never dropped.
import type { GraphEdge, GraphNode, NormalizedGraph, UnresolvedDependency } from "../../core/architecture/index.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ComponentRef {
  id: string;
  /** Workspace-relative root; "." for the workspace itself. */
  root: string;
}

export interface GraphParse {
  ok: boolean;
  graph: NormalizedGraph;
  problem?: string;
}

const EXTERNAL_TYPES = new Set(["core", "npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled", "npm-no-pkg", "npm-unknown"]);
const TS_EXT = /\.(ts|tsx|mts|cts)$/i;

const slash = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** The component that owns a path: the one with the longest root that contains it. */
export function componentOf(file: string, components: ComponentRef[]): string | undefined {
  let best: ComponentRef | undefined;
  for (const c of components) {
    const root = slash(c.root).replace(/\/$/, "");
    const inside = root === "." || root === "" || file === root || file.startsWith(`${root}/`);
    if (inside && (!best || root.length > slash(best.root).length)) best = c;
  }
  return best?.id;
}

const isNodeModules = (p: string): boolean => /(^|\/)node_modules\//.test(p);

export function parseDepcruiseOutput(text: string, opts: { version: string | null; components: ComponentRef[] }): GraphParse {
  const empty: NormalizedGraph = { nodes: [], edges: [], unresolved: [], coverage: { extractor: "dependency-cruiser", ...(opts.version ? { version: opts.version } : {}) } };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, graph: empty, problem: error instanceof Error ? error.message : String(error) };
  }
  if (!isRec(doc) || !Array.isArray(doc.modules)) return { ok: false, graph: empty, problem: "the document has no modules list" };

  const nodes = new Map<string, GraphNode>();
  for (const [index, m] of doc.modules.entries()) {
    if (!isRec(m) || typeof m.source !== "string") return { ok: false, graph: empty, problem: `module ${index} has no source` };
    const source = slash(m.source);
    if (isNodeModules(source) || m.coreModule === true || m.couldNotResolve === true) continue;
    const component = componentOf(source, opts.components);
    nodes.set(source, {
      id: source,
      kind: "file",
      language: TS_EXT.test(source) ? "typescript" : "javascript",
      ...(component ? { component } : {}),
      path: source,
    });
  }

  const edges: GraphEdge[] = [];
  const unresolved: UnresolvedDependency[] = [];
  for (const m of doc.modules) {
    const rec = m as Rec;
    const from = slash(rec.source as string);
    if (!nodes.has(from)) continue;
    const deps = rec.dependencies;
    if (deps === undefined) continue;
    if (!Array.isArray(deps)) return { ok: false, graph: empty, problem: `dependencies of ${from} is not a list` };
    for (const d of deps) {
      if (!isRec(d) || typeof d.module !== "string") return { ok: false, graph: empty, problem: `a dependency of ${from} has no module` };
      const types = Array.isArray(d.dependencyTypes) ? d.dependencyTypes.filter((t): t is string => typeof t === "string") : [];
      if (d.couldNotResolve === true) {
        unresolved.push({ from, specifier: d.module, reason: "could-not-resolve" });
        continue;
      }
      const resolved = typeof d.resolved === "string" ? slash(d.resolved) : null;
      // Packages and Node's own modules are outside the graph of the project: not a gap.
      if (d.coreModule === true || types.some((t) => EXTERNAL_TYPES.has(t)) || (resolved !== null && isNodeModules(resolved))) continue;
      if (resolved === null) {
        unresolved.push({ from, specifier: d.module, reason: "no-resolution" });
        continue;
      }
      if (!nodes.has(resolved)) {
        // Resolved to a file the analysis did not include (excluded, or outside the analysed folders).
        unresolved.push({ from, specifier: d.module, reason: "outside-analysis" });
        continue;
      }
      edges.push({ from, to: resolved, origin: `dependency-cruiser:${from}` });
    }
  }
  // Re-exports and type imports of the same pair collapse into one edge.
  const seen = new Set<string>();
  const unique = edges.filter((e) => {
    const key = `${e.from}\u0000${e.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ok: true,
    graph: {
      nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: unique,
      unresolved,
      coverage: { extractor: "dependency-cruiser", ...(opts.version ? { version: opts.version } : {}), complete: true },
    },
  };
}
