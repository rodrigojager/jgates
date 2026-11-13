// Configuração > Serviços (PLAN-guided-ux.md section 8): the compose files and services of the project with the role of
// each one (dependency, application under test, not used), the host effects they carry, the application under test, a
// preview of the `services:` section (and of the ZAP/Schemathesis targets) as a diff of jgates.yml, the save, and a
// start-up test in an isolated compose project that is always taken down. The section is written with the YAML patcher
// at its own keys only; a file that moved meanwhile is a conflict, never overwritten.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { patchYamlText, readRevision, writeFileAtomic, YamlPatchError, type YamlEdit } from "../../core/codecs/yaml/index.js";
import { ROOT_FILE, parseYamlText, validateDocument } from "../../core/config/load/index.js";
import { discoverCompose, HOST_EFFECT_KINDS, listComposeFiles, withDependencies, type ComposeDiscovery, type ComposeService, type HostEffect } from "../../core/discovery/compose.js";
import { unifiedDiff } from "../../core/documents/diff.js";
import { composeDown, engineCommand, engineLabels, engineRuntime, inspectImageSync, runInEngine, type EngineContext } from "../../core/engine/index.js";
import { workspaceDir } from "../../core/home/index.js";
import { HEALTH_POLL, readServicesConfig, servicesOverride, servicesProjectName, DEFAULT_SERVICES_TIMEOUT_SECONDS, type ServicesConfig } from "../../core/services/index.js";
import { resolveToolBindings } from "../../core/tools/index.js";
import { toolsImageTarget } from "../../core/tools-image/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";

export type ServiceRole = "dependency" | "application" | "unused";
const ROLES: ServiceRole[] = ["dependency", "application", "unused"];
const SERVICE_NAME = "^[A-Za-z0-9][A-Za-z0-9_.-]*$";
/** The tools that take the application as their target (`tools.<id>.target` in jgates.yml). */
const TARGET_TOOLS = ["zap", "schemathesis"] as const;

interface SectionInput {
  compose: string[];
  roles: Record<string, ServiceRole>;
  target: { port: number; path?: string; health?: string } | null;
  build: "allow" | "forbid";
  writableBinds: string[];
  allowHostEffects: string[];
  timeoutSeconds: number;
  setTargets: boolean;
  /** The compose profiles to start (services.profiles); null: the screen leaves them as they are. */
  profiles: string[] | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (status: number, code: string, message: string, details: Record<string, unknown> = {}): HttpError => new HttpError(status, code, message, null, details);

const rootAbs = (server: ServerContext): string => path.join(server.projectDir, ROOT_FILE);
const ackFile = (server: ServerContext): string => path.join(workspaceDir(server.home, server.workspace.id), "services-ack.json");

function pathOf(value: string | undefined, fallback: string | null): string | null {
  if (value === undefined || value === "") return fallback;
  return value.startsWith("/") ? value : `/${value}`;
}

/** The role each service has now: the configuration says it, or (without `start`) the suggestion of the discovery. */
function currentRoles(discovery: ComposeDiscovery, config: ServicesConfig | null): Record<string, ServiceRole> {
  const out: Record<string, ServiceRole> = {};
  for (const s of discovery.services) {
    if (config?.target?.service === s.name) out[s.name] = "application";
    else if (config && config.start !== null) out[s.name] = config.start.includes(s.name) ? "dependency" : "unused";
    else out[s.name] = s.role === "application" ? "application" : "dependency";
  }
  return out;
}

/** Ports an application can listen on, from what the compose file says (published target ports and `expose`). */
function portsOf(service: ComposeService): number[] {
  const all = [...service.ports.map((p) => p.target), ...service.expose].map((p) => Number.parseInt(p.split("/")[0] ?? "", 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
  return [...new Set(all)].sort((a, b) => a - b);
}

function describe(discovery: ComposeDiscovery) {
  return {
    files: discovery.files,
    problems: discovery.problems,
    services: discovery.services.map((s) => ({
      name: s.name,
      file: s.file,
      image: s.image,
      build: s.build,
      ports: portsOf(s),
      healthcheck: s.healthcheck,
      dependsOn: s.dependsOn,
      profiles: s.profiles,
      role: s.role,
      hostEffects: s.hostEffects,
    })),
  };
}

/** The host effects of the services that start, as the user must acknowledge them (project bind mounts are read-only and need no word). */
function effectsOf(discovery: ComposeDiscovery, started: string[]): HostEffect[] {
  return discovery.services.filter((s) => started.includes(s.name)).flatMap((s) => s.hostEffects).filter((e) => !(e.kind === "bind-mount" && e.insideProject === true));
}

function effectsHash(compose: string[], effects: HostEffect[]): string {
  const rows = effects.map((e) => `${e.service}|${e.kind}|${e.detail}`).sort();
  return crypto.createHash("sha256").update(JSON.stringify({ compose, rows })).digest("hex").slice(0, 16);
}

function acknowledged(server: ServerContext): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ackFile(server), "utf8")) as { hash?: unknown };
    return typeof parsed.hash === "string" ? parsed.hash : null;
  } catch {
    return null;
  }
}

