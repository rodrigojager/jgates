import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashBytes } from "../codecs/yaml/index.js";
import { resolveToolBindings, type BindingRole, type ResolvedBinding, type ToolBindingsResult, type ToolInstance } from "../tools/index.js";
import { translator } from "../../i18n/index.js";
import { AtomicWriteError, writeBytesAtomic, type WriteFaults } from "./atomic.js";
import { conformText, decodeBytes, encodeText, type DocumentEncoding, type Eol } from "./encoding.js";
import { unifiedDiff } from "./diff.js";
import { matchesExactly } from "../discovery/glob.js";
import { insideBySegments, nameProblem, realPathOf, samePath } from "./paths.js";
import { formatOf, validateText, type DocumentFormat, type ValidationResult } from "./validate.js";

/**
 * Document service: reads and writes the real files a tool instance is bound to (.jgates/tools.yml), for the UI
 * (through the local server) and the CLI (`jgates tools config`). Documents are addressed only by instance id,
 * binding id and, for a directory binding, one of the entries the binding lists; never by a path the caller makes up.
 *
 * Reading returns the text with its revision (sha256 of the bytes), encoding, BOM, line breaks and state. Saving
 * requires the revision the caller read: when the file moved on, the answer is a conflict with base, local and
 * current, and nothing is written. Writes are atomic (exclusive temporary file in the same directory, flushed and read
 * back, paths and revision checked again, rename) and keep the encoding, the BOM, the line breaks and the file mode.
 * Nothing here executes the content of a document.
 */

export { unifiedDiff } from "./diff.js";
export { validateText, formatOf, type DocumentFormat, type ValidationResult, type SyntaxIssue } from "./validate.js";
export { decodeBytes, encodeText, conformText, detectEol, type DocumentEncoding, type Eol } from "./encoding.js";
export { insideBySegments, samePath } from "./paths.js";
export { writeBytesAtomic, AtomicWriteError, type WriteFaults } from "./atomic.js";

const t = translator("documents");

export type DocumentState = "editable" | "read-only" | "governed" | "package";
export type StateReasonCode =
  | "ACCESS_READ"
  | "FS_READ_ONLY"
  | "PACKAGE_FILE"
  | "GOVERNED"
  | "BINARY"
  | "TOO_LARGE"
  | "ENCODING_UNSUPPORTED"
  | "NAME_NOT_ALLOWED"
  | "PARENT_MISSING";

export type DocumentErrorCode =
  | "INSTANCE_NOT_FOUND"
  | "BINDING_NOT_FOUND"
  | "BINDING_REFUSED"
  | "BINDING_IS_DIRECTORY"
  | "ENTRY_NOT_FOUND"
  | "ENTRY_NOT_ALLOWED"
  | "DOCUMENT_MISSING"
  | "DOCUMENT_EXISTS"
  | "DOCUMENT_NOT_TEXT"
  | "DOCUMENT_READ_ONLY"
  | "DOCUMENT_ENCODING"
  | "DOCUMENT_INVALID"
  | "PATH_CHANGED"
  | "WRITE_FAILED"
  | "VERIFY_FAILED";

export class DocumentError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    message: string,
    readonly fix: string | null,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DocumentError";
  }
}

export interface DocumentRef {
  instance: string;
  binding: string;
  /** Entry of a directory binding (path relative to the directory, as the binding lists it); null for a file binding. */
  entry: string | null;
}

export interface DocumentOptions {
  /** Entry of a directory binding. */
  entry?: string;
  /** Real paths whose files are governed (read-only for the editor). */
  governedRoots?: string[];
  /** Extra real paths of installed packages (read-only); the JGates dist/ and anything under node_modules always are. */
  packageRoots?: string[];
  /** Largest file loaded as text (default 2 MiB). */
  maxBytes?: number;
  /**
   * Internal: lets a save name an entry the directory binding does not list yet (creating a new file is an explicit
   * action: only a save with expectedRevision null sets it). The entry must stay inside the binding directory.
   */
  allowNewEntry?: boolean;
  /** Internal (rename): the new name need not match include, because the caller rewrites the include that named the old file. */
  skipIncludeCheck?: boolean;
}

