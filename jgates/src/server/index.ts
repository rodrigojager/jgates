// The local server of `jgates ui`: loopback only, one workspace per server, an
// ephemeral session opened by a one-time bootstrap secret, and every request checked (Host, Origin, session, CSRF,
// size, schema) before any route reads or writes anything.
import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureWorkspaceDirs, registerWorkspace, resolveHome, workspaceDir } from "../core/home/index.js";
import { translator } from "../i18n/index.js";
import { HttpError, escapeHtml, readBody, refuse, sendBody, sendError, sendJson } from "./http.js";
import { lockFile, processAlive, readLock, removeLockIfSame, requestLauncher, tryCreateLock, type ServerLock } from "./lock.js";
import { modeRefusal, setPolicyEditing } from "./policy-mode.js";
import { Router, check, queryObject } from "./router.js";
import { RunManager } from "./runs.js";
import {
  BootstrapStore,
  CONTROL_HEADER,
  CSRF_HEADER,
  SessionStore,
  allowedHosts,
  allowedOrigins,
  cookieName,
  randomToken,
  readCookie,
  safeEqual,
} from "./security.js";
import type { HtmlResult, RouteResult, ServerContext, ServerLimits, ServerWorkspace, StaticHandler } from "./types.js";

export * from "./types.js";
export { lockFile } from "./lock.js";

const t = translator("server");

export const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

export const DEFAULT_LIMITS: ServerLimits = {
  maxBody: 64 * 1024,
  maxConcurrent: 32,
  handlerTimeoutMs: 30_000,
  bootstrapTtlMs: 10 * 60_000,
  sessionIdleMs: 12 * 60 * 60_000,
  maxSessions: 16,
};

const MUTATIONS = new Set(["POST", "PUT", "DELETE", "PATCH"]);
const RESERVED_PREFIXES = ["/api/", "/session/", "/control/"];

/** Expected failure of `jgates ui` (the CLI maps the code to a message of the "server" catalog). */
export class UiError extends Error {
  constructor(
    readonly code: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(code);
    this.name = "UiError";
  }
}

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

export function serverDirOf(home: string, wsId: string): string {
  return path.join(workspaceDir(home, wsId), "server");
}

export const SERVER_LOG = "server.log";

async function loadStatic(): Promise<StaticHandler | null> {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "static.js");
  if (!fs.existsSync(file)) return null;
  const mod = (await import(pathToFileURL(file).href)) as { serveStatic?: unknown };
  return typeof mod.serveStatic === "function" ? (mod.serveStatic as StaticHandler) : null;
}

function placeholderPage(): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>JGates</title></head><body><p>${escapeHtml(t("server_ui_not_built"))}</p></body></html>\n`;
}

function messagePage(text: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>JGates</title></head><body><p>${escapeHtml(text)}</p></body></html>\n`;
}

export interface StartOptions {
  projectDir: string;
  workspace: ServerWorkspace;
  home: string;
  version: string;
  host?: LoopbackHost;
  /** 0 picks a free port. */
  port?: number;
  limits?: Partial<ServerLimits>;
  env?: NodeJS.ProcessEnv;
  /** The folder is a CI policy being edited, not a project (see policy-mode.ts). */
  policyMode?: boolean;
}

export interface RunningServer {
  context: ServerContext;
  /** Stops accepting requests, stops running jobs and removes pending launchers. */
  close(): Promise<void>;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(refuse(503, "TIMEOUT", { seconds: Math.round(ms / 1000) })), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function send(res: ServerResponse, result: RouteResult, head: boolean): void {
  if ("html" in result) sendBody(res, result.status, "text/html; charset=utf-8", (result as HtmlResult).html, result.headers ?? {}, head);
  else sendJson(res, result.status, result.json, result.headers ?? {});
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const host: LoopbackHost = opts.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.includes(host)) throw new UiError("HOST_NOT_LOOPBACK", { host });
  const limits: ServerLimits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const router = await Router.load();
  const serveStatic = await loadStatic();
  const policyMode = opts.policyMode === true;

