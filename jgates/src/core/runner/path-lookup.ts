// Looking a command up on PATH without starting it (PATHEXT on Windows).
import fs from "node:fs";
import path from "node:path";

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Looks a command up on PATH (PATHEXT on Windows); an absolute or relative path is checked as is. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
  if (command.includes("/") || command.includes("\\")) {
    for (const ext of exts) if (isFile(command + ext)) return path.resolve(command + ext);
    return null;
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

