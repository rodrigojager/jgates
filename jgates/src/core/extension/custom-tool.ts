// `jgates tools add-custom`: turns the flags (the same choices as the dialog) into the entry of .jgates/tools.yml and the
// lines of .jgates/image/Dockerfile, shows both as a diff, and writes them only when asked to. Nothing here runs a tool or
// builds an image.
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { patchYamlText, readRevision, writeFileAtomic } from "../codecs/yaml/index.js";
import { unifiedDiff } from "../documents/diff.js";
import { BASE_ARG, EXTENSION_DIR, extensionPaths } from "./key.js";

export const TOOLS_FILE = ".jgates/tools.yml";
export const TOOLS_FILE_START = "schemaVersion: 1\ntools: {}\n";

export type ReportFormat = "sarif" | "junit" | "checkstyle" | "exit-code";
export const REPORT_FORMATS: readonly ReportFormat[] = ["sarif", "junit", "checkstyle", "exit-code"];
export const INSTALL_METHODS = ["pip", "npm", "apt", "binary"] as const;
export type InstallMethod = (typeof INSTALL_METHODS)[number];

export interface CustomToolRequest {
  /** The tool instance id in tools.yml. */
  id: string;
  /** A ready image reference (pinned by digest on first use); without `install` and `image` the tool runs in the tools image. */
  image?: string;
  /** `method:spec` entries (pip:bandit==1.8.0, npm:eslint@9, apt:cppcheck, binary:<https url>#sha256=<hex>). */
  install: string[];
  command: string;
  args: string[];
  report: { format: ReportFormat; file?: string };
  capabilities: string[];
  component?: string;
  network: boolean;
  timeoutSeconds?: number;
  /** Edits the existing entry of `id` key by key (its other keys, such as enabled or required, stay) instead of refusing it. */
  replace?: boolean;
}

export type CustomToolErrorCode =
  | "ID_INVALID"
  | "ID_EXISTS"
  | "COMMAND_REQUIRED"
  | "CAPABILITY_REQUIRED"
  | "REPORT_INVALID"
  | "INSTALL_INVALID"
  | "IMAGE_AND_INSTALL"
  | "TOOLS_FILE_INVALID"
  | "TIMEOUT_INVALID";

export class CustomToolError extends Error {
  constructor(
    readonly code: CustomToolErrorCode,
    message: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(message);
    this.name = "CustomToolError";
  }
}

export interface FileChange {
  /** Path relative to the project, with forward slashes. */
  file: string;
  before: string | null;
  after: string;
  /** Unified diff (a new file is all additions). */
  diff: string;
}

