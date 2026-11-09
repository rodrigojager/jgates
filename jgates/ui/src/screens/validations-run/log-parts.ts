// Reading the step logs the runner writes, without changing their format. Each tool invocation writes
// `<invocation>.stdout.log` and `<invocation>.stderr.log` (an invocation id may contain dots: `import-linter.graph`,
// `quality-bridge.container`). JGates itself writes, into the error stream, a command header (`executable: ...` lines
// up to a line `---`), a footer (`---`, then exit code, signal and duration) and, for the bridge, a `--- jgates ---`
// trailer. Those lines are facts about the command, not output of the tool, so the screen shows them apart.

export type Stream = "stdout" | "stderr";

export interface LogFile {
  name: string;
  bytes: number;
}

export interface LogGroup {
  /** The invocation id: the file name without `.stdout.log` / `.stderr.log`. */
  invocation: string;
  /** What follows the step id in the invocation id (`graph` in `import-linter.graph`), or null for the step's own. */
  part: string | null;
  files: Partial<Record<Stream, LogFile>>;
}

const SUFFIX = /\.(stdout|stderr)\.log$/;

/** The log files of one step, grouped by invocation, the step's own invocation first, then the others by name. */
export function groupLogs(stepId: string, files: LogFile[]): LogGroup[] {
  const groups = new Map<string, LogGroup>();
  for (const f of files) {
    const match = SUFFIX.exec(f.name);
    if (!match) continue;
    const invocation = f.name.slice(0, match.index);
    if (invocation !== stepId && !invocation.startsWith(`${stepId}.`)) continue;
    let g = groups.get(invocation);
    if (!g) {
      g = { invocation, part: invocation === stepId ? null : invocation.slice(stepId.length + 1), files: {} };
      groups.set(invocation, g);
    }
    g.files[match[1] as Stream] = f;
  }
  return [...groups.values()].sort((a, b) => (a.part === null ? -1 : b.part === null ? 1 : a.invocation.localeCompare(b.invocation)));
}

export interface CommandFact {
  key: string;
  value: string;
}

export interface ParsedLog {
  /** What the tool wrote. */
  body: string;
  /** What JGates wrote about the command (header and footer), in order; empty when the file has none. */
  facts: CommandFact[];
  /** The `--- jgates ---` trailer some adapters add (the adapter's own summary of the whole step). */
  trailer: CommandFact[];
}

const FACT_LINE = /^([a-z][a-z ]*[a-z]): ?(.*)$/;
const FOOTER = /(?:^|\n)---\nexit code: [^\n]*\nsignal: [^\n]*\nduration ms: [^\n]*\n(?:(?:timed out|cancelled|spawn error: [^\n]*)\n)*$/;
const TRAILER = "--- jgates ---\n";

function factsOf(lines: string[]): CommandFact[] {
  return lines
    .filter((line) => line !== "" && line !== "---")
    .map((line) => {
      const m = FACT_LINE.exec(line);
      return m ? { key: m[1] as string, value: m[2] as string } : { key: line, value: "" };
    });
}

/**
 * Splits the text of a log into what the tool wrote and what JGates wrote about the command. The header is read up to
 * the first line that is exactly `---`, and only when the file starts with `executable:` (old runs and every adapter
 * write it so); the footer and the trailer are read only once the whole file is loaded (`complete`), because they are
 * at its end. A text that does not have that shape is all body.
 */
export function parseLog(text: string, complete: boolean): ParsedLog {
  let body = text;
  const facts: CommandFact[] = [];
  if (body.startsWith("executable: ")) {
    const end = body.indexOf("\n---\n");
    const endAtEof = end === -1 && body.endsWith("\n---") ? body.length - 4 : -1;
    const at = end !== -1 ? end : endAtEof;
    if (at !== -1) {
      const header = body.slice(0, at).split("\n");
      if (header.every((line) => FACT_LINE.test(line))) {
        facts.push(...factsOf(header));
        body = body.slice(at + 5);
      }
    }
  }
  const tail: CommandFact[] = [];
  if (complete) {
    const inner = body.lastIndexOf(`\n${TRAILER}`);
    const trailerAt = inner !== -1 ? inner + 1 : body.startsWith(TRAILER) ? 0 : -1;
    if (trailerAt !== -1) {
      const lines = body.slice(trailerAt + TRAILER.length).split("\n");
      if (lines.every((line) => line === "" || FACT_LINE.test(line))) {
        tail.push(...factsOf(lines));
        body = body.slice(0, trailerAt);
      }
    }
    const footer = FOOTER.exec(body);
    if (footer) {
      facts.push(...factsOf(footer[0].split("\n")));
      body = body.slice(0, footer.index);
    }
  }
  return { body, facts, trailer: tail };
}

/** True when the text has nothing but blank space. */
export const isBlank = (text: string): boolean => text.trim() === "";
