// Governed CI run (`jgates ci`). The rules come only from a CI policy: a complete JGates configuration kept in a folder
// outside the analyzed checkout and pinned by the hash of its bundle (JGATES_POLICY_SHA256). The run never loosens:
//   - the bundle hash is checked before anything else, and a policy inside the checkout is refused;
//   - the project's own jgates.yml, .jgates/ (profiles, tools, waivers) and quality policy file are never read;
//   - the analysis reads a clean copy of the commit (HEAD or --head) in the data folder, never the work tree;
//   - the bridge runs in its complete mode with the policy's quality policy (or the built-in default);
//   - a reduced run never passes, and an incomplete one never exits 0.
// Every policy problem is a configuration failure for the caller (exit 3), with a stable code and no text: the CLI
// translates by code.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { checkPolicyLocation, loadPolicyConfig, normalizePolicyHash, readPolicyBundle, type PolicyBundle, type PolicyErrorCode } from "../policy/index.js";
import { CONFIG_DIR } from "../config/load/index.js";
import { buildPlan, RUN_DIR_TOKEN, type BuildPlanResult, type Plan, type PlanScopeKind } from "../plan/index.js";
import { loadWaiverFile, WAIVERS_FILE, type Waiver } from "../results/index.js";
import { resolveSidecarDir } from "../bridge/index.js";
import { encodePointer, resolveConfig } from "../config/resolve/index.js";
import { budgetProblem } from "../governed/budgets.js";
import type { TreeProblemCode } from "../governed/tree.js";
import type { ResultPolicy } from "./types.js";

/** The quality policy of the bridge inside a CI policy folder (part of the bundle, like every file of .jgates/). */
export const POLICY_QUALITY_FILE = `${CONFIG_DIR}/quality-policy.json`;
/** Name of the copy handed to the bridge, in the run folder. */
export const RUN_QUALITY_POLICY = "quality-policy.json";
/** Quality policy used when the CI policy has none: the sidecar's defaults, never the project's own file. */
export const DEFAULT_QUALITY_POLICY = '{\n  "schemaVersion": 1\n}\n';

/** Scopes a governed run accepts: the whole commit, or what changed since --base. */
export const GOVERNED_SCOPES: readonly PlanScopeKind[] = ["full", "changed"];

export type GovernedErrorCode =
  | PolicyErrorCode
  /** Neither --policy nor JGATES_POLICY_DIR names the policy folder. */
  | "POLICY_DIR_REQUIRED"
  /** JGATES_POLICY_SHA256 is not set. */
  | "POLICY_SHA256_REQUIRED"
  /** JGATES_POLICY_SHA256 is not a sha256 (64 hex characters, "sha256:" prefix allowed). */
  | "POLICY_SHA256_INVALID"
  /** The bundle hash differs from JGATES_POLICY_SHA256. */
  | "POLICY_HASH_MISMATCH"
  /** .jgates/quality-policy.json of the policy is not a valid quality policy. */
  | "POLICY_QUALITY_INVALID"
  /** .jgates/waivers.json of the policy cannot be read. */
  | "POLICY_WAIVERS_INVALID"
  /** --profile names a profile the policy does not define. */
  | "POLICY_PROFILE_REFUSED"
  /** The quality policy turns the mandatory budgets off or loosens one past the standard ceiling. */
  | "POLICY_BUDGETS_WEAKENED"
  /** The policy's selection turns the file size check (the budgets) off. */
  | "POLICY_BUDGETS_DISABLED"
  /** The analyzed commit has a submodule, or a symbolic link that leaves the checkout (core/governed/tree.ts). */
  | TreeProblemCode;

export interface GovernedError {
  code: GovernedErrorCode;
  /** English detail for logs; the CLI shows its own translated text by `code`. */
  detail: string;
  path: string | null;
  /** POLICY_HASH_MISMATCH: the expected (normalized) and the actual bundle hash. */
  expected?: string;
  actual?: string;
}

export interface GovernedPolicy {
  bundle: PolicyBundle;
  from: "option" | "env";
  quality: { file: string | null; text: string; sha256: string };
  /** The approved waivers of the policy (.jgates/waivers.json of the policy folder). */
  waivers: Waiver[];
  /** Profiles the policy itself defines: the only ids --profile may name. */
  profiles: string[];
  /** execution.trustSelfReported of the policy (default false): whether a self-reported stage may satisfy a requirement. */
  trustSelfReported: boolean;
}

