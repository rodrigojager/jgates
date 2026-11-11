// Compose files of a project, read without running anything (PLAN-services.md section 2): which compose files exist,
// and for every service its image or build context, its ports, healthcheck, dependencies, profiles and bind mounts,
// plus the settings that reach the host (bind mounts of host paths, privileged, network_mode/pid host, devices,
// cap_add), so the review can list them and a governed run can refuse them. Nothing here talks to the engine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";

/** The compose files Compose itself looks for, in its order of preference. */
export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"] as const;
/** Override files (`compose.test.yaml`, `docker-compose.override.yml`...). */
const OVERRIDE_FILE = /^(?:docker-)?compose\.[A-Za-z0-9_.-]+\.ya?ml$/;
const MAX_BYTES = 1024 * 1024;

export type HostEffectKind = "bind-mount" | "privileged" | "network-host" | "pid-host" | "device" | "cap-add";
export const HOST_EFFECT_KINDS: readonly HostEffectKind[] = ["bind-mount", "privileged", "network-host", "pid-host", "device", "cap-add"];

/** A setting of a service that reaches the host. */
export interface HostEffect {
  service: string;
  kind: HostEffectKind;
  /** What exactly: `./data -> /var/lib/data`, `SYS_ADMIN`, `/dev/fuse`... */
  detail: string;
  /** bind-mount only: the host path is inside the project folder (JGates mounts it read-only). */
  insideProject?: boolean;
}

export interface ComposeBind {
  /** The source as written. */
  source: string;
  /** Absolute host path; null when it cannot be known without the environment (`${VAR}`). */
  resolved: string | null;
  target: string;
  readOnly: boolean;
  insideProject: boolean;
}

export interface ComposeService {
  name: string;
  /** Project-relative compose file that declares it (the first one). */
  file: string;
  image: string | null;
  build: { context: string; dockerfile: string | null } | null;
  /** Published ports (`host:container`, or the container port when the host side is chosen by the engine). */
  ports: Array<{ published: string | null; target: string }>;
  expose: string[];
  healthcheck: boolean;
  dependsOn: string[];
  profiles: string[];
  binds: ComposeBind[];
  hostEffects: HostEffect[];
  /** Suggested role: a well-known data store is a dependency, a project build with a published port the application. */
  role: "dependency" | "application" | null;
}

export interface ComposeDiscovery {
  /** Project-relative compose files that were read, in order. */
  files: string[];
  services: ComposeService[];
  /** Named volumes the files declare at top level (not the external ones). */
  volumes: string[];
  /** Files that could not be read or parsed (file: message). */
  problems: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string | number => typeof x === "string" || typeof x === "number").map(String) : []);
const DEPENDENCY_IMAGE = /(?:^|\/)(?:postgres|postgis|mysql|mariadb|mongo|mongodb|redis|valkey|memcached|rabbitmq|elasticsearch|opensearch|kafka|zookeeper|minio|mssql\/server|cassandra|neo4j|nats|localstack)(?:[:@]|$)/i;

