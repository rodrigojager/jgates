// Configuração > Arquitetura: the map drawn from .jgates/architecture.yml, the rules with their toggle ("Bloqueia"), the
// adapters that verify each one, the dependencies the last run could not resolve, the owner of each rule (source or
// generated) and the native configuration generated for the tools, read only. The toggle writes `enabled` into the rule
// by patch, so the comments of the file stay.
import fs from "node:fs";
import path from "node:path";
import { listRuns } from "../../core/artifacts/index.js";
import { ARCHITECTURE_FILE, readArchitecture, type ArchitectureRule } from "../../core/architecture/index.js";
import { readRevision } from "../../core/codecs/yaml/index.js";
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

export const routes: RouteDefinition[] = [
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