function startedOf(discovery: ComposeDiscovery, input: SectionInput): string[] {
  const names = new Set(discovery.services.map((s) => s.name));
  const wanted = Object.entries(input.roles).filter(([n, r]) => names.has(n) && r !== "unused").map(([n]) => n);
  return withDependencies(discovery, wanted).filter((n) => names.has(n));
}

function checkInput(discovery: ComposeDiscovery, input: SectionInput): { application: string | null } {
  const names = new Set(discovery.services.map((s) => s.name));
  for (const name of Object.keys(input.roles)) if (!names.has(name)) throw fail(422, "SERVICE_UNKNOWN", `The compose files have no service ${name}.`, { service: name });
  const applications = Object.entries(input.roles).filter(([, r]) => r === "application").map(([n]) => n);
  if (applications.length > 1) throw fail(422, "APPLICATION_MANY", "Only one service can be the application under test.", { services: applications });
  const application = applications[0] ?? null;
  if (application && !input.target) throw fail(422, "TARGET_PORT_REQUIRED", "Choose the port of the application under test.", { service: application });
  for (const w of input.writableBinds) if (!names.has(w)) throw fail(422, "SERVICE_UNKNOWN", `The compose files have no service ${w}.`, { service: w });
  return { application };
}

/** The `services:` mapping this input produces (defaults are left out so the file stays short). */
function sectionOf(input: SectionInput, discovery: ComposeDiscovery, application: string | null): Record<string, unknown> {
  const section: Record<string, unknown> = {};
  if (input.compose.length > 0) section.compose = input.compose;
  const started = Object.entries(input.roles).filter(([, r]) => r !== "unused").map(([n]) => n).sort();
  const unused = Object.values(input.roles).some((r) => r === "unused");
  const everything = discovery.services.length > 0 && started.length === discovery.services.length;
  if (unused || (started.length > 0 && !everything)) section.start = started;
  if (application && input.target) {
    const target: Record<string, unknown> = { service: application, port: input.target.port };
    const base = pathOf(input.target.path, null);
    const health = pathOf(input.target.health, null);
    if (base && base !== "/") target.path = base;
    if (health) target.health = health;
    section.target = target;
  }
  if (input.build === "allow") section.build = "allow";
  if (input.writableBinds.length > 0) section.writableBinds = [...input.writableBinds].sort();
  const allow = HOST_EFFECT_KINDS.filter((k) => input.allowHostEffects.includes(k));
  if (allow.length > 0) section.allowHostEffects = allow;
  if (input.timeoutSeconds !== DEFAULT_SERVICES_TIMEOUT_SECONDS) section.timeoutSeconds = input.timeoutSeconds;
  if (input.profiles && input.profiles.length > 0) section.profiles = input.profiles;
  return section;
}

/** The keys of `services:` this screen owns; every other key (profiles, hand-written ones) and its comments are never touched. */
const OWNED_KEYS = ["compose", "start", "target", "build", "writableBinds", "allowHostEffects", "timeoutSeconds"];

/**
 * Key-by-key edits that turn the current `services:` value into the section, leaving the keys the screen does not own
 * (`profiles` is owned only when the request carries it).
 */
function servicesEdits(current: unknown, section: Record<string, unknown>, owned: readonly string[] = OWNED_KEYS): YamlEdit[] {
  if (!isRecord(current)) return Object.keys(section).length > 0 ? [{ op: "set", path: ["services"], value: section }] : [];
  const edits: YamlEdit[] = [];
  for (const [key, value] of Object.entries(section)) if (JSON.stringify(current[key]) !== JSON.stringify(value)) edits.push({ op: "set", path: ["services", key], value });
  for (const key of owned) if (key in current && !(key in section)) edits.push({ op: "delete", path: ["services", key] });
  const remaining = new Set([...Object.keys(current).filter((k) => !owned.includes(k)), ...Object.keys(section)]);
  // Nothing left in the block: the block goes too, instead of `services: {}`.
  return remaining.size === 0 ? [{ op: "delete", path: ["services"] }] : edits;
}

