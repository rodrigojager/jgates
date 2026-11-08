// Incorporation of a regression proposal into the project, the only way a model-proposed test becomes a Quality check.
// It needs the explicit approval (`jgates regressions incorporate <run>/<id> --approve`) and a fresh validation: the test
// runs in the sandbox against an isolated copy of the current working tree and must reach a verdict (pass or fail; a
// test that cannot load is refused). Then, and only then, it writes into the project:
//
//   .jgates/regressions/<file>                 the test, byte for byte as validated (its sha256 is recorded)
//   .jgates/regressions/manifest.json          every incorporated regression with its provenance and validation
//   .jgates/regressions/run.mjs                the runner Quality executes (no model, no network; checks the sha256)
//   .jgates/regressions/evidence.schema.json   the evidence contract of the check (generic-command json-file)
//   .jgates/templates/jgates-regressions.yml   one generic-command check per regression (capability unit)
//   jgates.yml                                 the template entry (activation always), added once
//
// Nothing is ever written to JGates' shipped packs or built-in templates: an incorporated regression belongs to the
// project that approved it. A later Quality run executes it like any other deterministic check, with no provider call.
import fs from "node:fs";
import path from "node:path";
import { parseDocument, stringify } from "yaml";
import { contentHash } from "../ids/index.js";
import { removeFixture, workspaceFiles, writeFixture } from "./fixture.js";
import { REGRESSIONS_DIR, findProposal, sha256, type ListedProposal, type RegressionProposal } from "./proposals.js";
import { runSandboxedTest, sandboxSupport, type SandboxRun, type SandboxSupport } from "./sandbox.js";

export const MANIFEST_FILE = `${REGRESSIONS_DIR}/manifest.json`;
export const RUNNER_FILE = `${REGRESSIONS_DIR}/run.mjs`;
export const EVIDENCE_SCHEMA_FILE = `${REGRESSIONS_DIR}/evidence.schema.json`;
export const TEMPLATE_ID = "jgates-regressions";
export const TEMPLATE_FILE = `.jgates/templates/${TEMPLATE_ID}.yml`;
export const ROOT_CONFIG = "jgates.yml";
export const REGRESSION_CAPABILITY = "unit";

export interface ValidationRecord {
  executedAt: string;
  sandbox: SandboxSupport;
  /** Files of the working tree copied into the isolated fixture. */
  fixtureFiles: number;
  run: SandboxRun;
  /** The test reached a verdict (passed or failed) in the sandbox. */
  usable: boolean;
  /** It failed on the current source (it shows the defect now), or the method observed it fail before a patch. */
  detectsDefect: boolean;
}

export interface IncorporatedRegression {
  /** The Quality check (tool instance) that runs it. */
  tool: string;
  file: string;
  runner: RegressionProposal["runner"];
  sha256: string;
  title: string;
  rationale: string;
  origin: RegressionProposal["origin"] & { proposal: string };
  /** What the proposing method observed itself (null: it never executed the test). */
  proposalExecution: Record<string, unknown> | null;
  validation: Omit<ValidationRecord, "run"> & { outcome: SandboxRun["outcome"]; tests: SandboxRun["tests"]; exitCode: number | null };
  incorporatedAt: string;
  approval: { explicit: true; command: string };
}

export interface RegressionManifest {
  schemaVersion: 1;
  kind: "jgates-regressions";
  regressions: IncorporatedRegression[];
}

const abs = (workspacePath: string, rel: string): string => path.join(workspacePath, ...rel.split("/"));

export function readManifest(workspacePath: string): RegressionManifest {
  try {
    const doc = JSON.parse(fs.readFileSync(abs(workspacePath, MANIFEST_FILE), "utf8")) as Partial<RegressionManifest>;
    if (Array.isArray(doc.regressions)) return { schemaVersion: 1, kind: "jgates-regressions", regressions: doc.regressions };
  } catch {
    // No manifest yet.
  }
  return { schemaVersion: 1, kind: "jgates-regressions", regressions: [] };
}

/** The Quality check name of a proposal (stable: the same proposal always maps to the same check). */
export const regressionTool = (ref: string): string => `regression-${contentHash({ ref }).replace(/^sha256:/, "").slice(0, 10)}`;

