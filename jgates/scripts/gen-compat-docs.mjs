// Regenerates the compatibility matrix tables in docs/jgates/compatibilidade.{pt-BR,en}.md from the adapter manifests
// and the test evidence (jgates/src/core/matrix). Only the text between the two markers is replaced; the prose around
// the tables is kept. A missing document is created with its prose.
//
//   npm --prefix jgates run build && npm --prefix jgates run docs:compat          write the documents
//   node jgates/scripts/gen-compat-docs.mjs --check                                exit 1 when a document is stale
//
// matrix.test.js compares the same tables, so a change to a manifest or to evidence.ts needs this command.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const jgatesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.resolve(jgatesRoot, "..", "docs", "jgates");
const matrixModule = path.join(jgatesRoot, "dist", "core", "matrix", "index.js");

if (!fs.existsSync(matrixModule)) {
  console.error("jgates/dist is missing: run `npm --prefix jgates run build` first.");
  process.exit(2);
}

const m = await import(pathToFileURL(matrixModule).href);
const matrix = m.buildMatrix();
const problems = m.verifyMatrix(matrix);
if (problems.length > 0) {
  console.error(`The matrix does not hold (every announced capability needs a test or a stated reason); fix this before generating the documents:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}

const check = process.argv.includes("--check");

const SKELETON = {
  "pt-BR": `# Matriz de compatibilidade do JGates

Esta matriz é gerada dos manifestos dos adaptadores e das evidências de teste (\`jgates tools matrix --json\`). Cada capacidade integrada cita o arquivo de teste que a prova (em \`jgates/tests\`) e cada adaptador descreve a sua limitação. Um teste (\`jgates/tests/matrix.test.js\`) falha se uma capacidade for anunciada sem teste existente ou sem limitação descrita, e se esta tabela divergir da saída do comando. Para regenerar: \`npm --prefix jgates run build && npm --prefix jgates run docs:compat\`.

## Sistemas operacionais

- Linux: testado.
- Windows: ainda não testado; os testes que dependem do Windows estão marcados e pulam fora dele.
- macOS: não testado em máquina real.

## Suporte parcial

Go e Rust têm suporte parcial: descoberta, configuração explícita e o comando genérico com \`go test\` e \`cargo test\`. O que cada stack não cobre está na segunda tabela. .NET também é parcial.

## Matriz

`,
  en: `# JGates compatibility matrix

This matrix is generated from the adapter manifests and the test evidence (\`jgates tools matrix --json\`). Each integrated capability names the test file that proves it (in \`jgates/tests\`) and each adapter states its limitation. A test (\`jgates/tests/matrix.test.js\`) fails if a capability is announced without an existing test or without a described limitation, and if this table differs from the command output. To regenerate: \`npm --prefix jgates run build && npm --prefix jgates run docs:compat\`.

## Operating systems

- Linux: tested.
- Windows: not tested yet; tests that depend on Windows are marked and skip elsewhere.
- macOS: not tested on real hardware.

## Partial support

Go and Rust have partial support: discovery, explicit configuration and the generic command with \`go test\` and \`cargo test\`. What each stack does not cover is in the second table. .NET is partial as well.

## Matrix

`,
};

let stale = 0;
for (const lang of ["pt-BR", "en"]) {
  const file = path.join(docsDir, `compatibilidade.${lang}.md`);
  const block = `${m.MATRIX_START}\n${m.renderMatrixMarkdown(matrix, lang)}${m.MATRIX_END}\n`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  let next;
  if (current === null) {
    next = SKELETON[lang] + block;
  } else {
    const a = current.indexOf(m.MATRIX_START);
    const b = current.indexOf(m.MATRIX_END);
    if (a < 0 || b < a) {
      console.error(`${file}: the markers ${m.MATRIX_START} and ${m.MATRIX_END} are missing.`);
      process.exit(1);
    }
    next = current.slice(0, a) + block.slice(0, -1) + current.slice(b + m.MATRIX_END.length);
  }
  if (next === current) {
    console.log(`up to date: ${path.relative(process.cwd(), file)}`);
  } else if (check) {
    stale += 1;
    console.error(`stale: ${path.relative(process.cwd(), file)}`);
  } else {
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(file, next);
    console.log(`written: ${path.relative(process.cwd(), file)}`);
  }
}
if (stale > 0) {
  console.error("Run `npm --prefix jgates run build && npm --prefix jgates run docs:compat` and commit the documents.");
  process.exit(1);
}
