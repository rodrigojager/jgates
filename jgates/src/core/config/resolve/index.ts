import path from "node:path";
import { translator } from "../../../i18n/index.js";
import { discoverWithSettings, discoverWorkspace, loadWorkspaceSettings, type Inventory } from "../../discovery/index.js";
import { loadProjectConfig, ROOT_FILE } from "../load/index.js";
import { suggestName } from "../load/schema.js";
import { decodePointer, flatten, isDescendant, isPlainObject, type LayerOp } from "./pointer.js";
import { declaresTemplates, defaultLayers, profileOps, projectDocumentOps, type SourcedOps } from "./layers.js";
import { checkProfileChains, collectProjectProfiles, profileChain } from "./profiles.js";
import { FieldStore, getIn, type IssueSink } from "./store.js";
import { selectTemplates, TemplateGraph, type TemplateEntry } from "./templates.js";
import type { FieldLookup, LayerInfo, LayerName, ResolvedProfile, ResolveIssue, ResolveOptions, ResolveResult } from "./types.js";

export * from "./types.js";
export { encodePointer, decodePointer, isListOp } from "./pointer.js";
export { DEFAULT_PROFILE, IMPLICIT_TEMPLATES } from "./layers.js";

/**
 * Resolves the effective configuration of a project, with the origin of every value.
 *
 * Stage 1: the project fragments, the defaults and the call give the template entries, the selected profile and
 * the inventory (discovery). Stage 2: defaults < templates (ancestors first, conflicts are errors) < profile chain
 * (starter profiles first) < project files (fragments before jgates.yml) < call overrides. A template never changes
 * the discovery that activated it. Never throws for configuration problems: they come back in `errors`.
 */
export function resolveConfig(projectDir: string, options: ResolveOptions = {}): ResolveResult {
  const t = translator("config");
  const dir = path.resolve(projectDir);
  const errors: ResolveIssue[] = [];
  const warnings: ResolveIssue[] = [];
  const sink: IssueSink = { error: (e) => errors.push(e), warning: (w) => warnings.push(w) };
  const load = loadProjectConfig(dir, {
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
  });
  const result: ResolveResult = {
    ok: false,
    projectDir: load.projectDir,
    configDir: load.configDir,
    config: {},
    fields: {},
    profile: null,
    templates: { active: [], inactive: [], nodes: [] },
    layers: [],
    warnings,
    errors,
    diagnostics: load.diagnostics,
  };
  if (!load.valid) {
    errors.push({ code: "CONFIG_INVALID", message: t("resolve_config_invalid", { count: load.diagnostics.length }), fix: t("resolve_config_invalid_fix") });
    return result;
  }

  // Parents before the child: the fragments named in extends (declared order), then jgates.yml.
  const docs = [...load.documents.filter((d) => d.kind !== "root"), ...load.documents.filter((d) => d.kind === "root")];
  const defaults = defaultLayers(!docs.some(declaresTemplates));
  const project: SourcedOps[] = docs.map((d) => ({ source: d.file, file: d.file, ops: projectDocumentOps(d) }));
  const call = callLayers(options, sink);
  const missingRemove = options.missingRemove ?? "warning";

  // Stage 1: what selects templates and the profile.
  const first = new FieldStore(missingRemove);
  const quiet: IssueSink = { error: () => undefined, warning: () => undefined };
  applyAll(first, "defaults", defaults, quiet);
  applyAll(first, "project", project, quiet);
  applyAll(first, "call", call, quiet);
  const firstFields = first.resolvedFields();
  const entriesValue = getIn(first.tree(), ["templates"]);
  const entries = (isPlainObject(entriesValue) ? entriesValue : {}) as Record<string, TemplateEntry>;
  const selectedValue = first.get("/selection/profile");
  const selected = typeof selectedValue === "string" ? selectedValue : "";
  const selectedField = firstFields["/selection/profile"];
  const inventory = options.inventory ?? discoverFor(dir, options.configDir);

  const graph = new TemplateGraph(dir, sink, options.limits, load.configDir);
  const selection = selectTemplates(graph, entries, inventory, options.templates ?? [], sink, ROOT_FILE);
  result.templates = { active: selection.active, inactive: selection.inactive, nodes: selection.nodes };

  const projectProfiles = collectProjectProfiles(load.documents, sink);
  const chain = profileChain(selected, projectProfiles, sink, { file: selectedField?.file ?? null, path: selectedField?.path ?? null });
  checkProfileChains(projectProfiles, sink, new Set(chain ? chain.map((d) => d.ref) : [selected]));
  if (chain) {
    const firstWith = (key: string): string | null => {
      const def = chain.find((d) => typeof d.body[key] === "string");
      return def ? (def.body[key] as string) : null;
    };
    result.profile = {
      id: selected,
      label: firstWith("label"),
      description: firstWith("description"),
      chain: chain.map((d) => ({ id: d.ref, file: d.file, path: d.fileSegments.join(".") })),
    } satisfies ResolvedProfile;
  }
  if (errors.length > 0) return result;

  // Stage 2: every layer, weakest first.
  const store = new FieldStore(missingRemove);
  const layers: LayerInfo[] = [];
  const profileLayers: SourcedOps[] = [...(chain ?? [])].reverse().map((d) => ({
    source: d.ref.startsWith("builtin:") ? d.ref : `profile:${d.ref}`,
    file: d.file,
    ops: profileOps(d.body, d.fileSegments),
  }));
  applyAll(store, "defaults", defaults, sink, layers);
  applyAll(store, "template", selection.layers, sink, layers);
  applyAll(store, "profile", profileLayers, sink, layers);
  applyAll(store, "project", project, sink, layers);
  applyAll(store, "call", call, sink, layers);
  result.layers = layers;
  result.config = store.tree();
  result.fields = store.resolvedFields();
  result.ok = errors.length === 0;
  return result;
}