export interface OpenedDocument {
  ref: DocumentRef;
  /** Canonical real path: the identity shared by every instance that uses this physical file. */
  identity: string;
  /** Real path on disk (with the case the filesystem reports). */
  path: string;
  /** Workspace-relative path with forward slashes; null for a file under an external root. */
  relPath: string | null;
  /** "workspace" or the id of the external root. */
  root: string;
  role: BindingRole;
  access: "read" | "write";
  format: DocumentFormat;
  exists: boolean;
  /** null when the file does not exist or is not editable text (binary, too large, undecodable). */
  text: string | null;
  /** sha256 of the bytes; null when the file does not exist. */
  revision: string | null;
  encoding: DocumentEncoding | null;
  bom: boolean;
  eol: Eol;
  size: number | null;
  /** Permission bits, as octal text (for example "644"); null when the file does not exist. */
  mode: string | null;
  state: DocumentState;
  reasons: Array<{ code: StateReasonCode; message: string }>;
  /** Other instances and bindings that use the same physical file. */
  sharedWith: Array<{ tool: string; binding: string; role: BindingRole }>;
}

export interface DocumentValidation extends ValidationResult {
  ref: DocumentRef;
  identity: string;
  /** Revision of the file on disk (null when absent). */
  revision: string | null;
  /** "disk" when the file on disk was checked, "text" when the text given by the caller was. */
  source: "disk" | "text";
}

export interface EditPreview {
  ref: DocumentRef;
  identity: string;
  revision: string | null;
  changed: boolean;
  /** Unified diff from the file on disk to the proposed text, as it would be written. */
  diff: string;
  validation: ValidationResult;
}

export interface SaveRequest {
  /** Revision the caller read; null means "the file must not exist yet" (creating it is this explicit action). */
  expectedRevision: string | null;
  text: string;
  entry?: string;
  /** Saves even when the syntax check fails (an explicit choice of the text editor). */
  allowInvalid?: boolean;
  /** Text of the base revision, when the caller still has it (returned in a conflict). */
  baseText?: string;
}

export interface ConflictSide {
  revision: string | null;
  text: string | null;
}

export type SaveResult =
  | { status: "saved"; ref: DocumentRef; identity: string; previousRevision: string | null; revision: string; diff: string; validation: ValidationResult }
  | { status: "unchanged"; ref: DocumentRef; identity: string; revision: string; validation: ValidationResult }
  | {
      status: "conflict";
      ref: DocumentRef;
      identity: string;
      conflict: { base: ConflictSide; local: ConflictSide; current: ConflictSide & { exists: boolean } };
      /** Unified diff from the current file to the local text. */
      diff: string;
    };

