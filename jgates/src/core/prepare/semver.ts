// Version ranges of the adapter manifests (toolVersionRange): "*", or comparators joined by spaces, for example
// ">=1.100.0" or ">=0.5.0 <1.0.0". A pre-release suffix is ignored when comparing.

export function parseVersion(text: string | null | undefined): [number, number, number] | null {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text ?? "");
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** true/false for a readable version; null when the version or a comparator cannot be read (never a silent pass). */
export function satisfiesRange(version: string | null | undefined, range: string): boolean | null {
  const trimmed = range.trim();
  if (trimmed === "" || trimmed === "*") return true;
  const v = parseVersion(version);
  if (!v) return null;
  for (const part of trimmed.split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(part);
    if (!m) return null;
    const bound = parseVersion(m[2]) as [number, number, number];
    const c = compareVersions(v, bound);
    const op = m[1] ?? "=";
    const ok = op === ">=" ? c >= 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : c === 0;
    if (!ok) return false;
  }
  return true;
}