/** The workspace-relative tools file (where the instances of zap and schemathesis live). */
function toolsFileOf(server: ServerContext): string {
  return resolveToolBindings(server.projectDir, { skipInventory: true }).configFile ?? ".jgates/tools.yml";
}

/** The current target of every zap and schemathesis instance of the tools file (null when it has none). */
function instanceTargets(server: ServerContext): Array<{ tool: string; target: string | null }> {
  const file = toolsFileOf(server);
  const rev = readRevision(path.join(server.projectDir, file));
  if (!rev.exists) return [];
  const parsed = parseYamlText(rev.text.charCodeAt(0) === 0xfeff ? rev.text.slice(1) : rev.text, file).value;
  const tools = isRecord(parsed) && isRecord(parsed.tools) ? parsed.tools : {};
  return Object.entries(tools)
    .filter(([, body]) => isRecord(body) && (TARGET_TOOLS as readonly string[]).includes(String(body.adapter)))
    .map(([tool, body]) => ({ tool, target: typeof (body as Record<string, unknown>).target === "string" ? ((body as Record<string, unknown>).target as string) : null }));
}

function targetText(application: string, target: { port: number; path?: string }): string {
  const base = pathOf(target.path, "") ?? "";
  return `service:${application}:${target.port}${base === "/" ? "" : base}`;
}

interface Preview {
  section: Record<string, unknown>;
  before: string;
  after: string;
  /** The tools file to write too, when "usar como alvo" changes instances. */
  tools: { file: string; absolute: string; hash: string | null; after: string } | null;
  diff: string;
  revision: string | null;
  targets: Array<{ tool: string; before: string | null; after: string }>;
  effects: HostEffect[];
  hash: string;
  confirmed: boolean;
}

function buildPreview(server: ServerContext, input: SectionInput): Preview {
  const root = readRevision(rootAbs(server));
  if (!root.exists) throw fail(409, "CONFIG_MISSING", "There is no jgates.yml yet: finish the guided setup first.");
  const discovery = discoverCompose(server.projectDir, input.compose);
  if (discovery.services.length === 0) throw fail(422, "COMPOSE_EMPTY", "The chosen compose files have no services.", { problems: discovery.problems });
  const { application } = checkInput(discovery, input);
  const section = sectionOf(input, discovery, application);
  const parsedRoot = parseYamlText(root.text.charCodeAt(0) === 0xfeff ? root.text.slice(1) : root.text, ROOT_FILE).value;
  const edits = servicesEdits(isRecord(parsedRoot) ? parsedRoot.services : undefined, section, input.profiles === null ? OWNED_KEYS : [...OWNED_KEYS, "profiles"]);
  // "usar como alvo": the existing instances of zap and schemathesis (tools.yml, under the ids the user gave them) get the target.
  const targets: Preview["targets"] = [];
  const toolsEdits: YamlEdit[] = [];
  const toolsFile = toolsFileOf(server);
  const toolsRev = readRevision(path.join(server.projectDir, toolsFile));
  if (application && input.target && input.setTargets && toolsRev.exists) {
    const parsed = parseYamlText(toolsRev.text.charCodeAt(0) === 0xfeff ? toolsRev.text.slice(1) : toolsRev.text, toolsFile).value;
    const tools = isRecord(parsed) && isRecord(parsed.tools) ? parsed.tools : {};
    const value = targetText(application, input.target);
    for (const instance of resolveToolBindings(server.projectDir, { skipInventory: true }).instances) {
      if (!(TARGET_TOOLS as readonly string[]).includes(instance.adapter)) continue;
      const body = tools[instance.id];
      if (!isRecord(body)) continue;
      const before = typeof body.target === "string" ? body.target : null;
      if (before === value) continue;
      toolsEdits.push({ op: "set", path: ["tools", instance.id, "target"], value });
      targets.push({ tool: instance.id, before, after: value });
    }
  }
  let after: string;
  let toolsAfter: string = toolsRev.text;
  try {
    after = patchYamlText(root.text, edits).text;
    if (toolsEdits.length > 0) toolsAfter = patchYamlText(toolsRev.text, toolsEdits).text;
  } catch (error) {
    if (error instanceof YamlPatchError) throw fail(422, "CONFIG_INVALID", error.message);
    throw error;
  }
  const checkText = (kind: "root" | "tools", text: string, file: string): void => {
    const checked = parseYamlText(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, file);
    const problems = [...checked.diagnostics, ...(checked.value === undefined ? [] : validateDocument(kind, checked.value, file, { doc: checked.doc, lineCounter: checked.lineCounter }))];
    if (problems.length > 0) throw fail(422, "CONFIG_INVALID", problems[0]?.message ?? "invalid configuration");
  };
  checkText("root", after, ROOT_FILE);
  if (toolsEdits.length > 0) checkText("tools", toolsAfter, toolsFile);
  const effects = effectsOf(discovery, startedOf(discovery, input));
  const hash = effectsHash(input.compose, effects);
  return {
    section,
    before: root.text,
    after,
    tools: toolsEdits.length > 0 ? { file: toolsFile, absolute: path.join(server.projectDir, toolsFile), hash: toolsRev.hash, after: toolsAfter } : null,
    diff: [
      unifiedDiff(root.text, after, { oldLabel: `a/${ROOT_FILE}`, newLabel: `b/${ROOT_FILE}` }),
      ...(toolsEdits.length > 0 ? [unifiedDiff(toolsRev.text, toolsAfter, { oldLabel: `a/${toolsFile}`, newLabel: `b/${toolsFile}` })] : []),
    ]
      .filter((d) => d !== "")
      .join("\n"),
    revision: root.hash,
    targets,
    effects,
    hash,
    confirmed: effects.length === 0 || acknowledged(server) === hash,
  };
}

