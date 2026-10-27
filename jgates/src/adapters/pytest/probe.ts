// Asks the Python of the run whether pytest answers and whether the coverage plugin is active, without installing or
// writing anything. The plugin check runs `pytest --help` in the component with the project's own configuration but
// without conftest.py, so planning never executes project code.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveProjectPython } from "../../core/bridge/index.js";

export interface PytestProbe {
  /** Absolute path of the Python interpreter, or null when none was found. */
  python: string | null;
  version: string | null;
  /** Why pytest is not usable. */
  problem: "python_missing" | "no_pytest" | null;
  detail: string;
  /** pytest-cov answers `--cov` with the configuration of the component. */
  coverage: boolean;
}

const versions = new Map<string, { mtimeMs: number; version: string | null; detail: string }>();

function safeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return { PATH: env.PATH ?? "", HOME: env.HOME ?? "", PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };
}

export function probePytest(env: NodeJS.ProcessEnv, cwd: string): PytestProbe {
  const { interpreter, tried } = resolveProjectPython(env);
  if (!interpreter) return { python: null, version: null, problem: "python_missing", detail: tried.join(", "), coverage: false };
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(interpreter).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  let known = versions.get(interpreter);
  if (!known || known.mtimeMs !== mtimeMs) {
    const r = spawnSync(interpreter, ["-c", "import pytest; print(pytest.__version__)"], { encoding: "utf8", timeout: 30_000, env: safeEnv(env), windowsHide: true });
    const version = r.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
    known = { mtimeMs, version, detail: version ? "" : (r.stderr.trim().split(/\r?\n/).pop() ?? "") };
    versions.set(interpreter, known);
  }
  if (!known.version) return { python: interpreter, version: null, problem: "no_pytest", detail: interpreter, coverage: false };
  const help = spawnSync(interpreter, ["-m", "pytest", "--help", "--noconftest", "-p", "no:cacheprovider"], { encoding: "utf8", timeout: 60_000, cwd, env: safeEnv(env), windowsHide: true });
  const coverage = help.status === 0 && /--cov=\[?SOURCE/.test(help.stdout);
  return { python: interpreter, version: known.version, problem: null, detail: "", coverage };
}
