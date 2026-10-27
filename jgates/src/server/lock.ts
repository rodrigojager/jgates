// One server per workspace: <home>/workspaces/<id>/locks/ui-server.json (0600) says where the open server listens
// and holds the token of its local control channel. A lock whose server does not answer is stale; processes are
// never looked up or killed by name.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { workspaceDir } from "../core/home/index.js";
import { CONTROL_HEADER } from "./security.js";

export const LOCK_FILE = "ui-server.json";

export interface ServerLock {
  schemaVersion: 1;
  pid: number;
  host: string;
  port: number;
  controlToken: string;
  startedAt: string;
  version: string;
}

export function lockFile(home: string, wsId: string): string {
  return path.join(workspaceDir(home, wsId), "locks", LOCK_FILE);
}

function isLock(value: unknown): value is ServerLock {
  const v = value as Partial<ServerLock> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.pid === "number" &&
    typeof v.host === "string" &&
    typeof v.port === "number" &&
    typeof v.controlToken === "string" &&
    (v.host === "127.0.0.1" || v.host === "::1")
  );
}

export type LockRead = { kind: "none" } | { kind: "lock"; lock: ServerLock; raw: string } | { kind: "corrupt"; raw: string; ageMs: number };

export function readLock(file: string): LockRead {
  let raw: string;
  let mtime = 0;
  try {
    raw = fs.readFileSync(file, "utf8");
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return { kind: "none" };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isLock(parsed)) return { kind: "lock", lock: parsed, raw };
  } catch {
    // Falls through to corrupt.
  }
  return { kind: "corrupt", raw, ageMs: Date.now() - mtime };
}

/** Creates the lock only when none exists (atomic: the full content is linked into place). */
export function tryCreateLock(file: string, lock: ServerLock): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Removes the lock only when it still has exactly the content `raw` (never someone else's newer lock). */
export function removeLockIfSame(file: string, raw: string): void {
  try {
    if (fs.readFileSync(file, "utf8") === raw) fs.rmSync(file, { force: true });
  } catch {
    // Already gone.
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type ControlAnswer =
  | { kind: "ok"; launcher: string; url: string; pid: number }
  | { kind: "refused" }
  | { kind: "unreachable" }
  | { kind: "timeout" };

/** Asks the open server for a new bootstrap launcher over the control channel. */
export function requestLauncher(lock: ServerLock, timeoutMs = 3000): Promise<ControlAnswer> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: lock.host,
        port: lock.port,
        method: "POST",
        path: "/control/bootstrap",
        headers: { [CONTROL_HEADER]: lock.controlToken, "Content-Length": "0" },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve({ kind: "refused" });
          try {
            const doc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { launcher?: unknown; url?: unknown; pid?: unknown };
            if (typeof doc.launcher === "string" && typeof doc.url === "string" && typeof doc.pid === "number") {
              return resolve({ kind: "ok", launcher: doc.launcher, url: doc.url, pid: doc.pid });
            }
          } catch {
            // Not our server.
          }
          resolve({ kind: "refused" });
        });
        res.on("error", () => resolve({ kind: "unreachable" }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ kind: "timeout" });
    });
    req.on("error", () => resolve({ kind: "unreachable" }));
    req.end();
  });
}
