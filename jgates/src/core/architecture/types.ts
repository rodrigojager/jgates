// Normalized dependency graph: what the architecture adapters (dependency-cruiser, Import Linter, ...) produce and the
// evaluator consumes. Same shape on the wire to the sidecar bridge (operation "architecture").

export interface GraphNode {
  /** Identity of the node: a module name or a workspace-relative path, stable across runs. */
  id: string;
  /** module | file | package | namespace ... (free; the extractor knows). */
  kind: string;
  language?: string;
  /** Id of the workspace component the node belongs to. */
  component?: string;
  /** Workspace-relative path with forward slashes; absent for virtual or external modules. */
  path?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** Where the dependency was written: file:line or the extractor rule that produced it. */
  origin?: string;
}

/** A dependency the extractor saw but could not resolve to a node. It is a gap in coverage, never silence. */
export interface UnresolvedDependency {
  from: string;
  specifier: string;
  reason?: string;
}

export interface ExtractorCoverage {
  extractor?: string;
  version?: string;
  /** false: the extractor itself says it saw only part of the project. */
  complete?: boolean;
  reason?: string;
}

export interface NormalizedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: UnresolvedDependency[];
  coverage: ExtractorCoverage;
}

export type RuleKind = "forbidden-dependency" | "component-boundary" | "no-cycles" | "fan-limit";
export type RuleOwner = "source" | "generated";
export type RuleSeverity = "low" | "medium" | "high" | "critical";

export interface ArchitectureLayer {
  id: string;
  label?: string;
  component?: string;
  language?: string;
  paths?: string[];
  modules?: string[];
}

export interface ArchitectureRule {
  id: string;
  kind: RuleKind;
  enabled?: boolean;
  severity?: RuleSeverity;
  blocking?: boolean;
  owner?: RuleOwner;
  message?: string;
  from?: string;
  to?: string[];
  component?: string;
  allowedDependencies?: string[];
  within?: string;
  layer?: string;
  maxFanIn?: number;
  maxFanOut?: number;
}

/** The `architecture:` block of .jgates/architecture.yml. */
export interface ArchitectureContract {
  layers?: ArchitectureLayer[];
  rules?: ArchitectureRule[];
}

export type CoverageStatus = "complete" | "partial" | "empty";

export interface CoverageReason {
  code: string;
  message: string;
  [key: string]: unknown;
}

export interface GraphCoverage {
  status: CoverageStatus;
  extractor: string | null;
  nodes: number;
  edges: number;
  unresolved: number;
  unresolvedSample: UnresolvedDependency[];
  reasons: CoverageReason[];
}

export interface ArchitectureFinding {
  tool: "architecture";
  /** architecture.<kind> */
  rule: string;
  /** Id of the declared rule in architecture.yml. */
  ruleId: string;
  /** The file that declares the rule. */
  file: string;
  severity: RuleSeverity;
  blocking: boolean;
  category: "architecture-policy";
  path: string;
  message: string;
  metadata: Record<string, unknown>;
}

/** passed: verified and no blocking violation. failed: a blocking violation. incomplete: not proven (partial/empty graph or bridge failure) for a required check. */
export type ArchitectureState = "passed" | "failed" | "incomplete";

export interface ArchitectureEvaluation {
  state: ArchitectureState;
  /** true only when the graph coverage is complete: the absence of findings then means the absence of violations. */
  verified: boolean;
  required: boolean;
  coverage: GraphCoverage;
  rules: Array<{ id: string; kind: RuleKind; evaluated: boolean; findings: number }>;
  findings: ArchitectureFinding[];
  /** Why the state is not plain passed, in the catalog language. */
  reason?: string;
}
