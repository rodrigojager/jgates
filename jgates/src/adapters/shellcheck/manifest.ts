import type { AdapterManifest } from "../../core/catalog/index.js";
import { lintManifest } from "../lint-common/manifest.js";

/**
 * ShellCheck as the shell lint adapter: `shellcheck --format json1` over the shell scripts of the workspace (files named
 * *.sh, *.bash or *.ksh, found by the plan and listed in the command). The project's .shellcheckrc and the `# shellcheck`
 * directives of the scripts decide what is reported. ShellCheck only reads the scripts; nothing is rewritten.
 */
const base: AdapterManifest = lintManifest({
  id: "shellcheck",
  displayName: "ShellCheck (shell script lint)",
  toolName: "shellcheck",
  toolVersionRange: ">=0.9.0",
  configDiscovery: ".shellcheckrc in the workspace (ShellCheck walks up from each script) and the # shellcheck directives of the scripts",
  configPrecedence: "the configuration of the project decides which checks are enabled and which findings are excluded; JGates adds only the JSON format and the file list",
  exitCodes: [
    { code: 0, meaning: "no issue" },
    { code: 1, meaning: "issues found" },
    { code: 2, meaning: "a script could not be read or parsed" },
    { code: 3, meaning: "bad invocation" },
    { code: 4, meaning: "an option is not supported" },
  ],
  executesProjectCode: false,
  redirectionFlags: ["--format", "--color"],
  redirectionEnv: ["NO_COLOR"],
  relativeCost: "low",
  license: "GPL-3.0-only",
  limitations: [
    "checks the files named *.sh, *.bash or *.ksh, up to 500; scripts without that extension (a shebang only) are not found, and a workspace with more files is not applicable until the list is narrowed",
    "ShellCheck reads every severity: errors, warnings, info and style findings are all blocking findings; the project's .shellcheckrc excludes the ones it does not want",
    "a script ShellCheck cannot parse is an error stage, never a pass",
  ],
  stackSupport: [
    {
      capability: "lint",
      stack: "any",
      state: "validated",
      prerequisites: ["shellcheck in the JGates tools image", "at least one shell script (*.sh, *.bash, *.ksh) in the workspace"],
      limitations: ["shell scripts of any project, whatever its language; the shell dialect comes from each script's shebang or directive"],
    },
  ],
  sourceUrl: "https://github.com/koalaman/shellcheck",
  acquisition: ["https://github.com/koalaman/shellcheck#installing"],
  setup: ["https://github.com/koalaman/shellcheck/wiki/Directive", "https://github.com/koalaman/shellcheck/blob/master/shellcheck.1.md#rc-files"],
});

// Reads the synchronized copy of the project only: its step may run beside others (ADR-0023).
export const shellcheckManifest: AdapterManifest = { ...base, effects: { ...base.effects, onlyReadsProject: true } };
