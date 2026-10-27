import type { IncomingMessage } from "node:http";
import type { Plan } from "../core/plan/index.js";
import type { RunManager } from "./runs.js";
import type { BootstrapStore, Session, SessionStore } from "./security.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Who may call a route: a browser session (the default), the one-time bootstrap exchange, or the local control channel. */
export type RouteAuth = "session" | "bootstrap" | "control";

export interface ServerLimits {
  /** Largest request body accepted by a route that does not declare its own (bytes). */
  maxBody: number;
  /** Requests handled at the same time; the next one gets 503 BUSY. */
  maxConcurrent: number;
  /** Time a route handler may take before the request gets 503 TIMEOUT (ms). */
  handlerTimeoutMs: number;
  /** Lifetime of a bootstrap secret (ms). */
  bootstrapTtlMs: number;
  /** Idle lifetime of a browser session (ms). */
  sessionIdleMs: number;
  /** Sessions kept at the same time (the oldest is dropped). */
  maxSessions: number;
}

export interface ServerWorkspace {
  id: string;
  path: string;
  name: string;
}

/** State shared by every route of one server (one server serves exactly one workspace). */
export interface ServerContext {
  /** The folder the screens edit: the project, or the CI policy folder in policy mode. */
  projectDir: string;
  /** True when `projectDir` is a CI policy being edited (`jgates ui --policy`). */
  policyMode: boolean;
  workspace: ServerWorkspace;
  home: string;
  version: string;
  host: string;
  port: number;
  /** <home>/workspaces/<id>/server: log, launcher files and plans handed to runs (0700). */
  serverDir: string;
  limits: ServerLimits;
  sessions: SessionStore;
  bootstrap: BootstrapStore;
  /** Token of the local control channel (also written in the 0600 lock file). */
  controlToken: string;
  /** Plans built by this server, by planHash. */
  plans: Map<string, Plan>;
  runs: RunManager;
  /** Base URL without any secret, for example http://127.0.0.1:43123/. */
  baseUrl: string;
  /** Creates a new bootstrap secret and its launcher file; returns the launcher path. */
  issueLauncher(): string;
  /** Appends one line to the server log (never secrets: callers pass paths without query strings). */
  log(line: string): void;
}

export interface RouteRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  session: Session | null;
  server: ServerContext;
  raw: IncomingMessage;
}

export interface JsonResult {
  status: number;
  json: unknown;
  headers?: Record<string, string | string[]>;
}

export interface HtmlResult {
  status: number;
  html: string;
  headers?: Record<string, string | string[]>;
}

export type RouteResult = JsonResult | HtmlResult;

export interface RouteDefinition {
  method: HttpMethod;
  /** Path pattern, for example "/api/documents/:instance/:binding"; ":name" captures one decoded segment. */
  path: string;
  /** Defaults to "session". */
  auth?: RouteAuth;
  /** JSON Schemas (2020-12) of the captured segments, of the query string and of the JSON body. */
  params?: object;
  query?: object;
  /** Without a body schema the request must not carry a body. */
  body?: object;
  /** Largest body for this route (bytes); defaults to limits.maxBody. */
  maxBody?: number;
  /** Handler time limit (ms); defaults to limits.handlerTimeoutMs. */
  timeoutMs?: number;
  handler(request: RouteRequest): RouteResult | Promise<RouteResult>;
}

/** Shape of a module in src/server/routes/: it exports `routes`. */
export interface RouteModule {
  routes: RouteDefinition[];
}

/**
 * Mount point of the UI assets. When src/server/static.ts exists (the UI task creates it), it exports
 * `serveStatic: StaticHandler`; the server calls it for GET and HEAD outside /api, /session and /control, only with a
 * valid session, and sends the asset with the same security headers (CSP included) as every other response.
 */
export interface StaticAsset {
  status?: number;
  contentType: string;
  body: Buffer | string;
  cacheControl?: string;
}

export type StaticHandler = (pathname: string) => StaticAsset | null | Promise<StaticAsset | null>;
