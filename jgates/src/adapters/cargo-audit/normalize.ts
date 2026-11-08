// Normalizes the JSON of `cargo-audit audit --json` (fixtures of cargo-audit 0.22.2 in
// tests/fixtures/stack-extensions/recorded). `vulnerabilities.list` holds the RustSec advisories that affect a locked
// package: they block. `warnings` (unmaintained, unsound, notice, yanked) are reported but never block. Fail-closed:
// a document without the database, lockfile and vulnerabilities sections, or an entry without an advisory id and a
// package, proves nothing.
import { contentHash } from "../../core/ids/index.js";
import type { NormalizedSeverity, ResultFinding } from "../../core/run/types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export interface CargoAuditParse {
  ok: boolean;
  findings: ResultFinding[];
  /** Informational warnings among the findings (they never block). */
  warnings: number;
  /** How many locked packages the audit read. */
  dependencyCount: number | null;
  problem?: string;
}

const fail = (problem: string): CargoAuditParse => ({ ok: false, findings: [], warnings: 0, dependencyCount: null, problem });

const WARNING_SEVERITY: Record<string, NormalizedSeverity> = { unsound: "low", unmaintained: "info", notice: "info", yanked: "info" };

function entryFinding(entry: Rec, kind: "vulnerability" | string, opts: { stageId: string; version: string | null; lockfile: string }): ResultFinding | string {
  const advisory = isRec(entry.advisory) ? entry.advisory : null;
  const pkg = isRec(entry.package) ? entry.package : null;
  const name = pkg ? str(pkg.name) : null;
  const installed = pkg ? str(pkg.version) : null;
  // A yanked package has no advisory; it is identified by the package itself.
  const id = advisory ? str(advisory.id) : kind === "yanked" ? "yanked" : null;
  if (!id || !name || !installed) return `an entry of the kind ${kind} has no advisory id or no package`;
  const title = (advisory ? str(advisory.title) : null) ?? (kind === "yanked" ? "the locked version was yanked from crates.io" : id);
  const versions = isRec(entry.versions) ? entry.versions : null;
  const patched = versions && Array.isArray(versions.patched) ? versions.patched.filter((p): p is string => typeof p === "string") : [];
  const cvss = advisory ? str(advisory.cvss) : null;
  const aliases = advisory && Array.isArray(advisory.aliases) ? advisory.aliases.filter((a): a is string => typeof a === "string") : [];
  const blocking = kind === "vulnerability";
  const normalized: NormalizedSeverity = blocking ? "unknown" : (WARNING_SEVERITY[kind] ?? "info");
  const url = advisory ? str(advisory.url) : null;
  return {
    stageId: opts.stageId,
    tool: "cargo-audit",
    ...(opts.version ? { toolVersion: opts.version } : {}),
    ruleId: id === "yanked" ? `yanked:${name}` : id,
    category: "dependencies",
    severity: blocking ? (cvss ? `cvss ${cvss}` : "unknown") : kind,
    normalizedSeverity: normalized,
    message: `${title} (${name} ${installed}${patched.length > 0 ? `; patched in ${patched.join(" or ")}` : kind === "vulnerability" ? "; no patched version" : ""}${aliases.length > 0 ? `; ${aliases.join(", ")}` : ""}${blocking ? "" : `; ${kind}`})`,
    location: { path: opts.lockfile },
    fingerprint: contentHash({ tool: "cargo-audit", rule: id, package: name, version: installed, lockfile: opts.lockfile }),
    origin: "cargo-audit",
    blocking,
    ...(blocking ? { blockingReason: "blocking-tool" as const } : {}),
    waived: false,
    ...(url ? { docsUrl: url } : {}),
    ...(patched.length > 0 ? { remediation: `Upgrade ${name} to ${patched.join(" or ")}.` } : {}),
  };
}

export function parseCargoAuditOutput(stdout: string, opts: { stageId: string; version: string | null; root: string }): CargoAuditParse {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!isRec(doc) || !isRec(doc.database) || !isRec(doc.lockfile) || !isRec(doc.vulnerabilities)) return fail("the document has no database, lockfile and vulnerabilities sections");
  const vulns = doc.vulnerabilities;
  if (typeof vulns.found !== "boolean" || !Array.isArray(vulns.list)) return fail("vulnerabilities has no found flag and list");
  const lockfile = opts.root && opts.root !== "." ? `${opts.root}/Cargo.lock` : "Cargo.lock";
  const findings: ResultFinding[] = [];
  for (const [index, entry] of vulns.list.entries()) {
    const made = isRec(entry) ? entryFinding(entry, "vulnerability", { ...opts, lockfile }) : "an entry is not an object";
    if (typeof made === "string") return fail(`vulnerability ${index}: ${made}`);
    findings.push(made);
  }
  // `found` and the list must agree: a flag without entries (or the reverse) is a document the adapter does not understand.
  if (vulns.found !== (vulns.list.length > 0)) return fail("the found flag does not match the vulnerabilities list");
  let warnings = 0;
  if (isRec(doc.warnings)) {
    for (const [kind, list] of Object.entries(doc.warnings)) {
      if (!Array.isArray(list)) return fail(`warnings.${kind} is not a list`);
      for (const [index, entry] of list.entries()) {
        const made = isRec(entry) ? entryFinding(entry, kind, { ...opts, lockfile }) : "an entry is not an object";
        if (typeof made === "string") return fail(`warning ${kind}[${index}]: ${made}`);
        findings.push(made);
        warnings += 1;
      }
    }
  }
  const count = typeof doc.lockfile["dependency-count"] === "number" ? (doc.lockfile["dependency-count"] as number) : null;
  return { ok: true, findings, warnings, dependencyCount: count };
}
