// Value pickers of the guided forms (ADR-0009, PLAN-config-editing.md section 3): the values a field may take when
// they are known somewhere (a file or folder of the project, a git ref, a compose service and port, an id of the
// workspace or of the catalogue), so the person picks instead of typing. One route per value source of
// core/forms/derived/sources.ts: GET /api/pickers/<source>.
//
// Every list is read from files: the project tree (walked once and cached while it stays the same), the .git files for
// branches and tags, the compose files, the configuration files and the built-in catalogue. Only the recent commits ask
// Git, asynchronously and read-only (ADR-0010: no synchronous git in a handler); without Git the list has no commits
// and says so. A picker never restricts a value: the UI always keeps "Outro..." for typing.
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { builtinManifests } from "../../adapters/manifests.js";
import { builtinProfileBody, listBuiltinProfiles, listBuiltinTemplates } from "../../builtin/index.js";
import { cachedProject, projectInventory, projectResolve } from "../../core/cache/project.js";
import { localizedAdapterName, builtinTemplateText, createCoreCatalog } from "../../core/catalog/index.js";
import { starterProfileText } from "../../core/profiles/index.js";
import { discoverCompose, listComposeFiles, type ComposeService } from "../../core/discovery/compose.js";
import { buildVocabulary } from "../../core/discovery/vocabulary.js";
import { defaultReadDir, walkProject } from "../../core/discovery/walk.js";
import { derived } from "../../core/forms/index.js";
import { readServicesConfig } from "../../core/services/index.js";
import { resolveGit, runGitAsync } from "../../core/snapshot/git.js";
import { resolveToolBindings } from "../../core/tools/index.js";
import { HttpError, refuseMsg } from "../http.js";
import type { RouteDefinition } from "../types.js";

export interface PickerItem {
  /** What the field takes. */
  value: string;
  /** What the person reads (a catalogue name, a path, "service : port"). */
  label: string;
  /** The id or a detail, shown as secondary text. */
  secondary?: string;
  /** A group of the list (branch, tag, commit; project, catalogue...). */
  group?: string;
}

export interface PickerList {
  schemaVersion: 1;
  status: "OK";
  source: derived.ValueSourceName;
  items: PickerItem[];
  /** More values exist than the list holds (a very large project). */
  truncated: boolean;
  /** Why part of the list could not be read ("git-missing", "git-failed", "not-a-repository", "pattern-invalid"). */
  notes: string[];
}

/** Most values one list returns; the project walk itself stops at TREE_LIMITS. */
export const MAX_ITEMS = 1000;
const TREE_LIMITS = { maxEntries: 20_000, maxDepth: 16, maxManifestBytes: 0 };
const MAX_COMMITS = 20;
const MAX_REF_FILE = 1024 * 1024;
const MAX_CONFIG_FILE = 1024 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const byLabel = (a: PickerItem, b: PickerItem) => a.label.localeCompare(b.label, "en");

function capped(items: PickerItem[], notes: string[] = [], over = false): Omit<PickerList, "schemaVersion" | "status" | "source"> {
  return { items: items.slice(0, MAX_ITEMS), truncated: over || items.length > MAX_ITEMS, notes };
}

// ---- the project tree ------------------------------------------------------------------------------------------------

/** The files of the project (technical folders such as node_modules and .git left out), cached while the tree is unchanged. */
function projectTree(dir: string): { files: readonly string[]; truncated: boolean } {
  return cachedProject("picker-tree", [path.resolve(dir)], () => {
    const tree = walkProject(path.resolve(dir), defaultReadDir, TREE_LIMITS);
    return { files: tree.files, truncated: tree.truncated };
  });
}

function patternOf(text: string | undefined): RegExp | null | "invalid" {
  if (!text) return null;
  try {
    return new RegExp(text, "i");
  } catch {
    return "invalid";
  }
}

function projectFiles(dir: string, pattern: string | undefined) {
  const tree = projectTree(dir);
  const rx = patternOf(pattern);
  if (rx === "invalid") return capped([], ["pattern-invalid"]);
  // The value sources match the relative path; a hand-written form's suggestFiles pattern matches the file name.
  const files = rx ? tree.files.filter((f) => rx.test(f) || rx.test(f.slice(f.lastIndexOf("/") + 1))) : tree.files;
  return capped(
    files.map((f) => ({ value: f, label: f })),
    [],
    tree.truncated,
  );
}