export interface CustomToolPlan {
  id: string;
  /** Where the tool runs: `extension`, `tools` or the image reference. */
  image: string;
  entry: Record<string, unknown>;
  /** The lines this call adds to the Dockerfile (empty without `install`). */
  dockerfileLines: string[];
  changes: FileChange[];
  /** The Dockerfile has to be (re)built before the tool can run. */
  needsBuild: boolean;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** What a package spec may hold: no spaces, quotes, shell operators or variable expansion. */
const SPEC_RE = /^@?[A-Za-z0-9][A-Za-z0-9._@/:=<>~^+,[\]-]*$/;
const URL_RE = /^https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;

const OUTPUT = "{outputDir}";

/** The placeholders of the plan's wording ({output}, {component}) mean the adapter's ({outputDir}, {componentRoot}). */
export function normalizeArg(arg: string): string {
  return arg.split("{output}").join(OUTPUT).split("{component}").join("{componentRoot}");
}

/** One `method:spec` install request as Dockerfile lines (run as root; the image goes back to the image user after). */
export function installLines(request: string): string[] {
  const at = request.indexOf(":");
  const method = at > 0 ? request.slice(0, at) : "";
  const spec = at > 0 ? request.slice(at + 1) : "";
  const bad = (): never => {
    throw new CustomToolError("INSTALL_INVALID", `invalid --install ${request}`, { value: request, methods: INSTALL_METHODS.join(", ") });
  };
  if (!(INSTALL_METHODS as readonly string[]).includes(method) || spec === "") return bad();
  if (method === "binary") {
    const [url, checksum] = spec.split("#sha256=");
    if (!url || !URL_RE.test(url) || !checksum || !SHA_RE.test(checksum.toLowerCase())) return bad();
    const name = path.posix.basename(new URL(url).pathname);
    if (!FILE_RE.test(name)) return bad();
    return [`ADD --checksum=sha256:${checksum.toLowerCase()} ${url} /usr/local/bin/${name}`, `RUN chmod 0755 /usr/local/bin/${name}`];
  }
  if (!SPEC_RE.test(spec)) return bad();
  // The spec is quoted (extras such as bandit[sarif] are glob characters to the shell); it can hold no quote itself.
  if (method === "pip") return [`RUN UV_TOOL_DIR=/opt/jgates-ext/uv UV_TOOL_BIN_DIR=/usr/local/bin uv tool install --no-cache '${spec}'`];
  if (method === "npm") return [`RUN npm install --global --prefix /usr/local '${spec}'`];
  return [`RUN apt-get update && apt-get install -y --no-install-recommends '${spec}' && rm -rf /var/lib/apt/lists/*`];
}

/** The Dockerfile after this call: a new one, or the existing one with the new lines appended (a line already there is not repeated). */
export function dockerfileAfter(existing: string | null, lines: string[]): string {
  const header = `ARG ${BASE_ARG}\nFROM \${${BASE_ARG}}\n`;
  const base = existing === null || existing.trim() === "" ? header : existing.endsWith("\n") ? existing : `${existing}\n`;
  const present = new Set(base.split(/\r?\n/).map((l) => l.trim()));
  const fresh = lines.filter((l) => !present.has(l.trim()));
  if (fresh.length === 0) return base;
  return `${base}USER root\n${fresh.join("\n")}\nUSER 10001:10001\n`;
}

function entryOf(request: CustomToolRequest, image: string): Record<string, unknown> {
  const evidence: Record<string, unknown> =
    request.report.format === "exit-code" ? { kind: "exit-code" } : { kind: request.report.format, file: request.report.file };
  return {
    adapter: "generic-command",
    ...(image !== "tools" ? { image } : {}),
    command: request.command,
    args: request.args.map(normalizeArg),
    capabilities: [...request.capabilities],
    ...(request.component ? { component: request.component } : {}),
    ...(request.timeoutSeconds !== undefined ? { timeoutSeconds: request.timeoutSeconds } : {}),
    config: {
      effects: {
        readsCode: true,
        writesOutputs: request.report.format !== "exit-code",
        mayChangeCode: false,
        executesProjectCode: false,
        usesNetwork: request.network,
      },
      evidence,
    },
  };
}

/** Parses `--report sarif:<file>` (or `junit:<file>`, `checkstyle:<file>`, `exit-code`). */
export function parseReport(text: string): { format: ReportFormat; file?: string } {
  const at = text.indexOf(":");
  const format = (at < 0 ? text : text.slice(0, at)) as ReportFormat;
  const file = at < 0 ? undefined : text.slice(at + 1);
  if (!REPORT_FORMATS.includes(format)) throw new CustomToolError("REPORT_INVALID", `invalid --report ${text}`, { value: text, formats: REPORT_FORMATS.join(", ") });
  if (format === "exit-code") {
    if (file !== undefined) throw new CustomToolError("REPORT_INVALID", `invalid --report ${text}`, { value: text, formats: REPORT_FORMATS.join(", ") });
    return { format };
  }
  if (!file || !FILE_RE.test(file)) throw new CustomToolError("REPORT_INVALID", `invalid --report ${text}`, { value: text, formats: REPORT_FORMATS.join(", ") });
  return { format, file };
}

/** What the call would write, without writing anything. */
export function planCustomTool(projectDir: string, request: CustomToolRequest): CustomToolPlan {
  if (!ID_RE.test(request.id)) throw new CustomToolError("ID_INVALID", `invalid id ${request.id}`, { id: request.id });
  if (request.command.trim() === "") throw new CustomToolError("COMMAND_REQUIRED", "the command is required");
  if (request.capabilities.length === 0) throw new CustomToolError("CAPABILITY_REQUIRED", "at least one capability is required");
  if (request.timeoutSeconds !== undefined && !(Number.isInteger(request.timeoutSeconds) && request.timeoutSeconds > 0)) {
    throw new CustomToolError("TIMEOUT_INVALID", "the timeout must be a positive integer", { value: String(request.timeoutSeconds) });
  }
  if (request.install.length > 0 && request.image !== undefined) throw new CustomToolError("IMAGE_AND_INSTALL", "--image and --install exclude each other");
  if (request.image !== undefined && !REFERENCE_RE.test(request.image)) throw new CustomToolError("INSTALL_INVALID", `invalid --image ${request.image}`, { value: request.image, methods: "an image reference" });
  const lines = request.install.flatMap(installLines);
  const image = request.install.length > 0 ? "extension" : (request.image ?? "tools");

  const root = path.resolve(projectDir);
  const toolsAbs = path.join(root, ...TOOLS_FILE.split("/"));
  const revision = readRevision(toolsAbs);
  const toolsBefore = revision.exists ? revision.text : null;
  let existing: Record<string, unknown> = {};
  if (toolsBefore !== null) {
    try {
      const doc = parseYaml(toolsBefore) as { tools?: Record<string, unknown> } | null;
      existing = doc && typeof doc.tools === "object" && doc.tools !== null ? doc.tools : {};
    } catch (error) {
      throw new CustomToolError("TOOLS_FILE_INVALID", (error as Error).message, { file: TOOLS_FILE, detail: (error as Error).message });
    }
  }
  const present = Object.prototype.hasOwnProperty.call(existing, request.id);
  if (present && request.replace !== true) throw new CustomToolError("ID_EXISTS", `the tool ${request.id} already exists`, { id: request.id });

  const entry = entryOf(request, image);
  let toolsAfter: string;
  try {
    const old = existing[request.id];
    const oldEntry = request.replace === true && present && typeof old === "object" && old !== null && !Array.isArray(old) ? (old as Record<string, unknown>) : null;
    if (oldEntry) {
      // Key by key: what the dialog manages is set (or removed when it no longer applies); enabled, required and the rest stay.
      const id = request.id;
      const edits: Array<{ op: "set"; path: string[]; value: unknown } | { op: "delete"; path: string[] }> = [];
      for (const key of ["adapter", "image", "command", "args", "capabilities", "component", "timeoutSeconds"]) {
        if (key in entry) edits.push({ op: "set", path: ["tools", id, key], value: entry[key] });
        else if (key in oldEntry) edits.push({ op: "delete", path: ["tools", id, key] });
      }
      const config = entry.config as Record<string, unknown>;
      const oldConfig = oldEntry.config;
      if (typeof oldConfig === "object" && oldConfig !== null && !Array.isArray(oldConfig)) {
        edits.push({ op: "set", path: ["tools", id, "config", "evidence"], value: config.evidence });
        // Of the effects, the dialog decides only the network and whether a report is written; the others written by
        // hand (a tool that runs the project's code) stay as they are.
        const effects = config.effects as Record<string, unknown>;
        const oldEffects = (oldConfig as Record<string, unknown>).effects;
        if (typeof oldEffects === "object" && oldEffects !== null && !Array.isArray(oldEffects)) {
          for (const [key, value] of Object.entries(effects)) {
            if (key === "usesNetwork" || key === "writesOutputs" || !(key in oldEffects)) edits.push({ op: "set", path: ["tools", id, "config", "effects", key], value });
          }
        } else edits.push({ op: "set", path: ["tools", id, "config", "effects"], value: effects });
      } else {
        edits.push({ op: "set", path: ["tools", id, "config"], value: config });
      }
      toolsAfter = patchYamlText(toolsBefore ?? TOOLS_FILE_START, edits).text;
    } else {
      toolsAfter = patchYamlText(toolsBefore ?? TOOLS_FILE_START, [{ op: "set", path: ["tools", request.id], value: entry }]).text;
    }
  } catch (error) {
    throw new CustomToolError("TOOLS_FILE_INVALID", (error as Error).message, { file: TOOLS_FILE, detail: (error as Error).message });
  }
  const changes: FileChange[] = [{ file: TOOLS_FILE, before: toolsBefore, after: toolsAfter, diff: unifiedDiff(toolsBefore ?? "", toolsAfter, { oldLabel: toolsBefore === null ? "/dev/null" : `a/${TOOLS_FILE}`, newLabel: `b/${TOOLS_FILE}` }) }];

  if (lines.length > 0) {
    const dockerfileAbs = extensionPaths(root).dockerfile;
    const before = fs.existsSync(dockerfileAbs) ? fs.readFileSync(dockerfileAbs, "utf8") : null;
    const after = dockerfileAfter(before, lines);
    const rel = `${EXTENSION_DIR}/Dockerfile`;
    if (after !== before) changes.push({ file: rel, before, after, diff: unifiedDiff(before ?? "", after, { oldLabel: before === null ? "/dev/null" : `a/${rel}`, newLabel: `b/${rel}` }) });
  }
  return { id: request.id, image, entry, dockerfileLines: lines, changes, needsBuild: image === "extension" };
}

/** Writes the files of a plan (atomically, the Dockerfile first so a failure leaves no entry that points at nothing). */
export function writeCustomTool(projectDir: string, plan: CustomToolPlan): string[] {
  const written: string[] = [];
  const ordered = [...plan.changes].sort((a) => (a.file === TOOLS_FILE ? 1 : -1));
  for (const change of ordered) {
    writeFileAtomic(path.join(path.resolve(projectDir), ...change.file.split("/")), change.after);
    written.push(change.file);
  }
  return written;
}
