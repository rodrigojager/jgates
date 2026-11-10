// Cancelling a run in the container engine: the containers of the run are killed by their run label (never by name,
// never anything without the JGates labels) and the compose projects of the run's services are taken down. What the
// run produced before is untouched: the partial result is written by the run as for any other cancellation.
import { composeDown, killRun, LABEL_MANAGED, type ComposeSpec, type EngineContext } from "../engine/index.js";

/** What `compose down` needs to take a run's services down (the project is the only scope it touches). */
export type ServicesProject = Pick<ComposeSpec, "project" | "files" | "labels">;

const registry = new Map<string, Map<string, ServicesProject>>();

/**
 * The services phase calls this when it brings a compose project up for a run, so that a cancellation (or any other
 * end of the run) can take it down. Registering the same project twice keeps one entry.
 */
export function registerRunServices(runId: string, project: ServicesProject): void {
  const projects = registry.get(runId) ?? new Map<string, ServicesProject>();
  projects.set(project.project, project);
  registry.set(runId, projects);
}

/** The compose projects registered for the run. */
export function runServices(runId: string): ServicesProject[] {
  return [...(registry.get(runId)?.values() ?? [])];
}

/** Forgets the projects of a run (after they were taken down). */
export function forgetRunServices(runId: string): void {
  registry.delete(runId);
}

export interface EngineCancelResult {
  /** Containers of the run that were killed (name, state). */
  killed: Array<{ name: string; id: string }>;
  /** Compose projects taken down. */
  servicesDown: string[];
  /** Cleanup steps that failed (the cancellation itself is not undone by them). */
  errors: string[];
}

export interface EngineCancelInput {
  runId: string;
  context?: EngineContext;
  /** Compose projects to take down besides the registered ones. */
  services?: ServicesProject[];
}

/**
 * Kills the labelled containers of the run and takes its services down. Both always run, even if one fails, and the
 * result lists what happened. Only objects carrying the JGates labels of this run are touched.
 */
export async function cancelRunInEngine(input: EngineCancelInput): Promise<EngineCancelResult> {
  const context = input.context ?? {};
  const result: EngineCancelResult = { killed: [], servicesDown: [], errors: [] };
  try {
    result.killed = (await killRun(input.runId, context)).map((o) => ({ name: o.name, id: o.id }));
  } catch (error) {
    result.errors.push(`kill: ${error instanceof Error ? error.message : String(error)}`);
  }
  const projects = new Map<string, ServicesProject>();
  for (const p of [...runServices(input.runId), ...(input.services ?? [])]) projects.set(p.project, p);
  for (const project of projects.values()) {
    try {
      // Only a project that carries the JGates labels is ever taken down.
      if (project.labels[LABEL_MANAGED] !== "true") throw new Error(`compose project ${project.project} is not a JGates project`);
      await composeDown(project, context);
      result.servicesDown.push(project.project);
    } catch (error) {
      result.errors.push(`compose down ${project.project}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  forgetRunServices(input.runId);
  return result;
}
