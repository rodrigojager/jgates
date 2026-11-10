// `jgates tools export <file>` / `import <file>`: the tools image as a tarball, for a machine with no registry access
// (PLAN-image.md section 6). Export writes the tarball (`docker save`) and, next to it, `<file>.json` with the image id,
// the SHA-256 of the tarball and the versions. Import checks the tarball against that record BEFORE the engine loads
// anything, loads it, and then checks that the engine now holds an image with the recorded id (and, for a published
// release, the digest this release pins). A tarball without its record, or with another content, is refused.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { engineCommand, engineCommandSync, inspectImageSync, type EngineContext } from "../engine/index.js";
import { IMAGE_VERSION_LABEL, readToolsImagePin, toolsImageTarget, type ToolsImagePin } from "../tools-image/index.js";
import { translator } from "../../i18n/index.js";
import { engineContextOf } from "./status.js";

export type TransferErrorCode =
  | "ENGINE_UNAVAILABLE"
  | "IMAGE_MISSING"
  | "EXPORT_FAILED"
  | "IMPORT_FILE_MISSING"
  | "IMPORT_NO_RECORD"
  | "IMPORT_BAD_RECORD"
  | "IMPORT_TARBALL_MISMATCH"
  | "IMPORT_FAILED"
  | "IMPORT_DIGEST_MISMATCH"
  | "IMPORT_PIN_MISMATCH";

export class TransferError extends Error {
  constructor(
    readonly code: TransferErrorCode,
    message: string,
    readonly details: string = "",
  ) {
    super(message);
    this.name = "TransferError";
  }
}

export interface TransferRecord {
  schemaVersion: 1;
  reference: string;
  imageId: string;
  imageVersion: string | null;
  jgatesVersion: string;
  sha256: string;
  bytes: number;
  createdAt: string;
}

export interface TransferOptions {
  env?: NodeJS.ProcessEnv;
  version: string;
  file: string;
  pin?: ToolsImagePin;
  now?: () => Date;
}

const SAVE_TIMEOUT_MS = 60 * 60_000;

export const recordFileOf = (file: string): string => `${file}.json`;

export function sha256OfFile(file: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      hash.update(buffer);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ sha256: hash.digest("hex"), bytes }));
  });
}

function engineText(result: { stderr: string; stdout: string }): string {
  return (result.stderr || result.stdout).trim();
}

/** Writes the image of this release to `file` and its record to `<file>.json`. */
export async function exportImage(options: TransferOptions): Promise<TransferRecord> {
  const t = translator("lifecycle");
  const env = options.env ?? process.env;
  const target = toolsImageTarget(env, options.pin ?? readToolsImagePin());
  const context = engineContextOf(env);
  const image = inspectImageSync(target.reference, context);
  if (!image) throw new TransferError("IMAGE_MISSING", t("lifecycle_export_no_image", { image: target.reference }));
  const file = path.resolve(options.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const saved = await engineCommand(["save", "--output", file, target.reference], context, SAVE_TIMEOUT_MS);
  if (saved.spawnError || saved.exitCode !== 0 || !fs.existsSync(file)) {
    fs.rmSync(file, { force: true });
    throw new TransferError("EXPORT_FAILED", t("lifecycle_export_failed", { image: target.reference }), saved.spawnError?.message ?? engineText(saved));
  }
  const { sha256, bytes } = await sha256OfFile(file);
  const record: TransferRecord = {
    schemaVersion: 1,
    reference: target.reference,
    imageId: image.id,
    imageVersion: image.labels[IMAGE_VERSION_LABEL] ?? null,
    jgatesVersion: options.version,
    sha256,
    bytes,
    createdAt: (options.now?.() ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z"),
  };
  fs.writeFileSync(recordFileOf(file), JSON.stringify(record, null, 2) + "\n");
  return record;
}

function readRecord(file: string): TransferRecord {
  const t = translator("lifecycle");
  const recordFile = recordFileOf(file);
  if (!fs.existsSync(recordFile)) throw new TransferError("IMPORT_NO_RECORD", t("lifecycle_import_no_record", { file: recordFile }));
  try {
    const doc = JSON.parse(fs.readFileSync(recordFile, "utf8")) as Partial<TransferRecord>;
    if (typeof doc.imageId !== "string" || typeof doc.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(doc.sha256) || typeof doc.reference !== "string") throw new Error("missing fields");
    return doc as TransferRecord;
  } catch (error) {
    throw new TransferError("IMPORT_BAD_RECORD", t("lifecycle_import_bad_record", { file: recordFile }), error instanceof Error ? error.message : String(error));
  }
}

/** The digests the engine knows for a local image (the id and the repository digests). */
function digestsOf(reference: string, context: EngineContext): { id: string; all: string[] } | null {
  const result = engineCommandSync(["image", "inspect", reference], context);
  if (result.spawnError || result.exitCode !== 0) return null;
  try {
    const first = (JSON.parse(result.stdout) as Array<{ Id: string; RepoDigests?: string[] }>)[0];
    return first ? { id: first.Id, all: [first.Id, ...(first.RepoDigests ?? []).map((d) => d.slice(d.indexOf("@") + 1))] } : null;
  } catch {
    return null;
  }
}

/** Loads a tarball written by `export`, after verifying it against its record; returns the record that was verified. */
export async function importImage(options: TransferOptions): Promise<TransferRecord & { loadedId: string }> {
  const t = translator("lifecycle");
  const env = options.env ?? process.env;
  const pin = options.pin ?? readToolsImagePin();
  const file = path.resolve(options.file);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new TransferError("IMPORT_FILE_MISSING", t("lifecycle_import_no_file", { file }));
  const record = readRecord(file);
  const actual = await sha256OfFile(file);
  if (actual.sha256 !== record.sha256) {
    throw new TransferError("IMPORT_TARBALL_MISMATCH", t("lifecycle_import_tarball_mismatch", { file }), `expected ${record.sha256}, got ${actual.sha256}`);
  }
  const context = engineContextOf(env);
  const loaded = await engineCommand(["load", "--input", file], context, SAVE_TIMEOUT_MS);
  if (loaded.spawnError || loaded.exitCode !== 0) throw new TransferError("IMPORT_FAILED", t("lifecycle_import_failed", { file }), loaded.spawnError?.message ?? engineText(loaded));
  const target = toolsImageTarget(env, pin);
  const known = digestsOf(record.reference, context) ?? digestsOf(target.reference, context);
  if (!known || known.id !== record.imageId) {
    throw new TransferError("IMPORT_DIGEST_MISMATCH", t("lifecycle_import_digest_mismatch", { expected: record.imageId, actual: known?.id ?? "-" }), `the engine holds ${known?.id ?? "no image"} after loading ${file}`);
  }
  // A published release pins the digest of its image: the tarball has to be that image.
  if (target.source === "pin" && pin.published && !known.all.includes(pin.digest)) {
    throw new TransferError("IMPORT_PIN_MISMATCH", t("lifecycle_import_pin_mismatch", { expected: pin.digest }), `the engine digests: ${known.all.join(", ")}`);
  }
  return { ...record, loadedId: known.id };
}
