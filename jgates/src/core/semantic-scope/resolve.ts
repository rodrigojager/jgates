// Resolution of a Semantic scope before any model work (PLAN-semantic-security, scope and incremental methodology):
//   1. source identities, requested subjects, exclusions, comparison semantics and limits (additions, removals,
//      renames and explicitly selected dirty/untracked changes included; a Git reference is a comparison anchor, never
//      evidence of a previous review);
//   2. a bounded impact/context proposal from Git and the import graph (importers, imports, shared guards, contracts,
//      configuration and dependency changes), with the relationships it could not establish recorded as unknowns;
//   3. review subjects kept apart from supporting context, under strict exclusions and limits, with the context the
//      limits kept out recommended instead of read;
//   4. prior evidence reused only after current checks (ledger.ts); with no baseline, the run inherits nothing and
//      says so.
// The same request always resolves to the same scope: purpose, rigor and budget are not inputs, so they cannot change
// it. Nothing here throws for a problem of the request or the repository: it becomes a blocker of the resolution.
import fs from "node:fs";
import path from "node:path";
import { readArchitecture } from "../architecture/index.js";
import { resolveHome } from "../home/index.js";
import { contentHash, workspaceId } from "../ids/index.js";
import { validateGateRecord } from "../gates/schemas.js";
import { commitSourceIdentity, computeSourceIdentity } from "../gates/source.js";
import type { ScopeDirtyInput, ScopeEnd, ScopeSpec, ScopeSubject } from "../gates/types.js";
import { gitContext, resolveCommit } from "../snapshot/index.js";
import { findSemanticRun, listSemanticRuns } from "../semantic/store.js";
import { isExcluded } from "../../adapters/semantic-gate/mask.js";
import { translator } from "../../i18n/index.js";
import { categoriesOf } from "./classify.js";
import { buildImportGraph, extractorInfo, type ImportGraph } from "./imports.js";
import { checkReuse, globalFingerprint, methodsHash, readScopeLedger, type ReuseCheck } from "./ledger.js";
import { commitView, diffCommits, dirtyEntries, overlayView, pathKey, posix, sha256, workingTreeView, type DiffEntry, type FileView, type RepoContext } from "./views.js";
import {
  CONTEXT_POLICIES,
  DEFAULT_CONTEXT_LIMITS,
  type ChangeKind,
  type ContextLimits,
  type ContextPolicy,
  type ContextRelation,
  type FileCategory,
  type InheritedCoverage,
  type Reason,
  type ScopeBlocker,
  type ScopeContextEntry,
  type ScopeRequest,
  type ScopeSubjectEntry,
  type ScopeUnknown,
  type SemanticScopeResolution,
  type TargetDescription,
} from "./types.js";

const t = translator("semantic-scope");

/** Files whose content no reviewer reads as text: not applicable units of a full scope. */
const NOT_TEXT = /\.(png|jpe?g|gif|bmp|ico|webp|avif|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|exe|dll|so|dylib|o|a|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|webm|mov|avi|sqlite|db|bin|lockb)$/i;
const MAX_UNKNOWNS = 500;
const LIMIT_CAP = { maxFiles: 10_000, maxDepth: 10, maxBytes: 1024 * 1024 * 1024 };

export interface ResolveScopeOptions {
  workspacePath: string;
  request?: ScopeRequest | null;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Methods the run would use: reuse requires the same ones. */
  methods?: readonly string[];
}

const reason = (code: string, params: Record<string, string | number> = {}, via?: string): Reason => ({ code, message: t(`scope_reason_${code.toLowerCase()}`, params), ...(via ? { via } : {}) });
const blocker = (code: string, params: Record<string, string | number> = {}): ScopeBlocker => ({ code, message: t(`scope_blocker_${code.toLowerCase()}`, params) });
const warning = (code: string, params: Record<string, string | number> = {}): ScopeBlocker => ({ code, message: t(`scope_warning_${code.toLowerCase()}`, params) });
const sortByPath = <T extends { path: string }>(xs: T[]): T[] => xs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** The value without its human text (message fields, reason strings), so the scope hash is the same in every language. */
function withoutText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutText);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "message") continue;
      out[k] = k === "reason" && typeof v === "string" ? "" : withoutText(v);
    }
    return out;
  }
  return value;
}

/** A workspace-relative path from user input; null when it would leave the workspace. */
export function normalizeScopePath(value: string): string | null {
  const p = posix(value.trim()).replace(/^\.\/+/, "");
  if (p === "" || p === ".") return "";
  if (path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.includes("\0")) return null;
  const n = path.posix.normalize(p).replace(/\/$/, "");
  if (n === ".." || n.startsWith("../")) return null;
  return n === "." ? "" : n;
}

