import fs from "node:fs";
import path from "node:path";

/**
 * Path checks of the document service. Containment is decided segment by segment on real paths (never by a text
 * prefix: `/w/app` does not contain `/w/app2`), with the comparison rules of the platform (case-insensitive on
 * Windows and macOS, Unicode NFC everywhere).
 */

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function segmentsOf(p: string): string[] {
  const resolved = path.resolve(p);
  const { root } = path.parse(resolved);
  const rest = resolved.slice(root.length).split(/[\\/]+/).filter(Boolean);
  return [root, ...rest].map((s) => {
    const n = s.normalize("NFC");
    return CASE_INSENSITIVE ? n.toLowerCase() : n;
  });
}

/** True when `target` is `root` or lies below it, compared by path segments. */
export function insideBySegments(root: string, target: string): boolean {
  const a = segmentsOf(root);
  const b = segmentsOf(target);
  if (b.length < a.length) return false;
  return a.every((seg, i) => seg === b[i]);
}

/** Same physical path, by the platform rules. */
export function samePath(a: string, b: string): boolean {
  const x = segmentsOf(a);
  const y = segmentsOf(b);
  return x.length === y.length && x.every((s, i) => s === y[i]);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Problem with a file name on this platform, or null. Windows reserved names and trailing dots or spaces are refused there. */
export function nameProblem(name: string, platform: string = process.platform): string | null {
  if (name.includes("\0")) return "NUL";
  if (platform === "win32") {
    if (WINDOWS_RESERVED.test(name)) return "RESERVED_NAME";
    if (/[. ]$/.test(name)) return "TRAILING_DOT_OR_SPACE";
    if (/[<>:"|?*]/.test(name)) return "INVALID_CHARACTER";
  }
  return null;
}

/** Real path with the case the filesystem reports (never lowercased): what the service writes to. */
export function realPathOf(p: string): string {
  return fs.realpathSync.native(path.resolve(p));
}
