import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ErrorNotice, Loading, Pill } from "../../components/common";
import { Icon } from "../../components/icons";
import { fetchEnvironmentState, useRecheckOnFocus, type EnvironmentState } from "../../api/environment";
import { getLocale, t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { WorkspaceTabs } from "../workspace/tabs";
import { formatBytes } from "../wizard/api";
import type { EnvironmentReason } from "../../api/environment";
import { currentQuery } from "../../app/route";
import { JobButton, PullProgress, ReasonAction, RecipeCommands, Reasons, SectionCard, ageText, firstActionable, mb, useSectionJob, type Sections } from "./sections";
import "./environment.css";

export const screen: ScreenMeta = { id: "environment", path: "/environment", area: "workspace", navLabel: "nav_environment", navPath: "/environment", order: 30, icon: "tools" };

type State = EnvironmentState & { disk?: { freeMb: number | null } };

function useEnvironment() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const read = useCallback((fresh: boolean) => {
    setChecking(true);
    fetchEnvironmentState(getLocale(), undefined, fresh)
      .then((next) => {
        if (!alive.current) return;
        setState(next as State);
        setError(null);
      })
      .catch((e) => alive.current && setError(e))
      .finally(() => alive.current && setChecking(false));
  }, []);
  // Opening the screen reads the server's facts; "check again", the focus and the end of a job ask the engine anew.
  const load = useCallback(() => read(true), [read]);
  useEffect(() => read(false), [read]);
  useRecheckOnFocus(load);
  return { state, error, checking, load };
}

