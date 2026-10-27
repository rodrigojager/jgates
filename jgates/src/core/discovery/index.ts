import fs from "node:fs";
import path from "node:path";
import { loadProjectConfig, type ConfigDiagnostic } from "../config/load/index.js";
import { buildContext, detectCargo, detectDotnet, detectGo, detectNode, detectPython, detectUnsupported, isUnder, type Candidate } from "./detectors.js";
import { matchesPathOrParent } from "./glob.js";
import { compareStrings, defaultReadDir, walkProject } from "./walk.js";
import {
  DEFAULT_DISCOVERY_LIMITS,
  DETECTOR_VERSION,
  type Classification,
  type ClassificationStatus,
  type DiscoveryMode,
  type DiscoveryOptions,
  type Inconsistency,
  type Inventory,
  type WorkspaceSettings,
} from "./types.js";

export * from "./types.js";
export { matchesPathOrParent, matchesExactly } from "./glob.js";

export const WORKSPACE_FILE = ".jgates/workspace.yml";

export const DEFAULT_SETTINGS: WorkspaceSettings = { mode: "auto", components: [], include: [], exclude: [], configFile: null };

export interface DiscoveryResult {
  inventory: Inventory;
  /** Diagnostics of the workspace configuration; when not empty the defaults were used instead of the file. */
  diagnostics: ConfigDiagnostic[];
}

/** Reads the discovery settings from .jgates/workspace.yml (never throws; an invalid file gives the defaults). */
export function loadWorkspaceSettings(projectDir: string): { settings: WorkspaceSettings; diagnostics: ConfigDiagnostic[] } {
  const loaded = loadProjectConfig(projectDir);
  const doc = loaded.byKind.workspace;
  if (!doc) return { settings: DEFAULT_SETTINGS, diagnostics: [] };
  const diagnostics = loaded.diagnostics.filter((d) => d.file === doc.file);
  if (diagnostics.length > 0 || !doc.value || typeof doc.value !== "object") return { settings: { ...DEFAULT_SETTINGS, configFile: doc.file }, diagnostics };
  const v = doc.value as {
    discovery?: { enabled?: boolean; mode?: DiscoveryMode };
    components?: WorkspaceSettings["components"];
    include?: string[];
    exclude?: string[];
  };
  const mode: DiscoveryMode = v.discovery?.enabled === false ? "explicit" : (v.discovery?.mode ?? "auto");
  return {
    settings: { mode, components: v.components ?? [], include: v.include ?? [], exclude: v.exclude ?? [], configFile: doc.file },
    diagnostics,
  };
}

/** Discovers the components of a project reading only files; no process is started. */
export function discoverWorkspace(projectDir: string, options: DiscoveryOptions = {}): DiscoveryResult {
  const dir = path.resolve(projectDir);
  const { settings, diagnostics } = loadWorkspaceSettings(dir);
  return { inventory: discoverWithSettings(dir, settings, options), diagnostics };
}

