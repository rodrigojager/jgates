// jgates deps prepare|status|clean: the project's own dependencies in Linux volumes (PLAN-dependencies.md section 6).
// `prepare` synchronizes the project into its source volume and installs (or reuses) the dependencies of every install
// unit (or of one component); `status` says, per unit, whether the volume is ready, outdated, missing or failed, without
// starting a container; `clean` removes the dependency volumes of the workspace (selected by label) and their record.
import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { EngineError, engineRuntime, inspectImageSync, listManaged, removeManaged, type EngineContext } from "../../core/engine/index.js";
import { resolveHome, touchWorkspace, workspaceDir } from "../../core/home/index.js";
import { workspaceId } from "../../core/ids/index.js";
import { discoverWorkspace, loadWorkspaceSettings } from "../../core/discovery/index.js";
import { SyncError, syncProject } from "../../core/sync/index.js";
import { toolsImageTarget } from "../../core/tools-image/index.js";
import {
  LABEL_DEPS_UNIT,
  installUnits,
  loadDependencySettings,
  planUnit,
  prepareUnit,
  publicOutcome,
  readDepsState,
  updateDepsState,
  type InstallUnit,
  type UnitOutcome,
} from "../../core/deps/index.js";

const t = translator("deps");
const SUBCOMMANDS = ["prepare", "status", "clean"] as const;

interface Target {
  projectDir: string;
  units: InstallUnit[];
}

function projectOf(ctx: CommandContext): string | number {
  const cwd = path.resolve(typeof ctx.options.cwd === "string" ? ctx.options.cwd : process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return reportError(ctx, ctx.json, "BAD_CWD", t("deps_cmd_bad_cwd", { path: cwd }), t("deps_cmd_bad_cwd_fix"), EXIT_USAGE);
  return cwd;
}

/** The install units of the project, narrowed to the one of --component when given. */
function targetOf(ctx: CommandContext, projectDir: string): Target | number {
  const { inventory } = discoverWorkspace(projectDir);
  const { units } = installUnits(inventory.classifications.filter((c) => c.approvable));
  const wanted = typeof ctx.options.component === "string" ? ctx.options.component : null;
  if (wanted === null) return { projectDir, units };
  const chosen = units.filter((u) => u.id === wanted || u.components.includes(wanted));
  if (chosen.length === 0) return reportError(ctx, ctx.json, "UNKNOWN_COMPONENT", t("deps_cmd_unknown_component", { component: wanted, known: units.flatMap((u) => u.components).join(", ") || "-" }), t("deps_cmd_unknown_component_fix"), EXIT_USAGE);
  return { projectDir, units: chosen };
}

function engineContext(): EngineContext {
  return { runtime: engineRuntime(process.env), runnerOptions: { parentEnv: process.env } };
}

const imageReference = (): string => process.env.JGATES_TOOLS_IMAGE?.trim() || toolsImageTarget(process.env).reference;

async function prepare(ctx: CommandContext, target: Target): Promise<number> {
  const engine = engineContext();
  const home = resolveHome();
  const reference = imageReference();
  let image;
  try {
    image = inspectImageSync(reference, engine);
  } catch (error) {
    return reportError(ctx, ctx.json, "ENGINE_UNAVAILABLE", t("deps_cmd_engine", { message: error instanceof Error ? error.message : String(error) }), t("deps_cmd_engine_fix"), 1);
  }
  if (!image) return reportError(ctx, ctx.json, "IMAGE_MISSING", t("deps_cmd_no_image", { image: reference }), t("deps_cmd_no_image_fix"), 1);
  const workspace = touchWorkspace(target.projectDir, { home }).id;
  try {
    await syncProject({ projectDir: target.projectDir, workspace, image: image.id, version: ctx.version, home, context: engine, excludePatterns: loadWorkspaceSettings(target.projectDir).settings.exclude });
  } catch (error) {
    if (!(error instanceof SyncError || error instanceof EngineError)) throw error;
    return reportError(ctx, ctx.json, "SYNC_FAILED", t("deps_cmd_sync_failed", { message: error.message }), t("deps_cmd_engine_fix"), 1);
  }
  const settings = loadDependencySettings(target.projectDir);
  const logsDir = path.join(workspaceDir(home, workspace), "deps", "logs");
  const outcomes: UnitOutcome[] = [];
  for (const unit of target.units) {
    if (!ctx.json) ctx.stdout(t("deps_cmd_preparing", { unit: unit.id, components: unit.components.join(", ") }) + "\n");
    outcomes.push(
      await prepareUnit(unit, {
        projectDir: target.projectDir,
        workspace,
        home,
        version: ctx.version,
        imageId: image.id,
        governed: false,
        settings,
        env: process.env,
        vault: true,
        engine,
        logs: { dir: logsDir, root: workspaceDir(home, workspace) },
      }),
    );
  }
  const bad = outcomes.find((o) => o.status === "failed" || o.status === "not-ready");
  if (ctx.json) {
    writeJson(ctx, { schemaVersion: 1, status: bad ? "FAILED" : "OK", ...(bad?.code ? { code: bad.code } : {}), tool: "jgates", version: ctx.version, workspace, units: outcomes.map(publicOutcome) });
  } else {
    if (outcomes.length === 0) ctx.stdout(t("deps_cmd_no_units") + "\n");
    for (const o of outcomes) ctx.stdout(`${o.unit} (${o.components.join(", ")}): ${o.message}${o.log ? ` ${t("deps_cmd_log", { file: path.join(workspaceDir(home, workspace), o.log) })}` : ""}\n`);
  }
  return bad ? 1 : 0;
}

type UnitState = "ready" | "outdated" | "missing" | "failed" | "not-ready" | "unknown";

async function status(ctx: CommandContext, target: Target): Promise<number> {
  const engine = engineContext();
  const home = resolveHome();
  const workspace = workspaceId(target.projectDir);
  const record = readDepsState(home, workspace);
  const settings = loadDependencySettings(target.projectDir);
  let imageId: string | null = null;
  let volumes: string[] | null = null;
  try {
    imageId = inspectImageSync(imageReference(), engine)?.id ?? null;
    volumes = (await listManaged("volume", { kind: "deps", workspace }, engine)).map((v) => v.name);
  } catch {
    volumes = null;
  }
  const rows = target.units.map((unit) => {
    const planned = planUnit(unit, { projectDir: target.projectDir, workspace, imageId, governed: false, settings, env: process.env, vault: true });
    const installed = record.units[unit.id];
    const failure = record.failures[unit.id];
    const present = installed ? (volumes === null ? null : volumes.includes(installed.volume)) : false;
    let state: UnitState;
    let message: string;
    if (planned.blocked) {
      state = "not-ready";
      message = t(planned.blocked.reasonKey, planned.blocked.params);
    } else if (failure && failure.key === planned.key) {
      state = "failed";
      message = t("deps_status_failed", { message: failure.message });
    } else if (installed && present === null) {
      state = "unknown";
      message = t("deps_status_unknown");
    } else if (installed && present && installed.key === planned.key) {
      state = "ready";
      message = t("deps_status_ready", { date: installed.installedAt });
    } else if (installed && present) {
      state = "outdated";
      message = t("deps_status_outdated");
    } else {
      state = "missing";
      message = t("deps_status_missing");
    }
    return {
      unit: unit.id,
      components: unit.components,
      installRoot: unit.installRoot,
      ecosystem: unit.info.ecosystem,
      manager: unit.info.manager,
      lockfile: unit.info.lockfile,
      note: unit.info.note,
      state,
      message,
      key: planned.key,
      volume: installed?.volume ?? null,
      installedKey: installed?.key ?? null,
      installedAt: installed?.installedAt ?? null,
    };
  });
  if (ctx.json) writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, workspace, engine: volumes !== null, units: rows });
  else {
    if (rows.length === 0) ctx.stdout(t("deps_cmd_no_units") + "\n");
    for (const r of rows) ctx.stdout(`${r.unit} (${r.components.join(", ")}, ${r.manager ?? "-"}): ${r.message}${r.note ? ` ${t("deps_status_no_lockfile")}` : ""}\n`);
  }
  return 0;
}

