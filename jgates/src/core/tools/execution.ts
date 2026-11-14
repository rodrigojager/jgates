// What a tool instance would run, rendered from the same adapter code the plan uses (the adapter's plan() builds the
// command), so the area of the tool shows the command of the plan and not a second description of it. Nothing runs.
import { externalAdapter } from "../plan/adapters.js";
import { resolveReadable } from "../config/resolve/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { localizedAdapterName } from "../catalog/index.js";
import { resolveToolBindings } from "./index.js";

const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
// The defaults of the step container (core/engine DEFAULT_RESOURCES).
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_CPUS = 2;

export interface ExecutionLimits {
  memoryMb: number;
  cpus: number;
  timeoutSeconds: number;
  /** "adapter": the adapter's manifest; "configuration": execution.timeoutSeconds in jgates.yml; "default": JGates' own. */
  origin: { memoryMb: "adapter" | "default"; cpus: "adapter" | "default"; timeoutSeconds: "configuration" | "default" };
}

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
  /** The limits the step of this instance runs with and where each value comes from; null without a process of its own. */
  limits: ExecutionLimits | null;
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
  // The line is for a terminal of this machine: cmd.exe and PowerShell read double quotes and a backslash is a path
  // separator on Windows; POSIX shells read single quotes.
  const windows = process.platform === "win32";
  const safe = windows ? /^[A-Za-z0-9_@%+=:,./\\{}~-]+$/ : /^[A-Za-z0-9_@%+=:,./{}~-]+$/;
  const quote = (token: string): string => (safe.test(token) ? token : windows ? `"${token.replace(/"/g, '\\"')}"` : `'${token.replace(/'/g, `'\\''`)}'`);
  return [executable, ...args].map(quote).join(" ");
}

export function renderExecution(dir: string, instanceId: string, env: NodeJS.ProcessEnv = process.env): ExecutionView | null {
  const bound = resolveToolBindings(dir).instances.find((i) => i.id === instanceId);
  if (!bound) return null;
  const manifest = builtinManifests().find((m) => m.id === bound.adapter);
  const base = {
    instance: bound.id,
    adapter: bound.adapter,
    displayName: manifest ? localizedAdapterName(manifest.id, manifest.displayName) : bound.adapter,
    effects: manifest?.effects ?? {},
    context: { granularity: manifest?.granularity ?? [], minimumContext: manifest?.minimumContext ?? [], componentRoot: bound.componentRoot },
    limitations: manifest?.limitations ?? [],
    runner: bound.runner,
  };
  const none = (reason: string): ExecutionView => ({ ...base, planned: false, reason, command: null, runtime: null, toolVersion: null, availability: null, limits: null, network: false, output: null, configFiles: [], conditions: [] });
  const adapter = externalAdapter(bound.adapter);
  if (!adapter || !manifest) return none("NO_OWN_PROCESS");

  // What the files hold, also while a key written by hand makes the configuration invalid.
  const resolved = resolveReadable(dir);
  const config = resolved.config as Record<string, unknown>;
  const execution = typeof config.execution === "object" && config.execution !== null ? (config.execution as Record<string, unknown>) : {};
  const timeoutSeconds = typeof execution.timeoutSeconds === "number" ? execution.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS;
  const own = manifest.resources;
  const limits: ExecutionLimits = {
    memoryMb: own?.memoryMb ?? DEFAULT_MEMORY_MB,
    cpus: own?.cpus ?? DEFAULT_CPUS,
    timeoutSeconds,
    origin: {
      memoryMb: own?.memoryMb !== undefined ? "adapter" : "default",
      cpus: own?.cpus !== undefined ? "adapter" : "default",
      timeoutSeconds: typeof execution.timeoutSeconds === "number" ? "configuration" : "default",
    },
  };
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
    limits,
    network: planned.network,
    output: planned.output,
    configFiles: planned.configFiles,
    conditions: planned.conditions,
  };
}
