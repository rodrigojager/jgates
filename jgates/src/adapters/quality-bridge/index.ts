// Bridge adapter: runs the current quality-gate through the sidecar bridge as one composite step.
// Every output of the sidecar (reports, raw evidence, scope projections) goes to the run folder, never the workspace.
import fs from "node:fs";
import path from "node:path";
import { callBridge, type BridgeOutcome, type BridgeRequest } from "../../core/bridge/index.js";
import { governedBridgeEnv } from "../../core/governed/env.js";
import type { AdapterContext, AdapterOutput } from "../../core/run/types.js";
import { qualityBridgeManifest } from "./manifest.js";
import { normalizeBridge } from "./normalize.js";
import { ADAPTER_ID, BRIDGE_MODES, DEFAULT_SELECTION, planSubchecks, type BridgeMode, type BridgeSelection, type SubcheckPlan } from "./requirements.js";

export { qualityBridgeManifest } from "./manifest.js";
export { normalizeBridge, normalizeSeverity } from "./normalize.js";
export * from "./requirements.js";
export { requestFromPlan, runBridgeFromPlan, subchecksFromPlan } from "./from-plan.js";
export * from "./tool-configs.js";
export { duplicateScanners, SUPERSEDING_ADAPTERS, supersededPairs, type ActivePair, type SupersededPair } from "./superseded.js";

export type SelectionProblem = { kind: "invalid_value"; name: string; value: string; allowed: string };

/** Reads the bridge selection from the run options (CLI flags). */
export function selectionFromOptions(options: Record<string, string | boolean>): BridgeSelection | SelectionProblem {
  const selection: BridgeSelection = { ...DEFAULT_SELECTION };
  const mode = options["bridge-mode"];
  if (mode !== undefined) {
    if (typeof mode !== "string" || !BRIDGE_MODES.includes(mode as BridgeMode)) {
      return { kind: "invalid_value", name: "--bridge-mode", value: String(mode), allowed: BRIDGE_MODES.join(", ") };
    }
    selection.mode = mode as BridgeMode;
  }
  if (options["enable-pii"] === true) selection.pii = true;
  if (options["enable-secrets"] === true) selection.secrets = true;
  if (options["disable-iac"] === true) selection.iac = false;
  if (options["run-project-tests"] === true) selection.projectTests = true;
  if (options["enable-coverage"] === true) selection.coverage = true;
  return selection;
}

export function buildRequest(selection: BridgeSelection, target: string, outputDir: string): BridgeRequest {
  return {
    schemaVersion: 1,
    target,
    outputDir,
    mode: selection.mode,
    pii: selection.pii,
    secrets: selection.secrets,
    iac: selection.iac,
    projectTests: selection.projectTests,
    coverage: selection.coverage,
    ...(selection.subchecks ? { subchecks: [...selection.subchecks] } : {}),
    ...(selection.toolConfigs && Object.keys(selection.toolConfigs).length > 0 ? { toolConfigs: { ...selection.toolConfigs } } : {}),
  };
}

function writePrivate(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o600 });
}

const rel = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

/** Runs the bridge for one selection (the option flags) and normalizes the answer. */
export async function runQualityBridge(context: AdapterContext, selection: BridgeSelection): Promise<AdapterOutput> {
  const outputDir = path.join(context.outputsDir, ADAPTER_ID);
  const request = buildRequest(selection, context.workspacePath, outputDir);
  const subcheckIds = (qualityBridgeManifest.subchecks ?? []).map((s) => s.id);
  return executeBridge(context, request, planSubchecks(selection, subcheckIds));
}

/** Calls the bridge with a request and normalizes the answer against the requirement plans. */
export async function executeBridge(context: AdapterContext, request: BridgeRequest, plans: SubcheckPlan[]): Promise<AdapterOutput> {
  const outputDir = request.outputDir;
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const requestFile = path.join(outputDir, "bridge-request.json");
  writePrivate(requestFile, JSON.stringify(request, null, 2) + "\n");

  // The runner streams the sidecar's output into the log files as it comes (bounded by JGATES_MAX_LOG_BYTES, with
  // the truncation marker), not from the in-memory copy afterwards.
  const stdoutLog = path.join(context.logsDir, `${ADAPTER_ID}.stdout.log`);
  const stderrLog = path.join(context.logsDir, `${ADAPTER_ID}.stderr.log`);
  fs.mkdirSync(context.logsDir, { recursive: true, mode: 0o700 });
  // A hardened request (jgates ci) runs with an allowlisted environment: no CI token, no MEGALINTER_COMMAND.
  const env = request.hardened === true ? governedBridgeEnv(context.env) : context.env;
  const outcome: BridgeOutcome = await callBridge(request, { cwd: context.runDir, env, stdoutFile: stdoutLog, stderrFile: stderrLog });

  // When nothing started (no interpreter, no sidecar) the runner wrote no log: the files still exist, empty.
  if (!fs.existsSync(stdoutLog)) writePrivate(stdoutLog, "");
  if (!fs.existsSync(stderrLog)) writePrivate(stderrLog, "");
  const trailer = `--- jgates ---\ninterpreter: ${outcome.interpreter ?? "(none)"}\nexit code: ${outcome.exitCode ?? "(none)"}\nduration ms: ${outcome.durationMs}\n`;
  const failure = outcome.kind === "failure" ? `bridge failure: ${outcome.code}: ${outcome.message}\n` : "";
  fs.appendFileSync(stderrLog, `${trailer}${failure}`);

  const normalized = normalizeBridge(outcome, plans);
  return { ...normalized, logs: [rel(context.runDir, stdoutLog), rel(context.runDir, stderrLog)], outputs: [rel(context.runDir, outputDir)] };
}
