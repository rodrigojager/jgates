// What GET /api/providers and GET /api/secrets send: values with their origin and the state of each key, never a
// key value (the server never has one to send).
import { formatLocale } from "../../i18n/locale";

export type Origin = "project" | "user" | "default" | "unset";
export interface FieldValue {
  value: string | null;
  origin: Origin;
}
export type ProviderField = "baseUrl" | "model" | "apiKeyEnv";

export interface KeyState {
  name: string;
  state: "set" | "unset" | "unknown";
  source: "env" | "vault" | "none" | "unknown";
  updatedAt: string | null;
}

export interface ProviderEntry {
  name: string;
  kind: "provider" | "connection";
  type: "openai-compatible" | "http" | "cli";
  fields: ProviderField[];
  baseUrl: FieldValue;
  model: FieldValue;
  apiKeyEnv: FieldValue;
  headers: Record<string, string>;
  allowInsecureHttp: boolean;
  key: KeyState | null;
}

export interface FieldErrorView {
  field: string;
  code: string;
  message: string;
}

export type Lock = "governed" | "policy" | null;

export interface ProvidersData {
  writable: boolean;
  locked: Lock;
  governed: { policy: string } | null;
  file: string;
  revision: string | null;
  providers: ProviderEntry[];
  problems: FieldErrorView[];
}

export interface SecretView {
  name: string;
  provider: string | null;
  state: "set" | "unset";
  source: "env" | "vault" | "none";
  envName: string | null;
  inVault: boolean;
  updatedAt: string | null;
  usedBy: string[];
  testable: boolean;
}

export interface SecretsData {
  writable: boolean;
  locked: Lock;
  governed: { policy: string } | null;
  vault: string;
  secrets: SecretView[];
}

export interface ModelsAnswer {
  name: string;
  count: number;
  models: string[];
  truncated: boolean;
  defaultModelListed: boolean | null;
}

/** The key name pattern of the store (^[A-Z_][A-Z0-9_]*$). */
export const KEY_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
/** The connection name pattern (^[a-z0-9][a-z0-9-]{0,62}$). */
export const CONNECTION_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const secretPath = (name: string, suffix = ""): string => `/api/secrets/${encodeURIComponent(name)}${suffix}`;
export const providerPath = (name: string, suffix = ""): string => `/api/providers/${encodeURIComponent(name)}${suffix}`;

export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(formatLocale(), { dateStyle: "short", timeStyle: "short" });
}

/** true for plain http to a host that is not loopback: the key would travel in clear text (the server asks for a confirmation). */
export function insecureHttp(url: string): boolean {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return !(host === "localhost" || host.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "::1");
  } catch {
    return false;
  }
}

/** "Name: value" per line; an empty text clears the headers. Returns the field of the first line that is not a pair. */
export function parseHeaders(text: string): { headers: Record<string, string> | null } | { bad: string } {
  const headers: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const at = line.indexOf(":");
    if (at <= 0) return { bad: line.slice(0, 40) };
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { headers: Object.keys(headers).length > 0 ? headers : null };
}

export const headersText = (headers: Record<string, string>): string =>
  Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
