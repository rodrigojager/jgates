// Gate selection (V2): which gates a run selects (quality, semantic or both) and where that choice came from. The
// choice lives in the effective configuration at selection.gates, so every layer can set it with the usual precedence
// and origin: a template (config.selection.gates), a profile (gates), jgates.yml (selection.gates) and the call (the
// CLI --gates flag or the API `gates` field, a run-only override that is never saved). Without any of them the
// selection is Quality only, so a project that never mentions gates keeps its legacy behaviour. The CLI and the server
// both call resolveGateSelection, so the same request is interpreted the same way.
import path from "node:path";
import { GATE_KINDS, type GateKind } from "../gates/types.js";
import { encodePointer, resolveConfig, type LayerName, type ResolveIssue } from "../config/resolve/index.js";
import { translator } from "../../i18n/index.js";

export const GATES_POINTER = encodePointer(["selection", "gates"]);
export const QUALITY_COVERAGE_POINTER = encodePointer(["selection", "sequence", "qualityCoverage"]);

/**
 * declared-scope: a fully completed scoped Quality run approves the scope it declared, when that scope covers the
 * Semantic subjects. repository: only a Quality run that covered the whole repository approves the sequence.
 */
export type QualityCoveragePolicy = "declared-scope" | "repository";
export const QUALITY_COVERAGE_POLICIES: readonly QualityCoveragePolicy[] = ["declared-scope", "repository"];
export const DEFAULT_QUALITY_COVERAGE: QualityCoveragePolicy = "declared-scope";

/** Where a selection value came from (the resolver's origin, plus whether it holds for this run only). */
export interface SelectionOrigin {
  layer: LayerName;
  /** "jgates" for the built-in default, "builtin:<id>"/"profile:<id>", a template identity, "jgates.yml", "--gates"... */
  source: string;
  file: string | null;
  path: string | null;
  /** true: a call override (CLI flag or API field) that applies to this run only and is never written anywhere. */
  runOnly: boolean;
}

export interface GateSelection {
  /** The gates selected, in execution order (Quality before Semantic). */
  gates: GateKind[];
  origin: SelectionOrigin;
  /** What the saved configuration selects without the run-only override (equal to the selection when there is none). */
  saved: { gates: GateKind[]; origin: SelectionOrigin };
  /** The sequence policy of a combined selection, with its origin. */
  policy: { qualityCoverage: QualityCoveragePolicy; origin: SelectionOrigin };
  /** The profile the configuration resolved (null when it could not be resolved). */
  profile: string | null;
  /** Problems of the configuration that kept the saved selection from being read (the defaults apply then). */
  problems: ResolveIssue[];
}

const DEFAULT_ORIGIN: SelectionOrigin = { layer: "defaults", source: "jgates", file: null, path: null, runOnly: false };

export type GateListProblem = { code: "GATES_EMPTY" | "GATES_UNKNOWN"; value: string };

/** Orders and deduplicates a list of gates (Quality first); null when it names no gate or an unknown one. */
export function normalizeGates(values: readonly unknown[]): GateKind[] | null {
  if (values.length === 0) return null;
  const set = new Set<GateKind>();
  for (const v of values) {
    if (typeof v !== "string" || !(GATE_KINDS as readonly string[]).includes(v)) return null;
    set.add(v as GateKind);
  }
  return GATE_KINDS.filter((g) => set.has(g));
}

/** Parses the --gates flag: comma-separated (repeatable) gate names, "both" meaning quality,semantic. */
export function parseGatesFlag(values: readonly string[]): { ok: true; gates: GateKind[] } | { ok: false; problem: GateListProblem } {
  const names = values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v !== "")
    .flatMap((v) => (v === "both" ? ["quality", "semantic"] : [v]));
  if (names.length === 0) return { ok: false, problem: { code: "GATES_EMPTY", value: values.join(",") } };
  const unknown = names.find((n) => !(GATE_KINDS as readonly string[]).includes(n));
  if (unknown !== undefined) return { ok: false, problem: { code: "GATES_UNKNOWN", value: unknown } };
  return { ok: true, gates: normalizeGates(names) as GateKind[] };
}

export interface GateSelectionRequest {
  /** The profile the call asks for (as --profile); otherwise selection.profile of the configuration. */
  profile?: string;
  /** The run-only gate choice (--gates or the API `gates` field). */
  gates?: GateKind[];
  /** A CI policy folder whose configuration replaces the project's. */
  configDir?: string;
}

function originOf(field: { layer: LayerName; source: string; file: string | null; path: string | null }): SelectionOrigin {
  return { layer: field.layer, source: field.source, file: field.file, path: field.path, runOnly: field.layer === "call" };
}

/**
 * The gates a run selects and where the choice came from. A run-only override wins over every saved layer and is
 * reported as such, next to what the saved configuration selects. Never throws: a configuration that cannot be read
 * leaves the defaults (Quality only) and says why in `problems`.
 */
export function resolveGateSelection(workspacePath: string, request: GateSelectionRequest = {}): GateSelection {
  const dir = path.resolve(workspacePath);
  let resolved: ReturnType<typeof resolveConfig> | null = null;
  try {
    // The same resolution as the plan (discovery included): a template that selects gates counts only when active.
    resolved = resolveConfig(dir, {
      ...(request.profile !== undefined ? { profile: request.profile } : {}),
      ...(request.configDir !== undefined ? { configDir: request.configDir } : {}),
    });
  } catch (error) {
    const t = translator("sequence");
    return fallback(request, [{ code: "CONFIG_UNREADABLE", message: t("sequence_config_unreadable", { detail: error instanceof Error ? error.message : String(error) }) }]);
  }
  if (!resolved.ok) return fallback(request, [...resolved.errors]);
  const gatesField = resolved.fields[GATES_POINTER];
  const savedGates = gatesField && Array.isArray(gatesField.value) ? normalizeGates(gatesField.value) : null;
  const saved = savedGates && gatesField ? { gates: savedGates, origin: originOf(gatesField) } : { gates: ["quality" as GateKind], origin: DEFAULT_ORIGIN };
  const policyField = resolved.fields[QUALITY_COVERAGE_POINTER];
  const policyValue = policyField && (QUALITY_COVERAGE_POLICIES as readonly unknown[]).includes(policyField.value) ? (policyField.value as QualityCoveragePolicy) : null;
  const policy = policyValue && policyField ? { qualityCoverage: policyValue, origin: originOf(policyField) } : { qualityCoverage: DEFAULT_QUALITY_COVERAGE, origin: DEFAULT_ORIGIN };
  const override = request.gates ? normalizeGates(request.gates) : null;
  return {
    gates: override ?? saved.gates,
    origin: override ? { layer: "call", source: "--gates", file: null, path: null, runOnly: true } : saved.origin,
    saved,
    policy,
    profile: resolved.profile?.id ?? null,
    problems: [],
  };
}

function fallback(request: GateSelectionRequest, problems: ResolveIssue[]): GateSelection {
  const override = request.gates ? normalizeGates(request.gates) : null;
  const saved = { gates: ["quality" as GateKind], origin: DEFAULT_ORIGIN };
  return {
    gates: override ?? saved.gates,
    origin: override ? { layer: "call", source: "--gates", file: null, path: null, runOnly: true } : DEFAULT_ORIGIN,
    saved,
    policy: { qualityCoverage: DEFAULT_QUALITY_COVERAGE, origin: DEFAULT_ORIGIN },
    profile: null,
    problems,
  };
}

export const isCombined = (gates: readonly GateKind[]): boolean => gates.includes("quality") && gates.includes("semantic");
