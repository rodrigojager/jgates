// Configuração > Arquitetura: the map drawn from .jgates/architecture.yml, the rules with their toggle ("Bloqueia"), the
// adapters that verify each one, the dependencies the last run could not resolve, the owner of each rule (source or
// generated) and the native configuration generated for the tools, read only. The toggle writes `enabled` into the rule
// by patch, so the comments of the file stay.
import fs from "node:fs";
import path from "node:path";
import { listRuns } from "../../core/artifacts/index.js";
import { ARCHITECTURE_FILE, architectureReferenceProblems, readArchitecture, type ArchitectureRule } from "../../core/architecture/index.js";
import { patchYamlText, readRevision, type YamlEdit } from "../../core/codecs/yaml/index.js";
import { parseYamlText, validateDocument } from "../../core/config/load/index.js";
import { unifiedDiff } from "../../core/documents/diff.js";
import { defaultReadDir, walkProject } from "../../core/discovery/walk.js";
import { writeBytesAtomic } from "../../core/documents/atomic.js";
import { cachedProject } from "../../core/cache/project.js";
import { resolveConfig } from "../../core/config/resolve/index.js";
import { resolveSelection } from "../../core/selection/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { assertWritable, patchConfigFile } from "./templates.js";
import { modeOf } from "./workspaces.js";

type Rec = Record<string, unknown>;

const HASH_PATTERN = "^[0-9a-f]{64}$";
const GENERATED = [
  { tool: "import-linter", dir: "import-linter", file: "importlinter.ini", format: "ini" },
  { tool: "dependency-cruiser", dir: "dependency-cruiser", file: "depcruise.config.cjs", format: "javascript" },
];
const MAX_TEXT = 20_000;

function summary(rule: ArchitectureRule): Rec {
  switch (rule.kind) {
    case "forbidden-dependency":
      return { from: rule.from ?? null, to: rule.to ?? [] };
    case "component-boundary":
      return { component: rule.component ?? null, allowed: rule.allowedDependencies ?? [] };
    case "no-cycles":
      return { within: rule.within ?? null };
    default:
      return { layer: rule.layer ?? null, maxFanIn: rule.maxFanIn ?? null, maxFanOut: rule.maxFanOut ?? null };
  }
}

