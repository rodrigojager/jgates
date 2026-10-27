// Configuração > YAML: the real files of the JGates (jgates.yml, .jgates/*.yml and the project templates) in the editor.
// "Checar estrutura" validates syntax, schema and references of the text on the screen without writing anything; saving
// needs the revision that was read; the unsaved text is kept as a draft in the data folder until it is saved or discarded.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeBytesAtomic } from "../../core/documents/atomic.js";
import { hashBytes, readRevision } from "../../core/codecs/yaml/index.js";
import { CONFIG_DIR, FRAGMENT_FILES, ROOT_FILE, loadProjectConfig, parseYamlText, validateDocument, type ConfigDiagnostic } from "../../core/config/load/index.js";
import { ensureWorkspaceDirs } from "../../core/home/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { assertWritable, conflict } from "./templates.js";
import { modeOf } from "./workspaces.js";

type Rec = Record<string, unknown>;

const FILE_PATTERN = "^(jgates\\.yml|\\.jgates/(templates/)?[A-Za-z0-9][A-Za-z0-9._-]*\\.ya?ml)$";
const HASH_PATTERN = "^[0-9a-f]{64}$";
const MAX_BYTES = 1024 * 1024;

type Kind = "root" | "template" | "workspace" | "tools" | "policy" | "profiles" | "architecture" | "pii" | "other";

function kindOf(file: string): Kind {
  if (file === ROOT_FILE) return "root";
  if (file.startsWith(`${CONFIG_DIR}/templates/`)) return "template";
  const base = path.posix.basename(file);
  for (const [kind, name] of Object.entries(FRAGMENT_FILES)) if (name === base) return kind as Kind;
  return "other";
}

const isInside = (parent: string, child: string): boolean => {
  const r = path.relative(parent, child);
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
};

/** The absolute path of an allowed file; refuses links that leave the project. */
function locate(server: ServerContext, file: string): string {
  const abs = path.join(server.projectDir, file);
  try {
    const real = fs.realpathSync(abs);
    if (!isInside(fs.realpathSync(server.projectDir), real)) throw new HttpError(403, "FILE_OUTSIDE_PROJECT", `O arquivo ${file} aponta para fora do projeto.`);
    return real;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return abs;
  }
}

// ---- drafts of configuration files ------------------------------------------------------------------------------

interface ConfigDraft {
  schemaVersion: 1;
  kind: "config-file";
  file: string;
  baseRevision: string | null;
  text: string;
  updatedAt: string;
}

function draftPath(server: ServerContext, file: string): string {
  const dir = path.join(ensureWorkspaceDirs(server.home, server.workspace.id), "drafts");
  return path.join(dir, `config-${crypto.createHash("sha256").update(file).digest("hex").slice(0, 40)}.json`);
}

function readDraft(server: ServerContext, file: string): ConfigDraft | null {
  try {
    const d = JSON.parse(fs.readFileSync(draftPath(server, file), "utf8")) as ConfigDraft;
    return d.kind === "config-file" && d.file === file && typeof d.text === "string" ? d : null;
  } catch {
    return null;
  }
}

function dropDraft(server: ServerContext, file: string): void {
  fs.rmSync(draftPath(server, file), { force: true });
}

// ---- the check --------------------------------------------------------------------------------------------------

function copyConfig(from: string, to: string): void {
  const copy = (rel: string): void => {
    const src = path.join(from, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(src);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.mkdirSync(path.join(to, rel), { recursive: true });
      for (const name of fs.readdirSync(src)) copy(path.join(rel, name));
    } else if (stat.isFile() && stat.size <= MAX_BYTES * 2) {
      fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true });
      fs.copyFileSync(src, path.join(to, rel));
    }
  };
  copy(ROOT_FILE);
  copy(CONFIG_DIR);
}

interface CheckResult {
  valid: boolean;
  diagnostics: Array<ConfigDiagnostic & { inThisFile: boolean }>;
}

