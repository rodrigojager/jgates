// Hadolint adapter (Dockerfile lint): runs `hadolint --format json` over the Dockerfiles the plan found in the workspace,
// in the step container of the tools image, and turns the JSON report into located, blocking findings. See ../lint-common.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { activatedFiles, fileCensus } from "../linter/census.js";
import { MAX_FILES, makeLintAdapter, type LintSpec } from "../lint-common/index.js";
import { hadolintManifest } from "./manifest.js";
import { parseHadolint } from "./normalize.js";

export { hadolintManifest } from "./manifest.js";
export { parseHadolint } from "./normalize.js";

/** The Dockerfiles anywhere in the project. */
const ACTIVATION = { names: ["Dockerfile", "Containerfile", "*.Dockerfile", "Dockerfile.*"] };

export const hadolintSpec: LintSpec = {
  manifest: hadolintManifest,
  tool: "hadolint",
  imageTool: "hadolint",
  commandTool: "hadolint",
  overrideEnv: "JGATES_HADOLINT",
  scope: "workspace",
  executesProjectCode: false,
  prepare(scanDir) {
    const t = translator("lint-stacks");
    const files = activatedFiles(fileCensus(scanDir), ACTIVATION);
    if (files.length > MAX_FILES) return { skip: t("lint_too_many_files", { tool: "hadolint", limit: MAX_FILES }) };
    if (files.length === 0) return { skip: t("lint_no_files", { tool: "hadolint", kind: "Dockerfile, Containerfile" }) };
    return {
      args: ["--format", "json", "--failure-threshold", "style", "--no-color", ...files],
      env: { NO_COLOR: "1" },
      contract: { files },
      configFiles: [".hadolint.yaml", ".hadolint.yml"].filter((f) => fs.existsSync(path.join(scanDir, f))),
    };
  },
  parse: (stdout, _stderr, exitCode) => parseHadolint(stdout, exitCode),
};

export const hadolintAdapter = makeLintAdapter(hadolintSpec);
