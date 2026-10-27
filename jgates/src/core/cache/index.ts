// Cache of step results with demonstrable validity.
// A step is served from the cache only when everything it depends on is known and identical to the run that produced
// the result: the version of JGates, the content of the analyzed files (outputs, caches and reports are not part of
// it, so changing only them never invalidates anything), the step's own material (commands, tool versions, rules,
// scope, configuration, policy, templates, profile) and the files its configurations import. When any input is not
// identifiable (a dynamic import, the environment, the network, a tool that may change the code, a folder too big
// for the manifest) the step runs every time and the result says why. A reused stage carries `cache.status:
// "reused"` with the run and the date of the origin; nothing the cache holds ever makes a run pass by itself: the
// decision is computed again from the stages, fail-closed, as for any other run.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { contentHash } from "../ids/index.js";
import type { AdapterOutput, ResultStage, StageCacheInfo } from "../run/types.js";
import { traceConfigs, type ConfigTrace, type Untraceable } from "./trace.js";

export * from "./trace.js";

export const CACHE_SCHEMA_VERSION = 1;
const MAX_ENTRIES = 500;
const INERT = new Set(["disabled", "not_applicable"]);
/** States whose result says something about the code; the others (error, blocked, cancelled...) never enter. */
const STORABLE = new Set(["completed", "not_applicable", "disabled"]);

/** What the caller knows about a step: the material of its key, its configurations and what blocks the cache. */
export interface CacheSubject {
  /** Everything that makes the step's result what it is, as plain data. */
  material: unknown;
  /** Configuration files (workspace-relative) whose imports are inputs of the step. */
  configs: string[];
  /** Reasons the caller already knows make the step not cacheable. */
  blockers: Array<{ code: string; message: string }>;
}

export interface CacheEntry {
  schemaVersion: 1;
  key: string;
  stepId: string;
  runId: string;
  createdAt: string;
  version: string;
  output: AdapterOutput;
}

export interface RunCacheOptions {
  home: string;
  workspaceId: string;
  runId: string;
  /** Folder of this run; the artifacts of a reused step are copied into it from the run that produced them. */
  runDir: string;
  /** Folder the steps read (the workspace or the snapshot of the commit). */
  root: string;
  /** Hash of the input manifest taken before the steps. */
  inputsHash: string;
  /** false when the manifest is truncated: not every input is hashed. */
  inputsTraceable: boolean;
  version: string;
  now?: () => Date;
  /** false: nothing is read or written. */
  enabled?: boolean;
}

export const cacheDir = (home: string, workspaceId: string): string => path.join(home, "workspaces", workspaceId, "cache");

const stripStage = (s: ResultStage): ResultStage => {
  const { execution: _execution, cache: _cache, ...rest } = s;
  return rest;
};

export class RunCache {
  readonly enabled: boolean;
  private readonly pending: CacheEntry[] = [];
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(private readonly opts: RunCacheOptions) {
    this.enabled = opts.enabled !== false;
    this.dir = cacheDir(opts.home, opts.workspaceId);
    this.now = opts.now ?? (() => new Date());
  }

  private file(key: string): string {
    return path.join(this.dir, key.replace(/[^a-z0-9]/gi, "_") + ".json");
  }

  lookup(key: string): CacheEntry | null {
    try {
      const entry = JSON.parse(fs.readFileSync(this.file(key), "utf8")) as CacheEntry;
      if (entry.schemaVersion !== CACHE_SCHEMA_VERSION || entry.key !== key || !Array.isArray(entry.output?.stages) || typeof entry.runId !== "string") return null;
      return entry;
    } catch {
      return null;
    }
  }

  /** The key of a step, from the inputs of the run and the step's material and traced imports. */
  keyOf(stepId: string, subject: CacheSubject, trace: ConfigTrace): string {
    return contentHash({
      v: CACHE_SCHEMA_VERSION,
      version: this.opts.version,
      inputs: this.opts.inputsHash,
      step: stepId,
      material: subject.material,
      imports: trace.files,
    });
  }

