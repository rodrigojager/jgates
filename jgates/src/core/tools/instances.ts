// Tool instances in .jgates/tools.yml: create, rename and remove an instance, point a binding at another file, make a
// local override of a read-only (package or governed) file, and the template of a missing configuration file. Every
// write patches the YAML text at the keys it touches (comments and order stay), with the revision the caller read.
import fs from "node:fs";
import path from "node:path";
import { discoverWorkspace } from "../discovery/index.js";
import { parse as parseYamlValue } from "yaml";
import { patchYamlFile, readRevision, YamlPatchError, type YamlEdit } from "../codecs/yaml/index.js";
import { openDocument, formatOf } from "../documents/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { insideBySegments } from "../documents/paths.js";
import { resolveToolBindings } from "./index.js";

export type InstanceErrorCode =
  | "INSTANCE_ID_INVALID"
  | "INSTANCE_EXISTS"
  | "INSTANCE_NOT_FOUND"
  | "ADAPTER_UNKNOWN"
  | "COMPONENT_UNKNOWN"
  | "BINDING_NOT_FOUND"
  | "BINDING_PATH_INVALID"
  | "TOOLS_FILE_CONFLICT"
  | "TOOLS_FILE_INVALID"
  | "OVERRIDE_NOT_NEEDED"
  | "OVERRIDE_EXISTS"
  | "OVERRIDE_UNREADABLE";

export class InstanceError extends Error {
  constructor(
    readonly code: InstanceErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "InstanceError";
  }
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const TOOLS_FILE = ".jgates/tools.yml";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const slash = (p: string) => p.split(path.sep).join("/");

/** Default configuration file names per adapter, in the order they are looked for in the component folder. */
const DEFAULT_CONFIG: Record<string, string[]> = {
  eslint: ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts"],
  vitest: ["vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vite.config.ts"],
  ruff: ["ruff.toml", ".ruff.toml", "pyproject.toml"],
  pytest: ["pytest.ini", "pyproject.toml"],
  jscpd: [".jscpd.json"],
  "dependency-cruiser": [".dependency-cruiser.cjs", ".dependency-cruiser.js", ".dependency-cruiser.json"],
  "import-linter": [".importlinter", "setup.cfg", "pyproject.toml"],
  gitleaks: [".gitleaks.toml"],
  trivy: ["trivy.yaml"],
  "osv-scanner": ["osv-scanner.toml"],
  checkov: [".checkov.yaml"],
};

/** Adapters that a user can add as an instance (composite adapters like the quality bridge are not instances). */
export function instanceAdapters(): string[] {
  return builtinManifests()
    .filter((m) => m.kind !== "composite")
    .map((m) => m.id);
}

function toolsFile(dir: string): string {
  const r = resolveToolBindings(dir, { skipInventory: true });
  // configFile is workspace-relative; the server's working directory is not the workspace.
  return path.resolve(dir, r.configFile ?? TOOLS_FILE);
}

function mapped<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof YamlPatchError) {
      if (error.code === "YAML_CONFLICT") throw new InstanceError("TOOLS_FILE_CONFLICT", error.message, error.details as Record<string, unknown>);
      throw new InstanceError("TOOLS_FILE_INVALID", error.message, { code: error.code });
    }
    throw error;
  }
}

function readTools(dir: string): { file: string; tools: Record<string, unknown>; raw: unknown; hash: string | null } {
  const file = toolsFile(dir);
  const rev = readRevision(file);
  let value: unknown = null;
  if (rev.exists) {
    try {
      value = parseYamlValue(rev.text);
    } catch (error) {
      throw new InstanceError("TOOLS_FILE_INVALID", (error as Error).message);
    }
  }
  const tools = isObject(value) && isObject(value.tools) ? value.tools : {};
  return { file, tools, raw: value, hash: rev.hash };
}

function applyEdits(dir: string, edits: YamlEdit[], expectedHash: string | null): void {
  const file = toolsFile(dir);
  mapped(() => patchYamlFile(file, edits, { expectedHash, createWith: "schemaVersion: 1\ntools: {}\n" }));
}

/** Component ids of the workspace inventory with their roots. */
function componentRoots(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const c of discoverWorkspace(dir).inventory.classifications) out.set(c.id, c.componentRoot);
  } catch {
    // discovery is optional context
  }
  return out;
}

export interface CreateInstanceRequest {
  id: string;
  adapter: string;
  component?: string | null;
}

export interface InstanceChange {
  id: string;
  /** Files that mention the instance id as a selector (tool:<id>), so the UI can warn about them. */
  references: string[];
  config: string | null;
}

/** Workspace files (jgates.yml and the .jgates fragments) that mention `tool:<id>`. */
export function referencesTo(dir: string, id: string): string[] {
  const out: string[] = [];
  const root = path.resolve(dir);
  const files = [path.join(root, "jgates.yml")];
  try {
    for (const name of fs.readdirSync(path.join(root, ".jgates"))) if (name.endsWith(".yml")) files.push(path.join(root, ".jgates", name));
  } catch {
    // no .jgates folder
  }
  const needle = new RegExp(`tool:${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9._-])`);
  for (const f of files) {
    try {
      if (needle.test(fs.readFileSync(f, "utf8"))) out.push(slash(path.relative(root, f)));
    } catch {
      // unreadable fragments are reported by config validate
    }
  }
  return out;
}