function projectFolders(dir: string, pattern: string | undefined) {
  const tree = projectTree(dir);
  const folders = new Set<string>();
  for (const file of tree.files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const rx = patternOf(pattern);
  if (rx === "invalid") return capped([], ["pattern-invalid"]);
  const list = [...folders].filter((f) => !rx || rx.test(f)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return capped(
    list.map((f) => ({ value: f, label: f })),
    [],
    tree.truncated,
  );
}

// ---- git refs --------------------------------------------------------------------------------------------------------

function readSmall(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_REF_FILE) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The .git folder of `dir` or of its nearest ancestor (a worktree's "gitdir:" file followed) and its common folder. */
function gitDirs(dir: string): { gitDir: string; commonDir: string } | null {
  let cur = path.resolve(dir);
  for (;;) {
    const candidate = path.join(cur, ".git");
    let gitDir: string | null = null;
    try {
      const st = fs.statSync(candidate);
      if (st.isDirectory()) gitDir = candidate;
      else if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readSmall(candidate) ?? "");
        if (!m || !m[1]) return null;
        gitDir = path.resolve(cur, m[1]);
      }
    } catch {
      gitDir = null;
    }
    if (gitDir) {
      const common = readSmall(path.join(gitDir, "commondir"))?.trim();
      return { gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir };
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** The names under refs/<kind>/ (loose files and packed-refs), without the prefix. */
function refNames(dirs: { gitDir: string; commonDir: string }, kind: "heads" | "tags"): string[] {
  const names = new Set<string>();
  const walk = (base: string, rel: string, depth: number) => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(base, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(base, child, depth + 1);
      else if (e.isFile()) names.add(child);
    }
  };
  for (const base of new Set([dirs.gitDir, dirs.commonDir])) walk(path.join(base, "refs", kind), "", 0);
  const packed = readSmall(path.join(dirs.commonDir, "packed-refs"));
  const prefix = `refs/${kind}/`;
  for (const line of (packed ?? "").split(/\r?\n/)) {
    const [sha, name] = line.split(" ");
    if (sha && name && /^[0-9a-f]{40,64}$/.test(sha) && name.startsWith(prefix)) names.add(name.slice(prefix.length));
  }
  return [...names].sort((a, b) => a.localeCompare(b, "en"));
}

async function gitRefs(dir: string) {
  const dirs = gitDirs(dir);
  if (!dirs) return capped([], ["not-a-repository"]);
  const items: PickerItem[] = [
    ...refNames(dirs, "heads").map((name) => ({ value: name, label: name, group: "branch" })),
    ...refNames(dirs, "tags").map((name) => ({ value: name, label: name, group: "tag" })),
  ];
  const notes: string[] = [];
  const git = resolveGit(process.env);
  if (!git) notes.push("git-missing");
  else {
    // Read-only, no pager, no file system monitor of the repository; a time limit stops a Git that does not answer.
    const r = await runGitAsync(git, ["-c", "core.fsmonitor=false", "log", "-n", String(MAX_COMMITS), "--no-color", "--format=%H%x1f%h%x1f%s%x1f%cs", "HEAD", "--"], dir, process.env, {}, 15_000);
    if (r.status !== 0) notes.push("git-failed");
    else {
      for (const line of r.stdout.split("\n")) {
        const [sha, short, subject, date] = line.split("\x1f");
        if (!sha || !short || !/^[0-9a-f]{7,64}$/.test(sha)) continue;
        items.push({ value: sha, label: `${short} ${subject ?? ""}`.trim(), secondary: date ?? "", group: "commit" });
      }
    }
  }
  return capped(items, notes);
}

// ---- compose services ------------------------------------------------------------------------------------------------

function portsOf(service: ComposeService): number[] {
  const all = [...service.ports.map((p) => p.target), ...service.expose].map((p) => Number.parseInt(p.split("/")[0] ?? "", 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
  return [...new Set(all)].sort((a, b) => a - b);
}

function composeServices(dir: string): ComposeService[] {
  const config = readServicesConfig(dir);
  const files = config && config.compose.length > 0 ? config.compose : listComposeFiles(dir);
  if (files.length === 0) return [];
  return discoverCompose(dir, files).services;
}

function serviceTargets(dir: string) {
  const items: PickerItem[] = [];
  for (const s of composeServices(dir)) for (const port of portsOf(s)) items.push({ value: `service:${s.name}:${port}`, label: `${s.name} : ${port}`, secondary: s.file, group: "service" });
  return capped(items);
}

function services(dir: string) {
  return capped(composeServices(dir).map((s) => ({ value: s.name, label: s.name, secondary: s.file })));
}

// ---- configuration files and the catalogue ---------------------------------------------------------------------------

function readYaml(file: string): unknown {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_CONFIG_FILE) return null;
    return parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

function components(dir: string) {
  let inventory;
  try {
    inventory = projectInventory(dir);
  } catch {
    return capped([], ["discovery-failed"]);
  }
  const seen = new Set<string>();
  const items: PickerItem[] = [];
  for (const c of inventory.classifications) {
    if (seen.has(c.id) || c.classificationStatus === "ignored") continue;
    seen.add(c.id);
    items.push({ value: c.id, label: c.id, secondary: [c.componentRoot, c.language, c.framework].filter(Boolean).join(" · ") });
  }
  return capped(items.sort(byLabel));
}

function languages(dir: string) {
  const vocabulary = buildVocabulary();
  let found: string[] = [];
  try {
    found = projectInventory(dir).languages;
  } catch {
    found = [];
  }
  const items = vocabulary.languages.map((l) => ({ value: l.id, label: l.label, secondary: l.id, group: found.includes(l.id) ? "project" : "catalogue" }));
  return capped([...items.filter((i) => i.group === "project"), ...items.filter((i) => i.group !== "project")]);
}

function frameworks() {
  const items: PickerItem[] = [];
  const seen = new Set<string>();
  for (const l of buildVocabulary().languages) {
    for (const f of l.frameworks) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      items.push({ value: f.id, label: f.label, secondary: `${f.id} · ${l.label}` });
    }
  }
  return capped(items.sort(byLabel));
}

const catalog = () => createCoreCatalog().toDocument();

function capabilities() {
  return capped(catalog().capabilities.map((c) => ({ value: c.id, label: c.label, secondary: c.id })));
}

function profiles(dir: string) {
  const items: PickerItem[] = [];
  const doc = readYaml(path.join(dir, ".jgates", "profiles.yml"));
  const own = isObject(doc) && isObject(doc.profiles) ? doc.profiles : {};
  for (const [id, body] of Object.entries(own)) items.push({ value: id, label: isObject(body) && typeof body.label === "string" ? body.label : id, secondary: id, group: "project" });
  for (const item of listBuiltinProfiles()) {
    const label = starterProfileText(item.id, builtinProfileBody(item)).label;
    items.push({ value: item.ref, label: label ?? item.id, secondary: item.ref, group: "builtin" });
  }
  return capped(items);
}

function templates(dir: string) {
  const items: PickerItem[] = [];
  try {
    for (const f of fs.readdirSync(path.join(dir, ".jgates", "templates")).filter((n) => /\.ya?ml$/.test(n)).sort()) {
      const rel = `.jgates/templates/${f}`;
      const doc = readYaml(path.join(dir, rel));
      const label = isObject(doc) && typeof doc.label === "string" ? doc.label : isObject(doc) && typeof doc.id === "string" ? doc.id : f;
      items.push({ value: rel, label, secondary: rel, group: "project" });
    }
  } catch {
    // no template folder
  }
  for (const item of listBuiltinTemplates()) items.push({ value: item.ref, label: builtinTemplateText(item.ref, item.value).label ?? item.id, secondary: item.ref, group: "builtin" });
  return capped(items);
}

function adapterLabel(id: string): string {
  const manifest = builtinManifests().find((m) => m.id === id);
  return manifest ? localizedAdapterName(manifest.id, manifest.displayName) : id;
}

function toolInstances(dir: string): PickerItem[] {
  const out = new Map<string, PickerItem>();
  try {
    for (const i of resolveToolBindings(dir, { skipInventory: true }).instances) out.set(i.id, { value: i.id, label: adapterLabel(i.adapter), secondary: i.id });
  } catch {
    // an unreadable tools file: the instances of the effective configuration still come
  }
  try {
    const resolved = projectResolve(dir);
    const tools = isObject(resolved.config.tools) ? resolved.config.tools : {};
    for (const [id, body] of Object.entries(tools)) if (!out.has(id) && isObject(body) && typeof body.adapter === "string") out.set(id, { value: id, label: adapterLabel(body.adapter), secondary: id });
  } catch {
    // no effective configuration: only the tools file
  }
  return [...out.values()].sort((a, b) => a.value.localeCompare(b.value, "en"));
}

function adapters() {
  return capped(builtinManifests().map((m) => ({ value: m.id, label: localizedAdapterName(m.id, m.displayName ?? m.id), secondary: m.id })).sort(byLabel));
}

function checkSelectors(dir: string) {
  const doc = catalog();
  return capped([
    ...doc.categories.map((c) => ({ value: `category:${c.id}`, label: c.label, secondary: `category:${c.id}`, group: "category" })),
    ...doc.capabilities.map((c) => ({ value: `capability:${c.id}`, label: c.label, secondary: `capability:${c.id}`, group: "capability" })),
    ...toolInstances(dir).map((i) => ({ value: `tool:${i.value}`, label: i.label, secondary: `tool:${i.value}`, group: "tool" })),
  ]);
}

function architectureLayers(dir: string) {
  const doc = readYaml(path.join(dir, ".jgates", "architecture.yml"));
  const arch = isObject(doc) && isObject(doc.architecture) ? doc.architecture : {};
  const layers = Array.isArray(arch.layers) ? arch.layers : [];
  return capped(
    layers.filter((l): l is Record<string, unknown> => isObject(l) && typeof l.id === "string").map((l) => ({ value: l.id as string, label: typeof l.label === "string" ? l.label : (l.id as string), secondary: l.id as string })),
  );
}

/** The list of one value source. */
export async function pickerList(dir: string, source: derived.ValueSourceName, pattern?: string): Promise<PickerList> {
  let body: Omit<PickerList, "schemaVersion" | "status" | "source">;
  switch (source) {
    case "project-file":
      body = projectFiles(dir, pattern);
      break;
    case "project-folder":
      body = projectFolders(dir, pattern);
      break;
    case "git-ref":
      body = await gitRefs(dir);
      break;
    case "service-target":
      body = serviceTargets(dir);
      break;
    case "service":
      body = services(dir);
      break;
    case "component":
      body = components(dir);
      break;
    case "language":
      body = languages(dir);
      break;
    case "framework":
      body = frameworks();
      break;
    case "capability":
      body = capabilities();
      break;
    case "profile":
      body = profiles(dir);
      break;
    case "template":
      body = templates(dir);
      break;
    case "tool-instance":
      body = capped(toolInstances(dir));
      break;
    case "adapter":
      body = adapters();
      break;
    case "check-selector":
      body = checkSelectors(dir);
      break;
    case "architecture-layer":
      body = architectureLayers(dir);
      break;
    default:
      throw refuseMsg(404, "PICKER_UNKNOWN", "route_picker_unknown", { source: String(source) }, { source });
  }
  return { schemaVersion: 1, status: "OK", source, ...body };
}

export const routes: RouteDefinition[] = [
  {
    // GET /api/pickers/project-file?pattern=\.ya?ml$ : the values of one value source of the derived forms.
    method: "GET",
    path: "/api/pickers/:source",
    params: { type: "object", properties: { source: { enum: [...derived.VALUE_SOURCES] } }, required: ["source"], additionalProperties: false },
    query: { type: "object", properties: { pattern: { type: "string", maxLength: 256 } }, additionalProperties: false },
    timeoutMs: 30_000,
    async handler({ params, query, server }) {
      const list = await pickerList(server.projectDir, params.source as derived.ValueSourceName, (query as { pattern?: string }).pattern);
      return { status: 200, json: list };
    },
  },
];
