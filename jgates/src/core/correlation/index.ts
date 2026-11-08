// Root-cause correlation across tools and methods. It groups findings that share one root cause (a Quality finding
// such as a Semgrep result, a Semantic candidate of any method, the variants of a confirmed seed) while keeping every
// original finding untouched: each group member carries the original object, its tool or method, its run and its own
// validation state. Correlation never decides, merges or drops a verdict: a group can hold a confirmed candidate, a
// rejected one and an unvalidated scanner result side by side, and it says so (disagreement). Per-tool fingerprints stay
// on the originals for baselines; independent refutation records stay inside their candidate.
//
// Grouping is deterministic: two members join when they name the same explicit root-cause key or one names the other
// (a variant names its seed's run/candidate or fingerprint),
// or when they have the same known root-cause class (CWE first, then rule/category/title keywords) in the same file at
// lines within the window (any place a member points to: its location, its trace steps and its evidence). A member whose
// class is unknown joins only through an explicit key. Every input appears in exactly one group (singletons included).
import fs from "node:fs";
import path from "node:path";

export const CORRELATION_FILE = "evidence/correlation.json";
export const DEFAULT_LINE_WINDOW = 3;

export type MemberOrigin = "quality" | "semantic";
export type ValidationState = "tool-reported" | "waived" | "confirmed" | "needs-validation" | "rejected" | "unresolved" | "open";

export interface RootCauseClass {
  id: string;
  label: string;
  cwe: string[];
  keywords: RegExp;
}

/** Known root-cause classes, in match order (more specific first). */
export const ROOT_CAUSE_CLASSES: readonly RootCauseClass[] = [
  { id: "sql-injection", label: "SQL injection", cwe: ["CWE-89", "CWE-564"], keywords: /\bsql\w*[\s_-]*(injection|string[\s_-]*building|concat\w*|interpolat\w*)|\bsqli\b|\binjection\b[^.]*\bsql\b|\bsql\b[^.]*\b(text|statement|query)\b[^.]*\b(built|concatenat\w*|interpolat\w*)/i },
  { id: "command-injection", label: "OS command injection", cwe: ["CWE-78", "CWE-77"], keywords: /\b(os[\s_-]*)?command[\s_-]*injection\b|\bshell[\s_-]*(injection|command)\b/i },
  { id: "code-injection", label: "Code injection", cwe: ["CWE-94", "CWE-95"], keywords: /\b(code|eval)[\s_-]*injection\b|\bdynamic[\s_-]*code[\s_-]*execution\b/i },
  { id: "path-traversal", label: "Path traversal", cwe: ["CWE-22", "CWE-23"], keywords: /\bpath[\s_-]*traversal\b|\bdirectory[\s_-]*traversal\b|\bzip[\s_-]*slip\b/i },
  { id: "ssrf", label: "Server-side request forgery", cwe: ["CWE-918"], keywords: /\bssrf\b|\bserver[\s_-]*side[\s_-]*request[\s_-]*forgery\b/i },
  { id: "xss", label: "Cross-site scripting", cwe: ["CWE-79"], keywords: /\bxss\b|\bcross[\s_-]*site[\s_-]*scripting\b/i },
  { id: "deserialization", label: "Unsafe deserialization", cwe: ["CWE-502"], keywords: /\b(unsafe|insecure)[\s_-]*(deserializ\w*|yaml[\s_-]*load)\b/i },
  { id: "broken-access-control", label: "Broken access control (IDOR / missing ownership)", cwe: ["CWE-639", "CWE-284", "CWE-285", "CWE-862", "CWE-863", "CWE-566"], keywords: /\bidor\b|\binsecure[\s_-]*direct[\s_-]*object\b|\b(missing|no)[\s_-]*(ownership|authori[sz]ation|access)[\s_-]*check\b|\bownership\b|\bcross[\s_-]*(tenant|user)\b|\bclient[\s_-]*controlled[\s_-]*privilege\b|\bbroken[\s_-]*access[\s_-]*control\b/i },
  { id: "authentication", label: "Missing or broken authentication", cwe: ["CWE-287", "CWE-306"], keywords: /\b(missing|broken|bypass\w*)[\s_-]*authenticat\w*\b|\bauthenticat\w*[\s_-]*bypass\b/i },
  { id: "jwt-verification", label: "JWT signature not verified", cwe: ["CWE-347"], keywords: /\bjwt\b[^.]*\b(signature|verif\w*)\b/i },
  { id: "tls-verification", label: "TLS verification disabled", cwe: ["CWE-295"], keywords: /\btls[\s_-]*verification\b|\bcertificate[\s_-]*(validation|verification)\b|\binsecure[\s_-]*skip[\s_-]*verify\b/i },
  { id: "cors", label: "Permissive CORS", cwe: ["CWE-942"], keywords: /\bcors\b/i },
  { id: "csrf", label: "Cross-site request forgery", cwe: ["CWE-352"], keywords: /\bcsrf\b|\bcross[\s_-]*site[\s_-]*request[\s_-]*forgery\b/i },
  { id: "weak-crypto", label: "Weak cryptography", cwe: ["CWE-327", "CWE-328", "CWE-326"], keywords: /\bweak[\s_-]*(hash|cipher|crypto\w*)\b|\bmd5\b|\bsha-?1\b/i },
  { id: "insecure-default", label: "Insecure default or fallback", cwe: ["CWE-1188", "CWE-453", "CWE-1393"], keywords: /\b(insecure|fail[\s_-]*open)[\s_-]*default\w*\b|\bfallback[\s_-]*secret\b|\bdefault[\s_-]*credential\w*\b|\bfail[\s_-]*open\b/i },
  { id: "hardcoded-secret", label: "Hard-coded secret", cwe: ["CWE-798", "CWE-259"], keywords: /\bhard[\s_-]*coded[\s_-]*(secret|password|credential|key)\b/i },
  { id: "open-redirect", label: "Open redirect", cwe: ["CWE-601"], keywords: /\bopen[\s_-]*redirect\b/i },
];

