// Whether the formatter of an instance is in the tools image, and its version, from image.json (nothing starts).
// Inside the image only, a JGATES_<TOOL> override names another executable, which is asked for its version (a Node
// script is run through the Node that runs JGates).
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { inImageOverride, probeImageTool } from "../../core/tools-image/catalogue.js";
import { stepMode } from "../../core/runner/in-image.js";
import { probeEnv } from "../../core/runner/probe-env.js";
import type { Formatter } from "./normalize.js";

export interface FormatterProbe {
  /** What runs: the executable, or Node when the override is a script. */
  executable: string | null;
  /** Arguments before the formatter's own (the script when Node runs it). */
  prefix: string[];
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  /** What was tried (not_found) or the path that did not answer (no_answer). */
  detail: string;
}

/** The environment variable that points at the executable of a formatter, inside the image only. */
export const FORMATTER_ENV: Record<Formatter, string> = { ruff: "JGATES_RUFF", prettier: "JGATES_PRETTIER", gofmt: "JGATES_GOFMT", rustfmt: "JGATES_CARGO", dotnet: "JGATES_DOTNET" };
/** The tool of image.json whose version is the formatter's (gofmt ships with Go, cargo fmt is rustfmt, dotnet format is the SDK's). */
export const VERSION_TOOL: Record<Formatter, string> = { ruff: "ruff", prettier: "prettier", gofmt: "go", rustfmt: "rustfmt", dotnet: "dotnet-format" };
/** The tool of image.json whose command runs the formatter. */
const COMMAND_TOOL: Record<Formatter, string> = { ruff: "ruff", prettier: "prettier", gofmt: "go", rustfmt: "cargo", dotnet: "dotnet" };

const isScript = (executable: string): boolean => /\.(?:mjs|cjs|js)$/i.test(executable);
const cache = new Map<string, { mtimeMs: number; version: string | null }>();

function queryVersion(executable: string, env: NodeJS.ProcessEnv): string | null {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(executable).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  const hit = cache.get(executable);
  if (hit && hit.mtimeMs === mtimeMs) return hit.version;
  const script = isScript(executable);
  const r = spawnSync(script ? process.execPath : executable, script ? [executable, "--version"] : ["--version"], {
    encoding: "utf8",
    timeout: 60_000,
    env: probeEnv(env, { PATH: env.PATH ?? "", HOME: env.HOME ?? "", NO_COLOR: "1", DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" }),
    windowsHide: true,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
  });
  const version = r.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? null) : null;
  cache.set(executable, { mtimeMs, version });
  return version;
}

export function probeFormatter(formatter: Formatter, env: NodeJS.ProcessEnv): FormatterProbe {
  const named = inImageOverride(env, FORMATTER_ENV[formatter]);
  if (named !== null) {
    const abs = findOnPath(named, env);
    if (!abs) return { executable: null, prefix: [], version: null, problem: "not_found", detail: named };
    const script = isScript(abs);
    // gofmt has no version flag: the Go release of the image's catalogue stands for it.
    const version = formatter === "gofmt" ? (probeImageTool("go", env).version ?? "0.0.0") : queryVersion(abs, env);
    const exe = script ? process.execPath : abs;
    return version ? { executable: exe, prefix: script ? [abs] : [], version, problem: null, detail: "" } : { executable: abs, prefix: [], version: null, problem: "no_answer", detail: abs };
  }
  const tool = probeImageTool(VERSION_TOOL[formatter], env);
  if (tool.problem !== null) return { executable: null, prefix: [], version: null, problem: "not_found", detail: tool.detail };
  const command = probeImageTool(COMMAND_TOOL[formatter], env);
  if (command.problem !== null || command.executable === null) return { executable: null, prefix: [], version: null, problem: "not_found", detail: command.detail };
  let executable = command.executable;
  if (formatter === "gofmt") {
    // gofmt sits beside go: the bare name in the step container, the one found on the PATH inside the image.
    executable = stepMode(env) === "in-image" ? (findOnPath("gofmt", env) ?? "gofmt") : "gofmt";
  }
  return { executable, prefix: [], version: tool.version, problem: null, detail: "" };
}