async function clean(ctx: CommandContext, target: Target, onlyOne: boolean): Promise<number> {
  const engine = engineContext();
  const home = resolveHome();
  const workspace = workspaceId(target.projectDir);
  const removed: string[] = [];
  try {
    if (onlyOne) {
      for (const unit of target.units) removed.push(...(await removeManaged("volume", { kind: "deps", workspace, extraLabels: { [LABEL_DEPS_UNIT]: unit.id } }, engine)).map((v) => v.name));
    } else removed.push(...(await removeManaged("volume", { kind: "deps", workspace }, engine)).map((v) => v.name));
  } catch (error) {
    return reportError(ctx, ctx.json, "ENGINE_UNAVAILABLE", t("deps_cmd_engine", { message: error instanceof Error ? error.message : String(error) }), t("deps_cmd_engine_fix"), 1);
  }
  updateDepsState(home, workspace, (s) => {
    const ids = onlyOne ? target.units.map((u) => u.id) : [...Object.keys(s.units), ...Object.keys(s.failures)];
    for (const id of ids) {
      delete s.units[id];
      delete s.failures[id];
    }
  });
  if (ctx.json) writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, workspace, removed });
  else ctx.stdout(t("deps_cmd_cleaned", { count: removed.length }) + "\n");
  return 0;
}

export const command: CommandModule = {
  name: "deps",
  description: t("deps_cmd_description"),
  options: [
    { name: "cwd", type: "string", description: t("deps_cmd_option_cwd") },
    { name: "component", type: "string", description: t("deps_cmd_option_component") },
  ],
  async run(ctx) {
    const sub = ctx.args[0];
    if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) return reportError(ctx, ctx.json, "UNKNOWN_SUBCOMMAND", t("deps_cmd_unknown_sub", { name: sub ?? "-" }), t("deps_cmd_unknown_sub_fix"), EXIT_USAGE);
    const projectDir = projectOf(ctx);
    if (typeof projectDir === "number") return projectDir;
    const target = targetOf(ctx, projectDir);
    if (typeof target === "number") return target;
    if (sub === "prepare") return prepare(ctx, target);
    if (sub === "status") return status(ctx, target);
    return clean(ctx, target, typeof ctx.options.component === "string");
  },
};
