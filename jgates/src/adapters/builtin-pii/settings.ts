// Effective settings of the builtin-pii detector: the resolved `pii` section of the configuration plus the selection
// of each entity (selector pii:<entity>) become the configuration document the sidecar reads (config_from_dict).
// The selection decides whether an entity runs only when a pii:<entity> selector decided; a broader selector
// (capability:pii, a profile) turns the detector on and leaves each entity at its own default, so a new entity such as
// phone never starts running by itself.
import type { SelectionResult } from "../../core/selection/index.js";

/** Entities the built-in detector has a tested rule for, with the defaults that keep today's behavior. */
export const SUPPORTED_ENTITIES = ["cpf", "cnpj", "phone", "credit-card"] as const;
export const DEFAULT_ENABLED: Record<string, boolean> = { cpf: true, cnpj: true, phone: false, "credit-card": true };
export const DEFAULT_SEVERITY: Record<string, string> = { cpf: "medium", cnpj: "medium", phone: "medium", "credit-card": "high" };
/** Entities the product names but no detector exists for: shown as "not supported", never as a switch. */
export const UNSUPPORTED_ENTITIES = ["email", "ip-address", "person-name"] as const;
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export interface EntityState {
  id: string;
  enabled: boolean;
  severity: string;
  /** "selector": a pii:<entity> decision; "default": the entity's own default. */
  decidedBy: "selector" | "default";
  /** Where the deciding selector came from (layer and source), when a selector decided. */
  source: { layer: string; source: string; file: string | null } | null;
}

/** The state of every supported entity under one resolved configuration and its selection. */
export function entityStates(config: Rec | undefined, selection: SelectionResult | undefined): EntityState[] {
  const pii = isRec(config?.pii) ? config.pii : {};
  const entities = isRec(pii.entities) ? pii.entities : {};
  const top = typeof pii.severity === "string" ? pii.severity : null;
  return SUPPORTED_ENTITIES.map((id): EntityState => {
    const own = isRec(entities[id]) ? entities[id] : {};
    const item = selection?.items.find((i) => i.kind === "pii" && i.id === id);
    const decided = item?.decision && item.decision.selector === `pii:${id}` ? item : null;
    const severity = typeof own.severity === "string" ? own.severity : (top ?? (DEFAULT_SEVERITY[id] as string));
    return {
      id,
      enabled: decided ? decided.enabled : (DEFAULT_ENABLED[id] as boolean),
      severity,
      decidedBy: decided ? "selector" : "default",
      source: decided?.decision ? { layer: decided.decision.layer, source: decided.decision.source, file: decided.decision.file } : null,
    };
  });
}

/** The `config` of the bridge request: complete and explicit, so the plan shows exactly what runs. */
export function bridgeConfig(config: Rec | undefined, selection: SelectionResult | undefined): Rec {
  const pii = isRec(config?.pii) ? config.pii : {};
  const out: Rec = {
    schemaVersion: 1,
    entities: Object.fromEntries(entityStates(config, selection).map((e) => [e.id, { enabled: e.enabled, severity: e.severity }])),
  };
  // Options are passed through as written: an unsupported one is refused by the sidecar (never dropped).
  for (const key of ["detection", "reporting", "remediation"] as const) if (isRec(pii[key])) out[key] = pii[key];
  return out;
}
