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
  stackSupport: [
    { capability: "sast", stack: "python", state: "validated", prerequisites: ["Semgrep from the JGates tools image", "tools.<id>.rulePack: jgates (bundled JGates pack), local rules in the project or rules prepared with tools prepare"] },
    { capability: "sast", stack: "javascript", state: "validated", prerequisites: ["Semgrep from the JGates tools image", "tools.<id>.rulePack: jgates (bundled JGates pack) or local rules"] },
    { capability: "sast", stack: "typescript", state: "validated", prerequisites: ["Semgrep from the JGates tools image", "tools.<id>.rulePack: jgates (bundled JGates pack) or local rules"] },
    { capability: "sast", stack: "go", state: "validated", prerequisites: ["Semgrep from the JGates tools image", "tools.<id>.rulePack: jgates (bundled JGates pack) or local rules"] },
    { capability: "sast", stack: "csharp", state: "validated", prerequisites: ["Semgrep from the JGates tools image", "tools.<id>.rulePack: jgates (bundled JGates pack) or local rules"] },
    { capability: "sast", stack: "rust", state: "validated", prerequisites: ["Semgrep from the JGates tools image", "tools.<id>.rulePack: jgates (bundled JGates pack) or local rules"] },
    { capability: "sast", stack: "java", state: "validated", prerequisites: ["Semgrep from the JGates tools image", "tools.<id>.rulePack: jgates (bundled JGates pack) or local rules"], limitations: ["SAST only: Java has no component template, so no lint, type check, tests or dependency preparation run for it."] },
    { capability: "sast", stack: "php", state: "validated", prerequisites: ["Semgrep from the JGates tools image", "tools.<id>.rulePack: jgates (bundled JGates pack) or local rules"], limitations: ["SAST only: PHP has no component template, so no lint, type check, tests or dependency preparation run for it."] },
    { capability: "sast", stack: "any", state: "customer-setup-required", prerequisites: ["Semgrep from the JGates tools image", "local rules for the language, supplied by the customer or prepared with tools prepare"], limitations: ["The bundled pack has rules for JavaScript, TypeScript, Python, Go, C#, Rust, Java and PHP; any other language depends on the rules the customer supplies.", "Official semgrep-rules are never shipped: tools prepare fetches registry rules for the customer's own use."] },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/semgrep/semgrep",
    spdx: "LGPL-2.1-only",
    acquisition: ["https://semgrep.dev/docs/getting-started/cli"],
    setup: ["https://semgrep.dev/docs/writing-rules/overview"],
  },
};
