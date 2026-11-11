// The JGates override file of a run's compose project (PLAN-services.md sections 4 and 6), written to the run folder and
// never to the project. For every service that starts it:
//   - adds the JGates labels (cleanup selects by them);
//   - removes the published ports (`!reset []`): steps reach the services on the project network, so a run never
//     collides with a developer's running stack;
//   - redefines every bind mount of a path inside the project with the same target and `read_only: true`, so no service
//     writes to the user's folder (ADR-0006), unless services.writableBinds names the service.
// The default network gets the labels and is internal (no internet); the project's named volumes get the labels too.
// Every string is a JSON string, which is valid YAML.
import { EngineSpecError } from "../engine/index.js";
import type { ComposeDiscovery } from "../discovery/compose.js";

export interface OverrideInput {
  discovery: Pick<ComposeDiscovery, "services" | "volumes">;
  /** The services that start. */
  services: string[];
  labels: Record<string, string>;
  /** Services whose project bind mounts stay writable. */
  writable?: string[];
}

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const q = (value: string): string => JSON.stringify(value);

export function servicesOverride(input: OverrideInput): string {
  const labelLines = (indent: string): string[] => Object.entries(input.labels).map(([k, v]) => `${indent}${q(k)}: ${q(v)}`);
  const lines: string[] = ["# Written by JGates for this run; the project's compose files are never changed.", "services:"];
  for (const name of input.services) {
    if (!SERVICE_NAME.test(name)) throw new EngineSpecError("BAD_NAME", `invalid service name: ${name}`);
    const service = input.discovery.services.find((s) => s.name === name);
    lines.push(`  ${q(name)}:`, "    labels:", ...labelLines("      "), "    ports: !reset []");
    const binds = (service?.binds ?? []).filter((b) => b.insideProject && b.resolved !== null && !(input.writable ?? []).includes(name));
    if (binds.length > 0) {
      lines.push("    volumes:");
      for (const b of binds) lines.push("      - type: bind", `        source: ${q(b.resolved as string)}`, `        target: ${q(b.target)}`, "        read_only: true");
    }
  }
  lines.push("networks:", "  default:", "    internal: true", "    labels:", ...labelLines("      "));
  if (input.discovery.volumes.length > 0) {
    lines.push("volumes:");
    for (const v of input.discovery.volumes) lines.push(`  ${q(v)}:`, "    labels:", ...labelLines("      "));
  }
  return lines.join("\n") + "\n";
}