function defaultConfigFor(dir: string, adapter: string, componentRoot: string | null): string | null {
  const names = DEFAULT_CONFIG[adapter];
  if (!names) return null;
  const folder = componentRoot && componentRoot !== "." ? componentRoot : "";
  const pick = names.find((n) => fs.existsSync(path.join(dir, folder, n))) ?? names[0]!;
  return folder ? `${folder}/${pick}` : pick;
}

/** Adds an instance to tools.yml with the default configuration file of its adapter in the component folder. */
export function createInstance(dir: string, request: CreateInstanceRequest, expectedHash?: string | null): InstanceChange {
  if (!ID_RE.test(request.id)) throw new InstanceError("INSTANCE_ID_INVALID", `Invalid instance id: ${request.id}`);
  if (!instanceAdapters().includes(request.adapter)) throw new InstanceError("ADAPTER_UNKNOWN", `Unknown adapter: ${request.adapter}`, { adapter: request.adapter });
  const { tools, hash } = readTools(dir);
  if (Object.prototype.hasOwnProperty.call(tools, request.id)) throw new InstanceError("INSTANCE_EXISTS", `The instance ${request.id} already exists.`, { id: request.id });
  const roots = componentRoots(dir);
  const component = request.component ?? null;
  if (component !== null && !roots.has(component)) throw new InstanceError("COMPONENT_UNKNOWN", `Unknown component: ${component}`, { component });
  const config = defaultConfigFor(dir, request.adapter, component ? (roots.get(component) ?? null) : null);
  const body: Record<string, unknown> = { adapter: request.adapter };
  if (component) body.component = component;
  if (config) body.config = config;
  applyEdits(dir, [{ op: "set", path: ["tools", request.id], value: body }], expectedHash === undefined ? hash : expectedHash);
  return { id: request.id, references: [], config };
}

/** Renames an instance (the entry moves to the new key; the body is kept as it is). */
export function renameInstance(dir: string, id: string, to: string, expectedHash?: string | null): InstanceChange {
  if (!ID_RE.test(to)) throw new InstanceError("INSTANCE_ID_INVALID", `Invalid instance id: ${to}`);
  const { tools, hash } = readTools(dir);
  if (!Object.prototype.hasOwnProperty.call(tools, id)) throw new InstanceError("INSTANCE_NOT_FOUND", `The instance ${id} does not exist.`, { id });
  if (Object.prototype.hasOwnProperty.call(tools, to)) throw new InstanceError("INSTANCE_EXISTS", `The instance ${to} already exists.`, { id: to });
  applyEdits(
    dir,
    [
      { op: "set", path: ["tools", to], value: tools[id] },
      { op: "delete", path: ["tools", id] },
    ],
    expectedHash === undefined ? hash : expectedHash,
  );
  return { id: to, references: referencesTo(dir, id), config: null };
}

/** Removes an instance from tools.yml. Files it pointed at are never touched. */
export function removeInstance(dir: string, id: string, expectedHash?: string | null): InstanceChange {
  const { tools, hash } = readTools(dir);
  if (!Object.prototype.hasOwnProperty.call(tools, id)) throw new InstanceError("INSTANCE_NOT_FOUND", `The instance ${id} does not exist.`, { id });
  applyEdits(dir, [{ op: "delete", path: ["tools", id] }], expectedHash === undefined ? hash : expectedHash);
  return { id, references: referencesTo(dir, id), config: null };
}

/** The workspace-relative path as a user typed it, checked: relative, no backslash, no "." or ".." segment, inside the workspace. */
export function checkRelativePath(dir: string, raw: string): string {
  const bad = (): never => {
    throw new InstanceError("BINDING_PATH_INVALID", `Invalid path: ${raw}`, { path: raw });
  };
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) return bad();
  if (raw.includes("\\") || raw.includes("\u0000") || path.isAbsolute(raw) || raw.startsWith("~")) return bad();
  const parts = raw.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return bad();
  const abs = path.resolve(dir, raw);
  if (!insideBySegments(path.resolve(dir), abs)) return bad();
  return parts.join("/");
}

interface BindingSpot {
  /** Key path of the binding in tools.yml. */
  keyPath: string[];
  /** The declared value: a string, or an object with `path`. */
  spec: unknown;
}

function bindingSpot(dir: string, instance: string, binding: string): BindingSpot {
  const { tools } = readTools(dir);
  const body = tools[instance];
  if (!isObject(body)) throw new InstanceError("INSTANCE_NOT_FOUND", `The instance ${instance} does not exist.`, { id: instance });
  if (binding === "config" && body.config !== undefined) return { keyPath: ["tools", instance, "config"], spec: body.config };
  if (isObject(body.configFiles) && body.configFiles[binding] !== undefined) return { keyPath: ["tools", instance, "configFiles", binding], spec: body.configFiles[binding] };
  throw new InstanceError("BINDING_NOT_FOUND", `The instance ${instance} has no binding ${binding}.`, { instance, binding });
}

