import { qualityBridgeManifest } from "../../adapters/quality-bridge/manifest.js";
import { createCoreCatalog, type AdapterManifest } from "../catalog/index.js";
import { suggestName } from "../config/load/schema.js";

/** Kinds of selector, the same in YAML, in the CLI and in the API. */
export const SELECTOR_KINDS = ["category", "capability", "tool", "rule", "pii", "architecture", "component"] as const;
export type SelectorKind = (typeof SELECTOR_KINDS)[number];

export interface Selector {
  kind: SelectorKind;
  id: string;
  raw: string;
}

const SELECTOR_PATTERN = /^(category|capability|tool|rule|pii|architecture|component):([A-Za-z0-9._/-]+)$/;

export function parseSelector(raw: string): Selector | undefined {
  const m = SELECTOR_PATTERN.exec(raw);
  return m ? { kind: m[1] as SelectorKind, id: m[2] as string, raw } : undefined;
}

export interface UniverseTool {
  id: string;
  capabilities: string[];
  component: string | null;
  /** Composite adapter this instance belongs to (for example "quality-bridge" for "quality-bridge.lint"). */
  parent: string | null;
}

/** Everything a selector can name in a project: what exists is what can be selected. */
export interface Universe {
  categories: string[];
  capabilities: Array<{ id: string; category: string | null }>;
  tools: UniverseTool[];
  /** Rules the adapters can turn off, by instance. */
  rules: Array<{ tool: string; id: string }>;
  pii: string[];
  architecture: string[];
  components: string[];
  /** Composite parents, which stand for all their children (tool:quality-bridge). */
  parents: string[];
}

/** Entities the current PII detector recognizes; more come from pii.yml. */
export const DEFAULT_PII_ENTITIES = ["cpf", "cnpj", "credit-card", "phone"] as const;

export interface UniverseOptions {
  /** Adapter manifests whose sub-checks become tool instances (default: the bridge). */
  manifests?: AdapterManifest[];
  /** Rules that adapters can turn off, by tool instance. */
  rules?: Record<string, string[]>;
  /** Extra component ids. */
  components?: string[];
}

interface InventoryLike {
  classifications?: Array<{ id?: string | null }>;
}

function keysOf(value: unknown): string[] {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function at(config: Record<string, unknown>, ...segments: string[]): unknown {
  let node: unknown = config;
  for (const s of segments) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[s];
  }
  return node;
}

/** Builds the universe from the resolved configuration, the discovery inventory, the core catalog and the manifests. */
export function buildUniverse(config: Record<string, unknown>, inventory?: InventoryLike, options: UniverseOptions = {}): Universe {
  const catalog = createCoreCatalog().toDocument();
  const tools = new Map<string, UniverseTool>();
  for (const manifest of options.manifests ?? [qualityBridgeManifest]) {
    for (const sub of manifest.subchecks ?? []) {
      const id = `${manifest.id}.${sub.id}`;
      tools.set(id, { id, capabilities: [...sub.capabilities], component: null, parent: manifest.id });
    }
  }
  const configured = at(config, "tools");
  for (const id of keysOf(configured)) {
    const body = (configured as Record<string, Record<string, unknown>>)[id] ?? {};
    const caps = Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === "string") : [];
    tools.set(id, { id, capabilities: caps, component: typeof body.component === "string" ? body.component : null, parent: null });
  }

  const rules: Universe["rules"] = [];
  for (const [tool, list] of Object.entries(options.rules ?? {})) for (const id of list) rules.push({ tool, id });

  const components = new Set<string>(options.components ?? []);
  for (const c of inventory?.classifications ?? []) if (typeof c.id === "string" && c.id !== "") components.add(c.id);
  for (const id of keysOf(at(config, "workspace", "components"))) components.add(id);

  return {
    categories: catalog.categories.map((c) => c.id),
    capabilities: catalog.capabilities.map((c) => ({ id: c.id, category: c.category ?? null })),
    tools: [...tools.values()],
    rules,
    pii: [...new Set<string>([...DEFAULT_PII_ENTITIES, ...keysOf(at(config, "pii", "entities"))])],
    architecture: keysOf(at(config, "architecture", "rules")),
    components: [...components],
    parents: [...new Set([...tools.values()].map((t) => t.parent).filter((p): p is string => p !== null))],
  };
}

/** Every selector the universe can name, as strings. */
export function knownSelectors(u: Universe): string[] {
  return [
    ...u.categories.map((c) => `category:${c}`),
    ...u.capabilities.map((c) => `capability:${c.id}`),
    ...u.tools.map((t) => `tool:${t.id}`),
    ...u.parents.map((p) => `tool:${p}`),
    ...u.rules.map((r) => `rule:${r.tool}/${r.id}`),
    ...u.pii.map((p) => `pii:${p}`),
    ...u.architecture.map((a) => `architecture:${a}`),
    ...u.components.map((c) => `component:${c}`),
  ];
}

export type SelectorProblem =
  | { code: "SELECTOR_INVALID"; suggestion?: string }
  | { code: "SELECTOR_UNMATCHED"; suggestion?: string }
  | { code: "RULE_UNSUPPORTED"; tool: string; suggestion?: string };

/** null when the selector names something that exists; otherwise the problem, with a suggestion when one is close. */
export function checkSelector(raw: string, u: Universe): SelectorProblem | null {
  const sel = parseSelector(raw);
  const known = knownSelectors(u);
  if (!sel) {
    const suggestion = suggestName(raw, known);
    return { code: "SELECTOR_INVALID", ...(suggestion ? { suggestion } : {}) };
  }
  if (known.includes(raw)) return null;
  if (sel.kind === "rule") {
    const tool = sel.id.split("/")[0] as string;
    if (u.tools.some((t) => t.id === tool)) return { code: "RULE_UNSUPPORTED", tool, ...optional(suggestName(raw, known.filter((k) => k.startsWith("rule:")))) };
  }
  return { code: "SELECTOR_UNMATCHED", ...optional(suggestName(raw, known)) };
}

function optional(suggestion: string | undefined): { suggestion?: string } {
  return suggestion ? { suggestion } : {};
}
