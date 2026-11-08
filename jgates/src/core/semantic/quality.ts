// A Quality report attached to a Semantic run. It is evidence about a source, never an approval of the source the
// Semantic run judges unless both are the same traceable source: the binding (schemas/gates/evidence-binding) records
// the Quality run's own source identity and its freshness against the current one. Stale or unknown evidence is
// disclosed as such and never counts as a current approval.
import fs from "node:fs";
import path from "node:path";
import { loadGateRecord, readResultAsGateRun, writeGateRecord } from "../gates/read.js";
import { sourceMatch } from "../gates/source.js";
import type { EvidenceBinding, EvidenceFreshness, GateRunIdentity, SourceIdentity } from "../gates/types.js";
import type { ResultSemanticQualityEvidence, RunResult } from "../run/types.js";
import { translator } from "../../i18n/index.js";
import { RUN_IDENTITY_FILE } from "./store.js";

const t = translator("semantic");

/** Folder of the run that holds the evidence bindings of attached reports. */
export const EVIDENCE_DIR = "evidence";

export interface AttachedQuality {
  evidence: ResultSemanticQualityEvidence;
  /** Path of the binding record, relative to the Semantic run folder (null when the report could not be read). */
  bindingFile: string | null;
}

function readResult(dir: string): RunResult | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")) as RunResult;
  } catch {
    return null;
  }
}

/** The identity of a Quality run: its run.json when its producer wrote one, else derived from result.json (legacy). */
function identityOf(dir: string, result: RunResult): GateRunIdentity | null {
  try {
    if (fs.existsSync(path.join(dir, RUN_IDENTITY_FILE))) return loadGateRecord("run-identity", path.join(dir, RUN_IDENTITY_FILE));
    return readResultAsGateRun(result);
  } catch {
    return null;
  }
}

/**
 * Binds a Quality run (already resolved from the history) to the source the Semantic run judges and writes the binding
 * in <semanticRunDir>/evidence/quality-<runId>.json.
 */
export function attachQuality(quality: { runId: string; dir: string }, current: SourceIdentity, semanticRunDir: string, now: Date): AttachedQuality {
  const result = readResult(quality.dir);
  const identity = result ? identityOf(quality.dir, result) : null;
  if (!result || !identity) {
    return {
      evidence: {
        runId: quality.runId,
        decision: null,
        complete: false,
        reduced: false,
        freshness: "unknown",
        code: "QUALITY_RUN_UNREADABLE",
        reason: t("semantic_quality_unreadable", { runId: quality.runId }),
        currentApproval: false,
      },
      bindingFile: null,
    };
  }
  const match = sourceMatch(identity.source, current);
  const freshness: EvidenceFreshness = match.same ? "current" : match.code === "DIFFERENT_SOURCE" ? "stale" : "unknown";
  const reason = t(`semantic_quality_${match.code.toLowerCase()}`, { runId: quality.runId });
  const partial = result.partial === true;
  const currentApproval = freshness === "current" && !partial && result.decision === "passed" && result.complete === true && result.reduced !== true;
  const binding: EvidenceBinding = {
    schemaVersion: 1,
    origin: { gate: "quality", runId: quality.runId, producedAt: typeof result.finishedAt === "string" ? result.finishedAt : null, kind: "quality-report" },
    identities: {
      source: identity.source,
      config: identity.configHash,
      dependency: null,
      method: null,
      backend: null,
      policy: typeof result.policy?.sha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(result.policy.sha256) ? result.policy.sha256 : null,
    },
    freshness: { state: freshness, checkedAt: now.toISOString(), ...(freshness === "current" ? {} : { reason }) },
  };
  const bindingFile = path.posix.join(EVIDENCE_DIR, `quality-${quality.runId}.json`);
  let written: string | null = bindingFile;
  try {
    writeGateRecord("evidence-binding", path.join(semanticRunDir, EVIDENCE_DIR, `quality-${quality.runId}.json`), binding);
  } catch {
    written = null;
  }
  return {
    evidence: {
      runId: quality.runId,
      decision: typeof result.decision === "string" ? result.decision : null,
      complete: result.complete === true && !partial,
      reduced: result.reduced === true,
      freshness,
      code: match.code,
      reason,
      currentApproval,
    },
    bindingFile: written,
  };
}
