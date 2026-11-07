import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import { Pill } from "../../components/common";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { useShell } from "../../app/shell-context";
import "./about.css";

export const screen: ScreenMeta = { id: "about", path: "/about", order: 95, icon: "info" };

// The interface is offline and makes no external request, so the documentation is named by its path in the repository.
const DOCS = [
  { id: "compat_pt", file: "docs/jgates/compatibility.pt-BR.md" },
  { id: "compat_en", file: "docs/jgates/compatibility.en.md" },
  { id: "start_pt", file: "docs/jgates/getting-started.pt-BR.md" },
  { id: "start_en", file: "docs/jgates/getting-started.en.md" },
] as const;


interface CheckResult {
  installation: { kind: "dependency" | "global" | "clone"; version: string; commit: string | null; dirty: boolean; packageDir: string };
  repository: string;
  ref: string;
  latest: string;
  state: "up-to-date" | "available" | "unknown";
  canInstall: boolean;
  command: string[] | null;
}
interface InstallStatus {
  state: "idle" | "running" | "done" | "failed";
  commit: string | null;
  exitCode: number | null;
  log: string[];
}

const short = (commit: string | null) => (commit ? commit.slice(0, 12) : "?");

// Updates: nothing is checked on its own. The repository is asked only when the person presses the button, and the
// install needs a second, explicit press; it runs on the local server and the screen follows its status.
function Updates() {
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [install, setInstall] = useState<InstallStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fix: string | null } | null>(null);

  const fail = (e: unknown) => setError(e instanceof ApiError ? { message: e.message, fix: e.fix } : { message: String(e), fix: null });

  useEffect(() => {
    // An install started earlier (another tab, a reload) is shown again; this asks only the local server.
    api<{ update: InstallStatus }>("GET", "/api/update/status").then(
      (r) => {
        if (r.update.state !== "idle") setInstall(r.update);
      },
      () => undefined,
    );
  }, []);

  useEffect(() => {
    if (install?.state !== "running") return;
    const timer = window.setInterval(() => {
      api<{ update: InstallStatus }>("GET", "/api/update/status").then((r) => setInstall(r.update), fail);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [install?.state]);

  const runCheck = async () => {
    setBusy(true);
    setError(null);
    setConfirming(false);
    try {
      setCheck(await api<CheckResult>("POST", "/api/update/check", {}));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const runInstall = async () => {
    if (!check) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ update: InstallStatus }>("POST", "/api/update/install", { commit: check.latest });
      setInstall(r.update);
      setConfirming(false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const running = install?.state === "running";
  const offerInstall = check !== null && check.state !== "up-to-date" && check.canInstall && !running && install?.state !== "done";
  return (
    <section className="card flat stack" aria-labelledby="about-updates">
      <h2 id="about-updates">{t("about_updates")}</h2>
      <p className="small">{t("about_updates_note")}</p>
      <div className="row">
        <button type="button" className="btn" disabled={busy || running} onClick={runCheck} data-testid="update-check">
          {busy && !confirming ? t("about_updates_checking") : t("about_updates_check")}
        </button>
      </div>
      {error ? (
        <p role="alert" className="small">
          {error.message} {error.fix}
        </p>
      ) : null}
      {check ? (
        <div className="stack" data-testid="update-result">
          <dl className="kv">
            <dt>{t("about_updates_installed")}</dt>
            <dd>
              <code>{short(check.installation.commit)}</code> {check.installation.dirty ? t("about_updates_dirty") : null}
            </dd>
            <dt>{t("about_updates_latest", { ref: check.ref })}</dt>
            <dd>
              <code>{short(check.latest)}</code>
            </dd>
          </dl>
          <p>
            <Pill tone={check.state === "up-to-date" ? "green" : check.state === "available" ? "gold" : "blue"}>
              {t(`about_updates_state_${check.state.replace(/-/g, "_")}`)}
            </Pill>
          </p>
          {check.state !== "up-to-date" && !check.canInstall ? (
            <p className="small">{t(`about_updates_manual_${check.installation.kind}`, { packageDir: check.installation.packageDir })}</p>
          ) : null}
          {offerInstall && confirming ? (
            <div className="stack">
              <p className="small">{t("about_updates_confirm_text")}</p>
              <code className="small">{check.command?.join(" ")}</code>
              <div className="row">
                <button type="button" className="btn primary" disabled={busy} onClick={runInstall} data-testid="update-install-confirm">
                  {t("about_updates_install_confirm")}
                </button>
                <button type="button" className="btn" onClick={() => setConfirming(false)}>
                  {t("about_updates_cancel")}
                </button>
              </div>
            </div>
          ) : null}
          {offerInstall && !confirming ? (
            <div className="row">
              <button type="button" className="btn primary" onClick={() => setConfirming(true)} data-testid="update-install">
                {t("about_updates_install")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {install && install.state !== "idle" ? (
        <div className="stack" data-testid="update-install-status" aria-live="polite">
          <p>
            <Pill tone={install.state === "done" ? "green" : install.state === "failed" ? "red" : "blue"}>{t(`about_updates_install_${install.state}`)}</Pill>
          </p>
          {install.state === "done" ? <p className="small">{t("about_updates_restart")}</p> : null}
          {install.state === "failed" ? <p className="small">{t("about_updates_failed_note", { code: String(install.exitCode ?? "?") })}</p> : null}
          {install.log.length > 0 && install.state !== "done" ? <pre className="small update-log">{install.log.slice(-12).join("\n")}</pre> : null}
        </div>
      ) : null}
    </section>
  );
}

export default function AboutScreen() {
  const { info } = useShell();
  return (
    <div className="stack">
      <div>
        <h1>{t("about_title")}</h1>
        <p>{t("about_lead")}</p>
      </div>
      <section className="card flat stack" aria-labelledby="about-facts">
        <h2 id="about-facts">{t("about_facts")}</h2>
        <dl className="kv">
          <dt>{t("about_version")}</dt>
          <dd data-testid="about-version">{info?.version ?? "-"}</dd>
          <dt>{t("about_mode")}</dt>
          <dd data-testid="about-mode">
            {info ? <Pill tone={info.mode === "governed" ? "gold" : "green"}>{info.mode === "governed" ? t("about_mode_governed") : t("about_mode_local")}</Pill> : "-"}
          </dd>
          <dt>{t("about_workspace")}</dt>
          <dd>
            <code data-testid="about-path">{info?.workspace.path ?? "-"}</code>
          </dd>
        </dl>
      </section>
      <Updates />
      <section className="card flat stack" aria-labelledby="about-docs">
        <h2 id="about-docs">{t("about_docs")}</h2>
        <p className="small">{t("about_docs_note")}</p>
        <ul>
          {DOCS.map((d) => (
            <li key={d.id}>
              {t(`about_doc_${d.id}`)}: <code>{d.file}</code>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
