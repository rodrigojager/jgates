// Preflight of a step: what must exist before a process is worth starting (runtime, binary, version, configuration
// files, directories). A problem found here means a prerequisite is absent: the step does not run and its stages are
// blocked with the reason, never zero findings.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";

export type PreflightCode =
  | "RUNTIME_MISSING"
  | "BINARY_NOT_FOUND"
  | "BINARY_NOT_EXECUTABLE"
  | "VERSION_MISMATCH"
  | "VERSION_UNKNOWN"
  | "CONFIG_MISSING"
  | "CWD_MISSING"
  | "DIR_UNWRITABLE"
  | "PREREQUISITE_MISSING";

export interface PreflightProblem {
  code: PreflightCode;
  message: string;
  path?: string;
}

export interface PreflightSpec {
  /** Runtime the step needs (for example the Python of the bridge): null interpreter means it was not found. */
  runtime?: { name: string; interpreter: string | null; detail?: string };
  /** Executable the step starts: an absolute path or a name looked up in PATH. */
  executable?: string;
  /** PATH (and PATHEXT on Windows) used to look the executable up. */
  env?: NodeJS.ProcessEnv;
  /** Expected tool version and how to read the current one; a different answer blocks the step. */
  version?: { expected: string | null; read: () => string | null };
  /** Configuration files the step reads (absolute). */
  configFiles?: string[];
  /** Working directory (absolute). */
  cwd?: string;
  /** Directories the step writes into (created if absent). */
  outputDirs?: string[];
  /** Other prerequisites already checked by the caller: a non-null reason blocks the step. */
  extra?: Array<{ code?: PreflightCode; reason: string | null }>;
}

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function executableBit(file: string): boolean {
  if (process.platform === "win32") return true;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of an executable: the path itself when it has a directory part, else the first match in PATH. */
export function resolveExecutable(executable: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (executable.includes("/") || executable.includes("\\") || path.isAbsolute(executable)) {
    const abs = path.resolve(executable);
    return isFile(abs) ? abs : null;
  }
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)] : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, executable + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function preflight(spec: PreflightSpec): PreflightProblem[] {
  const t = translator("runner");
  const problems: PreflightProblem[] = [];
  for (const e of spec.extra ?? []) if (e.reason) problems.push({ code: e.code ?? "PREREQUISITE_MISSING", message: e.reason });
  if (spec.runtime && spec.runtime.interpreter === null) {
    problems.push({ code: "RUNTIME_MISSING", message: t("runner_runtime_missing", { name: spec.runtime.name, detail: spec.runtime.detail ?? "-" }) });
  }
  if (spec.executable !== undefined) {
    const found = resolveExecutable(spec.executable, spec.env);
    if (!found) problems.push({ code: "BINARY_NOT_FOUND", message: t("runner_binary_not_found", { executable: spec.executable }), path: spec.executable });
    else if (!executableBit(found)) problems.push({ code: "BINARY_NOT_EXECUTABLE", message: t("runner_binary_not_executable", { executable: found }), path: found });
    else if (spec.version && spec.version.expected) {
      let actual: string | null = null;
      try {
        actual = spec.version.read();
      } catch {
        actual = null;
      }
      if (actual === null) problems.push({ code: "VERSION_UNKNOWN", message: t("runner_version_unknown", { executable: found, expected: spec.version.expected }) });
      else if (actual !== spec.version.expected) {
        problems.push({ code: "VERSION_MISMATCH", message: t("runner_version_mismatch", { executable: found, expected: spec.version.expected, actual }) });
      }
    }
  }
  for (const file of spec.configFiles ?? []) {
    if (!isFile(file)) problems.push({ code: "CONFIG_MISSING", message: t("runner_config_missing", { file }), path: file });
  }
  if (spec.cwd !== undefined && !isDir(spec.cwd)) problems.push({ code: "CWD_MISSING", message: t("runner_cwd_missing", { dir: spec.cwd }), path: spec.cwd });
  for (const dir of spec.outputDirs ?? []) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      problems.push({ code: "DIR_UNWRITABLE", message: t("runner_dir_unwritable", { dir }), path: dir });
    }
  }
  return problems;
}