const inputSchema = {
  type: "object",
  properties: {
    compose: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 512 } },
    roles: { type: "object", maxProperties: 256, additionalProperties: { type: "string", enum: ROLES }, propertyNames: { pattern: SERVICE_NAME } },
    target: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: { port: { type: "integer", minimum: 1, maximum: 65535 }, path: { type: "string", maxLength: 512, pattern: "^[^\\s?#]*$" }, health: { type: "string", maxLength: 512, pattern: "^[^\\s?#]*$" } },
          required: ["port"],
          additionalProperties: false,
        },
      ],
    },
    build: { type: "string", enum: ["allow", "forbid"] },
    writableBinds: { type: "array", maxItems: 256, uniqueItems: true, items: { type: "string", pattern: SERVICE_NAME } },
    allowHostEffects: { type: "array", maxItems: 16, items: { type: "string", enum: [...HOST_EFFECT_KINDS] } },
    timeoutSeconds: { type: "integer", minimum: 5, maximum: 3600 },
    setTargets: { type: "boolean" },
    profiles: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 } },
  },
  required: ["compose", "roles"],
  additionalProperties: false,
};

function inputOf(body: unknown): SectionInput {
  const b = body as Partial<SectionInput>;
  return {
    compose: b.compose ?? [],
    roles: b.roles ?? {},
    target: b.target ?? null,
    build: b.build ?? "forbid",
    writableBinds: b.writableBinds ?? [],
    allowHostEffects: b.allowHostEffects ?? [],
    timeoutSeconds: b.timeoutSeconds ?? DEFAULT_SERVICES_TIMEOUT_SECONDS,
    setTargets: b.setTargets === true,
    profiles: Array.isArray(b.profiles) ? b.profiles : null,
  };
}

