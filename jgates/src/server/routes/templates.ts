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
import { cachedProject, invalidateProjectCache, projectInventory, projectResolve } from "../../core/cache/project.js";
import { type ResolveIssue } from "../../core/config/resolve/index.js";
import { templateOps } from "../../core/config/resolve/layers.js";
import { TemplateGraph } from "../../core/config/resolve/templates.js";
import { builtinTemplateText } from "../../core/catalog/index.js";
import { unifiedDiff } from "../../core/documents/diff.js";
import type { Classification } from "../../core/discovery/types.js";
import { getLocale } from "../../i18n/index.js";
import { HttpError, refuseMsg, routeText } from "../http.js";
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
  throw refuseMsg(403, "GOVERNED_LOCKED", "route_governed_locked", { policy: governed?.policy ?? "governed" });
}

export function conflict(currentRevision: string | null, file: string): HttpError {
  return refuseMsg(409, "REVISION_CONFLICT", "route_revision_conflict", { file }, { currentRevision });
}

/**
 * Patches one YAML file of the project: the revision the person read must still be the one on disk, the result must
 * not bring a schema or syntax problem the file did not already have, and the write is atomic.
 */
export function patchConfigFile(server: ServerContext, file: string, kind: "root" | "architecture", edits: YamlEdit[], expectedRevision: string | null): { revision: string | null } {
  const abs = path.join(server.projectDir, file);
  const current = readRevision(abs);
  if (!current.exists) throw refuseMsg(404, "FILE_MISSING", "route_file_missing", { file }, { file });
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
      throw refuseMsg(422, "CONFIG_INVALID", "route_invalid_after", { file, message: message ?? "" }, { file, path: pathPart });
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
  /** A file in .jgates/templates/ that jgates.yml does not reference ("Usar neste projeto"). */
  unreferenced: boolean;
}

const normalizeSource = (source: unknown): string => (typeof source === "string" ? source.replace(/\\/g, "/").replace(/^\.\//, "") : "");

/** The template files of the project (.jgates/templates/*.yml), with the identifier each one answers to. */
function projectTemplateFiles(server: ServerContext): Array<{ id: string; source: string }> {
  const dir = path.join(server.projectDir, TEMPLATES_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name)).map((e) => e.name).sort();
  } catch {
    return [];
  }
  const out: Array<{ id: string; source: string }> = [];
  for (const name of names) {
    const source = `${TEMPLATES_DIR}/${name}`;
    let id = name.replace(/\.ya?ml$/i, "");
    try {
      const value = parseYamlText(fs.readFileSync(path.join(dir, name), "utf8"), source).value;
      if (isRec(value) && typeof value.id === "string" && new RegExp(ID_PATTERN).test(value.id)) id = value.id;
    } catch {
      // An unreadable file is listed under its name; the row says so.
    }
    if (new RegExp(ID_PATTERN).test(id)) out.push({ id, source });
  }
  return out;
}

/** Approvable components a match selects (a template without a match selects none: it is applied by activation). */
function matching(match: { languages: string[]; frameworks: string[] }, components: Classification[]): string[] {
  if (match.languages.length === 0 && match.frameworks.length === 0) return [];
  return components
    .filter((c) => (match.languages.length === 0 || (c.language !== null && match.languages.includes(c.language))) && (match.frameworks.length === 0 || (c.framework !== null && match.frameworks.includes(c.framework))))
    .map((c) => c.id);
}

/**
 * A template that comes in by a file (docker-hadolint: a Dockerfile) has no language or framework to select
 * components with, but its state says whether the file is there: when it is, the template applies to every component
 * (to the workspace root, "." , when discovery found none); when it is not, to none.
 */
function byEvidence(state: { reason: string } | undefined, match: { languages: string[]; frameworks: string[] }, components: Classification[]): string[] {
  if (match.languages.length > 0 || match.frameworks.length > 0) return [];
  if (state?.reason !== "DETECTED" && state?.reason !== "REQUESTED") return [];
  return components.length > 0 ? components.map((c) => c.id) : ["."];
}

/**
 * The Templates screen, from the project cache (core/cache/project.ts) while the configuration and the files discovery
 * read stay the same. A write clears the cache and answers with the view built once after it.
 */
function describe(server: ServerContext): Rec {
  const mode = modeOf();
  return cachedProject(`templates-view:${JSON.stringify([getLocale(), mode.mode, mode.governed])}`, [server.projectDir], () => buildDescription(server));
}

