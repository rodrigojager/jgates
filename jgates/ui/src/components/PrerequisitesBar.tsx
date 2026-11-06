import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { Dialog, ErrorNotice, Pill, useAsync } from "./common";
import { DoctorAvatar } from "./DoctorAvatar";
import { Icon, type IconName } from "./icons";
import type { DoctorState } from "../mascots/doctor/index.js";
import { t } from "../i18n";
import "./prerequisites.css";

// What has to be in place before a validation runs (GET /api/prerequisites), each item with its one action: run it
// here after a confirmation that shows the exact commands, copy it to a terminal (commands with sudo), or only read
// what to do. The bar shows nothing when nothing is missing, unless `showReady` asks for the all-clear line.

export interface PrerequisiteItem {
  id: string;
  kind: "docker-start" | "docker-install" | "git-trust" | "tools-install" | "manual";
  classification: "essential" | "optional";
  names: string[];
  commands: string[];
  action: "run" | "copy" | null;
  hosts: string[];
  message: string | null;
  fix: string | null;
}

interface Report {
  ready: boolean;
  platform: string;
  items: PrerequisiteItem[];
}

interface FixResponse extends Report {
  outcome: { id: string; status: "done" | "failed" | "skipped"; message: string | null };
}

/** The Docker of a desktop (Windows, macOS) is an app to open; on Linux it is a service. */
const desktopDocker = (platform: string) => platform === "win32" || platform === "darwin";

function texts(item: PrerequisiteItem, platform: string): { icon: IconName; title: string; text: string; button: string } {
  const desktop = desktopDocker(platform);
  switch (item.kind) {
    case "docker-start":
      return desktop
        ? { icon: "power", title: t("prq_docker_start_title"), text: t("prq_docker_text"), button: t("prq_docker_start_button") }
        : { icon: "power", title: t("prq_docker_service_title"), text: t("prq_docker_text"), button: t("prq_copy") };
    case "docker-install":
      return { icon: "power", title: t("prq_docker_install_title"), text: t("prq_docker_text"), button: t("prq_docker_install_button") };
    case "git-trust":
      return { icon: "branch", title: t("prq_git_title"), text: t("prq_git_text", { folder: item.names[0] ?? "-" }), button: t("prq_git_button") };
    case "tools-install":
      return {
        icon: "tools",
        title: item.names.length === 1 ? t("prq_tools_title_one", { names: item.names.join(", ") }) : t("prq_tools_title", { count: item.names.length, names: item.names.join(", ") }),
        text: t("prq_tools_text"),
        button: item.names.length === 1 ? t("prq_tools_button_one") : t("prq_tools_button", { count: item.names.length }),
      };
    default:
      return { icon: "alert", title: t("prq_manual_title", { name: item.names.join(", ") }), text: item.message ?? "", button: "" };
  }
}

function Commands({ commands }: { commands: string[] }) {
  if (commands.length === 0) return null;
  return (
    <details className="prq-commands">
      <summary>{t("prq_show_commands")}</summary>
      <pre>
        <code>{commands.join("\n")}</code>
      </pre>
    </details>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className="btn" onClick={() => void copy()}>
      <Icon name={copied ? "check" : "copy"} />
      {copied ? t("prq_copied") : t("prq_copy")}
    </button>
  );
}

