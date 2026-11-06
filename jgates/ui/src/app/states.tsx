import { useEffect, useState } from "react";
import { api } from "../api";
import { errorText } from "../components/common";
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
            <Icon name="refresh" />
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

interface InitInfo {
  existing: string[];
  profiles: string[];
  defaultProfile: string;
  components: Array<{ root: string; language: string | null; framework: string | null; evidence: string[] }>;
  templates: string[];
  files: string[];
}

/**
 * Overview of a workspace with no jgates.yml: what discovery found, the choice of the starting profile and the
 * button that writes the configuration (the same files as `jgates init`). The terminal road stays below.
 */
export function FirstAccess() {
  const { info, reload } = useShell();
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [data, setData] = useState<InitInfo | null>(null);
  const [profile, setProfile] = useState("standard");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<{ message: string; fix: string | null } | null>(null);
  const dir = info?.workspace.path ?? ".";

  useEffect(() => {
    let alive = true;
    api<InitInfo>("GET", "/api/init")
      .then((d) => {
        if (!alive) return;
        setData(d);
        setProfile(d.defaultProfile);
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, []);

  const recheck = async () => {
    setChecking(true);
    await reload();
    setChecking(false);
    // The shell data replaces this state by itself when the file exists; otherwise say so.
    toast(t("first_not_yet"), "info");
  };
  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const answer = await api<{ profile: string; created: string[] }>("POST", "/api/init", { profile });
      toast(t("first_init_done", { profile: answer.profile, files: answer.created.join(", ") }), "ok");
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCreating(false);
    }
  };
  const steps = [
    { id: "init", title: t("first_step1_title"), text: t("first_step1_text"), command: `jgates init --profile ${profile} --cwd ${quote(dir)}` },
    { id: "discover", title: t("first_step2_title"), text: t("first_step2_text"), command: `jgates discover --cwd ${quote(dir)}` },
    { id: "plan", title: t("first_step3_title"), text: t("first_step3_text"), command: `jgates plan --cwd ${quote(dir)}` },
  ];
  return (
    <section className="stack" aria-labelledby="first-title" data-state="first-access">
      <div className="stack">
        <p className="eyebrow">{t("first_eyebrow")}</p>
        <h1 id="first-title">{t("first_title")}</h1>
        <p>{t("first_lead", { path: dir })}</p>
      </div>

      <div className="card flat stack" data-step="detected">
        <h2>{t("first_detected_title")}</h2>
        {!data ? <p className="small muted">{t("first_loading")}</p> : null}
        {data && data.components.length === 0 ? <p>{t("first_detected_none")}</p> : null}
        {data && data.components.length > 0 ? (
          <ul className="ws-list" aria-label={t("first_detected_title")}>
            {data.components.map((c) => (
              <li key={`${c.root}:${c.language ?? ""}`} className="ws-item">
                <Icon name="folder" />
                <div className="grow">
                  <strong className="mono">{c.root}</strong>
                  <div className="small muted">
                    {[c.language, c.framework].filter(Boolean).join(" · ") || t("first_language_unknown")}
                    {c.evidence.length > 0 ? ` (${c.evidence.join(", ")})` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {data ? <p className="small muted">{t("first_templates", { templates: data.templates.join(", ") })}</p> : null}
      </div>

      <fieldset className="card flat stack" data-step="profile">
        <legend>
          <h2>{t("first_profile_title")}</h2>
        </legend>
        {(data?.profiles ?? ["minimal", "standard", "strict"]).map((id) => (
          <label key={id} className="row first-profile">
            <input type="radio" name="first-profile" value={id} checked={profile === id} onChange={() => setProfile(id)} />
            <span className="grow">
              <strong>{id}</strong>
              <span className="small muted"> — {t(`first_profile_${id}`)}</span>
            </span>
          </label>
        ))}
        {data ? <p className="small muted">{t("first_files", { files: data.files.join(", ") })}</p> : null}
        <div className="row wrap">
          <button type="button" className="btn primary" onClick={() => void create()} disabled={creating || !data}>
            <Icon name="check" />
            {creating ? t("first_creating") : t("first_create")}
          </button>
        </div>
        {error ? (
          <div className="notice error" role="alert">
            <Icon name="alert" />
            <div className="grow">
              <p>{error.message}</p>
              {error.fix ? <p className="small">{error.fix}</p> : null}
            </div>
          </div>
        ) : null}
      </fieldset>

      <details className="card flat stack">
        <summary>{t("first_terminal")}</summary>
        <ol className="road">
          {steps.map((step, index) => (
            <li key={step.id} className="card flat stack" data-step={step.id}>
              <div className="row">
                <span className="step-number" aria-hidden="true">
                  {index + 1}
                </span>
                <h2>{step.title}</h2>
              </div>
              <p>{step.text}</p>
              <CopyCommand command={step.command} />
            </li>
          ))}
        </ol>
        <div className="row wrap">
          <button type="button" className="btn" onClick={recheck} disabled={checking}>
            <Icon name="refresh" />
            {t("first_recheck")}
          </button>
          <span className="small muted">{t("first_recheck_hint")}</span>
        </div>
      </details>
    </section>
  );
}

/** Quotes a path for the command line shown to the user only when it needs it. */
function quote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
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
