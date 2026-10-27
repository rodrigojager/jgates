// Configuração > Templates: the templates of the catalog and of the project with the toggle, the badge (Obrigatório,
// "N componentes", "Sem correspondência"), the detail (application, inheritance field by field, compatibility, YAML) and
// "Criar template", which writes a project template into .jgates/templates/ from the generic-command model and registers
// it in jgates.yml by patch (comments stay).
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { getBuiltinTemplate, listBuiltinTemplates } from "../../builtin/index.js";
import { patchYamlFile, patchYamlText, readRevision, YamlPatchError, type YamlEdit } from "../../core/codecs/yaml/index.js";
import { ROOT_FILE, parseYamlText, validateDocument } from "../../core/config/load/index.js";
import { resolveConfig, type ResolveIssue } from "../../core/config/resolve/index.js";
import { templateOps } from "../../core/config/resolve/layers.js";
import { TemplateGraph } from "../../core/config/resolve/templates.js";
import { discoverWorkspace } from "../../core/discovery/index.js";
import type { Classification } from "../../core/discovery/types.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { modeOf } from "./workspaces.js";

type Rec = Record<string, unknown>;

export const TEMPLATES_DIR = ".jgates/templates";
const ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";
const HASH_PATTERN = "^[0-9a-f]{64}$";

const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The governed mode fixes the configuration: every write of the Configuração tabs is refused with the reason. */
export function assertWritable(): void {
  const { mode, governed } = modeOf();
  if (mode !== "governed") return;
  throw new HttpError(403, "GOVERNED_LOCKED", `Modo governado: a configuração é fixada pela política ${governed?.policy ?? "governada"} e não pode ser alterada aqui.`, "Mude a política governada fora do checkout; o modo local continua editável.");
}

export function conflict(currentRevision: string | null, file: string): HttpError {
  return new HttpError(409, "REVISION_CONFLICT", `O ${file} mudou desde que foi lido.`, "Recarregue a tela para ver a versão atual antes de salvar de novo.", { currentRevision });
}

/**
 * Patches one YAML file of the project: the revision the person read must still be the one on disk, the result must
 * not bring a schema or syntax problem the file did not already have, and the write is atomic.
 */
export function patchConfigFile(server: ServerContext, file: string, kind: "root" | "architecture", edits: YamlEdit[], expectedRevision: string | null): { revision: string | null } {
  const abs = path.join(server.projectDir, file);
  const current = readRevision(abs);
  if (!current.exists) throw new HttpError(404, "FILE_MISSING", `O arquivo ${file} não existe.`, null, { file });
  if (expectedRevision !== undefined && expectedRevision !== current.hash) throw conflict(current.hash, file);
  try {
    const next = patchYamlText(current.text, edits);
    const problems = (text: string): string[] => {
      const parsed = parseYamlText(text, file);
      const all = [...parsed.diagnostics, ...(parsed.value === undefined || kind === "architecture" ? [] : validateDocument(kind, parsed.value, file, { doc: parsed.doc, lineCounter: parsed.lineCounter }))];
      return all.map((d) => `${d.path}|${d.message}`);
    };
    const before = new Set(problems(current.text));
    const fresh = problems(next.text).filter((p) => !before.has(p));
    if (fresh.length > 0) {
      const [pathPart, message] = (fresh[0] as string).split("|");
      throw new HttpError(422, "CONFIG_INVALID", `O ${file} ficaria inválido: ${message}`, null, { file, path: pathPart });
    }
    patchYamlFile(abs, edits, { expectedHash: current.hash as string });
  } catch (error) {
    if (error instanceof YamlPatchError) {
      if (error.code === "YAML_CONFLICT") throw conflict(readRevision(abs).hash, file);
      throw new HttpError(422, error.code, error.message);
    }
    throw error;
  }
  return { revision: readRevision(abs).hash };
}

interface NodeView {
  ref: string;
  file: string;
  value: Rec;
}