/** "Verificar de novo": the one action of a section that is fine (the screen reads the machine again). */
function Recheck({ label, onClick, checking }: { label: string; onClick: () => void; checking: boolean }) {
  return (
    <button type="button" className="btn" onClick={onClick} disabled={checking}>
      <Icon name="refresh" />
      {label}
    </button>
  );
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Engine({ s, disk, load, checking }: { s: Sections["engine"]; disk: number | null; load: () => void; checking: boolean }) {
  const reason = firstActionable(s.reasons);
  const ready = s.state === "ready";
  const summary = ready
    ? t("env_engine_ready", { version: String(s.serverVersion ?? "?"), memory: mb(s.memoryMb as number | null), cpus: Number(s.cpus ?? 0) })
    : (s.reasons[0]?.message ?? t(`env_engine_${s.state}`));
  return (
    <SectionCard
      id="engine"
      state={s.state}
      summary={summary}
      action={
        reason ? (
          <ReasonAction reason={reason} />
        ) : (s.reasons[0] as { recipe?: unknown } | undefined)?.recipe ? (
          <>
            <RecipeCommands reason={s.reasons[0] as EnvironmentReason} />
            <Recheck label={t("env_recheck_engine")} onClick={load} checking={checking} />
          </>
        ) : (
          <Recheck label={t("env_recheck_engine")} onClick={load} checking={checking} />
        )
      } notices={ready ? null : <Reasons reasons={s.reasons.filter((r) => r !== s.reasons[0] || Boolean(r.details))} />}>
      <dl className="kv">
        <Fact name={t("env_engine_runtime")}>
          <code>{String(s.runtime ?? "-")}</code>
        </Fact>
        <Fact name={t("env_engine_version")}>{String(s.serverVersion ?? t("env_unknown"))}</Fact>
        <Fact name={t("env_engine_system")}>{s.os ? `${s.os}/${s.arch ?? "?"}` : t("env_unknown")}</Fact>
        <Fact name={t("env_engine_memory")}>{mb(s.memoryMb as number | null)}</Fact>
        <Fact name={t("env_engine_cpus")}>{s.cpus === null || s.cpus === undefined ? t("env_unknown") : String(s.cpus)}</Fact>
        <Fact name={t("env_engine_disk")}>{mb(disk)}</Fact>
      </dl>
    </SectionCard>
  );
}

function Image({ s, engineReady, mode, load, checking }: { s: Sections["image"]; engineReady: boolean; mode: string; load: () => void; checking: boolean }) {
  const job = useSectionJob("pull", load);
  const [filter, setFilter] = useState("");
  const tools: Array<{ name: string; version: string }> = s.tools ?? [];
  const shown = tools.filter((x) => x.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const inImage = mode === "in-image";
  const label = s.state === "version-mismatch" ? t("env_image_update") : t("env_image_download");
  const summary = inImage
    ? t("env_image_in_image")
    : s.state === "ready"
      ? t("env_image_ready", { version: String(s.version ?? "?") })
      : (s.reasons[0]?.message ?? t(`env_image_${s.state}`));
  const needsJob = !inImage && (s.state === "missing" || s.state === "version-mismatch");
  const action = needsJob ? (
    <JobButton job={job} label={label} running={t("env_image_pulling")} disabled={!engineReady}>
      {job.state === "running" || job.state === "starting" ? <PullProgress events={job.events} /> : null}
      {!engineReady ? <span className="small muted">{t("env_needs_engine")}</span> : null}
    </JobButton>
  ) : (
    <Recheck label={t("env_image_verify")} onClick={load} checking={checking} />
  );
  return (
    <SectionCard id="image" state={inImage ? "ready" : s.state} summary={summary} action={action} notices={job.state === "failed" ? <p className="notice error" role="alert">{t("env_job_failed")}</p> : null}>
      <dl className="kv">
        <Fact name={t("env_image_version")}>{String(s.version ?? t("env_unknown"))}</Fact>
        <Fact name={t("env_image_expected")}>{String(s.expectedVersion ?? "-")}</Fact>
        <Fact name={t("env_image_reference")}>
          <code className="wrap-anywhere">{String(s.reference ?? "-")}</code>
        </Fact>
        <Fact name={t("env_image_digest")}>
          <code>{String(s.id ?? s.pinDigest ?? "-").replace("sha256:", "").slice(0, 12)}</code>
        </Fact>
        <Fact name={t("env_image_size")}>{s.sizeBytes ? formatBytes(Number(s.sizeBytes)) : t("env_unknown")}</Fact>
      </dl>
      <Reasons reasons={s.reasons.filter((r) => Boolean(r.details))} />
      <div className="stack tight">
        <label htmlFor="env-tool-search">{t("env_tools_search")}</label>
        <input id="env-tool-search" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <p className="small muted" role="status">
          {t("env_tools_count", { shown: shown.length, total: tools.length })}
        </p>
        {shown.length > 0 ? (
          <ul className="env-tools" aria-label={t("env_tools_list")}>
            {shown.map((x) => (
              <li key={x.name}>
                <code>{x.name}</code> <span className="muted">{x.version}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </SectionCard>
  );
}

function Data({ s, imageReady, load }: { s: Sections["data"]; imageReady: boolean; load: () => void }) {
  const job = useSectionJob("data", load);
  const databases: Array<{ id: string; state: string; ageDays: number | null; fetchedAt: string | null }> = s.databases ?? [];
  const summary = s.state === "fresh" ? t("env_data_fresh", { days: Number(s.maxAgeDays ?? 7) }) : (s.reasons[0]?.message ?? t(`env_data_${s.state}`));
  return (
    <SectionCard
      id="data"
      state={s.state}
      summary={summary}
      action={
        <JobButton job={job} label={t("env_data_update")} running={t("env_data_updating")} disabled={!imageReady} primary={s.state !== "fresh"}>
          {!imageReady ? <span className="small muted">{t("env_needs_image")}</span> : null}
          {job.state === "done" ? <span className="small" role="status">{t("env_data_updated")}</span> : null}
          {job.state === "failed" ? <span className="small" role="alert">{t("env_job_failed")}</span> : null}
        </JobButton>
      }
    >
      <p className="small">{t("env_data_threshold", { days: Number(s.maxAgeDays ?? 7) })}</p>
      <div className="table-wrap">
        <table aria-label={t("env_sec_data")}>
          <thead>
            <tr>
              <th scope="col">{t("env_data_col_database")}</th>
              <th scope="col">{t("env_data_col_age")}</th>
              <th scope="col">{t("env_data_col_state")}</th>
            </tr>
          </thead>
          <tbody>
            {databases.map((d) => (
              <tr key={d.id} data-database={d.id} data-state={d.state}>
                <th scope="row">{d.id}</th>
                <td>{ageText(d.ageDays)}</td>
                <td>
                  <Pill tone={d.state === "fresh" ? "green" : d.state === "stale" ? "gold" : "red"}>{t(`env_data_db_${d.state}`)}</Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

function Dependencies({ s, imageReady, load, checking }: { s: Sections["dependencies"]; imageReady: boolean; load: () => void; checking: boolean }) {
  const job = useSectionJob("dependencies", load);
  const units: Array<{ unit: string; components: string[]; state: string }> = s.units ?? [];
  const volumes: Array<{ name: string; sizeBytes: number }> = s.volumes ?? [];
  const pending = s.state === "failed" || s.state === "not-ready";
  const summary = s.state === "none" ? t("env_deps_none") : s.state === "ready" ? t("env_deps_ready", { count: units.length }) : (s.reasons[0]?.message ?? t("env_deps_not_ready"));
  const action = pending ? (
    <JobButton job={job} label={t("env_deps_prepare")} running={t("env_deps_preparing")} disabled={!imageReady}>
      {!imageReady ? <span className="small muted">{t("env_needs_image")}</span> : null}
      {job.state === "failed" ? <span className="small" role="alert">{t("env_job_failed")}</span> : null}
    </JobButton>
  ) : (
    <Recheck label={t("env_recheck_deps")} onClick={load} checking={checking} />
  );
  return (
    <SectionCard id="dependencies" state={s.state} summary={summary} action={action}>
      {units.length === 0 ? (
        <p className="small">{t("env_deps_none_detail")}</p>
      ) : (
        <ul className="env-units" aria-label={t("env_sec_dependencies")}>
          {units.map((u) => {
            const volume = volumes.find((v) => v.name.includes(u.unit));
            return (
              <li key={u.unit} data-unit={u.unit} data-state={u.state}>
                <strong>{u.components.join(", ")}</strong> <code>{u.unit}</code> <Pill tone={u.state === "ready" ? "green" : u.state === "failed" ? "red" : "gold"}>{t(`env_deps_unit_${u.state}`)}</Pill>
                {volume ? <span className="small muted"> · {formatBytes(volume.sizeBytes)}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

function Extension({ s }: { s: Sections["extension"] }) {
  const images: Array<{ name: string; sizeBytes: number }> = s.images ?? [];
  const outdated = firstActionable(s.reasons);
  return (
    <SectionCard
      id="extension"
      state={s.state}
      summary={s.state === "present" ? t("env_extension_present", { count: images.length }) : t("env_extension_none")}
      action={
        outdated ? (
          <ReasonAction reason={outdated} />
        ) : (
          <a className={`btn${s.state === "none" ? " primary" : ""}`} href="#/tools">
            {s.state === "none" ? t("env_extension_add") : t("env_extension_manage")}
          </a>
        )
      }
      notices={<Reasons reasons={s.reasons} />}
    >
      {images.length === 0 ? (
        <p className="small">{t("env_extension_none_detail")}</p>
      ) : (
        <ul className="env-units">
          {images.map((i) => (
            <li key={i.name}>
              <code>{i.name}</code> <span className="muted">{formatBytes(i.sizeBytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function Services({ s }: { s: Sections["services"] }) {
  const compose: string[] = s.compose ?? [];
  const start: string[] | null = s.start ?? null;
  return (
    <SectionCard
      id="services"
      state={s.configured ? s.state : "none"}
      summary={s.configured ? t("env_services_configured", { count: compose.length }) : t("env_services_none")}
      action={
        <a className="btn primary" href="#/config/services" data-testid="env-services-configure">
          {t("env_services_configure")}
        </a>
      }
      notices={<Reasons reasons={s.reasons} />}
    >
      <dl className="kv">
        <Fact name={t("env_services_compose")}>{compose.length > 0 ? compose.map((f) => <code key={f}>{f} </code>) : t("env_services_compose_auto")}</Fact>
        <Fact name={t("env_services_selected")}>{start === null ? t("env_services_selected_auto") : start.join(", ") || "-"}</Fact>
        <Fact name={t("env_services_target")}>{s.target ? <code>{String(s.target)}</code> : t("env_services_target_none")}</Fact>
        <Fact name={t("env_services_running")}>{String(s.running ?? 0)}</Fact>
      </dl>
    </SectionCard>
  );
}

function Codeql({ s, imageReady, load }: { s: Sections["codeql"]; imageReady: boolean; load: () => void }) {
  const [accepted, setAccepted] = useState(false);
  const job = useSectionJob("codeql", load, { acceptTerms: true });
  const prepared = s.state === "prepared";
  const summary = prepared ? t("env_codeql_prepared", { version: String(s.version ?? "?") }) : s.state === "unknown" ? t("env_codeql_unknown") : (s.reasons[0]?.message ?? t("env_codeql_not_prepared"));
  const action = prepared ? (
    <span className="small muted">{t("env_codeql_done")}</span>
  ) : (
    <div className="stack tight grow">
      <p className="small">
        <a href={String(s.termsUrl ?? "")} target="_blank" rel="noopener noreferrer">
          {t("env_codeql_terms_link")}
        </a>
      </p>
      <label className="row">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        <span>{t("env_codeql_accept")}</span>
      </label>
      <div className="row wrap">
        <JobButton job={job} label={t("env_codeql_prepare")} running={t("env_codeql_preparing")} disabled={!accepted || !imageReady}>
          {!imageReady ? <span className="small muted">{t("env_needs_image")}</span> : null}
          {job.state === "failed" ? <span className="small" role="alert">{t("env_job_failed")}</span> : null}
        </JobButton>
      </div>
    </div>
  );
  return (
    <SectionCard id="codeql" state={s.state} summary={summary} action={action}>
      <dl className="kv">
        <Fact name={t("env_codeql_version")}>{String(s.version ?? "-")}</Fact>
        <Fact name={t("env_codeql_prepared_at")}>{s.preparedAt ? String(s.preparedAt) : "-"}</Fact>
      </dl>
      <p className="small">{t("env_codeql_why")}</p>
    </SectionCard>
  );
}

export default function EnvironmentScreen() {
  const { state, error, checking, load } = useEnvironment();
  // `?section=image` (from the overview) lands on that section's heading once the sections are there.
  const wanted = useRef<string | null>(currentQuery().get("section"));
  useEffect(() => {
    if (!state || !wanted.current) return;
    const heading = document.getElementById(`env-h-${wanted.current}`);
    wanted.current = null;
    if (!heading) return;
    heading.setAttribute("tabindex", "-1");
    heading.scrollIntoView({ block: "start" });
    heading.focus();
  }, [state]);
  if (!state && !error) return <Loading />;
  const sections = state?.sections as unknown as Sections | undefined;
  const engineReady = state?.mode === "in-image" || sections?.engine.state === "ready";
  const imageReady = state?.mode === "in-image" || sections?.image.state === "ready";
  // The server's one definition of ready (`ready`, `notReady`), the same the overview and the API use.
  const notReady = state?.notReady?.length ?? 0;
  return (
    <div className="stack">
      <WorkspaceTabs selected="environment" />
      <div className="between wrap">
        <div>
          <h1>{t("env_title")}</h1>
          <p>{t("env_lead")}</p>
        </div>
        <button type="button" className="btn" onClick={load} disabled={checking}>
          <Icon name="refresh" />
          {t("env_recheck")}
        </button>
      </div>
      {error ? <ErrorNotice error={error} onRetry={load} /> : null}
      {sections ? (
        <>
          <div className={`notice ${notReady === 0 ? "ok" : "warn"}`} role="status" data-testid="env-summary" data-ready={notReady === 0}>
            <Icon name={notReady === 0 ? "check" : "alert"} />
            <div>
              <strong>{notReady === 0 ? t("env_ready") : t("env_not_ready", { count: notReady })}</strong>
              <p className="small">{t("env_three_states")}</p>
            </div>
          </div>
          <Engine s={sections.engine} disk={(state as State).disk?.freeMb ?? null} load={load} checking={checking} />
          <Image s={sections.image} engineReady={engineReady} mode={state?.mode ?? "container"} load={load} checking={checking} />
          <Data s={sections.data} imageReady={imageReady} load={load} />
          <Dependencies s={sections.dependencies} imageReady={imageReady} load={load} checking={checking} />
          <Extension s={sections.extension} />
          <Services s={sections.services} />
          <Codeql s={sections.codeql} imageReady={imageReady} load={load} />
        </>
      ) : null}
    </div>
  );
}