export interface CorrelationMember {
  /** Stable within a report: origin, run and the finding's index or candidate ID. */
  id: string;
  origin: MemberOrigin;
  runId: string | null;
  /** The tool that reported it (semgrep, codeql...) or semantic-gate for a model candidate. */
  tool: string;
  /** The Semantic method (module) that produced a candidate; null for a Quality finding. */
  method: string | null;
  location: { path: string; line: number | null };
  rootCause: { class: string; label: string; basis: "explicit-key" | "cwe" | "keywords" | "unknown"; key: string | null };
  validation: { state: ValidationState; by: string | null; reason: string | null };
  /** Identities other members may name as their root-cause key (a candidate's run/ID and its record fingerprint). */
  aliases: string[];
  /** The original finding or candidate, deep-copied, never modified. */
  original: Record<string, unknown>;
}

export interface CorrelationGroup {
  id: string;
  /** The places the members point to (locations, trace steps, evidence), sorted. */
  rootCause: { class: string; label: string; key: string | null; anchors: Array<{ path: string; line: number | null }> };
  members: CorrelationMember[];
  tools: string[];
  methods: string[];
  origins: MemberOrigin[];
  /** Counts of the members' own states; the group has no verdict of its own. */
  validation: Record<ValidationState, number>;
  /** Members disagree: one confirmed and another rejected. */
  disagreement: boolean;
}

export interface CorrelationReport {
  schemaVersion: 1;
  kind: "jgates-root-cause-correlation";
  generatedAt: string;
  rules: { lineWindow: number; classes: string[] };
  inputs: Array<{ origin: MemberOrigin; runId: string | null; members: number }>;
  groups: CorrelationGroup[];
  /** Groups with more than one member (related findings). */
  correlated: number;
  members: number;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const posix = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\/+/, "");

/** The root-cause class of a text (CWE tokens first, then keywords). */
export function classifyRootCause(texts: ReadonlyArray<unknown>): { class: string; label: string; basis: "cwe" | "keywords" | "unknown" } {
  const text = texts.filter((t) => typeof t === "string" && t !== "").join(" \n ");
  const cwes = new Set([...text.matchAll(/\bCWE[-_ ]?(\d+)\b/gi)].map((m) => `CWE-${m[1]}`));
  for (const c of ROOT_CAUSE_CLASSES) if (c.cwe.some((x) => cwes.has(x))) return { class: c.id, label: c.label, basis: "cwe" };
  for (const c of ROOT_CAUSE_CLASSES) if (c.keywords.test(text)) return { class: c.id, label: c.label, basis: "keywords" };
  return { class: "unknown", label: "Unknown root cause", basis: "unknown" };
}

