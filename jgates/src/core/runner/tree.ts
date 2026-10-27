// Process trees of the local runner: list the descendants of a process and stop a whole tree, on Unix and on
// Windows. The runner only ever stops processes it started (by pid, never by name).
import fs from "node:fs";
import { spawnSync } from "node:child_process";

/** Parent of every live process, read without starting anything on Linux (/proc) and with ps or CIM elsewhere. */
export function processTable(): Map<number, number> {
  const table = new Map<number, number>();
  if (process.platform === "linux") {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync("/proc");
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
        // The command name may hold spaces and parentheses: the fields after the last ")" are fixed.
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ppid = Number(rest[1]);
        if (Number.isInteger(ppid)) table.set(Number(name), ppid);
      } catch {
        // The process ended while the table was read.
      }
    }
    return table;
  }
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
      { encoding: "utf8", windowsHide: true, timeout: 20_000 },
    );
    for (const line of (r.stdout ?? "").split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid as number, ppid as number);
    }
    return table;
  }
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 10_000 });
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid as number, ppid as number);
  }
  return table;
}

/** Every descendant of `pid` (children, grandchildren...), from one snapshot of the process table. */
export function listDescendants(pid: number, table: Map<number, number> = processTable()): number[] {
  const children = new Map<number, number[]>();
  for (const [child, parent] of table) {
    if (child === parent) continue;
    const list = children.get(parent) ?? [];
    list.push(child);
    children.set(parent, list);
  }
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  const queue = [...(children.get(pid) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift() as number;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return out;
}

/** true while a process with this pid exists (a zombie that was not reaped yet counts as gone on Linux). */
export function isAlive(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Sends `signal` to a process tree. On Unix: the process group the runner created (the child leads its own group)
 * plus every pid in `known` and every current descendant, so a grandchild that left the group is reached too.
 * On Windows: taskkill /T /F on the root and on each known pid. Returns the pids it signalled.
 */
export function signalTree(rootPid: number, signal: NodeJS.Signals, options: { group?: boolean; known?: Iterable<number> } = {}): number[] {
  const targets = new Set<number>(options.known ?? []);
  for (const pid of listDescendants(rootPid)) targets.add(pid);
  targets.delete(process.pid);
  if (process.platform === "win32") {
    for (const pid of [rootPid, ...targets]) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 20_000 });
    }
    return [rootPid, ...targets];
  }
  if (options.group) {
    try {
      process.kill(-rootPid, signal);
    } catch {
      // The group is gone (or was never created).
    }
  }
  signalPid(rootPid, signal);
  for (const pid of targets) signalPid(pid, signal);
  return [rootPid, ...targets];
}

export interface TreeStopper {
  /** Asks the tree to stop (SIGTERM), then forces it (SIGKILL) after the grace period. Idempotent. */
  stop(): void;
  /** Forces at once whatever is left of the tree. */
  force(): void;
  /** The root process ended: from now on only its group and the pids already seen are signalled (its pid may be reused). */
  rootExited(): void;
  /** pids seen in the tree so far. */
  readonly known: ReadonlySet<number>;
}

/** Stops a tree the gentle way first; the pids seen at the first signal are kept, since they stop being descendants once their parent dies. */
export function treeStopper(rootPid: number, options: { group?: boolean; graceMs?: number } = {}): TreeStopper {
  const known = new Set<number>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let exited = false;
  const group = options.group ?? false;
  const send = (signal: NodeJS.Signals): void => {
    if (!exited) {
      for (const pid of signalTree(rootPid, signal, { group, known })) if (pid !== rootPid) known.add(pid);
      return;
    }
    if (process.platform === "win32") {
      for (const pid of known) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 20_000 });
      return;
    }
    if (group) {
      try {
        process.kill(-rootPid, signal);
      } catch {
        // The group is empty.
      }
    }
    for (const pid of known) signalPid(pid, signal);
  };
  return {
    known,
    stop() {
      if (stopped) return;
      stopped = true;
      if (process.platform === "win32") {
        send("SIGKILL");
        return;
      }
      send("SIGTERM");
      timer = setTimeout(() => send("SIGKILL"), options.graceMs ?? 3000);
      timer.unref();
    },
    force() {
      if (timer) clearTimeout(timer);
      stopped = true;
      send("SIGKILL");
    },
    rootExited() {
      exited = true;
    },
  };
}
