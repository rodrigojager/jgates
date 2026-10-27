// Checkov adapter: one `checkov --directory` per tool instance in the container runner, offline (--skip-download),
// with the project's .checkov.yaml as its document and the JSON report written to the run folder's output mount.
import { CONTAINER_OUTPUT, toContainerPath } from "../../core/runner/index.js";
import type { ExternalAdapter } from "../../core/plan/adapters.js";
import { planScanner, runScanner, type ScannerDefinition } from "../container-scanner/index.js";
import { checkovManifest } from "./manifest.js";
import { parseCheckovReport } from "./normalize.js";

export { checkovManifest } from "./manifest.js";
export { parseCheckovReport } from "./normalize.js";

/** The file Checkov writes in --output-file-path for the json output. */
export const CHECKOV_REPORT = "results_json.json";

export const checkovScanner: ScannerDefinition = {
  manifest: checkovManifest,
  label: "checkov_label",
  capabilities: ["iac"],
  documents: [{ binding: "config", native: [".checkov.yaml", ".checkov.yml"] }],
  report: CHECKOV_REPORT,
  args(input) {
    const config = input.documents.config?.file ?? null;
    return [
      ...(config ? ["--config-file", toContainerPath(config)] : []),
      "--directory",
      ".",
      "--output",
      "json",
      "--output-file-path",
      CONTAINER_OUTPUT,
      "--quiet",
      "--compact",
      "--skip-download",
    ];
  },
  exitCodes: [0, 1],
  network: false,
  // No Prisma Cloud package scan and no check-id mapping download (the container has no network anyway).
  env: { CHECKOV_RUN_SCA_PACKAGE_SCAN_V2: "false", BC_SKIP_MAPPING: "TRUE" },
  conditions(_input, t) {
    return [t("checkov_condition_offline")];
  },
  limitations(_input, t) {
    return [t("checkov_limitation_severity"), t("checkov_limitation_exceptions")];
  },
  parse: parseCheckovReport,
};

export const checkovAdapter: ExternalAdapter = {
  manifest: checkovManifest,
  plan: (input) => planScanner(checkovScanner, input),
  run: (context, plan, tool) => runScanner(checkovScanner, context, plan, tool),
};
