// The one line of a child's stderr that says why it died, for a message the user can act on. Only an exception line
// (`SomeError: message`, the last line of a Python traceback, or `Error: message` of Node) is taken, never the rest
// of the output: a tool's stderr may echo what it analyzed, and the full text stays in the run's log file.

const EXCEPTION_LINE = /^(?:[A-Za-z_][\w.]*\.)?\w*(?:Error|Exception)(?::\s.*)?$/;
const MAX_LENGTH = 240;

/** The last exception line of `stderr`, trimmed and bounded; null when there is none. */
export function exceptionLine(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line !== "" && EXCEPTION_LINE.test(line)) return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 1)}…` : line;
  }
  return null;
}