/** Runs a proposal's test in the sandbox against an isolated copy of the current working tree (writes nothing in it). */
export function validateProposal(workspacePath: string, listed: ListedProposal, options: { workDir: string; env?: NodeJS.ProcessEnv; now?: () => Date }): ValidationRecord {
  const env = options.env ?? process.env;
  const executedAt = (options.now ?? (() => new Date()))().toISOString();
  const support = sandboxSupport(env);
  const notRun = (reason: string, files = 0): ValidationRecord => ({
    executedAt,
    sandbox: support,
    fixtureFiles: files,
    run: { executed: false, outcome: "not-run", exitCode: null, timedOut: false, durationMs: 0, tests: null, file: `${REGRESSIONS_DIR}/${listed.proposal.file}`, output: "", reason, permissions: { read: [], write: false, network: false, childProcess: false } },
    usable: false,
    detectsDefect: false,
  });
  if (!support.ok) return notRun(support.reason ?? "no sandbox");
  const tree = workspaceFiles(workspacePath, env);
  if ("problem" in tree) return notRun(tree.problem);
  const rel = `${REGRESSIONS_DIR}/${listed.proposal.file}`;
  const files = [...tree.files.filter((f) => f.path !== rel), { path: rel, content: listed.proposal.content }];
  const dir = path.join(options.workDir, `validate-${process.pid}-${Date.now().toString(36)}`);
  try {
    const fixture = writeFixture(dir, files, { nodeModules: path.join(workspacePath, "node_modules") });
    const run = runSandboxedTest(fixture.dir, rel, { env, ...(fixture.dependencies ? { read: [fixture.dependencies] } : {}) });
    const before = (listed.proposal.execution as { before?: { outcome?: unknown } } | null)?.before?.outcome;
    const usable = run.executed && (run.outcome === "passed" || run.outcome === "failed");
    return { executedAt, sandbox: support, fixtureFiles: fixture.files, run, usable, detectsDefect: usable && (run.outcome === "failed" || before === "failed") };
  } finally {
    removeFixture(dir);
  }
}

/** The self-contained runner Quality executes for every incorporated regression (rewritten at each incorporation). */
export function runnerScript(): string {
  return `// Generated by JGates (jgates regressions incorporate); rewritten at each incorporation. It runs one incorporated
// regression test (node:test) and writes the evidence of the Quality check: no model is called, the test may not write
// files, use the network or start processes, and a test file whose sha256 differs from the approved one fails.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, "..", "..");
const [tool, outDir] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8"));
const entry = (manifest.regressions ?? []).find((r) => r.tool === tool);
fs.mkdirSync(outDir, { recursive: true });
const write = (doc) => fs.writeFileSync(path.join(outDir, "evidence.json"), JSON.stringify(doc, null, 2) + "\\n");
if (!entry) {
  write({ ok: false, tool, reason: "not in manifest.json", modelCalls: 0 });
  console.error("regression " + tool + " is not in .jgates/regressions/manifest.json");
  process.exit(1);
}
const file = path.join(here, entry.file);
const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\\r\\n/g, "\\n") : "";
const sha = crypto.createHash("sha256").update(text).digest("hex");
const read = [workspace];
const nm = path.join(workspace, "node_modules");
if (fs.existsSync(nm)) read.push(fs.realpathSync(nm));
const permission = spawnSync(process.execPath, ["--permission", "-e", "0"], { windowsHide: true }).status === 0;
const args = [...(permission ? ["--permission", ...read.map((r) => "--allow-fs-read=" + path.join(r, "*"))] : []), "--test-reporter=tap", file];
const env = { NODE_ENV: "test", NO_COLOR: "1" };
for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "TMPDIR", "LANG"]) if (process.env[k] !== undefined) env[k] = process.env[k];
const r = sha === entry.sha256 ? spawnSync(process.execPath, args, { cwd: workspace, env, encoding: "utf8", timeout: 120000, killSignal: "SIGKILL", windowsHide: true }) : null;
const num = (name) => {
  const m = r ? new RegExp("^# " + name + " (\\\\d+)\\\\s*$", "m").exec(r.stdout ?? "") : null;
  return m ? Number(m[1]) : null;
};
const tests = num("tests") === null ? null : { total: num("tests"), pass: num("pass") ?? 0, fail: num("fail") ?? 0 };
const ok = !!r && r.status === 0 && !!tests && tests.total > 0 && tests.fail === 0;
write({
  ok,
  tool,
  file: entry.file,
  title: entry.title,
  sha256: sha,
  expectedSha256: entry.sha256,
  sha256Matches: sha === entry.sha256,
  exitCode: r ? r.status : null,
  tests,
  sandboxed: permission,
  provenance: { ...entry.origin, incorporatedAt: entry.incorporatedAt },
  modelCalls: 0,
});
if (r) {
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
} else console.error("the test file changed since it was approved (sha256 " + sha + ", approved " + entry.sha256 + ")");
process.exit(ok ? 0 : 1);
`;
}