/** A Quality result's findings as members (semgrep, codeql... each with its own tool and fingerprint). */
export function qualityMembers(result: Record<string, unknown>): CorrelationMember[] {
  const runId = typeof result.runId === "string" ? result.runId : null;
  const findings = Array.isArray(result.findings) ? result.findings : [];
  return findings.filter(isObj).map((f, i) => {
    const loc = isObj(f.location) ? f.location : {};
    const cls = classifyRootCause([f.ruleId, f.category, f.message, f.cwe]);
    return {
      id: `quality:${runId ?? "-"}:${i}`,
      origin: "quality",
      runId,
      tool: String(f.tool ?? "unknown"),
      method: null,
      location: { path: posix(String(loc.path ?? "")), line: typeof loc.line === "number" ? loc.line : null },
      rootCause: { ...cls, key: null },
      validation: { state: f.waived === true ? "waived" : "tool-reported", by: String(f.tool ?? "unknown"), reason: f.waived === true ? String(f.waiverReason ?? "waived") : null },
      aliases: [],
      original: clone(f),
    };
  });
}

/** A Semantic result's investigation candidates as members, every status kept (rejected and unresolved too). */
export function semanticMembers(result: Record<string, unknown>): CorrelationMember[] {
  const runId = typeof result.runId === "string" ? result.runId : null;
  const inv = (result.semanticRun as { outcome?: { investigation?: Record<string, unknown> } } | undefined)?.outcome?.investigation;
  const method = isObj(inv?.module) ? String(inv.module.id ?? "") || null : null;
  const candidates = Array.isArray(inv?.candidates) ? inv.candidates : [];
  return candidates.filter(isObj).map((c) => {
    const details = isObj(c.details) ? { ...(isObj(c.details.record) ? c.details.record : {}), ...c.details } : {};
    const validation = isObj(c.validation) ? c.validation : null;
    const key = typeof details.root_cause_key === "string" && details.root_cause_key !== "" ? details.root_cause_key : null;
    const cls = classifyRootCause([details.cwe, c.title, c.category, details.root_cause, details.claimed_root_cause, details.attack_class, c.rationale]);
    const status = String(c.status ?? "open");
    return {
      id: `semantic:${runId ?? "-"}:${String(c.id ?? "")}`,
      origin: "semantic",
      runId,
      tool: "semantic-gate",
      method,
      location: { path: posix(String(c.path ?? "")), line: typeof c.line === "number" ? c.line : null },
      rootCause: key ? { ...cls, basis: cls.basis === "unknown" ? "explicit-key" : cls.basis, key } : { ...cls, key: null },
      aliases: [`${runId ?? "-"}/${String(c.id ?? "")}`, ...(typeof details.fingerprint === "string" && details.fingerprint !== "" ? [details.fingerprint] : [])],
      validation: { state: (["confirmed", "needs-validation", "rejected", "unresolved", "open"].includes(status) ? status : "open") as ValidationState, by: validation ? String(validation.context ?? "") || null : null, reason: validation ? String(validation.reason ?? "") || null : (typeof c.reason === "string" ? c.reason : null) },
      original: clone(c),
    };
  });
}

/**
 * Every place a member points to: its location, and for a candidate the steps of its trace and its evidence (a
 * source-to-sink record names the line a scanner flags even when its own location is the sink in another file).
 */
function anchorsOf(m: CorrelationMember): Array<{ path: string; line: number | null }> {
  const out = new Map<string, { path: string; line: number | null }>();
  const add = (p: string, line: number | null): void => {
    if (p !== "") out.set(`${p}\0${line ?? ""}`, { path: p, line });
  };
  add(m.location.path, m.location.line);
  const o = m.original;
  const refs: unknown[] = [];
  // A module's structured record may sit in the details or under details.record (the security-audit records).
  for (const d of isObj(o.details) ? [o.details, ...(isObj(o.details.record) ? [o.details.record] : [])] : []) refs.push(...(Array.isArray(d.trace) ? d.trace : []), ...(Array.isArray(d.evidence) ? d.evidence : []));
  if (isObj(o.validation) && Array.isArray(o.validation.evidence)) refs.push(...o.validation.evidence);
  for (const r of refs) {
    if (!isObj(r)) continue;
    add(posix(String(r.file ?? r.path ?? "")), typeof r.line === "number" ? r.line : null);
  }
  return [...out.values()];
}

/** Whether two anchor sets share a file at lines within the window (a file-level anchor matches only another one). */
function near(a: ReadonlyArray<{ path: string; line: number | null }>, b: ReadonlyArray<{ path: string; line: number | null }>, window: number): boolean {
  return a.some((x) => b.some((y) => x.path === y.path && (x.line === null || y.line === null ? x.line === y.line : Math.abs(x.line - y.line) <= window)));
}

