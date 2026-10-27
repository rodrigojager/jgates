import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "../../ids/index.js";
import { translator, type Translator } from "../../../i18n/index.js";
import { getBuiltinTemplate, isBuiltinRef, listBuiltinTemplates } from "../../../builtin/index.js";
import { suggestName, validateDocument } from "../load/schema.js";
import { parseYamlFile } from "../load/yaml.js";
import { DEFAULT_LIMITS, type YamlLimits } from "../load/types.js";
import { formatFilePath, isDescendant, isListOp, isPlainObject, type LayerOp, type ListOp } from "./pointer.js";
import { templateOps, type SourcedOps } from "./layers.js";
import type { IssueSink } from "./store.js";
import type { ActiveTemplate, InventoryLike, TemplateNodeInfo, TemplateState } from "./types.js";

/**
 * Templates: loading (built-in or project file), linearization of `extends` (parents in the declared order before
 * the child, diamonds deduplicated by resolved identity, cycles reported with the exact chain), activation from the
 * first-stage inventory, and the ordering of the active templates. Ancestors are weaker than descendants; between
 * unrelated templates the higher declared priority is stronger; with no defined order, overlapping writes with
 * different values are a conflict. The order of files on disk or of the list never decides. A `match.files` list is
 * configuration evidence: the template is detected only when one of those files exists (with the line it asks for)
 * in the root of a component of the matched languages, or in the workspace root.
 */

interface TemplateNode {
  identity: string;
  file: string;
  value: Record<string, unknown>;
  parents: string[];
  priority: number;
  ops: LayerOp[];
}

/** A template entry of the first stage (jgates.yml templates, or the implicit list). */
export interface TemplateEntry {
  source?: unknown;
  activation?: unknown;
  match?: unknown;
  priority?: unknown;
  enabled?: unknown;
}

interface Where {
  file: string;
  path: string;
}

function isInside(parent: string, child: string): boolean {
  const r = path.relative(parent, child);
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
}

export class TemplateGraph {
  private readonly nodes = new Map<string, TemplateNode | null>();
  private readonly t: Translator = translator("config");
  /** Real path of the analyzed project (template evidence is looked up there). */
  private readonly realDir: string;
  /** Configuration folder (template files are read from there); the project unless a policy is used. */
  private readonly configDir: string;
  private readonly realConfigDir: string;

  constructor(
    private readonly projectDir: string,
    private readonly sink: IssueSink,
    private readonly limits: YamlLimits = DEFAULT_LIMITS,
    configDir: string = projectDir,
  ) {
    this.realDir = fs.realpathSync(projectDir);
    this.configDir = path.resolve(configDir);
    this.realConfigDir = fs.realpathSync(this.configDir);
  }

  /** Resolves a reference (builtin:<id> or a project-relative path) to its identity, loading the document. */
  resolve(ref: string, where: Where): string | undefined {
    const identity = this.identityOf(ref, where);
    if (identity === undefined) return undefined;
    if (!this.nodes.has(identity)) this.load(identity, ref, where);
    return this.nodes.get(identity) ? identity : undefined;
  }

  node(identity: string): TemplateNode | undefined {
    return this.nodes.get(identity) ?? undefined;
  }

  /**
   * Whether a project-relative file exists inside the project (a link that leaves it does not count), and, when
   * `contains` is given, has a line that starts with that text after spaces. Only reads, at most 1 MiB.
   */
  hasEvidence(rel: string, contains: string | null): boolean {
    let real: string;
    try {
      real = fs.realpathSync(path.join(this.projectDir, ...rel.split("/")));
      if (!isInside(this.realDir, real)) return false;
      const stat = fs.statSync(real);
      if (!stat.isFile()) return false;
      if (contains === null) return true;
      if (stat.size > MAX_EVIDENCE_BYTES) return false;
    } catch {
      return false;
    }
    try {
      return fs.readFileSync(real, "utf8").split(/\r?\n/).some((line) => line.trimStart().startsWith(contains));
    } catch {
      return false;
    }
  }

