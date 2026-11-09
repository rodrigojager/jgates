// The vocabulary of component declarations: the languages and frameworks the detectors know, read from the detectors'
// own tables (one source: a framework added to a detector is offered by the "Declarar componente" dialog at once).
import {
  DOTNET_FRAMEWORKS,
  DOTNET_LANGUAGES,
  GO_FRAMEWORKS,
  LANGUAGE,
  NODE_FRAMEWORKS,
  PY_FRAMEWORKS,
  RUST_FRAMEWORKS,
  UNSUPPORTED_EXTENSIONS,
  UNSUPPORTED_MANIFESTS,
  type FrameworkTable,
} from "./detectors.js";

/** The detectors' tables: the languages each supported detector writes with its frameworks, and the languages recognized without tools. */
export interface DetectorTables {
  supported: ReadonlyArray<{ languages: readonly string[]; frameworks: FrameworkTable }>;
  unsupported: readonly string[];
}

export interface VocabularyFramework {
  id: string;
  label: string;
}

export interface VocabularyLanguage {
  id: string;
  label: string;
  /** True when JGates has checks for the language; false when it is only recognized (discovered, no checks run). */
  supported: boolean;
  frameworks: VocabularyFramework[];
}

export interface DiscoveryVocabulary {
  schemaVersion: 1;
  /** Supported languages first, in the detectors' order; then the recognized ones without tools, by name. */
  languages: VocabularyLanguage[];
}

export const DETECTOR_TABLES: DetectorTables = {
  supported: [
    { languages: [LANGUAGE.python], frameworks: PY_FRAMEWORKS },
    { languages: [LANGUAGE.typescript, LANGUAGE.javascript], frameworks: NODE_FRAMEWORKS },
    { languages: [LANGUAGE.go], frameworks: GO_FRAMEWORKS },
    { languages: [LANGUAGE.rust], frameworks: RUST_FRAMEWORKS },
    { languages: Object.values(DOTNET_LANGUAGES), frameworks: DOTNET_FRAMEWORKS },
  ],
  unsupported: [...Object.values(UNSUPPORTED_MANIFESTS), ...Object.values(UNSUPPORTED_EXTENSIONS)],
};

/** Display names of ids whose plain capitalization is wrong; any other id is shown capitalized. */
const LABELS: Readonly<Record<string, string>> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  csharp: "C#",
  fsharp: "F#",
  visualbasic: "Visual Basic",
  php: "PHP",
  cpp: "C++",
  next: "Next.js",
  nestjs: "NestJS",
  fastapi: "FastAPI",
  "actix-web": "Actix Web",
  aspnet: "ASP.NET Core",
};

export function labelOf(id: string): string {
  return LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

const byLabel = (a: { label: string }, b: { label: string }): number => a.label.localeCompare(b.label, "en");

/** Builds the vocabulary from detector tables (the real ones by default; tests pass extended copies). */
export function buildVocabulary(tables: DetectorTables = DETECTOR_TABLES): DiscoveryVocabulary {
  const languages: VocabularyLanguage[] = [];
  const seen = new Set<string>();
  for (const group of tables.supported) {
    const ids = [...new Set(group.frameworks.map(([, id]) => id))];
    for (const id of group.languages) {
      if (seen.has(id)) continue;
      seen.add(id);
      languages.push({ id, label: labelOf(id), supported: true, frameworks: ids.map((f) => ({ id: f, label: labelOf(f) })).sort(byLabel) });
    }
  }
  const unsupported = [...new Set(tables.unsupported)].filter((id) => !seen.has(id));
  languages.push(...unsupported.map((id) => ({ id, label: labelOf(id), supported: false, frameworks: [] })).sort(byLabel));
  return { schemaVersion: 1, languages };
}