/** Whether a file is named by a path subject: the file itself, a folder containing it, or a glob. */
export function matchesPath(file: string, value: string): boolean {
  if (value === "") return true;
  if (/[*?[]/.test(value)) return isExcluded(file, [value]);
  const f = pathKey(file);
  const v = pathKey(value);
  return f === v || f.startsWith(`${v}/`);
}

function clampLimits(request: ScopeRequest["context"]): ContextLimits {
  const pick = (v: number | undefined, d: number, cap: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, cap) : d);
  return {
    maxFiles: pick(request?.maxFiles, DEFAULT_CONTEXT_LIMITS.maxFiles, LIMIT_CAP.maxFiles),
    maxDepth: pick(request?.maxDepth, DEFAULT_CONTEXT_LIMITS.maxDepth, LIMIT_CAP.maxDepth),
    maxBytes: pick(request?.maxBytes, DEFAULT_CONTEXT_LIMITS.maxBytes, LIMIT_CAP.maxBytes),
  };
}

function dependencyNames(text: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (text === null) return out;
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = doc[section];
      if (deps && typeof deps === "object" && !Array.isArray(deps)) for (const [name, version] of Object.entries(deps as Record<string, unknown>)) out.set(name, `${section}:${String(version)}`);
    }
  } catch {
    // An unparseable manifest maps to nothing; the caller records an unknown.
  }
  return out;
}

/** True when an unresolved relative import (its candidate, without extension) named the old path. */
function namesOldPath(candidate: string, oldPath: string): boolean {
  const strip = (p: string): string => p.replace(/\.(js|mjs|cjs|ts|mts|cts|tsx|jsx|json)$/i, "");
  const c = pathKey(strip(candidate));
  const o = pathKey(strip(oldPath));
  return c === o || `${c}/index` === o;
}

interface Ends {
  base: ScopeEnd | null;
  target: ScopeEnd;
  dirtyInputs: ScopeDirtyInput[];
  repositoryId: string | null;
}

/** Everything a resolution needs that is not data: the live views and graph (used again by a run). */
export interface ScopeWorkspace {
  target: FileView;
  base: FileView | null;
  graph: ImportGraph | null;
}

/** Opens the target as a resolution describes it (a run re-opens it to fingerprint and to guard reads). */
export function openTarget(workspacePath: string, target: TargetDescription, env: NodeJS.ProcessEnv = process.env): FileView {
  const git = gitContext(workspacePath, env);
  if (target.kind === "commit" && git.repository && target.commit) {
    if (target.overlay.length === 0) return commitView(workspacePath, git, target.commit, env);
    const overlay = new Map(target.overlay.map((p) => [p, fs.existsSync(path.join(workspacePath, p))]));
    return overlayView(workspacePath, git, target.commit, overlay, env);
  }
  return workingTreeView(workspacePath, git, env);
}

interface ContextCandidate {
  path: string;
  relation: ContextRelation;
  depth: number;
  priority: number;
  reasons: Reason[];
  explicit: boolean;
}

/** Resolves a scope request into subjects, context, unknowns, exclusions, reuse and the gate record. */
export function resolveSemanticScope(options: ResolveScopeOptions): SemanticScopeResolution {
  return resolveWithWorkspace(options).resolution;
}