/** The compose files of a project root: the base files Compose looks for and the `compose.*.yaml` overrides. */
export function listComposeFiles(projectDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(projectDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
  const base = COMPOSE_FILES.filter((f) => names.includes(f));
  const overrides = names.filter((n) => OVERRIDE_FILE.test(n) && !(COMPOSE_FILES as readonly string[]).includes(n)).sort();
  return [...base, ...overrides];
}

function insideOf(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The host path of a bind source, relative to the compose file's folder; null when it depends on the environment. */
function resolveSource(source: string, fileDir: string): string | null {
  if (source.includes("$")) return null;
  if (source === "~" || source.startsWith("~/")) return path.join(os.homedir(), source.slice(1));
  if (path.isAbsolute(source) || /^[A-Za-z]:[\\/]/.test(source)) return path.resolve(source);
  return path.resolve(fileDir, source);
}

/** Splits a short volume spec (`src:dst[:mode]`), keeping a Windows drive letter with its path. */
function splitShort(spec: string): { source: string | null; target: string; mode: string } {
  const drive = /^[A-Za-z]:[\\/]/.test(spec) ? spec.slice(0, 2) : "";
  const parts = spec.slice(drive.length).split(":");
  if (parts.length === 1) return { source: null, target: drive + (parts[0] ?? ""), mode: "" };
  return { source: drive + (parts[0] ?? ""), target: parts[1] ?? "", mode: parts.slice(2).join(":") };
}

const looksLikePath = (s: string): boolean => s.startsWith(".") || s.startsWith("/") || s.startsWith("~") || s.includes("$") || /^[A-Za-z]:[\\/]/.test(s) || s.includes("/") || s.includes("\\");

function bindsOf(volumes: unknown, fileDir: string, projectDir: string): ComposeBind[] {
  const out: ComposeBind[] = [];
  for (const entry of Array.isArray(volumes) ? volumes : []) {
    let source: string | null = null;
    let target = "";
    let readOnly = false;
    if (typeof entry === "string") {
      const parts = splitShort(entry);
      if (!parts.source || !looksLikePath(parts.source)) continue;
      source = parts.source;
      target = parts.target;
      readOnly = parts.mode.split(",").includes("ro");
    } else if (isRecord(entry) && entry.type === "bind" && typeof entry.source === "string" && typeof entry.target === "string") {
      source = entry.source;
      target = entry.target;
      readOnly = entry.read_only === true;
    } else continue;
    const resolved = resolveSource(source, fileDir);
    out.push({ source, resolved, target, readOnly, insideProject: resolved !== null && insideOf(projectDir, resolved) });
  }
  return out;
}

function portsOf(ports: unknown): ComposeService["ports"] {
  const out: ComposeService["ports"] = [];
  for (const p of Array.isArray(ports) ? ports : []) {
    if (typeof p === "number") out.push({ published: null, target: String(p) });
    else if (typeof p === "string") {
      const parts = p.split(":");
      const target = parts[parts.length - 1] ?? p;
      out.push({ published: parts.length > 1 ? parts.slice(0, -1).join(":") : null, target });
    } else if (isRecord(p) && p.target !== undefined) out.push({ published: p.published === undefined ? null : String(p.published), target: String(p.target) });
  }
  return out;
}

function dependsOf(value: unknown): string[] {
  if (Array.isArray(value)) return asStrings(value);
  if (isRecord(value)) return Object.keys(value);
  return [];
}

function buildOf(value: unknown): ComposeService["build"] {
  if (typeof value === "string") return { context: value, dockerfile: null };
  if (isRecord(value)) return { context: typeof value.context === "string" ? value.context : ".", dockerfile: typeof value.dockerfile === "string" ? value.dockerfile : null };
  return null;
}

function healthOf(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.disable === true) return false;
  const test = value.test;
  if (Array.isArray(test) && test[0] === "NONE") return false;
  return test !== undefined;
}

/** The host effects of one service (bind mounts, privileged, host network or pid namespace, devices, added capabilities). */
export function hostEffectsOf(name: string, body: Record<string, unknown>, binds: ComposeBind[]): HostEffect[] {
  const effects: HostEffect[] = [];
  for (const b of binds) effects.push({ service: name, kind: "bind-mount", detail: `${b.source} -> ${b.target}${b.readOnly ? " (ro)" : ""}`, insideProject: b.insideProject });
  if (body.privileged === true) effects.push({ service: name, kind: "privileged", detail: "privileged: true" });
  if (body.network_mode === "host") effects.push({ service: name, kind: "network-host", detail: "network_mode: host" });
  if (body.pid === "host") effects.push({ service: name, kind: "pid-host", detail: "pid: host" });
  for (const d of Array.isArray(body.devices) ? body.devices : []) effects.push({ service: name, kind: "device", detail: typeof d === "string" ? d : JSON.stringify(d) });
  for (const c of asStrings(body.cap_add)) effects.push({ service: name, kind: "cap-add", detail: c });
  return effects;
}

/** Later files override scalar settings of a service and add to its lists, like Compose merges them. */
function mergeService(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...next };
  for (const key of ["volumes", "ports", "expose", "devices", "cap_add", "profiles"]) {
    if (Array.isArray(base[key]) && Array.isArray(next[key])) merged[key] = [...(base[key] as unknown[]), ...(next[key] as unknown[])];
  }
  return merged;
}

