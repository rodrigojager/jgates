// Which steps of a plan use the project's services, and which services a run starts for them. Shared by the plan (the
// selected names, the host effects the review lists, the governed refusals) and the run (the services phase and the
// gate of the steps). A step joins the services only when it needs them:
//   - a runtime check (ZAP, Schemathesis: an invocation whose contract has a `target`) whose target is
//     `service:<name>:<port>`; one with a URL target keeps its own network and never joins;
//   - a check of an integration, e2e or migration capability (the `<runner>-integration` instances, never the unit ones)
//     when jgates.yml has a `services:` section.
// A step that names a service while no services are configured (or the compose files lack it) is SERVICES_REQUIRED.
import { ADAPTER_ID as BRIDGE_ID } from "../../adapters/quality-bridge/requirements.js";
import { discoverCompose, withDependencies, type ComposeDiscovery, type HostEffect } from "../discovery/compose.js";
import type { PlanBody, PlanItem } from "../plan/types.js";
import { readServicesConfig, SERVICE_CAPABILITIES, type ServicesConfig } from "./config.js";

export interface ServiceNeed {
  /** Services the step names through a `service:` target. */
  named: string[];
  /** Why the step cannot get its services, or null. */
  required: { reason: "not-configured" | "unknown-service"; service: string | null } | null;
}

export interface ServicesSelection {
  config: ServicesConfig | null;
  discovery: ComposeDiscovery | null;
  /** The steps that use services (by step id). */
  steps: Map<string, ServiceNeed>;
  /** Services to start, with what they depend on; empty when nothing can start. */
  start: string[];
  /** Names the configuration asks for that the compose files do not have. */
  unknown: string[];
  /** Host effects of the services that start. */
  hostEffects: HostEffect[];
  /** The ones a governed run refuses (empty in local mode). */
  refused: HostEffect[];
  /** Services whose project bind mounts stay writable (services.writableBinds). */
  writable: string[];
  /** Services that compose would build from the project's Dockerfiles. */
  builds: string[];
}

export interface SelectServicesInput {
  /** The analyzed tree: compose files and project bind mounts are relative to it. */
  projectDir: string;
  /** Where jgates.yml is read (the project, or the CI policy). */
  configDir: string;
  items: PlanItem[];
  /** The invocations of the plan (only their id and contract are read). */
  invocations: Array<Pick<PlanBody["invocations"][number], "id" | "contract">>;
  governed: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The service a runtime check's contract names (`service: { name, port }`), null for a URL target, undefined when the contract has no target. */
function contractService(contract: Record<string, unknown> | undefined): string | null | undefined {
  if (!contract || !("target" in contract)) return undefined;
  return isRecord(contract.service) && typeof contract.service.name === "string" ? contract.service.name : null;
}

/** Whether a host effect needs the policy's permission in a governed run (project bind mounts are mounted read-only). */
export function needsPermission(effect: HostEffect): boolean {
  return !(effect.kind === "bind-mount" && effect.insideProject === true);
}

/** The steps of a plan that use services and the services to start; null when no step uses any. */
export function selectServices(input: SelectServicesInput): ServicesSelection | null {
  const config = readServicesConfig(input.configDir);
  const steps = new Map<string, ServiceNeed>();
  for (const item of input.items) {
    if (item.adapter === BRIDGE_ID) continue;
    const contract = input.invocations.find((i) => i.id === item.tool)?.contract;
    const named = contractService(contract);
    let need: string[] | null = null;
    if (named !== undefined) need = named ? [named] : null;
    else if (config && item.capabilities.some((c) => SERVICE_CAPABILITIES.includes(c))) need = [];
    if (need === null) continue;
    const known = steps.get(item.tool);
    steps.set(item.tool, { named: [...new Set([...(known?.named ?? []), ...need])], required: null });
  }
  if (steps.size === 0) return null;
  const empty = { start: [], unknown: [], hostEffects: [], refused: [], writable: [], builds: [] };
  if (!config) {
    for (const need of steps.values()) need.required = { reason: "not-configured", service: need.named[0] ?? null };
    return { config, discovery: null, steps, ...empty };
  }
  const discovery = discoverCompose(input.projectDir, config.compose);
  const known = new Set(discovery.services.map((s) => s.name));
  for (const need of steps.values()) {
    const missing = need.named.find((n) => !known.has(n));
    if (discovery.services.length === 0) need.required = { reason: "not-configured", service: need.named[0] ?? null };
    else if (missing) need.required = { reason: "unknown-service", service: missing };
  }
  const named = [...steps.values()].flatMap((n) => n.named);
  const asked = config.start ?? [...new Set([...(config.target ? [config.target.service] : []), ...named])];
  const unknown = asked.filter((n) => !known.has(n));
  // Nothing named: every service of the active profiles (a service with profiles starts only when one is active).
  const roots = asked.length > 0 ? asked.filter((n) => known.has(n)) : discovery.services.filter((s) => s.profiles.length === 0 || s.profiles.some((p) => config.profiles.includes(p))).map((s) => s.name);
  const start = withDependencies(discovery, roots).filter((n) => known.has(n));
  const started = discovery.services.filter((s) => start.includes(s.name));
  const hostEffects = started.flatMap((s) => s.hostEffects);
  const writable = config.writableBinds.filter((n) => start.includes(n));
  const refused = input.governed
    ? [
        ...hostEffects.filter((e) => needsPermission(e) && !config.allowHostEffects.includes(e.kind)),
        // A writable project folder is never allowed in governed mode (ADR-0006).
        ...started.filter((s) => writable.includes(s.name)).flatMap((s) => s.hostEffects.filter((e) => e.kind === "bind-mount" && e.insideProject)),
      ]
    : [];
  const builds = config.build === "allow" ? started.filter((s) => s.build !== null).map((s) => s.name) : [];
  return { config, discovery, steps, start, unknown, hostEffects, refused, writable, builds };
}
