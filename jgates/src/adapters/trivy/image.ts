// Trivy final-image mode (Infrastructure/images): `trivy image` over a saved image tarball (--input) or an image
// reference, with the normalized results of the same report parser the filesystem mode uses. The scan reads the
// vulnerability database from the jgates-data volume (a registry reference still needs the network to be read). Trivy is the tools image's: the run starts it in the step container like
// every other tool (natively when JGates itself runs in the image), and a launch that cannot happen (no engine, no
// image) is a structured state, never a clean result.
import fs from "node:fs";
import { parseTrivyReport } from "./normalize.js";
import { type ScannerFinding } from "../container-scanner/index.js";

export type TrivyImageTarget = { tarball: string } | { reference: string };

export type TrivyImageState =
  | { state: "completed"; findings: ScannerFinding[]; reportedVersion: string | null; network: true; runner: "container" }
  | { state: "missing-tool"; reason: string; tried: string[]; network: true }
  | { state: "error"; reason: string; network: true };

export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** spawn error code (ENOENT when the executable does not exist, HOST_EXECUTION_REFUSED when no step container could start). */
  errorCode?: string | undefined;
  /** The text of the spawn error. */
  errorMessage?: string | undefined;
}

/** Starts `trivy` with the arguments (the run's runner: a step container) and says how it ended. */
export type ProcessRunner = (args: string[]) => Promise<ProcessResult>;

export interface TrivyImageOptions {
  run: ProcessRunner;
  /** The folder Trivy keeps its cache in (a place the step may write: the instance's output folder). */
  cacheDir?: string;
}

// The vulnerability database is the read-only jgates-data volume (core/data): nothing is downloaded, and the scan cache
// is kept in memory because the database folder cannot be written.
const COMMON = ["--format", "json", "--exit-code", "0", "--skip-db-update", "--skip-check-update", "--skip-java-db-update", "--offline-scan", "--cache-backend", "memory", "--skip-version-check", "--disable-telemetry", "--no-progress"];

/** Arguments of `trivy image` for the target; the reference (or the tarball behind --input) closes the list. */
export function trivyImageArgs(target: TrivyImageTarget, cacheDir?: string): string[] {
  const cache = cacheDir ? ["--cache-dir", cacheDir] : [];
  return "tarball" in target ? ["image", ...COMMON, ...cache, "--input", target.tarball] : ["image", ...COMMON, ...cache, target.reference];
}

function interpret(result: ProcessResult): TrivyImageState | null {
  if (result.errorCode !== undefined || result.status !== 0) return null;
  const parsed = parseTrivyReport(result.stdout, { version: null, cwd: "/", capabilities: ["dependencies"] });
  if (!parsed.ok) return { state: "error", reason: `unreadable Trivy report: ${parsed.problem ?? "unknown"}`, network: true };
  // The report must be about an image: a filesystem report proves nothing about the final image.
  const type = (() => {
    try {
      return (JSON.parse(result.stdout) as { ArtifactType?: unknown }).ArtifactType;
    } catch {
      return undefined;
    }
  })();
  if (type !== "container_image") return { state: "error", reason: `the report is not of a container image (ArtifactType ${JSON.stringify(type ?? null)})`, network: true };
  return { state: "completed", findings: parsed.findings, reportedVersion: parsed.reportedVersion ?? null, network: true, runner: "container" };
}

/**
 * Scans a built image (tarball saved with `docker save`/`skopeo`, or a reference) with Trivy in the step container.
 * Returns normalized findings, or the structured `missing-tool` state when no step container could start. Never
 * installs anything.
 */
export async function scanImage(target: TrivyImageTarget, options: TrivyImageOptions): Promise<TrivyImageState> {
  if ("tarball" in target && !fs.existsSync(target.tarball)) return { state: "error", reason: `image tarball not found: ${target.tarball}`, network: true };
  const result = await options.run(trivyImageArgs(target, options.cacheDir));
  if (result.errorCode !== undefined) {
    return { state: "missing-tool", reason: `Trivy could not be started: ${result.errorCode}${result.errorMessage ? ` (${result.errorMessage})` : ""}`, tried: ["trivy"], network: true };
  }
  // The engine answered but the container did not run Trivy (a runtime failure): still a missing tool, with its words.
  if (result.status !== null && result.status >= 125 && result.status <= 127 && result.stdout.trim() === "") {
    const last = result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? `exit ${result.status}`;
    return { state: "missing-tool", reason: `Trivy could not run in the tools image: ${last}`, tried: ["trivy"], network: true };
  }
  return interpret(result) ?? { state: "error", reason: `trivy exited with ${result.status ?? "-"}: ${result.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? ""}`, network: true };
}
