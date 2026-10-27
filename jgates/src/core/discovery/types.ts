export const DETECTOR_VERSION = "discovery/1.0.0";

export type ClassificationStatus = "explicit" | "detected" | "ambiguous" | "unsupported" | "ignored";
export type DiscoveryMode = "auto" | "explicit" | "report-only";

export interface Classification {
  id: string;
  /** Directory of the component relative to the project, forward slashes; "." for the project root. */
  componentRoot: string;
  language: string | null;
  framework: string | null;
  packageManager: string | null;
  kind: string | null;
  detectedBy: string;
  detectorVersion: string;
  /** Sorted, project-relative paths of the files (or directory) that justify the classification. */
  evidencePaths: string[];
  reasonCode: string;
  classificationStatus: ClassificationStatus;
  /** True only for explicit or detected entries, when the mode allows templates and the entry is enabled. */
  approvable: boolean;
}

export interface Inconsistency {
  code: string;
  componentRoot: string;
  id: string | null;
}

export interface DiscoveryLimits {
  maxEntries: number;
  maxDepth: number;
  maxManifestBytes: number;
}

export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = { maxEntries: 50000, maxDepth: 16, maxManifestBytes: 1024 * 1024 };

export interface Inventory {
  schemaVersion: 1;
  detectorVersion: string;
  mode: DiscoveryMode;
  /** False in report-only mode: the inventory is reported and no template is activated. */
  templatesActive: boolean;
  configFile: string | null;
  classifications: Classification[];
  /** Sorted languages of the approvable classifications. */
  languages: string[];
  summary: Record<ClassificationStatus, number>;
  inconsistencies: Inconsistency[];
  indexed: { entries: number; truncated: boolean };
}

export interface DeclaredComponent {
  id: string;
  path: string;
  language?: string;
  framework?: string;
  kind?: string;
  enabled?: boolean;
}

/** What the discovery needs from .jgates/workspace.yml (see schemas/config/workspace.schema.json). */
export interface WorkspaceSettings {
  mode: DiscoveryMode;
  components: DeclaredComponent[];
  include: string[];
  exclude: string[];
  configFile: string | null;
}

export interface DirEntry {
  name: string;
  kind: "file" | "dir" | "other";
}

export interface DiscoveryOptions {
  /** Replaces the directory listing (tests shuffle the order with it). The result is sorted anyway. */
  readDir?: (absDir: string) => DirEntry[];
  limits?: Partial<DiscoveryLimits>;
  /** Overrides the mode of the configuration. */
  mode?: DiscoveryMode;
  caseInsensitive?: boolean;
}
