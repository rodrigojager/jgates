// Adapters that plan and run one process per tool instance (every adapter except the composite bridge).
// The plan asks the adapter for the command, the versions, the configuration file and the availability; the run
// hands the plan back to the same adapter, which executes exactly that command.
import type { AdapterManifest } from "../catalog/index.js";
import type { AdapterContext, AdapterOutput } from "../run/types.js";
import type { Plan, PlanCommand, PlanItem } from "./types.js";
import { builtinPiiAdapter } from "../../adapters/builtin-pii/index.js";
import { ruffAdapter } from "../../adapters/ruff/index.js";
import { semgrepAdapter } from "../../adapters/semgrep/index.js";
import { genericCommandAdapter } from "../../adapters/generic-command/index.js";
import { dependencyCruiserAdapter } from "../../adapters/dependency-cruiser/index.js";
import { vitestAdapter } from "../../adapters/vitest/index.js";
import { pytestAdapter } from "../../adapters/pytest/index.js";
import { importLinterAdapter } from "../../adapters/import-linter/index.js";
import { gitleaksAdapter } from "../../adapters/gitleaks/index.js";
import { trivyAdapter } from "../../adapters/trivy/index.js";
import { osvScannerAdapter } from "../../adapters/osv-scanner/index.js";
import { checkovAdapter } from "../../adapters/checkov/index.js";
import { eslintAdapter } from "../../adapters/eslint/index.js";
import { jscpdAdapter } from "../../adapters/jscpd/index.js";

export interface ExternalPlanInput {
  /** Workspace directory (absolute). */
  dir: string;
  env: NodeJS.ProcessEnv;
  /** Tool instance id (the key under tools). */
  tool: string;
  capability: string;
  componentRoot: string | null;
  timeoutSeconds: number;
  /** The resolved configuration (adapters whose instances are declared in it, like the generic command, read theirs here). */
  config?: Record<string, unknown>;
  /**
   * The CI policy folder that replaces the configuration of the analyzed files (jgates ci and its preview). When set,
   * an adapter reads its bindings and its lock there (absolute paths), never a configuration file of `dir`, and turns
   * off the suppressions the tool lets it turn off.
   */
  policyDir?: string;
}

export interface ExternalPlan {
  label: string;
  command: Omit<PlanCommand, "invocation">;
  runtime: NonNullable<PlanItem["runtime"]>;
  toolVersion: string | null;
  /** Files that decide the behaviour of the tool (hashed into the plan). */
  configFiles: Array<{ file: string; sha256: string | null }>;
  availability: PlanItem["availability"];
  /** false: an unavailable tool is reported when the run starts (stage blocked, decision incomplete), not at planning. */
  blocksPlan: boolean;
  network: boolean;
  limitations: string[];
  conditions: string[];
  output: PlanItem["output"];
  /** Effects declared by the instance itself (generic command); the default is a read-only analysis with outputs in the run folder. */
  effects?: Partial<PlanItem["effects"]>;
  /**
   * Capabilities the instance claims without a verifiable contract, with the reason: the item runs and its result
   * counts, but it does not cover the capability (or its category) as a requirement.
   */
  uncredited?: Record<string, string>;
  /** What the run needs to judge the result besides the command (recorded in the plan, so it is hashed and reviewable). */
  contract?: Record<string, unknown>;
}

export interface ExternalAdapter {
  manifest: AdapterManifest;
  plan(input: ExternalPlanInput): ExternalPlan;
  /** Runs the plan's invocation of one tool instance. */
  run(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput>;
}

const REGISTRY = new Map<string, ExternalAdapter>([
  [ruffAdapter.manifest.id, ruffAdapter],
  [builtinPiiAdapter.manifest.id, builtinPiiAdapter],
  [semgrepAdapter.manifest.id, semgrepAdapter],
  [genericCommandAdapter.manifest.id, genericCommandAdapter],
  [dependencyCruiserAdapter.manifest.id, dependencyCruiserAdapter],
  [importLinterAdapter.manifest.id, importLinterAdapter],
  [vitestAdapter.manifest.id, vitestAdapter],
  [pytestAdapter.manifest.id, pytestAdapter],
  [gitleaksAdapter.manifest.id, gitleaksAdapter],
  [trivyAdapter.manifest.id, trivyAdapter],
  [osvScannerAdapter.manifest.id, osvScannerAdapter],
  [checkovAdapter.manifest.id, checkovAdapter],
  [eslintAdapter.manifest.id, eslintAdapter],
  [jscpdAdapter.manifest.id, jscpdAdapter],
]);

export function externalAdapter(id: string | null | undefined): ExternalAdapter | undefined {
  return id ? REGISTRY.get(id) : undefined;
}

export function externalAdapterIds(): string[] {
  return [...REGISTRY.keys()];
}
