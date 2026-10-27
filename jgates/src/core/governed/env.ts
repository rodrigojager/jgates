// The environment of the quality gate's process in jgates ci. The local bridge keeps the environment it always had;
// the governed one gets only what the analysis needs to start (an allowlist): CI credentials, cloud and registry
// tokens, Git helpers and MEGALINTER_COMMAND (which would replace MegaLinter with any command) never reach it.
import { DEFAULT_ENV_ALLOWLIST } from "../runner/index.js";

/** Variables the governed bridge keeps, besides the runner's default allowlist. */
export const GOVERNED_BRIDGE_ENV: readonly string[] = [
  // The interpreter and the sidecar the bridge starts (resolvePython, resolveSidecarDir, the bridge timeout).
  "JGATES_PYTHON",
  "JGATES_SIDECAR_DIR",
  "JGATES_BRIDGE_TIMEOUT_MS",
  "JGATES_LOCALE",
  // The flavor of a source checkout (the image bakes its own in a root-owned file).
  "QUALITY_GATE_FLAVOR",
  // Network through the organization's proxy and its certificates (the scanners download their databases).
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
];

/** The allowlisted copy of `env` the governed bridge runs with. */
export function governedBridgeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of [...DEFAULT_ENV_ALLOWLIST, ...GOVERNED_BRIDGE_ENV]) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
