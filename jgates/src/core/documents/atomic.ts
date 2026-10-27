import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Atomic replacement of one file: the bytes go to an exclusive temporary file in the same directory (same
 * filesystem), are flushed and read back, the caller re-checks what it validated (paths, revision), and only then
 * the temporary file is renamed over the target. Any failure removes the temporary file and leaves the target as it
 * was: a half-written target is never possible, because the target is only ever replaced by rename.
 */

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Test-only fault points. Never set outside tests. */
export interface WriteFaults {
  /** Writes only this many bytes to the temporary file and then fails, like a full disk or a crash mid-write. */
  failAfterBytes?: number;
  /** Runs after the temporary file is complete and before the final checks (to change the world in between). */
  beforeCommit?: () => void;
  /** Fails right before the rename. */
  failBeforeRename?: boolean;
}

export interface AtomicWriteOptions {
  /** Permission bits to keep (the current file's mode); absent for a new file, which gets 0o666 minus the umask. */
  mode?: number;
  /** Called right before the rename; throws to abort (the temporary file is removed). */
  verify?: () => void;
  faults?: WriteFaults;
}

export class AtomicWriteError extends Error {
  constructor(
    message: string,
    readonly stage: "temp" | "verify" | "rename",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AtomicWriteError";
  }
}

function writeAll(fd: number, bytes: Buffer, limit: number | undefined): void {
  const total = limit === undefined ? bytes.length : Math.min(limit, bytes.length);
  let offset = 0;
  while (offset < total) offset += fs.writeSync(fd, bytes, offset, total - offset);
  if (limit !== undefined) throw new Error("simulated failure while writing the temporary file");
}

/** Replaces `target` with `bytes` atomically. `target` must be the real path (no symlink in it). */
export function writeBytesAtomic(target: string, bytes: Buffer, options: AtomicWriteOptions): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.jgates-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  let created = false;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, options.mode ?? 0o666);
    created = true;
    writeAll(fd, bytes, options.faults?.failAfterBytes);
    if (options.mode !== undefined) {
      try {
        fs.fchmodSync(fd, options.mode);
      } catch {
        // chmod is not supported everywhere (some Windows filesystems); the mode then follows the platform
      }
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (!fs.readFileSync(tmp).equals(bytes)) throw new Error("the temporary file does not hold the expected bytes");
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    if (created) fs.rmSync(tmp, { force: true });
    throw new AtomicWriteError((error as Error).message, "temp", error);
  }
  try {
    options.faults?.beforeCommit?.();
    options.verify?.();
    if (options.faults?.failBeforeRename) throw new AtomicWriteError("simulated failure before the rename", "rename");
  } catch (error) {
    // What the caller's check throws (a conflict, a path that moved) reaches the caller unchanged.
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw new AtomicWriteError((error as Error).message, "rename", error);
  }
  // Flush the directory entry where the platform allows it.
  try {
    const dfd = fs.openSync(dir, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    // not supported (Windows): the rename is still atomic
  }
}
