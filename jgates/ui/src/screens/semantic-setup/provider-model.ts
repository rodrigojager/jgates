// The data of the provider step of the Semantic area: what GET /api/providers/cli-status says about the agent CLIs
// (installed, logged in, models), what GET /api/semantic says about the project's saved provider, and the helpers that
// turn them into the state of a card (ready, needs login, not installed...). Nothing here reads or keeps a credential.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { PROVIDER_BLOCKER_CODES, PROVIDER_STEP_ROUTE } from "../../components/ProviderFixLink";
import { t, tOr } from "../../i18n";
import type { ProviderEntry, SecretView } from "../providers/model";

export type LoginState = "logged-in" | "not-logged-in" | "unknown";

export interface CliModels {
  source: "cli" | "suggested" | "none";
  list: string[];
  truncated: boolean;
  configured: string | null;
  configuredIn: string | null;
  suggestedDefault: string | null;
  problem: "TIMEOUT" | "COMMAND_FAILED" | "UNRECOGNIZED_OUTPUT" | null;
}

export interface CliProvider {
  id: string;
  name: string;
  command: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  login: { state: LoginState; reason: string; method: string | null; checkedWith: string | null };
  models: CliModels | null;
  loginCommand: { command: string; args: string[]; display: string };
  install: string;
  /** ISO time this CLI was detected. */
  checkedAt?: string;
}

export interface CliStatus {
  checkedAt: string;
  timeoutMs: number;
  providers: CliProvider[];
}

type Origin = "project" | "user" | "default" | "unset";

/** GET /api/semantic (the parts the provider step reads). */
export interface SemanticInfo {
  state: "off" | "configured" | "invalid";
  provider: string | null;
  model: string | null;
  problems: string[];
  effective: { kind: string; model: { value: string | null; origin: Origin } } | null;
  configFile: string;
  configKey: string;
  form: {
    revision: string | null;
    editable: boolean;
    available: boolean;
    unavailable: { code: string; message: string } | null;
    locked: { reason: "governed"; policy: string } | null;
    file: string;
    fields?: Array<{ id: string; state: "set" | "inherited" | "unrecognized"; value?: unknown }>;
  };
}

/** The CLI providers in the order the cards show them. */
export const CLI_IDS = ["claude-code", "codex-cli", "opencode", "gemini-cli"] as const;
const CLI_NAMES: Record<string, string> = { "claude-code": "Claude Code", "codex-cli": "Codex CLI", opencode: "OpenCode", "gemini-cli": "Gemini CLI" };

/** The name a person reads for a provider id (a CLI, an API provider) or a connection name (shown as it is). */
export function providerLabel(id: string): string {
  return CLI_NAMES[id] ?? tOr(`semprov_name_${id}`, id);
}

export const isCli = (id: string | null): boolean => id !== null && (CLI_IDS as readonly string[]).includes(id);

type SummaryInfo = Pick<SemanticInfo, "provider" | "model" | "effective" | "form">;

/**
 * The model written in the project's jgates.yml, or null. (`model` of GET /api/semantic is the model in effect, which
 * may come from the user's defaults; the form says what the file itself holds.)
 */
export function projectModel(info: Pick<SemanticInfo, "form">): string | null {
  const field = info.form.fields?.find((f) => f.id === "model");
  return field && field.state === "set" && typeof field.value === "string" ? field.value : null;
}

/** "Provedor: Codex CLI · modelo gpt-5": the summary of a saved choice. */
export function providerSummary(info: SummaryInfo): string {
  return info.provider ? t("semprov_summary", { choice: providerChoice(info) }) : t("semprov_none");
}

/** "Codex CLI · modelo gpt-5" / "· modelo gpt-5 (seu padrão)" / "· modelo padrão do CLI" (empty when there is none). */
export function providerChoice(info: SummaryInfo): string {
  if (!info.provider) return "";
  const own = projectModel(info);
  const effective = info.effective?.model.value ?? info.model ?? null;
  const modelText = own
    ? t("semprov_model", { model: own })
    : effective && info.effective?.model.origin === "user"
      ? t("semprov_model_user", { model: effective })
      : effective
        ? t("semprov_model", { model: effective })
        : isCli(info.provider)
          ? t("semprov_model_cli_default")
          : t("semprov_model_none");
  return t("semprov_choice", { provider: providerLabel(info.provider), model: modelText });
}

