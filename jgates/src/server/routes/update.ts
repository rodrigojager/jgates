// Updates (About > Updates): the same check and install as `jgates update`, started by a button. Nothing runs on its
// own: the repository is asked only when the person presses "Check for updates", and the install only installs the
// commit that check found, after a second press. The install runs in the background; the screen follows its status.
import { spawn } from "node:child_process";
import { compare, describeInstallation, findPackageDir, installCommand, remoteCommit, UpdateError, type Installation } from "../../core/update/index.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition } from "../types.js";

const t = translator("update");

interface InstallStatus {
  state: "idle" | "running" | "done" | "failed";
  commit: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  /** The last lines of the npm output. */
  log: string[];
}

let lastCheck: { installed: Installation; repository: string; latest: string } | null = null;
const status: InstallStatus = { state: "idle", commit: null, startedAt: null, endedAt: null, exitCode: null, log: [] };

function installation(): { installed: Installation; repository: string } {
  const packageDir = process.env.JGATES_UPDATE_PACKAGE_DIR || findPackageDir();
  if (!packageDir) throw new HttpError(500, "INSTALLATION_NOT_FOUND", t("update_not_found"), null);
  const installed = describeInstallation(packageDir);
  const repository = process.env.JGATES_UPDATE_REPOSITORY || installed.repository;
  if (!repository) throw new HttpError(500, "NO_REPOSITORY", t("update_no_repository"), null);
  return { installed, repository };
}

function keepLog(chunk: Buffer): void {
  for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) status.log.push(line);
  if (status.log.length > 40) status.log.splice(0, status.log.length - 40);
}

export const routes: RouteDefinition[] = [
  {
    method: "POST",
    path: "/api/update/check",
    body: { type: "object", additionalProperties: false, properties: { ref: { type: "string", pattern: "^[A-Za-z0-9._/-]{1,100}$" } } },
    timeoutMs: 70_000,
    handler({ body }) {
      const ref = (body as { ref?: string } | undefined)?.ref ?? "main";
      const { installed, repository } = installation();
      let latest: string;
      try {
        latest = remoteCommit(repository, ref);
      } catch (e) {
        if (!(e instanceof UpdateError)) throw e;
        if (e.code === "GIT_MISSING") throw new HttpError(503, e.code, t("update_git_missing"), t("update_git_missing_fix"));
        if (e.code === "REF_NOT_FOUND") throw new HttpError(404, e.code, t("update_ref_not_found", { ref }), t("update_ref_not_found_fix"));
        throw new HttpError(502, e.code, t("update_remote_failed", { repository, detail: e.message }), t("update_remote_failed_fix"));
      }
      lastCheck = { installed, repository, latest };
      const command = installCommand(installed, repository, latest);
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          installation: { kind: installed.kind, version: installed.version, commit: installed.commit, dirty: installed.dirty, packageDir: installed.packageDir },
          repository,
          ref,
          latest,
          state: compare(installed, latest),
          canInstall: command !== null,
          command,
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/update/install",
    body: { type: "object", additionalProperties: false, required: ["commit"], properties: { commit: { type: "string", pattern: "^[0-9a-f]{40}$" } } },
    handler({ body }) {
      const { commit } = body as { commit: string };
      if (status.state === "running") throw new HttpError(409, "UPDATE_RUNNING", t("update_ui_running"), null);
      // Only what the last check found: the screen cannot ask for any other package.
      if (!lastCheck || lastCheck.latest !== commit) throw new HttpError(409, "UPDATE_NOT_CHECKED", t("update_ui_not_checked"), t("update_ui_not_checked_fix"));
      const command = installCommand(lastCheck.installed, lastCheck.repository, commit);
      if (!command) throw new HttpError(409, "UPDATE_MANUAL", t("update_ui_manual"), null);
      Object.assign(status, { state: "running", commit, startedAt: new Date().toISOString(), endedAt: null, exitCode: null, log: [] });
      const [cmd = "npm", ...args] = command;
      const child = spawn(cmd, args.map((a) => (process.platform === "win32" && /\s/.test(a) ? `"${a}"` : a)), {
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        windowsHide: true,
      });
      child.stdout.on("data", keepLog);
      child.stderr.on("data", keepLog);
      const finish = (code: number | null) => {
        if (status.state !== "running") return;
        Object.assign(status, { state: code === 0 ? "done" : "failed", exitCode: code, endedAt: new Date().toISOString() });
      };
      child.on("error", (e) => {
        status.log.push(String(e));
        finish(1);
      });
      child.on("close", finish);
      return { status: 202, json: { schemaVersion: 1, status: "OK", update: status } };
    },
  },
  {
    method: "GET",
    path: "/api/update/status",
    handler() {
      return { status: 200, json: { schemaVersion: 1, status: "OK", update: status } };
    },
  },
];
