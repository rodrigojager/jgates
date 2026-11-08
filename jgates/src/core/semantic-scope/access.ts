// The host file-access guard of a resolved scope. Every read a Semantic module makes (the general review's context, an
// executor's read/list/search tools) goes through it: subjects and the previewed context are readable; exclusions are
// always refused (strict); anything else is refused under the strict policy and recorded as a recommended expansion,
// or admitted under the bounded policy only while the configured limits allow, each admission recorded with its reason.
// Paths that leave the workspace are refused before anything is looked up. Repository text never changes these rules:
// they are code, not prompt.
import path from "node:path";
import { isExcluded } from "../../adapters/semantic-gate/mask.js";
import { translator } from "../../i18n/index.js";
import { matchesPath, normalizeScopePath, openTarget } from "./resolve.js";
import { pathKey, type FileView } from "./views.js";
import type { SemanticScopeResolution } from "./types.js";

const t = translator("semantic-scope");

export type AccessRole = "subject" | "reused" | "context" | "expanded";
export type AccessCode = "SUBJECT" | "REUSED" | "CONTEXT" | "EXPANDED" | "EXCLUDED" | "OUTSIDE_SCOPE" | "PATH_ESCAPE" | "NOT_FOUND" | "EXPANSION_LIMIT";

export interface AccessDecision {
  path: string;
  allowed: boolean;
  role: AccessRole | null;
  code: AccessCode;
  message: string;
}

export interface AccessViolation {
  path: string;
  code: AccessCode;
  reason: string;
  at: string;
}

export class ScopeAccessError extends Error {
  constructor(readonly decision: AccessDecision) {
    super(decision.message);
    this.name = "ScopeAccessError";
  }
}

export interface ScopeAccessGuard {
  /** Whether a path may be read, and as what; never records anything. */
  check(p: string): AccessDecision;
  /** Reads a path at the target; refused reads are recorded and throw ScopeAccessError. */
  read(p: string): string;
  /** Asks for a file outside the previewed context (bounded policy only, inside the limits); recorded either way. */
  requestExpansion(p: string, reason: string): AccessDecision;
  /** The readable files (subjects, reused and context), sorted. */
  readable(): string[];
  violations(): AccessViolation[];
  expansions(): Array<{ path: string; reason: string; bytes: number }>;
}

export interface GuardOptions {
  workspacePath: string;
  resolution: SemanticScopeResolution;
  env?: NodeJS.ProcessEnv;
  /** The target view (opened from the resolution when absent). */
  view?: FileView;
  now?: () => Date;
}

export function createScopeGuard(options: GuardOptions): ScopeAccessGuard {
  const { resolution } = options;
  let view: FileView | null = options.view ?? null;
  const target = (): FileView => (view ??= openTarget(options.workspacePath, resolution.target, options.env ?? process.env));
  const now = options.now ?? (() => new Date());
  const roles = new Map<string, AccessRole>();
  for (const s of resolution.subjects) if (s.change !== "removed") roles.set(pathKey(s.path), s.disposition === "reused" ? "reused" : "subject");
  for (const c of resolution.context) roles.set(pathKey(c.path), "context");
  const patterns = resolution.exclusions.patterns;
  const violations: AccessViolation[] = [];
  const expansions: Array<{ path: string; reason: string; bytes: number }> = [];
  let expandedBytes = resolution.context.reduce((n, c) => n + c.bytes, 0);
  let expandedFiles = resolution.context.filter((c) => c.relation !== "explicit").length;

  const decide = (raw: string): AccessDecision => {
    const p = normalizeScopePath(String(raw));
    const deny = (code: AccessCode, shown: string): AccessDecision => ({ path: shown, allowed: false, role: null, code, message: t(`scope_access_${code.toLowerCase()}`, { path: shown }) });
    if (p === null || p === "") return deny("PATH_ESCAPE", String(raw));
    if (patterns.some((g) => matchesPath(p, g) || isExcluded(p, [g]))) return deny("EXCLUDED", p);
    const role = roles.get(pathKey(p));
    if (!role) return deny("OUTSIDE_SCOPE", p);
    const code: AccessCode = role === "subject" ? "SUBJECT" : role === "reused" ? "REUSED" : role === "context" ? "CONTEXT" : "EXPANDED";
    return { path: p, allowed: true, role, code, message: t(`scope_access_${code.toLowerCase()}`, { path: p }) };
  };
  const record = (d: AccessDecision): void => {
    violations.push({ path: d.path, code: d.code, reason: d.message, at: now().toISOString() });
  };

  return {
    check: decide,
    read(raw) {
      const d = decide(raw);
      if (!d.allowed) {
        record(d);
        throw new ScopeAccessError(d);
      }
      const buf = target().read(d.path);
      if (buf === null) {
        const missing: AccessDecision = { ...d, allowed: false, role: null, code: "NOT_FOUND", message: t("scope_access_not_found", { path: d.path }) };
        record(missing);
        throw new ScopeAccessError(missing);
      }
      return buf.toString("utf8");
    },
    requestExpansion(raw, why) {
      const d = decide(raw);
      if (d.allowed || d.code === "EXCLUDED" || d.code === "PATH_ESCAPE") {
        if (!d.allowed) record(d);
        return d;
      }
      const p = d.path;
      const size = target().size(p);
      if (size === null) {
        const missing: AccessDecision = { ...d, code: "NOT_FOUND", message: t("scope_access_not_found", { path: p }) };
        record(missing);
        return missing;
      }
      if (resolution.policy.context !== "bounded" || expandedFiles >= resolution.policy.maxFiles || expandedBytes + size > resolution.policy.maxBytes) {
        const refused: AccessDecision = { ...d, code: resolution.policy.context === "bounded" ? "EXPANSION_LIMIT" : "OUTSIDE_SCOPE", message: t(resolution.policy.context === "bounded" ? "scope_access_expansion_limit" : "scope_access_outside_scope", { path: p }) };
        record(refused);
        return refused;
      }
      expandedFiles++;
      expandedBytes += size;
      roles.set(pathKey(p), "expanded");
      expansions.push({ path: p, reason: String(why).slice(0, 300), bytes: size });
      return { path: p, allowed: true, role: "expanded", code: "EXPANDED", message: t("scope_access_expanded", { path: p }) };
    },
    readable() {
      const out = [...resolution.subjects.filter((s) => s.change !== "removed").map((s) => s.path), ...resolution.context.map((c) => c.path), ...expansions.map((e) => e.path)];
      return [...new Set(out)].sort();
    },
    violations: () => [...violations],
    expansions: () => [...expansions],
  };
}

/** Converts a repository-root-relative path (as Git and semantic-gate print it) to a workspace-relative one. */
export function fromRepositoryPath(p: string, prefix: string): string | null {
  const n = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (prefix === "") return n;
  return n.startsWith(prefix) ? n.slice(prefix.length) : null;
}

export const toRepositoryPath = (p: string, prefix: string): string => path.posix.join(prefix, p);