/** Files named `name` under a folder, shallowest first (the outputs of one run hold one folder per instance). */
function findFiles(root: string, name: string, depth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, level: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === name) out.push(path.join(dir, e.name));
      else if (e.isDirectory() && level < depth) walk(path.join(dir, e.name), level + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** What the most recent run that wrote architecture outputs saw: coverage, unresolved dependencies, generated configuration. */
function lastRunEvidence(server: ServerContext): Rec {
  let runs;
  try {
    runs = listRuns(server.home, server.workspace.id).slice(0, 15);
  } catch {
    return { runId: null, coverage: [], generated: [] };
  }
  for (const run of runs) {
    const outputs = path.join(run.dir, "outputs");
    const coverage: Rec[] = [];
    for (const tool of GENERATED) {
      for (const file of findFiles(path.join(outputs, tool.dir), "coverage.json")) {
        try {
          const c = JSON.parse(fs.readFileSync(file, "utf8")) as Rec;
          coverage.push({ tool: tool.tool, status: c.status ?? null, extractor: c.extractor ?? null, nodes: c.nodes ?? 0, edges: c.edges ?? 0, unresolved: c.unresolved ?? 0, sample: Array.isArray(c.unresolvedSample) ? c.unresolvedSample.slice(0, 20) : [], reasons: Array.isArray(c.reasons) ? c.reasons : [] });
        } catch {
          // A damaged coverage file is a gap in the evidence, not a reason to hide the screen.
        }
      }
    }
    const generated: Rec[] = [];
    for (const tool of GENERATED) {
      const [file] = findFiles(path.join(outputs, tool.dir), tool.file);
      if (!file) continue;
      try {
        const text = fs.readFileSync(file, "utf8");
        generated.push({ tool: tool.tool, file: path.relative(run.dir, file).split(path.sep).join("/"), format: tool.format, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT });
      } catch {
        // Same: unreadable generated file is simply not shown.
      }
    }
    if (coverage.length > 0 || generated.length > 0) return { runId: run.runId, startedAt: run.startedAt, coverage, generated };
  }
  return { runId: null, startedAt: null, coverage: [], generated: [] };
}

function describe(server: ServerContext): Rec {
  const mode = modeOf();
  const read = readArchitecture(server.projectDir);
  const revision = readRevision(path.join(server.projectDir, ARCHITECTURE_FILE));
  const base = { schemaVersion: 1, status: "OK", mode: mode.mode, governed: mode.governed, file: ARCHITECTURE_FILE, exists: revision.exists, revision: revision.hash };
  if (!read.declaration) return { ...base, valid: read.problems.length === 0, problems: read.problems, layers: [], rules: [], tools: [], evidence: lastRunEvidence(server) };

  // The tools that can verify a rule: the active instances with the architecture capability.
  const resolved = resolveConfig(server.projectDir);
  const selection = resolved.ok ? resolveSelection(resolved) : null;
  const capability = selection?.items.find((i) => i.selector === "capability:architecture");
  const tools = (selection?.universe.tools ?? [])
    .filter((t) => t.capabilities.includes("architecture") && t.parent === null)
    .map((t) => {
      const item = selection?.items.find((i) => i.selector === `tool:${t.id}`);
      const pair = item?.capabilities?.find((p) => p.capability === "architecture");
      return { id: t.id, component: t.component ?? null, enabled: pair?.enabled ?? false };
    });
  const active = tools.filter((t) => t.enabled);

  const contract = read.declaration.contract;
  const rules = (contract.rules ?? []).map((rule, index) => ({
    id: rule.id,
    kind: rule.kind,
    enabled: rule.enabled !== false,
    blocking: rule.blocking !== false,
    severity: rule.severity ?? null,
    owner: rule.owner ?? "source",
    message: rule.message ?? null,
    ...summary(rule),
    saveTo: { file: ARCHITECTURE_FILE, path: `architecture.rules[${index}].enabled` },
    origin: { layer: "project", source: "project", file: ARCHITECTURE_FILE, path: `architecture.rules[${index}].enabled` },
    coverage: { covered: rule.enabled !== false && active.length > 0 && capability?.enabled !== false, by: active.map((t) => t.id), available: tools.map((t) => t.id) },
  }));
  return { ...base, valid: true, problems: [], layers: (contract.layers ?? []).map((l) => ({ id: l.id, label: l.label ?? l.id, paths: l.paths ?? [], modules: l.modules ?? [], component: l.component ?? null })), rules, tools, evidence: lastRunEvidence(server) };
}

// ---- the guided editor: layers proposed from the folders, rules proposed from the layers, one save with a diff ------------

const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);

const EMPTY_FILE = [
  "# Architecture contract: the layers of the project and the rules between them.",
  "# JGates never deduces the architecture; it verifies what is declared here.",
  "schemaVersion: 1",
  "architecture:",
  "  layers: []",
  "  rules: []",
  "",
].join("\n");

/** Folder names that usually mark a layer, by the layer they suggest. A proposal only: the person confirms each one. */
const LAYER_FOLDERS: Readonly<Record<string, string>> = {
  domain: "domain",
  entities: "domain",
  application: "application",
  usecases: "application",
  "use-cases": "application",
  use_cases: "application",
  infrastructure: "infrastructure",
  infra: "infrastructure",
  persistence: "infrastructure",
  adapters: "infrastructure",
  presentation: "presentation",
  controllers: "presentation",
  web: "presentation",
  views: "presentation",
};
const LAYER_ORDER = ["domain", "application", "infrastructure", "presentation"];
/** The inner layers must not depend on the outer ones. */
const OUTWARD: Readonly<Record<string, string[]>> = { domain: ["application", "infrastructure", "presentation"], application: ["infrastructure", "presentation"] };
const NOT_LAYERS = new Set(["test", "tests", "__tests__", "docs", "doc", "node_modules", "examples", "example", "fixtures"]);
const MAX_PATHS = 8;
const PROPOSAL_LIMITS = { maxEntries: 20_000, maxDepth: 8, maxManifestBytes: 0 };

