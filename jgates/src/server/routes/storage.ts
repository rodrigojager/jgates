// Storage (Preferences > Storage): where the data folder is, the space of each workspace and of the JGates images, the
// retention, and the workspaces whose path no longer exists (relink them, or delete their artifacts after a
// confirmation). Deleting only ever happens inside <data folder>/workspaces (applyRetention checks it again).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { applyRetention, dirBytes, listRuns, planRetention } from "../../core/artifacts/index.js";
import { effectiveRetention, engineContextFor, storageReport } from "../../core/cleanup/index.js";
import { RelinkError, readRegistry, relinkWorkspace, workspaceDir, workspaceLineage, type WorkspaceEntry } from "../../core/home/index.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";

const t = translator("history");
const ID = "^[A-Za-z0-9_.-]{1,128}$";
const IMAGE_LABEL = "org.jgates.dev=true";

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export { effectiveRetention };

/** Images built by the work on JGates (label org.jgates.dev); empty and `available: false` when no container runtime answers. */
function readImages(env: NodeJS.ProcessEnv = process.env): { available: boolean; items: Array<{ name: string; size: string }> } {
  const runtime = env.JGATES_CONTAINER_RUNTIME?.trim() || "docker";
  const r = spawnSync(runtime, ["image", "ls", "--filter", `label=${IMAGE_LABEL}`, "--format", "{{.Repository}}:{{.Tag}}\t{{.Size}}"], { encoding: "utf8", timeout: 4000, env });
  if (r.error || r.status !== 0) return { available: false, items: [] };
  const items = r.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", size = ""] = line.split("\t");
      return { name, size };
    });
  return { available: true, items };
}

function groupIds(server: ServerContext, id: string): string[] {
  return workspaceLineage(server.home, id);
}

function describe(server: ServerContext, entry: WorkspaceEntry) {
  const ids = groupIds(server, entry.id);
  const runs = ids.flatMap((id) => listRuns(server.home, id).filter((r) => r.workspaceId === id));
  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    exists: isDirectory(entry.path),
    current: entry.id === server.workspace.id,
    lastAccess: entry.lastAccess,
    runs: runs.length,
    marked: runs.filter((r) => r.marks.baseline || r.marks.preserved).length,
    bytes: ids.reduce((n, id) => n + dirBytes(workspaceDir(server.home, id)), 0),
    folder: workspaceDir(server.home, entry.id),
  };
}

