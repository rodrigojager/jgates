/** Minimal glob matching for include/exclude and workspace member patterns (no filesystem access). */

export interface GlobOptions {
  caseInsensitive?: boolean;
}

/** Normalizes a user pattern: forward slashes, no leading "./" or "/", no trailing "/". */
export function normalizePattern(pattern: string): string {
  let p = pattern.replace(/\\/g, "/").trim();
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/^\/+/, "").replace(/\/+$/, "");
  return p;
}

function bodyToRegex(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c === "*") {
      if (body[i + 1] === "*") {
        if (body[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return out;
}

/** True when the whole path matches the pattern (`*` stays inside a segment, `**` crosses segments). */
export function matchesExactly(pattern: string, relPath: string, options: GlobOptions = {}): boolean {
  const p = normalizePattern(pattern);
  const re = new RegExp(`^${bodyToRegex(p)}$`, options.caseInsensitive ? "i" : "");
  return re.test(relPath);
}

/**
 * True when the path, or one of its parent directories, is selected by the pattern.
 * A pattern with no "/" matches a directory name at any depth; otherwise it is anchored at the project root.
 */
export function matchesPathOrParent(pattern: string, relPath: string, options: GlobOptions = {}): boolean {
  const p = normalizePattern(pattern);
  if (p === "") return false;
  const re = new RegExp(`^${bodyToRegex(p)}$`, options.caseInsensitive ? "i" : "");
  const anchored = p.includes("/");
  const segments = relPath === "." || relPath === "" ? ["."] : relPath.split("/");
  for (let i = 0; i < segments.length; i++) {
    const subject = anchored ? segments.slice(0, i + 1).join("/") : (segments[i] as string);
    if (re.test(subject)) return true;
  }
  return false;
}
