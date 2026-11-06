// Whether a run is still alive. While a run executes, its process rewrites heartbeat.json in the run folder every few
// seconds (pid and time). Its result.json says `partial: true` from the start, so "partial" alone cannot tell a run
// that is working from one whose process died; the heartbeat can, wherever the run was started (the UI's child
// process, a terminal, a CI job on this machine) and whether or not the server that started it is still up.
import fs from "node:fs";
import path from "node:path";

export const HEARTBEAT_FILE = "heartbeat.json";
export const HEARTBEAT_INTERVAL_MS = 5_000;
/** A heartbeat older than this means the process stopped beating (frozen or gone). */
export const HEARTBEAT_STALE_MS = 30_000;

export interface Heartbeat {
  schemaVersion: 1;
  pid: number;
  startedAt: string;
  updatedAt: string;
}

export interface HeartbeatHandle {
  stop(): void;
}

/** Starts beating for the run in `runDir`; `stop` removes the file (the final result.json is written by then). */
export function startHeartbeat(runDir: string, options: { now?: () => Date; intervalMs?: number; pid?: number } = {}): HeartbeatHandle {
  const now = options.now ?? (() => new Date());
  const file = path.join(runDir, HEARTBEAT_FILE);
  const startedAt = now().toISOString();
  const pid = options.pid ?? process.pid;
  const beat = () => {
    const doc: Heartbeat = { schemaVersion: 1, pid, startedAt, updatedAt: now().toISOString() };
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      // A missed beat is only a later beat; the run itself never fails because of it.
    }
  };
  beat();
  const timer = setInterval(beat, options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      fs.rmSync(file, { force: true });
    },
  };
}

/** Whether a process with this pid exists on this machine (a pid it may not signal still exists). */
export function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Liveness {
  alive: boolean;
  /** When the run last beat, or null without a heartbeat. */
  beatAt: string | null;
  pid: number | null;
}

/**
 * Alive when the heartbeat is fresh and its process exists. A run without a heartbeat (it finished, it died before
 * the first beat, or an older version ran it) is not alive.
 */
export function readLiveness(runDir: string, options: { now?: () => Date; exists?: (pid: number) => boolean; staleMs?: number } = {}): Liveness {
  let doc: Partial<Heartbeat> | null = null;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(runDir, HEARTBEAT_FILE), "utf8")) as Partial<Heartbeat>;
  } catch {
    return { alive: false, beatAt: null, pid: null };
  }
  const pid = typeof doc.pid === "number" ? doc.pid : null;
  const beatAt = typeof doc.updatedAt === "string" ? doc.updatedAt : null;
  const age = beatAt ? (options.now ?? (() => new Date()))().getTime() - Date.parse(beatAt) : Infinity;
  const fresh = Number.isFinite(age) && age <= (options.staleMs ?? HEARTBEAT_STALE_MS);
  const exists = pid !== null && (options.exists ?? processExists)(pid);
  return { alive: fresh && exists, beatAt, pid };
}

export interface Activity {
  /** The newest file the run wrote (logs, outputs, events), relative to the run folder with forward slashes. */
  file: string | null;
  at: string | null;
}

/**
 * The last thing the run wrote on disk: what the UI shows as "last activity" while a long step runs (a scanner that
 * finished, a log that grew). Bounded walk: a few levels and a few thousand entries.
 */
export function lastActivity(runDir: string, options: { maxDepth?: number; maxEntries?: number } = {}): Activity {
  const maxDepth = options.maxDepth ?? 7;
  const maxEntries = options.maxEntries ?? 5_000;
  let seen = 0;
  let best: { file: string; mtime: number } | null = null;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || seen >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > maxEntries) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name !== HEARTBEAT_FILE && !entry.name.endsWith(".tmp")) {
        try {
          const mtime = fs.statSync(full).mtimeMs;
          if (!best || mtime > best.mtime) best = { file: full, mtime };
        } catch {
          // Removed while walking.
        }
      }
    }
  };
  walk(runDir, 0);
  const found = best as { file: string; mtime: number } | null;
  if (!found) return { file: null, at: null };
  return { file: path.relative(runDir, found.file).split(path.sep).join("/"), at: new Date(found.mtime).toISOString() };
}
