// A log file with a size limit: the process output goes to disk as it arrives (never held whole in memory), is cut
// at the limit, and the file ends with a marker saying how much was kept and how much was dropped.
import fs from "node:fs";

export const TRUNCATION_MARKER = "[jgates] output truncated";

/** The line of a container header that names the full docker run line (the UI's "Comando executado"). */
export const CONTAINER_HEADER_MARK = "Comando executado: ";

/** Quotes an argument the way a shell user would type it (for the `docker run` line of a log header). */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The header of a host process log: what was started and where. */
export function processHeader(spec: { executable: string; args: string[]; cwd: string }): string {
  return `executable: ${spec.executable}\nargs: ${JSON.stringify(spec.args)}\ncwd: ${spec.cwd}\n---\n`;
}

/**
 * The header of a step container log: the command as run inside the container (executable, args, working directory)
 * and, under "Comando executado", the full `docker run` line of the engine client (what the UI shows as the command).
 */
export function containerHeader(input: { command: string[]; workdir: string; container: string; image: string; runtime: string; dockerArgs: string[] }): string {
  const [executable = "", ...args] = input.command;
  return [
    `executable: ${executable}`,
    `args: ${JSON.stringify(args)}`,
    `cwd: ${input.workdir}`,
    `container: ${input.container}`,
    `image: ${input.image}`,
    `${CONTAINER_HEADER_MARK}${[input.runtime, ...input.dockerArgs].map(shellQuote).join(" ")}`,
    "---",
    "",
  ].join("\n");
}

export class BoundedLog {
  private fd: number | null;
  private kept = 0;
  private seen = 0;

  constructor(
    readonly file: string,
    private readonly limit: number,
    header?: string,
  ) {
    this.fd = fs.openSync(file, "w", 0o600);
    if (header) fs.writeSync(this.fd, header);
  }

  /** Bytes the process wrote to this stream. */
  get bytesSeen(): number {
    return this.seen;
  }

  get truncated(): boolean {
    return this.seen > this.kept;
  }

  write(chunk: Buffer): void {
    this.seen += chunk.length;
    if (this.fd === null || this.kept >= this.limit) return;
    const room = this.limit - this.kept;
    const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
    fs.writeSync(this.fd, part);
    this.kept += part.length;
  }

  close(footer?: string): void {
    if (this.fd === null) return;
    if (this.truncated) {
      fs.writeSync(this.fd, `\n${TRUNCATION_MARKER}: kept ${this.kept} of ${this.seen} bytes (limit ${this.limit} bytes)\n`);
    }
    if (footer) fs.writeSync(this.fd, footer);
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

/** In-memory capture with a limit: what the adapter parses. Past the limit the rest is dropped and `truncated` is set. */
export class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  write(chunk: Buffer): void {
    if (this.kept >= this.limit) {
      this.truncated = true;
      return;
    }
    const room = this.limit - this.kept;
    if (chunk.length > room) {
      this.truncated = true;
      this.chunks.push(chunk.subarray(0, room));
      this.kept += room;
      return;
    }
    this.chunks.push(chunk);
    this.kept += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
