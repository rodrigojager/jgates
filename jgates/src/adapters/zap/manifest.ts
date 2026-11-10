import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * ZAP (Zed Attack Proxy) as runtime security evidence (Security domain, dast capability) against a running target the
 * customer names (tools.<id>.target). One step container of the JGates tools image per tool instance, which runs
 * `zap.sh -cmd -autorun` with an Automation Framework plan JGates writes in the run folder (the tools image carries the
 * ZAP Linux package, not the official image's zap-*.py scripts):
 *   - passive (the default): the spider (or, with an OpenAPI spec, the API import) and the passive rules only; no
 *     attack payloads are sent;
 *   - active: the same plus the active scan, which sends attack payloads. It is refused unless the instance sets
 *     mode: active AND allowActive: true, and the plan lists its effects.
 * The report is ZAP's traditional JSON. Without a target the stage is blocked, never passed.
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
      discovery: "the settings target, spec, mode, allowActive, auth, blockingRisk and spiderMinutes live in the instance of .jgates/tools.yml; the OpenAPI spec (optional) selects the API scan",
      precedence: "the settings of the instance decide everything; no ZAP configuration file of the project is read",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "the automation plan succeeded (alerts do not change the code; they are in the JSON report)" },
      { code: 2, meaning: "the automation plan finished with warnings (alerts are in the JSON report)" },
      { code: 1, meaning: "a job of the plan failed (target unreachable, bad spec, internal error): the stage is an error, never passed" },
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
    flags: ["-dir", "-autorun", "-silent"],
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
    "a target on the host's loopback is reached from the container as host.docker.internal; ZAP runs in the JGates tools image and no other image can be named",
  ],
  stackSupport: [
    {
      capability: "dast",
      stack: "any",
      state: "validated",
      prerequisites: ["Docker and the JGates tools image (jgates setup)", "a running HTTP target (tools.<id>.target); an OpenAPI spec for the API scan"],
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
