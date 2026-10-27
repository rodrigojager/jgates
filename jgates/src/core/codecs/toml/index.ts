import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolvePython, resolveSidecarDir } from "../../bridge/index.js";
import { translator } from "../../../i18n/index.js";
import {
  CodecError,
  applyEditsToValue,
  sameValue,
  type Codec,
  type CodecDiagnostic,
  type CodecDocument,
  type CodecOptions,
  type CodecPatchResult,
  type FieldEdit,
} from "../types.js";

/**
 * TOML codec. Structured reads and edits are done by `quality_sidecar.toml_edit` (tomlkit) in the sidecar
 * Python, through a restricted JSON protocol: the document text goes in, the new text comes out; the helper never
 * reads workspace files and never imports workspace code. Without Python (or without tomlkit) the codec answers
 * "structured edit unavailable" and the caller keeps the textual editor.
 */

export const TOML_UNAVAILABLE = "STRUCTURED_EDIT_UNAVAILABLE";
const TIMEOUT_MS = 15_000;

interface HelperError {
  code: string;
  message: string;
  line?: number;
  column?: number;
}

interface HelperResponse {
  schemaVersion: 1;
  ok: boolean;
  text?: string;
  changed?: boolean;
  exists?: boolean;
  fields?: unknown;
  version?: string;
  error?: HelperError;
}

type CallResult = { kind: "response"; response: HelperResponse } | { kind: "unavailable"; reason: string };

export interface TomlCodecOptions {
  env?: NodeJS.ProcessEnv;
}

function unavailableReason(key: "codecs_toml_no_python" | "codecs_toml_no_sidecar" | "codecs_toml_no_tomlkit" | "failed", detail = ""): string {
  const t = translator("codecs-toml");
  const reason = key === "failed" ? t("codecs_toml_helper_failed", { reason: detail }) : t(key);
  return t("codecs_toml_unavailable", { reason });
}

function callHelper(request: Record<string, unknown>, env: NodeJS.ProcessEnv): CallResult {
  const { interpreter } = resolvePython(env);
  if (!interpreter) return { kind: "unavailable", reason: unavailableReason("codecs_toml_no_python") };
  const sidecarDir = resolveSidecarDir(env);
  if (!sidecarDir) return { kind: "unavailable", reason: unavailableReason("codecs_toml_no_sidecar") };
  const result = spawnSync(interpreter, ["-m", "quality_sidecar.toml_edit"], {
    input: JSON.stringify({ schemaVersion: 1, ...request }),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    // The helper runs in the folder of the sidecar, never in the workspace.
    cwd: path.resolve(sidecarDir),
    env: {
      ...env,
      PYTHONPATH: env.PYTHONPATH ? `${sidecarDir}${path.delimiter}${env.PYTHONPATH}` : sidecarDir,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  });
  if (result.error) return { kind: "unavailable", reason: unavailableReason("failed", result.error.message) };
  let response: HelperResponse;
  try {
    response = JSON.parse(result.stdout.trim()) as HelperResponse;
  } catch {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim().split("\n").pop() ?? "";
    return { kind: "unavailable", reason: unavailableReason("failed", detail) };
  }
  if (!response.ok && response.error?.code === "TOMLKIT_MISSING") {
    return { kind: "unavailable", reason: unavailableReason("codecs_toml_no_tomlkit") };
  }
  return { kind: "response", response };
}

/** True when Python and tomlkit are reachable for structured TOML edits. */
export function tomlStructuredAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const call = callHelper({ operation: "validate", text: "" }, env);
  return call.kind === "response" && call.response.ok === true;
}

function diagnostic(error: HelperError): CodecDiagnostic {
  const out: CodecDiagnostic = { code: error.code, message: error.message };
  if (typeof error.line === "number") out.line = error.line;
  if (typeof error.column === "number") out.column = error.column;
  return out;
}

export function createTomlCodec(options: TomlCodecOptions = {}): Codec {
  const envOf = () => options.env ?? process.env;
  const t = translator("codecs-toml");

  function read(text: string, _options?: CodecOptions): CodecDocument {
    const call = callHelper({ operation: "read", text }, envOf());
    const base: CodecDocument = { ok: false, dialect: "toml", value: {}, fields: [], errors: [], warnings: [], documents: 1 };
    if (call.kind === "unavailable") {
      return { ...base, errors: [{ code: TOML_UNAVAILABLE, message: call.reason }] };
    }
    const { response } = call;
    if (!response.ok) {
      return { ...base, errors: [diagnostic(response.error ?? { code: "INTERNAL", message: "unknown helper error" })] };
    }
    return { ...base, ok: true, value: response.fields ?? {} };
  }

  function apply(text: string, edits: readonly FieldEdit[], _options?: CodecOptions): CodecPatchResult {
    if (edits.length === 0) return { text, changed: false, warnings: [] };
    const before = callHelper({ operation: "read", text }, envOf());
    if (before.kind === "unavailable") throw new CodecError("UNSUPPORTED", before.reason, { reason: TOML_UNAVAILABLE });
    if (!before.response.ok) {
      const e = before.response.error;
      throw new CodecError("PARSE", e?.message ?? "invalid TOML", { code: e?.code, line: e?.line, column: e?.column });
    }
    const expected = applyEditsToValue(before.response.fields, edits);
    let current = text;
    let currentValue: unknown = before.response.fields;
    for (const edit of edits) {
      const intents: Array<{ path: Array<string | number>; op: "set" | "delete"; value?: unknown }> = [];
      if (edit.op === "insert") {
        const target = valueAt(currentValue, edit.path);
        if (!Array.isArray(target)) throw new CodecError("BAD_EDIT", t("codecs_toml_bad_edit", { reason: "insert needs an array at the path" }));
        const next = [...target];
        const at = edit.index === undefined ? next.length : Math.min(Math.max(edit.index, 0), next.length);
        next.splice(at, 0, edit.value);
        intents.push({ path: edit.path, op: "set", value: next });
      } else if (edit.path.length === 0) {
        throw new CodecError("BAD_EDIT", t("codecs_toml_bad_edit", { reason: "the TOML root cannot be replaced" }));
      } else {
        intents.push(edit.op === "set" ? { path: edit.path, op: "set", value: edit.value } : { path: edit.path, op: "delete" });
      }
      const call = callHelper({ operation: "apply", text: current, intents }, envOf());
      if (call.kind === "unavailable") throw new CodecError("UNSUPPORTED", call.reason, { reason: TOML_UNAVAILABLE });
      if (!call.response.ok || typeof call.response.text !== "string") {
        const e = call.response.error;
        throw new CodecError(e?.code === "BAD_INTENT" ? "BAD_EDIT" : "PATCH_FAILED", e?.message ?? t("codecs_toml_patch_failed"), { code: e?.code });
      }
      current = call.response.text;
      currentValue = call.response.fields;
    }
    // The helper returns the value of the section it edited (the whole document here): compare with the expectation.
    if (!sameValue(currentValue, expected)) throw new CodecError("PATCH_FAILED", t("codecs_toml_patch_failed"));
    return { text: current, changed: current !== text, warnings: [] };
  }

  return { id: "toml", dialects: ["toml"], read, apply };
}

function valueAt(root: unknown, segments: readonly (string | number)[]): unknown {
  let node = root;
  for (const key of segments) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key as string];
  }
  return node;
}

export const tomlCodec: Codec = createTomlCodec();