function loadSource(server: ServerContext, source: string): NodeView | null {
  if (source.startsWith("builtin:")) {
    const item = getBuiltinTemplate(source);
    return item ? { ref: item.ref, file: item.file, value: item.value } : null;
  }
  try {
    const abs = path.resolve(server.projectDir, source);
    const rel = path.relative(server.projectDir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const parsed = parseYamlText(fs.readFileSync(abs, "utf8"), rel);
    return isRec(parsed.value) ? { ref: rel.split(path.sep).join("/"), file: rel.split(path.sep).join("/"), value: parsed.value } : null;
  } catch {
    return null;
  }
}

interface Row {
  id: string;
  label: string;
  description: string | null;
  source: string;
  origin: "builtin" | "project";
  declared: boolean;
  enabled: boolean;
  activation: "always" | "detected" | "manual";
  required: boolean;
  status: string;
  match: { languages: string[]; frameworks: string[] };
  components: string[];
  support: { level: string; uncovered: string[] } | null;
  extends: string[];
  problem: string | null;
}

/** Approvable components a match selects (a template without a match selects none: it is applied by activation). */
function matching(match: { languages: string[]; frameworks: string[] }, components: Classification[]): string[] {
  if (match.languages.length === 0 && match.frameworks.length === 0) return [];
  return components
    .filter((c) => (match.languages.length === 0 || (c.language !== null && match.languages.includes(c.language))) && (match.frameworks.length === 0 || (c.framework !== null && match.frameworks.includes(c.framework))))
    .map((c) => c.id);
}

function describe(server: ServerContext): Rec {
  const root = readRevision(path.join(server.projectDir, ROOT_FILE));
  const parsedRoot = root.exists ? parseYamlText(root.text, ROOT_FILE) : null;
  const declaredList = isRec(parsedRoot?.value) && Array.isArray((parsedRoot?.value as Rec).templates) ? ((parsedRoot?.value as Rec).templates as unknown[]) : null;
  const resolved = resolveConfig(server.projectDir);
  const states = new Map([...resolved.templates.active, ...resolved.templates.inactive].map((s) => [s.id, s]));
  const components = discoverWorkspace(server.projectDir).inventory.classifications.filter((c) => c.approvable);

  const entries: Array<{ id: string; entry: Rec; declared: boolean }> = [];
  for (const raw of declaredList ?? []) if (isRec(raw) && typeof raw.id === "string") entries.push({ id: raw.id, entry: raw, declared: true });
  if (declaredList === null) for (const [id, s] of states) entries.push({ id, entry: { source: s.source }, declared: false });
  for (const item of listBuiltinTemplates()) if (!entries.some((e) => e.entry.source === item.ref || e.id === item.id)) entries.push({ id: item.id, entry: { source: item.ref, enabled: false }, declared: false });

  const rows: Row[] = entries.map(({ id, entry, declared }) => {
    const source = typeof entry.source === "string" ? entry.source : "";
    const node = loadSource(server, source);
    const value = node?.value ?? {};
    const rawMatch = isRec(entry.match) ? entry.match : isRec(value.match) ? value.match : {};
    const match = { languages: strings(rawMatch.languages), frameworks: strings(rawMatch.frameworks) };
    const activation = entry.activation === "always" || entry.activation === "manual" || entry.activation === "detected" ? entry.activation : match.languages.length + match.frameworks.length > 0 ? "detected" : "always";
    const enabled = entry.enabled !== false;
    const state = states.get(id);
    const support = isRec(value.support) && typeof value.support.level === "string" ? { level: value.support.level, uncovered: strings(value.support.uncovered) } : null;
    return {
      id,
      label: typeof value.label === "string" ? value.label : id,
      description: typeof value.description === "string" ? value.description : null,
      source,
      origin: source.startsWith("builtin:") ? "builtin" : "project",
      declared,
      enabled,
      activation,
      required: activation === "always" && enabled,
      status: state?.reason ?? (enabled ? "UNKNOWN" : "DISABLED"),
      match,
      components: activation === "always" ? components.map((c) => c.id) : matching(match, components),
      support,
      extends: strings(value.extends),
      problem: node === null ? "Arquivo do template não encontrado ou ilegível." : null,
    };
  });
  rows.sort((a, b) => Number(b.required) - Number(a.required) || (a.origin === b.origin ? a.id.localeCompare(b.id) : a.origin === "project" ? -1 : 1));

  const conflicts = resolved.errors.filter((e: ResolveIssue) => /TEMPLATE|EXTENDS|CONFLICT/.test(e.code)).map((e) => ({ code: e.code, message: e.message, fix: e.fix ?? null, file: e.file ?? null }));
  const layersOrder = resolved.layers.map((l) => ({ layer: l.layer, source: l.source ?? null }));
  const mode = modeOf();
  return { schemaVersion: 1, status: "OK", mode: mode.mode, governed: mode.governed, revision: root.hash, file: ROOT_FILE, templates: rows, conflicts, order: layersOrder, folder: TEMPLATES_DIR };
}

/** The detail of one template: application, inheritance chain, the fields each template sets over its parents, YAML. */
function detail(server: ServerContext, id: string): Rec {
  const list = describe(server) as { templates: Row[] };
  const row = list.templates.find((r) => r.id === id);
  if (!row) throw new HttpError(404, "TEMPLATE_NOT_FOUND", `Não há template com o identificador ${id}.`);
  const errors: string[] = [];
  const graph = new TemplateGraph(server.projectDir, { error: (i) => errors.push(i.message), warning: () => undefined });
  const identity = graph.resolve(row.source, { file: ROOT_FILE, path: `templates.${id}.source` });
  const order = identity ? (graph.linearize(identity) ?? []) : [];
  const seen = new Map<string, { node: string; value: unknown }>();
  const chain = order.map((ref) => {
    const node = graph.node(ref) as { file: string; value: Rec; parents: string[]; ops: ReturnType<typeof templateOps> };
    const overrides: Array<{ pointer: string; value: unknown; previous: unknown; previousNode: string }> = [];
    const sets: Array<{ pointer: string; value: unknown; path: string | null; overrides: boolean }> = [];
    for (const op of node.ops) {
      const before = seen.get(op.pointer);
      if (before) overrides.push({ pointer: op.pointer, value: op.value, previous: before.value, previousNode: before.node });
      sets.push({ pointer: op.pointer, value: op.value, path: op.path, overrides: before !== undefined });
      seen.set(op.pointer, { node: ref, value: op.value });
    }
    return { ref, file: node.file, label: typeof node.value.label === "string" ? node.value.label : ref, parents: node.parents, sets, overrides };
  });
  const loaded = loadSource(server, row.source);
  const yamlText = loaded ? (row.source.startsWith("builtin:") ? stringify(loaded.value, { lineWidth: 0 }) : fs.readFileSync(path.join(server.projectDir, row.source), "utf8")) : "";
  return { schemaVersion: 1, status: "OK", template: row, chain, errors, yaml: { text: yamlText, file: loaded?.file ?? row.source, readOnly: row.origin === "builtin" } };
}

const EFFECTS = ["readsCode", "writesOutputs", "mayChangeCode", "executesProjectCode", "usesNetwork"] as const;

interface CreateBody {
  id: string;
  label?: string;
  languages?: string[];
  frameworks?: string[];
  command: string[];
  capability: string;
  effects?: Partial<Record<(typeof EFFECTS)[number], boolean>>;
  evidence?: { kind: "exit-code" | "test-runner"; runner?: "go-test" | "cargo-test" };
}

/** The model of a project template: it extends the base and declares one generic command (an explicit vector). */
export function templateModel(body: CreateBody): Rec {
  const languages = body.languages ?? [];
  const frameworks = body.frameworks ?? [];
  const [command, ...args] = body.command;
  const effects = { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false, ...(body.effects ?? {}) };
  return {
    schemaVersion: 1,
    id: body.id,
    label: body.label && body.label.trim() !== "" ? body.label.trim() : body.id,
    extends: ["builtin:base"],
    ...(languages.length + frameworks.length > 0 ? { match: { ...(languages.length > 0 ? { languages } : {}), ...(frameworks.length > 0 ? { frameworks } : {}) } } : {}),
    config: {
      tools: {
        [`${body.id}-check`]: {
          adapter: "generic-command",
          enabled: true,
          capabilities: [body.capability],
          command,
          args,
          config: { support: "partial", effects, evidence: body.evidence ?? { kind: "exit-code" } },
        },
      },
    },
  };
}

function create(server: ServerContext, body: CreateBody): Rec {
  const root = readRevision(path.join(server.projectDir, ROOT_FILE));
  if (!root.exists) throw new HttpError(422, "ROOT_MISSING", "Não há jgates.yml neste projeto.", "Crie a configuração antes (jgates init).");
  const value = parseYamlText(root.text, ROOT_FILE).value;
  const list = isRec(value) && Array.isArray(value.templates) ? (value.templates as unknown[]) : null;
  if ((list ?? []).some((e) => isRec(e) && e.id === body.id) || getBuiltinTemplate(body.id)) throw new HttpError(409, "TEMPLATE_EXISTS", `Já existe um template ${body.id}.`, "Escolha outro identificador.");
  if (body.evidence?.kind === "test-runner" && !body.evidence.runner) throw new HttpError(400, "EVIDENCE_RUNNER_REQUIRED", "O contrato test-runner precisa do runner (go-test ou cargo-test).");

  const model = templateModel(body);
  const problems = validateDocument("template", model, `${TEMPLATES_DIR}/${body.id}.yml`);
  if (problems.length > 0) throw new HttpError(422, "TEMPLATE_INVALID", `O template ficaria inválido: ${problems[0]?.message}`, null, { path: problems[0]?.path });

  const relative = `${TEMPLATES_DIR}/${body.id}.yml`;
  const abs = path.join(server.projectDir, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const header = `# Template do projeto ${body.id}. Estende o base e declara uma verificação por comando genérico.\n# Os efeitos declarados valem para o plano: o comando é um vetor (executável e argumentos), nunca uma linha de shell.\n`;
  try {
    fs.writeFileSync(abs, header + stringify(model, { lineWidth: 0 }), { flag: "wx", mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "TEMPLATE_FILE_EXISTS", `O arquivo ${relative} já existe.`, "Escolha outro identificador ou apague o arquivo.");
    throw error;
  }
  const languages = body.languages ?? [];
  const frameworks = body.frameworks ?? [];
  const hasMatch = languages.length + frameworks.length > 0;
  const entry: Rec = { id: body.id, source: relative, activation: hasMatch ? "detected" : "manual", ...(hasMatch ? { match: { ...(languages.length > 0 ? { languages } : {}), ...(frameworks.length > 0 ? { frameworks } : {}) } } : {}) };
  const implicit: Rec[] = [{ id: "base", source: "builtin:base", activation: "always" }];
  const edits: YamlEdit[] = list === null ? [{ op: "set", path: ["templates"], value: [...implicit, entry] }] : [{ op: "set", path: ["templates", list.length], value: entry }];
  try {
    patchConfigFile(server, ROOT_FILE, "root", edits, root.hash as string);
  } catch (error) {
    fs.rmSync(abs, { force: true });
    throw error;
  }
  server.log(`project template created: ${relative}`);
  return describe(server);
}

function setEnabled(server: ServerContext, id: string, enabled: boolean, expectedRevision: string | null): Rec {
  const root = readRevision(path.join(server.projectDir, ROOT_FILE));
  if (!root.exists) throw new HttpError(422, "ROOT_MISSING", "Não há jgates.yml neste projeto.");
  const view = describe(server) as { templates: Row[] };
  const row = view.templates.find((r) => r.id === id);
  if (!row) throw new HttpError(404, "TEMPLATE_NOT_FOUND", `Não há template com o identificador ${id}.`);
  if (!enabled && row.activation === "always") throw new HttpError(409, "TEMPLATE_REQUIRED", `O template ${id} é obrigatório (aplicação sempre): desligá-lo deixaria o plano sem a base.`, "Mude a aplicação no jgates.yml se for intencional.");
  const value = parseYamlText(root.text, ROOT_FILE).value;
  const list = isRec(value) && Array.isArray(value.templates) ? (value.templates as unknown[]) : null;
  const index = (list ?? []).findIndex((e) => isRec(e) && e.id === id);
  let edits: YamlEdit[];
  if (index >= 0) edits = [{ op: "set", path: ["templates", index, "enabled"], value: enabled }];
  else {
    const entry: Rec = { id, source: row.source, activation: row.activation, ...(row.match.languages.length + row.match.frameworks.length > 0 ? { match: { ...(row.match.languages.length > 0 ? { languages: row.match.languages } : {}), ...(row.match.frameworks.length > 0 ? { frameworks: row.match.frameworks } : {}) } } : {}), enabled };
    const implicit: Rec[] = view.templates.filter((r) => r.declared || r.enabled).map((r) => ({ id: r.id, source: r.source, activation: r.activation, ...(r.match.languages.length + r.match.frameworks.length > 0 ? { match: { ...(r.match.languages.length > 0 ? { languages: r.match.languages } : {}), ...(r.match.frameworks.length > 0 ? { frameworks: r.match.frameworks } : {}) } } : {}) }));
    edits = list === null ? [{ op: "set", path: ["templates"], value: [...implicit.filter((e) => e.id !== id), entry] }] : [{ op: "set", path: ["templates", list.length], value: entry }];
  }
  patchConfigFile(server, ROOT_FILE, "root", edits, expectedRevision);
  return describe(server);
}

const effectsSchema = { type: "object", additionalProperties: false, properties: Object.fromEntries(EFFECTS.map((k) => [k, { type: "boolean" }])) };

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/config/templates",
    handler({ server }) {
      return { status: 200, json: describe(server) };
    },
  },
  {
    method: "GET",
    path: "/api/config/templates/:id",
    params: { type: "object", properties: { id: { type: "string", pattern: ID_PATTERN } } },
    handler({ params, server }) {
      return { status: 200, json: detail(server, params.id as string) };
    },
  },
  {
    method: "POST",
    path: "/api/config/templates",
    body: {
      type: "object",
      additionalProperties: false,
      required: ["id", "command", "capability"],
      properties: {
        id: { type: "string", pattern: ID_PATTERN },
        label: { type: "string", maxLength: 120 },
        languages: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 60 } },
        frameworks: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 60 } },
        command: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1, maxLength: 1024, pattern: "^[^\\u0000\\n\\r]+$" } },
        capability: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 60 },
        effects: effectsSchema,
        evidence: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { enum: ["exit-code", "test-runner"] }, runner: { enum: ["go-test", "cargo-test"] } },
        },
      },
    },
    handler({ body, server }) {
      assertWritable();
      return { status: 201, json: create(server, body as CreateBody) };
    },
  },
  {
    method: "PUT",
    path: "/api/config/templates/:id/enabled",
    params: { type: "object", properties: { id: { type: "string", pattern: ID_PATTERN } } },
    body: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "expectedRevision"],
      properties: { enabled: { type: "boolean" }, expectedRevision: { type: "string", pattern: HASH_PATTERN } },
    },
    handler({ params, body, server }) {
      assertWritable();
      const b = body as { enabled: boolean; expectedRevision: string };
      return { status: 200, json: setEnabled(server, params.id as string, b.enabled, b.expectedRevision) };
    },
  },
];
