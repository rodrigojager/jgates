// Masking and exclusions applied to the review context BEFORE the prompt is built. Matches become a placeholder
// ([MASKED:<label>]) and files that usually hold secrets leave the context. Secrets (credential assignments, private
// keys) are always masked; each PII entity turns on and off alone, and the project's own patterns only add.
// The CPF, CNPJ, card and phone shapes are those of the PII sidecar (quality_sidecar/pii.py), which finds the shapes
// without validating the digits. The e-mail and IP shapes exist only here (the detector does not recognize them yet).

/** Counts per label (entities, secret, the project's patterns and the external tools). */
export type MaskCounts = Record<string, number>;

/** The PII entities of the masking, with their defaults (ip-address is off: code holds many IPs that are not personal data). */
export const MASK_ENTITIES = ["cpf", "cnpj", "credit-card", "phone", "email", "ip-address"] as const;
export type MaskEntity = (typeof MASK_ENTITIES)[number];
export const DEFAULT_MASK_ENTITIES: Record<MaskEntity, boolean> = { cpf: true, cnpj: true, "credit-card": true, phone: true, email: true, "ip-address": false };

export interface MaskPattern {
  id: string;
  label: string;
  regex: RegExp;
}

export interface MaskRules {
  entities: Record<MaskEntity, boolean>;
  patterns: MaskPattern[];
}

export const defaultMaskRules = (): MaskRules => ({ entities: { ...DEFAULT_MASK_ENTITIES }, patterns: [] });
/** Every entity on: for text that is not configurable (reasons and findings of the result). */
export const strictMaskRules = (): MaskRules => ({ entities: Object.fromEntries(MASK_ENTITIES.map((e) => [e, true])) as Record<MaskEntity, boolean>, patterns: [] });

/** The counts a result always shows: secret plus every enabled entity (zero when nothing matched). */
export function emptyCounts(rules: MaskRules = defaultMaskRules()): MaskCounts {
  const counts: MaskCounts = { secret: 0 };
  for (const e of MASK_ENTITIES) if (rules.entities[e]) counts[e] = 0;
  for (const p of rules.patterns) counts[p.label] = 0;
  return counts;
}

export const totalCount = (counts: MaskCounts): number => Object.values(counts).reduce((a, b) => a + b, 0);

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
// name = value / name: value for names that hold credentials; the value is replaced, the name stays.
const SECRET_ASSIGNMENT = /\b((?:[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passwd|password|credential)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi;
const CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const CARD = /\b(?:\d[ -]*?){13,19}\b/g;
const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const PHONE = /(?<![\w+.\-/])(?:\+55[ -]?)?(?:\([1-9][1-9]\)|[1-9][1-9])[ -]?(?:9\d{4}|[2-5]\d{3})[ -]?\d{4}(?![\w\-/]|\.\d)/g;
// local@domain.tld: a local part that starts and ends with a letter or digit, one or more domain labels and a
// letter-only top-level label. Not an e-mail: "@scope/pkg", "pkg@1.2.3", "user@localhost", "icon@2x.png".
const EMAIL = /(?<![\w.%+-])[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9_%+-])?@(?!\d+x\.)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![\w-]|\.[A-Za-z0-9])/g;
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
// Four octets 0-255, not part of a longer dotted number (a version "1.2.3.4.5") nor glued to a word ("v1.2.3.4").
const IPV4 = new RegExp(`(?<![\\w.])${OCTET}(?:\\.${OCTET}){3}(?!\\w|\\.\\d)`, "g");
// Full (8 groups) or compressed ("::") IPv6; a match without a decimal digit ("cafe::bad", a C++ scope) is kept.
const IPV6 = /(?<![\w:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?|::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?)(?![\w:])/g;

/** Files whose content never goes to a provider, whatever the configuration says. */
const SENSITIVE_FILES: RegExp[] = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.jgates\/.*(secret|credential)/i,
];

export function isSensitivePath(file: string): boolean {
  return SENSITIVE_FILES.some((re) => re.test(file.replaceAll("\\", "/")));
}

/** Glob with `*`, `**` and `?`, enough for the exclusion list of the settings. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") i++;
        out += "(?:.*/)?";
        // "**" at the end matches the rest
        if (i >= glob.length - 1) out = out.slice(0, -"(?:.*/)?".length) + ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Whether a path matches one of the globs (a glob without "/" also matches the file name alone). */
export function isExcluded(file: string, globs: readonly string[]): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return globs.some((g) => {
    const re = globToRegExp(g.replace(/^\.\//, "").replace(/\/$/, "/**"));
    return re.test(normalized) || (!g.includes("/") && re.test(normalized.split("/").pop() ?? ""));
  });
}

const bump = (counts: MaskCounts, label: string): void => {
  counts[label] = (counts[label] ?? 0) + 1;
};

function replaceAll(text: string, re: RegExp, label: string, counts: MaskCounts, keep?: (match: string) => boolean): string {
  re.lastIndex = 0;
  return text.replace(re, (match: string) => {
    // A pattern that matches an empty text or a placeholder changes nothing.
    if (match === "" || /^\[MASKED:[^\]]*\]$/.test(match) || (keep && keep(match))) return match;
    bump(counts, label);
    return `[MASKED:${label}]`;
  });
}

export function maskText(text: string, counts: MaskCounts, rules: MaskRules = defaultMaskRules()): string {
  // Secrets first and always.
  let out = text.replace(PRIVATE_KEY, () => {
    bump(counts, "secret");
    return "[MASKED:private-key]";
  });
  out = out.replace(SECRET_ASSIGNMENT, (_m, name: string) => {
    bump(counts, "secret");
    return `${name}[MASKED:secret]`;
  });
  // The project's patterns, then the entities (e-mail before the digit shapes, which could cut an address).
  for (const p of rules.patterns) out = replaceAll(out, p.regex, p.label, counts);
  const on = rules.entities;
  if (on.email) out = replaceAll(out, EMAIL, "email", counts);
  if (on["ip-address"]) {
    out = replaceAll(out, IPV4, "ip-address", counts);
    out = replaceAll(out, IPV6, "ip-address", counts, (m) => !/\d/.test(m));
  }
  if (on.cnpj) out = replaceAll(out, CNPJ, "cnpj", counts);
  if (on["credit-card"]) out = replaceAll(out, CARD, "credit-card", counts);
  if (on.cpf) out = replaceAll(out, CPF, "cpf", counts);
  if (on.phone) out = replaceAll(out, PHONE, "phone", counts);
  return out;
}

/** Masks every string of a structure (the review context) without changing its shape. */
export function maskDeep<T>(value: T, counts: MaskCounts, rules: MaskRules = defaultMaskRules()): T {
  if (typeof value === "string") return maskText(value, counts, rules) as T;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, counts, rules)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskDeep(v, counts, rules);
    return out as T;
  }
  return value;
}