/** Internal options; `faults` exists only for tests. */
export interface SaveInternals extends DocumentOptions {
  faults?: WriteFaults;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/** The package's own build output (dist/): built-in files are never edited in place. */
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Located {
  ref: DocumentRef;
  resolved: ToolBindingsResult;
  instance: ToolInstance;
  binding: ResolvedBinding;
  identity: string;
  /** Real path to read and write (case as on disk). */
  target: string;
  relPath: string | null;
  allowedRoots: string[];
}

function realOrSelf(p: string): string {
  try {
    return realPathOf(p);
  } catch {
    return path.resolve(p);
  }
}

const NEW_ENTRY = /^(?![/~])(?!.*\\)(?!(?:.*\/)?\.{1,2}(?:\/|$))(?!.*\/\/)[^\u0000]{1,1024}$/;

/** Target of an entry the binding does not list: a regular new file inside the real binding directory, matching include. */
function newEntryTarget(binding: ResolvedBinding, entry: string, skipInclude = false): string {
  const refuse = (code: DocumentErrorCode, reason: string): never => {
    throw new DocumentError(code, t("documents_new_entry_refused", { entry, reason }), t("documents_new_entry_refused_fix"));
  };
  if (!binding.exists) return refuse("ENTRY_NOT_FOUND", "BINDING_DIRECTORY_MISSING");
  if (binding.access === "read") return refuse("DOCUMENT_READ_ONLY", "ACCESS_READ");
  if (!NEW_ENTRY.test(entry)) return refuse("ENTRY_NOT_ALLOWED", "BAD_PATH");
  if (!skipInclude && binding.include && !binding.include.some((p) => matchesExactly(p, entry))) return refuse("ENTRY_NOT_ALLOWED", "NOT_IN_INCLUDE");
  const root = realOrSelf(binding.absPath);
  const parent = realOrSelf(path.dirname(path.join(root, ...entry.split("/"))));
  if (!insideBySegments(root, parent)) return refuse("ENTRY_NOT_ALLOWED", "OUTSIDE_BINDING");
  return path.join(parent, entry.split("/").pop() as string);
}

/** Finds the document of instance × binding (× entry) from a fresh resolution of tools.yml. */
function locate(dir: string, instanceId: string, bindingId: string, entry: string | undefined, allowNew = false, skipInclude = false): Located {
  const resolved = resolveToolBindings(dir, { skipInventory: true });
  const instance = resolved.instances.find((i) => i.id === instanceId);
  if (!instance) {
    const available = resolved.instances.map((i) => i.id).join(", ") || "-";
    throw new DocumentError("INSTANCE_NOT_FOUND", t("documents_instance_not_found", { name: instanceId }), t("documents_instance_not_found_fix", { available }), { available: resolved.instances.map((i) => i.id) });
  }
  const binding = instance.bindings.find((b) => b.id === bindingId);
  const ids = instance.bindings.map((b) => b.id);
  if (!binding) {
    throw new DocumentError("BINDING_NOT_FOUND", t("documents_binding_not_found", { binding: bindingId, instance: instanceId }), t("documents_binding_not_found_fix", { available: ids.join(", ") || "-" }), { available: ids });
  }
  if (binding.refused || binding.identity === null) {
    const diag = resolved.diagnostics.find((d) => d.pathSegments[0] === "tools" && d.pathSegments[1] === instanceId && d.pathSegments.includes(bindingId));
    throw new DocumentError("BINDING_REFUSED", t("documents_binding_refused", { binding: bindingId, instance: instanceId, reason: diag?.message ?? "-" }), diag?.suggestion ?? null, { diagnostic: diag?.code ?? null });
  }
  const workspaceReal = realOrSelf(resolved.projectDir);
  const externals = resolved.externalRoots.map((r) => r.path);
  const allowedRoots = binding.root === "workspace" ? [workspaceReal, ...externals] : (resolved.externalRoots.filter((r) => r.id === binding.root).map((r) => r.path));
  const ref: DocumentRef = { instance: instanceId, binding: bindingId, entry: null };

  let identity: string;
  let target: string;
  if (binding.kind === "directory") {
    const entries = binding.files.map((f) => f.path);
    if (entry === undefined) {
      throw new DocumentError("BINDING_IS_DIRECTORY", t("documents_binding_is_directory", { binding: bindingId }), t("documents_binding_is_directory_fix", { available: entries.join(", ") || "-" }), { entries });
    }
    const file = binding.files.find((f) => f.path === entry);
    if (!file && allowNew) {
      const created = newEntryTarget(binding, entry, skipInclude);
      ref.entry = entry;
      identity = created;
      target = created;
    } else if (!file) throw new DocumentError("ENTRY_NOT_FOUND", t("documents_entry_not_found", { entry, binding: bindingId }), t("documents_entry_not_found_fix", { available: entries.join(", ") || "-" }), { entries });
    else {
      ref.entry = entry;
      identity = file.identity;
      target = realOrSelf(path.join(binding.absPath, ...entry.split("/")));
    }
  } else {
    if (entry !== undefined) throw new DocumentError("ENTRY_NOT_ALLOWED", t("documents_entry_not_allowed", { binding: bindingId }), t("documents_entry_not_allowed_fix"));
    identity = binding.identity;
    if (binding.exists) target = realOrSelf(binding.absPath);
    else target = path.join(realOrSelf(path.dirname(binding.absPath)), path.basename(binding.absPath));
  }
  // Defence in depth: the target must be the identity the resolution reported and lie inside an allowed root,
  // compared by path segments.
  if (!samePath(target, identity)) {
    throw new DocumentError("PATH_CHANGED", t("documents_path_changed", { path: identity }), t("documents_path_changed_fix"));
  }
  if (!allowedRoots.some((root) => insideBySegments(root, target))) {
    throw new DocumentError("BINDING_REFUSED", t("documents_binding_refused", { binding: bindingId, instance: instanceId, reason: "BINDING_OUTSIDE_ROOT" }), null, { diagnostic: "BINDING_OUTSIDE_ROOT" });
  }
  const relPath = insideBySegments(workspaceReal, target) ? path.relative(workspaceReal, target).split(path.sep).join("/") || "." : null;
  return { ref, resolved, instance, binding, identity, target, relPath, allowedRoots };
}

interface DiskState {
  exists: boolean;
  bytes: Buffer | null;
  size: number | null;
  mode: number | null;
  tooLarge: boolean;
}

/** Reads the target without following a symlink at its last component. */
function readDisk(target: string, maxBytes: number): DiskState {
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { exists: false, bytes: null, size: null, mode: null, tooLarge: false };
    if (code === "ELOOP") throw new DocumentError("PATH_CHANGED", t("documents_path_changed", { path: target }), t("documents_path_changed_fix"));
    throw new DocumentError("WRITE_FAILED", t("documents_read_failed", { path: target, detail: (error as Error).message }), null);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new DocumentError("DOCUMENT_NOT_TEXT", t("documents_not_a_file", { path: target }), null);
    const mode = st.mode & 0o7777;
    if (st.size > maxBytes) return { exists: true, bytes: null, size: st.size, mode, tooLarge: true };
    return { exists: true, bytes: fs.readFileSync(fd), size: st.size, mode, tooLarge: false };
  } finally {
    fs.closeSync(fd);
  }
}