/** Same as discoverWorkspace with the settings given (init and plan use it with settings they built). */
export function discoverWithSettings(projectDir: string, settings: WorkspaceSettings, options: DiscoveryOptions = {}): Inventory {
  const dir = path.resolve(projectDir);
  const limits = { ...DEFAULT_DISCOVERY_LIMITS, ...options.limits };
  const ci = options.caseInsensitive ?? process.platform === "win32";
  const mode = options.mode ?? settings.mode;
  const tree = walkProject(dir, options.readDir ?? defaultReadDir, limits);
  const ctx = buildContext(tree.files, dir, limits.maxManifestBytes, ci);

  const found: Candidate[] = [
    ...detectNode(ctx),
    ...detectPython(ctx),
    ...detectGo(ctx),
    ...detectCargo(ctx),
    ...detectDotnet(ctx),
    ...detectUnsupported(ctx),
    ...tree.vendorDirs.map<Candidate>((v) => ({
      root: v,
      language: null,
      framework: null,
      packageManager: null,
      kind: null,
      detectedBy: "vendor-policy",
      evidence: [v],
      reasonCode: "VENDOR_DIRECTORY",
      status: "ignored",
    })),
  ];

  const inconsistencies: Inconsistency[] = [];
  const entries: Array<Candidate & { id: string | null; enabled: boolean }> = [];

  // Explicit declarations prevail over the detection of the same path.
  const declaredPaths = new Set<string>();
  for (const decl of settings.components) {
    const root = normalizeRoot(decl.path);
    declaredPaths.add(root);
    const same = found.filter((c) => c.root === root && c.status !== "unsupported" && c.detectedBy !== "vendor-policy");
    const exists = root === "." || tree.files.some((f) => isUnder(f, root)) || tree.vendorDirs.includes(root);
    if (!exists) inconsistencies.push({ code: "DECLARED_PATH_MISSING", componentRoot: root, id: decl.id });
    else if (decl.language && same.length > 0 && !same.some((c) => c.language === decl.language)) {
      inconsistencies.push({ code: "DECLARED_LANGUAGE_MISMATCH", componentRoot: root, id: decl.id });
    }
    const evidence = [...(settings.configFile ? [settings.configFile] : []), ...same.flatMap((c) => c.evidence)];
    entries.push({
      root,
      id: decl.id,
      enabled: decl.enabled !== false,
      language: decl.language ?? same[0]?.language ?? null,
      framework: decl.framework ?? same[0]?.framework ?? null,
      packageManager: same[0]?.packageManager ?? null,
      kind: decl.kind ?? null,
      detectedBy: "workspace-config",
      evidence,
      reasonCode: "DECLARED_IN_CONFIG",
      status: "explicit",
    });
  }

  for (const c of found) {
    if (declaredPaths.has(c.root) && c.status !== "unsupported" && c.detectedBy !== "vendor-policy") continue;
    if (mode === "explicit" && (c.status === "detected" || c.status === "ambiguous")) {
      entries.push({ ...c, id: null, enabled: true, status: "ignored", reasonCode: "NOT_DECLARED_IN_EXPLICIT_MODE" });
    } else entries.push({ ...c, id: null, enabled: true });
  }

  // include selects candidates, exclude always wins.
  const globOpts = { caseInsensitive: ci };
  const filtered = entries.map((e) => {
    if (settings.exclude.some((p) => matchesPathOrParent(p, e.root, globOpts))) {
      return { ...e, status: "ignored" as ClassificationStatus, reasonCode: "EXCLUDED_BY_RULE" };
    }
    if (e.status !== "explicit" && e.status !== "ignored" && settings.include.length > 0 && !settings.include.some((p) => matchesPathOrParent(p, e.root, globOpts))) {
      return { ...e, status: "ignored" as ClassificationStatus, reasonCode: "NOT_INCLUDED" };
    }
    return e;
  });

  const sorted = filtered.sort(
    (a, b) =>
      compareStrings(a.root, b.root) ||
      compareStrings(a.status, b.status) ||
      compareStrings(a.detectedBy, b.detectedBy) ||
      compareStrings(a.language ?? "", b.language ?? "") ||
      compareStrings(a.evidence[0] ?? "", b.evidence[0] ?? ""),
  );

  const used = new Set<string>(sorted.flatMap((e) => (e.id ? [e.id] : [])));
  const classifications: Classification[] = sorted.map((e) => {
    const id = e.id ?? uniqueId(makeId(e.root, e.language), e.language, used);
    const evidencePaths = [...new Set(e.evidence)].sort(compareStrings);
    return {
      id,
      componentRoot: e.root,
      language: e.language,
      framework: e.framework,
      packageManager: e.packageManager,
      kind: e.kind,
      detectedBy: e.detectedBy,
      detectorVersion: DETECTOR_VERSION,
      evidencePaths,
      reasonCode: e.reasonCode,
      classificationStatus: e.status,
      approvable: mode !== "report-only" && e.enabled && (e.status === "explicit" || e.status === "detected"),
    };
  });

  const summary: Record<ClassificationStatus, number> = { explicit: 0, detected: 0, ambiguous: 0, unsupported: 0, ignored: 0 };
  for (const c of classifications) summary[c.classificationStatus] += 1;
  inconsistencies.sort((a, b) => compareStrings(a.code, b.code) || compareStrings(a.componentRoot, b.componentRoot));

  return {
    schemaVersion: 1,
    detectorVersion: DETECTOR_VERSION,
    mode,
    templatesActive: mode !== "report-only",
    configFile: settings.configFile,
    classifications,
    languages: [...new Set(classifications.filter((c) => c.approvable && c.language).map((c) => c.language as string))].sort(compareStrings),
    summary,
    inconsistencies,
    indexed: { entries: tree.entries, truncated: tree.truncated },
  };
}

function normalizeRoot(p: string): string {
  const n = path.posix.normalize(p.replace(/\\/g, "/")).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return n === "" ? "." : n;
}

function makeId(root: string, language: string | null): string {
  const base = root === "." ? "root" : root.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return base === "" ? (language ?? "component") : base;
}

function uniqueId(base: string, language: string | null, used: Set<string>): string {
  let id = base;
  if (used.has(id) && language) id = `${base}-${language}`;
  let n = 2;
  const stem = id;
  while (used.has(id)) id = `${stem}-${n++}`;
  used.add(id);
  return id;
}

export function projectDirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
