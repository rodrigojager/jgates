import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Trivy as its own adapter (it leaves the bridge's trivy subcheck): `trivy fs` with the scanners the instance's
 * capabilities ask for (dependencies: vuln, iac: misconfig, secrets: secret, licenses: license), the project's
 * trivy.yaml and ignore file as two documents, and the vulnerability database it downloads recorded (source, date)
 * in the result. Offline: the database is the jgates-data volume (read-only, `jgates tools update-data`); runs on the container runner only.
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
  capabilities: ["dependencies", "iac", "secrets", "licenses", "sbom"],
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
    usesNetwork: false,
    needsService: false,
    usesAi: false,
    needsLicense: false,
    // Reads the synchronized copy of the project only: its step may run beside others (ADR-0023).
    onlyReadsProject: true,
  },
  redirection: { flags: ["--output", "--cache-dir", "--skip-version-check", "--disable-telemetry"], env: ["HOME", "TMPDIR"], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "medium",
  origin: "builtin",
  license: "Apache-2.0",
  kind: "tool",
  limitations: [
    "runs only in a step container of the JGates tools image, never as a process of the host",
    "an SBOM instance (capability sbom) runs `trivy fs --format cyclonedx` with no scanner: it writes the project's CycloneDX bill of materials (sbom.cdx.json) to the run folder as an artifact, finds no vulnerability, needs no database, and fails only when the document cannot be produced; it runs alone (it is not combined with the scanner capabilities)",
    "final-image mode: tools.<id>.imageRef (an image reference) or imageTarball (a docker save archive) replaces the filesystem scan with `trivy image` (vulnerabilities only, network for the database); Trivy runs in a step container of the JGates tools image, and without a running container engine the stage is blocked, never passed; JGates never builds or pulls the scanned image (a registry reference is read by Trivy itself, over the network), and the scan cannot be cancelled once started (the stage timeout bounds it)",
    "offline: the vulnerability database is read from the jgates-data volume (mounted read-only, --skip-db-update --offline-scan, no network); the checks embedded in Trivy are used and the Java database is not read; without the data the stage is blocked (DATA_MISSING) and older than execution.dataMaxAgeDays it is DATA_STALE",
  ],
  stackSupport: [
    { capability: "dependencies", stack: "any", state: "validated", prerequisites: ["Docker", "the JGates tools image (jgates setup)", "the Trivy vulnerability database (jgates tools update-data)"] },
    { capability: "iac", stack: "any", state: "validated", prerequisites: ["Docker", "the JGates tools image (jgates setup)"] },
    { capability: "secrets", stack: "any", state: "validated", prerequisites: ["Docker", "the JGates tools image (jgates setup)"] },
    { capability: "licenses", stack: "any", state: "validated", prerequisites: ["Docker", "the JGates tools image (jgates setup)"] },
    { capability: "sbom", stack: "any", state: "validated", prerequisites: ["Docker", "the JGates tools image (jgates setup)"] },
  ],
  distribution: {
    mode: "prepared-from-authorized-source",
    sourceUrl: "https://github.com/aquasecurity/trivy",
    spdx: "Apache-2.0",
    acquisition: ["https://trivy.dev/latest/getting-started/installation/"],
    setup: ["https://trivy.dev/latest/docs/configuration/"],
  },
};
