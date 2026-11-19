// Generates the parts of the committed documents that the tools image decides (npm --prefix jgates run image:docs):
//   1. the table "Tools shipped in the tools image" of THIRD_PARTY_NOTICES.md, from src/core/tools-image/about.json
//      (the programs that are not linter descriptors, and the components bundled inside them) and the linter
//      descriptors (src/builtin/linters/<id>/linter.json: their license and source), one row per image.json name;
//   2. the size of the image written in prose (the README's requirements, docs/jgates/storage, limitations and
//      getting-started, in English and pt-BR), from the pin the image build writes (release/tools-image.json): GB to
//      download and GB unpacked, rounded.
// `--check` changes nothing and fails when a document differs from what would be generated (tests run it; the
// integration slices regenerate after an image build). A document that no longer states the size fails the check too.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repositoryRoot = path.resolve(packageRoot, "..");
const NOTICES = path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md");
const ABOUT = path.join(packageRoot, "src", "core", "tools-image", "about.json");
const LINTERS = path.join(packageRoot, "src", "builtin", "linters");
const PIN = path.join(packageRoot, "release", "tools-image.json");
const TABLE_HEADER = "| Tool | License | Source |";

/** The documents that state the image's size, relative to the repository. */
export const SIZE_DOCUMENTS = [
  "README.md",
  "docs/jgates/storage.en.md",
  "docs/jgates/storage.pt-BR.md",
  "docs/jgates/limitations.en.md",
  "docs/jgates/limitations.pt-BR.md",
  "docs/jgates/getting-started.en.md",
  "docs/jgates/getting-started.pt-BR.md",
];
const DOWNLOAD = /\b([Aa]bout|[Cc]erca de) (\d+(?:[.,]\d+)?) GB( to download| para baixar)/g;
const UNPACKED = /\b(around|uns) (\d+(?:[.,]\d+)?) GB( unpacked| of disk once unpacked| descompactada| de disco depois de descompactada)/g;

function readDescriptors() {
  if (!fs.existsSync(LINTERS)) return [];
  return fs
    .readdirSync(LINTERS)
    .filter((id) => fs.existsSync(path.join(LINTERS, id, "linter.json")))
    .sort()
    .map((id) => JSON.parse(fs.readFileSync(path.join(LINTERS, id, "linter.json"), "utf8")));
}

/** The rows of the table: [name, license cell, source URL], sorted by name. */
export function noticeRows({ about = JSON.parse(fs.readFileSync(ABOUT, "utf8")), descriptors = readDescriptors() } = {}) {
  const rows = new Map();
  const cell = (entry) => entry.notice ?? `${entry.license}${entry.note ? ` (${entry.note})` : ""}`;
  for (const [name, entry] of Object.entries(about.tools)) rows.set(name, [name, cell(entry), entry.source]);
  for (const [name, entry] of Object.entries(about.bundled ?? {})) {
    if (rows.has(name)) throw new Error(`about.json: ${name} is both a tool and a bundled component`);
    rows.set(name, [name, cell(entry), entry.source]);
  }
  const fromDescriptor = new Map();
  for (const d of descriptors) {
    const name = d.program.tool;
    if (about.tools[name]) continue;
    const earlier = fromDescriptor.get(name);
    if (earlier && earlier.license !== d.license) throw new Error(`the descriptors ${earlier.id} and ${d.id} run ${name} with different licenses (${earlier.license}, ${d.license})`);
    if (rows.has(name) && !earlier) throw new Error(`${name}: the descriptor ${d.id} and about.json's bundled list both name it`);
    fromDescriptor.set(name, d);
    rows.set(name, [name, d.license, d.sourceUrl]);
  }
  return [...rows.values()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** THIRD_PARTY_NOTICES.md with its tools image table regenerated. */
export function noticesText(text, rows = noticeRows()) {
  const section = text.indexOf("## Tools shipped in the tools image");
  if (section < 0) throw new Error("THIRD_PARTY_NOTICES.md lacks the section \"Tools shipped in the tools image\"");
  const start = text.indexOf(TABLE_HEADER, section);
  if (start < 0) throw new Error(`THIRD_PARTY_NOTICES.md lacks the table header ${TABLE_HEADER}`);
  const lines = text.slice(start).split("\n");
  let count = 0;
  while (count < lines.length && lines[count].startsWith("|")) count += 1;
  const table = [TABLE_HEADER, "| --- | --- | --- |", ...rows.map(([name, license, source]) => `| \`${name}\` | ${license} | <${source}> |`)];
  return text.slice(0, start) + [...table, ...lines.slice(count)].join("\n");
}

const gigabytes = (bytes) => String(Math.max(1, Math.round(Number(bytes) / 1e9)));

/** A document with the size phrases set from the pin; `found` counts the phrases of each kind. */
export function sizedText(text, pin) {
  const download = gigabytes(pin.compressedBytes ?? pin.sizeBytes);
  const unpacked = gigabytes(pin.uncompressedBytes ?? (pin.compressedBytes ?? pin.sizeBytes) * 2.9);
  const found = { download: 0, unpacked: 0 };
  const out = text
    .replace(DOWNLOAD, (_all, word, _n, tail) => {
      found.download += 1;
      return `${word} ${download} GB${tail}`;
    })
    .replace(UNPACKED, (_all, word, _n, tail) => {
      found.unpacked += 1;
      return `${word} ${unpacked} GB${tail}`;
    });
  return { text: out, found };
}

/** What would change: [{file, current, next, problem?}]. */
export function plannedChanges() {
  const out = [];
  const notices = fs.readFileSync(NOTICES, "utf8");
  out.push({ file: "THIRD_PARTY_NOTICES.md", current: notices, next: noticesText(notices) });
  const pin = JSON.parse(fs.readFileSync(PIN, "utf8"));
  for (const relative of SIZE_DOCUMENTS) {
    const file = path.join(repositoryRoot, ...relative.split("/"));
    const current = fs.readFileSync(file, "utf8");
    const { text, found } = sizedText(current, pin);
    const problem = found.download === 0 || found.unpacked === 0 ? `${relative} no longer states the image's size (the phrases "about N GB to download" and "around N GB unpacked", or their pt-BR forms)` : undefined;
    out.push({ file: relative, current, next: text, ...(problem ? { problem } : {}) });
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const changes = plannedChanges();
  const problems = changes.filter((c) => c.problem).map((c) => c.problem);
  const stale = changes.filter((c) => c.current !== c.next).map((c) => c.file);
  for (const problem of problems) console.error(`image:docs: ${problem}`);
  if (check) {
    if (stale.length > 0) console.error(`image:docs: out of date (run npm --prefix jgates run image:docs): ${stale.join(", ")}`);
    process.exitCode = stale.length > 0 || problems.length > 0 ? 1 : 0;
  } else {
    for (const change of changes) if (change.current !== change.next) fs.writeFileSync(path.join(repositoryRoot, ...change.file.split("/")), change.next);
    console.log(stale.length > 0 ? `image:docs: wrote ${stale.join(", ")}` : "image:docs: everything was up to date");
    process.exitCode = problems.length > 0 ? 1 : 0;
  }
}
