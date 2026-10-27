import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";

export interface CatalogEntry {
  id: string;
  label: string;
  description: string;
  /** Capabilities only: the category the capability belongs to. */
  category?: string;
  unit?: string;
  proves?: string;
  observes?: string[];
  limits?: string[];
}

export interface Subcheck {
  id: string;
  label: string;
  description?: string;
  capabilities: string[];
  modes: Array<"quick" | "offline" | "full">;
  conditions?: string[];
  limitations?: string[];
}

/**
 * A folder of the run folder that takes the place of a workspace write:
 * `path` is relative to the run folder; the runner creates it and sets every variable in `env` to its absolute path.
 */
export interface OutputPath {
  path: string;
  purpose: "cache" | "home" | "output" | "report";
  env?: string[];
}

/** Adapter manifest; validated against schemas/catalog/adapter-manifest.schema.json. */
export interface AdapterManifest {
  schemaVersion: 1;
  id: string;
  displayName: string;
  adapterVersion: string;
  apiRange: string;
  toolName: string;
  toolVersionRange: string;
  runtimes?: string[];
  platforms: string[];
  cpuArchitectures?: string[];
  categories: string[];
  capabilities: string[];
  languages?: string[];
  frameworks?: string[];
  compatibleManifests?: string[];
  granularity: Array<"workspace" | "component" | "file" | "diff">;
  minimumContext?: string[];
  configFiles: Array<{ format: string; discovery: string; precedence?: string; ownedSelector?: string }>;
  editing: { implemented: string[]; tested: string[] };
  exitCodes: { codes: Array<{ code: number; meaning: string }>; reportRequired: boolean };
  effects: Record<string, boolean>;
  redirection?: { flags?: string[]; env?: string[]; outputPaths?: OutputPath[]; unavoidableWorkspaceWrites?: string[] };
  toggles?: { togglable?: string[]; perRunByFlag?: boolean };
  relativeCost: "low" | "medium" | "high";
  origin: string;
  integrity?: string;
  license: string;
  kind?: "tool" | "composite";
  subchecks?: Subcheck[];
  limitations?: string[];
  [key: string]: unknown;
}

/** Core ids are lowercase kebab-case; extension ids carry a namespace: x-<vendor>:<name>. */
export const ID_PATTERN = /^([a-z][a-z0-9-]*|x-[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9._-]*)$/;

export function isExtensionId(id: string): boolean {
  return id.startsWith("x-");
}

const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "schemas", "catalog");

function readSchema(name: string): object {
  return JSON.parse(fs.readFileSync(path.join(schemaDir, name), "utf8")) as object;
}

type AjvCtor = new (opts: object) => {
  compile(schema: object): ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string }> | null };
};
const Ajv = ((Ajv2020Module as unknown as { default?: AjvCtor }).default ?? (Ajv2020Module as unknown as AjvCtor)) as AjvCtor;

let validators: { manifest: ReturnType<InstanceType<AjvCtor>["compile"]>; entry: ReturnType<InstanceType<AjvCtor>["compile"]> } | undefined;

function getValidators() {
  if (!validators) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    validators = {
      manifest: ajv.compile(readSchema("adapter-manifest.schema.json")),
      entry: ajv.compile(readSchema("catalog-entry.schema.json")),
    };
  }
  return validators;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function run(validate: ReturnType<InstanceType<AjvCtor>["compile"]>, data: unknown): ValidationResult {
  const ok = validate(data) as boolean;
  const errors = ok ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
  return { ok, errors };
}

export function validateManifest(manifest: unknown): ValidationResult {
  return run(getValidators().manifest, manifest);
}

export function validateEntry(entry: unknown): ValidationResult {
  return run(getValidators().entry, entry);
}

/** Registry of categories, capabilities and adapters. Open: extensions register by namespaced id, no core change. */
export class Catalog {
  private readonly categories = new Map<string, CatalogEntry>();
  private readonly capabilities = new Map<string, CatalogEntry>();
  private readonly adapters = new Map<string, AdapterManifest>();

  addCategory(entry: CatalogEntry): void {
    this.add(this.categories, entry, "category");
  }

  addCapability(entry: CatalogEntry): void {
    this.add(this.capabilities, entry, "capability");
  }

  private add(map: Map<string, CatalogEntry>, entry: CatalogEntry, kind: string): void {
    const v = validateEntry(entry);
    if (!v.ok) throw new Error(`invalid ${kind} ${JSON.stringify(entry?.id)}: ${v.errors.join("; ")}`);
    if (map.has(entry.id)) throw new Error(`duplicate ${kind} id: ${entry.id}`);
    map.set(entry.id, entry);
  }

