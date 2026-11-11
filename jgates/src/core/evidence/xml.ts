// Tiny XML helpers shared by the JUnit and Checkstyle readers. Reports are machine written, flat enough that a tag
// scanner is enough; a document that does not look like the expected report is refused by the reader, never guessed.

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function attributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1] as string] = decodeEntities((m[3] ?? m[4]) as string);
  return out;
}

export interface XmlTag {
  closing: boolean;
  selfClosing: boolean;
  name: string;
  attrs: string;
  /** Offset right after the tag. */
  end: number;
  /** Offset of the tag. */
  start: number;
}

/** Every element tag in order (comments, declarations and CDATA are skipped). */
export function* tags(xml: string): Generator<XmlTag> {
  const cleaned = xml.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length)).replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => " ".repeat(m.length));
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  for (const m of cleaned.matchAll(re)) {
    yield { closing: m[1] === "/", selfClosing: m[4] === "/", name: m[2] as string, attrs: m[3] as string, start: m.index as number, end: (m.index as number) + m[0].length };
  }
}

/** Text content between two offsets with CDATA unwrapped and entities decoded. */
export function textBetween(xml: string, from: number, to: number): string {
  const raw = xml.slice(from, to).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/&/g, "&amp;").replace(/</g, "&lt;"));
  return decodeEntities(raw);
}
