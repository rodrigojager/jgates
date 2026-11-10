// What the governed CI path (jgates ci) trusts. For every adapter that runs its own process and every subcheck of the
// quality gate: where the tool reads its configuration there, what it does with suppressions written in the analyzed
// code, and how the run treats its result:
//   - trusted: the tool runs with the policy's (or the packaged) configuration and its result counts;
//   - self-reported: the tool runs code of the analyzed project (tests, MSBuild, a command that runs the project) or
//     reads evidence the project produced; it can fail the run, but by default it never satisfies a requirement;
//   - excluded: the tool reads configuration or ignore files from the analyzed tree by itself and was not verified for
//     jgates ci: a policy that turns it on is refused (exit 3) with the reason, and nothing runs.
// The table is the only source of truth: the plan, the step wrapper and the documentation read it.
import { qualityBridgeManifest } from "../../adapters/quality-bridge/manifest.js";

export type CiTreatment = "trusted" | "self-reported" | "excluded";

export interface CiTrust {
  treatment: CiTreatment;
  /** Where the configuration comes from in jgates ci. */
  config: string;
  /** What happens to suppressions written in the analyzed code. */
  suppressions: string;
}

/** Adapters that run their own process (src/core/plan/adapters.ts), by manifest id. */
export const ADAPTER_TRUST: Readonly<Record<string, CiTrust>> = {
  ruff: {
    treatment: "trusted",
    config: "the policy's binding (tools.<id>.config), else Ruff's defaults with --isolated; pyproject.toml, ruff.toml and .ruff.toml of the project are never read",
    suppressions: "disabled: --ignore-noqa ignores # noqa and # ruff: noqa; --no-respect-gitignore",
  },
  eslint: {
    treatment: "trusted",
    config: "the policy's binding only (absolute --config); without one the policy is refused; ESLint itself is never the copy in the project's node_modules",
    suppressions: "disabled: --no-inline-config ignores eslint-disable and /* eslint */ comments",
  },
  semgrep: {
    treatment: "trusted",
    config: "the rules of the policy's binding and the rule set pinned in the policy's lock",
    suppressions: "disabled: --disable-nosem, --x-ignore-semgrepignore-files, --no-git-ignore",
  },
  "builtin-pii": {
    treatment: "trusted",
    config: "the resolved configuration of the policy (pii.yml of the policy)",
    suppressions: "none: the detector honors no comment of the analyzed code",
  },
  "generic-command": {
    treatment: "trusted",
    config: "the command the policy declares; self-reported when the instance declares that it executes project code",
    suppressions: "none known: the command is the policy's",
  },
  pytest: {
    treatment: "self-reported",
    config: "pytest reads conftest.py, pytest.ini and the project's plugins: the project decides the result",
    suppressions: "honored: skip and xfail markers, conftest hooks",
  },
  vitest: {
    treatment: "self-reported",
    config: "Vitest loads the project's configuration and setup files: the project decides the result",
    suppressions: "honored: .skip, .todo and the project's configuration",
  },
  "cargo-test": {
    treatment: "self-reported",
    config: "cargo test compiles and runs the project's tests, build scripts and procedural macros, and reads Cargo.toml and .cargo/config.toml: the project decides the result",
    suppressions: "honored: #[ignore], #[should_panic], cfg(test) gates and the project's proptest configuration (failure persistence is disabled by the run)",
  },
  "build-check": {
    treatment: "self-reported",
    config: "the project's own compiler or type checker configuration (tsconfig.json, mypy.ini, go.mod, Cargo.toml, the .NET project): the project decides the result",
    suppressions: "honored: @ts-ignore, # type: ignore and the compiler's own suppressions; build scripts and analyzers of the project run",
  },
  zizmor: {
    treatment: "trusted",
    config: "zizmor runs with --no-config: neither zizmor.yml nor .github/zizmor.yml of the project is read; the persona and minimum severity come from the policy",
    suppressions: "disabled: --no-ignores ignores the # zizmor: ignore comments of the workflows",
  },
  oasdiff: {
    treatment: "trusted",
    config: "the policy's instance (specification, base reference and fail-on level); oasdiff reads no configuration file of the project",
    suppressions: "none: the adapter passes no error-ignore file",
  },
  "format-check": {
    treatment: "self-reported",
    config: "the formatter reads the project's own style configuration (ruff.toml or [tool.ruff], .prettierrc, rustfmt.toml, .editorconfig): the project decides what counts as formatted",
    suppressions: "honored: the formatter's own ignore mechanisms (# fmt: off, // prettier-ignore, #[rustfmt::skip], .prettierignore, .gitignore)",
  },
  "golangci-lint": {
    treatment: "self-reported",
    config: "golangci-lint reads the project's .golangci.yml / .yaml / .toml / .json: the project decides which linters run and what is excluded",
    suppressions: "honored: //nolint comments and the exclusions of the project's configuration",
  },
  clippy: {
    treatment: "self-reported",
    config: "cargo clippy compiles the crate (build scripts and procedural macros run) and reads clippy.toml, the [lints] tables of Cargo.toml and the lint attributes: the project decides the levels",
    suppressions: "honored: #[allow] and #[expect] attributes and the lint levels of the project's configuration",
  },
  "dotnet-analyzers": {
    treatment: "self-reported",
    config: "dotnet build runs the project's MSBuild targets, source generators and analyzers and reads .editorconfig, .globalconfig and rulesets: the project decides the severities",
    suppressions: "honored: #pragma warning disable, [SuppressMessage] and the severities of the project's configuration files",
  },
  shellcheck: {
    treatment: "self-reported",
    config: "ShellCheck reads the project's .shellcheckrc and the # shellcheck directives of the scripts: the project decides which checks count",
    suppressions: "honored: # shellcheck disable= directives and the disable lines of .shellcheckrc",
  },
  hadolint: {
    treatment: "self-reported",
    config: "Hadolint reads the project's .hadolint.yaml: the project decides the ignored rules, severity overrides and trusted registries",
    suppressions: "honored: # hadolint ignore= comments and the ignored rules of the configuration",
  },
  "file-size": {
    treatment: "trusted",
    config: "the policy's instance (the maxLines limit); the analysis reads the files as data and no configuration file of the project",
    suppressions: "none: the analysis honors no comment or ignore file of the analyzed code",
  },
  "supply-chain": {
    treatment: "trusted",
    config: "the policy's instance; the analysis is an offline read of the lockfiles and manifests, with no configuration file of the project",
    suppressions: "none: the analysis honors no comment or ignore file of the analyzed code",
  },
  govulncheck: {
    treatment: "trusted",
    config: "the policy's instance; govulncheck reads no configuration file, only the module's go.mod and go.sum as data",
    suppressions: "none: govulncheck has no suppression mechanism",
  },
  codeql: {
    treatment: "self-reported",
    config: "CodeQL builds the database by running the project's build (autobuild or the instance's build command): the project's code executes",
    suppressions: "honored: whatever the build and the project's CodeQL packs decide; the query suite is the instance's",
  },
  mutation: {
    treatment: "self-reported",
    config: "the mutation engine (Stryker or mutmut) loads the project's configuration and re-runs the project's tests on an isolated copy: the project decides the result",
    suppressions: "honored: the engine's own mutator exclusions and the project's test configuration",
  },
  schemathesis: {
    treatment: "self-reported",
    config: "the run's own generated configuration file; the verdict depends on the running service the instance targets, which the project provides",
    suppressions: "none known: a project schemathesis.toml is never read",
  },
  zap: {
    treatment: "self-reported",
    config: "the instance's mode and target; the verdict depends on the running service the instance targets, which the project provides",
    suppressions: "none known: the run passes no rules file of the project",
  },
  "cargo-audit": {
    treatment: "excluded",
    config: "cargo-audit reads .cargo/audit.toml of the analyzed folder by itself, and the adapter passes no configuration of the policy",
    suppressions: "honored: the advisories ignored in .cargo/audit.toml",
  },
  gitleaks: {
    treatment: "excluded",
    config: "Gitleaks reads .gitleaks.toml and .gitleaksignore from the scanned folder by itself",
    suppressions: "honored: gitleaks:allow comments",
  },
  trivy: {
    treatment: "excluded",
    config: "Trivy reads trivy.yaml and .trivyignore from its working folder by itself",
    suppressions: "honored: trivy:ignore comments",
  },
  "osv-scanner": {
    treatment: "excluded",
    config: "OSV-Scanner reads osv-scanner.toml next to each lockfile by itself",
    suppressions: "honored: the ignored vulnerabilities of osv-scanner.toml",
  },
  checkov: {
    treatment: "excluded",
    config: "Checkov reads .checkov.yaml from its working folder by itself",
    suppressions: "honored: checkov:skip comments",
  },
  jscpd: {
    treatment: "excluded",
    config: "jscpd reads .jscpd.json and the jscpd key of package.json from the analyzed folder",
    suppressions: "honored: jscpd:ignore-start and jscpd:ignore-end comments",
  },
  "dependency-cruiser": {
    treatment: "excluded",
    config: "the project's .dependency-cruiser.js (code) when the binding is native",
    suppressions: "none",
  },
  "import-linter": {
    treatment: "excluded",
    config: "the contracts of the project's .importlinter, setup.cfg or pyproject.toml",
    suppressions: "honored: ignore_imports of the project's contracts",
  },
};