function describeAfterWrite(server: ServerContext): Rec {
  invalidateProjectCache();
  return describe(server);
}

function buildDescription(server: ServerContext): Rec {
  const root = readRevision(path.join(server.projectDir, ROOT_FILE));
  const parsedRoot = root.exists ? parseYamlText(root.text, ROOT_FILE) : null;
  const declaredList = isRec(parsedRoot?.value) && Array.isArray((parsedRoot?.value as Rec).templates) ? ((parsedRoot?.value as Rec).templates as unknown[]) : null;
  const resolved = projectResolve(server.projectDir);
  const states = new Map([...resolved.templates.active, ...resolved.templates.inactive].map((s) => [s.id, s]));
  const components = projectInventory(server.projectDir).classifications.filter((c) => c.approvable);

  const entries: Array<{ id: string; entry: Rec; declared: boolean; unreferenced?: boolean }> = [];
  for (const raw of declaredList ?? []) if (isRec(raw) && typeof raw.id === "string") entries.push({ id: raw.id, entry: raw, declared: true });
  if (declaredList === null) for (const [id, s] of states) entries.push({ id, entry: { source: s.source }, declared: false });
  for (const item of listBuiltinTemplates()) if (!entries.some((e) => e.entry.source === item.ref || e.id === item.id)) entries.push({ id: item.id, entry: { source: item.ref, enabled: false }, declared: false });
  for (const file of projectTemplateFiles(server)) {
    if (entries.some((e) => normalizeSource(e.entry.source) === file.source || e.id === file.id)) continue;
    entries.push({ id: file.id, entry: { source: file.source, enabled: false }, declared: false, unreferenced: true });
  }

  const rows: Row[] = entries.map(({ id, entry, declared, unreferenced }) => {
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
      label: builtinTemplateText(source, value).label ?? id,
      description: builtinTemplateText(source, value).description,
      source,
      origin: source.startsWith("builtin:") ? "builtin" : "project",
      declared,
      enabled,
      activation,
      required: activation === "always" && enabled,
      status: state?.reason ?? (enabled ? "UNKNOWN" : "DISABLED"),
      match,
      components: activation === "always" ? components.map((c) => c.id) : matching(match, components).length > 0 ? matching(match, components) : byEvidence(state, match, components),
      support,
      extends: strings(value.extends),
      problem: node === null ? routeText("route_template_unreadable") : null,
      unreferenced: unreferenced === true,
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
  if (!row) throw refuseMsg(404, "TEMPLATE_NOT_FOUND", "route_template_not_found", { id });
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
    return { ref, file: node.file, label: builtinTemplateText(ref, node.value).label ?? ref, parents: node.parents, sets, overrides };
  });
  const loaded = loadSource(server, row.source);
  const yamlText = loaded ? (row.source.startsWith("builtin:") ? stringify(loaded.value, { lineWidth: 0 }) : fs.readFileSync(path.join(server.projectDir, row.source), "utf8")) : "";
  const model = row.origin === "project" && loaded ? editableModel(loaded.value, id) : null;
  // Where the template is listed in jgates.yml (templates[<entry>]): its activation, match and priority are edited there.
  const rootValue = parseYamlText(readRevision(path.join(server.projectDir, ROOT_FILE)).text, ROOT_FILE).value;
  const listed = isRec(rootValue) && Array.isArray(rootValue.templates) ? (rootValue.templates as unknown[]).findIndex((e) => isRec(e) && e.id === id) : -1;
  return { schemaVersion: 1, status: "OK", template: row, chain, errors, model, entry: listed >= 0 ? listed : null, yaml: { text: yamlText, file: loaded?.file ?? row.source, readOnly: row.origin === "builtin" } };
}

/** The key of the generic-command check a project template file declares (the model of "Criar template"), or null. */
function checkKey(value: Rec, id: string): string | null {
  const config = isRec(value.config) ? value.config : null;
  const tools = config && isRec(config.tools) ? config.tools : null;
  if (!tools) return null;
  const generic = Object.entries(tools).filter(([, tool]) => isRec(tool) && tool.adapter === "generic-command" && typeof tool.command === "string");
  const own = generic.find(([key]) => key === `${id}-check`);
  return (own ?? (generic.length === 1 ? generic[0] : undefined))?.[0] ?? null;
}

