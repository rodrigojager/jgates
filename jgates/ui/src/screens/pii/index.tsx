import { useState } from "react";
import { ApiError, api } from "../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import type { ScreenMeta } from "../../registry";
import { tp, tpOr } from "./messages";

// Configuration, Tools, PII: one row per entity, each saved by patch into .jgates/pii.yml (route /api/pii).
// It takes the place of the generic file area for the builtin-pii instance (static route before ":instance").
export const screen: ScreenMeta = { id: "pii", path: "/tools/builtin-pii", order: 15 };

interface Edit {
  op: "set" | "delete";
  path: string[];
  value?: string | boolean;
}

export default function PiiScreen() {
  const loaded = useAsync(() => api("GET", "/api/pii"), "pii");
  const [override, setOverride] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);

  if (loaded.loading) return <Loading />;
  if (loaded.error) return <ErrorNotice error={loaded.error} onRetry={loaded.reload} />;
  const data = (override ?? loaded.data) as any;

  async function save(edits: Edit[]) {
    setBusy(true);
    setProblem(null);
    setSaved(null);
    setConflict(false);
    try {
      const next = await api("PUT", "/api/pii", { expectedRevision: data.revision, edits });
      setOverride(next);
      setSaved(tp("pii_saved", { file: next.file }));
    } catch (error) {
      if (error instanceof ApiError && error.code === "REVISION_CONFLICT") setConflict(true);
      else setProblem(error);
    } finally {
      setBusy(false);
    }
  }

  const name = (id: string) => tpOr(`pii_entity_${id}`, id);
  const entities: any[] = data.entities ?? [];

  return (
    <div className="stack">
      <div className="stack">
        <a href="#/tools">{tp("pii_back")}</a>
        <h1>{tp("pii_title")}</h1>
        <p>{tp("pii_lead")}</p>
        <p className="small muted">{data.exists ? tp("pii_file", { file: data.file }) : tp("pii_file_new")}</p>
      </div>
      {data.valid === false ? (
        <div className="notice warn" role="status">
          <Icon name="alert" />
          <p>{tp("pii_invalid_file")}</p>
        </div>
      ) : null}
      {conflict ? (
        <div className="notice warn" role="alert">
          <Icon name="alert" />
          <div className="grow stack">
            <p>{tp("pii_conflict")}</p>
            <div>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setOverride(null);
                  setConflict(false);
                  loaded.reload();
                }}
              >
                <Icon name="refresh" />
                {tp("pii_reload")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {problem ? <ErrorNotice error={problem} /> : null}
      <div className="notice ok" role="status" data-testid="pii-status">
        {busy ? (
          <p>{tp("pii_saving")}</p>
        ) : saved ? (
          <>
            <Icon name="check" />
            <p>{saved}</p>
          </>
        ) : (
          <p className="muted">{data.exists ? String(data.revision).slice(0, 12) : ""}</p>
        )}
      </div>

      <section className="stack" aria-labelledby="pii-entities">
        <h2 id="pii-entities">{tp("pii_entities_title")}</h2>
        <div className="card flat table-wrap">
          <table aria-label={tp("pii_entities_label")}>
            <thead>
              <tr>
                <th scope="col">{tp("pii_col_entity")}</th>
                <th scope="col">{tp("pii_col_run")}</th>
                <th scope="col">{tp("pii_col_severity")}</th>
                <th scope="col">{tp("pii_col_state")}</th>
              </tr>
            </thead>
            <tbody>
              {entities.map((e) =>
                e.supported ? (
                  <tr key={e.id} data-entity={e.id}>
                    <th scope="row">{name(e.id)}</th>
                    <td>
                      <input
                        type="checkbox"
                        checked={e.enabled}
                        disabled={busy}
                        aria-label={tp("pii_switch", { entity: name(e.id) })}
                        onChange={(ev) => void save([{ op: "set", path: ["entities", e.id, "enabled"], value: ev.target.checked }])}
                      />
                    </td>
                    <td>
                      <select
                        value={e.severity}
                        disabled={busy}
                        aria-label={tp("pii_severity_of", { entity: name(e.id) })}
                        onChange={(ev) => void save([{ op: "set", path: ["entities", e.id, "severity"], value: ev.target.value }])}
                      >
                        {(data.supported?.severities ?? []).map((s: string) => (
                          <option key={s} value={s}>
                            {tpOr(`pii_severity_${s}`, s)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <div className="row">
                        <Pill tone={e.enabled ? "green" : "gold"}>{e.enabled ? tp("pii_state_on") : tp("pii_state_off")}</Pill>
                        <span className="small muted">{e.source ? tp("pii_state_by", { source: e.source.file ?? e.source.source }) : tp("pii_state_default")}</span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={e.id} data-entity={e.id}>
                    <th scope="row">{name(e.id)}</th>
                    <td colSpan={3}>
                      <Pill tone="red">{tp("pii_unsupported")}</Pill> <span className="small muted">{tp("pii_unsupported_hint")}</span>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack" aria-labelledby="pii-detection">
        <h2 id="pii-detection">{tp("pii_detection_title")}</h2>
        <div className="card flat stack">
          <label className="stack">
            <span>{tp("pii_locale")}</span>
            <select value={data.detection.locale} disabled={busy} onChange={(ev) => void save([{ op: "set", path: ["detection", "locale"], value: ev.target.value }])}>
              {(data.supported?.locales ?? []).map((l: string) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
              <option value="en-US" disabled>
                {tp("pii_locale_unavailable", { locale: "en-US" })}
              </option>
            </select>
            <span className="small muted">{tp("pii_locale_hint")}</span>
          </label>
          <label className="stack">
            <span className="row">
              <input
                type="checkbox"
                checked={data.detection.validateCheckDigits}
                disabled={busy}
                onChange={(ev) => void save([{ op: "set", path: ["detection", "validateCheckDigits"], value: ev.target.checked }])}
              />
              {tp("pii_check_digits")}
            </span>
            <span className="small muted">{tp("pii_check_digits_hint")}</span>
          </label>
        </div>
      </section>

      <section className="stack" aria-labelledby="pii-reporting">
        <h2 id="pii-reporting">{tp("pii_reporting_title")}</h2>
        <div className="card flat">
          <label className="stack">
            <span className="row">
              <input type="checkbox" checked={data.reporting.redactMatchedValues} disabled aria-describedby="pii-redact-hint" />
              {tp("pii_redact")}
            </span>
            <span id="pii-redact-hint" className="small muted">
              {tp("pii_redact_hint")}
            </span>
          </label>
        </div>
      </section>

      <section className="stack" aria-labelledby="pii-remediation">
        <h2 id="pii-remediation">{tp("pii_remediation_title")}</h2>
        <div className="card flat">
          <label className="stack">
            <span>{tp("pii_remediation")}</span>
            <select value={data.remediation.mode} disabled aria-describedby="pii-remediation-hint">
              <option value="none">{tp("pii_remediation_none")}</option>
              <option value="apply" disabled>
                {tp("pii_remediation_apply")}
              </option>
            </select>
            <span id="pii-remediation-hint" className="small muted">
              {tp("pii_remediation_hint")}
            </span>
          </label>
        </div>
      </section>
    </div>
  );
}