/** A registered workspace whose path is gone and that this server does not use: the only kind that can be relinked or deleted. */
function missingTarget(server: ServerContext, id: string): WorkspaceEntry {
  const entry = readRegistry(server.home).workspaces.find((w) => w.id === id && !w.relinkedTo);
  if (!entry) throw new HttpError(404, "WORKSPACE_NOT_FOUND", t("storage_workspace_not_found"), t("storage_workspace_not_found_fix"));
  if (entry.id === server.workspace.id || isDirectory(entry.path)) {
    throw new HttpError(409, "WORKSPACE_STILL_EXISTS", t("storage_workspace_exists", { path: entry.path }), t("storage_workspace_exists_fix"));
  }
  return entry;
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/storage",
    async handler({ server }) {
      const entries = readRegistry(server.home).workspaces.filter((w) => !w.relinkedTo);
      const report = await storageReport(process.env, engineContextFor(process.env));
      const workspaces = entries
        .map((w) => {
          const own = describe(server, w);
          const ids = new Set(groupIds(server, w.id));
          const volumes = report.workspaces.filter((v) => ids.has(v.workspace)).flatMap((v) => v.volumes);
          return { ...own, engine: { bytes: volumes.reduce((n, v) => n + v.sizeBytes, 0), volumes } };
        })
        .sort((a, b) => Number(b.current) - Number(a.current) || (a.lastAccess < b.lastAccess ? 1 : -1));
      const { policy, fromEnvironment } = effectiveRetention();
      const plan = planRetention(server.home, policy);
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          home: server.home,
          totalBytes: dirBytes(server.home),
          workspaces,
          retention: { ...policy, fromEnvironment, wouldRemoveRuns: plan.runs.length, wouldFreeBytes: plan.freedBytes },
          images: readImages(),
          // Engine objects by category, from the JGates labels; shared image layers are counted once.
          categories: {
            engine: report.engine,
            tools: report.tools,
            extensions: report.extensions,
            data: report.data,
            toolchains: report.toolchains,
            caches: report.caches,
            workspaces: report.workspaces,
            other: report.other,
            images: report.images,
            volumesBytes: report.volumesBytes,
            totalBytes: report.totalBytes,
          },
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/storage/relink",
    body: {
      type: "object",
      properties: { id: { type: "string", pattern: ID }, path: { type: "string", minLength: 1, maxLength: 4096 } },
      required: ["id", "path"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      const input = body as { id: string; path: string };
      const entry = missingTarget(server, input.id);
      if (!isDirectory(input.path)) throw new HttpError(400, "WORKSPACE_NOT_DIRECTORY", t("storage_not_directory", { path: input.path }), t("storage_not_directory_fix"));
      try {
        const target = relinkWorkspace(entry.id, input.path, { home: server.home });
        server.log(`relink ${entry.id} -> ${target.id}`);
        return { status: 200, json: { schemaVersion: 1, status: "OK", from: entry.id, to: { id: target.id, name: target.name, path: target.path } } };
      } catch (error) {
        if (error instanceof RelinkError) {
          const key = error.code === "RELINK_SAME_WORKSPACE" ? "storage_relink_same" : error.code === "RELINK_CYCLE" ? "storage_relink_cycle" : "storage_workspace_not_found";
          throw new HttpError(error.code === "WORKSPACE_NOT_FOUND" ? 404 : 409, error.code, t(key), t(`${key}_fix`));
        }
        throw error;
      }
    },
  },
  {
    // Without `dryRun: false` and `confirm` equal to the id, it only says what would go.
    method: "POST",
    path: "/api/storage/delete-artifacts",
    body: {
      type: "object",
      properties: { id: { type: "string", pattern: ID }, dryRun: { type: "boolean" }, confirm: { type: "string", maxLength: 128 } },
      required: ["id"],
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    handler({ body, server }) {
      const input = body as { id: string; dryRun?: boolean; confirm?: string };
      const entry = missingTarget(server, input.id);
      const ids = groupIds(server, entry.id);
      const runs = ids.flatMap((id) => listRuns(server.home, id).filter((r) => r.workspaceId === id));
      const preview = { id: entry.id, path: entry.path, runs: runs.length, marked: runs.filter((r) => r.marks.baseline || r.marks.preserved).length, bytes: ids.reduce((n, id) => n + dirBytes(workspaceDir(server.home, id)), 0), folders: ids.map((id) => workspaceDir(server.home, id)) };
      if (input.dryRun !== false) return { status: 200, json: { schemaVersion: 1, status: "OK", dryRun: true, preview } };
      if (input.confirm !== entry.id) throw new HttpError(400, "CONFIRMATION_REQUIRED", t("storage_confirm_required"), t("storage_confirm_required_fix"));
      const applied = applyRetention(server.home, {
        policy: effectiveRetention().policy,
        runs: [],
        missingWorkspaces: [{ id: entry.id, path: entry.path, keptRuns: [], removable: true }],
        freedBytes: preview.bytes,
      });
      server.log(`delete-artifacts ${entry.id} removed=${applied.removedWorkspaces.length} skipped=${applied.skipped.length}`);
      if (applied.removedWorkspaces.length === 0) throw new HttpError(409, "DELETE_REFUSED", t("storage_delete_refused"), t("storage_delete_refused_fix"), { skipped: applied.skipped });
      return { status: 200, json: { schemaVersion: 1, status: "OK", dryRun: false, preview, freedBytes: preview.bytes, skipped: applied.skipped } };
    },
  },
];