  private identityOf(ref: string, where: Where): string | undefined {
    if (isBuiltinRef(ref)) {
      if (getBuiltinTemplate(ref)) return ref;
      const available = listBuiltinTemplates().map((i) => i.ref);
      const suggestion = suggestName(ref, available);
      this.sink.error({
        code: "TEMPLATE_UNKNOWN",
        message: this.t("resolve_template_unknown", { ref }),
        fix: this.t("resolve_template_unknown_fix", { available: available.join(", ") }),
        file: where.file,
        details: { path: where.path, ...(suggestion ? { suggestion } : {}) },
      });
      return undefined;
    }
    const absolute = path.resolve(this.configDir, ref);
    let real: string | undefined;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      real = undefined;
    }
    if (path.isAbsolute(ref) || !isInside(this.configDir, absolute) || (real !== undefined && !isInside(this.realConfigDir, real))) {
      this.sink.error({ code: "TEMPLATE_OUTSIDE_PROJECT", message: this.t("resolve_template_outside", { ref }), file: where.file, details: { path: where.path } });
      return undefined;
    }
    if (real === undefined || !fs.statSync(real).isFile()) {
      this.sink.error({ code: "TEMPLATE_MISSING", message: this.t("resolve_template_missing", { ref }), file: where.file, details: { path: where.path } });
      return undefined;
    }
    return path.relative(this.realConfigDir, real).split(path.sep).join("/");
  }

  private load(identity: string, ref: string, where: Where): void {
    this.nodes.set(identity, null); // placeholder while loading
    let value: Record<string, unknown>;
    let file: string;
    if (isBuiltinRef(identity)) {
      const item = getBuiltinTemplate(identity);
      if (!item) return;
      value = item.value;
      file = item.file;
    } else {
      file = identity;
      const parsed = parseYamlFile(path.join(this.realConfigDir, identity), identity, this.limits);
      const diagnostics = [...parsed.diagnostics];
      if (diagnostics.length === 0) {
        if (!isPlainObject(parsed.value)) {
          diagnostics.push({ kind: "schema", code: "TYPE", file: identity, path: "", pathSegments: [], message: this.t("config_document_not_mapping") });
        } else {
          diagnostics.push(...validateDocument("template", parsed.value, identity, { doc: parsed.doc, lineCounter: parsed.lineCounter }));
        }
      }
      if (diagnostics.length > 0) {
        this.sink.error({
          code: "TEMPLATE_INVALID",
          message: this.t("resolve_template_invalid", { ref, count: diagnostics.length, detail: diagnostics.map((d) => `${d.path || "-"}: ${d.message}`).join("; ") }),
          fix: this.t("resolve_template_invalid_fix"),
          file: identity,
          details: { diagnostics, referencedFrom: where },
        });
        return;
      }
      value = parsed.value as Record<string, unknown>;
    }
    const node: TemplateNode = {
      identity,
      file,
      value,
      parents: [],
      priority: typeof value.priority === "number" ? value.priority : 0,
      ops: templateOps(value),
    };
    this.nodes.set(identity, node);
    const parents = Array.isArray(value.extends) ? (value.extends as unknown[]) : [];
    parents.forEach((parent, index) => {
      if (typeof parent !== "string") return;
      const id = this.resolve(parent, { file, path: formatFilePath(["extends", String(index)]) });
      if (id !== undefined) node.parents.push(id);
    });
  }

  /**
   * Parents in the declared order before the child; a node already placed is not placed again (diamond).
   * Returns undefined when the chain has a cycle (reported with the exact chain).
   */
  linearize(identity: string, placed: Set<string> = new Set(), order: string[] = []): string[] | undefined {
    const visit = (id: string, stack: string[]): boolean => {
      if (stack.includes(id)) {
        const chain = [...stack, id];
        this.sink.error({
          code: "EXTENDS_CYCLE",
          message: this.t("resolve_template_cycle", { chain: chain.join(" -> ") }),
          fix: this.t("resolve_cycle_fix"),
          file: this.node(id)?.file ?? id,
          chain,
        });
        return false;
      }
      if (placed.has(id)) return true;
      const node = this.node(id);
      if (!node) return false;
      for (const parent of node.parents) if (!visit(parent, [...stack, id])) return false;
      placed.add(id);
      order.push(id);
      return true;
    };
    return visit(identity, []) ? order : undefined;
  }

  ancestors(identity: string, seen: Set<string> = new Set()): Set<string> {
    for (const parent of this.node(identity)?.parents ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      this.ancestors(parent, seen);
    }
    return seen;
  }
}

const MAX_EVIDENCE_BYTES = 1024 * 1024;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

interface EvidenceFile {
  path: string;
  contains: string | null;
}

/** The match.files entries (a path, or {path, contains}). */
function evidenceFiles(value: unknown): EvidenceFile[] {
  if (!Array.isArray(value)) return [];
  const out: EvidenceFile[] = [];
  for (const v of value) {
    if (typeof v === "string" && v !== "") out.push({ path: v.replace(/\\/g, "/"), contains: null });
    else if (isPlainObject(v) && typeof v.path === "string" && typeof v.contains === "string") out.push({ path: v.path.replace(/\\/g, "/"), contains: v.contains });
  }
  return out;
}

