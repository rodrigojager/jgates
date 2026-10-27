export interface Sink {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const EXIT_OK = 0;
export const EXIT_USAGE = 3;
export const EXIT_INTERNAL = 4;

/** Writes exactly one JSON document to stdout. */
export function writeJson(sink: Pick<Sink, "stdout">, payload: unknown): void {
  sink.stdout(`${JSON.stringify(payload, null, 2)}\n`);
}

export interface StructuredError {
  schemaVersion: 1;
  status: "ERROR";
  code: string;
  message: string;
  fix: string | null;
  error: { code: string; message: string; fix: string | null };
  exitCode: number;
}

export function errorPayload(code: string, message: string, fix: string | null, exitCode: number): StructuredError {
  return { schemaVersion: 1, status: "ERROR", code, message, fix, error: { code, message, fix }, exitCode };
}

/**
 * Reports a structured error: one JSON document on stdout with --json (stderr stays empty),
 * plain text on stderr otherwise. Never emits ANSI. Returns the exit code.
 */
export function reportError(sink: Sink, json: boolean, code: string, message: string, fix: string | null, exitCode: number): number {
  if (json) writeJson(sink, errorPayload(code, message, fix, exitCode));
  else sink.stderr(`ERROR ${code}\n${message}\n${fix ?? ""}\n`);
  return exitCode;
}
