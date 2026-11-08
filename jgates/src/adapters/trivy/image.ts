// Trivy final-image mode (Infrastructure/images): `trivy image` over a saved image tarball (--input) or an image
// reference, with the normalized results of the same report parser the filesystem mode uses. The scan needs the
// vulnerability database (network, declared). A missing Trivy is a structured state, never a clean result: the
// executable is `JGATES_TRIVY`, `trivy` on the PATH, or the quality sidecar image through the container runtime.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SIDECAR_IMAGE } from "../container-scanner/image.js";
import { type ScannerFinding } from "../container-scanner/index.js";
import { parseTrivyReport } from "./normalize.js";

export type TrivyImageTarget = { tarball: string } | { reference: string };

export type TrivyImageState =
  | { state: "completed"; findings: ScannerFinding[]; reportedVersion: string | null; network: true; runner: "native" | "container" }
  | { state: "missing-tool"; reason: string; tried: string[]; network: true }
  | { state: "error"; reason: string; network: true };

export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** spawn error code (ENOENT when the executable does not exist). */
  errorCode?: string | undefined;
}

export type ProcessRunner = (executable: string, args: string[]) => ProcessResult;

export interface TrivyImageOptions {
  env?: NodeJS.ProcessEnv;
  /** Replaces the process spawn (tests). */
  run?: ProcessRunner;
  /** Image of the container fallback (default: the quality sidecar). */
  image?: string;
  timeoutMs?: number;
}

const COMMON = ["--format", "json", "--exit-code", "0", "--skip-version-check", "--disable-telemetry", "--no-progress"];

/** Arguments of `trivy image` for the target; the tarball path is the one the process sees. */
export function trivyImageArgs(target: TrivyImageTarget, tarballPath?: string): string[] {
  return "tarball" in target ? ["image", ...COMMON, "--input", tarballPath ?? target.tarball] : ["image", ...COMMON, target.reference];
}

function spawnRunner(timeoutMs: number): ProcessRunner {
  return (executable, args) => {
    const r = spawnSync(executable, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", errorCode: r.error ? ((r.error as NodeJS.ErrnoException).code ?? "ERROR") : undefined };
  };
}

function interpret(result: ProcessResult, runner: "native" | "container", cwd: string): TrivyImageState | null {
  if (result.errorCode !== undefined || result.status !== 0) return null;
  const parsed = parseTrivyReport(result.stdout, { version: null, cwd, capabilities: ["dependencies"] });
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
  return { state: "completed", findings: parsed.findings, reportedVersion: parsed.reportedVersion ?? null, network: true, runner };
}

/**
 * Scans a built image (tarball saved with `docker save`/`skopeo`, or a reference) with Trivy. Returns normalized
 * findings, or the structured `missing-tool` state when neither a native Trivy nor the container runtime with the
 * sidecar image can run it. Never installs anything.
 */
export function scanImage(target: TrivyImageTarget, options: TrivyImageOptions = {}): TrivyImageState {
  const env = options.env ?? process.env;
  const run = options.run ?? spawnRunner(options.timeoutMs ?? 10 * 60 * 1000);
  if ("tarball" in target && !fs.existsSync(target.tarball)) return { state: "error", reason: `image tarball not found: ${target.tarball}`, network: true };
  const tried: string[] = [];

  const nativeExe = env.JGATES_TRIVY && env.JGATES_TRIVY !== "" ? env.JGATES_TRIVY : "trivy";
  tried.push(nativeExe);
  const native = run(nativeExe, trivyImageArgs(target));
  if (native.errorCode === undefined) {
    return interpret(native, "native", "/") ?? { state: "error", reason: `trivy exited with ${native.status ?? "-"}: ${native.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? ""}`, network: true };
  }

  const runtime = env.JGATES_CONTAINER_RUNTIME && env.JGATES_CONTAINER_RUNTIME !== "" ? env.JGATES_CONTAINER_RUNTIME : "docker";
  tried.push(`${runtime} run ${options.image ?? SIDECAR_IMAGE}`);
  const mount = "tarball" in target ? path.dirname(path.resolve(target.tarball)) : null;
  const inside = "tarball" in target ? `/input/${path.basename(target.tarball)}` : undefined;
  const containerArgs = [
    "run",
    "--rm",
    "--label",
    "jproject.project=jgates",
    ...(mount ? ["-v", `${mount}:/input:ro`] : []),
    options.image ?? SIDECAR_IMAGE,
    "trivy",
    ...trivyImageArgs(target, inside),
  ];
  const container = run(runtime, containerArgs);
  if (container.errorCode !== undefined) {
    return { state: "missing-tool", reason: `Trivy is not available: neither ${nativeExe} nor ${runtime} could be started`, tried, network: true };
  }
  // The runtime exists but the daemon or the image does not: still a missing tool, with the runtime's own words.
  if (container.status !== 0 && container.stdout.trim() === "") {
    const last = container.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? `exit ${container.status ?? "-"}`;
    return { state: "missing-tool", reason: `Trivy could not run in ${options.image ?? SIDECAR_IMAGE}: ${last}`, tried, network: true };
  }
  return interpret(container, "container", "/") ?? { state: "error", reason: `trivy exited with ${container.status ?? "-"}`, network: true };
}

