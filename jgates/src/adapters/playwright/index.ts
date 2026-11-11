// playwright adapter: the e2e tests of a component with Playwright Test (TypeScript/JavaScript) or pytest-playwright
// (Python), in the step container of the tools image on the network of the run's compose services. The runner and the
// browsers are the project's (its dependency volume; Chromium from the toolchain volume, fetched for the installed
// Playwright version by the deps phase); the application under test is the services target, handed over as BASE_URL
// (Playwright Test configurations read process.env.BASE_URL) or --base-url (pytest-playwright). Without a services
// section the check is SERVICES_REQUIRED: the plan reports it as not applicable here with the action to set the services
// up, and it never runs nor blocks. Each failing test is a located, blocking finding; a report that is missing or an
// exit code the report does not explain is an error stage, never a pass.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { contentHash } from "../../core/ids/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { findOnPath } from "../../core/runner/path-lookup.js";
import { stepMode } from "../../core/runner/in-image.js";
import { inImageOverride } from "../../core/tools-image/catalogue.js";
import type { AdapterContext, AdapterOutput, ResultFinding, ResultMetric } from "../../core/run/types.js";
import {
  AREA,
  RUN_DIR,
  WORKSPACE,
  checkTarget,
  componentDirOf,
  instanceBody,
  isRec,
  readJsonFile,
  readText,
  runInstance,
  servicesOf,
  servicesRequiredReason,
  sha256File,
  tail,
  workspaceRelative,
  type KitContract,
} from "./kit.js";
import { playwrightManifest } from "./manifest.js";
import { parsePlaywrightReport, parsePytestJunit, type E2eReading } from "./normalize.js";

export { playwrightManifest } from "./manifest.js";
export { parsePlaywrightReport, parsePytestJunit } from "./normalize.js";

const ADAPTER_ID = playwrightManifest.id;
const RUNNERS = ["playwright-test", "pytest"] as const;
export type E2eRunner = (typeof RUNNERS)[number];
const PW_CONFIG = /^playwright\.config\.(?:ts|js|mjs|cjs|mts|cts)$/;
const NODE_PACKAGES = ["@playwright/test"];
/** Findings listed per run; the metrics count every test. */
const MAX_FINDINGS = 200;

interface E2eContract extends KitContract {
  runner: E2eRunner | null;
  /** The report the runner writes, relative to the instance's output folder. */
  report: string;
  target?: string;
  service?: { name: string; port: number; path: string } | null;
}

/** Folders from `from` up to `top` (inclusive), nearest first. */
export function ancestors(from: string, top: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(from);
  const stop = path.resolve(top);
  for (let i = 0; i < 32; i++) {
    out.push(dir);
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir || path.relative(stop, parent).startsWith("..")) break;
    dir = parent;
  }
  return out;
}

/** The package.json up the tree that declares the package, with the version its package-lock pins (when there is one). */
export function declaredNodePackage(scanDir: string, workspace: string, names: readonly string[]): { name: string; version: string | null } | null {
  for (const dir of ancestors(scanDir, workspace)) {
    const pkg = readJsonFile(path.join(dir, "package.json"));
    if (!pkg) continue;
    const name = names.find((n) => ["devDependencies", "dependencies", "optionalDependencies"].some((k) => isRec(pkg[k]) && Object.prototype.hasOwnProperty.call(pkg[k], n)));
    if (!name) continue;
    const lock = readJsonFile(path.join(dir, "package-lock.json"));
    const packages = lock && isRec(lock.packages) ? lock.packages : null;
    const entry = packages && isRec(packages[`node_modules/${name}`]) ? (packages[`node_modules/${name}`] as Record<string, unknown>) : null;
    return { name, version: entry && typeof entry.version === "string" ? entry.version : null };
  }
  return null;
}

const PY_DEP_FILES = ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "requirements-test.txt", "setup.cfg", "Pipfile"];

/** Whether the component's Python dependency files name a distribution, and the version an `==` pin gives it. */
export function declaredPythonPackage(scanDir: string, name: string): { version: string | null } | null {
  const re = new RegExp(`(?:^|["'\\s])${name.replace(/[-_.]/g, "[-_.]")}(?![\\w.-])\\s*(?:\\[[^\\]]*\\])?\\s*(?:==\\s*([0-9][\\w.]*))?`, "im");
  let found = false;
  for (const f of PY_DEP_FILES) {
    const text = readText(path.join(scanDir, f));
    if (text === null) continue;
    const m = re.exec(text);
    if (m) {
      found = true;
      if (m[1]) return { version: m[1] };
    }
  }
  return found ? { version: null } : null;
}

