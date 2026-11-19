// ShellCheck adapter (shell lint): runs `shellcheck --format json1` over the shell scripts the plan found in the workspace,
// in the step container of the tools image, and turns the JSON report into located, blocking findings. See ../lint-common.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { activatedFiles, fileCensus } from "../linter/census.js";
import { MAX_FILES, makeLintAdapter, type LintSpec } from "../lint-common/index.js";
import { shellcheckManifest } from "./manifest.js";
import { parseShellcheck } from "./normalize.js";

export { shellcheckManifest } from "./manifest.js";
export { parseShellcheck } from "./normalize.js";

/** The shell scripts anywhere in the project: by extension, or (files with no extension) by a first line that is a shell shebang. */
const ACTIVATION = {
  extensions: [".sh", ".bash", ".dash", ".ksh"],
  content: { pattern: "^#!\\s*(?:/usr/bin/env\\s+(?:-S\\s+)?)?(?:/\\S+/)?(?:ba|da|k)?sh(?:\\s|$)", firstLine: true },
};

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
    const files = activatedFiles(fileCensus(scanDir), ACTIVATION);
    if (files.length > MAX_FILES) return { skip: t("lint_too_many_files", { tool: "shellcheck", limit: MAX_FILES }) };
    if (files.length === 0) return { skip: t("lint_no_files", { tool: "shellcheck", kind: "*.sh, *.bash, *.dash, *.ksh, shell shebang" }) };
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