  /** Registers an adapter after validating the manifest and that every category and capability it names is known. */
  addAdapter(manifest: AdapterManifest): void {
    const v = validateManifest(manifest);
    if (!v.ok) throw new Error(`invalid manifest ${JSON.stringify(manifest?.id)}: ${v.errors.join("; ")}`);
    if (this.adapters.has(manifest.id)) throw new Error(`duplicate adapter id: ${manifest.id}`);
    for (const c of manifest.categories) if (!this.categories.has(c)) throw new Error(`unknown category: ${c}`);
    const caps = [...manifest.capabilities, ...(manifest.subchecks ?? []).flatMap((s) => s.capabilities)];
    for (const c of caps) if (!this.capabilities.has(c)) throw new Error(`unknown capability: ${c}`);
    this.adapters.set(manifest.id, manifest);
  }

  hasCategory(id: string): boolean {
    return this.categories.has(id);
  }

  hasCapability(id: string): boolean {
    return this.capabilities.has(id);
  }

  toDocument() {
    return {
      categories: [...this.categories.values()],
      capabilities: [...this.capabilities.values()],
      adapters: [...this.adapters.values()],
    };
  }
}

export const CORE_CATEGORIES: CatalogEntry[] = [
  { id: "quality", label: "Qualidade", description: "Estilo, lint, duplicação e saúde geral do código." },
  { id: "security", label: "Segurança", description: "Vulnerabilidades, segredos e dados pessoais." },
  { id: "tests", label: "Testes", description: "Execução de testes e cobertura." },
  { id: "architecture", label: "Arquitetura", description: "Contratos de dependência e estrutura." },
  { id: "dependencies", label: "Dependências", description: "Vulnerabilidades, licenças e integridade de dependências." },
  { id: "infrastructure", label: "Infraestrutura", description: "Infraestrutura como código e configuração de ambiente." },
  { id: "custom", label: "Verificações próprias", description: "Verificações definidas pelo projeto ou por extensões." },
];

function cap(id: string, category: string, label: string, description: string, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return { id, category, label, description, ...extra };
}

export const CORE_CAPABILITIES: CatalogEntry[] = [
  cap("lint", "quality", "Lint", "Análise estática de estilo e erros comuns."),
  cap("format-check", "quality", "Verificação de formato", "Confere a formatação sem alterar arquivos."),
  cap("duplication", "quality", "Duplicação", "Detecta código duplicado."),
  cap("secrets", "security", "Segredos", "Procura credenciais e chaves no código."),
  cap("secrets-history", "security", "Segredos no histórico Git", "Procura credenciais e chaves nos commits do histórico Git, não só na árvore atual."),
  cap("pii", "security", "Dados pessoais", "Procura dados pessoais em código e dados."),
  cap("sast", "security", "SAST", "Análise estática de segurança do código."),
  cap("dependencies", "dependencies", "Dependências", "Vulnerabilidades conhecidas em dependências."),
  cap("licenses", "dependencies", "Licenças", "Licenças das dependências e do código distribuído."),
  cap("unit", "tests", "Testes unitários", "Executa os testes unitários."),
  cap("integration", "tests", "Testes de integração", "Executa os testes de integração."),
  cap("e2e", "tests", "Testes ponta a ponta", "Executa os testes ponta a ponta."),
  cap("coverage", "tests", "Cobertura", "Mede a cobertura dos testes.", { unit: "percent" }),
  cap("mutation", "tests", "Mutação", "Mede a força dos testes por mutação.", { unit: "percent" }),
  cap("architecture", "architecture", "Arquitetura", "Satisfação dos contratos de arquitetura configurados."),
  cap("api-compatibility", "architecture", "Compatibilidade de API", "Compatibilidade de contratos de API entre versões."),
  cap("migration", "infrastructure", "Migrações", "Segurança e ordem de migrações."),
  cap("performance", "quality", "Desempenho", "Orçamentos e regressões de desempenho."),
  cap("iac", "infrastructure", "Infraestrutura como código", "Más configurações em Terraform, Kubernetes e similares."),
  cap("file-size", "quality", "Tamanho de arquivo", "Limite de linhas por arquivo.", { unit: "lines" }),
];

/** Builds a catalog with the core categories and capabilities (no adapters). */
export function createCoreCatalog(): Catalog {
  const catalog = new Catalog();
  for (const c of CORE_CATEGORIES) catalog.addCategory(c);
  for (const c of CORE_CAPABILITIES) catalog.addCapability(c);
  return catalog;
}
