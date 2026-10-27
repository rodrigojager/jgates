import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Semgrep with local rules only: the instance's binding points to a rule file or a directory of rule files and
 * the run uses nothing else (no registry, no network, metrics off). The registry rules (p/default) enter only through
 * `jgates tools prepare`, which stores them by hash under JGATES_HOME/tools and pins the hash in .jgates/lock.json;
 * the run then reads that stored copy.
 */
export const semgrepManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "semgrep",
  displayName: "Semgrep (local rules)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "semgrep",
  toolVersionRange: ">=1.100.0",
  runtimes: ["native"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["security"],
  capabilities: ["sast"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "yaml",
      discovery: "the config binding of the instance in .jgates/tools.yml: one rule file or a directory of rule files (for example .jgates/rules)",
      precedence: "only the bound rules are used; nothing is searched for or downloaded",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "scan finished (findings are in the JSON output)" },
      { code: 2, meaning: "fatal error" },
      { code: 7, meaning: "invalid rule configuration" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    executesProjectCode: false,
    usesNetwork: false,
    needsService: false,
    usesAi: false,
    needsLicense: false,
  },
  redirection: {
    flags: ["--output", "--metrics=off", "--disable-version-check"],
    env: ["HOME", "USERPROFILE", "SEMGREP_SEND_METRICS", "SEMGREP_ENABLE_VERSION_CHECK"],
    // Semgrep keeps its settings, log and caches under the home folder (~/.semgrep): a throwaway one in the run folder.
    outputPaths: [{ path: "cache/semgrep/home", purpose: "home", env: ["HOME", "USERPROFILE"] }],
    unavoidableWorkspaceWrites: [],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "medium",
  origin: "builtin",
  license: "LGPL-2.1",
  kind: "tool",
};
