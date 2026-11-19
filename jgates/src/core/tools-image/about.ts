// What the first-run wizard tells about the downloads (PLAN-guided-flows.md section 2, step 2): for each tool of the
// tools image its licence (as THIRD_PARTY_NOTICES.md lists it, section "Tools shipped in the tools image") and what it
// is for, and for each advisory database its name, source, approximate size and the tool that reads it. The versions
// come from the image's own image.json (catalogue.ts); this file only adds the words: about.json for the programs that
// are not linter descriptors, the descriptors' own identity for the others (PLAN-engine.md section 4). The notices table
// is generated from the same two sources (scripts/gen-image-docs.mjs). tests/v2/v2-69 checks that every tool of
// release/image-tools.json is here with the licence of THIRD_PARTY_NOTICES.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLinters, type LinterDescriptor } from "../../adapters/linter/descriptor.js";
import type { DatabaseId } from "../data/index.js";

export type ToolPurpose =
  | "runtime"
  | "package-manager"
  | "build"
  | "lint"
  | "format"
  | "types"
  | "tests"
  | "coverage"
  | "mutation"
  | "sast"
  | "iac"
  | "secrets"
  | "vulnerabilities"
  | "architecture"
  | "duplication"
  | "api"
  | "migrations"
  | "workflows"
  | "dast"
  | "jgates"
  | "utility";

export const TOOL_PURPOSES: readonly ToolPurpose[] = ["runtime", "package-manager", "build", "lint", "format", "types", "tests", "coverage", "mutation", "sast", "iac", "secrets", "vulnerabilities", "architecture", "duplication", "api", "migrations", "workflows", "dast", "jgates", "utility"];

export interface ToolAbout {
  license: string;
  purpose: ToolPurpose;
  /** Where its source is published. */
  source: string;
}

interface AboutFile {
  tools: Record<string, { license: string; purpose: ToolPurpose; source: string; note?: string; notice?: string }>;
}

let aboutFile: AboutFile | null = null;

function readAboutFile(): AboutFile {
  aboutFile ??= JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "about.json"), "utf8")) as AboutFile;
  return aboutFile;
}

/** What a linter descriptor's tool is for, from its place in the catalogue. */
export function descriptorPurpose(d: Pick<LinterDescriptor, "place">): ToolPurpose {
  const { kind, capability } = d.place;
  if (kind === "format") return "format";
  if (kind === "sbom") return "vulnerabilities";
  const byCapability: Record<string, ToolPurpose> = { secrets: "secrets", sast: "sast", iac: "iac", dependencies: "vulnerabilities", "ci-cd": "workflows", "api-contract": "api" };
  return byCapability[capability] ?? (kind === "scan" ? "sast" : "lint");
}

/**
 * Licence (SPDX expression, or the words of THIRD_PARTY_NOTICES.md), purpose and source of each tool of the image,
 * keyed by its image.json name: about.json, then one entry per descriptor program that about.json does not name.
 */
export function toolAboutTable(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, ToolAbout>> {
  const out: Record<string, ToolAbout> = {};
  for (const [name, entry] of Object.entries(readAboutFile().tools)) out[name] = { license: entry.license, purpose: entry.purpose, source: entry.source };
  for (const { descriptor } of loadLinters(env)) {
    const name = descriptor.program.tool;
    if (out[name] === undefined) out[name] = { license: descriptor.license, purpose: descriptorPurpose(descriptor), source: descriptor.sourceUrl };
  }
  return Object.freeze(out);
}

/** The words about one tool of the image, or undefined for a program JGates says nothing about. */
export function toolAbout(name: string, env: NodeJS.ProcessEnv = process.env): ToolAbout | undefined {
  return toolAboutTable(env)[name];
}

export interface DatabaseAbout {
  name: string;
  /** Where the data container downloads it from (core/data/script.ts). */
  source: string;
  /** Approximate size on disk once downloaded (the real one varies with each update). */
  approxBytes: number;
  /** The tool of the image that reads it. */
  usedBy: string;
}

export const DATABASE_ABOUT: Readonly<Record<DatabaseId, DatabaseAbout>> = Object.freeze({
  trivy: { name: "Trivy DB", source: "ghcr.io/aquasecurity/trivy-db", approxBytes: 900_000_000, usedBy: "Trivy" },
  osv: { name: "OSV.dev", source: "osv-vulnerabilities.storage.googleapis.com", approxBytes: 1_000_000_000, usedBy: "OSV-Scanner" },
  govulndb: { name: "Go vulnerability database", source: "vuln.go.dev", approxBytes: 40_000_000, usedBy: "govulncheck" },
  rustsec: { name: "RustSec advisory database", source: "github.com/rustsec/advisory-db", approxBytes: 20_000_000, usedBy: "cargo-audit" },
  grype: { name: "Grype vulnerability database", source: "grype.anchore.io", approxBytes: 200_000_000, usedBy: "Grype" },
  kubescape: { name: "Kubescape framework artifacts", source: "github.com/kubescape/regolibrary", approxBytes: 20_000_000, usedBy: "Kubescape" },
});