function readCompose(absolute: string): { value: Record<string, unknown> | null; problem: string | null } {
  let text: string;
  try {
    if (fs.statSync(absolute).size > MAX_BYTES) return { value: null, problem: "the file is larger than 1 MB" };
    text = fs.readFileSync(absolute, "utf8");
  } catch (error) {
    return { value: null, problem: (error as Error).message };
  }
  try {
    // Compose's own YAML: merge keys (<<) and anchors are allowed; custom tags (!reset, !override) only warn.
    const doc = parseDocument(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, { schema: "core", merge: true, uniqueKeys: true, prettyErrors: false });
    if (doc.errors.length > 0) return { value: null, problem: doc.errors[0]?.message.split("\n")[0] ?? "invalid YAML" };
    const value = doc.toJS({ maxAliasCount: 100 }) as unknown;
    return isRecord(value) ? { value, problem: null } : { value: null, problem: "the file is not a mapping" };
  } catch (error) {
    return { value: null, problem: (error as Error).message };
  }
}

/**
 * Reads the compose files of a project (the given project-relative files in order, or the ones Compose would find) and
 * describes their services. Never runs Compose and never throws: unreadable files are listed in `problems`.
 */
export function discoverCompose(projectDir: string, files?: string[]): ComposeDiscovery {
  const root = path.resolve(projectDir);
  const chosen = files && files.length > 0 ? files : listComposeFiles(root);
  const problems: string[] = [];
  const bodies = new Map<string, { body: Record<string, unknown>; file: string; fileDir: string }>();
  const volumes = new Set<string>();
  const read: string[] = [];
  for (const file of chosen) {
    const absolute = path.resolve(root, file);
    const { value, problem } = readCompose(absolute);
    if (!value) {
      problems.push(`${file}: ${problem ?? "unreadable"}`);
      continue;
    }
    read.push(file.split(path.sep).join("/"));
    // External volumes are not the project's: they are never labelled or removed.
    if (isRecord(value.volumes)) for (const [v, spec] of Object.entries(value.volumes)) if (!(isRecord(spec) && spec.external)) volumes.add(v);
    if (!isRecord(value.services)) continue;
    for (const [name, body] of Object.entries(value.services)) {
      if (!isRecord(body)) continue;
      const known = bodies.get(name);
      bodies.set(name, known ? { ...known, body: mergeService(known.body, body) } : { body, file: file.split(path.sep).join("/"), fileDir: path.dirname(absolute) });
    }
  }
  const services: ComposeService[] = [];
  for (const [name, { body, file, fileDir }] of [...bodies.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const binds = bindsOf(body.volumes, fileDir, root);
    const image = typeof body.image === "string" ? body.image : null;
    const build = buildOf(body.build);
    const ports = portsOf(body.ports);
    const role = image && DEPENDENCY_IMAGE.test(image) ? "dependency" : build && ports.length > 0 ? "application" : null;
    services.push({
      name,
      file,
      image,
      build,
      ports,
      expose: asStrings(body.expose),
      healthcheck: healthOf(body.healthcheck),
      dependsOn: dependsOf(body.depends_on),
      profiles: asStrings(body.profiles),
      binds,
      hostEffects: hostEffectsOf(name, body, binds),
      role,
    });
  }
  return { files: read, services, volumes: [...volumes].sort(), problems };
}

/** The services a selection needs: the named ones and everything they depend on, in a stable order. */
export function withDependencies(discovery: Pick<ComposeDiscovery, "services">, names: string[]): string[] {
  const byName = new Map(discovery.services.map((s) => [s.name, s]));
  const out = new Set<string>();
  const visit = (name: string): void => {
    if (out.has(name)) return;
    out.add(name);
    for (const dep of byName.get(name)?.dependsOn ?? []) visit(dep);
  };
  names.forEach(visit);
  return [...out].sort();
}
