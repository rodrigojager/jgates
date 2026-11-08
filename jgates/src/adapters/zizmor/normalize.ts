// Normalizes the JSON of `zizmor --format json-v1` (fixtures of 1.32.0 in tests/fixtures/zizmor) into result findings.
// Fail-closed: anything but a list of findings with an ident, determinations and a location proves nothing. A finding
// zizmor marks as ignored (a `zizmor: ignore[...]` comment or a rule of zizmor.yml) is a scanner exception and is not
// reported; the count is returned so the stage can say so.
import { contentHash } from "../../core/ids/index.js";
import type { NormalizedSeverity, ResultFinding } from "../../core/run/types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export interface ZizmorParse {
  ok: boolean;
  findings: ResultFinding[];
  /** Findings zizmor itself marked as ignored by a comment or by its configuration. */
  ignored: number;
  /** Why the output could not be interpreted. */
  problem?: string;
}

const SEVERITY: Record<string, { normalized: NormalizedSeverity; blocking: boolean }> = {
  high: { normalized: "high", blocking: true },
  medium: { normalized: "medium", blocking: true },
  low: { normalized: "low", blocking: false },
  informational: { normalized: "info", blocking: false },
};

/** Workspace-relative path of the verbatim path zizmor prints (`.\\.github\\workflows\\ci.yml` on Windows). */
export function relativeWorkflowPath(raw: string, root: string): string {
  let value = raw.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (value.startsWith("/")) value = value.replace(/^\/+/, "");
  return root && root !== "." ? `${root}/${value}` : value;
}

export function parseZizmorOutput(stdout: string, opts: { stageId: string; version: string | null; root: string }): ZizmorParse {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch (error) {
    return { ok: false, findings: [], ignored: 0, problem: error instanceof Error ? error.message : String(error) };
  }
  if (!Array.isArray(doc)) return { ok: false, findings: [], ignored: 0, problem: "the document is not a list of findings" };
  const findings: ResultFinding[] = [];
  let ignored = 0;
  for (const [index, entry] of doc.entries()) {
    const ident = isRec(entry) ? str(entry.ident) : null;
    const determinations = isRec(entry) && isRec(entry.determinations) ? entry.determinations : null;
    const locations = isRec(entry) && Array.isArray(entry.locations) ? entry.locations.filter(isRec) : [];
    if (!isRec(entry) || !ident || !determinations || locations.length === 0) {
      return { ok: false, findings: [], ignored: 0, problem: `finding ${index} has no ident, determinations or locations` };
    }
    if (entry.ignored === true) {
      ignored += 1;
      continue;
    }
    // The primary location is where the problem is; the others only help to read it.
    const place = locations.find((l) => l.symbolic !== undefined && isRec(l.symbolic) && l.symbolic.kind === "Primary") ?? locations[0];
    const symbolic = place && isRec(place.symbolic) ? place.symbolic : null;
    const local = symbolic && isRec(symbolic.key) && isRec(symbolic.key.Local) ? symbolic.key.Local : null;
    const rawPath = local ? str(local.verbatim_path) : null;
    if (!rawPath) return { ok: false, findings: [], ignored: 0, problem: `finding ${index} (${ident}) has no local file in its primary location` };
    const concrete = place && isRec(place.concrete) ? place.concrete : null;
    const start = concrete && isRec(concrete.location) && isRec(concrete.location.start_point) ? concrete.location.start_point : null;
    const line = start && typeof start.row === "number" ? start.row + 1 : undefined;
    const column = start && typeof start.column === "number" ? start.column + 1 : undefined;
    const nativeSeverity = str(determinations.severity) ?? "";
    // An unknown severity blocks: nothing the tool says it cannot qualify may count as favorable.
    const level = SEVERITY[nativeSeverity.trim().toLowerCase()] ?? { normalized: "unknown" as NormalizedSeverity, blocking: true };
    const file = relativeWorkflowPath(rawPath, opts.root);
    const annotation = symbolic ? str(symbolic.annotation) : null;
    const description = str(entry.desc) ?? ident;
    const confidence = str(determinations.confidence);
    findings.push({
      stageId: opts.stageId,
      tool: "zizmor",
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: ident,
      category: "ci-cd",
      severity: nativeSeverity || "unknown",
      normalizedSeverity: level.normalized,
      message: `${description}${annotation ? ` (${annotation})` : ""}${confidence ? `, confidence ${confidence.toLowerCase()}` : ""}`,
      location: { path: file, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) },
      fingerprint: contentHash({ tool: "zizmor", rule: ident, file, line: line ?? null, annotation }),
      origin: "zizmor",
      blocking: level.blocking,
      ...(level.blocking ? { blockingReason: "blocking-tool" as const } : {}),
      waived: false,
      ...(str(entry.url) ? { docsUrl: entry.url as string } : {}),
    });
  }
  return { ok: true, findings, ignored };
}
