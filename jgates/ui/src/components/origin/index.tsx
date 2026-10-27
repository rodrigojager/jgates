import { useState } from "react";
import { api } from "../../api";
import { t, tOr } from "../../i18n";
import { Dialog, ErrorNotice, Loading, Pill, useAsync } from "../common";
import { Icon } from "../icons";
import "./origin.css";

// "Origem dos valores": answers "por que isso está ativado?" and "onde editar?" with the chain of layers (defaults,
// templates, profile, project, call) and the file and field of each one. The data is what the server takes from
// `jgates config resolve --explain` (GET /api/config/explain), so the screen and the CLI show the same chain.
// Other configuration screens reuse it: <OriginButton selector="..." /> for a check, <OriginChain field={...} /> when
// they already hold a resolved field, <OriginLine origin={...} /> for the short line under a control.
// The catalog keys (origin_*) live in screens/config-profiles/messages.pt-BR.json; keys are global.

export interface OriginRef {
  layer: string;
  source: string;
  file: string | null;
  path: string | null;
}

export interface OriginWrite extends OriginRef {
  value: unknown;
  op?: string;
}

/** A resolved field as `config resolve --explain --json` gives it (fields[pointer]). */
export interface ResolvedFieldView extends OriginRef {
  pointer: string;
  value: unknown;
  previous?: OriginRef & { value: unknown };
  history: OriginWrite[];
}

export interface SaveTarget {
  file: string;
  path: string;
}

const layerLabel = (layer: string): string => tOr(`origin_layer_${layer}`, layer);

export const showValue = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/** Where a value is written: the file and the field, as text that can be copied. */
export function Place({ file, path }: { file: string | null; path: string | null }) {
  if (!file) return <span className="muted">{t("origin_no_file")}</span>;
  return (
    <span className="origin-place">
      <code>{file}</code>
      {path ? (
        <>
          {" "}
          <span className="muted">{t("origin_field")}</span> <code>{path}</code>
        </>
      ) : null}
    </span>
  );
}

/** The short line under a control: which layer decided and where the control writes. */
export function OriginLine({ origin, saveTo, fallback }: { origin: OriginRef | null; saveTo?: SaveTarget | null; fallback?: string }) {
  return (
    <p className="small origin-line">
      <span data-testid="origin-source">
        {origin ? t("origin_line", { layer: layerLabel(origin.layer), source: origin.source }) : (fallback ?? t("origin_none"))}
      </span>
      {saveTo ? (
        <span data-testid="origin-save">
          {" "}
          {t("origin_saved_in")} <code>{saveTo.file}</code>
        </span>
      ) : null}
    </p>
  );
}

/** The chain of layers of one field, strongest first; the one that decides is marked. */
export function OriginChain({ field }: { field: ResolvedFieldView }) {
  const writes = [...field.history].reverse();
  return (
    <ol className="origin-chain" data-testid="origin-chain" aria-label={t("origin_chain_label")}>
      {writes.map((w, index) => (
        <li key={`${w.source}:${w.path ?? ""}:${index}`} className={index === 0 ? "wins" : ""} data-layer={w.layer} data-source={w.source}>
          <div className="row wrap">
            <strong>{layerLabel(w.layer)}</strong>
            <span className="muted">{w.source}</span>
            {index === 0 ? <Pill tone="green">{t("origin_wins")}</Pill> : <span className="small muted">{t("origin_replaced")}</span>}
          </div>
          <dl className="kv">
            <dt>{t("origin_value")}</dt>
            <dd>
              <code data-testid="origin-value">{showValue(w.value)}</code>
            </dd>
            <dt>{t("origin_file")}</dt>
            <dd>
              <code data-testid="origin-file">{w.file ?? t("origin_no_file")}</code>
            </dd>
            {w.path ? (
              <>
                <dt>{t("origin_field")}</dt>
                <dd>
                  <code data-testid="origin-path">{w.path}</code>
                </dd>
              </>
            ) : null}
          </dl>
        </li>
      ))}
    </ol>
  );
}

/** Dialog that loads the explanation of a check and shows why it is on or off and where to edit it. */
export function OriginDialog({ selector, profile, title, onClose }: { selector: string; profile?: string; title?: string; onClose: () => void }) {
  const query = `selector=${encodeURIComponent(selector)}${profile ? `&profile=${encodeURIComponent(profile)}` : ""}`;
  const explain = useAsync(() => api("GET", `/api/config/explain?${query}`), `explain:${query}`);
  const d = explain.data as any;
  return (
    <Dialog title={title ?? t("origin_title", { selector })} onClose={onClose} wide>
      {explain.loading ? <Loading /> : null}
      {explain.error ? <ErrorNotice error={explain.error} /> : null}
      {d ? (
        <div className="stack" data-testid="origin-dialog">
          <p data-testid="origin-verdict">
            <strong>{d.enabled ? t("origin_is_on") : t("origin_is_off")}</strong> {t(`origin_reason_${d.reason}`)}
          </p>
          {(d.locked as any[]).map((l) => (
            <div className="notice warn" key={l.selector} role="status" data-testid="origin-locked">
              <Icon name="lock" />
              <div>
                <strong>{t("origin_locked")}</strong>
                <p>{l.reason}</p>
                <p className="small">
                  <Place file={l.file} path={l.path} />
                </p>
              </div>
            </div>
          ))}
          {d.field ? <OriginChain field={d.field} /> : <p className="muted">{t("origin_no_chain")}</p>}
          {d.overridden.length > 0 ? (
            <section aria-labelledby="origin-overridden">
              <h3 id="origin-overridden">{t("origin_overridden")}</h3>
              <ul className="origin-overridden">
                {(d.overridden as any[]).map((o, i) => (
                  <li key={i}>
                    <code>{o.selector}</code> = <code>{showValue(o.value)}</code> ({layerLabel(o.layer)}, {o.source}) <Place file={o.file} path={o.path} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="origin-where">
            <h3 id="origin-where">{t("origin_where")}</h3>
            {d.saveTo ? (
              <p data-testid="origin-where">
                <Place file={d.saveTo.file} path={d.saveTo.path} />
              </p>
            ) : (
              <p className="muted">{t("origin_where_readonly")}</p>
            )}
          </section>
        </div>
      ) : null}
    </Dialog>
  );
}

/** "Por que isso está ativado?" button that opens the dialog. */
export function OriginButton({ selector, profile, label }: { selector: string; profile?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn origin-btn" aria-label={t("origin_why_for", { name: label ?? selector })} onClick={() => setOpen(true)}>
        <Icon name="info" />
        {t("origin_why")}
      </button>
      {open ? <OriginDialog selector={selector} {...(profile ? { profile } : {})} {...(label ? { title: t("origin_title", { selector: label }) } : {})} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
