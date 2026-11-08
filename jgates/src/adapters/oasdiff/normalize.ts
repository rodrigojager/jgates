// Normalizes the JSON of `oasdiff breaking --format json` (fixtures of 1.36.0 in tests/fixtures/oasdiff/recorded) into
// result findings. Fail-closed: anything but a list of changes with an id, a text and a level proves nothing (an empty
// list is the compatible answer). The level of oasdiff is 1 (info), 2 (warn) or 3 (err); which levels block is the
// failOn setting of the instance.
import { contentHash } from "../../core/ids/index.js";
import type { NormalizedSeverity, ResultFinding } from "../../core/run/types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export const FAIL_ON_LEVELS = ["ERR", "WARN"] as const;
export type FailOn = (typeof FAIL_ON_LEVELS)[number];

export interface OasdiffParse {
  ok: boolean;
  findings: ResultFinding[];
  /** Why the output could not be interpreted. */
  problem?: string;
}

const LEVELS: Record<string, { native: string; normalized: NormalizedSeverity; rank: number }> = {
  "1": { native: "info", normalized: "info", rank: 1 },
  "2": { native: "warn", normalized: "medium", rank: 2 },
  "3": { native: "err", normalized: "high", rank: 3 },
  info: { native: "info", normalized: "info", rank: 1 },
  warn: { native: "warn", normalized: "medium", rank: 2 },
  warning: { native: "warn", normalized: "medium", rank: 2 },
  err: { native: "err", normalized: "high", rank: 3 },
  error: { native: "err", normalized: "high", rank: 3 },
};

export function parseOasdiffOutput(stdout: string, opts: { stageId: string; version: string | null; specPath: string; failOn: FailOn }): OasdiffParse {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch (error) {
    return { ok: false, findings: [], problem: error instanceof Error ? error.message : String(error) };
  }
  // Older and newer oasdiff print `null` for "no changes".
  if (doc === null) return { ok: true, findings: [] };
  if (!Array.isArray(doc)) return { ok: false, findings: [], problem: "the document is not a list of changes" };
  const threshold = opts.failOn === "WARN" ? 2 : 3;
  const findings: ResultFinding[] = [];
  for (const [index, entry] of doc.entries()) {
    const id = isRec(entry) ? str(entry.id) : null;
    const text = isRec(entry) ? str(entry.text) : null;
    const rawLevel = isRec(entry) ? entry.level : undefined;
    if (!isRec(entry) || !id || !text || (typeof rawLevel !== "number" && typeof rawLevel !== "string")) {
      return { ok: false, findings: [], problem: `change ${index} has no id, text or level` };
    }
    // An unknown level blocks: nothing the tool says it cannot qualify may count as favorable.
    const level = LEVELS[String(rawLevel).trim().toLowerCase()];
    const normalized: NormalizedSeverity = level?.normalized ?? "unknown";
    const blocking = level ? level.rank >= threshold : true;
    const operation = str(entry.operation);
    const apiPath = str(entry.path);
    const source = isRec(entry.source) ? entry.source : null;
    const line = source && typeof source.line === "number" ? source.line : undefined;
    const column = source && typeof source.column === "number" ? source.column : undefined;
    findings.push({
      stageId: opts.stageId,
      tool: "oasdiff",
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: id,
      category: "api-compatibility",
      severity: level?.native ?? String(rawLevel),
      normalizedSeverity: normalized,
      message: `${text}${operation && apiPath ? ` (${operation} ${apiPath})` : ""}`,
      location: { path: opts.specPath, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) },
      fingerprint: contentHash({ tool: "oasdiff", rule: id, spec: opts.specPath, operation, path: apiPath, text }),
      origin: "oasdiff",
      blocking,
      ...(blocking ? { blockingReason: "blocking-tool" as const } : {}),
      waived: false,
    });
  }
  return { ok: true, findings };
}
