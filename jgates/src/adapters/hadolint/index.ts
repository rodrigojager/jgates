// Hadolint adapter (Dockerfile lint): runs `hadolint --format json` over the Dockerfiles the plan found in the workspace,
// in the step container of the tools image, and turns the JSON report into located, blocking findings. See ../lint-common.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { findFiles, makeLintAdapter, type LintSpec } from "../lint-common/index.js";
import { hadolintManifest } from "./manifest.js";
import { parseHadolint } from "./normalize.js";

export { hadolintManifest } from "./manifest.js";
export { parseHadolint } from "./normalize.js";

const DOCKERFILE = /^(?:Dockerfile(?:\..+)?|.+\.Dockerfile)$/i;

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
    const { files, tooMany } = findFiles(scanDir, (name) => DOCKERFILE.test(name));
    if (tooMany) return { skip: t("lint_too_many_files", { tool: "hadolint", limit: files.length }) };
    if (files.length === 0) return { skip: t("lint_no_files", { tool: "hadolint", kind: "Dockerfile" }) };
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