/** Which inventory values (and evidence files) a match selects; undefined when it does not match. */
function matchInventory(match: unknown, inventory: InventoryLike, graph: TemplateGraph): string[] | undefined {
  const m = isPlainObject(match) ? match : {};
  const wantLanguages = stringList(m.languages);
  const wantFrameworks = stringList(m.frameworks);
  const wantFiles = evidenceFiles(m.files);
  const approvable = (inventory.classifications ?? []).filter((c) => c.approvable !== false);
  const languages = new Set<string>([...(inventory.languages ?? []), ...approvable.map((c) => c.language).filter((l): l is string => typeof l === "string")]);
  const frameworks = new Set<string>(approvable.map((c) => c.framework).filter((f): f is string => typeof f === "string"));
  const hitLanguages = wantLanguages.filter((l) => languages.has(l));
  const hitFrameworks = wantFrameworks.filter((f) => frameworks.has(f));
  if (wantLanguages.length > 0 && hitLanguages.length === 0) return undefined;
  if (wantFrameworks.length > 0 && hitFrameworks.length === 0) return undefined;
  if (wantLanguages.length === 0 && wantFrameworks.length === 0 && wantFiles.length === 0) return undefined;
  const values = [...hitLanguages, ...hitFrameworks].sort();
  if (wantFiles.length === 0) return values;
  // Evidence: the roots of the components the languages and frameworks select, and the workspace root.
  const roots = new Set<string>(["."]);
  for (const c of approvable) {
    if (wantLanguages.length > 0 && !(typeof c.language === "string" && wantLanguages.includes(c.language))) continue;
    if (wantFrameworks.length > 0 && !(typeof c.framework === "string" && wantFrameworks.includes(c.framework))) continue;
    // The inventory of discovery carries the component root ("." at the workspace root).
    const componentRoot = (c as { componentRoot?: unknown }).componentRoot;
    if (typeof componentRoot === "string" && componentRoot !== "") roots.add(componentRoot.replace(/\\/g, "/").replace(/\/+$/, "") || ".");
  }
  const hits = new Set<string>();
  for (const root of [...roots].sort()) {
    for (const file of wantFiles) {
      const rel = root === "." ? file.path : `${root}/${file.path}`;
      if (graph.hasEvidence(rel, file.contains)) hits.add(rel);
    }
  }
  if (hits.size === 0) return undefined;
  return [...values, ...[...hits].sort()];
}

export interface TemplateSelection {
  active: ActiveTemplate[];
  inactive: TemplateState[];
  nodes: TemplateNodeInfo[];
  /** Layer operations of the templates, in application order (weakest first), when there is no conflict. */
  layers: SourcedOps[];
}

/**
 * Activates the template entries (sorted by id, so the declaration order never matters), linearizes their chains and
 * returns the template layers in a defined order, or reports conflicts.
 */