/** Syntax, schema and references of `text` standing in for `file`; the project on disk is never touched. */
function check(server: ServerContext, file: string, text: string): CheckResult {
  const kind = kindOf(file);
  const out: ConfigDiagnostic[] = [];
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    out.push({ kind: "syntax", code: "TOO_LARGE", file, path: "", pathSegments: [], message: "O arquivo passa do limite de 1 MiB." });
  } else if (kind === "template") {
    const parsed = parseYamlText(text, file);
    out.push(...parsed.diagnostics);
    if (parsed.diagnostics.length === 0 && parsed.value !== undefined) out.push(...validateDocument("template", parsed.value, file, { doc: parsed.doc, lineCounter: parsed.lineCounter }));
  }
  if (out.length === 0 && Buffer.byteLength(text, "utf8") <= MAX_BYTES) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-check-"));
    try {
      copyConfig(server.projectDir, tmp);
      fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
      fs.writeFileSync(path.join(tmp, file), text);
      out.push(...loadProjectConfig(tmp).diagnostics);
      if (kind === "other") {
        const parsed = parseYamlText(text, file);
        out.push(...parsed.diagnostics);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  // The same problem is reported once.
  const seen = new Set<string>();
  const unique = out.filter((d) => {
    const key = `${d.file}|${d.path}|${d.code}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const diagnostics = unique.map((d) => ({ ...d, inThisFile: d.file === file }));
  return { valid: diagnostics.length === 0, diagnostics };
}

// ---- the files --------------------------------------------------------------------------------------------------

function listFiles(server: ServerContext): string[] {
  const files = new Set<string>();
  if (fs.existsSync(path.join(server.projectDir, ROOT_FILE))) files.add(ROOT_FILE);
  for (const [sub, dir] of [["", CONFIG_DIR], ["templates/", `${CONFIG_DIR}/templates`]] as const) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(server.projectDir, dir));
    } catch {
      // No folder yet.
    }
    for (const name of names.sort()) {
      const rel = `${CONFIG_DIR}/${sub}${name}`;
      if (/\.ya?ml$/.test(name) && new RegExp(FILE_PATTERN).test(rel) && fs.statSync(path.join(server.projectDir, rel)).isFile()) files.add(rel);
    }
  }
  return [...files];
}

function fileState(server: ServerContext, file: string): Rec {
  const rev = readRevision(locate(server, file));
  const draft = readDraft(server, file);
  const differs = draft !== null && draft.text !== rev.text;
  return {
    file,
    kind: kindOf(file),
    exists: rev.exists,
    revision: rev.hash,
    state: differs ? (draft.baseRevision !== rev.hash ? "conflict" : "draft") : "saved",
  };
}

function view(server: ServerContext, file: string): Rec {
  const abs = locate(server, file);
  const rev = readRevision(abs);
  if (!rev.exists) throw new HttpError(404, "FILE_MISSING", `O arquivo ${file} não existe.`, null, { file });
  const draft = readDraft(server, file);
  const differs = draft !== null && draft.text !== rev.text;
  const mode = modeOf();
  return {
    schemaVersion: 1,
    status: "OK",
    ...fileState(server, file),
    text: rev.text,
    mode: mode.mode,
    governed: mode.governed,
    draft: differs ? { text: draft.text, baseRevision: draft.baseRevision, updatedAt: draft.updatedAt, stale: draft.baseRevision !== rev.hash } : null,
  };
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/config/yaml",
    handler({ server }) {
      const mode = modeOf();
      return { status: 200, json: { schemaVersion: 1, status: "OK", mode: mode.mode, governed: mode.governed, files: listFiles(server).map((f) => fileState(server, f)) } };
    },
  },
  {
    method: "GET",
    path: "/api/config/yaml/file",
    query: { type: "object", required: ["file"], additionalProperties: false, properties: { file: { type: "string", pattern: FILE_PATTERN } } },
    handler({ query, server }) {
      return { status: 200, json: view(server, query.file as string) };
    },
  },
  {
    // "Checar estrutura": nothing is written; the answer names the file and the field of every problem.
    method: "POST",
    path: "/api/config/yaml/check",
    maxBody: MAX_BYTES * 2,
    body: { type: "object", additionalProperties: false, required: ["file", "text"], properties: { file: { type: "string", pattern: FILE_PATTERN }, text: { type: "string", maxLength: MAX_BYTES * 2 } } },
    handler({ body, server }) {
      const b = body as { file: string; text: string };
      return { status: 200, json: { schemaVersion: 1, status: "OK", file: b.file, ...check(server, b.file, b.text) } };
    },
  },
  {
    method: "PUT",
    path: "/api/config/yaml/draft",
    maxBody: MAX_BYTES * 2,
    body: {
      type: "object",
      additionalProperties: false,
      required: ["file", "text", "baseRevision"],
      properties: { file: { type: "string", pattern: FILE_PATTERN }, text: { type: "string", maxLength: MAX_BYTES * 2 }, baseRevision: { type: "string", pattern: HASH_PATTERN } },
    },
    handler({ body, server }) {
      const b = body as { file: string; text: string; baseRevision: string };
      const rev = readRevision(locate(server, b.file));
      if (rev.exists && rev.text === b.text) {
        dropDraft(server, b.file);
        return { status: 200, json: { schemaVersion: 1, status: "OK", saved: false } };
      }
      const draft: ConfigDraft = { schemaVersion: 1, kind: "config-file", file: b.file, baseRevision: b.baseRevision, text: b.text, updatedAt: new Date().toISOString() };
      const target = draftPath(server, b.file);
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(draft), { mode: 0o600 });
      fs.renameSync(tmp, target);
      return { status: 200, json: { schemaVersion: 1, status: "OK", saved: true, updatedAt: draft.updatedAt } };
    },
  },
  {
    method: "DELETE",
    path: "/api/config/yaml/draft",
    query: { type: "object", required: ["file"], additionalProperties: false, properties: { file: { type: "string", pattern: FILE_PATTERN } } },
    handler({ query, server }) {
      dropDraft(server, query.file as string);
      return { status: 200, json: { schemaVersion: 1, status: "OK" } };
    },
  },
  {
    method: "PUT",
    path: "/api/config/yaml/file",
    maxBody: MAX_BYTES * 2,
    body: {
      type: "object",
      additionalProperties: false,
      required: ["file", "text", "expectedRevision"],
      properties: {
        file: { type: "string", pattern: FILE_PATTERN },
        text: { type: "string", maxLength: MAX_BYTES * 2 },
        expectedRevision: { type: "string", pattern: HASH_PATTERN },
        allowInvalid: { type: "boolean" },
      },
    },
    handler({ body, server }) {
      assertWritable();
      const b = body as { file: string; text: string; expectedRevision: string; allowInvalid?: boolean };
      const abs = locate(server, b.file);
      const current = readRevision(abs);
      if (!current.exists) throw new HttpError(404, "FILE_MISSING", `O arquivo ${b.file} não existe.`, null, { file: b.file });
      if (current.hash !== b.expectedRevision) throw conflict(current.hash, b.file);
      const result = check(server, b.file, b.text);
      const mine = result.diagnostics.filter((d) => d.inThisFile);
      if (mine.length > 0 && b.allowInvalid !== true) {
        const first = mine[0] as ConfigDiagnostic;
        throw new HttpError(422, "CONFIG_INVALID", `O ${b.file} não foi salvo: ${first.path ? `${first.path}: ` : ""}${first.message}`, "Corrija o texto (o rascunho continua guardado) ou salve assim mesmo, sabendo que o plano deixará de ser aprovável.", { diagnostics: result.diagnostics });
      }
      const bytes = Buffer.from(b.text, "utf8");
      if (current.text === b.text) return { status: 200, json: { schemaVersion: 1, status: "OK", saved: false, ...view(server, b.file) } };
      let mode: number | undefined;
      try {
        mode = fs.statSync(abs).mode & 0o777;
      } catch {
        mode = undefined;
      }
      writeBytesAtomic(abs, bytes, {
        ...(mode !== undefined ? { mode } : {}),
        verify: () => {
          if (readRevision(abs).hash !== b.expectedRevision) throw conflict(readRevision(abs).hash, b.file);
        },
      });
      dropDraft(server, b.file);
      server.log(`config file saved: ${b.file} (${hashBytes(bytes).slice(0, 12)})`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", saved: true, ...view(server, b.file) } };
    },
  },
];