/** What the guided editor can edit: a file with one generic-command check. A hand-written shape is edited as YAML. */
function editableModel(value: Rec, id: string): Rec | null {
  const key = checkKey(value, id);
  if (key === null) return null;
  const tool = ((value.config as Rec).tools as Rec)[key] as Rec;
  const inner = isRec(tool.config) ? tool.config : {};
  const match = isRec(value.match) ? value.match : {};
  const evidence = isRec(inner.evidence) ? inner.evidence : { kind: "exit-code" };
  const effects = isRec(inner.effects) ? inner.effects : {};
  return {
    label: typeof value.label === "string" ? value.label : id,
    languages: strings(match.languages),
    frameworks: strings(match.frameworks),
    command: [tool.command as string, ...strings(tool.args)],
    capability: strings(tool.capabilities)[0] ?? "",
    effects: Object.fromEntries(EFFECTS.map((k) => [k, typeof effects[k] === "boolean" ? effects[k] : k === "readsCode" || k === "executesProjectCode"])),
    evidence: evidence.kind === "test-runner" && typeof evidence.runner === "string" ? { kind: "test-runner", runner: evidence.runner } : { kind: "exit-code" },
    extraCapabilities: strings(tool.capabilities).length > 1,
  };
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

const HEADER = (id: string): string => routeText("route_template_header", { id });

const matchOf = (languages: string[], frameworks: string[]): Rec => ({ ...(languages.length > 0 ? { languages } : {}), ...(frameworks.length > 0 ? { frameworks } : {}) });

function rootOf(server: ServerContext): { text: string; hash: string; list: unknown[] | null } {
  const root = readRevision(path.join(server.projectDir, ROOT_FILE));
  if (!root.exists) throw refuseMsg(422, "ROOT_MISSING", "route_root_missing");
  const value = parseYamlText(root.text, ROOT_FILE).value;
  return { text: root.text, hash: root.hash as string, list: isRec(value) && Array.isArray(value.templates) ? (value.templates as unknown[]) : null };
}

/** The edit of jgates.yml that registers a project template (the implicit base comes along when the list did not exist). */
function registerEdit(list: unknown[] | null, id: string, relative: string, languages: string[], frameworks: string[]): YamlEdit {
  const hasMatch = languages.length + frameworks.length > 0;
  const entry: Rec = { id, source: relative, activation: hasMatch ? "detected" : "manual", ...(hasMatch ? { match: matchOf(languages, frameworks) } : {}) };
  const implicit: Rec[] = [{ id: "base", source: "builtin:base", activation: "always" }];
  return list === null ? { op: "set", path: ["templates"], value: [...implicit, entry] } : { op: "set", path: ["templates", list.length], value: entry };
}

interface Change {
  file: string;
  before: string | null;
  after: string;
}

interface Plan {
  changes: Change[];
  /** Applies the plan: writes the files, jgates.yml last; undoes the file when jgates.yml refuses. */
  apply(expectedRevision: string): void;
}

function checkBody(body: CreateBody): void {
  if (body.evidence?.kind === "test-runner" && !body.evidence.runner) throw refuseMsg(400, "EVIDENCE_RUNNER_REQUIRED", "route_evidence_runner_required");
}

function planCreate(server: ServerContext, body: CreateBody): Plan {
  const root = rootOf(server);
  if ((root.list ?? []).some((e) => isRec(e) && e.id === body.id) || getBuiltinTemplate(body.id)) throw refuseMsg(409, "TEMPLATE_EXISTS", "route_template_exists", { id: body.id });
  checkBody(body);
  const model = templateModel(body);
  const problems = validateDocument("template", model, `${TEMPLATES_DIR}/${body.id}.yml`);
  if (problems.length > 0) throw refuseMsg(422, "TEMPLATE_INVALID", "route_template_invalid", { message: problems[0]?.message ?? "" }, { path: problems[0]?.path });

  const relative = `${TEMPLATES_DIR}/${body.id}.yml`;
  const abs = path.join(server.projectDir, relative);
  if (fs.existsSync(abs)) throw refuseMsg(409, "TEMPLATE_FILE_EXISTS", "route_template_file_exists", { file: relative });
  const text = HEADER(body.id) + stringify(model, { lineWidth: 0 });
  const edit = registerEdit(root.list, body.id, relative, body.languages ?? [], body.frameworks ?? []);
  const rootAfter = patchYamlText(root.text, [edit]).text;
  return {
    changes: [
      { file: relative, before: null, after: text },
      { file: ROOT_FILE, before: root.text, after: rootAfter },
    ],
    apply(expectedRevision) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      try {
        fs.writeFileSync(abs, text, { flag: "wx", mode: 0o644 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw refuseMsg(409, "TEMPLATE_FILE_EXISTS", "route_template_file_exists_race", { file: relative });
        throw error;
      }
      try {
        patchConfigFile(server, ROOT_FILE, "root", [edit], expectedRevision);
      } catch (error) {
        fs.rmSync(abs, { force: true });
        throw error;
      }
    },
  };
}

/** Edits a project template by patch: the comments and the keys the person added by hand stay. */
function planEdit(server: ServerContext, id: string, body: CreateBody): Plan {
  const view = describe(server) as { templates: Row[] };
  const row = view.templates.find((r) => r.id === id);
  if (!row) throw refuseMsg(404, "TEMPLATE_NOT_FOUND", "route_template_not_found", { id });
  if (row.origin !== "project") throw refuseMsg(409, "TEMPLATE_BUILTIN", "route_template_builtin_edit", { id });
  checkBody(body);
  const abs = path.join(server.projectDir, row.source);
  const current = readRevision(abs);
  if (!current.exists) throw refuseMsg(404, "FILE_MISSING", "route_file_missing", { file: row.source });
  const parsed = parseYamlText(current.text, row.source).value;
  const key = isRec(parsed) ? checkKey(parsed, id) : null;
  if (!isRec(parsed) || key === null) throw refuseMsg(422, "TEMPLATE_NOT_EDITABLE", "route_template_not_editable", { id });
  const [command, ...args] = body.command;
  const effects = { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false, ...(body.effects ?? {}) };
  const tool = ["config", "tools", key];
  const hasMatch = (body.languages ?? []).length + (body.frameworks ?? []).length > 0;
  const fileEdits: YamlEdit[] = [
    { op: "set", path: ["label"], value: body.label && body.label.trim() !== "" ? body.label.trim() : id },
    hasMatch ? { op: "set", path: ["match"], value: matchOf(body.languages ?? [], body.frameworks ?? []) } : { op: "delete", path: ["match"] },
    { op: "set", path: [...tool, "command"], value: command },
    { op: "set", path: [...tool, "args"], value: args },
    { op: "set", path: [...tool, "capabilities"], value: [body.capability] },
    { op: "set", path: [...tool, "config", "effects"], value: effects },
    { op: "set", path: [...tool, "config", "evidence"], value: body.evidence ?? { kind: "exit-code" } },
  ].filter((e) => !(e.op === "delete" && !("match" in parsed))) as YamlEdit[];
  const after = patchYamlText(current.text, fileEdits).text;
  const problems = validateDocument("template", parseYamlText(after, row.source).value, row.source);
  if (problems.length > 0) throw refuseMsg(422, "TEMPLATE_INVALID", "route_template_invalid", { message: problems[0]?.message ?? "" }, { path: problems[0]?.path });

  const root = rootOf(server);
  const index = (root.list ?? []).findIndex((e) => isRec(e) && e.id === id);
  const entryEdits: YamlEdit[] =
    index < 0
      ? []
      : [
          { op: "set", path: ["templates", index, "activation"], value: hasMatch ? "detected" : "manual" },
          hasMatch ? { op: "set", path: ["templates", index, "match"], value: matchOf(body.languages ?? [], body.frameworks ?? []) } : { op: "delete", path: ["templates", index, "match"] },
        ].filter((e) => !(e.op === "delete" && !(isRec((root.list as unknown[])[index]) && "match" in ((root.list as unknown[])[index] as Rec)))) as YamlEdit[];
  const rootAfter = entryEdits.length > 0 ? patchYamlText(root.text, entryEdits).text : root.text;
  return {
    changes: [
      { file: row.source, before: current.text, after },
      ...(rootAfter !== root.text ? [{ file: ROOT_FILE, before: root.text, after: rootAfter }] : []),
    ],
    apply(expectedRevision) {
      patchYamlFile(abs, fileEdits, { expectedHash: current.hash as string });
      if (entryEdits.length === 0) return;
      try {
        patchConfigFile(server, ROOT_FILE, "root", entryEdits, expectedRevision);
      } catch (error) {
        fs.writeFileSync(abs, current.text);
        throw error;
      }
    },
  };
}

function previewOf(plan: Plan): Rec {
  return {
    schemaVersion: 1,
    status: "OK",
    changed: plan.changes.some((c) => c.before !== c.after),
    files: plan.changes.map((c) => ({ file: c.file, created: c.before === null, diff: unifiedDiff(c.before ?? "", c.after, { oldLabel: c.before === null ? "/dev/null" : `a/${c.file}`, newLabel: `b/${c.file}` }) })),
  };
}

function create(server: ServerContext, body: CreateBody): Rec {
  const root = rootOf(server);
  planCreate(server, body).apply(root.hash);
  server.log(`project template created: ${TEMPLATES_DIR}/${body.id}.yml`);
  return describeAfterWrite(server);
}

function edit(server: ServerContext, id: string, body: CreateBody, expectedRevision: string): Rec {
  planEdit(server, id, body).apply(expectedRevision);
  server.log(`project template edited: ${id}`);
  return describeAfterWrite(server);
}

/** "Apagar": the entry leaves jgates.yml and the file of .jgates/templates/ goes; a template of the catalogue cannot go. */
function remove(server: ServerContext, id: string, expectedRevision: string): Rec {
  const view = describe(server) as { templates: Row[] };
  const row = view.templates.find((r) => r.id === id);
  if (!row) throw refuseMsg(404, "TEMPLATE_NOT_FOUND", "route_template_not_found", { id });
  if (row.origin !== "project") throw refuseMsg(409, "TEMPLATE_BUILTIN", "route_template_builtin_delete", { id });
  if (row.activation === "always" && row.declared) throw refuseMsg(409, "TEMPLATE_REQUIRED", "route_template_required_delete", { id });
  const source = normalizeSource(row.source);
  if (!source.startsWith(`${TEMPLATES_DIR}/`) || source.includes("..")) throw refuseMsg(409, "TEMPLATE_OUTSIDE", "route_template_outside", { file: row.source, dir: TEMPLATES_DIR });
  const root = rootOf(server);
  const index = (root.list ?? []).findIndex((e) => isRec(e) && e.id === id);
  if (index >= 0) patchConfigFile(server, ROOT_FILE, "root", [{ op: "delete", path: ["templates", index] }], expectedRevision);
  fs.rmSync(path.join(server.projectDir, source), { force: true });
  server.log(`project template deleted: ${source}`);
  return describeAfterWrite(server);
}

/** "Usar neste projeto": registers a file of .jgates/templates/ that jgates.yml did not reference. */
function adopt(server: ServerContext, id: string, expectedRevision: string): Rec {
  const view = describe(server) as { templates: Row[] };
  const row = view.templates.find((r) => r.id === id);
  if (!row) throw refuseMsg(404, "TEMPLATE_NOT_FOUND", "route_template_not_found", { id });
  if (!row.unreferenced) throw refuseMsg(409, "TEMPLATE_REFERENCED", "route_template_referenced", { id });
  const root = rootOf(server);
  patchConfigFile(server, ROOT_FILE, "root", [registerEdit(root.list, id, normalizeSource(row.source), [...row.match.languages], [...row.match.frameworks])], expectedRevision);
  server.log(`project template adopted: ${row.source}`);
  return describeAfterWrite(server);
}

function setEnabled(server: ServerContext, id: string, enabled: boolean, expectedRevision: string | null): Rec {
  const root = readRevision(path.join(server.projectDir, ROOT_FILE));
  if (!root.exists) throw refuseMsg(422, "ROOT_MISSING", "route_root_missing");
  // The view the person saw (from the cache when it is current): the only view built before the write.
  const view = describe(server) as { templates: Row[] };
  const row = view.templates.find((r) => r.id === id);
  if (!row) throw refuseMsg(404, "TEMPLATE_NOT_FOUND", "route_template_not_found", { id });
  if (!enabled && row.activation === "always") throw refuseMsg(409, "TEMPLATE_REQUIRED", "route_template_required_off", { id });
  const value = parseYamlText(root.text, ROOT_FILE).value;
  const list = isRec(value) && Array.isArray(value.templates) ? (value.templates as unknown[]) : null;
  const index = (list ?? []).findIndex((e) => isRec(e) && e.id === id);
  let edits: YamlEdit[];
  if (index >= 0) edits = [{ op: "set", path: ["templates", index, "enabled"], value: enabled }];
  else {
    // Copies: the cached view is frozen and the edits go to the YAML writer.
    const entry: Rec = { id, source: row.source, activation: row.activation, ...(row.match.languages.length + row.match.frameworks.length > 0 ? { match: { ...(row.match.languages.length > 0 ? { languages: [...row.match.languages] } : {}), ...(row.match.frameworks.length > 0 ? { frameworks: [...row.match.frameworks] } : {}) } } : {}), enabled };
    const implicit: Rec[] = view.templates.filter((r) => r.declared || r.enabled).map((r) => ({ id: r.id, source: r.source, activation: r.activation, ...(r.match.languages.length + r.match.frameworks.length > 0 ? { match: { ...(r.match.languages.length > 0 ? { languages: [...r.match.languages] } : {}), ...(r.match.frameworks.length > 0 ? { frameworks: [...r.match.frameworks] } : {}) } } : {}) }));
    edits = list === null ? [{ op: "set", path: ["templates"], value: [...implicit.filter((e) => e.id !== id), entry] }] : [{ op: "set", path: ["templates", list.length], value: entry }];
  }
  patchConfigFile(server, ROOT_FILE, "root", edits, expectedRevision);
  return describeAfterWrite(server);
}

const effectsSchema = { type: "object", additionalProperties: false, properties: Object.fromEntries(EFFECTS.map((k) => [k, { type: "boolean" }])) };

function createBodySchema(required: string[], extra: Rec, withId = true): Rec {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties: {
      ...(withId ? { id: { type: "string", pattern: ID_PATTERN } } : {}),
      label: { type: "string", maxLength: 120 },
      languages: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 60 } },
      frameworks: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 60 } },
      command: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1, maxLength: 1024, pattern: "^[^\\u0000\\n\\r]+$" } },
      capability: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 60 },
      effects: effectsSchema,
      evidence: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { enum: ["exit-code", "test-runner"] }, runner: { enum: ["go-test", "cargo-test"] } } },
      ...extra,
    },
  };
}

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
    body: createBodySchema(["id", "command", "capability"], {}),
    handler({ body, server }) {
      assertWritable();
      return { status: 201, json: create(server, body as CreateBody) };
    },
  },
  {
    // What a save would write (the new file and the entry of jgates.yml, or the edit of both): nothing is written.
    method: "POST",
    path: "/api/config/template-preview",
    body: createBodySchema(["id", "command", "capability"], { edit: { type: "boolean" } }),
    handler({ body, server }) {
      const b = body as CreateBody & { edit?: boolean };
      return { status: 200, json: previewOf(b.edit === true ? planEdit(server, b.id, b) : planCreate(server, b)) };
    },
  },
  {
    method: "PUT",
    path: "/api/config/templates/:id",
    params: { type: "object", properties: { id: { type: "string", pattern: ID_PATTERN } } },
    body: createBodySchema(["command", "capability", "expectedRevision"], { expectedRevision: { type: "string", pattern: HASH_PATTERN } }, false),
    handler({ params, body, server }) {
      assertWritable();
      const b = body as CreateBody & { expectedRevision: string };
      return { status: 200, json: edit(server, params.id as string, { ...b, id: params.id as string }, b.expectedRevision) };
    },
  },
  {
    method: "DELETE",
    path: "/api/config/templates/:id",
    params: { type: "object", properties: { id: { type: "string", pattern: ID_PATTERN } } },
    query: { type: "object", required: ["expectedRevision"], additionalProperties: false, properties: { expectedRevision: { type: "string", pattern: HASH_PATTERN } } },
    handler({ params, query, server }) {
      assertWritable();
      return { status: 200, json: remove(server, params.id as string, query.expectedRevision as string) };
    },
  },
  {
    method: "POST",
    path: "/api/config/templates/:id/adopt",
    params: { type: "object", properties: { id: { type: "string", pattern: ID_PATTERN } } },
    body: { type: "object", additionalProperties: false, required: ["expectedRevision"], properties: { expectedRevision: { type: "string", pattern: HASH_PATTERN } } },
    handler({ params, body, server }) {
      assertWritable();
      return { status: 200, json: adopt(server, params.id as string, (body as { expectedRevision: string }).expectedRevision) };
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
