// ShellCheck adapter (shell lint): runs `shellcheck --format json1` over the shell scripts the plan found in the workspace,
// in the step container of the tools image, and turns the JSON report into located, blocking findings. See ../lint-common.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { findFiles, makeLintAdapter, type LintSpec } from "../lint-common/index.js";
import { shellcheckManifest } from "./manifest.js";
import { parseShellcheck } from "./normalize.js";

export { shellcheckManifest } from "./manifest.js";
export { parseShellcheck } from "./normalize.js";

const SCRIPT = /\.(?:sh|bash|ksh)$/i;

export const shellcheckSpec: LintSpec = {
  manifest: shellcheckManifest,
  tool: "shellcheck",
  imageTool: "shellcheck",
  commandTool: "shellcheck",
  overrideEnv: "JGATES_SHELLCHECK",
  scope: "workspace",
  executesProjectCode: false,
  prepare(scanDir) {
    const t = translator("lint-stacks");
    const { files, tooMany } = findFiles(scanDir, (name) => SCRIPT.test(name));
    if (tooMany) return { skip: t("lint_too_many_files", { tool: "shellcheck", limit: files.length }) };
    if (files.length === 0) return { skip: t("lint_no_files", { tool: "shellcheck", kind: "*.sh, *.bash, *.ksh" }) };
    return {
      args: ["--format", "json1", "--color=never", "--", ...files],
      env: { NO_COLOR: "1" },
      contract: { files },
      configFiles: [".shellcheckrc"].filter((f) => fs.existsSync(path.join(scanDir, f))),
    };
  },
  parse: (stdout, _stderr, exitCode) => parseShellcheck(stdout, exitCode),
};

export const shellcheckAdapter = makeLintAdapter(shellcheckSpec);
