// What a tool instance would run, rendered from the same adapter code the plan uses (the adapter's plan() builds the
// command), so the area of the tool shows the command of the plan and not a second description of it. Nothing runs.
import { externalAdapter } from "../plan/adapters.js";
import { resolveConfig } from "../config/resolve/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { resolveToolBindings } from "./index.js";

const DEFAULT_TIMEOUT_SECONDS = 30 * 60;

export interface RenderedCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** executable and args as one line; {workspace} and {runDir} stay as the plan writes them. */
  line: string;
  container: { runtime: string; image: string; network: string } | null;
}

export interface ExecutionView {
  instance: string;
  adapter: string;
  displayName: string;
  /** false when the instance has no process of its own (the composite bridge): `reason` says why. */
  planned: boolean;
  reason: string | null;
  command: RenderedCommand | null;
  runtime: { name: string; interpreter: string | null; available: boolean } | null;
  toolVersion: string | null;
  availability: { status: string; reason: string | null } | null;
  network: boolean;
  /** Effects declared by the adapter manifest (for example executesProjectCode). */
  effects: Record<string, boolean>;
  context: { granularity: string[]; minimumContext: string[]; componentRoot: string | null };
  output: { format: string; schema: string | null } | null;
  configFiles: Array<{ file: string; sha256: string | null }>;
  conditions: string[];
  limitations: string[];
  runner: string;
}

/** One line for a command: tokens with spaces or quotes are quoted, everything else is shown as the plan has it. */
export function commandLine(executable: string, args: readonly string[]): string {
  const quote = (token: string): string => (/^[A-Za-z0-9_@%+=:,./{}~-]+$/.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`);
  return [executable, ...args].map(quote).join(" ");
}

export function renderExecution(dir: string, instanceId: string, env: NodeJS.ProcessEnv = process.env): ExecutionView | null {
  const bound = resolveToolBindings(dir).instances.find((i) => i.id === instanceId);
  if (!bound) return null;
  const manifest = builtinManifests().find((m) => m.id === bound.adapter);
  const base = {
    instance: bound.id,
    adapter: bound.adapter,
    displayName: manifest?.displayName ?? bound.adapter,
    effects: manifest?.effects ?? {},
    context: { granularity: manifest?.granularity ?? [], minimumContext: manifest?.minimumContext ?? [], componentRoot: bound.componentRoot },
    limitations: manifest?.limitations ?? [],
    runner: bound.runner,
  };
  const none = (reason: string): ExecutionView => ({ ...base, planned: false, reason, command: null, runtime: null, toolVersion: null, availability: null, network: false, output: null, configFiles: [], conditions: [] });
  const adapter = externalAdapter(bound.adapter);
  if (!adapter || !manifest) return none("NO_OWN_PROCESS");

  const resolved = resolveConfig(dir);
  const config = resolved.config as Record<string, unknown>;
  const execution = typeof config.execution === "object" && config.execution !== null ? (config.execution as Record<string, unknown>) : {};
  const timeoutSeconds = typeof execution.timeoutSeconds === "number" ? execution.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS;
  const planned = adapter.plan({ dir, env, tool: bound.id, capability: manifest.capabilities[0] ?? "", componentRoot: bound.componentRoot, timeoutSeconds, config });
  const container = planned.command.container;
  return {
    ...base,
    planned: true,
    reason: null,
    command: {
      executable: planned.command.executable,
      args: planned.command.args,
      cwd: planned.command.cwd,
      env: planned.command.env,
      line: commandLine(planned.command.executable, planned.command.args),
      container: container ? { runtime: container.runtime, image: container.image, network: container.network } : null,
    },
    runtime: planned.runtime,
    toolVersion: planned.toolVersion,
    availability: planned.availability,
    network: planned.network,
    output: planned.output,
    configFiles: planned.configFiles,
    conditions: planned.conditions,
  };
}
