import { useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { OriginLine, type OriginRef, type SaveTarget } from "../../components/origin";
import { useToast } from "../../components/Toast";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { Switch } from "../config-profiles/switch";
import "./config-architecture.css";

// Configuração > Arquitetura. The map drawn from .jgates/architecture.yml, the rules with toggle and "Bloqueia", the
// adapters that verify each rule, the dependencies the last run could not resolve and the generated native
// configuration (read only).
export const screen: ScreenMeta = { id: "config-architecture", path: "/config/architecture", area: "config", navLabel: "cfa_nav", navPath: "/config/architecture", order: 42, icon: "branch" };

interface Layer {
  id: string;
  label: string;
  paths: string[];
  modules: string[];
  component: string | null;
}

interface Rule {
  id: string;
  kind: string;
  enabled: boolean;
  blocking: boolean;
  severity: string | null;
  owner: string;
  message: string | null;
  from?: string | null;
  to?: string[];
  component?: string | null;
  allowed?: string[];
  within?: string | null;
  layer?: string | null;
  maxFanIn?: number | null;
  maxFanOut?: number | null;
  saveTo: SaveTarget;
  origin: OriginRef;
  coverage: { covered: boolean; by: string[]; available: string[] };
}

interface Evidence {
  runId: string | null;
  startedAt?: string | null;
  coverage: Array<{ tool: string; status: string | null; extractor: string | null; nodes: number; edges: number; unresolved: number; sample: Array<{ from?: string; specifier?: string; reason?: string }>; reasons: string[] }>;
  generated: Array<{ tool: string; file: string; format: string; text: string; truncated: boolean }>;
}

interface View {
  mode: "local" | "governed";
  governed: { policy: string } | null;
  file: string;
  exists: boolean;
  revision: string | null;
  valid: boolean;
  problems: Array<{ code: string; path: string; message: string; line?: number }>;
  layers: Layer[];
  rules: Rule[];
  tools: Array<{ id: string; component: string | null; enabled: boolean }>;
  evidence: Evidence;
}

function ruleText(rule: Rule): string {
  switch (rule.kind) {
    case "forbidden-dependency":
      return t("cfa_rule_forbidden", { from: rule.from ?? "?", to: (rule.to ?? []).join(", ") });
    case "component-boundary":
      return t("cfa_rule_boundary", { component: rule.component ?? "?", allowed: (rule.allowed ?? []).join(", ") || t("cfa_rule_nothing") });
    case "no-cycles":
      return rule.within ? t("cfa_rule_cycles_in", { within: rule.within }) : t("cfa_rule_cycles");
    default:
      return t("cfa_rule_fan", { layer: rule.layer ?? t("cfa_rule_all"), fanIn: rule.maxFanIn ?? "-", fanOut: rule.maxFanOut ?? "-" });
  }
}

function Arrow({ blocked }: { blocked: boolean }) {
  return (
    <svg className={`arch-arrow${blocked ? " blocked" : ""}`} viewBox="0 0 48 16" width="48" height="16" role="img" aria-label={blocked ? t("cfa_arrow_blocked") : t("cfa_arrow_allowed")}>
      <line x1="2" y1="8" x2="38" y2="8" stroke="currentColor" strokeWidth="1.7" strokeDasharray={blocked ? "4 3" : undefined} />
      {blocked ? <path d="M18 3l8 10M26 3l-8 10" stroke="currentColor" strokeWidth="1.7" fill="none" /> : <path d="M36 3l8 5-8 5" stroke="currentColor" strokeWidth="1.7" fill="none" />}
    </svg>
  );
}

function LayerMap({ layers, rules }: { layers: Layer[]; rules: Rule[] }) {
  const forbidden = rules.filter((r) => r.kind === "forbidden-dependency" && r.enabled);
  const isBlocked = (a: string, b: string): boolean => forbidden.some((r) => (r.from === a && (r.to ?? []).includes(b)) || (r.from === b && (r.to ?? []).includes(a)));
  if (layers.length === 0) return <p className="small muted">{t("cfa_map_empty")}</p>;
  return (
    <div className="arch-map" data-testid="arch-map">
      {layers.map((layer, i) => (
        <div className="arch-step" key={layer.id}>
          <div className="arch-layer" data-layer={layer.id}>
            <strong>{layer.label}</strong>
            <code className="small">{[...layer.paths, ...layer.modules].join(", ")}</code>
          </div>
          {i < layers.length - 1 ? <Arrow blocked={isBlocked(layer.id, (layers[i + 1] as Layer).id)} /> : null}
        </div>
      ))}
    </div>
  );
}

export default function ConfigArchitectureScreen() {
  const toast = useToast();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const view = useAsync<View>(() => api("GET", "/api/config/architecture"), `architecture:${revision}`);

  if (view.error) return <ErrorNotice error={view.error} onRetry={view.reload} />;
  if (!view.data) return <Loading />;
  const v = view.data;
  const governedReason = v.mode === "governed" ? t("cfa_governed_reason", { policy: v.governed?.policy ?? "" }) : null;

  const toggle = async (rule: Rule, enabled: boolean) => {
    setBusy(rule.id);
    setError(null);
    try {
      await api("PUT", `/api/config/architecture/rules/${encodeURIComponent(rule.id)}`, { enabled, expectedRevision: v.revision });
      toast(t(enabled ? "cfa_rule_on" : "cfa_rule_off", { id: rule.id }), "ok");
      setRevision((n) => n + 1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <div className="between wrap">
        <div>
          <h1>{t("cfa_title")}</h1>
          <p>{t("cfa_lead")}</p>
        </div>
        <a className="btn" href="#/config/yaml" data-testid="edit-yaml">
          {t("cfa_edit_yaml")}
        </a>
      </div>
      {governedReason ? (
        <div className="notice warn" role="status" data-testid="governed-note">
          <Icon name="lock" />
          <p className="small">{governedReason}</p>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}

      {!v.exists ? (
        <div className="notice" role="status">
          <Icon name="info" />
          <p>{t("cfa_missing", { file: v.file })}</p>
        </div>
      ) : null}
      {v.problems.length > 0 ? (
        <div className="notice error" role="alert" data-testid="arch-problems">
          <Icon name="alert" />
          <div>
            <strong>{t("cfa_invalid", { file: v.file })}</strong>
            <ul>
              {v.problems.map((p, i) => (
                <li key={i}>
                  <code>{p.path || "-"}</code> {p.message}
                  {p.line ? <span className="small muted"> {t("cfa_line", { line: p.line })}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <section className="card pad stack" aria-labelledby="cfa-map-title">
        <h2 id="cfa-map-title">{t("cfa_map_title")}</h2>
        <p className="small muted">{t("cfa_map_lead")}</p>
        <LayerMap layers={v.layers} rules={v.rules} />
        <p className="small muted">
          {t("cfa_source")} <code>{v.file}</code>
        </p>
      </section>

      <section className="stack" aria-labelledby="cfa-rules-title">
        <h2 id="cfa-rules-title">{t("cfa_rules_title")}</h2>
        {v.rules.length === 0 && v.exists && v.problems.length === 0 ? <p className="small muted">{t("cfa_rules_none")}</p> : null}
        <ul className="arch-rules" data-testid="arch-rules">
          {v.rules.map((rule) => (
            <li key={rule.id} className="card pad" data-rule={rule.id} data-enabled={rule.enabled}>
              <div className="between wrap">
                <div className="stack tight">
                  <div className="row wrap">
                    <h3>{rule.id}</h3>
                    <Pill>{tOr(`cfa_kind_${rule.kind}`, rule.kind)}</Pill>
                    {rule.blocking ? <Pill tone="red">{t("cfa_blocks")}</Pill> : <Pill>{t("cfa_warns")}</Pill>}
                    <Pill tone={rule.owner === "generated" ? "blue" : undefined}>{t(rule.owner === "generated" ? "cfa_owner_generated" : "cfa_owner_source")}</Pill>
                    {!rule.enabled ? <Pill>{t("cfa_disabled")}</Pill> : null}
                  </div>
                  <p>{rule.message ?? ruleText(rule)}</p>
                  <p className="small" data-testid="rule-coverage">
                    {!rule.enabled
                      ? t("cfa_cov_disabled")
                      : rule.coverage.covered
                        ? t("cfa_cov_by", { tools: rule.coverage.by.join(", ") })
                        : rule.coverage.available.length > 0
                          ? t("cfa_cov_off", { tools: rule.coverage.available.join(", ") })
                          : t("cfa_cov_none")}
                  </p>
                  <OriginLine origin={rule.origin} saveTo={rule.saveTo} />
                </div>
                <div className="stack tight arch-switch">
                  <Switch checked={rule.enabled} label={t("cfa_toggle_aria", { id: rule.id })} disabled={governedReason !== null || busy === rule.id} onChange={(next) => toggle(rule, next)} testId={`toggle-${rule.id}`} />
                  {governedReason ? <span className="small muted">{governedReason}</span> : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card pad stack" aria-labelledby="cfa-unres-title" data-testid="arch-evidence">
        <h2 id="cfa-unres-title">{t("cfa_unresolved_title")}</h2>
        {v.evidence.runId === null ? (
          <p className="small muted">{t("cfa_unresolved_none")}</p>
        ) : (
          <>
            <p className="small muted">{t("cfa_unresolved_run", { run: v.evidence.runId })}</p>
            {v.evidence.coverage.map((c) => (
              <div key={c.tool} className="stack tight" data-coverage={c.tool}>
                <p>
                  <strong>{c.tool}</strong> {t("cfa_cov_graph", { status: tOr(`cfa_graph_${c.status}`, c.status ?? "?"), nodes: c.nodes, edges: c.edges, unresolved: c.unresolved })}
                </p>
                {c.sample.length > 0 ? (
                  <ul className="small">
                    {c.sample.map((s, i) => (
                      <li key={i}>
                        <code>{s.from}</code> {t("cfa_imports")} <code>{s.specifier}</code>
                        {s.reason ? <span className="muted"> ({s.reason})</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </>
        )}
      </section>

      <section className="card pad stack" aria-labelledby="cfa-gen-title">
        <h2 id="cfa-gen-title">{t("cfa_generated_title")}</h2>
        <p className="small muted">{t("cfa_generated_lead")}</p>
        {v.evidence.generated.length === 0 ? <p className="small muted">{t("cfa_generated_none")}</p> : null}
        {v.evidence.generated.map((g) => (
          <details key={g.tool}>
            <summary>
              {g.tool} <code className="small">{g.file}</code> <Pill>{t("cfa_read_only")}</Pill>
            </summary>
            <pre className="arch-native" tabIndex={0} aria-label={t("cfa_generated_label", { tool: g.tool })}>
              {g.text}
            </pre>
          </details>
        ))}
      </section>
    </div>
  );
}