function proposal(server: ServerContext): Rec {
  const read = readArchitecture(server.projectDir);
  const known = new Set((read.declaration?.contract.layers ?? []).map((l) => l.id));
  const found = cachedProject("architecture-folders", [path.resolve(server.projectDir)], () => {
    const tree = walkProject(path.resolve(server.projectDir), defaultReadDir, PROPOSAL_LIMITS);
    const folders = new Set<string>();
    for (const file of tree.files) {
      const parts = file.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
    }
    const byLayer = new Map<string, string[]>();
    for (const folder of [...folders].sort()) {
      const parts = folder.split("/");
      if (parts.some((p) => NOT_LAYERS.has(p.toLowerCase()) || p.startsWith("."))) continue;
      const layer = LAYER_FOLDERS[(parts[parts.length - 1] as string).toLowerCase()];
      if (!layer) continue;
      byLayer.set(layer, [...(byLayer.get(layer) ?? []), `${folder}/**`]);
    }
    return LAYER_ORDER.filter((id) => byLayer.has(id)).map((id) => ({ id, paths: (byLayer.get(id) as string[]).slice(0, MAX_PATHS) }));
  });
  const layers = found.filter((l) => !known.has(l.id)).map((l) => ({ id: l.id, paths: [...l.paths] }));
  const present = new Set([...known, ...found.map((l) => l.id)]);
  const existingRules = new Set((read.declaration?.contract.rules ?? []).map((r) => r.id));
  // A pair a rule of the file already forbids is not proposed again under another name.
  const covered = new Set((read.declaration?.contract.rules ?? []).filter((r) => r.kind === "forbidden-dependency").flatMap((r) => (r.to ?? []).map((to) => `${r.from}>${to}`)));
  const rules: Rec[] = [];
  for (const [from, targets] of Object.entries(OUTWARD)) {
    if (!present.has(from)) continue;
    for (const to of targets) {
      const id = `${from}-not-${to}`;
      if (present.has(to) && !existingRules.has(id) && !covered.has(`${from}>${to}`)) rules.push({ id, kind: "forbidden-dependency", from, to: [to], blocking: true });
    }
  }
  return { schemaVersion: 1, status: "OK", layers, rules };
}