function uniqueAnchors(xs: Array<{ path: string; line: number | null }>): Array<{ path: string; line: number | null }> {
  const m = new Map(xs.map((x) => [`${x.path}\0${x.line ?? ""}`, x]));
  return [...m.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0)));
}

/** Groups members by root cause; every member lands in exactly one group, unchanged. */
export function correlateMembers(members: readonly CorrelationMember[], options: { lineWindow?: number; now?: Date } = {}): CorrelationReport {
  const window = options.lineWindow ?? DEFAULT_LINE_WINDOW;
  const parent = members.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] as number)));
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const anchors = members.map(anchorsOf);
  for (let a = 0; a < members.length; a++) {
    for (let b = a + 1; b < members.length; b++) {
      const x = members[a] as CorrelationMember;
      const y = members[b] as CorrelationMember;
      const keyed = (m: CorrelationMember, o: CorrelationMember): boolean => !!m.rootCause.key && (m.rootCause.key === o.rootCause.key || o.aliases.includes(m.rootCause.key));
      if (keyed(x, y) || keyed(y, x)) {
        union(a, b);
        continue;
      }
      if (x.rootCause.class === "unknown" || x.rootCause.class !== y.rootCause.class) continue;
      if (near(anchors[a] as Array<{ path: string; line: number | null }>, anchors[b] as Array<{ path: string; line: number | null }>, window)) union(a, b);
    }
  }
  const byRoot = new Map<number, number[]>();
  members.forEach((_, i) => byRoot.set(find(i), [...(byRoot.get(find(i)) ?? []), i]));
  const groups: CorrelationGroup[] = [];
  for (const idx of [...byRoot.values()].sort((a, b) => (a[0] as number) - (b[0] as number))) {
    const ms = idx.map((i) => members[i] as CorrelationMember);
    const known = ms.find((m) => m.rootCause.class !== "unknown") ?? (ms[0] as CorrelationMember);
    const count = Object.fromEntries((["tool-reported", "waived", "confirmed", "needs-validation", "rejected", "unresolved", "open"] as ValidationState[]).map((s) => [s, ms.filter((m) => m.validation.state === s).length])) as Record<ValidationState, number>;
    groups.push({
      id: `G${groups.length + 1}`,
      rootCause: { class: known.rootCause.class, label: known.rootCause.label, key: ms.find((m) => m.rootCause.key)?.rootCause.key ?? null, anchors: uniqueAnchors(idx.flatMap((i) => anchors[i] as Array<{ path: string; line: number | null }>)) },
      members: ms,
      tools: [...new Set(ms.map((m) => m.tool))].sort(),
      methods: [...new Set(ms.map((m) => m.method).filter((m): m is string => !!m))].sort(),
      origins: [...new Set(ms.map((m) => m.origin))].sort() as MemberOrigin[],
      validation: count,
      disagreement: count.confirmed > 0 && count.rejected > 0,
    });
  }
  const inputs = new Map<string, { origin: MemberOrigin; runId: string | null; members: number }>();
  for (const m of members) {
    const k = `${m.origin}\0${m.runId ?? ""}`;
    const e = inputs.get(k) ?? { origin: m.origin, runId: m.runId, members: 0 };
    e.members++;
    inputs.set(k, e);
  }
  return {
    schemaVersion: 1,
    kind: "jgates-root-cause-correlation",
    generatedAt: (options.now ?? new Date()).toISOString(),
    rules: { lineWindow: window, classes: ROOT_CAUSE_CLASSES.map((c) => c.id) },
    inputs: [...inputs.values()],
    groups,
    correlated: groups.filter((g) => g.members.length > 1).length,
    members: members.length,
  };
}

/** The members of one run's result document (Quality findings, or a Semantic run's candidates). */
export function membersOfResult(result: Record<string, unknown>): CorrelationMember[] {
  return result.gate === "semantic" || isObj(result.semanticRun) ? semanticMembers(result) : qualityMembers(result);
}

/** Correlates the runs in the given run folders (each with its result.json); optionally writes the report. */
export function correlateRunDirs(dirs: readonly string[], options: { lineWindow?: number; now?: Date; write?: string } = {}): CorrelationReport {
  const members = dirs.flatMap((d) => membersOfResult(JSON.parse(fs.readFileSync(path.join(d, "result.json"), "utf8")) as Record<string, unknown>));
  const report = correlateMembers(members, options);
  if (options.write) writeCorrelation(options.write, report);
  return report;
}

export function writeCorrelation(file: string, report: CorrelationReport): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
