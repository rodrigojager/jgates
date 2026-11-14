// Steps 1 and 2: the machine (the doctor examines it: the container engine, checked every 3 s while the page is visible
// and when the person comes back to it, then memory, disk and CPUs against what JGates recommends; the runtime chosen
// from a list and saved in the user's preferences) and what is downloaded (the tools image with its tools, the security
// databases, the totals against the free space), whose download goes on in the background once started.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRecheckOnFocus } from "../../api/environment";
import { DoctorAvatar } from "../../components/DoctorAvatar";
import { ErrorNotice, Loading, Pill, Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import "../../components/prerequisites.css";
import { getLocale, t } from "../../i18n";
import type { DoctorState } from "../../mascots/doctor/index.js";
import { advance, fetchDocker, fetchSetup, fetchTools, formatBytes, saveRuntime, startDownloads, testRuntime, type DockerCheck, type Requirement, type RuntimeId, type RuntimeTest, type SecurityDatabase, type ToolsInfo } from "./api";
import { EquivalentCommand, ReasonNotice, StepNav, useJob } from "./parts";
import type { StepProps } from "./Wizard";

const POLL_MS = 3000;

/** The doctor's state for the machine check: checking until the first answer, error when it cannot answer at all. */
export function doctorStateOf(check: DockerCheck | null, error: unknown): DoctorState {
  if (!check) return error ? "error" : "checking";
  if (check.state === "unsupported") return "error";
  if (!check.ready || check.requirements.some((r) => r.state === "warn" || r.state === "error")) return "needs-you";
  return "ok";
}

const REQUIREMENT_TONE: Record<Requirement["state"], "green" | "gold" | "red" | undefined> = { ok: "green", warn: "gold", error: "red", unknown: undefined };

/**
 * The measured value beside a requirement: "7,8 GB", "4", "27.0.1". Memory and disk are counted the way the requirement's
 * own sentence and its recommendation count them (1 GB = 1024 MB, as the engine reports them), so the value and the
 * sentence under it say the same number.
 */
function measured(r: Requirement): string {
  if (r.value === null) return t("wizard_unknown");
  if (r.unit === "mb" && typeof r.value === "number") return r.value >= 1024 ? `${formatNumber(Math.round((r.value / 1024) * 10) / 10)} GB` : `${formatNumber(r.value)} MB`;
  return String(r.value);
}

/** One decimal at most, with the separator of the interface's language. */
function formatNumber(value: number): string {
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(value);
}

function Requirements({ list }: { list: Requirement[] }) {
  return (
    <section className="stack" aria-labelledby="wizard-req-title">
      <h2 id="wizard-req-title" className="wizard-subtitle">
        {t("wizard_req_title")}
      </h2>
      <ul className="wizard-checklist" data-testid="wizard-requirements">
        {list.map((r) => (
          <li key={r.id} data-requirement={r.id} data-state={r.state} className="wizard-check">
            <span className={`wizard-check-icon ${r.state}`} aria-hidden="true">
              <Icon name={r.state === "ok" ? "check" : r.state === "unknown" ? "info" : "alert"} />
            </span>
            <div className="grow stack tight">
              <span className="row wrap">
                <strong>{t(`wizard_req_${r.id}`)}</strong>
                <span className="mono" data-testid="wizard-requirement-value">
                  {measured(r)}
                </span>
                <Pill tone={REQUIREMENT_TONE[r.state]}>{t(`wizard_req_state_${r.state}`)}</Pill>
              </span>
              <span className="small muted">{r.message}</span>
            </div>
          </li>
        ))}
      </ul>
      {list.some((r) => r.state === "warn" && !r.blocking) ? <p className="small muted">{t("wizard_req_warn_note")}</p> : null}
    </section>
  );
}

/** The runtime list: Docker, Podman, or another executable with its path and "Testar"; "Usar" saves the choice. */
function RuntimeChoice({ check, onSaved }: { check: DockerCheck; onSaved: () => void }) {
  const runtime = check.runtime;
  const [choice, setChoice] = useState<RuntimeId>(runtime.selected);
  const [path, setPath] = useState(runtime.path ?? "");
  const [tested, setTested] = useState<RuntimeTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const changed = choice !== runtime.selected || (choice === "custom" && path.trim() !== (runtime.path ?? ""));
  const test = async () => {
    setTesting(true);
    setError(null);
    setTested(null);
    try {
      setTested(await testRuntime(path.trim()));
    } catch (e) {
      setError(e);
    } finally {
      setTesting(false);
    }
  };
  const use = async () => {
    setSaving(true);
    setError(null);
    try {
      const answer = await saveRuntime(choice, choice === "custom" ? path.trim() : undefined);
      setSaved(answer.runtime.path ?? answer.runtime.selected);
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <fieldset className="stack wizard-fieldset" data-testid="wizard-runtime">
      <legend>{t("wizard_runtime_legend")}</legend>
      <div className="stack tight">
        {runtime.options.map((o) => (
          <label key={o.id} className="row wrap wizard-runtime-option" data-runtime={o.id}>
            <input type="radio" name="wizard-runtime" value={o.id} checked={choice === o.id} onChange={() => setChoice(o.id)} />
            <span>{t(`wizard_runtime_${o.id}`)}</span>
            {o.id !== "custom" ? <span className="small muted wizard-break">{o.found ? t("wizard_runtime_found", { path: o.found }) : t("wizard_runtime_not_found")}</span> : null}
          </label>
        ))}
      </div>
      {choice === "custom" ? (
        <div className="stack tight">
          <label htmlFor="wizard-runtime-path">{t("wizard_runtime_path")}</label>
          <div className="row wrap">
            <input
              id="wizard-runtime-path"
              className="input grow"
              type="text"
              data-free-text="path"
              spellCheck={false}
              autoComplete="off"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setTested(null);
              }}
            />
            {/* Never disabled while it runs: a disabled button loses the focus. */}
            <button type="button" className="btn" onClick={() => void test()} disabled={path.trim() === ""} aria-busy={testing}>
              {testing ? <Spinner /> : <Icon name="play" />}
              {t("wizard_runtime_test")}
            </button>
          </div>
        </div>
      ) : null}
      <div role="status" aria-live="polite" className="stack tight">
        {tested ? (
          <p className={`small${tested.ok ? "" : " field-problem"}`} data-testid="wizard-runtime-test" data-ok={tested.ok ? "true" : "false"}>
            {tested.message}
          </p>
        ) : null}
        {saved ? <p className="small">{t("wizard_runtime_saved", { runtime: saved })}</p> : null}
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      {changed ? (
        <div>
          <button type="button" className="btn primary" onClick={() => void use()} disabled={choice === "custom" && path.trim() === ""} aria-busy={saving}>
            {saving ? <Spinner /> : <Icon name="check" />}
            {t("wizard_runtime_use")}
          </button>
        </div>
      ) : null}
      {runtime.envOverride ? <p className="small muted wizard-break">{t("wizard_runtime_env", { value: runtime.envOverride })}</p> : null}
    </fieldset>
  );
}