function writable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function reason(code: StateReasonCode, params: Record<string, string | number> = {}) {
  return { code, message: t(`documents_reason_${code}`, params) };
}

function stateOf(loc: Located, disk: DiskState, decodedProblem: string | null, options: DocumentOptions): { state: DocumentState; reasons: OpenedDocument["reasons"] } {
  const reasons: OpenedDocument["reasons"] = [];
  const packageRoots = [PACKAGE_DIR, ...(options.packageRoots ?? [])];
  const inPackage = packageRoots.some((r) => insideBySegments(realOrSelf(r), loc.target)) || loc.target.split(/[\\/]/).includes("node_modules");
  if (inPackage) return { state: "package", reasons: [reason("PACKAGE_FILE")] };
  if ((options.governedRoots ?? []).some((r) => insideBySegments(realOrSelf(r), loc.target))) return { state: "governed", reasons: [reason("GOVERNED")] };
  if (loc.binding.access === "read") reasons.push(reason("ACCESS_READ"));
  const name = nameProblem(path.basename(loc.target));
  if (name) reasons.push(reason("NAME_NOT_ALLOWED", { detail: name }));
  if (disk.exists) {
    if (!writable(loc.target) || !writable(path.dirname(loc.target))) reasons.push(reason("FS_READ_ONLY"));
  } else if (!fs.existsSync(path.dirname(loc.target))) reasons.push(reason("PARENT_MISSING"));
  else if (!writable(path.dirname(loc.target))) reasons.push(reason("FS_READ_ONLY"));
  if (disk.tooLarge) reasons.push(reason("TOO_LARGE", { size: disk.size ?? 0 }));
  if (decodedProblem === "BINARY") reasons.push(reason("BINARY"));
  if (decodedProblem === "ENCODING_UNSUPPORTED") reasons.push(reason("ENCODING_UNSUPPORTED"));
  return { state: reasons.length ? "read-only" : "editable", reasons };
}

function sharedWith(loc: Located): OpenedDocument["sharedWith"] {
  const doc = loc.resolved.documents.find((d) => d.identity === loc.identity);
  return (doc?.usedBy ?? []).filter((u) => !(u.tool === loc.ref.instance && u.binding === loc.ref.binding));
}

