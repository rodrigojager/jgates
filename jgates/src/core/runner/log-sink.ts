// A log file with a size limit: the process output goes to disk as it arrives (never held whole in memory), is cut
// at the limit, and the file ends with a marker saying how much was kept and how much was dropped.
import fs from "node:fs";

export const TRUNCATION_MARKER = "[jgates] output truncated";

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
