// Engine and Git facts of the local server (ADR-0010, PLAN-performance.md P1 and P6). A request handler never waits on
// a synchronous `docker` or `git` process: the event loop serves every other request (static files included) while the
// engine answers.
//
// How it works. The read-only engine and Git questions (engine info, image inspect, volume inspect, the listings, the
// helper container that prints the data and CodeQL status files, `git rev-parse` and `git status`) are answered from one
// cache: a fresh answer (under FRESH_MS) is used as is, an older one (under STALE_MS) is used while a background probe
// refreshes it, anything else is probed. Probes are asynchronous and single flight (one process per question, however
// many requests ask). Only answers that worked are kept: an engine that does not answer, an image or a volume that is
// not there are asked again on the next request, so a Docker started or an image pulled from a terminal shows at once.
// The actions that change what the engine holds (pull, setup, data update, dependencies, CodeQL, clean, a prerequisite
// fix) invalidate the cache, and an explicit "check again" (`fresh`) asks everything again.
//
// The plan, the status and the prerequisites are computed by synchronous code that the CLI shares, so the server runs
// that code inside withEngineFacts: there, the engine module (engineCommandSync, runInEngineSync) and runGit answer
// from the cache, and a question the cache does not have throws FactsPending instead of spawning. withEngineFacts then
// waits for the asynchronous probes and computes again; each round learns at least one answer, and a warm cache needs
// one round. Outside withEngineFacts (the CLI) nothing changes.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { ExecutionResult } from "../runner/process.js";
import { stepMode } from "../runner/in-image.js";
import { gitContext, resolveGit, runGitAsync, setGitReadCache, type GitCall } from "../snapshot/git.js";
import { readDataStatusSync } from "../data/index.js";
import { readCodeqlStatusSync } from "../codeql-prepare/index.js";
import { toolsImageTarget } from "../tools-image/index.js";
import { detectEngineSync, inspectImageSync, setEngineReadCache, type EngineContext } from "./index.js";

/** An answer younger than this is used as is. */
export const FRESH_MS = 5_000;
/** An answer younger than this is used while a background probe refreshes it; an older one is probed first. */
export const STALE_MS = 120_000;
/** Time limit of the Git status the shell shows. */
export const GIT_STATUS_TIMEOUT_MS = 10_000;
const MAX_ROUNDS = 16;
const MAX_ENTRIES = 512;

/** Thrown by a synchronous read inside withEngineFacts when the answer is not known yet (it is being probed). */
export class FactsPending extends Error {
  constructor(readonly key: string) {
    super(`engine fact pending: ${key}`);
    this.name = "FactsPending";
  }
}

type Known = { value: unknown } | { error: unknown };

interface Scope {
  /** Every answer this computation used, kept for its next rounds so they all see the same facts. */
  known: Map<string, Known>;
  /** Questions a synchronous read could not answer in the current round. */
  misses: Map<string, Promise<unknown>>;
  /** Time of the oldest answer the computation used. */
  asOf: number | null;
  /** An explicit "check again": answers (and probes) older than this time are not used. */
  freshSince: number | null;
}

const scopes = new AsyncLocalStorage<Scope>();

/** Runs a probe outside any scope: its own engine calls are never served from the cache. */
const outside = <T>(run: () => Promise<T>): Promise<T> => scopes.exit(run);

interface Entry<T> {
  value: T;
  at: number;
}

class FactCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly flights = new Map<string, { promise: Promise<T>; at: number }>();
  private generation = 0;

  constructor(private readonly keep: (key: string, value: T) => boolean) {}

  entry(key: string): Entry<T> | undefined {
    return this.entries.get(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * One probe per question at a time (a probe started before `notBefore` is not joined); its answer is kept only when
   * worth keeping and nothing invalidated the cache meanwhile.
   */
  probe(key: string, run: () => Promise<T>, notBefore: number | null = null): Promise<T> {
    const flying = this.flights.get(key);
    if (flying && (notBefore === null || flying.at >= notBefore)) return flying.promise;
    const generation = this.generation;
    // An answer is as old as the question: a probe that started earlier never passes for a newer one.
    const asked = Date.now();
    const flight: Promise<T> = outside(run).then(
      (value) => {
        if (this.flights.get(key)?.promise === flight) this.flights.delete(key);
        // keep() may invalidate the whole cache (an engine that stopped answering): then nothing is stored.
        const keep = this.keep(key, value);
        if (generation === this.generation) {
          if (keep) this.store(key, value, asked);
          else this.entries.delete(key);
        }
        return value;
      },
      (error: unknown) => {
        if (this.flights.get(key)?.promise === flight) this.flights.delete(key);
        if (generation === this.generation) this.entries.delete(key);
        throw error;
      },
    );
    this.flights.set(key, { promise: flight, at: asked });
    return flight;
  }

  private store(key: string, value: T, at: number): void {
    const current = this.entries.get(key);
    if (current && current.at > at) return;
    this.entries.delete(key);
    this.entries.set(key, { value, at });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** Forgets every answer; probes already running finish, but their answers are not kept. */
  invalidate(): void {
    this.generation++;
    this.entries.clear();
    this.flights.clear();
  }
}

type Served<T> = { value: T } | { error: unknown } | { pending: Promise<T> };

/** The answer of the current scope to one question; undefined outside a scope. */
function serve<T>(cache: FactCache<T>, key: string, run: () => Promise<T>): Served<T> | undefined {
  const scope = scopes.getStore();
  if (!scope) return undefined;
  const known = scope.known.get(key);
  if (known) return known as Served<T>;
  const entry = cache.entry(key);
  const age = entry ? Date.now() - entry.at : Number.POSITIVE_INFINITY;
  if (entry && age < STALE_MS && (scope.freshSince === null || entry.at >= scope.freshSince)) {
    if (age >= FRESH_MS) cache.probe(key, run).catch(() => undefined);
    scope.known.set(key, { value: entry.value });
    scope.asOf = scope.asOf === null ? entry.at : Math.min(scope.asOf, entry.at);
    return { value: entry.value };
  }
  const asked = Date.now();
  const pending = cache.probe(key, run, scope.freshSince).then(
    (value) => {
      scope.known.set(key, { value });
      scope.asOf = scope.asOf === null ? asked : Math.min(scope.asOf, asked);
      return value;
    },
    (error: unknown) => {
      scope.known.set(key, { error });
      throw error;
    },
  );
  pending.catch(() => undefined);
  return { pending };
}

/** The synchronous side: the answer, or FactsPending after the question was handed to a probe. */
function serveSync<T>(cache: FactCache<T>, key: string, run: () => Promise<T>): T | undefined {
  const served = serve(cache, key, run);
  if (!served) return undefined;
  if ("value" in served) return served.value;
  if ("error" in served) throw served.error;
  scopes.getStore()?.misses.set(key, served.pending);
  throw new FactsPending(key);
}

/**
 * Engine answers worth keeping: the ones that worked. A failure (no engine, a stopped daemon, an image or a volume that
 * is not there yet) is what the person is about to fix, often from a terminal, so it is asked again on the next request
 * (the prime asks those reads before the computation, so a failure costs one quick probe, not another round). When
 * `info` or `version` fails, every kept answer is dropped: nothing a stopped engine said stays.
 */
function keepEngineAnswer(key: string, result: ExecutionResult): boolean {
  const [kind, , verb] = JSON.parse(key) as string[];
  const worked = result.exitCode === 0 && !result.spawnError && !result.timedOut;
  if (!worked && kind === "command" && (verb === "info" || verb === "version")) engineCache.invalidate();
  return worked;
}

const engineCache: FactCache<ExecutionResult> = new FactCache<ExecutionResult>(keepEngineAnswer);
/** Git answers worth keeping: the ones that worked (a folder Git refuses or does not know is asked again). */
const gitCache = new FactCache<GitCall>((_key, call) => call.status === 0);
/** Whether each work tree has uncommitted changes; null (Git missing, failed or too slow) is kept too, until a refresh. */
const dirtyCache = new FactCache<boolean | null>(() => true);

setEngineReadCache({
  read(key, probe) {
    const served = serve(engineCache, key, probe);
    if (!served) return undefined;
    if ("value" in served) return Promise.resolve(served.value);
    if ("error" in served) return Promise.reject(served.error);
    return served.pending;
  },
  readSync: (key, probe) => serveSync(engineCache, key, probe),
});
setGitReadCache({ readSync: (key, probe) => serveSync(gitCache, key, probe) });

/**
 * The synchronous part of the server's computations takes turns: one at a time, each after the event loop had its turn.
 * Several screens whose facts arrive together (they waited on the same probe) would otherwise compute back to back and
 * hold every other request for the sum of their times; this way a cheap request waits for one computation at most.
 */
let lane: Promise<unknown> = Promise.resolve();

function inTurn<T>(work: () => T): Promise<T> {
  const next = lane.then(() => new Promise<void>((resolve) => setImmediate(resolve))).then(work);
  lane = next.catch(() => undefined);
  return next;
}

async function settle<T>(scope: Scope, compute: () => T | Promise<T>): Promise<T> {
  for (let round = 1; ; round++) {
    scope.misses.clear();
    let outcome: { value: T } | { error: unknown };
    try {
      // The turn ends when `compute` returns (an asynchronous computation goes on outside it, at its next await).
      const started = { result: undefined as T | Promise<T> | undefined };
      await inTurn(() => {
        started.result = scopes.run(scope, compute);
      });
      outcome = { value: await (started.result as T | Promise<T>) };
    } catch (error) {
      outcome = { error };
    }
    if (scope.misses.size === 0) {
      if ("value" in outcome) return outcome.value;
      throw outcome.error;
    }
    if (round >= MAX_ROUNDS) throw new Error(`the engine facts did not settle after ${MAX_ROUNDS} rounds: ${[...scope.misses.keys()].join(", ")}`);
    await Promise.allSettled(scope.misses.values());
  }
}

export interface PrimeOptions {
  env?: NodeJS.ProcessEnv;
  /** The JGates version of this server (the label of the helper containers). */
  version: string;
  /** The fetch times of the advisory data (one helper container); default true. */
  data?: boolean;
  /** The CodeQL status (one helper container); default true. */
  codeql?: boolean;
  /** Also what Git says about this folder (work tree, HEAD, branch). */
  gitDir?: string;
}

/**
 * The reads most screens need, asked together: the engine, the tools image, the data and CodeQL status, and Git when a
 * folder is given. Run first, in a few cheap rounds, they let the computation that follows find everything at once.
 */
function primeReads(options: PrimeOptions): void {
  const env = options.env ?? process.env;
  const each = (read: () => unknown): void => {
    try {
      read();
    } catch (error) {
      if (!(error instanceof FactsPending)) throw error;
    }
  };
  const gitDir = options.gitDir;
  if (gitDir !== undefined) each(() => gitContext(gitDir, env));
  if (stepMode(env) === "in-image") return;
  const context: EngineContext = { runnerOptions: { parentEnv: env } };
  each(() => detectEngineSync({ requiredMemoryMb: 0, requiredDiskMb: 0 }, context));
  each(() => inspectImageSync(toolsImageTarget(env).reference, context));
  if (options.data !== false) each(() => readDataStatusSync(env, options.version));
  if (options.codeql !== false) each(() => readCodeqlStatusSync(env, options.version));
}

export interface FactsOptions {
  /** Ask the common reads first, in parallel (see PrimeOptions). */
  prime?: PrimeOptions;
  /** An explicit "check again": every engine and Git answer is asked anew (and kept for the next requests). */
  fresh?: boolean;
}

/**
 * Computes `compute` (synchronous or not) with the engine and Git reads answered from the cache, without ever spawning
 * them synchronously. `compute` must only read: it may run more than once while the facts it needs are probed.
 */
export async function withEngineFacts<T>(compute: () => T | Promise<T>, options: FactsOptions = {}): Promise<T> {
  // Inside another computation: its rounds take care of what this one misses.
  if (scopes.getStore()) return compute();
  const scope: Scope = { known: new Map(), misses: new Map(), asOf: null, freshSince: options.fresh ? Date.now() : null };
  if (options.prime) {
    const prime = options.prime;
    await settle(scope, () => primeReads(prime)).catch(() => undefined);
  }
  return settle(scope, compute);
}

/** Inside withEngineFacts: when the oldest engine or Git answer the computation used was read (ISO 8601); null otherwise. */
export function factsAsOf(): string | null {
  const asOf = scopes.getStore()?.asOf;
  return asOf === null || asOf === undefined ? null : new Date(asOf).toISOString();
}

let warming: Promise<unknown> | null = null;
let warmedAt = 0;

/**
 * Asks the common reads now, in the background of a first request, so the first screen finds them ready. At most once
 * per STALE_MS, and never while the cache already holds answers: a frame that polls does not keep the engine busy.
 */
export function warmEngineFacts(options: PrimeOptions): void {
  if (engineCache.size > 0 || warming || Date.now() - warmedAt < STALE_MS) return;
  warmedAt = Date.now();
  warming = withEngineFacts(() => undefined, { prime: options })
    .catch(() => undefined)
    .finally(() => {
      warming = null;
    });
}

/** After an action that changed what the engine holds: the next reads ask the engine again. */
export function invalidateEngineFacts(): void {
  engineCache.invalidate();
}

/** After an action that may have changed Git's answers (a commit, a trusted folder): the next reads ask Git again. */
export function invalidateGitFacts(): void {
  gitCache.invalidate();
  dirtyCache.invalidate();
}

const STATUS_ARGS = ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=dirty", "--", "."];

/**
 * Whether the work tree of `dir` has uncommitted changes (tracked changes or untracked files that are not ignored): the
 * last answer, or a new one when `refresh` is asked or none was read yet. Git runs asynchronously, read-only, with the
 * repository-configured file system monitor off (reading the status never runs a program of the repository) and a time
 * limit; null when Git is missing, failed or did not answer in time.
 */
export function gitDirty(dir: string, options: { refresh?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<boolean | null> {
  const key = path.resolve(dir);
  const entry = dirtyCache.entry(key);
  if (entry && !options.refresh) return Promise.resolve(entry.value);
  // A refresh never joins a status that was asked before it (the work tree may have changed since).
  const notBefore = options.refresh ? Date.now() : null;
  return dirtyCache.probe(
    key,
    async () => {
      const env = options.env ?? process.env;
      const git = resolveGit(env);
      if (!git) return null;
      const r = await runGitAsync(git, STATUS_ARGS, dir, env, {}, options.timeoutMs ?? GIT_STATUS_TIMEOUT_MS);
      return r.status === 0 ? r.stdout.trim() !== "" : null;
    },
    notBefore,
  );
}