export const evidenceSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "JGates incorporated regression: evidence of one run",
  type: "object",
  required: ["ok", "tool", "sha256Matches", "tests", "modelCalls"],
  properties: {
    ok: { const: true },
    tool: { type: "string" },
    sha256Matches: { const: true },
    tests: { type: "object", required: ["total", "fail"], properties: { total: { type: "integer", minimum: 1 }, fail: { const: 0 } } },
    modelCalls: { const: 0 },
  },
};

/** The project template with one generic-command check per incorporated regression. */
export function templateText(manifest: RegressionManifest): string {
  const tools: Record<string, unknown> = {};
  for (const r of manifest.regressions) {
    tools[r.tool] = {
      adapter: "generic-command",
      enabled: true,
      capabilities: [REGRESSION_CAPABILITY],
      command: "node",
      args: [RUNNER_FILE, r.tool, "{outputDir}"],
      config: {
        effects: { readsCode: true, writesOutputs: true, mayChangeCode: false, executesProjectCode: true, usesNetwork: false },
        evidence: { kind: "json-file", file: "evidence.json", schema: EVIDENCE_SCHEMA_FILE },
        limitations: [
          `Generated regression ${r.file}: proposed by the Semantic run ${r.origin.runId} (${r.origin.method}, ${r.origin.proposal}), validated and incorporated ${r.incorporatedAt} by explicit approval; it runs without any model call.`,
        ],
      },
    };
  }
  const header = "# Generated by `jgates regressions incorporate`: one deterministic check per incorporated regression\n# (.jgates/regressions/manifest.json holds their provenance). Edit through that command.\n";
  return header + stringify({ schemaVersion: 1, id: TEMPLATE_ID, config: { tools } });
}

/** jgates.yml with the template entry added once (comments and layout kept); text null when it is already there. */
function withTemplateEntry(workspacePath: string): { text: string | null } | { problem: "NO_PROJECT_CONFIG" | "CONFIG_UNREADABLE" } {
  const file = abs(workspacePath, ROOT_CONFIG);
  if (!fs.existsSync(file)) return { problem: "NO_PROJECT_CONFIG" };
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  if (doc.errors.length > 0) return { problem: "CONFIG_UNREADABLE" };
  const value = doc.toJS() as Record<string, unknown> | null;
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) return { problem: "CONFIG_UNREADABLE" };
  const templates = value ? value.templates : undefined;
  if (templates !== undefined && templates !== null && !Array.isArray(templates)) return { problem: "CONFIG_UNREADABLE" };
  if (Array.isArray(templates) && templates.some((t) => t && typeof t === "object" && (t as { id?: unknown }).id === TEMPLATE_ID)) return { text: null };
  const entry = { id: TEMPLATE_ID, source: TEMPLATE_FILE, activation: "always" };
  if (Array.isArray(templates)) doc.addIn(["templates"], doc.createNode(entry));
  else doc.setIn(["templates"], doc.createNode([entry]));
  return { text: doc.toString() };
}

