// Project configuration files of the bridge scanners (local mode only; governed mode keeps the trusted configuration).
//
// In .jgates/tools.yml the bridge instance (adapter quality-bridge) binds a scanner's file with a configFiles entry
// whose id is the subcheck id: gitleaks, trivy or osv-scanner. The plan sends the workspace-relative path in the
// bridge request (toolConfigs); the sidecar checks it again (inside the target, symlinks followed, file present) and
// uses it in place of the trusted package file. jgates ci never sends them: its configuration comes from the policy
// folder, so the packaged files are used.
//
// effectiveCommand mirrors the argv of quality_sidecar/tools.py (_run_gitleaks, _run_trivy, _run_osv_scanner) in the
// public form of the sidecar report: workspace paths relative to the workspace root, the run folder as {runDir} and
// the package configuration folder as {sidecarConfig}. jgates/tests/bridge-config.test.js compares it with the
// command the sidecar answers after running a fake scanner, so the two cannot drift apart silently.
import crypto from "node:crypto";
import fs from "node:fs";
import { resolveToolBindings, type ResolvedBinding } from "../../core/tools/index.js";
import { ADAPTER_ID } from "./requirements.js";

export const CONFIGURABLE_SUBCHECKS = ["gitleaks", "trivy", "osv-scanner"] as const;
export type ConfigurableSubcheck = (typeof CONFIGURABLE_SUBCHECKS)[number];

/** Trusted files of the sidecar package (quality-gate/sidecar/config), used when the project binds none. */
export const PACKAGE_CONFIGS: Record<ConfigurableSubcheck, string> = {
  gitleaks: "gitleaks-ci.toml",
  trivy: "trivy-ci.yaml",
  "osv-scanner": "osv-scanner-ci.toml",
};

/** Placeholder of the sidecar's package configuration folder in effective commands. */
export const SIDECAR_CONFIG_TOKEN = "{sidecarConfig}";
const RAW_DIR = `{runDir}/outputs/${ADAPTER_ID}/raw`;

export const isConfigurable = (id: string): id is ConfigurableSubcheck => (CONFIGURABLE_SUBCHECKS as readonly string[]).includes(id);

export interface BridgeConfigFile {
  subcheck: ConfigurableSubcheck;
  /** Workspace-relative path, forward slashes (what the request carries). */
  file: string;
  sha256: string | null;
}

export interface BridgeConfigProblem {
  code: "BRIDGE_CONFIG_OUTSIDE_WORKSPACE" | "BRIDGE_CONFIG_MISSING" | "BRIDGE_CONFIG_NOT_FILE";
  subcheck: ConfigurableSubcheck;
  declared: string;
}

export interface BridgeConfigs {
  /** Subcheck id -> workspace-relative file, for the request's toolConfigs. */
  toolConfigs: Partial<Record<ConfigurableSubcheck, string>>;
  files: BridgeConfigFile[];
  problems: BridgeConfigProblem[];
}

function sha256Of(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/** The configuration files the project binds for the given bridge subchecks (only those that will run). */
export function bridgeToolConfigs(dir: string, subchecks: readonly string[]): BridgeConfigs {
  const out: BridgeConfigs = { toolConfigs: {}, files: [], problems: [] };
  const wanted = subchecks.filter(isConfigurable);
  if (wanted.length === 0) return out;
  const instance = resolveToolBindings(dir, { skipInventory: true }).instances.find((i) => i.adapter === ADAPTER_ID);
  if (!instance) return out;
  for (const sub of wanted) {
    const binding: ResolvedBinding | undefined = instance.bindings.find((b) => b.id === sub && b.role !== "ignore");
    if (!binding) continue;
    // The sidecar only accepts files inside the target: an external root or a symlink escape is refused here first.
    if (binding.refused || binding.relPath === null) out.problems.push({ code: "BRIDGE_CONFIG_OUTSIDE_WORKSPACE", subcheck: sub, declared: binding.declared });
    else if (!binding.exists) out.problems.push({ code: "BRIDGE_CONFIG_MISSING", subcheck: sub, declared: binding.declared });
    else if (binding.kind !== "file") out.problems.push({ code: "BRIDGE_CONFIG_NOT_FILE", subcheck: sub, declared: binding.declared });
    else {
      out.toolConfigs[sub] = binding.relPath;
      out.files.push({ subcheck: sub, file: binding.relPath, sha256: sha256Of(binding.absPath) });
    }
  }
  return out;
}

export interface EffectiveCommand {
  executable: string;
  args: string[];
  cwd: string;
  config: { source: "project" | "package"; file: string };
}

/** The argv the sidecar runs for one configurable subcheck (see the header of this module). */
export function effectiveCommand(subcheck: string, options: { config: string | null; secrets: boolean }): EffectiveCommand | null {
  if (!isConfigurable(subcheck)) return null;
  const config = options.config ?? `${SIDECAR_CONFIG_TOKEN}/${PACKAGE_CONFIGS[subcheck]}`;
  const source = options.config ? ("project" as const) : ("package" as const);
  const base = { executable: subcheck, cwd: SIDECAR_CONFIG_TOKEN, config: { source, file: options.config ?? PACKAGE_CONFIGS[subcheck] } };
  switch (subcheck) {
    case "gitleaks":
      return {
        ...base,
        args: [
          "--redact=100",
          "--no-banner",
          "--config",
          config,
          "--gitleaks-ignore-path",
          `${SIDECAR_CONFIG_TOKEN}/gitleaksignore-ci`,
          "--ignore-gitleaks-allow",
          "--report-format",
          "json",
          "--report-path",
          `${RAW_DIR}/gitleaks.json`,
          "dir",
          ".",
        ],
      };
    case "trivy":
      return {
        ...base,
        args: [
          "--config",
          config,
          "fs",
          "--ignorefile",
          `${SIDECAR_CONFIG_TOKEN}/trivyignore-ci`,
          "--show-suppressed",
          "--scanners",
          options.secrets ? "vuln,misconfig,secret" : "vuln,misconfig",
          "--format",
          "json",
          "--output",
          `${RAW_DIR}/trivy.json`,
          "--exit-code",
          "0",
          ...[".git", ".quality", "node_modules", "vendor"].flatMap((d) => ["--skip-dirs", d]),
          ".",
        ],
      };
    case "osv-scanner":
      return {
        ...base,
        args: ["scan", "source", "--recursive", "--no-ignore", "--allow-no-lockfiles", "--config", config, "--format", "json", "."],
      };
  }
}
