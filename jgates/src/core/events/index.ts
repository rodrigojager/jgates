// Events of a run as JSON Lines: one object per line with runId, a sequence
// that only grows (1, 2, 3...) and a type, written as they happen so the state survives a crash of the main process.
// A reader resumes from a cursor: it asks for the events after sequence N and gets only those.
// Contract: schemas/events/event.schema.json (versioned by schemaVersion).
import fs from "node:fs";

export const EVENTS_SCHEMA_VERSION = 1;
export const EVENTS_FILE = "events.jsonl";

export const EVENT_TYPES = [
  "run-started",
  "step-started",
  "process-started",
  "process-finished",
  "stage",
  "step-finished",
  "step-skipped",
  "cancel-requested",
  "run-finished",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface RunEvent {
  schemaVersion: typeof EVENTS_SCHEMA_VERSION;
  runId: string;
  sequence: number;
  type: EventType;
  /** ISO 8601. */
  at: string;
  data: Record<string, unknown>;
}

export interface EventLogOptions {
  runId: string;
  /** Files the stream is appended to (the run folder's events.jsonl and, with --events-jsonl, the user's file). */
  files: string[];
  now?: () => Date;
  /** Called after each event is written (progress on stderr, tests). */
  listener?: (event: RunEvent) => void;
}

/** Append-only event stream of one run. Every event is on disk (all files) before `emit` returns. */
export class EventLog {
  private sequence = 0;
  private readonly fds: number[] = [];
  private closed = false;

  constructor(private readonly opts: EventLogOptions) {
    // A new stream starts empty: the file holds the events of this run only.
    for (const file of opts.files) this.fds.push(fs.openSync(file, "w", 0o600));
  }

  get runId(): string {
    return this.opts.runId;
  }

  /** Sequence of the last event written (0 before the first). */
  get cursor(): number {
    return this.sequence;
  }

  emit(type: EventType, data: Record<string, unknown> = {}): RunEvent | null {
    if (this.closed) return null;
    this.sequence += 1;
    const event: RunEvent = {
      schemaVersion: EVENTS_SCHEMA_VERSION,
      runId: this.opts.runId,
      sequence: this.sequence,
      type,
      at: (this.opts.now ?? (() => new Date()))().toISOString(),
      data,
    };
    const line = `${JSON.stringify(event)}\n`;
    for (const fd of this.fds) {
      try {
        fs.writeSync(fd, line);
      } catch {
        // One unwritable copy does not stop the run; the run folder's copy is the reference.
      }
    }
    try {
      this.opts.listener?.(event);
    } catch {
      // A listener never breaks the stream.
    }
    return event;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fd of this.fds) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

export interface ReadEventsResult {
  events: RunEvent[];
  /** Pass it back as `after` to get only what came later. */
  cursor: number;
  /** Lines that are not events (a line still being written is not counted: it is left for the next read). */
  invalidLines: number;
}

/** Parses JSON Lines text; an unfinished last line (no newline yet) is ignored, so a reader never sees half an event. */
export function parseEvents(text: string, after = 0): ReadEventsResult {
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const events: RunEvent[] = [];
  let invalidLines = 0;
  let cursor = after;
  for (const line of complete.split("\n")) {
    if (line.trim() === "") continue;
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    const e = doc as Partial<RunEvent>;
    if (typeof e.sequence !== "number" || typeof e.type !== "string" || typeof e.runId !== "string") {
      invalidLines += 1;
      continue;
    }
    if (e.sequence <= after) continue;
    events.push(e as RunEvent);
    cursor = Math.max(cursor, e.sequence);
  }
  return { events, cursor, invalidLines };
}

/** Reads the events of a file after the cursor `after` (0: from the start). A missing file has no events yet. */
export function readEvents(file: string, options: { after?: number; runId?: string } = {}): ReadEventsResult {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const result = parseEvents(text, options.after ?? 0);
  if (options.runId) result.events = result.events.filter((e) => e.runId === options.runId);
  return result;
}
