import { useEffect, useMemo, useState } from "react";
import { yamlHref } from "../../forms/derived/api";
import { ApiError, api } from "../../api";
import { useShell } from "../../app/shell-context";
import { DiffView } from "../../components/DiffView";
import { ErrorNotice, Loading, Pill, Spinner, Updating, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { Stepper } from "../../components/Stepper";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import "./services.css";

// Configuração > Serviços (PLAN-guided-ux.md section 8): the compose files, the role of every service, the host effects
// in plain words, the application under test, a start-up test and the preview of what jgates.yml gets before it is saved.
// Every value that has a known set (role, service, port, timeout) is a select; only the paths are typed.
export const screen: ScreenMeta = { id: "services", path: "/config/services", area: "config", navLabel: "svc_nav", navPath: "/config/services", order: 46, icon: "settings" };

type Role = "dependency" | "application" | "unused";
const ROLES: Role[] = ["dependency", "application", "unused"];
const TIMEOUTS = [60, 120, 300, 600, 1200];
const STEPS = ["files", "roles", "target", "review"] as const;
type Step = (typeof STEPS)[number];

interface HostEffect {
  service: string;
  kind: string;
  detail: string;
  insideProject?: boolean;
}

interface Service {
  name: string;
  file: string;
  image: string | null;
  build: { context: string } | null;
  ports: number[];
  healthcheck: boolean;
  dependsOn: string[];
  profiles: string[];
  role: "dependency" | "application" | null;
  hostEffects: HostEffect[];
}

interface Discovery {
  files: string[];
  problems: string[];
  services: Service[];
}

interface View {
  configured: boolean;
  configFile: boolean;
  revision: string | null;
  found: string[];
  selected: string[];
  config: { target: { service: string; port: number; path: string; health: string | null } | null; build: "allow" | "forbid"; writableBinds: string[]; allowHostEffects: string[]; timeoutSeconds: number; profiles?: string[] | null } | null;
  roles: Record<string, Role>;
  discovery: Discovery;
  acknowledged: boolean;
  /** The current target of each zap and schemathesis instance (null: none). */
  instanceTargets?: Array<{ tool: string; target: string | null }>;
}

interface Preview {
  diff: string;
  changed: boolean;
  targets: Array<{ tool: string; before: string | null; after: string }>;
  effects: HostEffect[];
  confirmed: boolean;
}

interface TestResult {
  state: "ready" | "not-ready";
  failed: string | null;
  states: Array<{ service: string; state: string; health: string }>;
  log: string;
  stopped: boolean;
}

/** The services that start: the ones with a role and what they depend on. */
function startedOf(services: Service[], roles: Record<string, Role>): Set<string> {
  const by = new Map(services.map((s) => [s.name, s]));
  const out = new Set<string>();
  const visit = (name: string) => {
    if (out.has(name) || !by.has(name)) return;
    out.add(name);
    for (const d of by.get(name)?.dependsOn ?? []) visit(d);
  };
  for (const s of services) if ((roles[s.name] ?? "dependency") !== "unused") visit(s.name);
  return out;
}

/** A refusal of the services routes in the user's language when the catalog knows its code; any other failure as it is. */
function Problem({ error }: { error: unknown }) {
  if (error instanceof ApiError && tOr(`svc_err_${error.code}`, "") !== "") {
    return (
      <div className="notice error" role="alert" data-testid="svc-error" data-code={error.code}>
        <Icon name="alert" />
        <p>{t(`svc_err_${error.code}`, { service: String(error.body.service ?? ""), file: String(error.body.file ?? "") })}</p>
      </div>
    );
  }
  return <ErrorNotice error={error} />;
}

function EffectLine({ effect, unused }: { effect: HostEffect; unused: boolean }) {
  const project = effect.kind === "bind-mount" && effect.insideProject === true;
  const key = project ? "svc_effect_project_bind" : `svc_effect_${effect.kind.replace(/-/g, "_")}`;
  return (
    <li className={unused ? "muted" : undefined} data-effect={effect.kind} data-testid="svc-effect">
      {project ? <Icon name="info" /> : <Icon name="alert" />}
      <span>
        {tOr(key, effect.kind)} <code>{effect.detail}</code>
        {unused ? ` ${t("svc_effect_unused")}` : ""}
      </span>
    </li>
  );
}

export default function ServicesScreen() {
  const shell = useShell();
  const governed = shell.info?.mode === "governed";
  const [reload, setReload] = useState(0);
  const view = useAsync<View>(() => api("GET", "/api/services"), `services:${reload}`);
  const [compose, setCompose] = useState<string[]>([]);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [roles, setRoles] = useState<Record<string, Role>>({});
  const [port, setPort] = useState<number | null>(null);
  const [basePath, setBasePath] = useState("");
  const [healthPath, setHealthPath] = useState("");
  const [build, setBuild] = useState(false);
  const [writable, setWritable] = useState<string[]>([]);
  const [allow, setAllow] = useState<string[]>([]);
  const [timeout, setTimeoutSeconds] = useState(120);
  // services.profiles: the compose profiles a run starts (kept in the order of the file).
  const [composeProfiles, setComposeProfiles] = useState<string[]>([]);
  const [setTargets, setSetTargets] = useState(true);
  const [extra, setExtra] = useState("");
  const [extraFiles, setExtraFiles] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<null | "discover" | "preview" | "save" | "test">(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [step, setStep] = useState<Step>("files");

  const data = view.data;
  useEffect(() => {
    if (!data) return;
    setCompose(data.selected);
    setDiscovery(data.discovery);
    setRoles(data.roles);
    const target = data.config?.target ?? null;
    const app = Object.entries(data.roles).find(([, r]) => r === "application")?.[0] ?? null;
    const appService = data.discovery.services.find((s) => s.name === app);
    setPort(target?.port ?? appService?.ports[0] ?? null);
    setBasePath(target && target.path !== "/" ? target.path : "");
    setHealthPath(target?.health ?? "");
    setBuild(data.config?.build === "allow");
    setWritable(data.config?.writableBinds ?? []);
    setAllow(data.config?.allowHostEffects ?? []);
    setTimeoutSeconds(data.config?.timeoutSeconds ?? 120);
    setComposeProfiles(data.config?.profiles ?? []);
    // "Usar como alvo" starts checked unless it would replace a target written by hand (a URL of an instance).
    setSetTargets((data.instanceTargets ?? []).every((i) => i.target === null || i.target.startsWith("service:")));
    setExtraFiles([]);
    setPreview(null);
    setTest(null);
    setAck(false);
  }, [data]);

  const services = discovery?.services ?? [];
  const application = Object.entries(roles).find(([, r]) => r === "application")?.[0] ?? null;
  const appService = services.find((s) => s.name === application) ?? null;
  const started = useMemo(() => startedOf(services, roles), [services, roles]);
  const files = useMemo(() => [...new Set([...(data?.found ?? []), ...compose, ...extraFiles])], [data, compose, extraFiles]);
  // The profiles the compose files declare, then those written in jgates.yml that no file declares (kept, and said so).
  const discoveredProfiles = useMemo(() => [...new Set(services.flatMap((s) => s.profiles))].sort(), [services]);
  const profileChoices = useMemo(() => [...discoveredProfiles, ...composeProfiles.filter((p) => !discoveredProfiles.includes(p))], [discoveredProfiles, composeProfiles]);
  const timeoutChoices = useMemo(() => (TIMEOUTS.includes(timeout) ? TIMEOUTS : [...TIMEOUTS, timeout].sort((a, b) => a - b)), [timeout]);
  const effectKinds = useMemo(() => [...new Set(services.filter((s) => started.has(s.name)).flatMap((s) => s.hostEffects).filter((e) => !(e.kind === "bind-mount" && e.insideProject)).map((e) => e.kind))], [services, started]);

  if (view.error) return <ErrorNotice error={view.error} onRetry={view.reload} />;
  if (!data || !discovery) return <Loading />;

  const body = () => ({
    compose,
    roles,
    target: application && port !== null ? { port, ...(basePath ? { path: basePath } : {}), ...(healthPath ? { health: healthPath } : {}) } : null,
    build: build ? "allow" : "forbid",
    writableBinds: writable.filter((w) => started.has(w)),
    allowHostEffects: allow.filter((k) => effectKinds.includes(k)),
    timeoutSeconds: timeout,
    setTargets,
    profiles: composeProfiles,
  });
  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  // The list changes only when the server accepts it (a file that does not exist is refused and never listed).
  const applyFiles = async (next: string[]) => {
    const found = await api<{ roles: Record<string, Role>; discovery: Discovery }>("POST", "/api/services/discover", { compose: next });
    setCompose(next);
    setPreview(null);
    setTest(null);
    setDiscovery(found.discovery);
    setRoles((old) => Object.fromEntries(Object.entries(found.roles).map(([n, r]) => [n, old[n] ?? r])));
  };
  const changeFiles = (next: string[]) => run("discover", () => applyFiles(next));
  const toggleFile = (file: string, on: boolean) => {
    const next = on ? [...compose, file] : compose.filter((f) => f !== file);
    // The order of the list is the order of the files (later files override earlier ones).
    void changeFiles(files.filter((f) => next.includes(f)));
  };
  const addFile = () => {
    const file = extra.trim().replace(/\\/g, "/");
    if (!file) return;
    void run("discover", async () => {
      await applyFiles([...compose.filter((f) => f !== file), file]);
      setExtra("");
      setExtraFiles((old) => (old.includes(file) ? old : [...old, file]));
    });
  };
  const setRole = (name: string, role: Role) => {
    setPreview(null);
    setRoles((old) => {
      const next = { ...old, [name]: role };
      if (role === "application") for (const [n, r] of Object.entries(old)) if (n !== name && r === "application") next[n] = "dependency";
      return next;
    });
    if (role === "application") setPort(services.find((s) => s.name === name)?.ports[0] ?? null);
  };
  const chooseApplication = (name: string) => {
    if (name === "") {
      if (application) setRole(application, "dependency");
      setPort(null);
      return;
    }
    setRole(name, "application");
  };

  const showPreview = () =>
    run("preview", async () => {
      const p = await api<Preview>("POST", "/api/services/preview", body());
      setPreview(p);
      setAck(false);
      setSaved(false);
    });
  const save = () =>
    run("save", async () => {
      await api("PUT", "/api/services", { ...body(), revision: data.revision, acknowledged: ack });
      setSaved(true);
      setPreview(null);
      setReload((n) => n + 1);
    });
  const startTest = () =>
    run("test", async () => {
      setTest(null);
      const r = await api<{ result: TestResult }>("POST", "/api/services/test", body());
      setTest(r.result);
    });

  const noConfig = !data.configFile;
  const readOnly = governed || noConfig;
  const needsPort = application !== null && port === null;
  const stepIndex = STEPS.indexOf(step);
  const canPreview = !readOnly && busy === null && services.length > 0 && !needsPort;

  return (
    <div className="stack" data-testid="services-screen" aria-busy={view.reloading}>
      <div>
        <h1>{t("svc_title")}</h1>
        <p>{t("svc_lead")}</p>
      </div>
      <Updating active={view.reloading} />
      {governed ? (
        <div className="notice warn" role="status" data-testid="svc-governed">
          <Icon name="lock" />
          <p className="small">{t("svc_governed")}</p>
        </div>
      ) : null}
      {noConfig ? (
        <div className="notice warn" role="status" data-testid="svc-noconfig">
          <Icon name="alert" />
          <p className="small">{t("svc_noconfig")}</p>
        </div>
      ) : null}
      <Stepper label={t("svc_steps_label")} current={step} onSelect={(id) => setStep(id as Step)} steps={STEPS.map((id, i) => ({ id, label: t(`svc_step_${id}`), disabled: busy !== null, done: i < stepIndex }))} />
      {error ? <Problem error={error} /> : null}
      {saved ? (
        <div className="notice ok" role="status" data-testid="svc-saved">
          <Icon name="check" />
          <p>{t("svc_saved")}</p>
        </div>
      ) : null}

      {step === "files" ? (
      <section className="card pad stack" aria-labelledby="svc-files-title">
        <h2 id="svc-files-title">{t("svc_files_title")}</h2>
        <p className="small muted">{t("svc_files_help")}</p>
        {files.length === 0 ? <p data-testid="svc-no-files">{t("svc_files_none")}</p> : null}
        <ul className="svc-list" role="group" aria-label={t("svc_files_title")}>
          {files.map((f) => (
            <li key={f}>
              <label className="row">
                <input type="checkbox" checked={compose.includes(f)} disabled={readOnly || busy !== null} onChange={(e) => toggleFile(f, e.target.checked)} />
                <code>{f}</code>
              </label>
            </li>
          ))}
        </ul>
        <div className="row wrap">
          <label className="stack tight grow">
            <span className="small">{t("svc_files_add_label")}</span>
            <input className="input" type="text" data-free-text="path" value={extra} placeholder="docker/compose.test.yaml" autoComplete="off" spellCheck={false} disabled={readOnly} onChange={(e) => setExtra(e.target.value)} />
          </label>
          <button type="button" className="btn" disabled={readOnly || busy !== null || extra.trim() === ""} onClick={addFile}>
            {t("svc_files_add")}
          </button>
        </div>
        {discovery.problems.map((p) => (
          <div key={p} className="notice warn" role="status">
            <Icon name="alert" />
            <p className="small">{t("svc_problem", { detail: p })}</p>
          </div>
        ))}
      </section>
      ) : null}

      {step === "roles" ? (
      <section className="card pad stack" aria-labelledby="svc-services-title">
        <h2 id="svc-services-title">{t("svc_services_title")}</h2>
        {services.length === 0 ? <p>{t("svc_services_none")}</p> : null}
        <ul className="svc-list">
          {services.map((s) => {
            const role = roles[s.name] ?? "dependency";
            const projectBinds = s.hostEffects.some((e) => e.kind === "bind-mount" && e.insideProject);
            return (
              <li key={s.name} className="card flat stack" data-testid="svc-service" data-service={s.name}>
                <div className="between wrap">
                  <h3>{s.name}</h3>
                  <div className="row wrap">
                    {s.role ? <Pill tone="blue">{t(`svc_suggested_${s.role}`)}</Pill> : null}
                    {started.has(s.name) && role === "unused" ? <Pill>{t("svc_needed")}</Pill> : null}
                  </div>
                </div>
                <p className="small">{s.image ? t("svc_from_image", { image: s.image }) : s.build ? t("svc_from_build", { context: s.build.context }) : t("svc_from_unknown")}</p>
                <label className="stack tight">
                  <span className="small">{t("svc_role_label", { service: s.name })}</span>
                  <select className="input" data-testid={`svc-role-${s.name}`} value={role} disabled={readOnly} onChange={(e) => setRole(s.name, e.target.value as Role)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`svc_role_${r}`)}
                      </option>
                    ))}
                  </select>
                </label>
                {s.hostEffects.length > 0 ? (
                  <div className="stack tight">
                    <strong className="small">{t("svc_effects_title")}</strong>
                    <ul className="svc-effects">
                      {s.hostEffects.map((e, i) => (
                        <EffectLine key={i} effect={e} unused={!started.has(s.name)} />
                      ))}
                    </ul>
                  </div>
                ) : null}
                {projectBinds && started.has(s.name) ? (
                  <label className="row">
                    <input type="checkbox" data-testid={`svc-writable-${s.name}`} checked={writable.includes(s.name)} disabled={readOnly} onChange={(e) => setWritable((old) => (e.target.checked ? [...old, s.name] : old.filter((n) => n !== s.name)))} />
                    <span className="small">{t("svc_writable", { service: s.name })}</span>
                  </label>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
      ) : null}

      {step === "target" ? (
      <section className="card pad stack" aria-labelledby="svc-app-title">
        <h2 id="svc-app-title">{t("svc_app_title")}</h2>
        <p className="small muted">{t("svc_app_help")}</p>
        <div className="row wrap">
          <label className="stack tight">
            <span className="small">{t("svc_app_service")}</span>
            <select className="input" data-testid="svc-app-service" value={application ?? ""} disabled={readOnly} onChange={(e) => chooseApplication(e.target.value)}>
              <option value="">{t("svc_app_none")}</option>
              {services.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="stack tight">
            <span className="small">{t("svc_app_port")}</span>
            {appService && appService.ports.length > 0 ? (
              <select className="input" data-testid="svc-app-port" value={port === null ? "" : String(port)} disabled={readOnly} onChange={(e) => setPort(Number(e.target.value))}>
                {appService.ports.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            ) : (
              <input className="input number" type="number" min={1} max={65535} data-free-text="port-undeclared" data-testid="svc-app-port" value={port ?? ""} disabled={readOnly || !application} onChange={(e) => setPort(e.target.value === "" ? null : Number(e.target.value))} />
            )}
          </label>
        </div>
        {application && appService && appService.ports.length === 0 ? <p className="small muted">{t("svc_app_port_undeclared")}</p> : null}
        <div className="row wrap">
          <label className="stack tight">
            <span className="small">{t("svc_app_base")}</span>
            <input className="input" type="text" data-free-text="url-path" data-testid="svc-app-base" value={basePath} placeholder="/" autoComplete="off" spellCheck={false} disabled={readOnly || !application} onChange={(e) => setBasePath(e.target.value)} />
          </label>
          <label className="stack tight">
            <span className="small">{t("svc_app_health")}</span>
            <input className="input" type="text" data-free-text="url-path" data-testid="svc-app-health" value={healthPath} placeholder="/health" autoComplete="off" spellCheck={false} disabled={readOnly || !application} onChange={(e) => setHealthPath(e.target.value)} />
          </label>
        </div>
        {application && port !== null ? (
          <label className="row">
            <input type="checkbox" data-testid="svc-set-targets" checked={setTargets} disabled={readOnly} onChange={(e) => setSetTargets(e.target.checked)} />
            <span className="small">{t("svc_app_targets", { target: `service:${application}:${port}` })}</span>
          </label>
        ) : null}
        <div className="row wrap">
          <button type="button" className="btn" data-testid="svc-test" disabled={busy !== null || services.length === 0 || needsPort} onClick={startTest}>
            {busy === "test" ? <Spinner /> : <Icon name="play" />}
            {busy === "test" ? t("svc_test_running") : t("svc_test")}
          </button>
          <span className="small muted">{t("svc_test_help")}</span>
        </div>
        <div aria-live="polite">
          {test ? (
            <div className={`notice ${test.state === "ready" ? "ok" : "error"}`} role={test.state === "ready" ? "status" : "alert"} data-testid="svc-test-result" data-state={test.state}>
              <Icon name={test.state === "ready" ? "check" : "alert"} />
              <div className="stack tight grow">
                <strong>{test.state === "ready" ? t("svc_test_ready") : t("svc_test_failed", { service: test.failed ?? "-" })}</strong>
                {test.states.length > 0 ? (
                  <ul className="svc-effects">
                    {test.states.map((s) => (
                      <li key={s.service}>
                        <code>{s.service}</code> {s.state}
                        {s.health ? ` (${s.health})` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="small">{test.stopped ? t("svc_test_stopped") : ""}</p>
                <details>
                  <summary>{t("svc_test_logs")}</summary>
                  <pre className="svc-log" tabIndex={0}>
                    {test.log}
                  </pre>
                </details>
              </div>
            </div>
          ) : null}
        </div>
      </section>
      ) : null}

      {step === "review" ? (
      <>
      <details className="card pad" data-testid="svc-customize">
        <summary>{t("svc_custom_title")}</summary>
        <div className="stack">
          <label className="stack tight">
            <span className="small">{t("svc_timeout")}</span>
            <select className="input" data-testid="svc-timeout" value={timeout} disabled={readOnly} onChange={(e) => setTimeoutSeconds(Number(e.target.value))}>
              {timeoutChoices.map((s) => (
                <option key={s} value={s}>
                  {t("svc_timeout_option", { seconds: s })}
                </option>
              ))}
            </select>
          </label>
          <label className="row">
            <input type="checkbox" data-testid="svc-build" checked={build} disabled={readOnly} onChange={(e) => setBuild(e.target.checked)} />
            <span className="small">{t("svc_build")}</span>
          </label>
          {profileChoices.length > 0 ? (
            <fieldset className="stack tight" data-testid="svc-profiles">
              <legend className="small">{t("svc_profiles_title")}</legend>
              <p className="small muted">{t("svc_profiles_help")}</p>
              {profileChoices.map((p) => (
                <label key={p} className="row">
                  <input
                    type="checkbox"
                    value={p}
                    checked={composeProfiles.includes(p)}
                    disabled={readOnly}
                    onChange={(e) => setComposeProfiles((old) => (e.target.checked ? [...old, p] : old.filter((x) => x !== p)))}
                  />
                  <span className="small">
                    <code>{p}</code>
                    {discoveredProfiles.includes(p) ? null : <span className="muted"> {t("svc_profiles_not_found")}</span>}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {effectKinds.length > 0 ? (
            <fieldset className="stack tight">
              <legend className="small">{t("svc_allow_title")}</legend>
              <p className="small muted">{t("svc_allow_help")}</p>
              {effectKinds.map((k) => (
                <label key={k} className="row">
                  <input type="checkbox" checked={allow.includes(k)} disabled={readOnly} onChange={(e) => setAllow((old) => (e.target.checked ? [...old, k] : old.filter((x) => x !== k)))} />
                  <span className="small">{tOr(`svc_kind_${k.replace(/-/g, "_")}`, k)}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <p className="small">
            <a href={yamlHref("jgates.yml", "services")}>{t("svc_edit_yaml")}</a>
          </p>
        </div>
      </details>

      <div className="row wrap">
        <button type="button" className="btn primary" data-testid="svc-preview" disabled={!canPreview} onClick={showPreview}>
          {busy === "preview" ? <Spinner /> : <Icon name="file" />}
          {t("svc_preview")}
        </button>
      </div>

      {preview ? (
        <section className="card pad stack" aria-labelledby="svc-preview-title" data-testid="svc-preview-panel">
          <h2 id="svc-preview-title">{t("svc_preview_title")}</h2>
          {preview.changed ? <DiffView diff={preview.diff} /> : <p>{t("svc_preview_same")}</p>}
          {preview.targets.length > 0 ? (
            <ul className="svc-effects" data-testid="svc-preview-targets">
              {preview.targets.map((x) => (
                <li key={x.tool}>
                  <span>
                    {t("svc_preview_target", { tool: x.tool })} <code>{x.after}</code>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {!preview.confirmed ? (
            <div className="notice warn" data-testid="svc-ack-panel">
              <Icon name="alert" />
              <div className="stack tight">
                <p className="small">{t("svc_ack_lead")}</p>
                <ul className="svc-effects">
                  {preview.effects.map((e, i) => (
                    <EffectLine key={i} effect={e} unused={false} />
                  ))}
                </ul>
                <label className="row">
                  <input type="checkbox" data-testid="svc-ack" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span>{t("svc_ack")}</span>
                </label>
              </div>
            </div>
          ) : null}
          <div className="row wrap">
            <button type="button" className="btn primary" data-testid="svc-save" disabled={busy !== null || (!preview.confirmed && !ack)} onClick={save}>
              <Icon name="check" />
              {busy === "save" ? t("svc_saving") : t("svc_save")}
            </button>
            <button type="button" className="btn" onClick={() => setPreview(null)}>
              {t("svc_preview_close")}
            </button>
          </div>
        </section>
      ) : null}
      </>
      ) : null}

      <div className="row wrap svc-nav">
        <button type="button" className="btn" data-testid="svc-back" disabled={stepIndex === 0 || busy !== null} onClick={() => setStep(STEPS[stepIndex - 1] as Step)}>
          {t("back")}
        </button>
        {stepIndex < STEPS.length - 1 ? (
          <button type="button" className="btn primary" data-testid="svc-next" disabled={busy !== null} onClick={() => setStep(STEPS[stepIndex + 1] as Step)}>
            {t("svc_next")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
