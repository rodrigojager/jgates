// Fake /etc/jgates/image.json files for the tests (JGATES_IMAGE_JSON): the package's mirror of the tools image's
// image.json (release/image-tools.json) with tools left out or replaced, written to a temporary folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RELEASE_IMAGE_JSON = path.resolve(here, "..", "..", "release", "image-tools.json");

/** The mirror's document. */
export function releaseImageJson() {
  return JSON.parse(fs.readFileSync(RELEASE_IMAGE_JSON, "utf8"));
}

/** Writes an image.json with `tools` replaced as given (a tool set to null is left out) and returns its path. */
export function writeImageJson(tools = {}, extra = {}) {
  const doc = { ...releaseImageJson(), ...extra };
  doc.tools = { ...doc.tools };
  for (const [name, version] of Object.entries(tools)) {
    if (version === null) delete doc.tools[name];
    else doc.tools[name] = version;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-image-json-"));
  const file = path.join(dir, "image.json");
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

/** An image.json without the named tools. */
export function imageJsonWithout(...names) {
  return writeImageJson(Object.fromEntries(names.map((n) => [n, null])));
}