  private mark(output: AdapterOutput, info: StageCacheInfo): AdapterOutput {
    return { ...output, stages: output.stages.map((s) => (INERT.has(s.state) ? s : { ...s, cache: info })) };
  }

  /**
   * Runs a step through the cache: a hit returns the stored output without running anything; a miss or a step that
   * can not be cached runs `execute`, and every stage says which of the two happened and why.
   */
  async wrap(stepId: string, subject: CacheSubject | undefined, execute: () => Promise<AdapterOutput>): Promise<AdapterOutput> {
    if (!this.enabled || !subject) return execute();
    const t = translator("cache");
    const trace = traceConfigs(this.opts.root, subject.configs);
    const reasons: Array<{ code: string; message: string }> = [...subject.blockers];
    if (!this.opts.inputsTraceable) reasons.push({ code: "INPUTS_TRUNCATED", message: t("cache_reason_inputs_truncated") });
    for (const u of trace.untraceable) reasons.push({ code: u.code, message: t(`cache_reason_${u.code.toLowerCase()}`, { file: u.file }) });
    if (reasons.length > 0) {
      const output = await execute();
      return this.mark(output, { status: "uncacheable", code: reasons[0]!.code, reason: reasons.map((r) => r.message).join(" ") });
    }
    const key = this.keyOf(stepId, subject, trace);
    const hit = this.lookup(key);
    if (hit) {
      const info: StageCacheInfo = {
        status: "reused",
        runId: hit.runId,
        at: hit.createdAt,
        key,
        reason: t("cache_reused", { runId: hit.runId, at: hit.createdAt }),
      };
      return this.mark(this.inherit(stepId, hit), info);
    }
    const output = await execute();
    const marked = this.mark(output, { status: "executed", key, reason: t("cache_executed") });
    if (output.stages.length > 0 && output.stages.every((s) => STORABLE.has(s.state) && s.interpreted !== false)) {
      this.pending.push({
        schemaVersion: CACHE_SCHEMA_VERSION,
        key,
        stepId,
        runId: this.opts.runId,
        createdAt: "",
        version: this.opts.version,
        output: { ...output, stages: output.stages.map(stripStage) },
      });
    }
    return marked;
  }

  /**
   * The artifacts of a reused step stay readable in this run: the logs and outputs it listed, and its folder under
   * outputs/, are copied from the run that produced them. What no longer exists there is left out of the lists.
   */
  private inherit(stepId: string, hit: CacheEntry): AdapterOutput {
    const originDir = path.join(path.dirname(this.opts.runDir), hit.runId);
    const copy = (rel: string): boolean => {
      const from = path.resolve(originDir, rel);
      const to = path.resolve(this.opts.runDir, rel);
      const inside = (base: string, p: string): boolean => p === base || p.startsWith(base + path.sep);
      if (!inside(originDir, from) || !inside(this.opts.runDir, to)) return false;
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
        return true;
      } catch {
        return false;
      }
    };
    copy(path.join("outputs", stepId));
    return { ...hit.output, logs: hit.output.logs.filter(copy), outputs: hit.output.outputs.filter(copy) };
  }

  /** Writes what the run produced. Called only when the analyzed inputs did not change during the run. */
  commit(): number {
    if (!this.enabled || this.pending.length === 0) return 0;
    let written = 0;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const createdAt = this.now().toISOString();
      for (const entry of this.pending) {
        const file = this.file(entry.key);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ ...entry, createdAt }) + "\n", { mode: 0o600 });
        fs.renameSync(tmp, file);
        written += 1;
      }
      this.prune();
    } catch {
      /* the cache is an optimization: a store that fails costs a re-run, never a wrong answer */
    }
    this.pending.length = 0;
    return written;
  }

  /** Drops the pending entries (the run was cancelled or its inputs changed while it ran). */
  discard(): void {
    this.pending.length = 0;
  }

  private prune(): void {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(MAX_ENTRIES)) fs.rmSync(path.join(this.dir, old.f), { force: true });
  }
}

export type { Untraceable };
