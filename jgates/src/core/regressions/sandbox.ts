// The isolated execution of a test file: a fixture folder (fixture.ts) and a Node.js child under the permission model
// (`--permission`): it may read only the fixture and the dependencies folder it is given, and it may not write files,
// open network connections, start processes or workers. The Semantic modules use it to observe a reproducer or a
// proposed regression test (post-patch validation, `jgates regressions validate`); what a test prints is masked before it
// is kept or shown. A runtime whose permission model does not restrict the network is refused (Node.js 25 or later):
// nothing is then executed, and nothing may be claimed as observed.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { emptyCounts, maskText, strictMaskRules } from "../../adapters/semantic-gate/mask.js";

/** Longest run of one test file (ms). */
export const SANDBOX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 4_000;

export interface SandboxSupport {
  ok: boolean;
  /** The Node.js executable used (JGATES_SANDBOX_NODE or this process's). */
  node: string;
  reason: string | null;
}

/** passed: every test passed. failed: at least one test failed. error: the file did not run to a verdict (load error, no test, timeout). not-run: nothing was executed. */
export type SandboxOutcome = "passed" | "failed" | "error" | "not-run";

export interface SandboxRun {
  /** Whether a process was started and ran the file (only then can the outcome be observed). */
  executed: boolean;
  outcome: SandboxOutcome;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  tests: { total: number; pass: number; fail: number; cancelled: number } | null;
  /** The test file, relative to the fixture. */
  file: string;
  /** stdout then stderr, masked, with the fixture path replaced by <fixture>, truncated. */
  output: string;
  reason: string | null;
  /** The permission flags of the run (what the process could do). */
  permissions: { read: string[]; write: false; network: false; childProcess: false };
}

/** The Node.js executable of the sandbox. */
export function sandboxNode(env: NodeJS.ProcessEnv = process.env): string {
  return env.JGATES_SANDBOX_NODE && env.JGATES_SANDBOX_NODE !== "" ? env.JGATES_SANDBOX_NODE : process.execPath;
}

/** The environment of a sandboxed child: only what a runtime needs to start, never credentials or NODE_OPTIONS. */
export function sandboxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { NODE_ENV: "test", NO_COLOR: "1" };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "TMPDIR", "LANG"]) if (env[key] !== undefined) out[key] = env[key];
  return out;
}

const supportCache = new Map<string, SandboxSupport>();

/** Whether this runtime can sandbox a test (permission model restricting files, network and processes). */
export function sandboxSupport(env: NodeJS.ProcessEnv = process.env): SandboxSupport {
  const node = sandboxNode(env);
  const cached = supportCache.get(node);
  if (cached) return cached;
  const probe = "process.exit(process.permission && !process.permission.has('net') && !process.permission.has('child') && !process.permission.has('fs.write') ? 0 : 3)";
  const r = spawnSync(node, ["--permission", "-e", probe], { encoding: "utf8", timeout: 15_000, windowsHide: true, env: sandboxEnv(env) });
  let support: SandboxSupport;
  if (r.error) support = { ok: false, node, reason: `the sandbox runtime ${node} could not start (${(r.error as NodeJS.ErrnoException).code ?? r.error.message})` };
  else if (r.status === 0) support = { ok: true, node, reason: null };
  else if (r.status === 3) support = { ok: false, node, reason: `the permission model of ${node} does not restrict the network, files and processes (Node.js 25 or later is needed)` };
  else support = { ok: false, node, reason: `the runtime ${node} refused the permission model (exit ${String(r.status)}): ${String(r.stderr ?? "").trim().slice(0, 200)}` };
  supportCache.set(node, support);
  return support;
}

function maskOutput(text: string, fixtureDir: string): string {
  const rules = strictMaskRules();
  // The fixture's location (as printed, with forward slashes, or escaped in TAP's YAML) says nothing about the test.
  let withoutPaths = text;
  for (const form of [fixtureDir.split("\\").join("\\\\"), fixtureDir, fixtureDir.split(path.sep).join("/")]) withoutPaths = withoutPaths.split(form).join("<fixture>");
  const masked = maskText(withoutPaths, emptyCounts(rules), rules);
  return masked.length > MAX_OUTPUT ? `${masked.slice(0, MAX_OUTPUT)}\n... (${masked.length - MAX_OUTPUT} more characters)` : masked;
}

/** The TAP summary of node:test (`# tests N`, `# pass N`...), or null when the file never reached it. */
export function tapSummary(stdout: string): SandboxRun["tests"] {
  const num = (name: string): number | null => {
    const m = new RegExp(`^# ${name} (\\d+)\\s*$`, "m").exec(stdout);
    return m ? Number(m[1]) : null;
  };
  const total = num("tests");
  if (total === null) return null;
  return { total, pass: num("pass") ?? 0, fail: num("fail") ?? 0, cancelled: num("cancelled") ?? 0 };
}

/**
 * Runs one node:test file of a fixture in the sandbox. `read` lists extra folders the process may read (the real
 * dependencies folder behind the fixture's node_modules link).
 */
export function runSandboxedTest(fixtureDir: string, file: string, options: { env?: NodeJS.ProcessEnv; read?: string[]; timeoutMs?: number } = {}): SandboxRun {
  const env = options.env ?? process.env;
  const read = [fixtureDir, ...(options.read ?? [])];
  const permissions = { read: read.map((r) => (r === fixtureDir ? "<fixture>" : r)), write: false as const, network: false as const, childProcess: false as const };
  const support = sandboxSupport(env);
  const notRun = (reason: string): SandboxRun => ({ executed: false, outcome: "not-run", exitCode: null, timedOut: false, durationMs: 0, tests: null, file, output: "", reason, permissions });
  if (!support.ok) return notRun(support.reason ?? "no sandbox");
  const args = ["--permission", ...read.map((r) => `--allow-fs-read=${path.join(r, "*")}`), "--test-reporter=tap", file];
  const started = Date.now();
  const r = spawnSync(support.node, args, { cwd: fixtureDir, env: sandboxEnv(env), encoding: "utf8", timeout: options.timeoutMs ?? SANDBOX_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const durationMs = Date.now() - started;
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (r.error && code !== "ETIMEDOUT") return notRun(`the sandbox process could not start (${code ?? r.error.message})`);
  const stdout = String(r.stdout ?? "");
  const output = maskOutput(`${stdout}${r.stderr ? `\n--- stderr ---\n${String(r.stderr)}` : ""}`, fixtureDir);
  const timedOut = code === "ETIMEDOUT" || (r.status === null && r.signal !== null);
  const tests = tapSummary(stdout);
  let outcome: SandboxOutcome;
  let reason: string | null = null;
  if (timedOut) {
    outcome = "error";
    reason = `the test did not finish within ${Math.round((options.timeoutMs ?? SANDBOX_TIMEOUT_MS) / 1000)} s`;
  } else if (!tests) {
    outcome = "error";
    reason = "the file did not run to a test verdict (it failed to load, or it is not a node:test file)";
  } else if (tests.total === 0) {
    outcome = "error";
    reason = "the file declares no test";
  } else if (tests.fail > 0) {
    outcome = "failed";
  } else if (r.status === 0 && tests.cancelled === 0) {
    outcome = "passed";
  } else {
    outcome = "error";
    reason = `no test failed but the run ended with exit ${String(r.status)}${tests.cancelled > 0 ? ` and ${tests.cancelled} cancelled test(s)` : ""}`;
  }
  return { executed: true, outcome, exitCode: r.status, timedOut, durationMs, tests, file, output, reason, permissions };
}
