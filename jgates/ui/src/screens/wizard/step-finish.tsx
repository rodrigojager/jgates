// Steps 5 and 6: the project's dependencies (prepared now, or as soon as the tools finish downloading), each unit with
// what it installs, where it goes and the network it uses, its state taken from the job's result (D27); and the review
// of the first validation, whose primary button starts it.
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading, Pill, Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";
import { advance, fetchDependencies, fetchSetup, prepareDependencies, type DependenciesInfo, type DependencyUnit } from "./api";
import { EquivalentCommand, StepNav, useJob } from "./parts";
import type { StepProps } from "./Wizard";

const STATE_TONE: Record<string, "green" | "gold" | "red" | "blue" | undefined> = { ready: "green", failed: "red", outdated: "gold", missing: undefined, "not-ready": undefined };

interface UnitEvent {
  unit: { unit: string; status: string; message: string; details: string | null; volume?: string | null };
}

/** A unit's state from the outcome of the job that prepared it (D27): installed or reused is ready. */
const OUTCOME_STATE: Record<string, string> = { installed: "ready", reused: "ready", failed: "failed", "not-ready": "not-ready" };

/** What the preparation installs, where it goes and the network it uses, for one unit. */
function UnitFacts({ u, volume }: { u: DependencyUnit; volume: string | null }) {
  const files = (u.install?.files ?? []).join(", ") || (u.lockfile ?? u.installRoot);
  const installs = u.blocked
    ? t("wizard_deps_installs_blocked", { reason: u.blocked })
    : u.install?.mode === "frozen"
      ? t("wizard_deps_installs_frozen", { files: u.lockfile ?? files })
      : t("wizard_deps_installs_manifest", { files });
  const network = u.network.registry ? t(u.network.private ? "wizard_deps_network_private" : "wizard_deps_network_registry", { registry: u.network.registry }) : t("wizard_deps_network_unknown");
  return (
    <dl className="wizard-facts small">
      <dt>{t("wizard_deps_fact_manager")}</dt>
      <dd data-fact="manager">{u.manager ?? "?"}</dd>
      <dt>{t("wizard_deps_fact_lockfile")}</dt>
      <dd data-fact="lockfile" className="mono">
        {u.lockfile ?? t("wizard_project_no_lockfile")}
      </dd>
      <dt>{t("wizard_deps_fact_language")}</dt>
      <dd data-fact="language">{u.languageVersion ? `${u.ecosystem} ${u.languageVersion}` : u.ecosystem}</dd>
      <dt>{t("wizard_deps_fact_installs")}</dt>
      <dd data-fact="installs">
        {installs}
        {u.install && u.install.commands.length > 0 ? (
          <span className="stack tight">
            {u.install.commands.map((c) => (
              <code key={c} className="wizard-break">
                {c}
              </code>
            ))}
          </span>
        ) : null}
      </dd>
      <dt>{t("wizard_deps_fact_where")}</dt>
      <dd data-fact="volume">{t("wizard_deps_volume", { volume: volume ?? u.volume.name ?? t("wizard_deps_volume_pending", { prefix: u.volume.prefix }), target: u.volume.target ?? "/workspace" })}</dd>
      <dt>{t("wizard_deps_fact_network")}</dt>
      <dd data-fact="network">{network}</dd>
    </dl>
  );
}

