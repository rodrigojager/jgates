export type ErrorKind = "usage" | "context" | "provider" | "parse";

export class SemanticGateError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SemanticGateError";
  }
}

export function exitCodeForError(error: unknown): number {
  if (error instanceof SemanticGateError) {
    if (error.kind === "context" || error.kind === "usage") {
      return 3;
    }
    return 2;
  }
  return 2;
}

