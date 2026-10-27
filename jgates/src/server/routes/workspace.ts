// Workspace context: root, configuration file, branch and commit, the discovery inventory, the preview of the scope
// and the discovery settings, which are written by patch into .jgates/workspace.yml (comments stay).
import fs from "node:fs";
import path from "node:path";
import { ROOT_FILE, parseYamlText, validateDocument } from "../../core/config/load/index.js";
import { patchYamlFile, patchYamlText, readRevision, YamlPatchError, type YamlEdit } from "../../core/codecs/yaml/index.js";
import {
  DEFAULT_DISCOVERY_LIMITS,
  WORKSPACE_FILE,
  discoverWithSettings,
  discoverWorkspace,
  loadWorkspaceSettings,
  matchesPathOrParent,
  type Classification,
  type DiscoveryMode,
  type Inventory,
  type WorkspaceSettings,
} from "../../core/discovery/index.js";
import { compareStrings, defaultReadDir, walkProject } from "../../core/discovery/walk.js";
import { listBuiltinTemplates } from "../../builtin/index.js";
import { readGitContext } from "../git.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";

const SEED = "schemaVersion: 1\n";
const MAX_LIST = 200;
const MODES = ["auto", "explicit", "report-only"];

type Rec = Record<string, unknown>;

// The last inventory each server showed, so "Detectar novamente" can say what changed since the previous discovery.
const previous = new WeakMap<ServerContext, Inventory>();

const signature = (c: Classification): string =>
  JSON.stringify([c.classificationStatus, c.language, c.framework, c.reasonCode, c.evidencePaths, c.approvable]);
const keyOf = (c: Classification): string => `${c.componentRoot}\u0000${c.language ?? ""}\u0000${c.detectedBy}`;

