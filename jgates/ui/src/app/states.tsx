import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { Loading, Spinner } from "../components/common";
import { Icon } from "../components/icons";
import { useToast } from "../components/Toast";
import { t } from "../i18n";
import type { Area } from "./areas";
import { useShell } from "./shell-context";

// States of the interface itself. Each one says what happened, what is safe
// and what to do next; none is a generic error.

/** The local server stopped answering. The files are untouched; the way back is to run `jgates ui` again. */
export function ServerStopped({ path }: { path: string }) {
  const { probe, reload } = useShell();
  const [checking, setChecking] = useState(false);
  const [still, setStill] = useState(false);
  const check = async () => {
    setChecking(true);
    setStill(false);
    const state = await probe();
    if (state === "ok") await reload();
    else setStill(true);
    setChecking(false);
  };
  return (
    <section className="state" role="alert" aria-labelledby="state-title" data-state="server-stopped">
      <Icon name="power" />
      <div className="stack grow">
        <h1 id="state-title">{t("stopped_title")}</h1>
        <p>{t("stopped_lead")}</p>
        <ol className="steps">
          <li>
            {t("stopped_step1", { path })} <code>jgates ui</code>
          </li>
          <li>{t("stopped_step2")}</li>
        </ol>
        <div className="row wrap">
          <button type="button" className="btn primary" onClick={check} disabled={checking}>
            {checking ? <Spinner /> : <Icon name="refresh" />}
            {checking ? t("stopped_checking") : t("stopped_retry")}
          </button>
          {still ? <span className="small muted">{t("stopped_still")}</span> : null}
        </div>
      </div>
    </section>
  );
}

/** The server answers but does not know this session any more (restarted, or idle for too long). */
export function SessionExpired() {
  return (
    <section className="state" role="alert" aria-labelledby="state-title" data-state="session-expired">
      <Icon name="lock" />
      <div className="stack grow">
        <h1 id="state-title">{t("expired_title")}</h1>
        <p>{t("expired_lead")}</p>
        <p>
          {t("expired_fix")} <code>jgates ui</code>
        </p>
      </div>
    </section>
  );
}

/** A command the user is meant to copy: shown as text, with a button that copies it. */
export function CopyCommand({ command }: { command: string }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast(t("copy_done"), "ok");
    } catch {
      toast(t("copy_failed"), "warn");
    }
  };
  return (
    <div className="command row">
      <code className="grow">{command}</code>
      <button type="button" className="btn" onClick={copy} aria-label={t("copy_aria", { command })}>
        <Icon name="copy" />
        {t("copy")}
      </button>
    </div>
  );
}

// The first-run wizard, fetched when it is shown (most visits of the overview never need its code).
const Wizard = lazy(() => import("../screens/wizard/Wizard"));

/**
 * The overview's content: the first-run wizard while the setup is not over (a workspace without jgates.yml always, or a
 * wizard that was started and has not ended), the overview's own screen afterwards. The server keeps the wizard's
 * state, so a reload lands on the same step.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const { info } = useShell();
  const configured = info?.workspace.configured ?? true;
  // Without a configuration the wizard shows at once; with one, the server says whether a wizard is still going on.
  const [open, setOpen] = useState<boolean | null>(configured ? null : true);
  useEffect(() => {
    let alive = true;
    api<{ open: boolean }>("GET", "/api/setup").then(
      (answer) => alive && setOpen(answer.open),
      () => alive && setOpen(!configured),
    );
    return () => {
      alive = false;
    };
  }, [configured]);
  if (open === null) return <Loading />;
  if (!open) return <>{children}</>;
  return (
    <Suspense fallback={<Loading />}>
      <Wizard onClosed={() => setOpen(false)} />
    </Suspense>
  );
}

/** An area (or route) with no screen in this version of the application. */
export function AreaUnavailable({ area }: { area: Area | undefined }) {
  return (
    <section className="stack" aria-labelledby="unavailable-title" data-state="unavailable">
      <h1 id="unavailable-title">{area ? t(area.label) : t("not_found")}</h1>
      <div className="notice">
        <Icon name="info" />
        <div className="stack grow">
          <p>{area ? t("unavailable_text") : t("not_found_text")}</p>
          <p className="small">
            {t("unavailable_cli")} <code>jgates --help</code>
          </p>
          <div>
            <a className="btn" href="#/overview">
              {t("nav_overview")}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/** A run is going on in this workspace: a reload of the page lands here and finds the way back to it. */
export function ActiveRunBanner({ runId }: { runId: string }) {
  return (
    <div className="notice warn" role="status" data-state="run-in-progress">
      <Icon name="play" />
      <div className="grow">
        <strong>{t("banner_run")}</strong>
        <p className="small">{t("banner_run_hint")}</p>
      </div>
      <a className="btn" href={`#/runs/${encodeURIComponent(runId)}`}>
        {t("banner_run_follow")}
      </a>
    </div>
  );
}
