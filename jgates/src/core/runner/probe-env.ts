// The small environment the version probes give a child (`ruff --version`, `python -c "import pytest"`...).
// On Linux and macOS it is exactly the variables the caller names. On Windows a few more are needed for a child to
// work at all: SYSTEMROOT (Python's random source and sockets), APPDATA (Python's user site-packages, where
// `pip install --user` puts pytest, Ruff or Import Linter), LOCALAPPDATA, USERPROFILE, PATHEXT and the temp folders.
// Without them a tool installed for the user looks absent to JGates although it runs in the user's own terminal.

const WINDOWS_ESSENTIALS = ["SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "PATHEXT", "TEMP", "TMP"] as const;

/** `base` plus, on Windows only, the essentials present in `env` (never overriding a value of `base`). */
export function probeEnv(env: NodeJS.ProcessEnv, base: Record<string, string>, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== "win32") return base;
  const out: Record<string, string> = {};
  for (const name of WINDOWS_ESSENTIALS) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return { ...out, ...base };
}
