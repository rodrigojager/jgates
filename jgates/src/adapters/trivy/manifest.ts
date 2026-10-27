import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Trivy as its own adapter (it leaves the bridge's trivy subcheck): `trivy fs` with the scanners the instance's
 * capabilities ask for (dependencies: vuln, iac: misconfig, secrets: secret, licenses: license), the project's
 * trivy.yaml and ignore file as two documents, and the vulnerability database it downloads recorded (source, date)
 * in the result. Needs network (the database and the checks bundle); runs on the container runner only.
 */
export const trivyManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "trivy",
  displayName: "Trivy",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "trivy",
  // JSON SchemaVersion 2 with the Trivy.Version field; the fixtures are of the pinned 0.72.0.
  toolVersionRange: ">=0.56.0 <1.0.0",
  runtimes: ["container"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64"],
  categories: ["dependencies", "infrastructure", "security"],
  capabilities: ["dependencies", "iac", "secrets", "licenses"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    { format: "yaml", discovery: "tools.yml config of the instance, otherwise trivy.yaml in the scan root (Trivy's own default)", precedence: "command-line flags of the plan over the file" },
    { format: "text", discovery: "tools.yml configFiles.ignore of the instance, otherwise .trivyignore (or .trivyignore.yaml) in the scan root", precedence: "a separate document: findings the scanner skips (a scanner exception, not a waiver of the gate)" },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "scan finished (--exit-code 0: findings are in the report)" },
      { code: 1, meaning: "error" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    executesProjectCode: false,
    usesNetwork: true,
    needsService: false,
    usesAi: false,
    needsLicense: false,
  },
  redirection: { flags: ["--output", "--cache-dir", "--skip-version-check", "--disable-telemetry"], env: ["HOME", "TMPDIR"], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "medium",
  origin: "builtin",
  license: "Apache-2.0",
  kind: "tool",
  limitations: [
    "runs only on the container runner, in the image `jgates tools prepare` pins in .jgates/lock.json (the sidecar image by default)",
    "the vulnerability database is cached in the data folder (tools/cache/trivy-db) and reused while its NextUpdate is in the future (--skip-db-update); the checks bundle and the Java database are still downloaded on every run",
  ],
};