export interface GovernedPolicyRequest {
  /** --policy, else JGATES_POLICY_DIR (undefined: neither). */
  policyDir: string | undefined;
  from: "option" | "env";
  /** JGATES_POLICY_SHA256 as given. */
  expectedSha256: string | undefined;
  /** The analyzed checkout. */
  projectDir: string;
  env?: NodeJS.ProcessEnv;
}

const sha256Hex = (text: string): string => crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const fail = (code: GovernedErrorCode, detail: string, where: string | null = null, extra: Partial<GovernedError> = {}) =>
  ({ ok: false as const, error: { code, detail, path: where, ...extra } });

type Validator = ((doc: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };

/** Validator of quality-gate/schemas/quality-policy.schema.json, next to the sidecar; null when it is not there. */
function qualityPolicyValidator(env: NodeJS.ProcessEnv): Validator | null {
  const sidecar = resolveSidecarDir(env);
  const file = sidecar ? path.join(path.dirname(sidecar), "schemas", "quality-policy.schema.json") : null;
  if (!file || !fs.existsSync(file)) return null;
  const require = createRequire(import.meta.url);
  const mod = require("ajv/dist/2020") as { default: new (opts: object) => { compile(schema: unknown): Validator } };
  return new mod.default({ strict: false, allErrors: true }).compile(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** The quality policy of the bundle (or the default), checked now so a broken one stops the run before it starts. */
function qualityPolicyOf(bundle: PolicyBundle, env: NodeJS.ProcessEnv): { ok: true; quality: GovernedPolicy["quality"] } | ReturnType<typeof fail> {
  if (!bundle.files.some((f) => f.path === POLICY_QUALITY_FILE)) {
    return { ok: true, quality: { file: null, text: DEFAULT_QUALITY_POLICY, sha256: sha256Hex(DEFAULT_QUALITY_POLICY) } };
  }
  let text: string;
  let doc: unknown;
  try {
    text = fs.readFileSync(path.join(bundle.dir, ...POLICY_QUALITY_FILE.split("/")), "utf8");
    doc = JSON.parse(text);
  } catch (error) {
    return fail("POLICY_QUALITY_INVALID", `${POLICY_QUALITY_FILE}: ${error instanceof Error ? error.message : String(error)}`, POLICY_QUALITY_FILE);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc) || (doc as Record<string, unknown>).schemaVersion !== 1) {
    return fail("POLICY_QUALITY_INVALID", `${POLICY_QUALITY_FILE}: an object with schemaVersion 1 is expected`, POLICY_QUALITY_FILE);
  }
  const validate = qualityPolicyValidator(env);
  if (validate && !validate(doc)) {
    const problems = (validate.errors ?? []).slice(0, 3).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
    return fail("POLICY_QUALITY_INVALID", `${POLICY_QUALITY_FILE}: ${problems.join("; ")}`, POLICY_QUALITY_FILE);
  }
  // The budgets are mandatory in jgates ci: tighter is fine, off or looser than the standard ceiling is refused.
  const weakened = budgetProblem(doc as Record<string, unknown>);
  if (weakened) return fail("POLICY_BUDGETS_WEAKENED", `${POLICY_QUALITY_FILE}${weakened.pointer}: ${weakened.detail}`, `${POLICY_QUALITY_FILE}#${weakened.pointer}`);
  return { ok: true, quality: { file: POLICY_QUALITY_FILE, text, sha256: sha256Hex(text) } };
}

/** `execution.trustSelfReported` of the policy's configuration (never the project's); false when absent or unreadable. */
function policyTrustsSelfReported(policyDir: string, projectDir: string): boolean {
  try {
    return resolveConfig(projectDir, { configDir: policyDir }).fields[encodePointer(["execution", "trustSelfReported"])]?.value === true;
  } catch {
    return false;
  }
}

/** Ids of the profiles the policy's own configuration documents define. */
function policyProfiles(policyDir: string, projectDir: string): string[] {
  const ids = new Set<string>();
  for (const doc of loadPolicyConfig(policyDir, projectDir).documents) {
    if (doc.kind !== "profiles" || doc.value === null || typeof doc.value !== "object") continue;
    const profiles = (doc.value as Record<string, unknown>).profiles;
    if (profiles !== null && typeof profiles === "object" && !Array.isArray(profiles)) for (const id of Object.keys(profiles)) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Checks the CI policy before anything else: the folder is named, JGATES_POLICY_SHA256 is set and well formed, the
 * folder exists outside the analyzed checkout, its bundle can be read and its hash is the expected one; then its quality
 * policy and its waivers are read. Reads only; never throws for a policy problem.
 */
export function prepareGovernedPolicy(request: GovernedPolicyRequest): { ok: true; policy: GovernedPolicy } | { ok: false; error: GovernedError } {
  const env = request.env ?? process.env;
  if (request.policyDir === undefined || request.policyDir.trim() === "") return fail("POLICY_DIR_REQUIRED", "no policy folder (--policy or JGATES_POLICY_DIR)");
  const policyDir = path.resolve(request.policyDir);
  if (request.expectedSha256 === undefined || request.expectedSha256.trim() === "") return fail("POLICY_SHA256_REQUIRED", "JGATES_POLICY_SHA256 is not set");
  const expected = normalizePolicyHash(request.expectedSha256);
  if (expected === null) return fail("POLICY_SHA256_INVALID", "JGATES_POLICY_SHA256 is not a sha256 hash");

  const location = checkPolicyLocation(policyDir, request.projectDir);
  if (location) return fail(location.code, location.message, location.path);
  const read = readPolicyBundle(policyDir);
  if (!read.ok) return fail(read.error.code, read.error.message, read.error.path);
  const bundle = read.bundle;
  if (bundle.sha256 !== expected) {
    return fail("POLICY_HASH_MISMATCH", `policy bundle hash ${bundle.sha256} differs from JGATES_POLICY_SHA256 ${expected}`, policyDir, { expected, actual: bundle.sha256 });
  }

  const quality = qualityPolicyOf(bundle, env);
  if (!quality.ok) return quality;
  const waiverFile = loadWaiverFile(path.join(bundle.dir, ...WAIVERS_FILE.split("/")));
  if (waiverFile.problem) return fail("POLICY_WAIVERS_INVALID", `${WAIVERS_FILE}: ${waiverFile.problem}`, WAIVERS_FILE);
  return {
    ok: true,
    policy: {
      bundle,
      from: request.from,
      quality: quality.quality,
      waivers: waiverFile.waivers,
      profiles: policyProfiles(bundle.dir, request.projectDir),
      trustSelfReported: policyTrustsSelfReported(bundle.dir, request.projectDir),
    },
  };
}

/** --profile is allowed only when the policy itself defines that profile (a built-in one is never chosen by the call). */
export function checkGovernedProfile(policy: GovernedPolicy, profile: string | undefined): GovernedError | null {
  if (profile === undefined || policy.profiles.includes(profile)) return null;
  return { code: "POLICY_PROFILE_REFUSED", detail: `profile ${profile} is not defined by the policy`, path: null };
}

/** The `policy` block of result.json. */
export function policyRecord(policy: GovernedPolicy): ResultPolicy {
  return {
    sha256: policy.bundle.sha256,
    files: policy.bundle.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
    source: { dir: policy.bundle.dir, from: policy.from },
    qualityPolicy: { file: policy.quality.file, sha256: policy.quality.sha256 },
    trustSelfReported: policy.trustSelfReported,
  };
}

export interface GovernedPlanRequest {
  /** Commit to analyze (default HEAD); always read from a snapshot, never from the work tree. */
  head?: string;
  scope?: PlanScopeKind;
  base?: string;
  profile?: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * The plan of a governed run: built only from the policy, for a snapshot of the commit, with the bridge in its complete
 * mode and the policy's quality policy (the copy written in the run folder, named by its hash).
 */
export function buildGovernedPlan(projectDir: string, policy: GovernedPolicy, request: GovernedPlanRequest): BuildPlanResult {
  return buildPlan(projectDir, {
    configDir: policy.bundle.dir,
    head: request.head ?? "HEAD",
    scope: request.scope ?? "full",
    ...(request.base !== undefined ? { base: request.base } : {}),
    ...(request.profile !== undefined ? { profile: request.profile } : {}),
    version: request.version,
    compare: false,
    bridgePolicy: { file: `${RUN_DIR_TOKEN}/${RUN_QUALITY_POLICY}`, sha256: policy.quality.sha256 },
    ...(request.env ? { env: request.env } : {}),
    ...(request.home ? { home: request.home } : {}),
  });
}

/** Files written in the run folder before the steps start: the plan and the quality policy the bridge reads. */
export function governedRunFiles(plan: Plan, policy: GovernedPolicy): Record<string, string> {
  return { "plan.json": `${JSON.stringify(plan, null, 2)}\n`, [RUN_QUALITY_POLICY]: policy.quality.text };
}
