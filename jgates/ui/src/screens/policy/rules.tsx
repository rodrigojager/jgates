import { useState } from "react";
import { ApiError, api } from "../../api";
import { ErrorNotice, Loading, Pill, Spinner, Updating, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { DerivedFormView } from "../../forms/derived/DerivedForm";
import { loadForm } from "../../forms/derived/api";
import { useKeyEditor } from "../../forms/derived/editor";
import type { DerivedFormData } from "../../forms/derived/types";
import { t } from "../../i18n";

const POLICY_FILE = ".jgates/policy.yml";

/**
 * The policy file of this project as a form (rules, required evidence, exceptions), derived from its schema and written
 * one key at a time. A missing file is created from its template on request. Under a governed policy (the policy comes
 * from a folder outside the repository) the values are shown and nothing writes: the screen says whose policy it is.
 */
export function ProjectPolicyRules({ governed }: { governed: { policy: string } | null }) {
  const toast = useToast();
  const loaded = useAsync<DerivedFormData | null>(
    () =>
      loadForm({ file: POLICY_FILE }).catch((error) => {
        if (error instanceof ApiError && error.code === "FILE_MISSING") return null;
        throw error;
      }),
    "policy-rules-form",
  );
  const editor = useKeyEditor(loaded.reload);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const readOnly = governed !== null;
  const missing = !loaded.loading && !loaded.error && (loaded.data === null || loaded.data.file.exists === false);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      await api("POST", "/api/config/yaml/create", { file: POLICY_FILE });
      toast(t("pol_rules_created", { file: POLICY_FILE }), "ok");
      loaded.reload();
    } catch (e) {
      setError(e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="card flat stack" aria-labelledby="pol-rules-title" data-testid="policy-rules" data-mode={readOnly ? "governed" : "local"}>
      <div className="row between wrap">
        <h2 id="pol-rules-title">{t("pol_rules_title")}</h2>
        {readOnly ? <Pill tone="gold">{t("pol_rules_readonly_pill")}</Pill> : null}
      </div>
      <p className="small">{t("pol_rules_lead", { file: POLICY_FILE })}</p>
      {readOnly ? (
        <div className="notice warn" role="status" data-testid="policy-readonly">
          <Icon name="lock" />
          <span>{t("pol_rules_governed", { policy: governed.policy })}</span>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      {loaded.loading && !loaded.data ? <Loading /> : null}
      {loaded.error && !loaded.data ? <ErrorNotice error={loaded.error} onRetry={loaded.reload} /> : null}
      {missing && !loaded.loading ? (
        <div className="stack" data-testid="policy-missing">
          <p>{readOnly ? t("pol_rules_missing_governed", { file: POLICY_FILE }) : t("pol_rules_missing", { file: POLICY_FILE })}</p>
          {!readOnly ? (
            <div>
              <button type="button" className="btn primary" disabled={creating} aria-busy={creating || undefined} onClick={() => void create()} data-testid="policy-create">
                {creating ? <Spinner /> : null}
                {t("pol_rules_create", { file: POLICY_FILE })}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {loaded.data && loaded.data.file.exists ? (
        <div aria-busy={loaded.reloading ? true : undefined}>
          <Updating active={loaded.reloading} />
          <DerivedFormView form={loaded.data} editor={editor} reload={loaded.reload} readOnly={readOnly} headingLevel={3} />
        </div>
      ) : null}
    </section>
  );
}