function ConfirmDialog({ item, platform, onClose, onDone }: { item: PrerequisiteItem; platform: string; onClose: () => void; onDone: (r: FixResponse) => void }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const x = texts(item, platform);
  const run = async () => {
    setRunning(true);
    setError(null);
    setFailed(null);
    try {
      const r = await api<FixResponse>("POST", "/api/prerequisites/fix", { id: item.id });
      if (r.outcome.status === "done") onDone(r);
      else setFailed(r.outcome.message ?? r.outcome.status);
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
    }
  };
  return (
    <Dialog title={x.title} onClose={onClose}>
      <div className="stack">
        <p>{t(item.kind === "git-trust" ? "prq_confirm_git" : item.kind === "tools-install" ? "prq_confirm_tools" : "prq_confirm_docker")}</p>
        <pre className="prq-pre" data-testid="prq-confirm-commands">
          <code>{item.commands.join("\n")}</code>
        </pre>
        <p className="small muted">{item.hosts.length > 0 ? t("prq_network", { hosts: item.hosts.join(", ") }) : t("prq_no_network")}</p>
        {running ? (
          <p className="small" role="status">
            {t(item.kind === "tools-install" ? "prq_running_tools" : "prq_running")}
          </p>
        ) : null}
        {failed ? (
          <div className="notice error" role="alert">
            <Icon name="alert" />
            <p>{t("prq_failed", { message: failed })}</p>
          </div>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
        <div className="row">
          <button type="button" className="btn primary" disabled={running} onClick={() => void run()} data-testid="prq-confirm">
            <Icon name="play" />
            {running ? t("prq_running_short") : t("prq_run")}
          </button>
          <button type="button" className="btn" disabled={running} onClick={onClose}>
            {t("prq_cancel")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function Row({ item, platform, onRun, waiting, inEnvironment }: { item: PrerequisiteItem; platform: string; onRun: () => void; waiting: boolean; inEnvironment: boolean }) {
  const x = texts(item, platform);
  const copyOnly = item.action === "copy";
  return (
    <li className="prq-row" data-prerequisite={item.id} data-kind={item.kind}>
      <span className="prq-icon" aria-hidden="true">
        <Icon name={x.icon} />
      </span>
      <div className="grow">
        <div className="row wrap">
          <strong>{x.title}</strong>
          {item.classification === "optional" ? <Pill tone="blue">{t("prq_optional")}</Pill> : null}
        </div>
        <p className="small">{x.text}</p>
        {copyOnly ? <p className="small muted">{t(item.kind === "git-trust" ? "prq_copy_note_git" : "prq_copy_note_sudo")}</p> : null}
        {item.kind === "manual" && item.fix ? <p className="small">{t("prq_manual_fix", { fix: item.fix })}</p> : null}
        {item.action === null && item.kind !== "manual" && item.message ? <p className="small">{item.message}</p> : null}
        {waiting ? (
          <p className="small" role="status" data-testid="prq-waiting">
            {t("prq_docker_waiting")}
          </p>
        ) : null}
        <Commands commands={item.commands} />
      </div>
      <div className="prq-actions">
        {item.action === "run" ? (
          <button type="button" className="btn" onClick={onRun} disabled={waiting} data-testid={`prq-run-${item.id}`}>
            {x.button}
          </button>
        ) : null}
        {copyOnly ? <CopyButton text={item.commands.join("\n")} /> : null}
        {item.kind === "tools-install" && !inEnvironment ? (
          <a className="prq-link" href="#/environment">
            {t("prq_see_environment")}
          </a>
        ) : null}
      </div>
    </li>
  );
}

/** How long the bar keeps checking after Docker was asked to start (its daemon takes a while to answer). */
const DOCKER_WAIT_MS = 120_000;
const DOCKER_POLL_MS = 4_000;
/** How long the all-clear line stays on the Overview after the last item was fixed. */
const READY_LINGER_MS = 4_000;

/**
 * `showReady` keeps an all-clear line when nothing is missing; `inEnvironment` is the bar inside the Environment screen,
 * which has its own "check again" and is where "see in Environment" leads.
 */
export function PrerequisitesBar({ showReady = false, inEnvironment = false, onChanged }: { showReady?: boolean; inEnvironment?: boolean; onChanged?: () => void }) {
  const loaded = useAsync(() => api<Report>("GET", "/api/prerequisites"), "prerequisites");
  const [report, setReport] = useState<Report | null>(null);
  const [confirm, setConfirm] = useState<PrerequisiteItem | null>(null);
  const [dockerSince, setDockerSince] = useState<number | null>(null);
  const [fixedAll, setFixedAll] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (loaded.data) setReport(loaded.data);
  }, [loaded.data]);

  // After "Abrir Docker Desktop" the daemon needs time: check again until it answers or the wait runs out.
  useEffect(() => {
    if (dockerSince === null) return;
    const tick = async () => {
      try {
        const r = await api<Report>("GET", "/api/prerequisites");
        setReport(r);
        const still = r.items.some((i) => i.id === "docker");
        if (!still) {
          setDockerSince(null);
          if (r.items.length === 0) setFixedAll(true);
          onChanged?.();
          return;
        }
      } catch {
        // A failed check is retried on the next tick.
      }
      if (Date.now() - dockerSince < DOCKER_WAIT_MS) timer.current = setTimeout(() => void tick(), DOCKER_POLL_MS);
      else setDockerSince(null);
    };
    timer.current = setTimeout(() => void tick(), DOCKER_POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [dockerSince]);

  // On the Overview the all-clear line is a moment, not a fixture: the Doctor celebrates, then the bar leaves.
  const [celebrated, setCelebrated] = useState(false);
  useEffect(() => {
    if (!fixedAll || showReady) return;
    const id = setTimeout(() => setCelebrated(true), READY_LINGER_MS);
    return () => clearTimeout(id);
  }, [fixedAll, showReady]);

  const done = (r: FixResponse) => {
    setConfirm(null);
    setReport(r);
    if (r.outcome.id === "docker" && r.items.some((i) => i.id === "docker")) setDockerSince(Date.now());
    if (r.items.length === 0) setFixedAll(true);
    onChanged?.();
  };

  let state: DoctorState;
  let className = "prq";
  let body: ReactNode;
  if (!report && loaded.error) {
    state = "error";
    className = "prq prq-slim prq-error";
    body = <ErrorNotice error={loaded.error} onRetry={loaded.reload} />;
  } else if (!report) {
    // The diagnosis probes Docker, Git and every tool: say so while it runs instead of leaving a gap.
    state = "checking";
    className = "prq prq-slim prq-checking";
    body = <p className="small">{t("prq_checking")}</p>;
  } else if (report.items.length === 0) {
    if (!showReady && (!fixedAll || celebrated)) return null;
    state = "ok";
    className = "prq prq-slim prq-ready";
    body = (
      <>
        <strong>{t("prq_ready_title")}</strong>
        <p className="small">{t("prq_ready_text")}</p>
      </>
    );
  } else {
    const essential = report.items.filter((i) => i.classification === "essential").length;
    state = "needs-you";
    body = (
      <>
        <span className="eyebrow">{t("prq_eyebrow").toUpperCase()}</span>
        <h2 id="prq-title">{essential > 0 ? (essential === 1 ? t("prq_title_one") : t("prq_title", { count: essential })) : t("prq_title_optional")}</h2>
        <ul className="prq-list">
          {report.items.map((item) => (
            <Row key={item.id} item={item} platform={report.platform} onRun={() => setConfirm(item)} waiting={item.id === "docker" && dockerSince !== null} inEnvironment={inEnvironment} />
          ))}
        </ul>
        <div className="between wrap prq-foot">
          {inEnvironment ? (
            <span />
          ) : (
            <button type="button" className="btn" onClick={loaded.reload} disabled={loaded.loading}>
              <Icon name="refresh" />
              {t("prq_recheck")}
            </button>
          )}
          <span className="small muted">{t("prq_consent")}</span>
        </div>
        {confirm ? <ConfirmDialog item={confirm} platform={report.platform} onClose={() => setConfirm(null)} onDone={done} /> : null}
      </>
    );
  }

  // One section and one Doctor for every state, so the mascot stays mounted and plays the change between states.
  return (
    <section className={className} data-testid="prerequisites" data-state={state} aria-live="polite" {...(state === "needs-you" ? { "aria-labelledby": "prq-title" } : {})}>
      <DoctorAvatar state={state} />
      <div className="grow prq-body">{body}</div>
    </section>
  );
}