export function selectTemplates(
  graph: TemplateGraph,
  entries: Record<string, TemplateEntry>,
  inventory: InventoryLike,
  requested: readonly string[],
  sink: IssueSink,
  fileOfEntries: string,
): TemplateSelection {
  const t = translator("config");
  const active: ActiveTemplate[] = [];
  const inactive: TemplateState[] = [];
  const priorities = new Map<string, number>();
  const ids = Object.keys(entries).sort();

  for (const id of requested) {
    if (!Object.hasOwn(entries, id)) {
      const suggestion = suggestName(id, ids);
      sink.error({ code: "TEMPLATE_ENTRY_UNKNOWN", message: t("resolve_template_entry_unknown", { id }), ...(suggestion ? { details: { suggestion } } : {}) });
    }
  }

  for (const id of ids) {
    const entry = entries[id] as TemplateEntry;
    const source = typeof entry.source === "string" ? entry.source : "";
    if (entry.enabled === false) {
      inactive.push({ id, source, reason: "DISABLED" });
      continue;
    }
    const identity = graph.resolve(source, { file: fileOfEntries, path: `templates.${id}.source` });
    if (identity === undefined) continue;
    const node = graph.node(identity) as TemplateNode;
    const match = entry.match ?? node.value.match;
    const activation = typeof entry.activation === "string" ? entry.activation : match !== undefined ? "detected" : "always";
    let state: TemplateState | undefined;
    if (activation === "always") state = { id, source, reason: "ALWAYS" };
    else if (activation === "manual") {
      if (!requested.includes(id)) {
        inactive.push({ id, source, reason: "MANUAL" });
        continue;
      }
      state = { id, source, reason: "REQUESTED" };
    } else {
      if (requested.includes(id)) state = { id, source, reason: "REQUESTED" };
      else if (inventory.templatesActive === false) {
        inactive.push({ id, source, reason: "REPORT_ONLY" });
        continue;
      } else {
        const matched = matchInventory(match, inventory, graph);
        if (!matched) {
          inactive.push({ id, source, reason: "NOT_DETECTED" });
          continue;
        }
        state = { id, source, reason: "DETECTED", matched };
      }
    }
    const chain = graph.linearize(identity);
    if (!chain) continue;
    const priority = typeof entry.priority === "number" ? entry.priority : node.priority;
    priorities.set(identity, Math.max(priorities.get(identity) ?? -Infinity, priority));
    active.push({ ...state, priority, chain });
  }

  // Every node of the active chains, with its ancestors and priority.
  const all = new Set<string>();
  for (const a of active) for (const id of a.chain) all.add(id);
  const ancestors = new Map<string, Set<string>>();
  const priority = (id: string): number => priorities.get(id) ?? (graph.node(id) as TemplateNode).priority;
  for (const id of all) ancestors.set(id, graph.ancestors(id));
  const less = (a: string, b: string): boolean =>
    (ancestors.get(b) as Set<string>).has(a) || (!(ancestors.get(a) as Set<string>).has(b) && priority(a) < priority(b));

  // Topological order (parents first); among the available nodes, the lowest priority and then the identity.
  const order: string[] = [];
  const remaining = new Set(all);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => [...(graph.node(id) as TemplateNode).parents].every((p) => !remaining.has(p)));
    ready.sort((a, b) => priority(a) - priority(b) || (a < b ? -1 : a > b ? 1 : 0));
    const next = ready[0];
    if (next === undefined) break; // unreachable: chains with a cycle were rejected by linearize
    order.push(next);
    remaining.delete(next);
  }

  const conflicts = findConflicts(order, (id) => (graph.node(id) as TemplateNode).ops, less);
  for (const c of conflicts) {
    sink.error({
      code: "TEMPLATE_CONFLICT",
      message: t("resolve_template_conflict", { a: c.templates[0], b: c.templates[1], pointer: c.pointer }),
      fix: t("resolve_template_conflict_fix"),
      pointer: c.pointer,
      details: c,
    });
  }

  const nodes: TemplateNodeInfo[] = order.map((id) => {
    const node = graph.node(id) as TemplateNode;
    return { ref: id, file: node.file, priority: priority(id), parents: node.parents };
  });
  const layers: SourcedOps[] = conflicts.length > 0 ? [] : order.map((id) => ({ source: id, file: (graph.node(id) as TemplateNode).file, ops: (graph.node(id) as TemplateNode).ops }));
  return { active, inactive, nodes, layers };
}

export interface TemplateConflict {
  pointer: string;
  /** The two templates, sorted. */
  templates: [string, string];
  values: [unknown, unknown];
}

function overlaps(x: LayerOp, y: LayerOp): boolean {
  if (x.pointer === y.pointer) return true;
  if (isDescendant(y.pointer, x.pointer)) return x.kind !== "object";
  if (isDescendant(x.pointer, y.pointer)) return y.kind !== "object";
  return false;
}

function compatible(x: LayerOp, y: LayerOp): boolean {
  if (x.pointer !== y.pointer) return false;
  if (x.kind === "object" && y.kind === "object") return true;
  if (x.kind === "set" && y.kind === "set") return canonicalJson(x.value) === canonicalJson(y.value);
  if (x.kind === "list" && y.kind === "list" && isListOp(x.value) && isListOp(y.value)) {
    const a = x.value as ListOp;
    const b = y.value as ListOp;
    if (a.replace || b.replace) return canonicalJson(a) === canonicalJson(b);
    const has = (list: unknown[] | undefined, item: unknown) => (list ?? []).some((v) => canonicalJson(v) === canonicalJson(item));
    // Additions and removals commute when no item is added by one and removed by the other.
    return !(a.add ?? []).some((i) => has(b.remove, i)) && !(b.add ?? []).some((i) => has(a.remove, i));
  }
  return false;
}

/** Overlapping writes of two templates that no order separates (or whose order contradicts the application order). */
function findConflicts(order: string[], opsOf: (id: string) => LayerOp[], less: (a: string, b: string) => boolean): TemplateConflict[] {
  const found = new Map<string, TemplateConflict>();
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i] as string;
      const b = order[j] as string;
      if (less(a, b)) continue;
      for (const x of opsOf(a)) {
        for (const y of opsOf(b)) {
          if (!overlaps(x, y) || compatible(x, y)) continue;
          const pair = [a, b].sort() as [string, string];
          const [first, second] = pair[0] === a ? [x, y] : [y, x];
          const pointer = first.pointer.length <= second.pointer.length ? first.pointer : second.pointer;
          const key = `${pointer}\u0000${pair.join("\u0000")}`;
          if (!found.has(key)) found.set(key, { pointer, templates: pair, values: [first.value, second.value] });
        }
      }
    }
  }
  return [...found.values()].sort((p, q) => (p.pointer < q.pointer ? -1 : p.pointer > q.pointer ? 1 : p.templates.join() < q.templates.join() ? -1 : 1));
}
