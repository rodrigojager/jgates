import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * jscpd as its own adapter: the duplication check the bridge also has as a subcheck, now with the project's
 * jscpd configuration. When this adapter runs the duplication capability the plan leaves the bridge's jscpd out, so the
 * tool never runs twice. The bridge's own jscpd subcheck always runs with the trusted config.
 */
export const jscpdManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "jscpd",
  displayName: "jscpd (duplication)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "jscpd",
  toolVersionRange: ">=4.0.0",
  runtimes: ["node"],
  platforms: ["linux", "win32", "darwin"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["quality"],
  capabilities: ["duplication"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "json",
      discovery: "the config binding of the instance in .jgates/tools.yml; else .jscpd.json in the component directory",
      precedence: "the binding over .jscpd.json; without either, the jscpd defaults",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "scan finished" },
      { code: 1, meaning: "scan finished over the configured threshold" },
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
  redirection: { flags: ["--output", "--reporters"], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
  limitations: ["The configuration is JSON data; the report is always JSON in the run folder whatever the config asks for."],
};