/** Safe compose files: project-relative, inside the project, existing files. */
function checkFiles(server: ServerContext, files: string[]): void {
  const root = path.resolve(server.projectDir);
  for (const file of files) {
    const abs = path.resolve(root, file);
    const rel = path.relative(root, abs);
    if (path.isAbsolute(file) || rel.startsWith("..") || path.isAbsolute(rel)) throw fail(422, "COMPOSE_PATH_INVALID", `${file} is not inside the project.`, { file });
    let isFile = false;
    try {
      isFile = fs.statSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) throw fail(422, "COMPOSE_FILE_MISSING", `${file} does not exist in the project.`, { file });
  }
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/services",
    timeoutMs: 30_000,
    handler({ server }) {
      const config = readServicesConfig(server.projectDir);
      const found = listComposeFiles(server.projectDir);
      const selected = config && config.compose.length > 0 ? config.compose : found;
      const discovery = discoverCompose(server.projectDir, selected);
      const roles = currentRoles(discovery, config);
      const root = readRevision(rootAbs(server));
      const started = withDependencies(discovery, Object.entries(roles).filter(([, r]) => r !== "unused").map(([n]) => n));
      const effects = effectsOf(discovery, started);
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          configured: config !== null,
          configFile: root.exists,
          revision: root.hash,
          found,
          selected,
          config,
          roles,
          discovery: describe(discovery),
          acknowledged: effects.length === 0 || acknowledged(server) === effectsHash(selected, effects),
          tools: TARGET_TOOLS,
          // The targets the instances of those tools have now: "usar como alvo" starts unchecked when it would replace
          // one written by hand (a URL), so saving the other settings never rewrites it unasked.
          instanceTargets: instanceTargets(server),
        },
      };
    },
  },
  {
    // The files of a selection: services, roles suggested and host effects, without touching the configuration.
    method: "POST",
    path: "/api/services/discover",
    timeoutMs: 30_000,
    body: { type: "object", properties: { compose: inputSchema.properties.compose }, required: ["compose"], additionalProperties: false },
    handler({ body, server }) {
      const compose = (body as { compose: string[] }).compose;
      checkFiles(server, compose);
      const discovery = discoverCompose(server.projectDir, compose);
      const roles: Record<string, ServiceRole> = {};
      for (const s of discovery.services) roles[s.name] = s.role === "application" ? "application" : "dependency";
      return { status: 200, json: { schemaVersion: 1, status: "OK", roles, discovery: describe(discovery) } };
    },
  },
  {
    method: "POST",
    path: "/api/services/preview",
    timeoutMs: 30_000,
    body: inputSchema,
    handler({ body, server }) {
      const input = inputOf(body);
      checkFiles(server, input.compose);
      const p = buildPreview(server, input);
      return {
        status: 200,
        json: { schemaVersion: 1, status: "OK", section: p.section, diff: p.diff, revision: p.revision, targets: p.targets, effects: p.effects, confirmed: p.confirmed, changed: p.before !== p.after },
      };
    },
  },
  {
    method: "PUT",
    path: "/api/services",
    timeoutMs: 30_000,
    body: { ...inputSchema, properties: { ...inputSchema.properties, revision: { anyOf: [{ type: "string", maxLength: 128 }, { type: "null" }] }, acknowledged: { type: "boolean" } }, required: ["compose", "roles", "revision"] },
    handler({ body, server }) {
      const input = inputOf(body);
      const b = body as { revision: string | null; acknowledged?: boolean };
      checkFiles(server, input.compose);
      if (readRevision(rootAbs(server)).hash !== b.revision) throw fail(409, "REVISION_CONFLICT", "jgates.yml changed since it was read.");
      const p = buildPreview(server, input);
      if (!p.confirmed) {
        if (b.acknowledged !== true) throw fail(409, "ACK_REQUIRED", "The host effects of the services have to be acknowledged first.", { effects: p.effects });
        fs.mkdirSync(path.dirname(ackFile(server)), { recursive: true });
        fs.writeFileSync(ackFile(server), `${JSON.stringify({ schemaVersion: 1, hash: p.hash })}\n`, { mode: 0o600 });
      }
      writeFileAtomic(rootAbs(server), p.after);
      if (p.tools) {
        if (readRevision(p.tools.absolute).hash !== p.tools.hash) throw fail(409, "REVISION_CONFLICT", `${p.tools.file} changed since it was read.`);
        writeFileAtomic(p.tools.absolute, p.tools.after);
      }
      server.log("services saved");
      return { status: 200, json: { schemaVersion: 1, status: "OK", section: p.section, targets: p.targets, revision: readRevision(rootAbs(server)).hash } };
    },
  },
  {
    // "Testar subida": starts the services in an isolated compose project, waits for the healthchecks and for the health
    // path of the application, returns the states and the logs, and always takes the project down.
    method: "POST",
    path: "/api/services/test",
    timeoutMs: 900_000,
    body: inputSchema,
    async handler({ body, server }) {
      const input = inputOf(body);
      checkFiles(server, input.compose);
      const discovery = discoverCompose(server.projectDir, input.compose);
      if (discovery.services.length === 0) throw fail(422, "COMPOSE_EMPTY", "The chosen compose files have no services.", { problems: discovery.problems });
      const { application } = checkInput(discovery, input);
      const started = startedOf(discovery, input);
      if (started.length === 0) throw fail(422, "SERVICES_NONE", "No service is selected to start.");
      const env = process.env;
      const engine: EngineContext = { runtime: engineRuntime(env), runnerOptions: { parentEnv: env } };
      const project = servicesProjectName(server.workspace.id, "test");
      const labels = engineLabels({ kind: "services", version: server.version, workspace: server.workspace.id, run: "services-test" });
      const dir = path.join(server.serverDir, "services-test");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const overrideFile = path.join(dir, "compose.jgates.yml");
      fs.writeFileSync(overrideFile, servicesOverride({ discovery, services: started, labels, writable: input.writableBinds }), { mode: 0o600 });
      const files = [...discovery.files.map((f) => path.resolve(server.projectDir, f)), overrideFile];
      const base = ["compose", "--project-name", project, ...files.flatMap((f) => ["-f", f])];
      const log: string[] = [];
      const record = (args: string[], r: { stdout: string; stderr: string; exitCode: number | null }): void => {
        log.push(`$ docker ${args.join(" ")}\n${r.stdout}${r.stderr}[exit ${r.exitCode ?? "-"}]`);
      };
      const timeout = input.timeoutSeconds;
      let state: "ready" | "not-ready" = "ready";
      let failed: string | null = null;
      let states: unknown = [];
      try {
        const up = ["up", "--detach", "--wait", "--wait-timeout", String(timeout), "--pull", "missing", "--quiet-pull", ...(input.build === "allow" ? [] : ["--no-build"]), ...started];
        const upArgs = [...base, ...up];
        const upResult = await engineCommand(upArgs, engine, timeout * 1000 + 600_000);
        record(upArgs, upResult);
        if (upResult.spawnError || upResult.exitCode !== 0) {
          state = "not-ready";
          failed = application ?? started[0] ?? null;
        } else if (application && input.target?.health) {
          const health = `http://${application}:${input.target.port}${pathOf(input.target.health, "/")}`;
          const reference = env.JGATES_TOOLS_IMAGE?.trim() || toolsImageTarget(env).reference;
          const image = inspectImageSync(reference, engine);
          const poll = image
            ? await runInEngine(
                {
                  image: image.id,
                  command: ["python3", "-c", HEALTH_POLL, health, String(timeout)],
                  labels: engineLabels({ kind: "helper", version: server.version, workspace: server.workspace.id, run: "services-test" }),
                  network: `${project}_default`,
                  resources: { memoryMb: 128, cpus: 1, pids: 32 },
                  timeoutMs: (timeout + 30) * 1000,
                },
                engine,
              )
            : null;
          log.push(poll ? `$ health ${health}\n${poll.stdout}${poll.stderr}[exit ${poll.exitCode ?? "-"}]` : `$ health ${health}\nthe tools image ${reference} is not available`);
          if (!poll || poll.exitCode !== 0) {
            state = "not-ready";
            failed = application;
          }
        }
        const psArgs = [...base, "ps", "--all", "--format", "json"];
        const ps = await engineCommand(psArgs, engine, 60_000).catch(() => null);
        if (ps) {
          record(psArgs, ps);
          states = ps.stdout
            .split(/\r?\n/)
            .filter((l) => l.trim().startsWith("{"))
            .map((l) => {
              try {
                const row = JSON.parse(l) as Record<string, unknown>;
                return { service: String(row.Service ?? row.Name ?? ""), state: String(row.State ?? ""), health: String(row.Health ?? "") };
              } catch {
                return null;
              }
            })
            .filter((x) => x !== null);
        }
        const logsArgs = [...base, "logs", "--no-color", "--timestamps", "--tail", "200"];
        const logs = await engineCommand(logsArgs, engine, 120_000).catch(() => null);
        if (logs) record(logsArgs, logs);
      } finally {
        try {
          const args = await composeDown({ project, files, labels }, engine);
          log.push(`$ docker ${args.join(" ")}\n[exit 0]`);
        } catch (error) {
          log.push(`compose down failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { status: 200, json: { schemaVersion: 1, status: "OK", result: { state, failed, services: started, states, log: log.join("\n\n").slice(-60_000), stopped: true } } };
    },
  },
];
