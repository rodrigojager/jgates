import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * File-size check as a core adapter (Quality domain, "maintainability"): the budget of lines per file that the quality
 * sidecar's built-in gate enforced, now in-process in JGates. It reads the text files of the workspace and reports each
 * one over the limit (the maxLines setting of the instance, 5000 by default). It is offline, runs nothing of the
 * project and writes nothing; a file it cannot read, a binary file and a tree too big to walk are said in the result,
 * never counted as small.
 */
export const fileSizeManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "file-size",
  displayName: "File size (lines per file)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "jgates-file-size",
  toolVersionRange: "*",
  runtimes: ["native"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["quality"],
  capabilities: ["file-size"],
  granularity: ["workspace"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "yaml",
      discovery: "no tool file; the maxLines setting lives in the instance of .jgates/tools.yml",
      precedence: "the instance setting over the default (5000 lines)",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [{ code: 0, meaning: "in-process analysis finished (files over the limit are in the result)" }],
    reportRequired: false,
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
  redirection: { flags: [], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
  limitations: [
    "counts the lines of text files; binary files are skipped and listed, never counted as small",
    "does not enter generated or third-party folders (.git, node_modules, virtual environments, target, vendor, dist, build, obj)",
    "the limit is one number for every file type; there is no per-folder or per-extension limit",
  ],
  stackSupport: [
    {
      capability: "file-size",
      stack: "any",
      state: "validated",
      prerequisites: ["none: shipped with JGates"],
      limitations: ["lines per file only; bytes per file and change-size budgets stay with the quality bridge until it is retired"],
    },
  ],
  distribution: {
    mode: "shipped",
    spdx: "MIT",
    notices: ["LICENSE"],
  },
};
