// The request one validation is built from: what "Escolher" collects and "Revisar" turns into a plan. Hash routes carry no
// query string in this application, so the request travels in memory (and in sessionStorage, to survive a reload).

export type TargetKind = "changed" | "full" | "paths" | "commit" | "compare";

export interface ValidationRequest {
  profile: string | null;
  target: TargetKind;
  /** Directory (target "paths"). */
  path: string;
  /** Commit reference (target "commit") or the head of a comparison. */
  head: string;
  /** Base reference of a comparison. */
  base: string;
  /** Selectors switched off for this run only. */
  skip: string[];
}

export const EMPTY_REQUEST: ValidationRequest = { profile: null, target: "full", path: "", head: "", base: "", skip: [] };

const KEY = "jgates.validation.request";
let memory: ValidationRequest = EMPTY_REQUEST;

export function readRequest(): ValidationRequest {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw) return { ...EMPTY_REQUEST, ...(JSON.parse(raw) as Partial<ValidationRequest>) };
  } catch {
    // Storage may be blocked; the in-memory copy is enough.
  }
  return memory;
}

export function writeRequest(request: ValidationRequest): void {
  memory = request;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(request));
  } catch {
    // Not persisted; the in-memory copy still serves the next screen.
  }
}

/** The body of POST /api/plans for a request. */
export function planBody(request: ValidationRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (request.profile) body.profile = request.profile;
  switch (request.target) {
    case "changed":
      body.scope = "changed";
      break;
    case "full":
      body.scope = "full";
      break;
    case "paths":
      body.scope = "paths";
      body.paths = request.path.trim() === "" ? [] : [request.path.trim()];
      break;
    case "commit":
      body.scope = "full";
      if (request.head.trim() !== "") body.head = request.head.trim();
      break;
    case "compare":
      body.scope = "changed";
      if (request.base.trim() !== "") body.base = request.base.trim();
      if (request.head.trim() !== "") body.head = request.head.trim();
      break;
  }
  if (request.skip.length > 0) body.skip = request.skip;
  return body;
}

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const quote = (value: string): string => (SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/** The command that runs exactly this validation from a terminal; its plan has the same hash. */
export function equivalentCommand(body: Record<string, unknown>, workspacePath: string): string {
  const parts = ["jgates", "run", "--cwd", quote(workspacePath)];
  if (typeof body.profile === "string") parts.push("--profile", quote(body.profile));
  if (typeof body.scope === "string") parts.push("--scope", body.scope);
  for (const p of (body.paths as string[] | undefined) ?? []) parts.push("--path", quote(p));
  if (typeof body.base === "string") parts.push("--base", quote(body.base));
  if (typeof body.head === "string") parts.push("--head", quote(body.head));
  for (const s of (body.skip as string[] | undefined) ?? []) parts.push("--skip", quote(s));
  for (const s of (body.only as string[] | undefined) ?? []) parts.push("--only", quote(s));
  parts.push("--json");
  return parts.join(" ");
}
