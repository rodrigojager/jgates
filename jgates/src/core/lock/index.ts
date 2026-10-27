// .jgates/lock.json: the tool versions, the prepared rule sets and the container images pinned by `jgates tools prepare`.
// Reading never fails; the only writer is the prepare step (an explicit action), through an atomic replace.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const LOCK_FILE = ".jgates/lock.json";

export interface LockedRules {
  /** What was asked for, for example "p/default". */
  ref: string;
  /** sha256 of the stored rule file; also the folder name under <home>/tools. */
  hash: string;
  /** File name inside <home>/tools/<hash>. */
  file: string;
  /** Where the bytes came from (the URL). */
  source: string;
  bytes: number;
}

/** The container image of an instance that runs on the container runner (the plan never reads an image elsewhere). */
export interface LockedImage {
  /** What was asked for: a tag (name:tag) or a digest reference. */
  reference: string;
  /** The image id the runtime reported (sha256:<64 hex>). */
  id: string;
  /** What the container runner starts: the repository digest (name@sha256:...) when the image has one, else the id. */
  pinned: string;
  /** The image label the tool version was read from (org.jgates.tool.<tool>.version). */
  versionLabel: string;
}

export interface LockedTool {
  adapter: string;
  adapterVersion: string;
  toolVersion: string | null;
  preparedAt: string;
  rules?: LockedRules[];
  image?: LockedImage;
}

export interface LockDocument {
  schemaVersion: 1;
  tools: Record<string, LockedTool>;
}

export interface LockRead {
  /** Workspace-relative path of the lock file. */
  file: string;
  exists: boolean;
  lock: LockDocument;
  /** Why the file could not be used (unreadable JSON or schema violation); the lock is then empty. */
  problem: string | null;
  /** sha256 of the bytes on disk, null when the file is absent. */
  sha256: string | null;
}

type Validator = ((doc: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };
let validator: Validator | null = null;

export function lockSchemaFile(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "schemas", "config", "lock.schema.json");
}

function lockValidator(): Validator {
  if (validator) return validator;
  const require = createRequire(import.meta.url);
  const mod = require("ajv/dist/2020") as { default: new (opts: object) => { compile(schema: unknown): Validator } };
  validator = new mod.default({ strict: true, allErrors: true, allowUnionTypes: true }).compile(JSON.parse(fs.readFileSync(lockSchemaFile(), "utf8")));
  return validator;
}

/** Problems of a lock document against schemas/config/lock.schema.json (empty when valid). */
export function validateLock(doc: unknown): string[] {
  const validate = lockValidator();
  if (validate(doc)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}

export const emptyLock = (): LockDocument => ({ schemaVersion: 1, tools: {} });

export function readLock(dir: string): LockRead {
  const abs = path.join(dir, LOCK_FILE);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(abs);
  } catch {
    return { file: LOCK_FILE, exists: false, lock: emptyLock(), problem: null, sha256: null };
  }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return { file: LOCK_FILE, exists: true, lock: emptyLock(), problem: (error as Error).message, sha256 };
  }
  const problems = validateLock(parsed);
  if (problems.length > 0) return { file: LOCK_FILE, exists: true, lock: emptyLock(), problem: problems.join("; "), sha256 };
  return { file: LOCK_FILE, exists: true, lock: parsed as LockDocument, problem: null, sha256 };
}

/** Writes the lock atomically (temporary file in the same folder, then rename), keys sorted for a stable diff. */
export function writeLock(dir: string, lock: LockDocument): void {
  const abs = path.join(dir, LOCK_FILE);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const sorted: LockDocument = { schemaVersion: 1, tools: Object.fromEntries(Object.keys(lock.tools).sort().map((k) => [k, lock.tools[k] as LockedTool])) };
  const tmp = `${abs}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    fs.renameSync(tmp, abs);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