export function resolveWithWorkspace(options: ResolveScopeOptions): { resolution: SemanticScopeResolution; workspace: ScopeWorkspace | null } {
  const env = options.env ?? process.env;
  const workspacePath = path.resolve(options.workspacePath);
  const request = options.request ?? {};
  const mode = request.mode ?? "full";
  const policy: ContextPolicy = request.context?.policy && (CONTEXT_POLICIES as readonly string[]).includes(request.context.policy) ? request.context.policy : "strict";
  const limits = clampLimits(request.context);
  const blockers: ScopeBlocker[] = [];
  const warnings: ScopeBlocker[] = [];
  const unknowns: ScopeUnknown[] = [];
  const unknown = (code: ScopeUnknown["code"], p: string, detail: string): void => {
    if (unknowns.length < MAX_UNKNOWNS) unknowns.push({ code, path: p, detail, message: t(`scope_unknown_${code.toLowerCase()}`, { path: p, detail }) });
  };

  // 1. The request itself.
  const exclusions: string[] = [];
  for (const raw of request.exclusions ?? []) {
    const p = normalizeScopePath(raw);
    if (p === null || p === "") blockers.push(blocker("SCOPE_PATH_OUTSIDE", { path: raw }));
    else exclusions.push(p);
  }
  const subjects: ScopeSubject[] = [];
  for (const s of request.subjects ?? []) {
    if (s.kind === "path") {
      const p = normalizeScopePath(s.value);
      if (p === null) blockers.push(blocker("SCOPE_PATH_OUTSIDE", { path: s.value }));
      else subjects.push({ kind: "path", value: p === "" ? "." : p });
    } else subjects.push({ kind: "subsystem", value: s.value });
  }
  const allow: string[] = [];
  for (const raw of request.context?.allow ?? []) {
    const p = normalizeScopePath(raw);
    if (p === null || p === "") blockers.push(blocker("SCOPE_PATH_OUTSIDE", { path: raw }));
    else allow.push(p);
  }
  if (mode === "full" && subjects.length > 0) blockers.push(blocker("SCOPE_SUBJECTS_NOT_APPLICABLE"));
  if (mode === "selected" && subjects.length === 0) blockers.push(blocker("SCOPE_SUBJECTS_REQUIRED"));
  if (mode !== "incremental" && (request.base || request.target || (request.dirty !== undefined && request.dirty !== "none"))) blockers.push(blocker("SCOPE_COMPARISON_NOT_APPLICABLE", { mode }));
  if (mode === "incremental" && !request.base) blockers.push(blocker("SCOPE_BASE_REQUIRED"));
  const excluded = (p: string): string | null => exclusions.find((g) => matchesPath(p, g) || isExcluded(p, [g])) ?? null;

  const git = gitContext(workspacePath, env);
  if (mode === "incremental" && !git.repository) blockers.push(blocker("SCOPE_REQUIRES_GIT"));

  // Subsystems are the layers of .jgates/architecture.yml (their path globs).
  const subjectGlobs: Array<{ subject: ScopeSubject; globs: string[] }> = [];
  for (const s of subjects) {
    if (s.kind === "path") subjectGlobs.push({ subject: s, globs: [s.value === "." ? "" : s.value] });
    else {
      const layer = readArchitecture(workspacePath).declaration?.contract.layers?.find((l) => l.id === s.value);
      if (!layer || !layer.paths || layer.paths.length === 0) blockers.push(blocker("SCOPE_SUBSYSTEM_UNKNOWN", { subsystem: s.value }));
      else subjectGlobs.push({ subject: s, globs: layer.paths.map((g) => normalizeScopePath(g) ?? g) });
    }
  }
  const inSubjects = (p: string): boolean => subjectGlobs.some((sg) => sg.globs.some((g) => matchesPath(p, g)));

  const empty = (target: TargetDescription, ends: Ends | null): SemanticScopeResolution => finish({ target, ends, subjectsOut: [], contextOut: [], changes: [], recommended: [], excludedOut: [], reuse: null, graph: null, repositoryFiles: 0, matches: false, baselineCode: null });

  // 2. The ends: the target view, the base view, the changes and the dirty inputs.
  let targetView: FileView | null = null;
  let baseView: FileView | null = null;
  let target: TargetDescription = { kind: git.repository ? "working-tree" : "directory", commit: git.repository ? git.head : null, overlay: [] };
  let ends: Ends | null = null;
  let changes: DiffEntry[] = [];
  let changeKinds = new Map<string, ChangeKind>();
  let workingDirty: Set<string> | null = null;

  if (blockers.length === 0 && mode !== "incremental") {
    targetView = workingTreeView(workspacePath, git, env);
    let sourceId: string | null = null;
    let repositoryId: string | null = null;
    try {
      const source = computeSourceIdentity(workspacePath, { env });
      sourceId = source.id;
      repositoryId = source.repository?.id ?? null;
    } catch {
      warnings.push(warning("SCOPE_SOURCE_UNKNOWN"));
    }
    const dirtyInputs: ScopeDirtyInput[] = [];
    if (git.repository) {
      const dirty = dirtyEntries(workspacePath, git, env);
      if (dirty?.truncated) unknown("STATUS_TRUNCATED", ".", "git status");
      for (const d of dirty?.entries ?? []) dirtyInputs.push({ path: d.path, change: d.change, sha256: d.change === "removed" ? null : (targetView.sha(d.path) ?? null) });
    }
    ends = { base: null, target: { ref: null, commit: git.repository ? git.head : null, sourceId }, dirtyInputs, repositoryId };
  } else if (blockers.length === 0 && git.repository) {
    const repo = git as RepoContext;
    const baseRef = String(request.base);
    const targetRef = request.target ? String(request.target) : "HEAD";
    const baseCommit = resolveCommit(repo, workspacePath, baseRef, env);
    const targetCommit = resolveCommit(repo, workspacePath, targetRef, env);
    if (!baseCommit) blockers.push(blocker("SCOPE_REF_UNRESOLVED", { ref: baseRef }));
    if (!targetCommit) blockers.push(blocker("SCOPE_REF_UNRESOLVED", { ref: targetRef }));
    const dirtyRequest = request.dirty ?? "none";
    if (baseCommit && targetCommit && dirtyRequest !== "none" && targetCommit !== repo.head) blockers.push(blocker("SCOPE_DIRTY_REQUIRES_HEAD_TARGET", { ref: targetRef }));
    if (baseCommit && targetCommit && blockers.length === 0) {
      const dirty = dirtyEntries(workspacePath, repo, env);
      if (dirty?.truncated) unknown("STATUS_TRUNCATED", ".", "git status");
      workingDirty = dirty ? new Set(dirty.entries.map((d) => pathKey(d.path))) : null;
      let selected = dirtyRequest === "none" ? [] : (dirty?.entries ?? []);
      if (Array.isArray(dirtyRequest)) {
        const wanted = dirtyRequest.map((d) => ({ raw: d, p: normalizeScopePath(d) }));
        for (const w of wanted) {
          if (w.p === null) blockers.push(blocker("SCOPE_PATH_OUTSIDE", { path: w.raw }));
          else if (!selected.some((d) => matchesPath(d.path, w.p as string))) warnings.push(warning("SCOPE_DIRTY_PATH_CLEAN", { path: w.raw }));
        }
        selected = selected.filter((d) => wanted.some((w) => w.p !== null && matchesPath(d.path, w.p)));
      }
      const overlay = new Map(selected.map((d) => [d.path, d.change !== "removed"]));
      baseView = commitView(workspacePath, repo, baseCommit, env);
      targetView = overlay.size > 0 ? overlayView(workspacePath, repo, targetCommit, overlay, env) : commitView(workspacePath, repo, targetCommit, env);
      target = { kind: "commit", commit: targetCommit, overlay: [...overlay.keys()].sort() };
      const diff = diffCommits(workspacePath, repo, baseCommit, targetCommit, env);
      if (!diff) blockers.push(blocker("SCOPE_DIFF_FAILED", { base: baseRef, target: targetRef }));
      const byPath = new Map((diff ?? []).map((d) => [pathKey(d.path), d]));
      for (const d of selected) {
        const key = pathKey(d.path);
        const existing = byPath.get(key);
        if (d.change === "removed") {
          if (baseView.has(d.path)) byPath.set(key, { path: d.path, change: "removed" });
          else byPath.delete(key);
        } else if (baseView.has(d.path)) {
          if (baseView.sha(d.path) === targetView.sha(d.path)) {
            if (existing?.change !== "renamed") byPath.delete(key);
          } else if (existing?.change !== "renamed") byPath.set(key, { path: d.path, change: "modified" });
        } else if (existing?.change !== "renamed") byPath.set(key, { path: d.path, change: "added" });
      }
      changes = sortByPath([...byPath.values()]);
      changeKinds = new Map(changes.map((c) => [pathKey(c.path), c.change]));
      for (const d of selected) if (d.change === "untracked" && changeKinds.get(pathKey(d.path)) === "added") changeKinds.set(pathKey(d.path), "untracked");
      const dirtyInputs: ScopeDirtyInput[] = selected.map((d) => ({ path: d.path, change: d.change, sha256: d.change === "removed" ? null : targetView!.sha(d.path) }));
      let baseSource: string | null = null;
      let targetSource: string | null = null;
      let repositoryId: string | null = null;
      try {
        const b = commitSourceIdentity(workspacePath, baseCommit, env);
        const tg = commitSourceIdentity(workspacePath, targetCommit, env);
        baseSource = b.id;
        repositoryId = tg.repository?.id ?? null;
        targetSource = dirtyInputs.length > 0 ? contentHash({ v: 1, commitSource: tg.id, dirty: dirtyInputs.map((d) => [d.path, d.change, d.sha256]) }) : tg.id;
      } catch {
        warnings.push(warning("SCOPE_SOURCE_UNKNOWN"));
      }
      ends = { base: { ref: baseRef, commit: baseCommit, sourceId: baseSource }, target: { ref: targetRef, commit: targetCommit, sourceId: targetSource }, dirtyInputs, repositoryId };
    }
  }
  if (blockers.length > 0 || !targetView || !ends) return { resolution: empty(target, ends), workspace: null };
  const tv = targetView;

  // 3. The import graph, when relations matter: selected and incremental scopes, or a baseline to check.
  const needGraph = mode !== "full" || Boolean(request.baseline);
  const graph = needGraph ? buildImportGraph(tv) : null;

  // 4. Subjects.
  const excludedOut: Array<{ path: string; reason: Reason }> = [];
  const excludedSeen = new Set<string>();
  const exclude = (p: string, pattern: string): void => {
    if (excludedSeen.has(pathKey(p))) return;
    excludedSeen.add(pathKey(p));
    excludedOut.push({ path: p, reason: reason("EXCLUDED", { pattern }) });
  };
  const notApplicable: Array<{ path: string; reason: Reason }> = [];
  const subjectsOut: ScopeSubjectEntry[] = [];
  const subjectKeys = new Set<string>();
  const addSubject = (p: string, change: ChangeKind, reasons: Reason[], previousPath?: string): void => {
    const key = pathKey(p);
    if (subjectKeys.has(key)) return;
    const pattern = excluded(p);
    if (pattern !== null) return exclude(p, pattern);
    subjectKeys.add(key);
    subjectsOut.push({ path: p, change, ...(previousPath ? { previousPath } : {}), categories: categoriesOf(p), reasons, disposition: "examine" });
  };
  if (mode === "full") {
    for (const f of tv.files) {
      if (NOT_TEXT.test(f)) notApplicable.push({ path: f, reason: reason("NOT_TEXT") });
      else addSubject(f, "unchanged", [reason("FULL_SCOPE")]);
    }
  } else if (mode === "selected") {
    for (const sg of subjectGlobs) {
      const matched = tv.files.filter((f) => sg.globs.some((g) => matchesPath(f, g)));
      if (matched.length === 0) blockers.push(blocker("SCOPE_SUBJECT_EMPTY", { subject: sg.subject.value }));
      for (const f of matched) {
        if (NOT_TEXT.test(f)) notApplicable.push({ path: f, reason: reason("NOT_TEXT") });
        else addSubject(f, "unchanged", [reason(sg.subject.kind === "subsystem" ? "SELECTED_SUBSYSTEM" : "SELECTED_PATH", { subject: sg.subject.value })]);
      }
    }
  } else {
    for (const c of changes) {
      if (subjectGlobs.length > 0 && !inSubjects(c.path) && !(c.previousPath && inSubjects(c.previousPath))) continue;
      const kind = changeKinds.get(pathKey(c.path)) ?? c.change;
      const code = kind === "renamed" ? "RENAMED" : kind === "removed" ? "REMOVED" : kind === "untracked" ? "UNTRACKED" : kind === "added" ? "ADDED" : "MODIFIED";
      addSubject(c.path, kind, [reason(code, { path: c.path, previous: c.previousPath ?? "" })], c.previousPath);
    }
  }

  // 5. Reuse of a baseline (current checks against the target).
  const methods = options.methods ?? [];
  let reuse: ReuseCheck | null = null;
  let baselineCode: string | null = null;
  let baselineRunId: string | null = null;
  if (request.baseline) {
    const home = options.home ?? resolveHome({ env });
    const wsId = workspaceId(workspacePath);
    const runs = request.baseline === "latest" ? listSemanticRuns(home, wsId).filter((r) => r.lifecycle === "settled") : [];
    const found = request.baseline === "latest" ? (runs.find((r) => readScopeLedger(r.dir) !== null) ?? null) : findSemanticRun(home, wsId, request.baseline);
    if (!found) {
      baselineCode = "BASELINE_NOT_FOUND";
      warnings.push(warning("SCOPE_BASELINE_NOT_FOUND", { ref: request.baseline }));
    } else {
      baselineRunId = found.runId;
      const ledger = readScopeLedger(found.dir);
      if (!ledger) {
        baselineCode = "BASELINE_WITHOUT_LEDGER";
        warnings.push(warning("SCOPE_BASELINE_WITHOUT_LEDGER", { runId: found.runId }));
      } else if (ledger.repositoryId !== null && ends.repositoryId !== null && ledger.repositoryId !== ends.repositoryId) {
        baselineCode = "BASELINE_OTHER_REPOSITORY";
        warnings.push(warning("SCOPE_BASELINE_OTHER_REPOSITORY", { runId: found.runId }));
      } else {
        const candidates = new Set(tv.files.filter((f) => excluded(f) === null && !NOT_TEXT.test(f)));
        reuse = checkReuse({ ledger, view: tv, graph, methodsHash: methodsHash(methods), globalFingerprint: globalFingerprint(tv), candidates });
      }
    }
  }
  const reusedIds = new Set((reuse?.reused ?? []).map((r) => pathKey(r.id)));
  for (const s of subjectsOut) {
    if (reusedIds.has(pathKey(s.path)) && s.change === "unchanged") {
      s.disposition = "reused";
      const r = reuse?.reused.find((x) => pathKey(x.id) === pathKey(s.path));
      if (r) s.reasons.push(...r.reasons);
    }
    if (reuse?.pending.has(s.path)) s.reasons.push(reason("PRIOR_UNRESOLVED_RETURNS", { runId: reuse.baselineRunId ?? "-" }));
  }

  // 6. Context proposal.
  const candidates = new Map<string, ContextCandidate>();
  const propose = (p: string, relation: ContextRelation, depth: number, why: Reason, priority: number, explicit = false): void => {
    const key = pathKey(p);
    if (subjectKeys.has(key)) return;
    const pattern = excluded(p);
    if (pattern !== null) return exclude(p, pattern);
    const existing = candidates.get(key);
    if (existing) {
      if (!existing.reasons.some((r) => r.code === why.code && r.via === why.via)) existing.reasons.push(why);
      existing.depth = Math.min(existing.depth, depth);
      existing.priority = Math.min(existing.priority, priority);
      existing.explicit = existing.explicit || explicit;
      return;
    }
    candidates.set(key, { path: p, relation, depth, priority, reasons: [why], explicit });
  };
  const categoryCode = (cats: FileCategory[]): string => (cats.includes("shared-guard") ? "_GUARD" : cats.includes("contract") ? "_CONTRACT" : cats.includes("configuration") ? "_CONFIG" : "");
  const importersBfs = (start: string, startReason: (importer: string) => Reason, priority: number): void => {
    if (!graph || limits.maxDepth === 0) return;
    let frontier = [start];
    const seen = new Set([pathKey(start)]);
    for (let depth = 1; depth <= limits.maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const importer of [...(graph.importers.get(f) ?? [])].sort()) {
          if (seen.has(pathKey(importer))) continue;
          seen.add(pathKey(importer));
          next.push(importer);
          propose(importer, "importer", depth, depth === 1 ? startReason(importer) : reason("IMPORTS_AFFECTED", { path: f }, f), priority + depth);
        }
      }
      frontier = next;
    }
  };
  const importsOf = (from: string, why: (to: string) => Reason, priority: number): void => {
    if (!graph || limits.maxDepth === 0) return;
    let frontier = [from];
    const seen = new Set([pathKey(from)]);
    for (let depth = 1; depth <= limits.maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const to of [...(graph.edges.get(f) ?? [])].sort()) {
          if (seen.has(pathKey(to))) continue;
          seen.add(pathKey(to));
          next.push(to);
          const cats = categoriesOf(to);
          const bump = cats.includes("shared-guard") || cats.includes("contract") ? 0 : 2;
          propose(to, "imported", depth, why(to), priority + depth + bump);
        }
      }
      frontier = next;
    }
  };

  if (mode === "incremental") {
    for (const s of subjectsOut) {
      if (s.change === "removed") continue;
      const suffix = categoryCode(s.categories);
      importersBfs(s.path, () => reason(`IMPORTS_CHANGED${suffix}`, { path: s.path }, s.path), suffix === "_GUARD" ? 0 : 1);
      importsOf(s.path, (to) => reason("IMPORTED_BY_CHANGED", { path: s.path, category: categoriesOf(to)[0] ?? "code" }, s.path), 2);
      if (s.categories.includes("dependency-manifest")) {
        if (path.posix.basename(s.path) === "package.json") {
          const before = dependencyNames(baseView?.read(s.previousPath ?? s.path)?.toString("utf8") ?? null);
          const after = dependencyNames(tv.read(s.path)?.toString("utf8") ?? null);
          const changed = [...new Set([...before.keys(), ...after.keys()])].filter((n) => before.get(n) !== after.get(n)).sort();
          for (const name of changed) {
            for (const user of [...(graph?.packageUsers.get(name) ?? [])].sort()) propose(user, "dependency-user", 1, reason("USES_CHANGED_DEPENDENCY", { name, path: s.path }, s.path), 1);
          }
        } else unknown("DEPENDENCY_CHANGE_UNMAPPED", s.path, path.posix.basename(s.path));
      } else if (s.categories.includes("configuration") && !s.categories.includes("code") && !(graph?.importers.get(s.path)?.size)) {
        unknown("CONFIG_CONSUMERS_UNKNOWN", s.path, path.posix.basename(s.path));
      }
    }
    // Files that still import a removed or renamed path (their import is now broken or stale).
    for (const s of subjectsOut) {
      const old = s.change === "removed" ? s.path : s.change === "renamed" ? s.previousPath : undefined;
      if (!old || !graph) continue;
      for (const u of graph.unresolved) {
        if (u.candidate === null || !namesOldPath(u.candidate, old)) continue;
        propose(u.from, "importer", 1, reason(s.change === "removed" ? "IMPORTS_REMOVED" : "IMPORTS_RENAMED_OLD_PATH", { path: old, now: s.path }, old), 0);
      }
    }
  } else if (mode === "selected") {
    for (const s of subjectsOut) {
      importsOf(s.path, () => reason("IMPORTED_BY_SUBJECT", { path: s.path }, s.path), 1);
      importersBfs(s.path, () => reason("IMPORTS_SUBJECT", { path: s.path }, s.path), 3);
    }
  }
  // Prior unresolved units the change reaches return to the plan as subjects.
  if (reuse && mode === "incremental") {
    for (const id of [...reuse.pending].sort()) {
      const c = candidates.get(pathKey(id));
      if (!c) continue;
      candidates.delete(pathKey(id));
      addSubject(c.path, "unchanged", [reason("PRIOR_UNRESOLVED_AFFECTED", { runId: reuse.baselineRunId ?? "-" }), ...c.reasons]);
    }
  }
  for (const a of allow) {
    const files = tv.files.filter((f) => matchesPath(f, a));
    if (files.length === 0) warnings.push(warning("SCOPE_ALLOW_EMPTY", { path: a }));
    for (const f of files) propose(f, "explicit", 0, reason("EXPLICITLY_ALLOWED", { path: a }), -1, true);
  }

  // 7. Limits: the proposal inside them is the allowed context; the rest is recommended, never read silently.
  const contextOut: ScopeContextEntry[] = [];
  const recommended: Array<{ path: string; reasons: Reason[] }> = [];
  let usedFiles = 0;
  let usedBytes = 0;
  const ordered = [...candidates.values()].sort((a, b) => a.priority - b.priority || a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const c of ordered) {
    const bytes = tv.size(c.path) ?? 0;
    if (!c.explicit) {
      if (usedFiles >= limits.maxFiles) {
        recommended.push({ path: c.path, reasons: [...c.reasons, reason("LIMIT_FILES", { max: limits.maxFiles })] });
        continue;
      }
      if (usedBytes + bytes > limits.maxBytes) {
        recommended.push({ path: c.path, reasons: [...c.reasons, reason("LIMIT_BYTES", { max: limits.maxBytes })] });
        continue;
      }
      usedFiles++;
      usedBytes += bytes;
    }
    contextOut.push({ path: c.path, relation: c.relation, depth: c.depth, bytes, categories: categoriesOf(c.path), reasons: c.reasons });
  }
  sortByPath(contextOut);
  sortByPath(recommended);

  // 8. Unknowns of the graph: computed imports anywhere may hide importers; unresolved ones matter inside the region.
  if (graph) {
    const region = new Set([...subjectsOut.map((s) => s.path), ...contextOut.map((c) => c.path)]);
    for (const u of graph.unknowns) {
      if (mode === "selected" && !region.has(u.path)) continue;
      unknown(u.code, u.path, u.detail);
    }
    for (const u of graph.unresolved) {
      if (!region.has(u.from)) continue;
      const broken = subjectsOut.some((s) => (s.change === "removed" || s.change === "renamed") && u.candidate !== null && namesOldPath(u.candidate, s.change === "removed" ? s.path : (s.previousPath ?? "")));
      if (!broken) unknown("UNRESOLVED_IMPORT", u.from, u.spec);
    }
  }

  // 9. Does the working tree hold the target's content for what a context-only review reads from disk?
  let matches = target.kind !== "commit";
  if (target.kind === "commit") {
    const head = git.repository ? git.head : null;
    const overlayKeys = new Set(target.overlay.map(pathKey));
    const read = [...subjectsOut.filter((s) => s.disposition === "examine" && s.change !== "removed").map((s) => s.path), ...contextOut.map((c) => c.path)];
    matches = head === target.commit && workingDirty !== null && read.every((p) => !workingDirty!.has(pathKey(p)) || overlayKeys.has(pathKey(p)));
  }

  return {
    resolution: finish({
      target,
      ends,
      subjectsOut: sortByPath(subjectsOut),
      contextOut,
      changes,
      recommended,
      excludedOut: sortByPath(excludedOut),
      notApplicable: sortByPath(notApplicable),
      reuse,
      graph,
      repositoryFiles: tv.files.length,
      matches,
      baselineCode,
      baselineRunId,
    }),
    workspace: { target: tv, base: baseView, graph },
  };

  interface FinishInput {
    target: TargetDescription;
    ends: Ends | null;
    subjectsOut: ScopeSubjectEntry[];
    contextOut: ScopeContextEntry[];
    changes: DiffEntry[];
    recommended: Array<{ path: string; reasons: Reason[] }>;
    excludedOut: Array<{ path: string; reason: Reason }>;
    notApplicable?: Array<{ path: string; reason: Reason }>;
    reuse: ReuseCheck | null;
    graph: ImportGraph | null;
    repositoryFiles: number;
    matches: boolean;
    baselineCode: string | null;
    baselineRunId?: string | null;
  }

  function finish(input: FinishInput): SemanticScopeResolution {
    const reuseReport = {
      baselineRunId: input.reuse?.baselineRunId ?? input.baselineRunId ?? null,
      reused: input.reuse?.reused ?? [],
      invalidated: input.reuse?.invalidated ?? [],
      notCarried: input.reuse?.notCarried ?? [],
    };
    const code = input.reuse ? (reuseReport.reused.length > 0 ? "CARRIED_WITH_EVIDENCE" : "NOTHING_REUSABLE") : (input.baselineCode ?? "NO_BASELINE");
    const inherited: InheritedCoverage = {
      state: code === "CARRIED_WITH_EVIDENCE" ? "partial" : "none",
      code,
      message: t(`scope_inherited_${code.toLowerCase()}`, { runId: reuseReport.baselineRunId ?? "-", count: reuseReport.reused.length }),
      baselineRunId: reuseReport.baselineRunId,
      units: reuseReport.reused.length,
    };
    if (mode !== "full" && input.subjectsOut.length === 0 && blockers.length === 0) blockers.push(blocker(mode === "incremental" ? "SCOPE_NO_CHANGES" : "SCOPE_EMPTY"));
    const firstMessage = (rs: Reason[]): string => rs.map((r) => r.message).join("; ") || "-";
    const baselineId = reuseReport.baselineRunId && /^(run|sem)_[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(reuseReport.baselineRunId) ? reuseReport.baselineRunId : null;
    const spec: ScopeSpec = {
      schemaVersion: 1,
      mode,
      subjects: mode === "full" ? [] : subjects,
      exclusions,
      resolved: { base: input.ends?.base ?? null, target: input.ends?.target ?? { ref: null, commit: null, sourceId: null }, dirtyInputs: input.ends?.dirtyInputs ?? [] },
      baselineRunId: baselineId,
      context: {
        allowed: input.contextOut.map((c) => ({ kind: "path" as const, value: c.path, reason: firstMessage(c.reasons) })),
        expansion: { maxFiles: limits.maxFiles, maxDepth: limits.maxDepth, maxBytes: limits.maxBytes },
      },
      units: {
        effective: input.subjectsOut.map((s) => ({ id: s.path, reason: firstMessage(s.reasons) })),
        examined: [],
        reused: input.subjectsOut
          .filter((s) => s.disposition === "reused")
          .map((s) => {
            const r = reuseReport.reused.find((x) => pathKey(x.id) === pathKey(s.path));
            return { id: s.path, reason: firstMessage(r?.reasons ?? s.reasons), evidence: { runId: r?.evidence?.runId ?? baselineId ?? "sem_unknown", gate: "semantic" as const } };
          }),
        omitted: [
          ...input.excludedOut.map((e) => ({ id: e.path, reason: e.reason.message })),
          ...(input.notApplicable ?? []).map((e) => ({ id: e.path, reason: e.reason.message })),
          ...input.recommended.map((r) => ({ id: r.path, reason: firstMessage(r.reasons) })),
        ],
      },
    };
    if (blockers.length === 0) {
      const problems = validateGateRecord("scope", spec);
      if (problems.length > 0) blockers.push(blocker("SCOPE_RECORD_INVALID", { problems: problems.slice(0, 5).join("; ") }));
    }
    const toExamine = input.subjectsOut.filter((s) => s.disposition === "examine").length;
    const reused = input.subjectsOut.length - toExamine;
    const body = {
      mode,
      repositoryId: input.ends?.repositoryId ?? null,
      spec,
      target: input.target,
      subjects: input.subjectsOut,
      context: input.contextOut,
      impact: {
        extractor: extractorInfo(input.graph),
        changes: input.changes.map((c) => ({ path: c.path, change: changeKinds.get(pathKey(c.path)) ?? c.change, ...(c.previousPath ? { previousPath: c.previousPath } : {}), categories: categoriesOf(c.path) })),
        unknowns,
        recommendedExpansion: input.recommended,
      },
      exclusions: { patterns: exclusions, excluded: input.excludedOut },
      policy: { context: policy, ...limits },
      reuse: reuseReport,
      inheritedCoverage: inherited,
      completion: {
        repositoryFiles: input.repositoryFiles,
        subjects: input.subjectsOut.length,
        toExamine,
        reused,
        context: input.contextOut.length,
        excluded: input.excludedOut.length,
        claim: mode === "full" ? ("repository-applicable" as const) : ("scope-only" as const),
      },
      workingTreeMatchesTarget: input.matches,
    };
    return { schemaVersion: 1, scopeHash: contentHash({ v: 1, ...(withoutText(body) as object) }), ...body, blockers: [...blockers], warnings: [...warnings] };
  }
}

/** sha256 of a buffer (exported for the run ledger). */
export { sha256 };