export function DockerStep({ act, busy, back }: StepProps) {
  const [check, setCheck] = useState<DockerCheck | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const load = useCallback(async () => {
    setChecking(true);
    try {
      setCheck(await fetchDocker());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // While the engine is not ready: a new check every 3 s, only while the page is visible; none once it is ready.
  const ready = check?.ready === true;
  useEffect(() => {
    if (ready) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [ready, load]);
  useRecheckOnFocus(() => void load());

  const doctor = doctorStateOf(check, error);
  return (
    <div className="stack" data-testid="wizard-step-docker">
      <div className="row wizard-doctor" data-testid="wizard-doctor" data-state={doctor}>
        <DoctorAvatar state={doctor} />
        <div className="grow stack tight">
          <p className="wizard-lead" role="status" aria-live="polite" data-testid="wizard-engine" data-engine={check?.state ?? (error ? "error" : "checking")}>
            <strong>{t(`wizard_doctor_${doctor.replace("-", "_")}`)}</strong>
          </p>
          <p>{t("wizard_docker_lead")}</p>
        </div>
      </div>
      {check?.mode === "in-image" ? <p>{t("wizard_docker_in_image")}</p> : null}
      {check && check.requirements.length > 0 ? <Requirements list={check.requirements} /> : null}
      {check ? check.reasons.map((reason) => <ReasonNotice key={reason.code} reason={reason} tone={check.ready ? "info" : "warn"} />) : null}
      {error ? <ErrorNotice error={error} /> : null}
      <div className="row wrap">
        <button type="button" className="btn" onClick={() => void load()} aria-busy={checking}>
          {checking ? <Spinner /> : <Icon name="refresh" />}
          {t("wizard_recheck")}
        </button>
        {!ready ? <span className="small muted">{t("wizard_docker_polling")}</span> : null}
      </div>
      {check && check.mode !== "in-image" ? <RuntimeChoice check={check} onSaved={() => void load()} /> : null}
      <details>
        <summary>{t("wizard_docker_why")}</summary>
        <p>{t("wizard_docker_why_text")}</p>
      </details>
      <details>
        <summary>{t("wizard_docker_other")}</summary>
        <p>{t("wizard_docker_other_text")}</p>
      </details>
      <EquivalentCommand command="jgates setup" />
      <StepNav onBack={back} busy={busy} nextDisabled={!ready} onNext={() => void act(() => advance("docker"))} />
    </div>
  );
}

/** Bytes per second and time left of a download, from what the screen saw since the first progress event. */
function useRate(downloaded: number, total: number): { speed: number | null; leftSeconds: number | null } {
  const first = useRef<{ at: number; bytes: number } | null>(null);
  const [rate, setRate] = useState<{ speed: number | null; leftSeconds: number | null }>({ speed: null, leftSeconds: null });
  useEffect(() => {
    if (total <= 0) return;
    const now = Date.now();
    if (!first.current) {
      first.current = { at: now, bytes: downloaded };
      return;
    }
    const seconds = (now - first.current.at) / 1000;
    if (seconds < 1) return;
    const speed = (downloaded - first.current.bytes) / seconds;
    setRate({ speed: speed > 0 ? speed : null, leftSeconds: speed > 0 ? Math.round((total - downloaded) / speed) : null });
  }, [downloaded, total]);
  return rate;
}

/** The words of a database's state: what is true now, never a promise that no longer holds (D29). */
function databaseState(d: SecurityDatabase, imageReady: boolean, dataJob: string | null): string {
  if (dataJob === "running") return t("wizard_data_state_updating");
  if (d.state === "fresh") return t("wizard_data_state_fresh");
  if (dataJob === "failed") return t("wizard_data_state_failed");
  if (d.state === "stale") return t("wizard_data_state_stale");
  return imageReady ? t("wizard_data_state_absent") : t("wizard_data_state_missing");
}

export function ToolsStep({ view, act, apply, busy, back }: StepProps) {
  const [info, setInfo] = useState<ToolsInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    fetchTools().then(
      (next) => {
        setInfo(next);
        setError(null);
      },
      setError,
    );
  }, []);
  useEffect(load, [load]);

  const pullRef = view.setup.jobs.pull;
  const dataRef = view.setup.jobs.data;
  const pull = useJob(pullRef?.id ?? null, pullRef?.known ?? true);
  const data = useJob(dataRef?.id ?? null, dataRef?.known ?? true);
  // When the pull ends the server starts the advisory data: read the view again to learn its job, and the image state.
  const pullState = pull?.state ?? null;
  useEffect(() => {
    if (pullState === "done" || pullState === "failed") {
      load();
      fetchSetup().then(apply, () => undefined);
    }
  }, [pullState, load, apply]);
  // When the data job ends, the databases are read again: their rows say what is there now.
  const dataState = data?.state ?? null;
  useEffect(() => {
    if (dataState === "done" || dataState === "failed") load();
  }, [dataState, load]);

  const last = [...(pull?.events ?? [])].reverse().find((e) => e.type === "image-pull") as { downloaded?: number; total?: number } | undefined;
  const downloaded = Number(last?.downloaded ?? 0);
  const total = Number(last?.total ?? 0);
  const rate = useRate(downloaded, total);
  const imageReady = info?.image.state === "ready" || info?.mode === "in-image";
  const downloading = pull?.state === "running";
  const failed = pull?.state === "failed";
  const dataRunning = data?.state === "running";
  const endEvent = [...(pull?.events ?? [])].reverse().find((e) => e.type === "end") as { reasons?: Array<{ code: string; message: string; action: { kind: "command" | "link" | "route" | "none"; label: string } }> } | undefined;

  if (!info && !error) return <Loading />;
  const doctor: DoctorState = failed && !imageReady ? "error" : imageReady ? "ok" : downloading ? "checking" : "needs-you";
  const freeBytes = info?.disk.freeBytes ?? null;
  const pendingBytes = info?.totals.pendingDiskBytes ?? 0;
  return (
    <div className="stack" data-testid="wizard-step-tools">
      {/* The doctor stays with the machine: here he says whether the tools are on it. */}
      <div className="row wizard-doctor" data-testid="wizard-tools-doctor" data-state={doctor}>
        <DoctorAvatar state={doctor} />
        <p className="wizard-lead grow">{t("wizard_tools_lead")}</p>
      </div>
      {error ? <ErrorNotice error={error} onRetry={load} /> : null}
      {info ? (
        <>
          <section className="card flat stack" aria-labelledby="wizard-image-title" data-testid="wizard-image">
            <h2 id="wizard-image-title" className="wizard-subtitle">
              {t("wizard_tools_image_title")}
            </h2>
            <dl className="wizard-facts">
              <dt>{t("wizard_tools_image_name")}</dt>
              <dd className="mono">{info.image.name}</dd>
              <dt>{t("wizard_tools_version")}</dt>
              <dd>{info.image.version ?? t("wizard_unknown")}</dd>
              <dt>{t("wizard_tools_download_size")}</dt>
              <dd>{formatBytes(info.image.downloadBytes)}</dd>
              <dt>{t("wizard_tools_disk_size")}</dt>
              <dd>{formatBytes(info.image.diskBytes)}</dd>
            </dl>
            {info.image.tools.length > 0 ? (
              <details data-testid="wizard-tools-list">
                <summary>{t("wizard_tools_list", { count: info.image.tools.length })}</summary>
                {/* A focusable region: on a narrow screen the table scrolls inside it, never the page. */}
                <div className="wizard-table-wrap" role="region" tabIndex={0} aria-label={t("wizard_tools_list", { count: info.image.tools.length })}>
                  <table className="wizard-table">
                    <thead>
                      <tr>
                        <th scope="col">{t("wizard_tools_col_tool")}</th>
                        <th scope="col">{t("wizard_tools_col_version")}</th>
                        <th scope="col">{t("wizard_tools_col_license")}</th>
                        <th scope="col">{t("wizard_tools_col_purpose")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {info.image.tools.map((tool) => (
                        <tr key={tool.name} data-tool={tool.name}>
                          <th scope="row" className="mono">
                            {tool.name}
                          </th>
                          <td className="mono">{tool.version}</td>
                          <td>{tool.license ?? "-"}</td>
                          <td>{tool.purposeText ?? "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null}
          </section>
          <section className="card flat stack" aria-labelledby="wizard-data-title" data-testid="wizard-data">
            <h2 id="wizard-data-title" className="wizard-subtitle">
              {t("wizard_data_title")}
            </h2>
            <p className="small muted">{t("wizard_data_lead", { volume: info.data.volume })}</p>
            <ul className="wizard-cards">
              {info.data.databases.map((d) => (
                <li key={d.id} className="stack tight" data-database={d.id}>
                  <span className="row wrap">
                    <strong>{d.name}</strong>
                    <span className="small" data-testid="wizard-data-state">
                      {databaseState(d, imageReady, data?.state ?? null)}
                    </span>
                  </span>
                  <span className="small muted wizard-break">
                    {t("wizard_data_source")}: <span className="mono">{d.source}</span> · {t("wizard_data_size")}: {d.approximate ? t("wizard_data_approx", { size: formatBytes(d.sizeBytes) }) : formatBytes(d.sizeBytes)} · {t("wizard_data_used_by")}: {d.usedBy}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <p data-testid="wizard-totals">
            {t("wizard_tools_totals", { download: formatBytes(info.totals.downloadBytes), disk: formatBytes(info.totals.diskBytes) })}{" "}
            {freeBytes === null
              ? null
              : freeBytes >= pendingBytes
                ? t("wizard_tools_free", { free: formatBytes(freeBytes) })
                : t("wizard_tools_free_low", { free: formatBytes(freeBytes), missing: formatBytes(pendingBytes - freeBytes) })}
          </p>
        </>
      ) : null}
      <div role="status" aria-live="polite" className="stack" data-testid="wizard-download" data-state={imageReady ? "ready" : downloading ? "downloading" : failed ? "failed" : "idle"}>
        {imageReady ? (
          <p className="row wrap">
            <Pill tone="green">{t("wizard_ready")}</Pill>
            <span>{info?.mode === "in-image" ? t("wizard_tools_in_image") : t("wizard_tools_ready", { version: info?.image.version ?? "?" })}</span>
          </p>
        ) : null}
        {downloading ? (
          <div className="stack wizard-progress">
            <progress max={total > 0 ? total : undefined} value={total > 0 ? downloaded : undefined} aria-label={t("wizard_tools_progress_label")} />
            <p className="small">
              {total > 0 ? t("wizard_tools_progress", { done: formatBytes(downloaded), total: formatBytes(total) }) : t("wizard_tools_starting")}
              {rate.speed ? ` · ${t("wizard_tools_speed", { speed: formatBytes(rate.speed) })}` : ""}
              {rate.leftSeconds !== null ? ` · ${t("wizard_tools_left", { minutes: Math.max(1, Math.round(rate.leftSeconds / 60)) })}` : ""}
            </p>
            <p className="small muted">{t("wizard_tools_background")}</p>
          </div>
        ) : null}
      </div>
      {failed && !imageReady ? (endEvent?.reasons ?? []).map((reason) => <ReasonNotice key={reason.code} reason={reason} tone="error" />) : null}
      {pull?.state === "unknown" && !imageReady ? <p className="small muted">{t("wizard_tools_lost")}</p> : null}
      {!imageReady && !downloading ? (
        <div className="row wrap">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void act(startDownloads)}>
            <Icon name="play" />
            {failed ? t("wizard_tools_retry") : t("wizard_tools_download")}
          </button>
        </div>
      ) : null}
      <EquivalentCommand command="jgates setup" />
      {/* "Continuar enquanto baixa" only while a download really runs (D29). */}
      <StepNav onBack={back} busy={busy} nextPrimary={imageReady || downloading} onNext={() => void act(() => advance("tools"))} nextLabel={downloading || dataRunning ? t("wizard_tools_next_background") : t("wizard_next")} />
    </div>
  );
}
