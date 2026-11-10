// A minimal tar writer (ustar with GNU long names) for the sync stream: the host packs the files that changed into one
// archive, the helper container unpacks it into the source volume. Writing it here keeps the host free of any `tar`
// binary (Windows has none that is guaranteed) and gives every entry exactly the mode the sync decided.
import fs from "node:fs";

const BLOCK = 512;
const CHUNK = 4 * 1024 * 1024;

function octal(value: number, width: number): string {
  return Math.max(0, Math.floor(value)).toString(8).padStart(width - 1, "0") + "\0";
}

function put(header: Buffer, offset: number, text: string, width: number): void {
  const bytes = Buffer.from(text, "utf8");
  bytes.copy(header, offset, 0, Math.min(bytes.length, width));
}

function header(name: string, type: string, size: number, mode: number, mtimeSeconds: number, link = ""): Buffer {
  const block = Buffer.alloc(BLOCK);
  put(block, 0, name, 100);
  put(block, 100, octal(mode, 8), 8);
  put(block, 108, octal(10001, 8), 8);
  put(block, 116, octal(10001, 8), 8);
  put(block, 124, octal(size, 12), 12);
  put(block, 136, octal(mtimeSeconds, 12), 12);
  block.fill(0x20, 148, 156);
  put(block, 156, type, 1);
  put(block, 157, link, 100);
  put(block, 257, "ustar\0", 6);
  put(block, 263, "00", 2);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(block, 148, sum.toString(8).padStart(6, "0") + "\0 ", 8);
  return block;
}

const padding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

export interface TarEntry {
  /** Path relative to the archive root, with forward slashes. */
  path: string;
  kind: "file" | "dir" | "symlink";
  mode: number;
  mtimeMs: number;
  /** File: absolute host path to read. */
  source?: string;
  /** File: bytes the header announces (the file is read for exactly this many). */
  size?: number;
  /** Symlink: target. */
  target?: string;
}

/** Writes tar archives to a file, entry by entry, through a buffer (synchronous: the sync is I/O bound and simple). */
export class TarWriter {
  private readonly fd: number;
  private buffer: Buffer[] = [];
  private buffered = 0;
  bytes = 0;

  constructor(private readonly file: string) {
    this.fd = fs.openSync(file, "w");
  }

  private push(chunk: Buffer): void {
    this.buffer.push(chunk);
    this.buffered += chunk.length;
    this.bytes += chunk.length;
    if (this.buffered >= CHUNK) this.flush();
  }

  private flush(): void {
    if (this.buffered === 0) return;
    fs.writeSync(this.fd, Buffer.concat(this.buffer, this.buffered));
    this.buffer = [];
    this.buffered = 0;
  }

  private name(entryPath: string, directory: boolean): string {
    const full = directory ? `${entryPath}/` : entryPath;
    if (Buffer.byteLength(full) <= 100) return full;
    // GNU long name: a pseudo entry carries the whole path; the real header keeps a truncated one.
    const data = Buffer.from(full + "\0", "utf8");
    this.push(header("././@LongLink", "L", data.length, 0, 0));
    this.push(data);
    this.push(Buffer.alloc(padding(data.length)));
    return Buffer.from(full, "utf8").subarray(0, 99).toString("utf8").replace(/�+$/, "");
  }

  /** Adds one entry; a file that cannot be read is reported by returning false (nothing of it is written). */
  add(entry: TarEntry): boolean {
    const mtime = entry.mtimeMs / 1000;
    if (entry.kind === "dir") {
      this.push(header(this.name(entry.path, true), "5", 0, entry.mode, mtime));
      return true;
    }
    if (entry.kind === "symlink") {
      this.push(header(this.name(entry.path, false), "2", 0, entry.mode, mtime, entry.target ?? ""));
      return true;
    }
    const size = entry.size ?? 0;
    let source: number;
    try {
      source = fs.openSync(entry.source ?? entry.path, "r");
    } catch {
      return false;
    }
    try {
      this.push(header(this.name(entry.path, false), "0", size, entry.mode, mtime));
      // A file that shrank (or failed) while it was read is padded with zeros: its stat no longer matches the one
      // recorded for it, so the next sync sends it again.
      let position = 0;
      let failed = false;
      while (position < size) {
        const chunk = Buffer.alloc(Math.min(CHUNK, size - position));
        let filled = 0;
        while (!failed && filled < chunk.length) {
          try {
            const n = fs.readSync(source, chunk, filled, chunk.length - filled, position + filled);
            if (n === 0) failed = true;
            else filled += n;
          } catch {
            failed = true;
          }
        }
        this.push(chunk);
        position += chunk.length;
      }
      this.push(Buffer.alloc(padding(size)));
      return true;
    } finally {
      fs.closeSync(source);
    }
  }

  close(): void {
    this.push(Buffer.alloc(BLOCK * 2));
    this.flush();
    fs.closeSync(this.fd);
  }
}

export interface ParsedTarEntry {
  path: string;
  type: string;
  mode: number;
  size: number;
  mtimeMs: number;
  link: string;
  data: Buffer;
}

/** Reads an archive written by TarWriter (ustar and GNU long names); used by the fake engine and the tests. */
export function readTar(buffer: Buffer): ParsedTarEntry[] {
  const entries: ParsedTarEntry[] = [];
  let offset = 0;
  let base = 0;
  let longName: string | null = null;
  const text = (start: number, width: number): string => {
    const slice = buffer.subarray(base + start, base + start + width);
    const end = slice.indexOf(0);
    return slice.subarray(0, end < 0 ? width : end).toString("utf8");
  };
  while (offset + BLOCK <= buffer.length) {
    base = offset;
    const block = buffer.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const type = text(156, 1) || "0";
    const size = parseInt(text(124, 12).trim() || "0", 8);
    const data = buffer.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + size + padding(size);
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    const name = longName ?? text(0, 100);
    longName = null;
    entries.push({
      path: name.replace(/\/$/, ""),
      type,
      mode: parseInt(text(100, 8).trim() || "0", 8),
      size,
      mtimeMs: parseInt(text(136, 12).trim() || "0", 8) * 1000,
      link: text(157, 100),
      data: Buffer.from(data),
    });
  }
  return entries;
}
