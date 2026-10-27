// The MegaLinter linters of the quality gate (quality-gate/sidecar/config/megalinter-linters.json): where each one
// reads its configuration, whether it honors suppressions in the analyzed code and how jgates ci treats it. The same
// file closes MegaLinter's list in the sidecar (ENABLE_LINTERS of a hardened request) and tells the run which
// suppression comments a linter still honors and whether MegaLinter's stage is self-reported.
import fs from "node:fs";
import path from "node:path";
import { resolveSidecarDir } from "../bridge/index.js";
import type { CiTreatment } from "./trust.js";

export const LINTERS_FILE = "megalinter-linters.json";

export interface BridgeLinter {
  id: string;
  config: string;
  suppressions: string;
  /** Kind of suppression comment the linter still honors in jgates ci (suppressions.ts), when it honors one. */
  suppressionMarker?: string;
  executesProjectCode: boolean;
  ci: CiTreatment;
  ciArguments?: string;
  reason?: string;
}

export class LinterListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinterListError";
  }
}

const TREATMENTS: readonly CiTreatment[] = ["trusted", "self-reported", "excluded"];

/** Path of the list next to the sidecar package (null when the sidecar is not found). */
export function lintersFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const sidecar = resolveSidecarDir(env);
  return sidecar ? path.join(sidecar, "config", LINTERS_FILE) : null;
}

/** Reads and checks the list; throws LinterListError when it is missing or malformed (the governed run fails closed). */
export function readBridgeLinters(file: string | null): BridgeLinter[] {
  if (!file) throw new LinterListError(`${LINTERS_FILE}: the quality gate sidecar was not found`);
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new LinterListError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
  const linters = record.linters;
  if (record.schemaVersion !== 1 || !Array.isArray(linters) || linters.length === 0) throw new LinterListError(`${file}: a schemaVersion 1 document with a non-empty linters list is expected`);
  const seen = new Set<string>();
  return linters.map((raw, index) => {
    const l = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (typeof l.id !== "string" || !TREATMENTS.includes(l.ci as CiTreatment) || typeof l.config !== "string" || typeof l.suppressions !== "string") {
      throw new LinterListError(`${file}: linters[${index}] needs id, config, suppressions and ci (${TREATMENTS.join(", ")})`);
    }
    if (seen.has(l.id)) throw new LinterListError(`${file}: ${l.id} is listed twice`);
    seen.add(l.id);
    if (l.ci === "excluded" && typeof l.reason !== "string") throw new LinterListError(`${file}: ${l.id} is excluded without a reason`);
    return {
      id: l.id,
      config: l.config,
      suppressions: l.suppressions,
      ...(typeof l.suppressionMarker === "string" ? { suppressionMarker: l.suppressionMarker } : {}),
      executesProjectCode: l.executesProjectCode === true,
      ci: l.ci as CiTreatment,
      ...(typeof l.ciArguments === "string" ? { ciArguments: l.ciArguments } : {}),
      ...(typeof l.reason === "string" ? { reason: l.reason } : {}),
    };
  });
}

/** The linters MegaLinter may run in jgates ci (not excluded by the list). */
export const ciLinters = (linters: BridgeLinter[]): BridgeLinter[] => linters.filter((l) => l.ci !== "excluded");
