import { QualityMascotStrip } from "../../components/QualityMascotStrip";
import { useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading, Updating, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { DerivedForm } from "../../forms/derived/DerivedForm";
import { ConfigDiagnostics, diagnosticsOf } from "./diagnostics";
import { ProfileEditor, type ScrollRequest } from "./editor";
import { ProfileCards, type Card, type Starter, type WriteAnswer } from "./profiles";
import { Protect, type CategoryView, type SelectorGroup } from "./protect";
import "./config-profiles.css";

// Configuração > Perfil. The first screen of the Configuração area (its path is the area's own).
export const screen: ScreenMeta = { id: "config-profiles", path: "/config", area: "config", navLabel: "cfgp_nav", navPath: "/config", order: 40, icon: "sliders" };

const nameOfView = (cards: Card[], ref: string): string => {
  const card = cards.find((c) => c.ref === ref);
  return card ? (card.label ?? card.id) : ref.replace(/^builtin:/, "");
};

export default function ConfigProfilesScreen() {
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null);
  const refresh = () => setRevision((n) => n + 1);
  // Writes made outside the editor form (the tree, the cards): the form reads its file again so its revision is the current one.
  const [writes, setWrites] = useState(0);

  const list = useAsync(() => api("GET", "/api/profiles"), `profiles:${revision}`);
  const query = selected ? `?profile=${encodeURIComponent(selected)}` : "";
  const view = useAsync(() => api("GET", `/api/config/profile${query}`), `view:${selected ?? "-"}:${revision}`);
  // What the plan says about each capability here and the mascots: asked next to the view, never holding the screen.
  const availability = useAsync(() => api("GET", `/api/config/profile/plan${query}`), `plan:${selected ?? "-"}:${revision}`);
  const planPart = (availability.data as any) ?? null;

  // A write answers with the updated list and view (ADR-0010): they go in place of the requests; only the plan part is asked.
  const applyAnswer = (answer: WriteAnswer | null, next?: string | null) => {
    setWrites((n) => n + 1);
    const target = next === undefined ? selected : next;
    if (answer?.profiles && answer.view) {
      list.prime(answer.profiles as any, `profiles:${revision}`);
      view.prime(answer.view as any, `view:${target ?? "-"}:${revision}`);
      // A new profile on screen changes the plan key, which asks by itself; the same one is asked again by hand.
      if (target === selected) availability.reload();
      setSelected(target);
    } else {
      setSelected(target);
      refresh();
    }
  };
  // A write of the profile on screen (selection, policy): its answer carries the view; the cards read their changes again.
  const applyView = (answer: { view?: unknown } | null) => {
    setWrites((n) => n + 1);
    if (answer?.view) {
      view.prime(answer.view as any);
      list.reload();
      availability.reload();
    } else refresh();
  };

  // An invalid key in a configuration file: the screen stays, with the diagnostics (file, key, line) and the way to the YAML editor.
  const diagnostics = diagnosticsOf(list.error) ?? diagnosticsOf(view.error);
  if (diagnostics) {
    return (
      <div className="stack">
        <div>
          <h1>{t("cfgp_title")}</h1>
          <p>{t("cfgp_lead")}</p>
        </div>
        <ConfigDiagnostics
          diagnostics={diagnostics}
          onRetry={() => {
            list.reload();
            view.reload();
          }}
        />
        <div className="notice ok">
          <Icon name="info" />
          <p className="small">{t("cfgp_files_note")}</p>
        </div>
      </div>
    );
  }
  if (list.error) return <ErrorNotice error={list.error} onRetry={list.reload} />;
  if (view.error) return <ErrorNotice error={view.error} onRetry={view.reload} />;
  if (!list.data || !view.data) return <Loading />;

  const cards = (list.data as any).profiles as Card[];
  const starters = (list.data as any).starters as Starter[];
  const v = view.data as any;
  const current = v.profile.ref as string;

  return (
    <div className="stack" aria-busy={list.reloading || view.reloading}>
      <div>
        <h1>{t("cfgp_title")}</h1>
        <p>{t("cfgp_lead")}</p>
      </div>
      <Updating active={list.reloading || view.reloading} />

      {/* A key written by hand that the schema refuses: the profile is still shown as the files hold it. */}
      {((v.diagnostics ?? []) as any[]).length > 0 ? (
        <ConfigDiagnostics
          readable
          diagnostics={v.diagnostics}
          onRetry={() => {
            list.reload();
            view.reload();
          }}
        />
      ) : null}

      {(v.selectionErrors as any[]).length > 0 ? (
        <div className="notice warn" role="alert">
          <Icon name="alert" />
          <div>
            <strong>{t("cfgp_selection_errors")}</strong>
            <ul>
              {(v.selectionErrors as any[]).map((e, i) => (
                <li key={i}>
                  {e.message}
                  {e.fix ? <span className="small muted"> {e.fix}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <ProfileCards cards={cards} starters={starters} selected={current} followsDefault={selected === null} onSelect={(ref) => { setSelected(ref); setScrollRequest((r) => ({ ref, n: (r?.n ?? 0) + 1 })); }} onChanged={applyAnswer} />

      <QualityMascotStrip snapshot={planPart?.profile === current ? planPart.mascots : null} loading={availability.loading} />
      <ProfileEditor
        profile={current}
        id={v.profile.id as string}
        name={nameOfView(cards, current)}
        file={v.profile.file as string}
        writes={writes}
        editable={v.profile.editable === true}
        request={scrollRequest}
        onHandled={() => setScrollRequest(null)}
        onChanged={() => {
          list.reload();
          view.reload();
        }}
      />
      <Protect
        categories={v.categories as CategoryView[]}
        selectors={(v.selectors ?? []) as SelectorGroup[]}
        universe={v.universe as { components: string[]; tools: string[] }}
        plan={planPart?.profile === current ? (planPart.plan ?? null) : null}
        profile={current}
        editable={v.profile.editable === true}
        onChanged={applyView}
      />
      {/* The project's own defaults in jgates.yml (scope, paths, gates... of a validation that names nothing) and the
          configuration files it extends: every key with its control, written one at a time. The default profile is the
          cards' "Marcar como padrão". */}
      <section className="card pad stack" aria-labelledby="cfgp-defaults-title" data-testid="project-defaults">
        <h2 id="cfgp-defaults-title">{t("cfgp_defaults_title")}</h2>
        <p className="small muted">{t("cfgp_defaults_lead")}</p>
        <DerivedForm
          key={`defaults:${writes}`}
          source={{ file: "jgates.yml" }}
          include={(f) => (f.path[0] === "selection" && f.path[1] !== "profile") || f.path[0] === "extends"}
          onWrite={() => {
            list.reload();
            view.reload();
          }}
        />
      </section>

      <div className="notice ok" data-testid="policy-pointer">
        <Icon name="lock" />
        <p className="small">
          {t("cfgp_policy_moved")} <a href="#/policy">{t("cfgp_policy_moved_link")}</a>
        </p>
      </div>

      <div className="notice ok">
        <Icon name="info" />
        <p className="small">{t("cfgp_files_note")}</p>
      </div>
    </div>
  );
}
