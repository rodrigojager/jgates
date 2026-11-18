// What the first-run wizard tells about the downloads (PLAN-guided-flows.md section 2, step 2): for each tool of the
// tools image its licence (as THIRD_PARTY_NOTICES.md lists it, section "Tools shipped in the tools image") and what it
// is for, and for each advisory database its name, source, approximate size and the tool that reads it. The versions
// come from the image's own image.json (catalogue.ts); this file only adds the words. tests/v2/v2-69 checks that every
// tool of release/image-tools.json is here with the licence of THIRD_PARTY_NOTICES.md.
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
}

/** Licence (SPDX expression, or the words of THIRD_PARTY_NOTICES.md) and purpose of each tool of the image. */
export const TOOL_ABOUT: Readonly<Record<string, ToolAbout>> = Object.freeze({
  cargo: { license: "MIT OR Apache-2.0", purpose: "package-manager" },
  "cargo-audit": { license: "Apache-2.0 OR MIT", purpose: "vulnerabilities" },
  "cargo-llvm-cov": { license: "Apache-2.0 OR MIT", purpose: "coverage" },
  checkov: { license: "Apache-2.0", purpose: "iac" },
  clippy: { license: "MIT OR Apache-2.0", purpose: "lint" },
  corepack: { license: "MIT", purpose: "package-manager" },
  coverage: { license: "Apache-2.0", purpose: "coverage" },
  curl: { license: "curl", purpose: "utility" },
  "dependency-cruiser": { license: "MIT", purpose: "architecture" },
  dotnet: { license: "MIT", purpose: "runtime" },
  "dotnet-ef": { license: "MIT", purpose: "migrations" },
  "dotnet-format": { license: "MIT", purpose: "format" },
  "dotnet-stryker": { license: "Apache-2.0", purpose: "mutation" },
  eslint: { license: "MIT", purpose: "lint" },
  "fast-check": { license: "MIT", purpose: "tests" },
  gcc: { license: "GPL-3.0-or-later with the GCC Runtime Library Exception", purpose: "build" },
  git: { license: "GPL-2.0-only", purpose: "utility" },
  gitleaks: { license: "MIT", purpose: "secrets" },
  go: { license: "BSD-3-Clause", purpose: "runtime" },
  "golangci-lint": { license: "GPL-3.0", purpose: "lint" },
  govulncheck: { license: "BSD-3-Clause", purpose: "vulnerabilities" },
  hadolint: { license: "GPL-3.0", purpose: "iac" },
  hypothesis: { license: "MPL-2.0", purpose: "tests" },
  "import-linter": { license: "BSD-2-Clause", purpose: "architecture" },
  java: { license: "GPL-2.0-only with the Classpath Exception", purpose: "runtime" },
  jgates: { license: "MIT", purpose: "jgates" },
  jq: { license: "MIT", purpose: "utility" },
  jscpd: { license: "MIT", purpose: "duplication" },
  make: { license: "GPL-3.0-or-later", purpose: "build" },
  mutmut: { license: "BSD-3-Clause", purpose: "mutation" },
  mypy: { license: "MIT", purpose: "types" },
  node: { license: "MIT", purpose: "runtime" },
  npm: { license: "Artistic-2.0", purpose: "package-manager" },
  oasdiff: { license: "Apache-2.0", purpose: "api" },
  "osv-scanner": { license: "Apache-2.0", purpose: "vulnerabilities" },
  "pkg-config": { license: "ISC", purpose: "build" },
  prettier: { license: "MIT", purpose: "format" },
  pyright: { license: "MIT", purpose: "types" },
  pytest: { license: "MIT", purpose: "tests" },
  "pytest-cov": { license: "MIT", purpose: "coverage" },
  python: { license: "PSF-2.0", purpose: "runtime" },
  "quality-sidecar": { license: "MIT", purpose: "jgates" },
  rsync: { license: "GPL-3.0-or-later", purpose: "utility" },
  ruff: { license: "MIT", purpose: "lint" },
  rustc: { license: "MIT OR Apache-2.0", purpose: "runtime" },
  rustfmt: { license: "MIT OR Apache-2.0", purpose: "format" },
  rustup: { license: "MIT OR Apache-2.0", purpose: "package-manager" },
  schemathesis: { license: "MIT", purpose: "api" },
  semgrep: { license: "LGPL-2.1-only", purpose: "sast" },
  shellcheck: { license: "GPL-3.0-or-later", purpose: "lint" },
  squawk: { license: "Apache-2.0", purpose: "migrations" },
  stryker: { license: "Apache-2.0", purpose: "mutation" },
  "stryker-jest-runner": { license: "Apache-2.0", purpose: "mutation" },
  "stryker-vitest-runner": { license: "Apache-2.0", purpose: "mutation" },
  tini: { license: "MIT", purpose: "utility" },
  tomlkit: { license: "MIT", purpose: "utility" },
  trivy: { license: "Apache-2.0", purpose: "vulnerabilities" },
  typescript: { license: "Apache-2.0", purpose: "types" },
  "typescript-eslint": { license: "MIT", purpose: "lint" },
  unzip: { license: "Info-ZIP", purpose: "utility" },
  uv: { license: "MIT OR Apache-2.0", purpose: "package-manager" },
  vitest: { license: "MIT", purpose: "tests" },
  "vitest-coverage-v8": { license: "MIT", purpose: "coverage" },
  xz: { license: "0BSD and GPL-2.0-or-later", purpose: "utility" },
  zap: { license: "Apache-2.0", purpose: "dast" },
  zizmor: { license: "MIT", purpose: "workflows" },
});

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
