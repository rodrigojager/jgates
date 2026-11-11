// The `services:` section of jgates.yml (PLAN-services.md section 3) and the `service:<name>:<port>` targets of the
// runtime checks. The schema (schemas/config/jgates.schema.json) validates the section when the configuration loads;
// this reader applies the defaults and never throws.
import fs from "node:fs";
import path from "node:path";
import { parseYamlFile } from "../config/load/yaml.js";
import { HOST_EFFECT_KINDS, type HostEffectKind } from "../discovery/compose.js";

export interface ServicesTarget {
  service: string;
  port: number;
  /** Base path of the application ("/" by default). */
  path: string;
  /** Path polled until the application answers (2xx or 3xx); null: only the compose healthchecks are waited for. */
  health: string | null;
}

export interface ServicesConfig {
  /** Project-relative compose files, in order; empty: the files Compose itself would find. */
  compose: string[];
  profiles: string[];
  /** Services to start; null: those the checks need (the target and the services the checks name). */
  start: string[] | null;
  target: ServicesTarget | null;
  /** May compose build images from the project's Dockerfiles. */
  build: "allow" | "forbid";
  /** Services allowed to write to the project folder (their project bind mounts stay writable; refused when governed). */
  writableBinds: string[];
  /** Host effects a governed run accepts (the policy's own jgates.yml decides). */
  allowHostEffects: HostEffectKind[];
  /** Seconds to wait for the healthchecks and for the target's health path. */
  timeoutSeconds: number;
}

export const DEFAULT_SERVICES_TIMEOUT_SECONDS = 120;
/** The capabilities whose checks use the project's services (PLAN-services.md section 5). */
export const SERVICE_CAPABILITIES: readonly string[] = ["integration", "e2e", "api-contract", "dast", "migration"];

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

function urlPath(value: unknown, fallback: string | null): string | null {
  if (typeof value !== "string" || value === "") return fallback;
  return value.startsWith("/") ? value : `/${value}`;
}

/** Reads the `services:` section of jgates.yml in `configDir`; null when the file or the section is absent. */
export function readServicesConfig(configDir: string): ServicesConfig | null {
  const file = path.join(configDir, "jgates.yml");
  if (!fs.existsSync(file)) return null;
  const parsed = parseYamlFile(file, "jgates.yml");
  const root = parsed.value;
  if (!isRecord(root) || !isRecord(root.services)) return null;
  const s = root.services;
  let target: ServicesTarget | null = null;
  if (isRecord(s.target) && typeof s.target.service === "string" && SERVICE_NAME.test(s.target.service) && Number.isInteger(s.target.port)) {
    target = { service: s.target.service, port: s.target.port as number, path: urlPath(s.target.path, "/") ?? "/", health: urlPath(s.target.health, null) };
  }
  const timeout = typeof s.timeoutSeconds === "number" && Number.isInteger(s.timeoutSeconds) && s.timeoutSeconds > 0 ? s.timeoutSeconds : DEFAULT_SERVICES_TIMEOUT_SECONDS;
  return {
    compose: names(s.compose),
    profiles: names(s.profiles),
    start: Array.isArray(s.start) ? names(s.start).filter((n) => SERVICE_NAME.test(n)) : null,
    target,
    build: s.build === "allow" ? "allow" : "forbid",
    writableBinds: names(s.writableBinds),
    allowHostEffects: names(s.allowHostEffects).filter((k): k is HostEffectKind => (HOST_EFFECT_KINDS as readonly string[]).includes(k)),
    timeoutSeconds: timeout,
  };
}

export interface ServiceTarget {
  service: string;
  port: number;
  /** Base path, "" when none. */
  path: string;
  /** The URL a step on the services network uses (`http://api:8000/base`). */
  url: string;
}

const SERVICE_TARGET = /^service:([A-Za-z0-9][A-Za-z0-9_.-]*):(\d{1,5})(\/[^\s?#]*)?$/;

/** Parses `service:<name>:<port>[/path]`; null when the value is not one. */
export function parseServiceTarget(value: unknown): ServiceTarget | null {
  if (typeof value !== "string") return null;
  const match = SERVICE_TARGET.exec(value.trim());
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  const base = (match[3] ?? "").replace(/\/+$/, "");
  const service = match[1] as string;
  return { service, port, path: base, url: `http://${service}:${port}${base}` };
}

/** Whether a value is written as a service target, valid or not (so a typo is reported, not taken for a URL). */
export function looksLikeServiceTarget(value: unknown): boolean {
  return typeof value === "string" && value.trim().startsWith("service:");
}

/** `jgates-<ws>-<run>`: the compose project of a run (lowercase, only the characters Compose accepts). */
export function servicesProjectName(workspace: string, runId: string): string {
  return `jgates-${workspace}-${runId}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

/** The network Compose creates for the project's default network; the steps that need services join it. */
export function servicesNetworkName(project: string): string {
  return `${project}_default`;
}
