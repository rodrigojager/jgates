/**
 * Text encoding of a document. Bytes are decoded only when the decoding round-trips exactly, so writing back the
 * text that was read reproduces the same bytes; Latin-1 and UTF-16 never become UTF-8 in silence.
 */

export type DocumentEncoding = "utf-8" | "utf-16le" | "utf-16be" | "latin1";
export type Eol = "lf" | "crlf" | "mixed" | "none";

export interface DecodedText {
  /** null when the bytes are not text this service can edit (binary, undecodable). */
  text: string | null;
  encoding: DocumentEncoding | null;
  bom: boolean;
  eol: Eol;
  /** Why text is null: BINARY or ENCODING_UNSUPPORTED. */
  problem: "BINARY" | "ENCODING_UNSUPPORTED" | null;
}

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);

function startsWith(bytes: Buffer, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
}

function decodeStrict(bytes: Buffer, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  if (crlf === 0 && lf === 0 && cr === 0) return "none";
  if (cr > 0 || (crlf > 0 && lf > 0)) return "mixed";
  return crlf > 0 ? "crlf" : "lf";
}

/** Encodes text in the given encoding; throws a RangeError when a character does not fit (Latin-1). */
export function encodeText(text: string, encoding: DocumentEncoding, bom: boolean): Buffer {
  let body: Buffer;
  let mark: Buffer = Buffer.alloc(0);
  switch (encoding) {
    case "utf-8":
      body = Buffer.from(text, "utf8");
      if (bom) mark = BOM_UTF8;
      break;
    case "utf-16le":
      body = Buffer.from(text, "utf16le");
      if (bom) mark = Buffer.from([0xff, 0xfe]);
      break;
    case "utf-16be":
      body = Buffer.from(text, "utf16le").swap16();
      if (bom) mark = Buffer.from([0xfe, 0xff]);
      break;
    case "latin1":
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 0xff) throw new RangeError(`character U+${text.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")} does not fit Latin-1`);
      }
      body = Buffer.from(text, "latin1");
      break;
  }
  return Buffer.concat([mark, body]);
}

/** Decodes the bytes of a document; text is null when they are binary or do not round-trip. */
export function decodeBytes(bytes: Buffer): DecodedText {
  let encoding: DocumentEncoding;
  let bom = false;
  let text: string | null;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    encoding = "utf-8";
    bom = true;
    text = decodeStrict(bytes.subarray(3), "utf-8");
  } else if (startsWith(bytes, [0xff, 0xfe])) {
    encoding = "utf-16le";
    bom = true;
    text = bytes.length % 2 === 0 ? decodeStrict(bytes.subarray(2), "utf-16le") : null;
  } else if (startsWith(bytes, [0xfe, 0xff])) {
    encoding = "utf-16be";
    bom = true;
    text = bytes.length % 2 === 0 ? decodeStrict(Buffer.from(bytes.subarray(2)).swap16(), "utf-16le") : null;
  } else {
    if (bytes.includes(0)) return { text: null, encoding: null, bom: false, eol: "none", problem: "BINARY" };
    text = decodeStrict(bytes, "utf-8");
    encoding = "utf-8";
    if (text === null) {
      encoding = "latin1";
      text = bytes.toString("latin1");
    }
  }
  if (text === null) return { text: null, encoding, bom, eol: "none", problem: "ENCODING_UNSUPPORTED" };
  // Only a decoding that reproduces the bytes is editable.
  let again: Buffer | null = null;
  try {
    again = encodeText(text, encoding, bom);
  } catch {
    again = null;
  }
  if (!again || !again.equals(bytes)) return { text: null, encoding, bom, eol: "none", problem: "ENCODING_UNSUPPORTED" };
  return { text, encoding, bom, eol: detectEol(text), problem: null };
}

/**
 * Brings incoming text to the line breaks of the document: a CRLF document stays CRLF and an LF one stays LF even
 * when the editor or stdin sends the other kind. Mixed or single-line documents keep the text as given. A leading
 * BOM character is dropped: the BOM is a property of the document, not of the text.
 */
export function conformText(text: string, eol: Eol): string {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (eol === "crlf") return body.replace(/\r?\n/g, "\r\n");
  if (eol === "lf") return body.replace(/\r\n/g, "\n");
  return body;
}
