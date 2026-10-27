// Gitleaks adapter: one `gitleaks dir` (capability secrets) or `gitleaks git` (capability secrets-history) per tool
// instance, in the container runner, with the project's .gitleaks.toml and ignore file as two separate documents.
// The redaction (--redact=100), the report in the run folder and the exit code of a leak (3, so that 1 stays an
// error) are part of the command: no configuration file or editor change can turn them off.
import { CONTAINER_OUTPUT, toContainerPath } from "../../core/runner/index.js";
import type { ExternalAdapter } from "../../core/plan/adapters.js";
import { planScanner, REPORT_FILE, runScanner, type ArgsInput, type ScannerDefinition } from "../container-scanner/index.js";
import { gitleaksManifest } from "./manifest.js";
import { parseGitleaksReport } from "./normalize.js";

export { gitleaksManifest } from "./manifest.js";
export { maskMatch, parseGitleaksReport, REDACTED } from "./normalize.js";

/** The flags no document can change. */
export const GITLEAKS_FIXED_FLAGS = ["--redact=100", "--no-banner", "--no-color", "--log-level", "warn", "--exit-code", "3", "--report-format", "json"];

const modeOf = (input: ArgsInput): "dir" | "git" => (input.capabilities[0] === "secrets-history" ? "git" : "dir");

export const gitleaksScanner: ScannerDefinition = {
  manifest: gitleaksManifest,
  label: "gitleaks_label",
  capabilities: ["secrets", "secrets-history"],
  documents: [
    { binding: "config", native: [".gitleaks.toml"] },
    { binding: "ignore", native: [".gitleaksignore"] },
  ],
  args(input) {
    const config = input.documents.config?.file ?? null;
    const ignore = input.documents.ignore?.file ?? null;
    return [
      modeOf(input),
      ...GITLEAKS_FIXED_FLAGS,
      "--report-path",
      `${CONTAINER_OUTPUT}/${REPORT_FILE}`,
      ...(config ? ["--config", toContainerPath(config)] : []),
      ...(ignore ? ["--gitleaks-ignore-path", toContainerPath(ignore)] : []),
      ".",
    ];
  },
  exitCodes: [0, 3],
  network: false,
  conditions(input, t) {
    return [t(modeOf(input) === "git" ? "gitleaks_scope_git" : "gitleaks_scope_dir", { root: input.root }), t("gitleaks_condition_redact")];
  },
  limitations(_input, t) {
    return [t("gitleaks_limitation_exceptions")];
  },
  exclusive(capabilities, t) {
    // One process scans one scope; the other capability needs an instance of its own.
    const [first, ...rest] = capabilities;
    return Object.fromEntries(rest.filter((c) => c !== first).map((c) => [c, t("gitleaks_one_scope", { capability: c, first: first ?? "-" })]));
  },
  parse: parseGitleaksReport,
};

export const gitleaksAdapter: ExternalAdapter = {
  manifest: gitleaksManifest,
  plan: (input) => planScanner(gitleaksScanner, input),
  run: (context, plan, tool) => runScanner(gitleaksScanner, context, plan, tool),
};