/** What a card says about its provider, and whether a project can be saved with it now. */
export type Readiness = "ready" | "login" | "unknown" | "missing" | "checking" | "key" | "setup" | "local";

export function cliReadiness(cli: CliProvider | undefined): Readiness {
  if (!cli) return "checking";
  if (!cli.installed) return "missing";
  if (cli.login.state === "logged-in") return "ready";
  if (cli.login.state === "not-logged-in") return "login";
  return "unknown";
}

export function apiReadiness(entry: ProviderEntry, secret: SecretView | undefined): Readiness {
  if (entry.fields.includes("baseUrl") && !entry.baseUrl.value) return "setup";
  if (!entry.key) return "local";
  const set = secret ? secret.state === "set" : entry.key.state === "set";
  return set ? "ready" : "key";
}

/** A provider the project can be saved with: ready, or a login the CLI cannot confirm (gemini has no status command). */
export const savable = (r: Readiness): boolean => r === "ready" || r === "unknown" || r === "local";

/**
 * The CLI status, asked once per mount from the server's detection cache. `recheck(id)` asks again for one CLI (after
 * its login, or "Verificar de novo") and `recheck()` for all of them ("Detectar de novo"), both ignoring the cache.
 */
export function useCliStatus(): { data: CliStatus | null; error: unknown; modelsLoading: boolean; checking: Set<string>; recheck: (id?: string) => Promise<void> } {
  const [data, setData] = useState<CliStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const alive = useRef(true);

  const merge = useCallback((next: CliStatus, keepModels: boolean) => {
    setData((prev) => {
      if (!prev) return next;
      const byId = new Map(next.providers.map((p) => [p.id, p]));
      return {
        ...next,
        providers: prev.providers.map((p) => {
          const fresh = byId.get(p.id);
          if (!fresh) return p;
          return keepModels && fresh.models === null ? { ...fresh, models: p.models } : fresh;
        }),
      };
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        // One request per mount: the server answers from its detection cache (no CLI starts when it is warm) and
        // detects once, with the model listings, when it is cold.
        const full = await api<CliStatus>("GET", "/api/providers/cli-status?models=1");
        if (!alive.current) return;
        merge(full, false);
      } catch (e) {
        if (alive.current) setError(e);
      } finally {
        if (alive.current) setModelsLoading(false);
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [merge]);

  const recheck = useCallback(
    async (id?: string) => {
      const ids = id ? [id] : [...CLI_IDS];
      setChecking((s) => new Set([...s, ...ids]));
      try {
        const answer = await api<CliStatus>("GET", `/api/providers/cli-status?models=1&refresh=1${id ? `&only=${encodeURIComponent(id)}` : ""}`);
        if (alive.current) {
          setError(null);
          merge(answer, true);
        }
      } catch (e) {
        if (alive.current) setError(e);
      } finally {
        if (alive.current) setChecking((s) => new Set([...s].filter((x) => !ids.includes(x))));
      }
    },
    [merge],
  );

  return { data, error, modelsLoading, checking, recheck };
}

/** GET /api/semantic, reloadable; `replace` takes the view a save answered with. */
export function useSemanticInfo(): { data: SemanticInfo | null; error: unknown; reload: () => void; replace: (next: SemanticInfo) => void } {
  const [data, setData] = useState<SemanticInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api<SemanticInfo>("GET", "/api/semantic").then(
      (d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      },
      (e) => {
        if (live) setError(e);
      },
    );
    return () => {
      live = false;
    };
  }, [tick]);
  return { data, error, reload: () => setTick((n) => n + 1), replace: setData };
}

/** The route of the provider step: every "no provider" message links here. */
export const PROVIDER_STEP_HREF = PROVIDER_STEP_ROUTE;
/** Blocker codes the provider step resolves. */
export const PROVIDER_BLOCKERS = PROVIDER_BLOCKER_CODES;