/** Points a binding at another workspace file (the "select file" action). Creates nothing. */
export function setBindingPath(dir: string, instance: string, binding: string, rawPath: string, expectedHash?: string | null): { path: string } {
  const rel = checkRelativePath(dir, rawPath);
  const spot = bindingSpot(dir, instance, binding);
  const { hash } = readTools(dir);
  const edits: YamlEdit[] = isObject(spot.spec)
    ? [
        { op: "set", path: [...spot.keyPath, "path"], value: rel },
        { op: "delete", path: [...spot.keyPath, "root"] },
        { op: "delete", path: [...spot.keyPath, "base"] },
      ]
    : [{ op: "set", path: spot.keyPath, value: rel }];
  applyEdits(dir, edits, expectedHash === undefined ? hash : expectedHash);
  return { path: rel };
}

export interface OverrideResult {
  path: string;
  from: string;
}

/**
 * Local override of a package or governed file: copies the bytes into the workspace (never over an existing file) and
 * points the binding at the copy. The original is not touched.
 */
export function createLocalOverride(dir: string, instance: string, binding: string, rawPath?: string, expectedHash?: string | null): OverrideResult {
  const opened = openDocument(dir, instance, binding);
  if (opened.state !== "package" && opened.state !== "governed") throw new InstanceError("OVERRIDE_NOT_NEEDED", `The file of ${instance}/${binding} is already editable.`, { state: opened.state });
  if (!opened.exists) throw new InstanceError("OVERRIDE_UNREADABLE", "The file does not exist.", {});
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(opened.path);
  } catch (error) {
    throw new InstanceError("OVERRIDE_UNREADABLE", (error as Error).message, {});
  }
  const resolved = resolveToolBindings(dir).instances.find((i) => i.id === instance);
  const component = resolved?.componentRoot;
  const rel = checkRelativePath(dir, rawPath ?? `${component && component !== "." ? `${component}/` : ""}${path.basename(opened.path)}`);
  const target = path.resolve(dir, rel);
  // The folder is created inside the workspace; a symlinked parent that leaves it is refused.
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const realRoot = fs.realpathSync(path.resolve(dir));
  if (!insideBySegments(realRoot, fs.realpathSync(parent))) throw new InstanceError("BINDING_PATH_INVALID", `Invalid path: ${rel}`, { path: rel });
  if (fs.existsSync(target)) throw new InstanceError("OVERRIDE_EXISTS", `The file ${rel} already exists.`, { path: rel });
  const { hash } = readTools(dir);
  fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
  try {
    setBindingPath(dir, instance, binding, rel, expectedHash === undefined ? hash : expectedHash);
  } catch (error) {
    // The binding did not change: the copy would only be a stray file.
    fs.rmSync(target, { force: true });
    throw error;
  }
  return { path: rel, from: opened.relPath ?? slash(opened.path) };
}

export interface TemplateText {
  text: string;
  format: string;
  /** Where the content comes from: the adapter's own template or the empty one of the format. */
  source: "adapter" | "format";
}

const ADAPTER_TEMPLATES: Record<string, (file: string) => string | null> = {
  eslint: (file) => (file.endsWith(".cjs") ? "// ESLint flat configuration created by JGates.\nmodule.exports = [\n  {\n    rules: {},\n  },\n];\n" : "// ESLint flat configuration created by JGates.\nexport default [\n  {\n    rules: {},\n  },\n];\n"),
  ruff: (file) => (file.endsWith("pyproject.toml") ? "[tool.ruff]\nline-length = 88\n" : "line-length = 88\n"),
  pytest: (file) => (file.endsWith("pyproject.toml") ? "[tool.pytest.ini_options]\naddopts = \"-q\"\n" : "[pytest]\naddopts = -q\n"),
  jscpd: () => "{\n  \"threshold\": 5,\n  \"minLines\": 5\n}\n",
  vitest: () => "import { defineConfig } from \"vitest/config\";\n\nexport default defineConfig({\n  test: {},\n});\n",
};

/** Content for a missing configuration file: the adapter's template, or an empty valid document of the format. */
export function templateFor(adapter: string, file: string): TemplateText {
  const format = formatOf(file);
  const own = ADAPTER_TEMPLATES[adapter]?.(file) ?? null;
  if (own !== null) return { text: own, format, source: "adapter" };
  const empty: Record<string, string> = { json: "{}\n", jsonc: "{}\n", yaml: "# Created by JGates.\n", toml: "# Created by JGates.\n", ini: "# Created by JGates.\n" };
  const cjs = file.endsWith(".cjs") ? "module.exports = {};\n" : null;
  return { text: cjs ?? empty[format] ?? "", format, source: "format" };
}
