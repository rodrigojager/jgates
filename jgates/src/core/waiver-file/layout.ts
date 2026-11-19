// Where the entries of a waiver file sit in its text, and the two text edits the file gets (append entries, remove one
// entry). The edits splice the original text, so everything else in a hand-written file stays byte for byte: its other
// entries, unknown keys, key order, indentation and line breaks. The functions assume the text is valid JSON (the caller
// parsed it first).

export interface Span {
  /** Index of the first character. */
  start: number;
  /** Index after the last character. */
  end: number;
}

export interface ArrayLayout {
  /** Index of the `[`. */
  open: number;
  /** Index of the matching `]`. */
  close: number;
  /** One span per element, in order. */
  elements: Span[];
}

const isSpace = (ch: string | undefined): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

function skipSpace(text: string, i: number): number {
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

/** The index after the JSON value that starts at `i`. */
function skipValue(text: string, i: number): number {
  const ch = text[i];
  if (ch === '"') return skipString(text, i);
  if (ch === "[" || ch === "{") {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i = skipString(text, i);
        continue;
      }
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  while (i < text.length && !isSpace(text[i]) && text[i] !== "," && text[i] !== "]" && text[i] !== "}") i++;
  return i;
}

function skipString(text: string, i: number): number {
  i++;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  return i;
}

/** The layout of the array that starts at `open` (the index of its `[`). */
function arrayAt(text: string, open: number): ArrayLayout {
  const elements: Span[] = [];
  let i = skipSpace(text, open + 1);
  while (i < text.length && text[i] !== "]") {
    const end = skipValue(text, i);
    elements.push({ start: i, end });
    i = skipSpace(text, end);
    if (text[i] === ",") i = skipSpace(text, i + 1);
  }
  return { open, close: i, elements };
}

/**
 * The array of entries of a waiver file: the document itself (a list) or the value of its `waivers` key (the last one
 * when the key repeats, as JSON.parse reads it). Null when the document holds neither.
 */
export function locateEntries(text: string): { shape: "list" | "object"; array: ArrayLayout } | null {
  const first = skipSpace(text, 0);
  if (text[first] === "[") return { shape: "list", array: arrayAt(text, first) };
  if (text[first] !== "{") return null;
  let found: ArrayLayout | null = null;
  let i = skipSpace(text, first + 1);
  while (i < text.length && text[i] !== "}") {
    const keyEnd = skipValue(text, i);
    let key: string;
    try {
      key = JSON.parse(text.slice(i, keyEnd)) as string;
    } catch {
      return null;
    }
    i = skipSpace(text, keyEnd);
    if (text[i] !== ":") return null;
    i = skipSpace(text, i + 1);
    if (key === "waivers" && text[i] === "[") found = arrayAt(text, i);
    else if (key === "waivers") found = null;
    i = skipSpace(text, skipValue(text, i));
    if (text[i] === ",") i = skipSpace(text, i + 1);
  }
  return found ? { shape: "object", array: found } : null;
}

/** The line break the text uses (CRLF when it has one, else LF). */
export function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** The white space that opens the line holding index `pos`. */
function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(lineStart, pos));
  return m ? m[0] : "";
}

/** Whether index `pos` is the first non-blank character of its line. */
function startsLine(text: string, pos: number): boolean {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, pos));
}

function formatEntry(entry: object, indent: string, eol: string): string {
  return JSON.stringify(entry, null, 2)
    .split("\n")
    .map((line, n) => (n === 0 ? line : indent + line))
    .join(eol);
}

/** The text of a waiver file that does not exist yet: an object with `waivers`, two-space indentation, a final newline. */
export function newFileText(entries: object[]): string {
  const body = entries.map((e) => `    ${formatEntry(e, "    ", "\n")}`).join(",\n");
  return `{\n  "waivers": [\n${body}\n  ]\n}\n`;
}

/** The text after appending `entries` at the end of the array of `text`; only the array's tail changes. */
export function appendEntries(text: string, array: ArrayLayout, entries: object[]): string {
  const eol = eolOf(text);
  const unit = "  ";
  const last = array.elements[array.elements.length - 1];
  if (last) {
    const first = array.elements[0]!;
    const indent = startsLine(text, first.start) ? lineIndent(text, first.start) : lineIndent(text, array.open) + unit;
    const insert = entries.map((e) => `,${eol}${indent}${formatEntry(e, indent, eol)}`).join("");
    return text.slice(0, last.end) + insert + text.slice(last.end);
  }
  const closeIndent = lineIndent(text, array.open);
  const indent = closeIndent + unit;
  const body = entries.map((e) => `${indent}${formatEntry(e, indent, eol)}`).join(`,${eol}`);
  return `${text.slice(0, array.open + 1)}${eol}${body}${eol}${closeIndent}${text.slice(array.close)}`;
}

/** The text after removing the element at `index` of the array of `text` with its comma; the rest is untouched. */
export function removeElement(text: string, array: ArrayLayout, index: number): string {
  const el = array.elements[index]!;
  if (array.elements.length === 1) return text.slice(0, array.open + 1) + text.slice(array.close);
  const next = array.elements[index + 1];
  if (next) return text.slice(0, el.start) + text.slice(next.start);
  const prev = array.elements[index - 1]!;
  return text.slice(0, prev.end) + text.slice(el.end);
}
