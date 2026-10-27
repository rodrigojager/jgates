// Line and column of the keys of a TOML text, for the "open at the position in the file" link of the form. This is a
// locator, not a parser: the values come from the TOML codec (tomlkit). It follows table headers ([a.b], [[a]]),
// dotted and quoted keys, and skips multi-line strings and arrays, so a key inside a value is never taken for a key.
import type { Position } from "./types.js";

type Segment = string | number;

/** Splits a TOML key (`a."b.c".d`) into its segments. */
export function splitTomlKey(raw: string): string[] {
  const out: string[] = [];
  let i = 0;
  const s = raw.trim();
  while (i < s.length) {
    while (s[i] === " " || s[i] === "\t") i++;
    let seg = "";
    const quote = s[i];
    if (quote === '"' || quote === "'") {
      i++;
      while (i < s.length && s[i] !== quote) {
        if (quote === '"' && s[i] === "\\" && i + 1 < s.length) {
          seg += s[i + 1];
          i += 2;
          continue;
        }
        seg += s[i];
        i++;
      }
      i++;
    } else {
      while (i < s.length && s[i] !== "." && s[i] !== " " && s[i] !== "\t") seg += s[i++];
    }
    out.push(seg);
    while (s[i] === " " || s[i] === "\t") i++;
    if (s[i] === ".") i++;
    else break;
  }
  return out;
}

/** End of the key part of a `key = value` line (index of the `=`), or -1 when the line is not a key/value pair. */
function equalsIndex(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "=") return i;
    else if (c === "#" || c === "[" || c === "{") return -1;
  }
  return -1;
}

/** Bracket depth change of a value text, ignoring strings and comments; also reports an open multi-line string. */
function scanValue(text: string, state: { depth: number; multi: string | null }): void {
  for (let i = 0; i < text.length; i++) {
    if (state.multi) {
      if (text.startsWith(state.multi, i)) {
        i += 2;
        state.multi = null;
      } else if (state.multi === '"""' && text[i] === "\\") i++;
      continue;
    }
    const c = text[i];
    if (c === "#") return;
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      state.multi = text.slice(i, i + 3);
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) {
        if (q === '"' && text[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "[" || c === "{") state.depth++;
    else if (c === "]" || c === "}") state.depth--;
  }
}

const keyOf = (path: readonly Segment[]): string => JSON.stringify(path);

/** Positions (1-based) of every table and key of the text, by key path; the first occurrence wins. */
export function tomlPositions(text: string): Map<string, Position> {
  const positions = new Map<string, Position>();
  const record = (path: Segment[], position: Position) => {
    for (let n = 1; n <= path.length; n++) {
      const k = keyOf(path.slice(0, n));
      if (!positions.has(k)) positions.set(k, position);
    }
  };
  const arrayCounts = new Map<string, number>();
  let table: Segment[] = [];
  const state = { depth: 0, multi: null as string | null };
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (state.multi || state.depth > 0) {
      scanValue(line, state);
      return;
    }
    const trimmed = line.trimStart();
    const column = line.length - trimmed.length + 1;
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const header = /^\[(\[)?\s*(.+?)\s*\](\])?\s*(?:#.*)?$/.exec(trimmed);
    if (header && Boolean(header[1]) === Boolean(header[3])) {
      const segments = splitTomlKey(header[2] as string);
      if (header[1]) {
        const k = keyOf(segments);
        const n = arrayCounts.get(k) ?? 0;
        arrayCounts.set(k, n + 1);
        table = [...segments, n];
      } else table = segments;
      record(table, { line: index + 1, column });
      return;
    }
    const eq = equalsIndex(trimmed);
    if (eq <= 0) return;
    record([...table, ...splitTomlKey(trimmed.slice(0, eq))], { line: index + 1, column });
    scanValue(trimmed.slice(eq + 1), state);
  });
  return positions;
}

/** Position of a key path, or of its nearest present ancestor; null when nothing of it is in the text. */
export function positionOf(positions: Map<string, Position>, path: readonly Segment[]): Position | null {
  for (let n = path.length; n > 0; n--) {
    const hit = positions.get(keyOf(path.slice(0, n)));
    if (hit) return hit;
  }
  return null;
}

/** Same lookup, but only for the exact path (no ancestor). */
export function exactPositionOf(positions: Map<string, Position>, path: readonly Segment[]): Position | null {
  return positions.get(keyOf(path)) ?? null;
}
