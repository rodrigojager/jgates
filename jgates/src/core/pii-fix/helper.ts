// The helper container (ADR-0004): the built-in PII detector and the structured TOML editing are tools of the JGates tools
// image, so on a machine outside the image they run in one short container (`org.jgates.kind=helper`, no network, the
// step contract) that gets its input on standard input and prints one JSON document. Nothing from the host is mounted:
// the files to scan travel as a tar stream (base64 text, after one line with the request), so the helper never sees
// the project, only the content JGates chose to send, and the answer comes back on standard output. The host applies
// whatever the answer proposes, after the preview, itself.
import { stepUser } from "../runner/container.js";
import {
  engineLabels,
  engineRuntime,
  runInEngine,
  runInEngineSync,
  toolsImageReference,
  type EngineContext,
  type EngineRunSpec,
} from "../engine/index.js";
import { IMAGE_SIDECAR_PYTHON } from "../bridge/index.js";
import { readVersion } from "../../cli/version.js";

export const HELPER_WORK_DIR = "/tmp/work";
export const HELPER_REQUEST_FILE = "/tmp/req.json";

/** What the helper can be: unavailable (no engine, no image, no daemon) with the reason, or the output of the run. */
export type HelperOutcome =
  | { kind: "ran"; stdout: string; stderr: string; exitCode: number | null; durationMs: number }
  | { kind: "timeout"; durationMs: number }
  | { kind: "unavailable"; reason: string };

export interface HelperFile {
  /** Path relative to the root of the archive, forward slashes. */
  path: string;
  bytes: Buffer;
}

// ---- the tar stream (ustar with GNU long names, in memory) -----------------------------------------------------------

const BLOCK = 512;
const octal = (value: number, width: number): string => Math.max(0, Math.floor(value)).toString(8).padStart(width - 1, "0") + "\0";

function put(header: Buffer, offset: number, text: string, width: number): void {
  Buffer.from(text, "utf8").copy(header, offset, 0, width);
}

function tarHeader(name: string, type: string, size: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  put(block, 0, name, 100);
  put(block, 100, octal(0o644, 8), 8);
  put(block, 108, octal(10001, 8), 8);
  put(block, 116, octal(10001, 8), 8);
  put(block, 124, octal(size, 12), 12);
  put(block, 136, octal(0, 12), 12);
  block.fill(0x20, 148, 156);
  put(block, 156, type, 1);
  put(block, 257, "ustar\0", 6);
  put(block, 263, "00", 2);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(block, 148, sum.toString(8).padStart(6, "0") + "\0 ", 8);
  return block;
}

const padding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

/** A tar archive of regular files; every file is mode 0644 and carries no time. */
export function tarOf(files: readonly HelperFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    let name = file.path;
    if (Buffer.byteLength(name) > 100) {
      const data = Buffer.from(name + "\0", "utf8");
      parts.push(tarHeader("././@LongLink", "L", data.length), data, Buffer.alloc(padding(data.length)));
      name = Buffer.from(name, "utf8").subarray(0, 99).toString("utf8").replace(/�+$/, "");
    }
    parts.push(tarHeader(name, "0", file.bytes.length), file.bytes, Buffer.alloc(padding(file.bytes.length)));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

// ---- the container ------------------------------------------------------------------------------------------------------

/** The script of a PII/TOML helper that reads a request line and a base64 tar: `sh -c <script> <python>`. */
const PII_SCRIPT = [
  "set -e",
  "IFS= read -r request",
  `mkdir -p ${HELPER_WORK_DIR}`,
  `printf '%s' "$request" > ${HELPER_REQUEST_FILE}`,
  `base64 -d | tar -x -C ${HELPER_WORK_DIR}`,
  `exec "$0" -m quality_sidecar bridge < ${HELPER_REQUEST_FILE}`,
].join("\n");

let cachedVersion: string | null = null;
const version = (): string => (cachedVersion ??= readVersion());

function contextOf(env: NodeJS.ProcessEnv): EngineContext {
  return { runtime: engineRuntime(env), runnerOptions: { parentEnv: env } };
}

function specOf(env: NodeJS.ProcessEnv, command: string[], stdin: string, timeoutMs: number, tmpfsMb: number): EngineRunSpec {
  return {
    image: toolsImageReference(env),
    command,
    labels: engineLabels({ kind: "helper", version: version() }),
    network: "none",
    user: stepUser(),
    resources: { memoryMb: 1024, cpus: 2, pids: 256, tmpfsMb },
    timeoutMs,
    stdin,
  };
}

const ENGINE_TROUBLE = /Cannot connect|daemon|Unable to find image|No such image|pull access denied|image .* not found|executable file not found|error during connect/i;

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 300) ?? "";
}

function outcomeOf(result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; spawnError: { code: string; message: string } | null }, durationMs: number): HelperOutcome {
  if (result.spawnError) return { kind: "unavailable", reason: `the container engine could not be started (${result.spawnError.code})` };
  if (result.timedOut) return { kind: "timeout", durationMs };
  // The runtime itself failed (125-127) or the engine/image is not there: the helper never ran.
  if (result.stdout.trim() === "" && result.exitCode !== 0 && (result.exitCode === 125 || ENGINE_TROUBLE.test(result.stderr))) {
    return { kind: "unavailable", reason: lastLine(result.stderr) || `the container engine answered with exit code ${result.exitCode ?? "-"}` };
  }
  return { kind: "ran", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationMs };
}

/** Request line + base64 tar: the standard input of the PII helper. */
export function piiInput(request: unknown, files: readonly HelperFile[]): string {
  return `${JSON.stringify(request)}\n${tarOf(files).toString("base64")}\n`;
}

/** Runs the PII bridge of the image's sidecar over `files` (the request's `target` is HELPER_WORK_DIR). */
export async function runPiiHelper(request: unknown, files: readonly HelperFile[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<HelperOutcome> {
  const total = files.reduce((sum, f) => sum + f.bytes.length, 0);
  const tmpfsMb = Math.min(4096, Math.max(256, Math.ceil((total * 1.2) / (1024 * 1024)) + 64));
  const spec = { ...specOf(env, ["sh", "-c", PII_SCRIPT, IMAGE_SIDECAR_PYTHON], piiInput(request, files), timeoutMs, tmpfsMb), workdir: "/tmp" };
  const started = Date.now();
  const result = await runInEngine(spec, contextOf(env));
  return outcomeOf(result, Date.now() - started);
}

/** Runs the sidecar's tomlkit helper: the request document in, the response document out. */
export function runTomlHelper(request: unknown, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): HelperOutcome {
  const spec = { ...specOf(env, [IMAGE_SIDECAR_PYTHON, "-m", "quality_sidecar.toml_edit"], JSON.stringify(request), timeoutMs, 64), workdir: "/tmp" };
  const started = Date.now();
  const result = runInEngineSync(spec, contextOf(env));
  return outcomeOf(result, Date.now() - started);
}
