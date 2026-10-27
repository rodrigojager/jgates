import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { resolveHome } from "../../core/home/index.js";
import { readPolicyBundle } from "../../core/policy/index.js";
import { UiError, launchUi } from "../../server/index.js";
import { openInBrowser } from "../../server/browser.js";

const t = translator("server");
const tp = translator("policy");

const str = (options: Record<string, string | boolean>, name: string): string | undefined => (typeof options[name] === "string" ? (options[name] as string) : undefined);

/**
 * `jgates ui`: starts the local server of the workspace (or reuses the open one) and prints where it listens.
 * The one-time bootstrap secret never goes to stdout or stderr: it lives only in a 0600 launcher file in the data
 * folder, which is opened in the browser (or opened by hand with --no-open).
 */
export const command: CommandModule = {
  name: "ui",
  description: t("ui_description"),
  options: [
    { name: "cwd", type: "string", description: t("ui_option_cwd") },
    { name: "policy", type: "string", description: t("ui_option_policy") },
    { name: "port", type: "string", description: t("ui_option_port") },
    { name: "host", type: "string", description: t("ui_option_host") },
    { name: "no-open", type: "boolean", description: t("ui_option_no_open") },
  ],
  async run(ctx) {
    const usage = (code: string, params: Record<string, string | number> = {}) => {
      const key = `ui_${code.toLowerCase()}`;
      return reportError(ctx, ctx.json, code, t(key, params), t(`${key}_fix`, params), EXIT_USAGE);
    };
    const extra = ctx.args[0];
    if (extra !== undefined) return usage("UNEXPECTED_ARGUMENT", { name: extra });
    const policy = str(ctx.options, "policy");
    if (policy !== undefined && str(ctx.options, "cwd") !== undefined) return usage("POLICY_WITH_CWD");
    // With --policy the folder to serve is the CI policy: the same editors, applied to the policy repository.
    const projectDir = path.resolve(policy ?? str(ctx.options, "cwd") ?? process.cwd());
    let isDir = false;
    try {
      isDir = fs.statSync(projectDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      if (policy === undefined) return usage("BAD_CWD", { path: projectDir });
      const key = "policy_err_policy_dir_missing";
      return reportError(ctx, ctx.json, "POLICY_DIR_MISSING", tp(key, { path: projectDir }), tp(`${key}_fix`), EXIT_USAGE);
    }
    if (policy !== undefined) {
      const read = readPolicyBundle(projectDir);
      // Only a folder that cannot be a policy at all is refused here; a broken one opens, so the screens can fix it.
      if (!read.ok && (read.error.code === "POLICY_DIR_MISSING" || read.error.code === "POLICY_ROOT_MISSING")) {
        const key = `policy_err_${read.error.code.toLowerCase()}`;
        const params = { path: read.error.path ?? "" };
        return reportError(ctx, ctx.json, read.error.code, tp(key, params), tp(`${key}_fix`, params), EXIT_USAGE);
      }
    }
    const portText = str(ctx.options, "port") ?? "0";
    if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) > 65535) return usage("INVALID_PORT", { value: portText });
    const host = str(ctx.options, "host") ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1") return usage("HOST_NOT_LOOPBACK", { host });

    let outcome;
    try {
      outcome = await launchUi({ projectDir, version: ctx.version, home: resolveHome(), host, port: Number(portText), ...(policy !== undefined ? { policyMode: true } : {}) });
    } catch (error) {
      if (error instanceof UiError) return usage(error.code, error.params);
      throw error;
    }

    const open = ctx.options["no-open"] !== true;
    const opened = open ? openInBrowser(outcome.launcher) : false;
    const launcherUrl = pathToFileURL(outcome.launcher).href;
    if (ctx.json) {
      writeJson(ctx, {
        schemaVersion: 1,
        status: "OK",
        tool: "jgates",
        version: ctx.version,
        reused: outcome.kind === "reused",
        url: outcome.url,
        host: outcome.host,
        port: outcome.port,
        pid: outcome.pid,
        ...(policy !== undefined ? { policy: true } : {}),
        workspace: outcome.workspace,
        launcher: outcome.launcher,
        launcherUrl,
        opened,
        log: outcome.log,
      });
    } else {
      ctx.stdout(`${t(outcome.kind === "reused" ? "ui_text_reused" : policy !== undefined ? "ui_text_started_policy" : "ui_text_started", { url: outcome.url, workspace: outcome.workspace.name })}\n`);
      ctx.stdout(`${t("ui_text_launcher", { launcher: launcherUrl })}\n`);
      if (outcome.kind === "started") ctx.stdout(`${t("ui_text_stop")}\n`);
    }
    if (outcome.kind === "reused") return 0;

    // Keep serving until the process is asked to stop.
    const started = outcome;
    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void started.stop().then(resolve, resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      if (process.platform === "win32") process.once("SIGBREAK", stop);
    });
    return 0;
  },
};