  ensureWorkspaceDirs(opts.home, opts.workspace.id);
  const serverDir = serverDirOf(opts.home, opts.workspace.id);
  mkdirPrivate(serverDir);
  const logFile = path.join(serverDir, SERVER_LOG);
  const log = (line: string) => {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // Logging never breaks a request.
    }
  };

  const server = http.createServer({ requestTimeout: 60_000, headersTimeout: 15_000, keepAliveTimeout: 5_000, maxHeaderSize: 16 * 1024 });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") reject(new UiError("PORT_IN_USE", { port: opts.port ?? 0 }));
      else if (error.code === "EACCES") reject(new UiError("PORT_DENIED", { port: opts.port ?? 0 }));
      else reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port: opts.port ?? 0, exclusive: true });
  });
  if (policyMode) setPolicyEditing(opts.projectDir);
  const address = server.address() as AddressInfo;
  const port = address.port;
  const hosts = allowedHosts(host, port);
  const origins = allowedOrigins(host, port);
  const baseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${port}/`;

  const bootstrap = new BootstrapStore(limits.bootstrapTtlMs);
  const context: ServerContext = {
    projectDir: opts.projectDir,
    policyMode,
    workspace: opts.workspace,
    home: opts.home,
    version: opts.version,
    host,
    port,
    serverDir,
    limits,
    sessions: new SessionStore(limits.sessionIdleMs, limits.maxSessions),
    bootstrap,
    controlToken: randomToken(),
    plans: new Map(),
    runs: new RunManager({ projectDir: opts.projectDir, plansDir: path.join(serverDir, "plans"), env: opts.env ?? process.env, log }),
    baseUrl,
    issueLauncher() {
      const file = path.join(serverDir, `launch-${crypto.randomBytes(6).toString("hex")}.html`);
      const { secret } = bootstrap.issue(() => fs.rmSync(file, { force: true }));
      const url = escapeHtml(`${baseUrl}session/bootstrap?token=${secret}`);
      const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${url}"><title>JGates</title></head><body><p><a href="${url}">${escapeHtml(t("server_launcher_link"))}</a></p></body></html>\n`;
      fs.writeFileSync(file, html, { mode: 0o600 });
      return file;
    },
    log,
  };

  let inFlight = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const method = (req.method ?? "GET").toUpperCase();
    let pathname = "/";
    res.on("finish", () => log(`${method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`));
    let counted = false;
    try {
      // Host first: a name that is not this loopback server (DNS rebinding) gets nothing, not even a 404.
      const hostHeader = (req.headers.host ?? "").toLowerCase();
      if (!hosts.has(hostHeader)) throw refuse(421, "HOST_NOT_ALLOWED");
      const rawUrl = req.url ?? "/";
      if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) throw refuse(400, "INPUT_INVALID", { detail: "url" });
      const url = new URL(rawUrl, baseUrl);
      pathname = url.pathname;

      if (inFlight >= limits.maxConcurrent) throw refuse(503, "BUSY");
      inFlight++;
      counted = true;

      const origin = req.headers.origin;
      const fetchSite = req.headers["sec-fetch-site"];
      const mutation = MUTATIONS.has(method);
      const sessionOf = () => context.sessions.find(readCookie(req, cookieName(port)));

      if (!RESERVED_PREFIXES.some((p) => pathname.startsWith(p))) {
        // UI assets: read-only, session required.
        if (method !== "GET" && method !== "HEAD") throw refuse(405, "METHOD_NOT_ALLOWED", {}, {}, { Allow: "GET, HEAD" });
        if (origin !== undefined && !origins.has(origin)) throw refuse(403, "ORIGIN_NOT_ALLOWED");
        if (!sessionOf()) {
          sendBody(res, 401, "text/html; charset=utf-8", messagePage(t("server_session_required_page")), {}, method === "HEAD");
          return;
        }
        const asset = serveStatic ? await serveStatic(pathname) : null;
        if (asset) {
          sendBody(res, asset.status ?? 200, asset.contentType, asset.body, asset.cacheControl ? { "Cache-Control": asset.cacheControl } : {}, method === "HEAD");
          return;
        }
        if (!serveStatic && pathname === "/") {
          sendBody(res, 200, "text/html; charset=utf-8", placeholderPage(), {}, method === "HEAD");
          return;
        }
        throw refuse(404, "NOT_FOUND");
      }

      const found = router.match(method, pathname);
      if (found === null) throw refuse(404, "NOT_FOUND");
      if ("allowed" in found) throw refuse(405, "METHOD_NOT_ALLOWED", {}, {}, { Allow: found.allowed.join(", ") });
      const { route, params } = found;
      const auth = route.def.auth ?? "session";

      let session = null;
      if (auth === "control") {
        // Only the CLI talks to the control channel: anything a browser sends (Origin, Sec-Fetch-*) is refused.
        if (origin !== undefined || fetchSite !== undefined) throw refuse(403, "ORIGIN_NOT_ALLOWED");
        const token = req.headers[CONTROL_HEADER];
        if (typeof token !== "string" || !safeEqual(token, context.controlToken)) throw refuse(403, "CONTROL_INVALID");
      } else {
        if (origin !== undefined && !origins.has(origin)) throw refuse(403, "ORIGIN_NOT_ALLOWED");
        if (mutation && origin === undefined) throw refuse(403, "ORIGIN_REQUIRED");
        if (auth === "session") {
          if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none") throw refuse(403, "ORIGIN_NOT_ALLOWED");
          session = sessionOf();
          if (!session) throw refuse(401, "SESSION_REQUIRED");
          if (mutation) {
            const csrf = req.headers[CSRF_HEADER];
            if (typeof csrf !== "string" || !safeEqual(csrf, session.csrfToken)) throw refuse(403, "CSRF_INVALID");
          }
        }
      }

      // The mode may refuse the route: a governed project cannot write its configuration, a policy folder is not a project.
      const modeError = modeRefusal(method, route.def.path);
      if (modeError) throw modeError;

      const raw = await readBody(req, route.def.maxBody ?? limits.maxBody);
      let body: unknown = undefined;
      if (route.body) {
        const type = String(req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
        if (type !== "application/json") throw refuse(415, "UNSUPPORTED_MEDIA_TYPE");
        try {
          body = JSON.parse(raw.toString("utf8")) as unknown;
        } catch {
          throw refuse(400, "INPUT_INVALID", { detail: "body: not JSON" });
        }
        check(route.body, body, "body");
      } else if (raw.length > 0) throw refuse(400, "INPUT_INVALID", { detail: "body: not allowed" });
      const query = queryObject(url.searchParams);
      check(route.query, query, "query");
      check(route.params, params, "params");

      const result = await withTimeout(
        Promise.resolve().then(() => route.def.handler({ params, query, body, session, server: context, raw: req })),
        route.def.timeoutMs ?? limits.handlerTimeoutMs,
      );
      send(res, result, method === "HEAD");
    } catch (error) {
      if (error instanceof HttpError) sendError(res, error);
      else {
        log(`error ${pathname}: ${error instanceof Error ? error.name : "unknown"}`);
        sendError(res, refuse(500, "INTERNAL"));
      }
    } finally {
      if (counted) inFlight--;
    }
  };
  server.on("request", (req: IncomingMessage, res: ServerResponse) => void handle(req, res));
  log(`started ${host}:${port} workspace ${opts.workspace.id}`);

  let closing: Promise<void> | null = null;
  return {
    context,
    close() {
      closing ??= new Promise<void>((resolve) => {
        if (policyMode) setPolicyEditing(null);
        context.runs.shutdown();
        bootstrap.clear();
        server.close(() => resolve());
        server.closeAllConnections();
        log("stopped");
      });
      return closing;
    },
  };
}

