// Provenance of a run result. It keeps the fields the
// current evidence already uses (sourceCommit, producer, producerVersion, generatedAt, as in
// quality_sidecar/provenance.py) and adds the hashes of what the result depends on, the process that produced it and
// the plan it executed. The identity of the analysis is a content hash of the analyzed snapshot and of those hashes:
// a different configuration, policy, template set, tool set or input always gives a different identity, so an old
// result never approves a new state. This is self-declared metadata of a run of this machine, not an attestation.
import path from "node:path";
import { FRAGMENT_FILES, ROOT_FILE } from "../config/load/index.js";
import { contentHash } from "../ids/index.js";
import type { Plan } from "../plan/types.js";

export const PROVENANCE_SCHEMA_VERSION = 1;
const LOCK_FILE = ".jgates/lock.json";

/** Hashes of everything besides the code that decides what a run checks and how. */
export interface AnalysisHashes {
  /** The plan executed (its planHash). */
  plan: string;
  /** Resolved configuration plus the JGates configuration files (jgates.yml and its fragments, profiles). */
  config: string;
  /** The policy documents (.jgates/policy.yml and the policy fragments). */
  policy: string;
  /** The templates in effect (active and inactive) and their source files. */
  templates: string;
  /** Versions of JGates, the adapters and the tools, the commands of each invocation and the tool lockfile. */
  tools: string;
  /** Native configuration files of the tools (ruff.toml, rule files...). */
  nativeFiles: string;
  /** The discovery inventory. */
  inventory: string;
}

type FileHash = { file: string; sha256: string | null };
type Group = "config" | "policy" | "templates" | "tools" | "native";

const fragmentKind = (file: string): string | undefined => {
  const base = path.posix.basename(file);
  return Object.entries(FRAGMENT_FILES).find(([, name]) => name === base)?.[0];
};

/** Which part of the identity a configuration file of the plan belongs to. */
export function fileGroup(file: string, templateFiles: ReadonlySet<string>): Group {
  if (templateFiles.has(file) || file.startsWith("builtin:templates/")) return "templates";
  if (file.startsWith("builtin:")) return "config";
  if (file === LOCK_FILE) return "tools";
  const kind = fragmentKind(file);
  if (kind === "policy") return "policy";
  if (kind === "tools") return "tools";
  if (file === ROOT_FILE || kind !== undefined) return "config";
  return "native";
}

/** The hashes of a plan, grouped as the identity needs them. */
export function hashesOfPlan(plan: Plan): AnalysisHashes {
  const templateFiles = new Set<string>();
  for (const a of plan.templates.active) {
    templateFiles.add(a.source);
    for (const link of a.chain) templateFiles.add(link);
  }
  for (const a of plan.templates.inactive) templateFiles.add(a.source);
  const groups: Record<Group, FileHash[]> = { config: [], policy: [], templates: [], tools: [], native: [] };
  for (const f of plan.inputs.configFiles) groups[fileGroup(f.file, templateFiles)].push({ file: f.file, sha256: f.sha256 });
  const items = [...plan.groups.willRun, ...plan.groups.notApplicableOrDisabled];
  return {
    plan: plan.planHash,
    config: contentHash({ configHash: plan.inputs.configHash, files: groups.config, profile: plan.profile }),
    policy: contentHash({ files: groups.policy }),
    templates: contentHash({ active: plan.templates.active, inactive: plan.templates.inactive, files: groups.templates }),
    tools: contentHash({
      versions: plan.versions,
      invocations: plan.invocations.map((i) => ({ id: i.id, adapter: i.adapter, executable: i.command.executable, args: i.command.args, env: i.command.env })),
      items: items.map((i) => ({ id: i.id, versions: i.versions, runtime: i.runtime })),
      files: groups.tools,
    }),
    nativeFiles: contentHash({ files: groups.native }),
    inventory: plan.inputs.inventoryHash,
  };
}

/** Identity of the analyzed snapshot: what was read, at which commit, and whether the tree had local changes. */
export interface SnapshotIdentityInput {
  kind: "in-place" | "git-commit";
  commit: string | null;
  tree: string | null;
  dirty: boolean | null;
  inputsHash: string;
  /** false when the inputs could not all be hashed (too many files). */
  traceable: boolean;
}

export function snapshotIdentity(input: SnapshotIdentityInput): string {
  return contentHash({ v: PROVENANCE_SCHEMA_VERSION, ...input });
}

/** Identity of the analysis: the snapshot plus every hash the result depends on, and the scope that was asked. */
export function analysisIdentity(snapshotId: string, hashes: AnalysisHashes | null, scope: unknown = null): string {
  return contentHash({ v: PROVENANCE_SCHEMA_VERSION, snapshot: snapshotId, hashes, scope });
}

/** One prompt of the semantic review: where its text came from and the sha256 of the text in effect. */
export interface SemanticPromptPart {
  /** default: the file packaged with semantic-gate; project: a file of the workspace; policy: a file of the CI policy. */
  source: "default" | "project" | "policy";
  mode: "default" | "replace" | "append";
  /** The configured file, relative to the configuration folder; null for the packaged default. */
  file: string | null;
  sha256: string;
}

/**
 * The prompts the semantic review of the run used (only when the run asked for it and the prompts could be read).
 * Recorded so a result tells with which prompt it was made; it is not part of the identity, since the semantic
 * review never feeds the decision.
 */
export interface SemanticPromptsProvenance {
  /** sha256 of the effective prompts: the system prompt and the review rubric together. */
  sha256: string;
  system: SemanticPromptPart;
  review: SemanticPromptPart;
}

export interface Provenance {
  schemaVersion: 1;
  /** The commit analyzed (the snapshot's, or HEAD of the work tree); null without Git. */
  sourceCommit: string | null;
  producer: "jgates";
  producerVersion: string;
  generatedAt: string;
  /** runner: produced by this run on this machine; never an imported report. */
  evidence: "runner";
  process: { pid: number; platform: string; arch: string; node: string };
  plan: { hash: string; source: string; file: string } | null;
  identity: string;
  snapshot: string;
  hashes: AnalysisHashes | null;
  /** The prompts of the semantic review, when the run had one ($.semantic.prompts). */
  semanticPrompts?: SemanticPromptsProvenance;
}

export interface ProvenanceInput {
  version: string;
  generatedAt: Date;
  sourceCommit: string | null;
  plan: { hash: string; source: string; file: string } | null;
  identity: string;
  snapshot: string;
  hashes: AnalysisHashes | null;
}

export function buildProvenance(input: ProvenanceInput): Provenance {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    sourceCommit: input.sourceCommit,
    producer: "jgates",
    producerVersion: input.version,
    generatedAt: input.generatedAt.toISOString(),
    evidence: "runner",
    process: { pid: process.pid, platform: process.platform, arch: process.arch, node: process.version },
    plan: input.plan,
    identity: input.identity,
    snapshot: input.snapshot,
    hashes: input.hashes,
  };
}