export function DependenciesStep({ view, act, apply, busy, back }: StepProps) {
  const [info, setInfo] = useState<DependenciesInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    fetchDependencies().then((next) => {
      setInfo(next);
      setError(null);
    }, setError);
  }, []);
  useEffect(load, [load]);

  const depsRef = view.setup.jobs.dependencies;
  const pullRef = view.setup.jobs.pull;
  const deps = useJob(depsRef?.id ?? null, depsRef?.known ?? true);
  const pull = useJob(view.setup.dependencies === "queued" ? (pullRef?.id ?? null) : null, pullRef?.known ?? true);
  // The pull ended: the server started the queued dependencies; learn their job.
  const pullState = pull?.state ?? null;
  useEffect(() => {
    if (pullState === "done" || pullState === "failed") fetchSetup().then(apply, () => undefined);
  }, [pullState, apply]);
  const depsState = deps?.state ?? null;
  useEffect(() => {
    if (depsState === "done" || depsState === "failed") load();
  }, [depsState, load]);

  if (!info) return error ? <ErrorNotice error={error} onRetry={load} /> : <Loading />;
  const outcomes = new Map((deps?.events ?? []).filter((e) => e.type === "dependencies-unit").map((e) => [(e as unknown as UnitEvent).unit.unit, (e as unknown as UnitEvent).unit]));
  const queued = view.setup.dependencies === "queued";
  const running = deps?.state === "running";
  // The state of each unit comes from the job that prepared it, once it ended; before that, from the engine.
  const stateOf = (u: DependencyUnit): string => {
    const outcome = outcomes.get(u.unit);
    return outcome ? (OUTCOME_STATE[outcome.status] ?? u.state) : u.state;
  };
  const pending = info.units.filter((u) => stateOf(u) !== "ready");
  const failed = info.units.some((u) => stateOf(u) === "failed") || deps?.state === "failed";

  return (
    <div className="stack" data-testid="wizard-step-dependencies">
      <p className="wizard-lead">{t("wizard_deps_lead")}</p>
      {error ? <ErrorNotice error={error} /> : null}
      {info.units.length === 0 ? <p>{t("wizard_deps_none")}</p> : null}
      <ul className="wizard-cards" aria-label={t("wizard_deps_list")}>
        {info.units.map((u) => {
          const outcome = outcomes.get(u.unit);
          const state = stateOf(u);
          return (
            <li key={u.unit} className="card flat stack" data-unit={u.unit} data-state={state}>
              <div className="row wrap">
                <strong className="mono">{u.unit}</strong>
                <Pill tone={STATE_TONE[state]}>{tOr(`wizard_deps_state_${state.replace(/-/g, "_")}`, state)}</Pill>
              </div>
              <UnitFacts u={u} volume={outcome?.volume ?? null} />
              {u.components.length > 1 ? <p className="small muted">{t("wizard_deps_components", { components: u.components.join(", ") })}</p> : null}
              {outcome ? (
                <details>
                  <summary>{outcome.message}</summary>
                  {outcome.details ? <pre className="wizard-pre">{outcome.details}</pre> : <p className="small muted">{t("wizard_deps_no_log")}</p>}
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div role="status" aria-live="polite" data-testid="wizard-deps-status" data-state={queued ? "queued" : running ? "running" : (deps?.state ?? view.setup.dependencies)}>
        {queued ? <p className="notice">{t("wizard_deps_queued")}</p> : null}
        {running ? <p className="spinner-text">{t("wizard_deps_running")}</p> : null}
        {deps?.state === "done" ? <p>{t("wizard_deps_done")}</p> : null}
        {!queued && !running && info.units.length > 0 && pending.length === 0 ? <p data-testid="wizard-deps-ready">{t("wizard_deps_all_ready")}</p> : null}
      </div>
      {failed && !running ? <p className="notice error" role="alert">{t("wizard_deps_failed")}</p> : null}
      {/* Only while something is left to prepare: once the job made every unit ready there is nothing to press (D27). */}
      {pending.length > 0 && !queued && !running ? (
        <div className="row wrap">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void act(prepareDependencies)}>
            <Icon name="play" />
            {failed ? t("wizard_deps_retry") : t("wizard_deps_prepare")}
          </button>
        </div>
      ) : null}
      <EquivalentCommand command="jgates deps prepare" />
      <StepNav onBack={back} busy={busy} onSkip={pending.length > 0 ? () => void act(() => advance("dependencies", { skip: true })) : null} onNext={() => void act(() => advance("dependencies"))} />
    </div>
  );
}
