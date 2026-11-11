// Steps 1 and 2: the container engine (checked every 3 s while the page is visible, and when the person comes back to
// it) and the tools download, which goes on in the background once started.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRecheckOnFocus } from "../../api/environment";
import { ErrorNotice, Loading, Pill, Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";
import { advance, fetchDocker, fetchSetup, fetchTools, formatBytes, startDownloads, type DockerCheck, type ToolsInfo } from "./api";
import { EquivalentCommand, ReasonNotice, StepNav, useJob } from "./parts";
import type { StepProps } from "./Wizard";

const POLL_MS = 3000;

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

  const facts = check?.facts;
  return (
    <div className="stack" data-testid="wizard-step-docker">
      <p className="wizard-lead">{t("wizard_docker_lead")}</p>
      <div role="status" aria-live="polite" className="stack" data-testid="wizard-engine" data-engine={check?.state ?? "checking"}>
        {!check && !error ? <p className="spinner-text">{t("wizard_docker_checking")}</p> : null}
        {check?.ready ? (
          <p className="row wrap">
            <Pill tone="green">{t("wizard_ready")}</Pill>
            <span>
              {check.mode === "in-image"
                ? t("wizard_docker_in_image")
                : t("wizard_docker_ready", { version: facts?.serverVersion ?? "?", memory: formatBytes((facts?.memoryMb ?? 0) * 1024 * 1024), cpus: facts?.cpus ?? 0 })}
            </span>
          </p>
        ) : null}
      </div>
      {check ? check.reasons.map((reason) => <ReasonNotice key={reason.code} reason={reason} tone={check.ready ? "info" : "warn"} />) : null}
      {error ? <ErrorNotice error={error} /> : null}
      <div className="row wrap">
        <button type="button" className="btn" onClick={() => void load()} disabled={checking}>
          {checking ? <Spinner /> : <Icon name="refresh" />}
          {t("wizard_recheck")}
        </button>
        {!ready ? <span className="small muted">{t("wizard_docker_polling")}</span> : null}
      </div>
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

  const last = [...(pull?.events ?? [])].reverse().find((e) => e.type === "image-pull") as { downloaded?: number; total?: number } | undefined;
  const downloaded = Number(last?.downloaded ?? 0);
  const total = Number(last?.total ?? 0);
  const rate = useRate(downloaded, total);
  const imageReady = info?.image.state === "ready" || info?.mode === "in-image";
  const downloading = pull?.state === "running";
  const failed = pull?.state === "failed";
  const endEvent = [...(pull?.events ?? [])].reverse().find((e) => e.type === "end") as { reasons?: Array<{ code: string; message: string; action: { kind: "command" | "link" | "route" | "none"; label: string } }> } | undefined;

  if (!info && !error) return <Loading />;
  return (
    <div className="stack" data-testid="wizard-step-tools">
      <p className="wizard-lead">{t("wizard_tools_lead")}</p>
      {error ? <ErrorNotice error={error} onRetry={load} /> : null}
      {info ? (
        <dl className="wizard-facts">
          <dt>{t("wizard_tools_size")}</dt>
          <dd>{formatBytes(info.image.sizeBytes)}</dd>
          <dt>{t("wizard_tools_disk")}</dt>
          <dd>{info.disk.freeMb === null ? t("wizard_unknown") : t("wizard_tools_disk_value", { free: formatBytes(info.disk.freeMb * 1e6), need: formatBytes(info.disk.requiredMb * 1e6) })}</dd>
          <dt>{t("wizard_tools_data")}</dt>
          <dd>{t(`wizard_data_${data?.state === "running" ? "updating" : info.data.state}`)}</dd>
        </dl>
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
      <StepNav onBack={back} busy={busy} onNext={() => void act(() => advance("tools"))} nextLabel={imageReady ? t("wizard_next") : t("wizard_tools_next_background")} />
    </div>
  );
}