/** Which runner the component uses when the instance does not say. */
export function detectE2eRunner(scanDir: string, workspace: string): E2eRunner | null {
  let names: string[] = [];
  try {
    names = fs.readdirSync(scanDir);
  } catch {
    return null;
  }
  if (names.some((n) => PW_CONFIG.test(n)) || declaredNodePackage(scanDir, workspace, NODE_PACKAGES)) return "playwright-test";
  if (declaredPythonPackage(scanDir, "pytest-playwright")) return "pytest";
  return null;
}

interface E2eProbe {
  executable: string | null;
  prefix: string[];
  /** The Playwright version (its range is the manifest's), null when nothing pins it. */
  version: string | null;
  problem: "not_found" | null;
  detail: string;
}

/**
 * The runner without running or installing anything. The tools image does not carry Playwright: it is the project's
 * own dependency, installed into the dependency volume by the deps phase, so on the host the plan only asks whether the
 * component declares it, and the step runs `playwright` from the volume's node_modules/.bin (or `python -m pytest` of
 * the volume's environment). Inside the image JGATES_PLAYWRIGHT names another command (for both runners).
 */
export function probeE2e(runner: E2eRunner, env: NodeJS.ProcessEnv, workspace: string, scanDir: string): E2eProbe {
  const declared = runner === "pytest" ? declaredPythonPackage(scanDir, "pytest-playwright") : declaredNodePackage(scanDir, workspace, NODE_PACKAGES);
  const pinned = runner === "pytest" ? (declaredPythonPackage(scanDir, "playwright")?.version ?? null) : (declared?.version ?? null);
  const named = inImageOverride(env, "JGATES_PLAYWRIGHT");
  if (named !== null) {
    const abs = findOnPath(named, env);
    if (!abs) return { executable: null, prefix: [], version: null, problem: "not_found", detail: named };
    // The override stands for the command the step would run: `playwright`, or `python` with -m pytest after it.
    const after = runner === "pytest" ? ["-m", "pytest"] : [];
    return /\.(?:mjs|cjs|js)$/i.test(abs) ? { executable: process.execPath, prefix: [abs, ...after], version: pinned, problem: null, detail: "" } : { executable: abs, prefix: after, version: pinned, problem: null, detail: "" };
  }
  if (runner === "pytest") {
    if (!declared) return { executable: null, prefix: [], version: null, problem: "not_found", detail: "pytest-playwright" };
    return { executable: "python", prefix: ["-m", "pytest"], version: pinned, problem: null, detail: "" };
  }
  if (stepMode(env) === "in-image") {
    for (const dir of ancestors(scanDir, workspace)) {
      const cli = path.join(dir, "node_modules", "@playwright", "test", "cli.js");
      if (fs.existsSync(cli)) return { executable: process.execPath, prefix: [cli], version: (readJsonFile(path.join(path.dirname(cli), "package.json"))?.version as string | undefined) ?? pinned, problem: null, detail: "" };
    }
    return { executable: null, prefix: [], version: null, problem: "not_found", detail: "node_modules/@playwright/test" };
  }
  if (!declared) return { executable: null, prefix: [], version: null, problem: "not_found", detail: "package.json (devDependencies.@playwright/test)" };
  return { executable: "playwright", prefix: [], version: pinned, problem: null, detail: "" };
}

