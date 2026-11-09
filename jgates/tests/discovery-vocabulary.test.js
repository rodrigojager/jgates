import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as fx from "./fixtures/discovery/index.js";

// The vocabulary of the "Declarar componente" dialog comes from the detectors' own tables: every framework a detector
// can write is offered under its language, a framework added to a detector table shows up without another list to
// edit, and the languages recognized without tools form their own group.

const here = path.dirname(fileURLToPath(import.meta.url));
const discovery = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "discovery", "index.js")).href);
const detectors = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "discovery", "detectors.js")).href);

const lang = (vocab, id) => vocab.languages.find((l) => l.id === id);
const frameworkIds = (vocab, id) => (lang(vocab, id)?.frameworks ?? []).map((f) => f.id).sort();

test("supported languages come first with readable names, in the detectors' order", () => {
  const vocab = discovery.buildVocabulary();
  const supported = vocab.languages.filter((l) => l.supported);
  assert.deepEqual(
    supported.map((l) => [l.id, l.label]),
    [
      ["python", "Python"],
      ["typescript", "TypeScript"],
      ["javascript", "JavaScript"],
      ["go", "Go"],
      ["rust", "Rust"],
      ["csharp", "C#"],
      ["fsharp", "F#"],
      ["visualbasic", "Visual Basic"],
    ],
  );
  const firstUnsupported = vocab.languages.findIndex((l) => !l.supported);
  assert.ok(vocab.languages.slice(firstUnsupported).every((l) => !l.supported), "the recognized-only languages follow the supported ones");
});

test("languages recognized without tools are a separate group, C++ included as cpp", () => {
  const vocab = discovery.buildVocabulary();
  const cpp = lang(vocab, "cpp");
  assert.deepEqual(cpp, { id: "cpp", label: "C++", supported: false, frameworks: [] });
  for (const id of new Set([...Object.values(detectors.UNSUPPORTED_MANIFESTS), ...Object.values(detectors.UNSUPPORTED_EXTENSIONS)])) {
    assert.equal(lang(vocab, id)?.supported, false, `${id} is offered as recognized without tools`);
  }
  assert.equal(new Set(vocab.languages.map((l) => l.id)).size, vocab.languages.length, "no language appears twice");
});

test("each language offers exactly the frameworks its detector writes", () => {
  const vocab = discovery.buildVocabulary();
  const ids = (table) => [...new Set(table.map(([, id]) => id))].sort();
  assert.deepEqual(frameworkIds(vocab, "python"), ids(detectors.PY_FRAMEWORKS));
  assert.deepEqual(frameworkIds(vocab, "typescript"), ids(detectors.NODE_FRAMEWORKS));
  assert.deepEqual(frameworkIds(vocab, "javascript"), ids(detectors.NODE_FRAMEWORKS));
  assert.deepEqual(frameworkIds(vocab, "go"), ids(detectors.GO_FRAMEWORKS));
  assert.deepEqual(frameworkIds(vocab, "rust"), ids(detectors.RUST_FRAMEWORKS));
  assert.deepEqual(frameworkIds(vocab, "csharp"), ["aspnet"]);
  assert.ok(frameworkIds(vocab, "python").includes("fastapi"));
  assert.ok(!frameworkIds(vocab, "python").includes("react"), "frameworks are filtered by language");
  assert.equal(lang(vocab, "typescript").frameworks.find((f) => f.id === "next").label, "Next.js");
});

test("a framework added to a detector table appears in the vocabulary", () => {
  const tables = discovery.DETECTOR_TABLES;
  const extended = {
    ...tables,
    supported: tables.supported.map((g) => (g.frameworks === detectors.PY_FRAMEWORKS ? { ...g, frameworks: [...g.frameworks, ["litestar", "litestar"]] } : g)),
    unsupported: [...tables.unsupported, "zig"],
  };
  const vocab = discovery.buildVocabulary(extended);
  assert.ok(frameworkIds(vocab, "python").includes("litestar"));
  assert.equal(lang(vocab, "python").frameworks.find((f) => f.id === "litestar").label, "Litestar");
  assert.deepEqual(lang(vocab, "zig"), { id: "zig", label: "Zig", supported: false, frameworks: [] });
  // The default vocabulary is built from the very tables the detectors use.
  assert.equal(tables.supported.find((g) => g.languages.includes("python")).frameworks, detectors.PY_FRAMEWORKS);
});

test("the .NET web framework the detector writes is the vocabulary's id", () => {
  const dir = fx.writeTree({ "svc/Svc.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n' });
  try {
    const c = discovery.discoverWorkspace(dir).inventory.classifications.find((x) => x.componentRoot === "svc");
    assert.equal(c.language, "csharp");
    assert.equal(c.framework, "aspnet");
    assert.deepEqual(frameworkIds(discovery.buildVocabulary(), c.language), [c.framework]);
  } finally {
    fx.removeTree(dir);
  }
});
