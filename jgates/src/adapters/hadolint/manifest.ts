import type { AdapterManifest } from "../../core/catalog/index.js";
import { lintManifest } from "../lint-common/manifest.js";

/**
 * Hadolint as the Dockerfile lint adapter: `hadolint --format json --failure-threshold style` over the Dockerfiles of the
 * workspace (Dockerfile, Dockerfile.*, *.Dockerfile, found by the plan and listed in the command). The project's
 * .hadolint.yaml and the `# hadolint ignore` comments decide what is reported. Hadolint only reads the files; nothing is
 * rewritten and no image is built.
 */
export const hadolintManifest: AdapterManifest = lintManifest({
  id: "hadolint",
  displayName: "Hadolint (Dockerfile lint)",
  toolName: "hadolint",
  toolVersionRange: ">=2.0.0",
  configDiscovery: ".hadolint.yaml or .hadolint.yml in the working folder (the workspace root) and the # hadolint ignore comments of the Dockerfiles",
  configPrecedence: "the configuration of the project decides the ignored rules, trusted registries and severity overrides; JGates sets only the JSON format and a failure threshold of style, so that every reported rule is a finding",
  exitCodes: [
    { code: 0, meaning: "no rule fired" },
    { code: 1, meaning: "rules fired at or above the failure threshold (a syntax error is a DL1000 rule)" },
  ],
  executesProjectCode: false,
  redirectionFlags: ["--format", "--failure-threshold", "--no-color"],
  redirectionEnv: ["NO_COLOR"],
  relativeCost: "low",
  license: "GPL-3.0-only",
  limitations: [
    "checks the files named Dockerfile, Dockerfile.* or *.Dockerfile, up to 500; other names (Containerfile) are not found, and a workspace with more files is not applicable until the list is narrowed",
    "every severity is a blocking finding (error, warning, info, style); the project's .hadolint.yaml ignores the rules it does not want",
    "static analysis of the file: no image is built and the base images are not pulled",
  ],
  stackSupport: [
    {
      capability: "lint",
      stack: "any",
      state: "validated",
      prerequisites: ["hadolint in the JGates tools image", "at least one Dockerfile in the workspace"],
      limitations: ["Dockerfiles of any project, whatever its language; the shell inside RUN instructions is checked with ShellCheck by hadolint itself"],
    },
  ],
  sourceUrl: "https://github.com/hadolint/hadolint",
  acquisition: ["https://github.com/hadolint/hadolint#install"],
  setup: ["https://github.com/hadolint/hadolint#configure"],
});