function load(dir: string, instanceId: string, bindingId: string, options: DocumentOptions) {
  const loc = locate(dir, instanceId, bindingId, options.entry, options.allowNewEntry === true, options.skipIncludeCheck === true);
  const disk = readDisk(loc.target, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const decoded = disk.bytes ? decodeBytes(disk.bytes) : null;
  return { loc, disk, decoded };
}

/** Reads a document. Never creates anything: a missing file comes back with exists false. */
export function openDocument(dir: string, instanceId: string, bindingId: string, options: DocumentOptions = {}): OpenedDocument {
  const { loc, disk, decoded } = load(dir, instanceId, bindingId, options);
  const { state, reasons } = stateOf(loc, disk, decoded?.problem ?? null, options);
  return {
    ref: loc.ref,
    identity: loc.identity,
    path: loc.target,
    relPath: loc.relPath,
    root: loc.binding.root,
    role: loc.binding.role,
    access: loc.binding.access,
    format: formatOf(loc.target),
    exists: disk.exists,
    text: decoded?.text ?? null,
    revision: disk.bytes ? hashBytes(disk.bytes) : disk.exists ? revisionOfLarge(loc.target) : null,
    encoding: decoded?.encoding ?? (disk.exists ? null : "utf-8"),
    bom: decoded?.bom ?? false,
    eol: decoded?.eol ?? "none",
    size: disk.size,
    mode: disk.mode === null ? null : (disk.mode & 0o777).toString(8),
    state,
    reasons,
    sharedWith: sharedWith(loc),
  };
}

function revisionOfLarge(target: string): string | null {
  try {
    return hashBytes(fs.readFileSync(target));
  } catch {
    return null;
  }
}

function requireText(loc: Located, disk: DiskState, decoded: ReturnType<typeof decodeBytes> | null): string {
  if (!disk.exists) throw new DocumentError("DOCUMENT_MISSING", t("documents_missing", { path: loc.relPath ?? loc.target }), t("documents_missing_fix"));
  if (!decoded || decoded.text === null) {
    const why = disk.tooLarge ? "TOO_LARGE" : (decoded?.problem ?? "BINARY");
    throw new DocumentError("DOCUMENT_NOT_TEXT", t("documents_not_text", { path: loc.relPath ?? loc.target, reason: why }), null, { reason: why });
  }
  return decoded.text;
}

/** Checks the syntax of the file on disk, or of `text` when given, for the format of the document. Executes nothing. */
export function validateDocument(dir: string, instanceId: string, bindingId: string, options: DocumentOptions & { text?: string } = {}): DocumentValidation {
  const { loc, disk, decoded } = load(dir, instanceId, bindingId, options);
  const text = options.text !== undefined ? options.text : requireText(loc, disk, decoded);
  return {
    ref: loc.ref,
    identity: loc.identity,
    revision: disk.bytes ? hashBytes(disk.bytes) : null,
    source: options.text !== undefined ? "text" : "disk",
    ...validateText(formatOf(loc.target), text),
  };
}

interface Proposal {
  text: string;
  bytes: Buffer;
}

/** The proposed text as it would be written: line breaks, encoding and BOM of the document. */
function propose(loc: Located, disk: DiskState, decoded: ReturnType<typeof decodeBytes> | null, text: string): Proposal {
  const encoding: DocumentEncoding = decoded?.encoding ?? "utf-8";
  const bom = decoded?.bom ?? false;
  const conformed = conformText(text, decoded?.eol ?? "none");
  try {
    return { text: conformed, bytes: encodeText(conformed, encoding, bom) };
  } catch (error) {
    throw new DocumentError("DOCUMENT_ENCODING", t("documents_encoding", { path: loc.relPath ?? loc.target, encoding, detail: (error as Error).message }), t("documents_encoding_fix", { encoding }), { encoding });
  }
}

const label = (loc: Located) => loc.relPath ?? loc.target;

/** Diff and validation of a proposed text, without writing anything. */
export function previewEdit(dir: string, instanceId: string, bindingId: string, request: { text: string } & DocumentOptions): EditPreview {
  const { loc, disk, decoded } = load(dir, instanceId, bindingId, request);
  if (disk.exists && (!decoded || decoded.text === null)) requireText(loc, disk, decoded);
  const current = decoded?.text ?? "";
  const proposal = propose(loc, disk, decoded, request.text);
  return {
    ref: loc.ref,
    identity: loc.identity,
    revision: disk.bytes ? hashBytes(disk.bytes) : null,
    changed: !disk.bytes || !proposal.bytes.equals(disk.bytes),
    diff: unifiedDiff(current, proposal.text, { oldLabel: `a/${label(loc)}`, newLabel: `b/${label(loc)}` }),
    validation: validateText(formatOf(loc.target), proposal.text),
  };
}

class LateConflict extends Error {}

/**
 * Saves a document with optimistic concurrency. A revision that moved gives `status: "conflict"` and writes nothing;
 * every other refusal throws a DocumentError. Success is reported only after the bytes on disk were read back.
 */
export function saveDocument(dir: string, instanceId: string, bindingId: string, request: SaveRequest, internals: SaveInternals = {}): SaveResult {
  const options: DocumentOptions = { ...internals, ...(request.entry !== undefined ? { entry: request.entry } : {}), allowNewEntry: request.expectedRevision === null };
  // Always a fresh resolution: a symlink swapped since the read is caught here.
  const { loc, disk, decoded } = load(dir, instanceId, bindingId, options);
  const currentRevision = disk.bytes ? hashBytes(disk.bytes) : disk.exists ? revisionOfLarge(loc.target) : null;
  const localRevision = (): string => {
    try {
      return hashBytes(propose(loc, disk, decoded, request.text).bytes);
    } catch {
      return hashBytes(Buffer.from(request.text, "utf8"));
    }
  };
  const conflict = (current: { revision: string | null; text: string | null; exists: boolean }): SaveResult => ({
    status: "conflict",
    ref: loc.ref,
    identity: loc.identity,
    conflict: {
      base: { revision: request.expectedRevision, text: request.baseText ?? null },
      local: { revision: localRevision(), text: request.text },
      current,
    },
    diff: unifiedDiff(current.text ?? "", request.text, { oldLabel: `current/${label(loc)}`, newLabel: `local/${label(loc)}` }),
  });
  if (currentRevision !== request.expectedRevision) {
    return conflict({ revision: currentRevision, text: decoded?.text ?? null, exists: disk.exists });
  }
  const { state, reasons } = stateOf(loc, disk, decoded?.problem ?? null, options);
  if (state !== "editable") {
    const codes = reasons.map((r) => r.code);
    if (codes.includes("BINARY") || codes.includes("TOO_LARGE") || codes.includes("ENCODING_UNSUPPORTED")) requireText(loc, disk, decoded);
    throw new DocumentError("DOCUMENT_READ_ONLY", t("documents_read_only", { path: label(loc), reason: reasons.map((r) => r.message).join("; ") }), t(`documents_read_only_fix_${state === "read-only" ? "local" : state}`), { state, reasons });
  }
  const proposal = propose(loc, disk, decoded, request.text);
  const validation = validateText(formatOf(loc.target), proposal.text);
  if (disk.bytes && proposal.bytes.equals(disk.bytes)) {
    return { status: "unchanged", ref: loc.ref, identity: loc.identity, revision: currentRevision as string, validation };
  }
  if (validation.status === "invalid" && !request.allowInvalid) {
    throw new DocumentError("DOCUMENT_INVALID", t("documents_invalid", { path: label(loc) }), t("documents_invalid_fix"), { validation });
  }

  const parent = path.dirname(loc.target);
  const verify = () => {
    // The directory must still be the real one that was validated, inside an allowed root.
    let realParent: string;
    try {
      realParent = realPathOf(parent);
    } catch {
      throw new DocumentError("PATH_CHANGED", t("documents_path_changed", { path: label(loc) }), t("documents_path_changed_fix"));
    }
    if (realParent !== parent || !loc.allowedRoots.some((root) => insideBySegments(root, realParent))) {
      throw new DocumentError("PATH_CHANGED", t("documents_path_changed", { path: label(loc) }), t("documents_path_changed_fix"));
    }
    // The target must not have become a symlink, and its bytes must still be the expected revision.
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(loc.target);
    } catch {
      st = null;
    }
    if (st && !st.isFile()) throw new DocumentError("PATH_CHANGED", t("documents_path_changed", { path: label(loc) }), t("documents_path_changed_fix"));
    const again = readDisk(loc.target, Number.MAX_SAFE_INTEGER);
    const againRevision = again.bytes ? hashBytes(again.bytes) : null;
    if (againRevision !== request.expectedRevision) throw new LateConflict();
  };

  try {
    writeBytesAtomic(loc.target, proposal.bytes, { ...(disk.mode !== null ? { mode: disk.mode & 0o7777 } : {}), verify, ...(internals.faults ? { faults: internals.faults } : {}) });
  } catch (error) {
    if (error instanceof LateConflict) {
      const now = readDisk(loc.target, Number.MAX_SAFE_INTEGER);
      return conflict({ revision: now.bytes ? hashBytes(now.bytes) : null, text: now.bytes ? decodeBytes(now.bytes).text : null, exists: now.exists });
    }
    if (error instanceof DocumentError) throw error;
    const stage = error instanceof AtomicWriteError ? error.stage : "temp";
    throw new DocumentError("WRITE_FAILED", t("documents_write_failed", { path: label(loc), detail: (error as Error).message }), t("documents_write_failed_fix"), { stage });
  }
  const written = readDisk(loc.target, Number.MAX_SAFE_INTEGER);
  if (!written.bytes || !written.bytes.equals(proposal.bytes)) {
    throw new DocumentError("VERIFY_FAILED", t("documents_verify_failed", { path: label(loc) }), t("documents_verify_failed_fix"));
  }
  return {
    status: "saved",
    ref: loc.ref,
    identity: loc.identity,
    previousRevision: currentRevision,
    revision: hashBytes(written.bytes),
    diff: unifiedDiff(decoded?.text ?? "", proposal.text, { oldLabel: `a/${label(loc)}`, newLabel: `b/${label(loc)}` }),
    validation,
  };
}

