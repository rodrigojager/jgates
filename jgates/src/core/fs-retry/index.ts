// A rename over an existing file, for the temporary-file-then-rename writes of the run, sequence and semantic records.
// On Windows a rename can fail for a moment (EPERM, EBUSY, EACCES) while the system, an indexer, a virus scanner or a
// reader holds the target: the write is retried a few times before it is an error. Elsewhere it is a plain rename.
import fs from "node:fs";

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
const ATTEMPTS = 12;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !TRANSIENT.has(code) || attempt >= ATTEMPTS) throw error;
      pause(Math.min(25 * attempt, 200));
    }
  }
}
