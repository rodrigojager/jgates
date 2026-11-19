import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * OSV-Scanner as its own adapter (it leaves the bridge's osv-scanner subcheck): `osv-scanner scan source --recursive`
 * over the lockfiles of the scan root. Configuration follows the real tool: a bound osv-scanner.toml is passed with
 * --config and then applies to every lockfile; without a binding OSV-Scanner reads the osv-scanner.toml next to each
 * lockfile (no inheritance between directories), and the plan lists and hashes the ones it finds. Offline mode: the
 * vulnerabilities come from the OSV databases in the jgates-data volume (read-only, `jgates tools update-data`), whose fetch
 * time the result records. Runs on the container runner only.
 */
export const osvScannerManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "osv-scanner",
  displayName: "OSV-Scanner",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "osv-scanner",
  // The JSON of the v2 `scan source` command (results, packages, groups); the fixtures are of the pinned 2.4.0.
  toolVersionRange: ">=2.0.0 <3.0.0",
  runtimes: ["container"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64"],
  categories: ["dependencies"],
  capabilities: ["dependencies"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "toml",
      discovery: "tools.yml config of the instance (passed with --config, for every lockfile), otherwise the osv-scanner.toml next to each lockfile",
      precedence: "--config replaces the per-directory files; directories do not inherit from their parents",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "no vulnerability found" },
      { code: 1, meaning: "vulnerabilities found" },
      { code: 127, meaning: "general error" },
      { code: 128, meaning: "no package sources found" },
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
    // Reads the synchronized copy of the project only: its step may run beside others (ADR-0023).
    onlyReadsProject: true,
  },
  redirection: { flags: ["--output-file", "--format"], env: ["HOME", "TMPDIR"], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "Apache-2.0",
  kind: "tool",
  limitations: [
    "runs only in a step container of the JGates tools image, never as a process of the host",
    "offline mode (--offline-vulnerabilities, no network): the OSV databases come from the jgates-data volume, mounted read-only; without the data the stage is blocked (DATA_MISSING), older than execution.dataMaxAgeDays it is DATA_STALE",
  ],
  stackSupport: [
    { capability: "dependencies", stack: "any", state: "validated", prerequisites: ["Docker", "the JGates tools image (jgates setup)", "the OSV offline databases (jgates tools update-data)"] },
  ],
  distribution: {
    mode: "prepared-from-authorized-source",
    sourceUrl: "https://github.com/google/osv-scanner",
    spdx: "Apache-2.0",
    acquisition: ["https://google.github.io/osv-scanner/installation/"],
    setup: ["https://google.github.io/osv-scanner/configuration/"],
  },
};
