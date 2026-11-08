// Distribution metadata and the distribution check. The adapter side checks that every registered adapter says how
// its external tool reaches the customer (shipped / prepared from an authorized source / customer supplied) with what
// that mode needs; the pack side checks that every shippable pack has provenance, an eligible license and its
// notices, and carries no restricted material such as the official semgrep-rules. See PLAN-distribution.md.
import type { AdapterManifest, DistributionMode } from "../catalog/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { isRestrictedSource, spdxEligible } from "./license.js";
import { checkPack, checkPackRoot, type PackReport } from "./pack.js";
import { problem, type DistributionProblem } from "./problems.js";

export * from "./license.js";
export * from "./pack.js";
export * from "./problems.js";

export interface AdapterDistributionReport {
  id: string;
  mode: DistributionMode | null;
  ok: boolean;
  problems: DistributionProblem[];
}

export interface DistributionReport {
  schemaVersion: 1;
  ok: boolean;
  adapters: AdapterDistributionReport[];
  packs: PackReport[];
  problems: DistributionProblem[];
}

const filled = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";

/** Problems of the distribution metadata of one adapter manifest. */
export function checkAdapterDistribution(manifest: AdapterManifest): AdapterDistributionReport {
  const d = manifest.distribution;
  const id = manifest.id;
  if (!d) return { id, mode: null, ok: false, problems: [problem("DISTRIBUTION_MISSING", id)] };
  const problems: DistributionProblem[] = [];
  const links = [...(d.acquisition ?? []), ...(d.setup ?? [])];
  if (d.mode === "shipped") {
    // JGates' own code ships under the JGates license; third-party material also names its source and revision.
    if (!filled(d.spdx)) problems.push(problem("PROVENANCE_INCOMPLETE", id, { detail: "spdx" }));
    else if (!spdxEligible(d.spdx)) problems.push(problem("LICENSE_NOT_ELIGIBLE", id, { detail: d.spdx }));
    if ((d.notices ?? []).filter(filled).length === 0) problems.push(problem("NOTICE_MISSING", id, { detail: "notices" }));
    if (filled(d.sourceUrl) && !filled(d.revision)) problems.push(problem("PROVENANCE_INCOMPLETE", id, { detail: "revision" }));
    if (filled(d.sourceUrl) && isRestrictedSource(d.sourceUrl)) problems.push(problem("RESTRICTED_SOURCE", id, { detail: d.sourceUrl }));
  } else {
    if (!filled(d.sourceUrl)) problems.push(problem("PROVENANCE_INCOMPLETE", id, { detail: "sourceUrl" }));
    if (links.length === 0) problems.push(problem("ACQUISITION_MISSING", id));
  }
  if (d.mode === "customer-supplied" && (!filled(manifest.toolVersionRange) || manifest.toolVersionRange.trim() === "*")) {
    problems.push(problem("VERSIONS_MISSING", id, { detail: manifest.toolVersionRange || "-" }));
  }
  return { id, mode: d.mode, ok: problems.length === 0, problems };
}

export interface DistributionCheckOptions {
  manifests?: AdapterManifest[];
  /** Pack folders to check one by one. */
  packs?: string[];
  /** Shipping roots: every subfolder is a pack, every loose file is content without provenance. */
  roots?: string[];
}

/** The whole distribution check: the adapters' metadata and the packs given. Deterministic for the same files. */
export function checkDistribution(options: DistributionCheckOptions = {}): DistributionReport {
  const adapters = (options.manifests ?? builtinManifests()).map(checkAdapterDistribution);
  const packs = [...(options.packs ?? []).map(checkPack), ...(options.roots ?? []).flatMap(checkPackRoot)];
  const problems = [...adapters.flatMap((a) => a.problems), ...packs.flatMap((p) => p.problems)];
  return { schemaVersion: 1, ok: problems.length === 0, adapters, packs, problems };
}