/** Subchecks of the quality gate (the bridge), by subcheck id. */
export const SUBCHECK_TRUST: Readonly<Record<string, CiTrust>> = {
  "file-size": { treatment: "trusted", config: "the policy's quality policy (budgets)", suppressions: "none" },
  megalinter: {
    treatment: "trusted",
    config: "the closed list of quality-gate/sidecar/config/megalinter-linters.json; self-reported when a linter of the list that runs MSBuild has project files to load",
    suppressions: "per linter, in megalinter-linters.json; honored ones are reported as blocking findings of the policy",
  },
  semgrep: { treatment: "trusted", config: "the registry rule set p/default", suppressions: "disabled: --disable-nosem, .semgrepignore ignored" },
  gitleaks: { treatment: "trusted", config: "the packaged gitleaks-ci.toml and an empty ignore file", suppressions: "disabled: --ignore-gitleaks-allow" },
  trivy: { treatment: "trusted", config: "the packaged trivy-ci.yaml and an empty ignore file", suppressions: "reported: --show-suppressed, each suppression is a finding" },
  checkov: { treatment: "trusted", config: "the packaged checkov-ci.yml", suppressions: "reported: each skipped check is a finding" },
  "osv-scanner": { treatment: "trusted", config: "the packaged osv-scanner-ci.toml (no per-lockfile osv-scanner.toml)", suppressions: "none" },
  jscpd: { treatment: "trusted", config: "the packaged jscpd-ci.json", suppressions: "honored: jscpd:ignore comments, reported as blocking findings of the policy" },
  "project-tests": { treatment: "self-reported", config: "the project's own test command", suppressions: "honored: whatever the project's tests decide" },
  coverage: {
    treatment: "self-reported",
    config: "coverage reports produced during the run; a report present in the analyzed commit is refused",
    suppressions: "honored: the project's coverage configuration",
  },
};

/** Treatment of an external adapter's item in jgates ci; an adapter missing from the table is excluded (fail-closed). */
export function adapterTreatment(adapter: string | null, executesProjectCode: boolean): CiTreatment {
  const known = adapter ? ADAPTER_TRUST[adapter] : undefined;
  if (!known) return "excluded";
  if (known.treatment === "trusted" && executesProjectCode) return "self-reported";
  return known.treatment;
}

/** Treatment of a subcheck of the quality gate; a subcheck missing from the table is excluded (fail-closed). */
export function subcheckTreatment(subcheck: string | null): CiTreatment {
  return (subcheck ? SUBCHECK_TRUST[subcheck]?.treatment : undefined) ?? "excluded";
}

/** Subchecks the bridge manifest declares that the table does not know (a test keeps this empty). */
export function untrustedSubchecks(): string[] {
  return (qualityBridgeManifest.subchecks ?? []).map((s) => s.id).filter((id) => SUBCHECK_TRUST[id] === undefined);
}