function planPlaywright(input: ExternalPlanInput): ExternalPlan {
  const t = translator(AREA);
  const { root, dir } = componentDirOf(input);
  const body = instanceBody(input);
  const configured = typeof body.e2eRunner === "string" && (RUNNERS as readonly string[]).includes(body.e2eRunner) ? (body.e2eRunner as E2eRunner) : null;
  const runner = configured ?? detectE2eRunner(dir, input.dir);
  const services = servicesOf(input);
  const target = checkTarget(body.target, services);
  const out = `${RUN_DIR}/outputs/${ADAPTER_ID}/${input.tool}`;
  const probe = runner ? probeE2e(runner, input.env, input.dir, dir) : null;
  // A plain URL target is the developer's own running application: it needs no compose services (and the network).
  const external = target.url !== null && target.service === null;
  const servicesRequired = services === null && !external;
  const component = typeof body.component === "string" ? body.component : null;

  let availability: ExternalPlan["availability"];
  let blocksPlan = false;
  if (body.e2eRunner !== undefined && configured === null) {
    availability = { status: "unavailable", reason: t("e2e_setting_runner", { tool: input.tool, value: String(body.e2eRunner), allowed: RUNNERS.join(", ") }) };
    blocksPlan = true;
  } else if (target.problem !== null) {
    availability = { status: "unavailable", reason: t("checks_setting_target", { tool: input.tool, value: target.problem }) };
    blocksPlan = true;
  } else if (servicesRequired) availability = { status: "unavailable", reason: servicesRequiredReason() };
  else if (runner === null || probe === null) availability = { status: "unavailable", reason: t("e2e_no_runner", { dir: root ?? "." }) };
  else if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("e2e_missing", { runner, detail: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, playwrightManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: "playwright", version: probe.version, range: playwrightManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else availability = { status: "available", reason: null };

  const urlEnv: Record<string, string> = target.url ? { BASE_URL: target.url } : {};
  const report = runner === "pytest" ? "junit.xml" : "report.json";
  const args =
    runner === "pytest"
      ? ["-p", "no:cacheprovider", `--junitxml=${out}/junit.xml`, "-o", "junit_family=xunit2", `--output=${out}/test-results`, "--browser", "chromium", ...(target.url ? ["--base-url", target.url] : [])]
      : ["test", "--reporter=json", `--output=${out}/test-results`];
  const env: Record<string, string> =
    runner === "pytest" ? { CI: "1", PYTHONDONTWRITEBYTECODE: "1", NO_COLOR: "1", ...urlEnv } : { CI: "1", PLAYWRIGHT_JSON_OUTPUT_NAME: `${out}/report.json`, NO_COLOR: "1", FORCE_COLOR: "0", ...urlEnv };
  const configFiles = new Map<string, string | null>();
  try {
    for (const n of fs.readdirSync(dir)) if (PW_CONFIG.test(n) || n === "pytest.ini" || n === "conftest.py") configFiles.set(root ? `${root}/${n}` : n, sha256File(path.join(dir, n)));
  } catch {
    // no component folder: nothing to hash
  }
  const contract: E2eContract = {
    component,
    root,
    runner,
    report,
    ...(servicesRequired ? { servicesRequired: true } : {}),
    // A target (named service or URL) is recorded like the runtime checks' one: the services selection reads it.
    ...(target.url ? { target: target.url, service: target.service } : {}),
  };
  const conditions = [t("e2e_condition_executes")];
  if (target.url) conditions.push(t("e2e_condition_target", { url: target.url }));
  else if (!servicesRequired) conditions.push(t("e2e_condition_no_target"));
  return {
    label: t("e2e_label", { runner: runner === "pytest" ? "pytest-playwright" : "Playwright Test" }),
    command: { executable: probe?.executable ?? (runner === "pytest" ? "python" : "playwright"), args: [...(probe?.prefix ?? []), ...args], cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE, env, stdin: null },
    runtime: { name: "native", interpreter: probe?.executable ?? null, available: probe?.executable !== null && probe?.problem === null },
    toolVersion: probe?.version ?? null,
    configFiles: [...configFiles].map(([file, sha256]) => ({ file, sha256 })),
    availability,
    blocksPlan,
    network: external,
    limitations: [t("e2e_limitation")],
    conditions,
    output: { format: "json", schema: null },
    imageTool: runner === "pytest" ? "python" : "node",
    ...(servicesRequired ? { requires: "services" as const } : {}),
    contract,
    effects: { executesProjectCode: true },
  };
}

async function runPlaywright(context: AdapterContext, planDoc: Plan, tool: string): Promise<AdapterOutput> {
  return runInstance<E2eContract>(ADAPTER_ID, context, planDoc, tool, async (run) => {
    const t = translator(AREA);
    const executed = await run.exec(0);
    const stop = run.stopped(executed);
    if (stop) return stop;
    const { result, command } = executed;
    const runner = run.contract.runner ?? "playwright-test";
    const reportFile = path.join(run.outDir, run.contract.report || (runner === "pytest" ? "junit.xml" : "report.json"));
    const workspaceView = run.view(context.workspacePath);
    const cwdView = run.view(command.cwd);
    const reading: E2eReading =
      runner === "pytest"
        ? parsePytestJunit(readText(reportFile), command.cwd, context.workspacePath)
        : parsePlaywrightReport(readText(reportFile), (abs) => workspaceRelative(abs, workspaceView, cwdView));
    const native = `exit ${result.exitCode ?? "-"}`;
    const tool$ = runner === "pytest" ? "pytest-playwright" : "Playwright Test";
    const failed = reading.cases.filter((c) => c.status === "failed");
    const untrusted = (reason: string): AdapterOutput => run.all("error", reason, { interpreted: false, nativeStatus: native });
    if (!reading.ok || result.truncated) {
      return untrusted(t("checks_no_report", { tool: tool$, code: result.exitCode ?? "-", detail: `${result.truncated ? "output truncated" : (reading.problem ?? "")} ${tail(result.stderr || result.stdout)}`.trim() || "-" }));
    }
    const noTests = reading.cases.filter((c) => !c.suite).length === 0;
    // pytest exits 5 when it collected nothing; Playwright exits 0 or 1 with an empty report.
    const explained = result.exitCode === 0 ? failed.length === 0 : result.exitCode === 1 ? failed.length > 0 || (runner === "playwright-test" && noTests) : runner === "pytest" && result.exitCode === 5 && noTests;
    if (!explained) return untrusted(t("checks_exit_mismatch", { tool: tool$, code: result.exitCode ?? "-", failed: failed.length, detail: tail(result.stderr) || "-" }));

    const item = run.items[0] as Plan["groups"]["willRun"][number];
    const component = run.contract.component;
    const scope = component ? "component" : "workspace";
    const withComponent = component ? { component } : {};
    const count = (id: string, key: string, value: number): ResultMetric => ({ id, label: t(key), unit: "count", value, ...withComponent, scope, origin: ADAPTER_ID });
    const cases = reading.cases.filter((c) => !c.suite);
    const passed = cases.filter((c) => c.status === "passed").length;
    const flaky = cases.filter((c) => c.status === "flaky").length;
    const skipped = cases.filter((c) => c.status === "skipped").length;
    const executedCount = cases.length - skipped;
    const metrics: ResultMetric[] = [
      count("tests.e2e.executed", "e2e_metric_executed", executedCount),
      count("tests.e2e.passed", "e2e_metric_passed", passed + flaky),
      count("tests.e2e.failed", "e2e_metric_failed", failed.length),
      count("tests.e2e.flaky", "e2e_metric_flaky", flaky),
      count("tests.e2e.skipped", "e2e_metric_skipped", skipped),
    ];
    if (noTests && failed.length === 0) {
      return { ...run.base(), stages: run.items.map((i) => run.stage(i, "completed", t("e2e_no_tests", { tool: tool$ }), { interpreted: false, nativeStatus: native })), findings: [], metrics };
    }
    const findings: ResultFinding[] = failed.slice(0, MAX_FINDINGS).map((c) => ({
      stageId: item.id,
      tool: ADAPTER_ID,
      ...(run.version ? { toolVersion: run.version } : {}),
      ruleId: c.suite ? "playwright.e2e-error" : "playwright.e2e-failed",
      category: "tests",
      severity: "error",
      normalizedSeverity: "high",
      message: t(c.suite ? "e2e_finding_error" : "e2e_finding_failed", { name: c.name, message: c.message || "-" }),
      ...(c.file ? { location: { path: c.file, ...(c.line !== null ? { line: c.line } : {}) } } : {}),
      fingerprint: contentHash({ tool: ADAPTER_ID, rule: c.suite ? "error" : "failed", test: c.name, file: c.file }),
      origin: ADAPTER_ID,
      blocking: true,
      blockingReason: "blocking-tool",
      waived: false,
    }));
    const reason = t("e2e_reason", { tool: tool$, version: run.version ?? "?", executed: executedCount, failed: failed.length, flaky, skipped, target: (run.contract.target as string | undefined) ?? "-" });
    return {
      ...run.base(),
      stages: run.items.map((i) => run.stage(i, "completed", reason, { blockingViolations: findings.length, findings: findings.length, nativeStatus: native })),
      findings,
      metrics,
    };
  });
}

export const playwrightAdapter: ExternalAdapter = {
  manifest: playwrightManifest,
  plan: planPlaywright,
  run: runPlaywright,
};