export type RenameResult =
  | { status: "renamed"; ref: DocumentRef; from: string; to: string; revision: string }
  | { status: "conflict"; ref: DocumentRef; from: string; current: { revision: string | null; exists: boolean } };

/**
 * Renames one entry of a directory binding inside the same directory. The source must be the revision the caller
 * read (otherwise a conflict, nothing moves) and the destination must not exist: the new name is linked first
 * (fails when it exists), then the old one is removed, so a file is never overwritten.
 */
export function renameEntry(dir: string, instanceId: string, bindingId: string, request: { from: string; to: string; expectedRevision: string }, internals: DocumentOptions = {}): RenameResult {
  const source = load(dir, instanceId, bindingId, { ...internals, entry: request.from });
  const revision = source.disk.bytes ? hashBytes(source.disk.bytes) : source.disk.exists ? revisionOfLarge(source.loc.target) : null;
  if (!source.disk.exists || revision !== request.expectedRevision) {
    return { status: "conflict", ref: source.loc.ref, from: request.from, current: { revision, exists: source.disk.exists } };
  }
  const { state, reasons } = stateOf(source.loc, source.disk, source.decoded?.problem ?? null, internals);
  if (state !== "editable") {
    throw new DocumentError("DOCUMENT_READ_ONLY", t("documents_read_only", { path: label(source.loc), reason: reasons.map((r) => r.message).join("; ") }), t(`documents_read_only_fix_${state === "read-only" ? "local" : state}`), { state, reasons });
  }
  // The destination is located the way a new file is: inside the binding directory, matching include.
  const dest = load(dir, instanceId, bindingId, { ...internals, entry: request.to, allowNewEntry: true, skipIncludeCheck: true });
  if (dest.disk.exists) throw new DocumentError("DOCUMENT_EXISTS", t("documents_exists", { path: label(dest.loc) }), t("documents_exists_fix"));
  if (!fs.existsSync(path.dirname(dest.loc.target))) throw new DocumentError("ENTRY_NOT_ALLOWED", t("documents_new_entry_refused", { entry: request.to, reason: "PARENT_MISSING" }), t("documents_new_entry_refused_fix"));
  try {
    try {
      fs.linkSync(source.loc.target, dest.loc.target);
      fs.unlinkSync(source.loc.target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new DocumentError("DOCUMENT_EXISTS", t("documents_exists", { path: label(dest.loc) }), t("documents_exists_fix"));
      if (code !== "EPERM" && code !== "ENOSYS" && code !== "EOPNOTSUPP" && code !== "EXDEV") throw error;
      fs.renameSync(source.loc.target, dest.loc.target);
    }
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError("WRITE_FAILED", t("documents_write_failed", { path: label(dest.loc), detail: (error as Error).message }), t("documents_write_failed_fix"), { stage: "rename" });
  }
  const moved = readDisk(dest.loc.target, Number.MAX_SAFE_INTEGER);
  if (!moved.bytes || hashBytes(moved.bytes) !== request.expectedRevision) throw new DocumentError("VERIFY_FAILED", t("documents_verify_failed", { path: label(dest.loc) }), t("documents_verify_failed_fix"));
  return { status: "renamed", ref: dest.loc.ref, from: request.from, to: request.to, revision: request.expectedRevision };
}