/** What changed between two inventories: components added, removed or whose status, language or evidence moved. */
function changesBetween(before: Inventory | undefined, after: Inventory): Rec {
  if (!before) return { baseline: true, added: [], removed: [], changed: [] };
  const was = new Map(before.classifications.map((c) => [keyOf(c), c]));
  const now = new Map(after.classifications.map((c) => [keyOf(c), c]));
  const brief = (c: Classification): Rec => ({ id: c.id, componentRoot: c.componentRoot, language: c.language, status: c.classificationStatus });
  const added = [...now].filter(([k]) => !was.has(k)).map(([, c]) => brief(c));
  const removed = [...was].filter(([k]) => !now.has(k)).map(([, c]) => brief(c));
  const changed = [...now]
    .filter(([k, c]) => was.has(k) && signature(was.get(k) as Classification) !== signature(c))
    .map(([k, c]) => ({ ...brief(c), from: (was.get(k) as Classification).classificationStatus }));
  return { baseline: false, added, removed, changed };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The built-in templates each approvable component matches (by language and framework), by classification id. */
function templatesOf(inventory: Inventory): Record<string, string[]> {
  const templates = listBuiltinTemplates().flatMap((item) => {
    const match = (item.value as Rec).match as Rec | undefined;
    const languages = strings(match?.languages);
    const frameworks = strings(match?.frameworks);
    return languages.length === 0 && frameworks.length === 0 ? [] : [{ id: item.id, languages, frameworks }];
  });
  const out: Record<string, string[]> = {};
  for (const c of inventory.classifications) {
    if (!c.approvable) continue;
    out[c.id] = templates
      .filter((m) => (m.languages.length === 0 || (c.language !== null && m.languages.includes(c.language))) && (m.frameworks.length === 0 || (c.framework !== null && m.frameworks.includes(c.framework))))
      .map((m) => m.id);
  }
  return out;
}

function describeSettings(server: ServerContext): Rec {
  const abs = path.join(server.projectDir, WORKSPACE_FILE);
  const revision = readRevision(abs);
  const loaded = loadWorkspaceSettings(server.projectDir);
  let enabled: boolean | null = null;
  if (revision.exists) {
    const parsed = parseYamlText(revision.text, WORKSPACE_FILE);
    const discovery = (parsed.value as Rec | undefined)?.discovery as Rec | undefined;
    if (discovery && typeof discovery.enabled === "boolean") enabled = discovery.enabled;
  }
  return {
    schemaVersion: 1,
    status: "OK",
    file: WORKSPACE_FILE,
    exists: revision.exists,
    revision: revision.hash,
    text: revision.text,
    mode: loaded.settings.mode,
    enabled,
    include: loaded.settings.include,
    exclude: loaded.settings.exclude,
    components: loaded.settings.components,
    valid: loaded.diagnostics.length === 0,
    diagnostics: loaded.diagnostics.map((d) => ({ message: d.message, path: (d as unknown as Rec).path ?? null, line: (d as unknown as Rec).line ?? null })),
  };
}

type FileState = "included" | "excluded" | "ambiguous" | "not-included";
interface FileVerdict {
  state: FileState;
  rule: string | null;
}

/** Decides one file under a set of settings: the first exclude that matches wins, then include, then ambiguity. */
function judge(file: string, settings: WorkspaceSettings, ambiguousRoots: Classification[]): FileVerdict {
  for (const pattern of settings.exclude) if (matchesPathOrParent(pattern, file)) return { state: "excluded", rule: `exclude: ${pattern}` };
  if (settings.include.length > 0 && !settings.include.some((p) => matchesPathOrParent(p, file))) return { state: "not-included", rule: "include" };
  const hit = ambiguousRoots.find((c) => c.componentRoot === "." || file === c.componentRoot || file.startsWith(`${c.componentRoot}/`));
  if (hit) return { state: "ambiguous", rule: hit.reasonCode };
  return { state: "included", rule: null };
}

/** Settings of a candidate: the saved ones with the fields of the request replacing theirs. */
function candidate(server: ServerContext, body: Rec): WorkspaceSettings {
  const { settings } = loadWorkspaceSettings(server.projectDir);
  return {
    ...settings,
    ...(typeof body.mode === "string" ? { mode: body.mode as DiscoveryMode } : {}),
    ...(Array.isArray(body.include) ? { include: body.include as string[] } : {}),
    ...(Array.isArray(body.exclude) ? { exclude: body.exclude as string[] } : {}),
    ...(Array.isArray(body.components) ? { components: body.components as WorkspaceSettings["components"] } : {}),
  };
}

const patternList = { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 512, pattern: "^[^\\u0000\\n\\r]+$" } };
const component = {
  type: "object",
  properties: {
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$", maxLength: 120 },
    path: { type: "string", minLength: 1, maxLength: 512, pattern: "^(?![/~])(?!.*\\\\)(?!(?:.*/)?\\.\\.(?:/|$))[^\\u0000]+$" },
    language: { type: "string", minLength: 1, maxLength: 60 },
    framework: { type: "string", minLength: 1, maxLength: 60 },
    kind: { type: "string", minLength: 1, maxLength: 60 },
    enabled: { type: "boolean" },
  },
  required: ["id", "path"],
  additionalProperties: false,
};
const scopeProperties = {
  mode: { enum: MODES },
  include: patternList,
  exclude: patternList,
  components: { type: "array", maxItems: 200, items: component },
};

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/workspace",
    handler({ server }) {
      const configFile = path.join(server.projectDir, ROOT_FILE);
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          workspace: server.workspace,
          root: server.projectDir,
          configFile: fs.existsSync(configFile) ? ROOT_FILE : null,
          git: readGitContext(server.projectDir),
          server: { version: server.version, host: server.host, port: server.port },
        },
      };
    },
  },
  {
    method: "GET",
    path: "/api/workspace/discovery",
    handler({ server }) {
      const { inventory, diagnostics } = discoverWorkspace(server.projectDir);
      if (!previous.has(server)) previous.set(server, inventory);
      return { status: 200, json: { schemaVersion: 1, status: "OK", inventory, diagnostics, templates: templatesOf(inventory) } };
    },
  },
  {
    // "Detectar novamente": runs the discovery (read only) and says what changed since the previous one.
    method: "POST",
    path: "/api/workspace/discovery/run",
    body: { type: "object", additionalProperties: false },
    handler({ server }) {
      const { inventory, diagnostics } = discoverWorkspace(server.projectDir);
      const changes = changesBetween(previous.get(server), inventory);
      previous.set(server, inventory);
      return { status: 200, json: { schemaVersion: 1, status: "OK", inventory, diagnostics, changes, templates: templatesOf(inventory) } };
    },
  },
  {
    method: "GET",
    path: "/api/workspace/settings",
    handler({ server }) {
      return { status: 200, json: describeSettings(server) };
    },
  },
  {
    // The preview of a scope change, before it is saved: which files stay, leave or are ambiguous, and the rule.
    method: "POST",
    path: "/api/workspace/preview",
    body: { type: "object", properties: scopeProperties, additionalProperties: false },
    handler({ body, server }) {
      const next = candidate(server, body as Rec);
      const { settings: saved } = loadWorkspaceSettings(server.projectDir);
      const inventory = discoverWithSettings(server.projectDir, next);
      const base = discoverWithSettings(server.projectDir, saved);
      const tree = walkProject(server.projectDir, defaultReadDir, DEFAULT_DISCOVERY_LIMITS);
      const ambiguous = inventory.classifications.filter((c) => c.classificationStatus === "ambiguous");
      const ambiguousBefore = base.classifications.filter((c) => c.classificationStatus === "ambiguous");
      const lists: Record<"included" | "excluded" | "ambiguous", Array<Rec>> = { included: [], excluded: [], ambiguous: [] };
      const counts = { included: 0, excluded: 0, ambiguous: 0, leaving: 0, entering: 0 };
      for (const file of tree.files) {
        const after = judge(file, next, ambiguous);
        const before = judge(file, saved, ambiguousBefore);
        const out = after.state === "excluded" || after.state === "not-included";
        const wasOut = before.state === "excluded" || before.state === "not-included";
        const bucket = out ? "excluded" : after.state === "ambiguous" ? "ambiguous" : "included";
        counts[bucket] += 1;
        const leaving = out && !wasOut;
        const entering = !out && wasOut;
        if (leaving) counts.leaving += 1;
        if (entering) counts.entering += 1;
        // Files that change sides come first in the list: they are what the user is about to cause.
        lists[bucket].push({ path: file, rule: after.rule, leaving, entering });
      }
      for (const key of ["included", "excluded", "ambiguous"] as const) {
        lists[key].sort((a, b) => Number(Boolean(b.leaving || b.entering)) - Number(Boolean(a.leaving || a.entering)) || compareStrings(a.path as string, b.path as string));
        lists[key] = lists[key].slice(0, Math.max(MAX_LIST, lists[key].filter((f) => f.leaving || f.entering).length));
      }
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          mode: next.mode,
          counts,
          truncated: tree.truncated,
          listLimit: MAX_LIST,
          files: lists,
          unsupported: inventory.classifications.filter((c) => c.classificationStatus === "unsupported"),
          conflicting: inventory.classifications.filter((c) => c.reasonCode === "CONFLICTING_LOCKFILES"),
          inventory,
        },
      };
    },
  },
  {
    method: "PUT",
    path: "/api/workspace/settings",
    body: {
      type: "object",
      properties: { expectedRevision: { anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }] }, ...scopeProperties },
      required: ["expectedRevision"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      const b = body as Rec & { expectedRevision: string | null };
      const abs = path.join(server.projectDir, WORKSPACE_FILE);
      const current = readRevision(abs);
      const conflict = () =>
        new HttpError(409, "REVISION_CONFLICT", "O .jgates/workspace.yml mudou desde que foi lido.", "Recarregue a tela para ver a versão atual antes de salvar de novo.", {
          currentRevision: current.hash,
        });
      if (b.expectedRevision !== current.hash) throw conflict();

      const edits: YamlEdit[] = [];
      if (typeof b.mode === "string") {
        edits.push({ op: "set", path: ["discovery", "mode"], value: b.mode });
        // A file that turned discovery off would keep the new mode from taking effect.
        const existing = current.exists ? (parseYamlText(current.text, WORKSPACE_FILE).value as Rec | undefined)?.discovery : undefined;
        if (existing && (existing as Rec).enabled === false) edits.push({ op: "delete", path: ["discovery", "enabled"] });
      }
      for (const key of ["include", "exclude", "components"] as const) {
        const value = b[key];
        if (!Array.isArray(value)) continue;
        edits.push(value.length === 0 ? { op: "delete", path: [key] } : { op: "set", path: [key], value });
      }
      if (edits.length === 0) throw new HttpError(400, "NOTHING_TO_SAVE", "Nenhuma alteração para gravar.", null);

      try {
        // The result must still be a valid workspace.yml before anything is written.
        const next = patchYamlText(current.exists ? current.text : SEED, edits);
        const parsed = parseYamlText(next.text, WORKSPACE_FILE);
        const problems = [...parsed.diagnostics, ...(parsed.value === undefined ? [] : validateDocument("workspace", parsed.value, WORKSPACE_FILE, { doc: parsed.doc, lineCounter: parsed.lineCounter }))];
        if (problems.length > 0) {
          const first = problems[0] as { message: string; path: string };
          throw new HttpError(422, "WORKSPACE_INVALID", `O workspace.yml ficaria inválido: ${first.message}`, null, { path: first.path });
        }
        patchYamlFile(abs, edits, { expectedHash: current.hash, createWith: SEED });
      } catch (error) {
        if (error instanceof YamlPatchError) {
          if (error.code === "YAML_CONFLICT") throw conflict();
          throw new HttpError(422, error.code, error.message);
        }
        throw error;
      }
      server.log("workspace settings saved");
      return { status: 200, json: describeSettings(server) };
    },
  },
];