interface LayerIn {
  id: string;
  label?: string;
  paths: string[];
}
interface RuleIn {
  id: string;
  from: string;
  to: string[];
  blocking?: boolean;
}
interface EditBody {
  layers: LayerIn[];
  rules: RuleIn[];
  removeLayers: string[];
  removeRules: string[];
  expectedRevision?: string | null;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface ArchPlan {
  exists: boolean;
  before: string;
  after: string;
  edits: YamlEdit[];
  revision: string | null;
}

/**
 * The edits one save makes: a new layer or rule is appended, a known one gets only the fields that changed, a removed
 * one is deleted by its index. Whatever the person wrote by hand (comments, other keys, other kinds of rule) stays.
 */
function planArchitecture(server: ServerContext, body: EditBody): ArchPlan {
  const abs = path.join(server.projectDir, ARCHITECTURE_FILE);
  const rev = readRevision(abs);
  const before = rev.exists ? rev.text : EMPTY_FILE;
  const parsed = parseYamlText(before, ARCHITECTURE_FILE);
  if (parsed.diagnostics.length > 0 || !isRec(parsed.value)) throw new HttpError(422, "CONFIG_INVALID", `O ${ARCHITECTURE_FILE} tem um erro de sintaxe e não pode ser editado por aqui.`, "Corrija o arquivo na aba YAML.");
  const arch = isRec(parsed.value.architecture) ? parsed.value.architecture : null;
  const listOf = (key: "layers" | "rules"): Rec[] => (arch && Array.isArray(arch[key]) ? (arch[key] as unknown[]).filter(isRec) : []);
  const rawLen = (key: "layers" | "rules"): number => (arch && Array.isArray(arch[key]) ? (arch[key] as unknown[]).length : 0);

  const edits: YamlEdit[] = [];
  const created: { layers: Rec[]; rules: Rec[] } = { layers: [], rules: [] };
  const removals: Array<{ key: "layers" | "rules"; index: number }> = [];
  const upsert = (key: "layers" | "rules", inputs: Array<Rec & { id: string }>, fields: string[], fresh: (input: Rec) => Rec, removed: string[]): void => {
    const existing = listOf(key);
    for (const input of inputs) {
      const index = existing.findIndex((e) => e.id === input.id);
      if (index < 0) {
        created[key].push(fresh(input));
        continue;
      }
      for (const field of fields) {
        if (input[field] === undefined || same(input[field], (existing[index] as Rec)[field])) continue;
        edits.push({ op: "set", path: ["architecture", key, index, field], value: input[field] });
      }
    }
    for (const id of removed) {
      const index = existing.findIndex((e) => e.id === id);
      if (index >= 0) removals.push({ key, index });
    }
  };
  upsert("layers", body.layers as never, ["label", "paths"], (l) => ({ id: l.id, ...(l.label ? { label: l.label } : {}), paths: l.paths }), body.removeLayers);
  upsert("rules", body.rules as never, ["from", "to", "blocking"], (r) => ({ id: r.id, kind: "forbidden-dependency", from: r.from, to: r.to, ...(r.blocking === undefined ? {} : { blocking: r.blocking }) }), body.removeRules);

  if (arch === null) {
    if (created.layers.length + created.rules.length > 0) edits.push({ op: "set", path: ["architecture"], value: { ...(created.layers.length > 0 ? { layers: created.layers } : {}), ...(created.rules.length > 0 ? { rules: created.rules } : {}) } });
  } else {
    for (const key of ["layers", "rules"] as const) {
      if (created[key].length === 0) continue;
      if (rawLen(key) === 0) edits.push({ op: "set", path: ["architecture", key], value: created[key] });
      else created[key].forEach((item, k) => edits.push({ op: "set", path: ["architecture", key, rawLen(key) + k], value: item }));
    }
  }
  for (const r of removals.sort((a, b) => b.index - a.index)) edits.push({ op: "delete", path: ["architecture", r.key, r.index] });

  const after = edits.length === 0 ? before : patchYamlText(before, edits).text;
  const value = parseYamlText(after, ARCHITECTURE_FILE).value;
  const schema = validateDocument("architecture", value, ARCHITECTURE_FILE);
  if (schema.length > 0) throw new HttpError(422, "CONFIG_INVALID", `O ${ARCHITECTURE_FILE} ficaria inválido: ${schema[0]?.message}`, null, { path: schema[0]?.path });
  const refs = architectureReferenceProblems(value)[0];
  if (refs) throw new HttpError(422, refs.code === "REF_LAYER_UNKNOWN" ? "LAYER_UNKNOWN" : "DUPLICATE_ID", refs.code === "REF_LAYER_UNKNOWN" ? `A camada ${refs.params.id} não existe no ${ARCHITECTURE_FILE}.` : `O identificador ${refs.params.id} aparece duas vezes no ${ARCHITECTURE_FILE}.`, null, { path: refs.segments.join(".") });
  return { exists: rev.exists, before, after, edits, revision: rev.hash };
}

const idSchema = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 80 };
const editSchema = {
  type: "object",
  additionalProperties: false,
  required: ["layers", "rules", "removeLayers", "removeRules"],
  properties: {
    layers: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, required: ["id", "paths"], properties: { id: idSchema, label: { type: "string", minLength: 1, maxLength: 120 }, paths: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 300 } } } } },
    rules: { type: "array", maxItems: 200, items: { type: "object", additionalProperties: false, required: ["id", "from", "to"], properties: { id: idSchema, from: idSchema, to: { type: "array", minItems: 1, maxItems: 50, items: idSchema }, blocking: { type: "boolean" } } } },
    removeLayers: { type: "array", maxItems: 100, items: idSchema },
    removeRules: { type: "array", maxItems: 200, items: idSchema },
    expectedRevision: { type: ["string", "null"], pattern: HASH_PATTERN },
  },
};

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/config/architecture/proposal",
    handler({ server }) {
      return { status: 200, json: proposal(server) };
    },
  },
  {
    // What a save would write: the diff of .jgates/architecture.yml (nothing is written).
    method: "POST",
    path: "/api/config/architecture/preview",
    body: editSchema,
    handler({ body, server }) {
      const plan = planArchitecture(server, body as EditBody);
      return { status: 200, json: { schemaVersion: 1, status: "OK", file: ARCHITECTURE_FILE, exists: plan.exists, revision: plan.revision, changed: plan.after !== plan.before, diff: unifiedDiff(plan.exists ? plan.before : "", plan.after, { oldLabel: plan.exists ? `a/${ARCHITECTURE_FILE}` : "/dev/null", newLabel: `b/${ARCHITECTURE_FILE}` }) } };
    },
  },
  {
    method: "PUT",
    path: "/api/config/architecture",
    body: editSchema,
    handler({ body, server }) {
      assertWritable();
      const b = body as EditBody;
      const plan = planArchitecture(server, b);
      if (plan.exists && plan.after === plan.before) return { status: 200, json: describe(server) };
      if (plan.exists) patchConfigFile(server, ARCHITECTURE_FILE, "architecture", plan.edits, b.expectedRevision ?? (plan.revision as string));
      else {
        const abs = path.join(server.projectDir, ARCHITECTURE_FILE);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        writeBytesAtomic(abs, Buffer.from(plan.after, "utf8"), {
          verify: () => {
            if (readRevision(abs).exists) throw new HttpError(409, "FILE_EXISTS", `O arquivo ${ARCHITECTURE_FILE} já existe.`, "Recarregue a tela.");
          },
        });
      }
      server.log("architecture layers and rules saved");
      return { status: 200, json: describe(server) };
    },
  },
  {
    method: "GET",
    path: "/api/config/architecture",
    handler({ server }) {
      return { status: 200, json: describe(server) };
    },
  },
  {
    method: "PUT",
    path: "/api/config/architecture/rules/:id",
    params: { type: "object", properties: { id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" } } },
    body: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "expectedRevision"],
      properties: { enabled: { type: "boolean" }, expectedRevision: { type: "string", pattern: HASH_PATTERN } },
    },
    handler({ params, body, server }) {
      assertWritable();
      const b = body as { enabled: boolean; expectedRevision: string };
      const read = readArchitecture(server.projectDir);
      const index = (read.declaration?.contract.rules ?? []).findIndex((r) => r.id === params.id);
      if (!read.declaration || index < 0) throw new HttpError(404, "RULE_NOT_FOUND", `Não há regra ${params.id} no ${ARCHITECTURE_FILE}.`);
      patchConfigFile(server, ARCHITECTURE_FILE, "architecture", [{ op: "set", path: ["architecture", "rules", index, "enabled"], value: b.enabled }], b.expectedRevision);
      server.log(`architecture rule ${params.id} enabled=${b.enabled}`);
      return { status: 200, json: describe(server) };
    },
  },
];