/**
 * The inventory of the project, with the discovery settings (.jgates/workspace.yml) of the configuration folder when
 * it is not the project: a policy decides how its target is discovered.
 */
export function discoverFor(projectDir: string, configDir?: string): Inventory {
  if (configDir === undefined || path.resolve(configDir) === path.resolve(projectDir)) return discoverWorkspace(projectDir).inventory;
  return discoverWithSettings(projectDir, loadWorkspaceSettings(configDir).settings);
}

function applyAll(store: FieldStore, layer: LayerName, groups: SourcedOps[], sink: IssueSink, layers?: LayerInfo[]): void {
  for (const group of groups) {
    layers?.push({ layer, source: group.source, file: group.file });
    for (const op of group.ops) store.apply(op, { layer, source: group.source, file: group.file }, sink);
  }
}

function callLayers(options: ResolveOptions, sink: IssueSink): SourcedOps[] {
  const t = translator("config");
  const out: SourcedOps[] = [];
  if (options.profile !== undefined) out.push({ source: "--profile", file: null, ops: flatten(options.profile, ["selection", "profile"], null) });
  for (const override of options.overrides ?? []) {
    const segments = decodePointer(override.pointer);
    if (!segments || segments.length === 0) {
      sink.error({ code: "BAD_OVERRIDE", message: t("resolve_bad_override", { pointer: override.pointer }), pointer: override.pointer });
      continue;
    }
    const ops: LayerOp[] = flatten(override.value, segments, null);
    const source = override.source ?? "call";
    const last = out[out.length - 1];
    if (last && last.source === source && last.file === null) last.ops.push(...ops);
    else out.push({ source, file: null, ops });
  }
  return out;
}

/** The value at a JSON Pointer of a resolved configuration, with the origin of the leaf or of the leaves under it. */
export function getField(result: ResolveResult, pointer: string): FieldLookup {
  const segments = decodePointer(pointer);
  if (!segments) return { found: false, pointer };
  const field = result.fields[pointer];
  if (field) return { found: true, pointer, value: field.value, field };
  const under = Object.entries(result.fields).filter(([key]) => pointer === "" || isDescendant(key, pointer));
  if (under.length > 0) return { found: true, pointer, value: getIn(result.config, segments), fields: Object.fromEntries(under) };
  const suggestion = suggestName(pointer, Object.keys(result.fields));
  return { found: false, pointer, ...(suggestion ? { suggestion } : {}) };
}