export interface LaunchOptions {
  projectDir: string;
  version: string;
  home?: string;
  host?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  limits?: Partial<ServerLimits>;
  /** `projectDir` is a CI policy folder to edit (jgates ui --policy). */
  policyMode?: boolean;
}

export type LaunchOutcome =
  | { kind: "started"; server: RunningServer; launcher: string; url: string; host: string; port: number; pid: number; workspace: ServerWorkspace; log: string; stop(): Promise<void> }
  | { kind: "reused"; launcher: string; url: string; host: string; port: number; pid: number; workspace: ServerWorkspace; log: string };

/**
 * Starts the server of a workspace, or reuses the one already open for it: the second call gets a fresh launcher
 * from the running server through the control channel. A lock whose server does not answer is replaced.
 */
export async function launchUi(opts: LaunchOptions): Promise<LaunchOutcome> {
  const requested = opts.host ?? "127.0.0.1";
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(requested)) throw new UiError("HOST_NOT_LOOPBACK", { host: requested });
  const host = requested as LoopbackHost;
  const home = opts.home ?? resolveHome({ env: opts.env ?? process.env });
  const entry = registerWorkspace(opts.projectDir, { home });
  const workspace: ServerWorkspace = { id: entry.id, path: entry.path, name: entry.name };
  const file = lockFile(home, workspace.id);
  const logPath = path.join(serverDirOf(home, workspace.id), SERVER_LOG);

  for (let attempt = 0; attempt < 5; attempt++) {
    const current = readLock(file);
    if (current.kind === "corrupt") {
      // A lock being written right now is younger than a few seconds; an older unreadable one is stale.
      if (current.ageMs < 5000) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      removeLockIfSame(file, current.raw);
      continue;
    }
    if (current.kind === "lock") {
      const answer = await requestLauncher(current.lock);
      if (answer.kind === "ok") {
        const base = `http://${current.lock.host.includes(":") ? `[${current.lock.host}]` : current.lock.host}:${current.lock.port}/`;
        return { kind: "reused", launcher: answer.launcher, url: base, host: current.lock.host, port: current.lock.port, pid: answer.pid, workspace, log: logPath };
      }
      if (answer.kind === "timeout" && processAlive(current.lock.pid)) throw new UiError("SERVER_UNRESPONSIVE", { port: current.lock.port, lock: file });
      // Nobody answers on that port with this lock's token: the lock is stale.
      removeLockIfSame(file, current.raw);
      continue;
    }

    const server = await startServer({
      projectDir: workspace.path,
      workspace,
      home,
      version: opts.version,
      host,
      port: opts.port ?? 0,
      ...(opts.limits ? { limits: opts.limits } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.policyMode ? { policyMode: true } : {}),
    });
    const lock: ServerLock = {
      schemaVersion: 1,
      pid: process.pid,
      host,
      port: server.context.port,
      controlToken: server.context.controlToken,
      startedAt: new Date().toISOString(),
      version: opts.version,
    };
    if (!tryCreateLock(file, lock)) {
      // Another `jgates ui` won the race: use its server instead.
      await server.close();
      continue;
    }
    const raw = fs.readFileSync(file, "utf8");
    const launcher = server.context.issueLauncher();
    return {
      kind: "started",
      server,
      launcher,
      url: server.context.baseUrl,
      host,
      port: server.context.port,
      pid: process.pid,
      workspace,
      log: logPath,
      async stop() {
        await server.close();
        removeLockIfSame(file, raw);
      },
    };
  }
  throw new UiError("LOCK_CONTENDED", { lock: file });
}
