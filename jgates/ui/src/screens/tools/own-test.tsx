import { useState } from "react";
import { ApiError, api } from "../../api";
import { Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";

// "Testar agora" of an own tool outside the creation dialog: the card's `Não testada` state and the tool page use it.
// The test builds the extension image when it is out of date and runs the one tool once on the synced copy.

interface TestResult {
  state: "ok" | "findings" | "unreadable" | "blocked" | "build-failed" | "not-found";
  reason: string | null;
  findingCount: number;
}

/** The button and, once it ran, the answer in words; `onTested` runs when the test could read the report. */
export function OwnTest({ id, onTested }: { id: string; onTested?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const r = await api<{ result: TestResult }>("POST", "/api/tools/custom/test", { instance: id });
      setResult(r.result);
      if (r.result.state === "ok" || r.result.state === "findings") onTested?.();
    } catch (e) {
      setError(e instanceof ApiError ? (tOr(`ctl_err_${e.code}`, "") || e.message) : t("error_network"));
    } finally {
      setBusy(false);
    }
  }

  const good = result?.state === "ok" || result?.state === "findings";
  return (
    <div className="stack tight" data-testid="own-test">
      <div className="row wrap">
        <button type="button" className="btn" disabled={busy} aria-label={t("tools_own_test_label", { tool: id })} onClick={run}>
          {busy ? <Spinner /> : <Icon name="play" />}
          {busy ? t("ctl_test_running") : t("ctl_test_now")}
        </button>
        {busy ? <span className="small muted">{t("ctl_test_progress")}</span> : null}
      </div>
      {result ? (
        <div className={`notice ${good ? "ok" : "warn"}`} role="status" data-testid="own-test-result" data-state={result.state}>
          <Icon name={good ? "check" : "alert"} />
          <div className="stack tight">
            <strong>{t(`ctl_result_${result.state.replace("-", "_")}`, { count: result.findingCount })}</strong>
            {result.reason ? <p className="small">{result.reason}</p> : null}
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="notice error" role="alert">
          <Icon name="alert" />
          <p>{error}</p>
        </div>
      ) : null}
    </div>
  );
}
