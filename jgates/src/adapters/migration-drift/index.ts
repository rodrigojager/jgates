// migration-drift adapter: asks each framework whether the project's models and its migrations still agree, in the step
// container of the tools image on the network of the run's compose services (the database the framework connects to
// through tools.<id>.databaseUrl, handed over in DATABASE_URL or the variable tools.<id>.databaseUrlEnv names):
//   - Django: python manage.py makemigrations --check --dry-run --no-input (exit 1 with "Migrations for" = drift);
//   - Alembic: alembic upgrade head, then alembic check (exit 255 with "New upgrade operations detected" = drift);
//   - Prisma: prisma migrate diff --from-migrations <dir> --to-schema <schema> --exit-code (exit 2 = drift);
//   - EF Core: dotnet ef migrations has-pending-model-changes (exit 1 with "Changes have been made to the model" = drift).
// A drift is one blocking finding with what the framework printed; anything the exit code and the output do not explain
// is an error stage, never a pass. Without a services section the check is SERVICES_REQUIRED (not applicable here, with
// the action to set the services up), never run and never a blocker.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { contentHash } from "../../core/ids/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan } from "../../core/plan/types.js";
import { findOnPath } from "../../core/runner/path-lookup.js";
import { inImageOverride, probeImageTool } from "../../core/tools-image/catalogue.js";
import type { AdapterContext, AdapterOutput, ResultFinding } from "../../core/run/types.js";
import { declaredNodePackage, declaredPythonPackage } from "../playwright/index.js";
import { AREA, RUN_DIR, WORKSPACE, componentDirOf, instanceBody, readText, runInstance, servicesOf, servicesRequiredReason, sha256File, tail, type KitCommand, type KitContract } from "../playwright/kit.js";
import { migrationDriftManifest } from "./manifest.js";

export { migrationDriftManifest } from "./manifest.js";

const ADAPTER_ID = migrationDriftManifest.id;
export const FRAMEWORKS = ["django", "alembic", "prisma", "efcore", "squawk"] as const;
export type MigrationFramework = (typeof FRAMEWORKS)[number];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DETAIL_LINES = 40;
const MAX_SQL_FINDINGS = 200;

/** The SQL files squawk lints when the instance names none (its own patterns, relative to the component). */
export const DEFAULT_SQL = ["migrations/**/*.sql"];
const SQL_PATTERN = /^(?![/\\]|[A-Za-z]:)(?!(?:.*[/\\])?\.\.(?:[/\\]|$))[^\s,]+\.sql$/;

