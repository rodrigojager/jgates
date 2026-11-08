import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * ZAP (Zed Attack Proxy) as runtime security evidence (Security domain, dast capability) against a running target the
 * customer names (tools.<id>.target). One container run of the official image per tool instance:
 *   - passive (the default): zap-baseline.py (spider + passive rules) or, with an OpenAPI spec, zap-api-scan.py -S
 *     (the API is imported and only passive rules run); no attack payloads are sent;
 *   - active: zap-full-scan.py or zap-api-scan.py without -S, which send attack payloads. It is refused unless the
 *     instance sets mode: active AND allowActive: true, and the plan lists its effects.
 * The image comes from the customer (`docker pull ghcr.io/zaproxy/zaproxy:stable`); the run uses `--pull never` and the
 * image id recorded in the plan, and never downloads anything. Without a target the stage is blocked, never passed.
 */
export const zapManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "zap",
  displayName: "ZAP (runtime security scan)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "zap",
  // The JSON report (-J) of the packaged scan scripts; the fixtures are of 2.17.0.
  toolVersionRange: ">=2.14.0 <3.0.0",
  runtimes: ["container"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["security"],
  capabilities: ["dast"],
  granularity: ["workspace"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "yaml",
      discovery: "the settings target, spec, mode, allowActive, auth, image, blockingRisk and spiderMinutes live in the instance of .jgates/tools.yml; the OpenAPI spec (optional) selects the API scan",
      precedence: "the settings of the instance decide everything; no ZAP configuration file of the project is read",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "scan finished (the plan passes -I, so warnings do not change the code; alerts are in the JSON report)" },
      { code: 1, meaning: "scan finished with alerts at FAIL level (alerts are in the JSON report)" },
      { code: 2, meaning: "scan finished with warnings (alerts are in the JSON report)" },
      { code: 3, meaning: "the scan could not run (target unreachable, bad spec, internal error): the stage is an error, never passed" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    executesProjectCode: false,
    usesNetwork: true,
    needsService: true,
    usesAi: false,
    needsLicense: false,
  },
  redirection: {
    flags: ["-J", "-I", "--pull"],
    env: [],
    outputPaths: [],
    unavoidableWorkspaceWrites: [],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "high",
  origin: "builtin",
  license: "Apache-2.0",
  kind: "tool",
  limitations: [
    "runs only against a running target the customer names (tools.<id>.target); without it the stage is blocked, never passed",
    "passive mode still sends requests (spider or API import); active mode sends attack payloads and may change the target's data, so it is refused unless explicitly enabled (mode: active and allowActive: true)",
    "a target on the host's loopback is reached from the container as host.docker.internal; the Docker image is supplied by the customer and never pulled during a run",
  ],
  stackSupport: [
    {
      capability: "dast",
      stack: "any",
      state: "validated",
      prerequisites: ["Docker and the ZAP image (docker pull ghcr.io/zaproxy/zaproxy:stable)", "a running HTTP target (tools.<id>.target); an OpenAPI spec for the API scan"],
      limitations: ["HTTP targets only; authenticated scans use one header from an environment variable"],
    },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/zaproxy/zaproxy",
    spdx: "Apache-2.0",
    acquisition: ["https://www.zaproxy.org/docs/docker/about/", "https://github.com/zaproxy/zaproxy/pkgs/container/zaproxy"],
    setup: ["https://www.zaproxy.org/docs/docker/baseline-scan/", "https://www.zaproxy.org/docs/docker/api-scan/", "https://www.zaproxy.org/docs/docker/full-scan/"],
  },
};
