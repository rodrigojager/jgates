// Settings shared by the runtime API checks (Schemathesis, ZAP): the target base URL and the authentication header.
// A runtime check runs only against an explicit target; without one the stage is blocked, never passed. The secret of
// the authentication header is never written in the configuration or the plan: the instance names the environment
// variable that holds it, and the run reads it from its own environment.
import { looksLikeServiceTarget, parseServiceTarget } from "../../core/services/config.js";

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The body of one tool instance (tools.<id>) of the resolved configuration, or an empty object. */
export function instanceBody(config: unknown, tool: string): Record<string, unknown> {
  const tools = isRec(config) && isRec(config.tools) ? config.tools : {};
  return isRec(tools[tool]) ? (tools[tool] as Record<string, unknown>) : {};
}

export interface TargetCheck {
  /** The normalized base URL (no trailing slash), or null. */
  url: string | null;
  /** Why the value is not a usable target ("missing" when unset). */
  problem: "missing" | "invalid" | null;
  /**
   * The compose service of a `service:<name>:<port>[/path]` target: the run starts it and the step reaches it on the
   * run's services network as `http://<name>:<port>` (url).
   */
  service?: { name: string; port: number; path: string } | null;
}

/** An http(s) base URL with a host, without credentials, query or fragment, or a `service:<name>:<port>` target. */
export function checkTarget(value: unknown): TargetCheck {
  if (value === undefined || value === null || value === "") return { url: null, problem: "missing" };
  if (looksLikeServiceTarget(value)) {
    const service = parseServiceTarget(value);
    return service ? { url: service.url, problem: null, service: { name: service.service, port: service.port, path: service.path } } : { url: null, problem: "invalid" };
  }
  if (typeof value !== "string") return { url: null, problem: "invalid" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { url: null, problem: "invalid" };
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    return { url: null, problem: "invalid" };
  }
  return { url: parsed.toString().replace(/\/+$/, ""), problem: null };
}

/** Whether the host of a URL is the local machine (loopback names and addresses). */
export function isLoopbackHost(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export interface AuthSetting {
  /** HTTP header name (Authorization, X-Api-Key...). */
  header: string;
  /** Environment variable whose value is the whole header value. */
  valueEnv: string;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reads `auth: { header, valueEnv }`; undefined is "no authentication", anything malformed is a problem. */
export function readAuth(value: unknown): { auth: AuthSetting | null; problem: boolean } {
  if (value === undefined) return { auth: null, problem: false };
  if (!isRec(value)) return { auth: null, problem: true };
  const header = value.header;
  const valueEnv = value.valueEnv;
  const extra = Object.keys(value).filter((k) => k !== "header" && k !== "valueEnv");
  if (typeof header !== "string" || !HEADER_NAME.test(header) || typeof valueEnv !== "string" || !ENV_NAME.test(valueEnv) || extra.length > 0) return { auth: null, problem: true };
  return { auth: { header, valueEnv }, problem: false };
}

/** A positive integer setting within [min, max], or the fallback when unset; null when present and invalid. */
export function intSetting(value: unknown, fallback: number | null, min: number, max: number): number | null | "invalid" {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return "invalid";
  return value;
}

/** A relative path that stays inside its root. */
export function safeRelative(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.replace(/\\/g, "/").split("/");
  return !parts.includes("..") && !parts.some((p) => p === "");
}
