// Generate the bilingual tool catalog after compiling JGates.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtinManifests } from "../dist/adapters/manifests.js";
import { loadLinters, linterTemplateId, linterTexts } from "../dist/adapters/linter/descriptor.js";
import { buildMatrix } from "../dist/core/matrix/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const linters = loadLinters({}).map(({ descriptor }) => descriptor);
const descriptorIds = new Set(linters.map(({ id }) => id));
const native = builtinManifests().filter(({ id }) => !descriptorIds.has(id) && id !== "quality-bridge");
const matrix = buildMatrix(native);
const image = read("jgates/release/image-tools.json").tools;
const templateDir = "jgates/src/builtin/templates";
const templates = fs.readdirSync(path.join(root, templateDir)).filter((name) => name.endsWith(".json"))
  .sort().map((name) => read(`${templateDir}/${name}`));
const check = process.argv.includes("--check");

const copy = {
  en: {
    title: "JGates tool catalog",
    intro: "The tables cover the built-in checks. Versions shown for descriptor tools come from the pinned tools image. See the [compatibility matrix](compatibility.en.md) for test evidence and [third-party notices](../../THIRD_PARTY_NOTICES.md) for the complete image inventory, including runtimes and bundled components.",
    descriptors: "Descriptor-based tools",
    tiers: "Essential runs the core checks. Balanced adds applicable `main` tools from this table and Strict adds applicable `extended` tools. Use `tool:<id>` to enable a tool explicitly. The template column gives the ID within the built-in source.",
    native: "Other built-in adapters",
    nativeIntro: "The file patterns below are the built-in templates' activation evidence. The adapter can also require specific files, configuration or services. See `jgates plan` for the decision on your project.",
    tool: "Tool", purpose: "What it checks", trigger: "File evidence", license: "License", limitation: "Limitation",
    template: "Tier and template", adapter: "Adapter", stack: "Applicable stacks", any: "Any stack",
    configured: "Explicit configuration", project: "Whole project", requires: "Requires one of",
    content: "Content pattern", firstLine: "first line", prefix: "first 4 KiB", extensionless: "files without an extension",
  },
  "pt-BR": {
    title: "Catálogo de ferramentas do JGates",
    intro: "As tabelas cobrem as verificações integradas. As versões das ferramentas com descritor vêm da imagem de ferramentas fixada. Consulte a [matriz de compatibilidade](compatibility.pt-BR.md) para ver as evidências de teste e os [avisos de terceiros](../../THIRD_PARTY_NOTICES.md) para ver o inventário completo da imagem, incluindo ambientes de execução e componentes incluídos.",
    descriptors: "Ferramentas com descritor",
    tiers: "O perfil Essencial roda as verificações básicas. O Equilibrado acrescenta as ferramentas aplicáveis do nível `main` desta tabela e o Rigoroso, as do nível `extended`. Use `tool:<id>` para ligar uma ferramenta explicitamente. A coluna de templates mostra o ID na origem integrada.",
    native: "Outros adaptadores integrados",
    nativeIntro: "Os padrões de arquivo abaixo são as evidências de ativação dos templates integrados. O adaptador também pode exigir arquivos, configurações ou serviços específicos. Consulte `jgates plan` para ver a decisão no seu projeto.",
    tool: "Ferramenta", purpose: "O que verifica", trigger: "Arquivos que ativam", license: "Licença", limitation: "Limitação",
    template: "Nível e template", adapter: "Adaptador", stack: "Stacks aplicáveis", any: "Qualquer stack",
    configured: "Configuração explícita", project: "Projeto inteiro", requires: "Exige um destes arquivos",
    content: "Padrão de conteúdo", firstLine: "primeira linha", prefix: "primeiros 4 KiB", extensionless: "arquivos sem extensão",
  },
};

const code = (value) => `\`${value}\``;
const codeList = (values) => values.map(code).join(", ");
const tableRow = (values) => `| ${values.map((value) => value.replaceAll("|", "\\|").replace(/\s*\r?\n\s*/g, " ")).join(" | ")} |`;
const table = (headings, rows) => [tableRow(headings), tableRow(headings.map(() => "---")), ...rows.map(tableRow)].join("\n");

function fileEvidence({ extensions = [], names = [], content, project, requires = [] }, t) {
  const matches = [...extensions, ...names].map(code);
  if (content) {
    const candidates = content.names?.length ? codeList(content.names) : t.extensionless;
    matches.push(`${t.content} ${code(content.pattern)} (${t[content.firstLine === false ? "prefix" : "firstLine"]}, ${candidates})`);
  }
  const trigger = project ? t.project : matches.join(", ");
  return [trigger, requires.length ? `${t.requires} ${codeList(requires)}` : ""].filter(Boolean).join(". ");
}

function nativeEvidence(id, t) {
  const matching = templates.filter((template) => Object.values(template.config?.tools ?? {})
    .some((tool) => tool.adapter === id && tool.enabled !== false));
  return matching.map(({ id, match }) => {
    const files = match?.files ?? [];
    return files.length ? `${code(id)} (${codeList(files)})` : code(id);
  }).join("; ") || t.configured;
}

for (const [lang, t] of Object.entries(copy)) {
  const catalog = read(`jgates/src/i18n/catalog.${lang}.json`);
  const descriptorRows = linters.map((d) => {
    const version = image[d.program.tool];
    if (!version) throw new Error(`${d.id}: ${d.program.tool} is missing from the tools image inventory`);
    const { purpose, limitation } = linterTexts(d, lang);
    return [`${code(d.id)} (${d.program.tool} ${version})`, purpose, fileEvidence(d.activation, t), code(d.license),
      `${code(d.place.tier)} / ${code(linterTemplateId(d))}`, limitation];
  });
  const nativeRows = [...native].sort((a, b) => a.id.localeCompare(b.id, "en")).map((m) => {
    const adapter = matrix.adapters.find(({ id }) => id === m.id);
    const stacks = [...new Set((m.stackSupport ?? []).map(({ stack }) => stack))].sort();
    const applicable = stacks.includes("any") ? t.any : codeList(stacks) || t.configured;
    const capabilities = m.capabilities.map((id) => catalog[`capability_${id}_label`] ?? code(id));
    return [code(m.id), capabilities.join(", ") || t.configured, applicable, nativeEvidence(m.id, t), m.license,
      adapter.limitation[lang === "en" ? "en" : "ptBR"]];
  });
  const doc = [
    `# ${t.title}`, t.intro, `## ${t.descriptors}`, t.tiers,
    table([t.tool, t.purpose, t.trigger, t.license, t.template, t.limitation], descriptorRows),
    `## ${t.native}`, t.nativeIntro,
    table([t.adapter, t.purpose, t.stack, t.trigger, t.license, t.limitation], nativeRows),
    "<!-- Generated by jgates/scripts/gen-tool-catalog.mjs. -->",
  ].join("\n\n") + "\n";
  const file = path.join(root, "docs", "jgates", `tools.${lang}.md`);
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n") === doc) continue;
  if (check) {
    console.error(`Stale tool catalog: ${path.relative(root, file)}`);
    process.exitCode = 1;
  } else {
    fs.writeFileSync(file, doc);
  }
}