export type IncorporateCode = "APPROVAL_REQUIRED" | "PROPOSAL_NOT_FOUND" | "PROPOSAL_TAMPERED" | "ALREADY_INCORPORATED" | "FILE_EXISTS" | "NO_PROJECT_CONFIG" | "CONFIG_UNREADABLE" | "VALIDATION_NOT_EXECUTED" | "VALIDATION_UNUSABLE";

export type IncorporateResult =
  | { ok: true; regression: IncorporatedRegression; files: string[]; validation: ValidationRecord }
  | { ok: false; code: IncorporateCode; detail: string; validation?: ValidationRecord };

export interface IncorporateOptions {
  workspacePath: string;
  home: string;
  workspaceId: string;
  ref: string;
  /** The explicit approval; without it nothing is executed or written. */
  approve: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Incorporates one proposal after the explicit approval and a fresh, usable validation. */
export function incorporateProposal(options: IncorporateOptions): IncorporateResult {
  const { workspacePath } = options;
  const now = options.now ?? (() => new Date());
  if (!options.approve) return { ok: false, code: "APPROVAL_REQUIRED", detail: options.ref };
  const listed = findProposal(options.home, options.workspaceId, options.ref);
  if (!listed) return { ok: false, code: "PROPOSAL_NOT_FOUND", detail: options.ref };
  if (listed.tampered) return { ok: false, code: "PROPOSAL_TAMPERED", detail: options.ref };
  const manifest = readManifest(workspacePath);
  const tool = regressionTool(listed.ref);
  if (manifest.regressions.some((r) => r.tool === tool)) return { ok: false, code: "ALREADY_INCORPORATED", detail: tool };
  const testRel = `${REGRESSIONS_DIR}/${listed.proposal.file}`;
  if (fs.existsSync(abs(workspacePath, testRel))) return { ok: false, code: "FILE_EXISTS", detail: testRel };
  if (!fs.existsSync(abs(workspacePath, ROOT_CONFIG))) return { ok: false, code: "NO_PROJECT_CONFIG", detail: ROOT_CONFIG };
  const workDir = path.join(options.home, "workspaces", options.workspaceId, "regressions", "work");
  const validation = validateProposal(workspacePath, listed, { workDir, ...(options.env ? { env: options.env } : {}), now });
  if (!validation.run.executed) return { ok: false, code: "VALIDATION_NOT_EXECUTED", detail: validation.run.reason ?? "-", validation };
  if (!validation.usable) return { ok: false, code: "VALIDATION_UNUSABLE", detail: validation.run.reason ?? validation.run.outcome, validation };

  const { run, ...rest } = validation;
  const regression: IncorporatedRegression = {
    tool,
    file: listed.proposal.file,
    runner: listed.proposal.runner,
    sha256: sha256(listed.proposal.content),
    title: listed.proposal.title,
    rationale: listed.proposal.rationale,
    origin: { ...listed.proposal.origin, proposal: listed.proposal.id },
    proposalExecution: listed.proposal.execution,
    validation: { ...rest, outcome: run.outcome, tests: run.tests, exitCode: run.exitCode },
    incorporatedAt: now().toISOString(),
    approval: { explicit: true, command: `jgates regressions incorporate ${listed.ref} --approve` },
  };
  const next: RegressionManifest = { ...manifest, regressions: [...manifest.regressions, regression] };
  const config = withTemplateEntry(workspacePath);
  if ("problem" in config) return { ok: false, code: config.problem, detail: ROOT_CONFIG, validation };
  const files: string[] = [];
  const put = (rel: string, content: string): void => {
    fs.mkdirSync(path.dirname(abs(workspacePath, rel)), { recursive: true });
    fs.writeFileSync(abs(workspacePath, rel), content);
    files.push(rel);
  };
  put(testRel, listed.proposal.content);
  put(RUNNER_FILE, runnerScript());
  put(EVIDENCE_SCHEMA_FILE, `${JSON.stringify(evidenceSchema, null, 2)}\n`);
  put(MANIFEST_FILE, `${JSON.stringify(next, null, 2)}\n`);
  put(TEMPLATE_FILE, templateText(next));
  // The project configuration last: it references the files above only once they all exist.
  if (config.text !== null) put(ROOT_CONFIG, config.text);
  return { ok: true, regression, files, validation };
}