interface MigrationContract extends KitContract {
  framework: MigrationFramework | null;
  /** The file the finding points to (the migrations folder, the schema or the project), workspace-relative. */
  anchor: string | null;
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The .csproj of a component that uses EF Core migrations (a Migrations/*ModelSnapshot.cs next to it), or null. */
export function efcoreProject(dir: string): string | null {
  const projects = listDir(dir).filter((n) => n.endsWith(".csproj")).sort();
  for (const p of projects) {
    const text = readText(path.join(dir, p)) ?? "";
    if (!/Include\s*=\s*"Microsoft\.EntityFrameworkCore/i.test(text)) continue;
    if (listDir(path.join(dir, "Migrations")).some((n) => n.endsWith("ModelSnapshot.cs"))) return p;
  }
  return null;
}

/** The Prisma schema of a component (prisma/schema.prisma, else schema.prisma), or null. */
function prismaSchema(dir: string): string | null {
  for (const rel of ["prisma/schema.prisma", "schema.prisma"]) if (fs.existsSync(path.join(dir, ...rel.split("/")))) return rel;
  return null;
}

/** Which framework the component uses when the instance does not say. */
export function detectFramework(dir: string, workspace: string): MigrationFramework | null {
  if (prismaSchema(dir) && declaredNodePackage(dir, workspace, ["prisma"])) return "prisma";
  if (fs.existsSync(path.join(dir, "alembic.ini"))) return "alembic";
  if (fs.existsSync(path.join(dir, "manage.py")) && declaredPythonPackage(dir, "django")) return "django";
  if (efcoreProject(dir)) return "efcore";
  return null;
}

/** The executable of a framework command: JGATES_MIGRATION_TOOL inside the image (a Node script through Node), else the command. */
function commandOf(env: NodeJS.ProcessEnv, executable: string): { executable: string; prefix: string[]; problem: string | null } {
  const named = inImageOverride(env, "JGATES_MIGRATION_TOOL");
  if (named === null) return { executable, prefix: [], problem: null };
  const abs = findOnPath(named, env);
  if (!abs) return { executable, prefix: [], problem: named };
  return /\.(?:mjs|cjs|js)$/i.test(abs) ? { executable: process.execPath, prefix: [abs, executable], problem: null } : { executable: abs, prefix: [executable], problem: null };
}

function planMigration(input: ExternalPlanInput): ExternalPlan {
  const t = translator(AREA);
  const { root, dir } = componentDirOf(input);
  const body = instanceBody(input);
  const problems: string[] = [];
  let framework: MigrationFramework | null = null;
  if (body.framework !== undefined) {
    if (typeof body.framework === "string" && (FRAMEWORKS as readonly string[]).includes(body.framework)) framework = body.framework as MigrationFramework;
    else problems.push(t("migration_setting_framework", { tool: input.tool, value: String(body.framework), allowed: FRAMEWORKS.join(", ") }));
  } else framework = detectFramework(dir, input.dir);
  const urlEnv = body.databaseUrlEnv === undefined ? "DATABASE_URL" : typeof body.databaseUrlEnv === "string" && ENV_NAME.test(body.databaseUrlEnv) ? body.databaseUrlEnv : null;
  if (urlEnv === null) problems.push(t("migration_setting_env", { tool: input.tool, value: String(body.databaseUrlEnv) }));
  const databaseUrl = typeof body.databaseUrl === "string" && body.databaseUrl.trim() !== "" ? body.databaseUrl.trim() : null;
  if (body.databaseUrl !== undefined && databaseUrl === null) problems.push(t("migration_setting_url", { tool: input.tool }));
  const services = servicesOf(input);
  const component = typeof body.component === "string" ? body.component : null;
  const at = (rel: string): string => (root ? `${root}/${rel}` : rel);
  const cwd = root ? `${WORKSPACE}/${root}` : WORKSPACE;
  const out = `${RUN_DIR}/outputs/${ADAPTER_ID}/${input.tool}`;
  const env: Record<string, string> = { PYTHONDONTWRITEBYTECODE: "1", NO_COLOR: "1", ...(databaseUrl && urlEnv ? { [urlEnv]: databaseUrl } : {}) };

  let commands: KitCommand[] = [];
  let anchor: string | null = null;
  let imageTool = "python";
  let version: string | null = null;
  let missing: string | null = null;
  const configFiles: string[] = [];
  const cmd = (executable: string, args: string[], extra: Record<string, string> = {}): KitCommand => {
    const c = commandOf(input.env, executable);
    if (c.problem) missing = c.problem;
    return { executable: c.executable, args: [...c.prefix, ...args], cwd, env: { ...env, ...extra } };
  };
  switch (framework) {
    case "django": {
      if (!declaredPythonPackage(dir, "django")) missing = "django";
      version = declaredPythonPackage(dir, "django")?.version ?? null;
      commands = [cmd("python", ["manage.py", "makemigrations", "--check", "--dry-run", "--no-input", "--verbosity", "2"])];
      anchor = at("manage.py");
      configFiles.push("manage.py");
      break;
    }
    case "alembic": {
      if (!declaredPythonPackage(dir, "alembic")) missing = "alembic";
      version = declaredPythonPackage(dir, "alembic")?.version ?? null;
      commands = [cmd("alembic", ["upgrade", "head"]), cmd("alembic", ["check"])];
      anchor = at("alembic.ini");
      configFiles.push("alembic.ini");
      break;
    }
    case "prisma": {
      const declared = declaredNodePackage(dir, input.dir, ["prisma"]);
      if (!declared) missing = "prisma";
      version = declared?.version ?? null;
      const schema = typeof body.prismaSchema === "string" ? body.prismaSchema : (prismaSchema(dir) ?? "prisma/schema.prisma");
      const migrations = typeof body.prismaMigrations === "string" ? body.prismaMigrations : `${path.posix.dirname(schema)}/migrations`;
      commands = [cmd("prisma", ["migrate", "diff", "--from-migrations", migrations, "--to-schema", schema, "--exit-code"], { CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" })];
      anchor = at(migrations);
      imageTool = "node";
      configFiles.push(schema, ...["prisma.config.ts", "prisma.config.js", "prisma.config.mjs"].filter((f) => fs.existsSync(path.join(dir, f))));
      break;
    }
    case "squawk": {
      // The SQL migration linter (Apache-2.0, in the tools image): it reads the SQL files, connects to nothing.
      const tool = probeImageTool("squawk", input.env);
      if (tool.problem !== null && inImageOverride(input.env, "JGATES_MIGRATION_TOOL") === null) missing = `squawk (${tool.detail})`;
      version = tool.version;
      const sql = Array.isArray(body.sql) ? body.sql.filter((p): p is string => typeof p === "string") : DEFAULT_SQL;
      if (body.sql !== undefined && (!Array.isArray(body.sql) || sql.length === 0 || sql.length !== body.sql.length || !sql.every((p) => SQL_PATTERN.test(p)))) problems.push(t("migration_setting_sql", { tool: input.tool }));
      commands = [cmd("squawk", ["--reporter", "json", ...sql])];
      imageTool = "squawk";
      configFiles.push(...[".squawk.toml"].filter((f) => fs.existsSync(path.join(dir, f))));
      break;
    }
    case "efcore": {
      const project = typeof body.dotnetProject === "string" ? body.dotnetProject : efcoreProject(dir);
      const context = typeof body.dbContext === "string" ? body.dbContext : null;
      const tool = probeImageTool("dotnet-ef", input.env);
      if (tool.problem !== null && inImageOverride(input.env, "JGATES_MIGRATION_TOOL") === null) missing = `dotnet-ef (${tool.detail})`;
      version = tool.version;
      commands = [
        cmd("dotnet-ef", ["migrations", "has-pending-model-changes", ...(project ? ["--project", project] : []), ...(context ? ["--context", context] : []), "--no-color"], {
          DOTNET_NOLOGO: "1",
          DOTNET_CLI_TELEMETRY_OPTOUT: "1",
          DOTNET_CLI_UI_LANGUAGE: "en",
          DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
          MSBUILDDISABLENODEREUSE: "1",
        }),
      ];
      anchor = project ? at(project) : null;
      imageTool = "dotnet-ef";
      if (project) configFiles.push(project);
      break;
    }
  }
  // The drift checks compare against the services database; the SQL linter reads files only.
  const lintOnly = framework === "squawk";
  const servicesRequired = services === null && !lintOnly;
  let availability: ExternalPlan["availability"];
  if (problems.length > 0) availability = { status: "unavailable", reason: problems.join(" ") };
  else if (servicesRequired) availability = { status: "unavailable", reason: servicesRequiredReason() };
  else if (framework === null) availability = { status: "unavailable", reason: t("migration_no_framework", { dir: root ?? "." }) };
  else if (databaseUrl === null && !lintOnly) availability = { status: "unavailable", reason: t("migration_needs_url", { tool: input.tool, variable: urlEnv ?? "DATABASE_URL" }) };
  else if (missing !== null) availability = { status: "unavailable", reason: t("migration_missing", { framework, detail: missing }) };
  else availability = { status: "available", reason: null };

  const first = commands[0] ?? { executable: "python", args: [], cwd, env };
  const contract: MigrationContract = {
    component,
    root,
    framework,
    anchor,
    ...(servicesRequired ? { servicesRequired: true } : {}),
    ...(commands.length > 1 ? { more: commands.slice(1) } : {}),
  };
  const conditions = [t("migration_condition", { framework: framework ?? "-" })];
  if (databaseUrl && urlEnv) conditions.push(t("migration_condition_url", { variable: urlEnv }));
  return {
    label: t("migration_label", { framework: framework ?? "-" }),
    command: { ...first, stdin: null },
    runtime: { name: "native", interpreter: first.executable, available: missing === null && framework !== null },
    toolVersion: version,
    configFiles: configFiles.map((f) => ({ file: at(f), sha256: sha256File(path.join(dir, ...f.split("/"))) })),
    availability,
    blocksPlan: problems.length > 0,
    network: false,
    limitations: [t("migration_limitation")],
    conditions,
    output: { format: "text", schema: null },
    imageTool,
    ...(servicesRequired ? { requires: "services" as const } : {}),
    contract,
    effects: { executesProjectCode: true, ...(framework === "efcore" ? { workspaceWrites: [at("bin"), at("obj")] } : {}) },
  };
}

/** What a framework's output says: drift (with its lines), no drift, or nothing it can tell. */
export interface SquawkViolation {
  file: string;
  /** 1-based line. */
  line: number;
  column: number;
  level: string;
  rule: string;
  message: string;
  help: string | null;
}

/** squawk --reporter json: an array of violations (line and column 0-based); null when the output is not one. */
export function parseSquawk(stdout: string): SquawkViolation[] | null {
  const start = stdout.indexOf("[");
  if (start < 0) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
  if (!Array.isArray(doc)) return null;
  const out: SquawkViolation[] = [];
  for (const v of doc) {
    if (typeof v !== "object" || v === null) return null;
    const r = v as Record<string, unknown>;
    if (typeof r.file !== "string" || typeof r.rule_name !== "string" || typeof r.message !== "string") return null;
    out.push({
      file: r.file,
      line: typeof r.line === "number" ? r.line + 1 : 1,
      column: typeof r.column === "number" ? r.column + 1 : 1,
      level: typeof r.level === "string" ? r.level : "Warning",
      rule: r.rule_name,
      message: r.message,
      help: typeof r.help === "string" ? r.help : null,
    });
  }
  return out;
}

export function readDrift(framework: MigrationFramework, exitCode: number | null, stdout: string, stderr: string): { state: "drift" | "clean" | "unknown"; detail: string[] } {
  const text = `${stdout}\n${stderr}`;
  // eslint-disable-next-line no-control-regex
  const lines = (s: string): string[] => s.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  switch (framework) {
    case "django":
      if (exitCode === 0 && /No changes detected/i.test(text)) return { state: "clean", detail: [] };
      if (exitCode === 1 && /Migrations for '/.test(stdout)) return { state: "drift", detail: lines(stdout.slice(stdout.search(/Migrations for '/))) };
      return { state: "unknown", detail: [] };
    case "alembic":
      if (exitCode === 0 && /No new upgrade operations detected/i.test(text)) return { state: "clean", detail: [] };
      if (exitCode !== 0 && /New upgrade operations detected/i.test(text)) return { state: "drift", detail: lines(text).filter((l) => /New upgrade operations detected/i.test(l)) };
      return { state: "unknown", detail: [] };
    case "prisma":
      if (exitCode === 0) return { state: "clean", detail: [] };
      if (exitCode === 2) return { state: "drift", detail: lines(stdout) };
      return { state: "unknown", detail: [] };
    case "squawk":
      return { state: "unknown", detail: [] };
    case "efcore":
      if (exitCode === 0 && /No changes have been made to the model/i.test(text)) return { state: "clean", detail: [] };
      if (exitCode !== 0 && /Changes have been made to the model since the last migration/i.test(text)) return { state: "drift", detail: lines(text).filter((l) => /Changes have been made to the model/i.test(l)) };
      return { state: "unknown", detail: [] };
  }
}

async function runMigration(context: AdapterContext, planDoc: Plan, tool: string): Promise<AdapterOutput> {
  return runInstance<MigrationContract>(ADAPTER_ID, context, planDoc, tool, async (run) => {
    const t = translator(AREA);
    const framework = run.contract.framework;
    if (framework === null) return run.all("blocked", t("migration_no_framework", { dir: run.contract.root ?? "." }));
    let last = null as Awaited<ReturnType<typeof run.exec>> | null;
    for (let i = 0; i < run.commands.length; i++) {
      const executed = await run.exec(i);
      const stop = run.stopped(executed);
      if (stop) return stop;
      last = executed;
      // A step before the comparison (alembic upgrade head) that fails leaves nothing to compare.
      if (i < run.commands.length - 1 && executed.result.exitCode !== 0) {
        return run.all("error", t("migration_prepare_failed", { framework, code: executed.result.exitCode ?? "-", detail: tail(executed.result.stderr || executed.result.stdout) || "-" }), { interpreted: false, nativeStatus: `exit ${executed.result.exitCode ?? "-"}` });
      }
    }
    if (!last) return run.all("error", t("migration_prepare_failed", { framework, code: "-", detail: "-" }), { interpreted: false });
    const { result } = last;
    const native = `exit ${result.exitCode ?? "-"}`;
    fs.writeFileSync(path.join(run.outDir, "output.txt"), `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`, { mode: 0o600 });
    const item0 = run.items[0] as Plan["groups"]["willRun"][number];
    if (framework === "squawk") {
      const violations = parseSquawk(result.stdout);
      // squawk exits 0 without violations and 1 with them; anything else, or an output that is not its report, proves nothing.
      if (violations === null || result.truncated || !((result.exitCode === 0 && violations.length === 0) || (result.exitCode === 1 && violations.length > 0))) {
        return run.all("error", t("migration_unexplained", { framework, code: result.exitCode ?? "-", detail: tail(result.stderr || result.stdout) || "-" }), { interpreted: false, nativeStatus: native });
      }
      const at = (file: string): string => {
        const rel = file.replace(/\\/g, "/").replace(/^\.\//, "");
        return run.contract.root ? `${run.contract.root}/${rel}` : rel;
      };
      const findings: ResultFinding[] = violations.slice(0, MAX_SQL_FINDINGS).map((v) => {
        // Like the other linters: every finding, whatever its level, blocks (the project's .squawk.toml turns rules off).
        const error = true;
        return {
          stageId: item0.id,
          tool: ADAPTER_ID,
          ...(run.version ? { toolVersion: run.version } : {}),
          ruleId: `squawk.${v.rule}`,
          category: "migration",
          severity: v.level,
          normalizedSeverity: v.level.toLowerCase() === "error" ? "high" : "medium",
          message: t("migration_sql_finding", { rule: v.rule, message: v.message, help: v.help ?? "-" }),
          location: { path: at(v.file), line: v.line, column: v.column },
          fingerprint: contentHash({ tool: ADAPTER_ID, rule: v.rule, file: at(v.file), line: v.line, message: v.message }),
          origin: ADAPTER_ID,
          blocking: error,
          ...(error ? { blockingReason: "blocking-tool" as const } : {}),
          waived: false,
        };
      });
      const blocking = findings.filter((f) => f.blocking).length;
      const reason = t("migration_reason_sql", { version: run.version ?? "?", count: violations.length, blocking });
      return { ...run.base(), stages: run.items.map((i) => run.stage(i, "completed", reason, { blockingViolations: blocking, findings: findings.length, nativeStatus: native })), findings };
    }
    const drift = readDrift(framework, result.exitCode, result.stdout, result.stderr);
    if (drift.state === "unknown" || result.truncated) {
      return run.all("error", t("migration_unexplained", { framework, code: result.exitCode ?? "-", detail: tail(result.stderr || result.stdout) || "-" }), { interpreted: false, nativeStatus: native });
    }
    const item = run.items[0] as Plan["groups"]["willRun"][number];
    if (drift.state === "clean") {
      return { ...run.base(), stages: run.items.map((i) => run.stage(i, "completed", t("migration_reason_clean", { framework, version: run.version ?? "?" }), { blockingViolations: 0, findings: 0, nativeStatus: native })), findings: [] };
    }
    const shown = drift.detail.slice(0, MAX_DETAIL_LINES);
    const finding: ResultFinding = {
      stageId: item.id,
      tool: ADAPTER_ID,
      ...(run.version ? { toolVersion: run.version } : {}),
      ruleId: `migration-drift.${framework}`,
      category: "migration",
      severity: "error",
      normalizedSeverity: "high",
      message: t("migration_finding", { framework, detail: shown.join(" | ") || "-" }),
      ...(run.contract.anchor ? { location: { path: run.contract.anchor } } : {}),
      fingerprint: contentHash({ tool: ADAPTER_ID, rule: framework, anchor: run.contract.anchor, detail: shown }),
      origin: ADAPTER_ID,
      blocking: true,
      blockingReason: "blocking-tool",
      waived: false,
    };
    return {
      ...run.base(),
      stages: run.items.map((i) => run.stage(i, "completed", t("migration_reason_drift", { framework, version: run.version ?? "?" }), { blockingViolations: 1, findings: 1, nativeStatus: native })),
      findings: [finding],
    };
  });
}

export const migrationDriftAdapter: ExternalAdapter = {
  manifest: migrationDriftManifest,
  plan: planMigration,
  run: runMigration,
};
