import { useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { Policy, type PolicyView } from "./policy";
import { ProfileCards, type Card, type Starter } from "./profiles";
import { Protect, type CategoryView } from "./protect";
import "./config-profiles.css";

// Configuração > Perfil. The first screen of the Configuração area (its path is the area's own).
export const screen: ScreenMeta = { id: "config-profiles", path: "/config", area: "config", navLabel: "cfgp_nav", navPath: "/config", order: 40, icon: "sliders" };

export default function ConfigProfilesScreen() {
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = () => setRevision((n) => n + 1);

  const list = useAsync(() => api("GET", "/api/profiles"), `profiles:${revision}`);
  const query = selected ? `?profile=${encodeURIComponent(selected)}` : "";
  const view = useAsync(() => api("GET", `/api/config/profile${query}`), `view:${selected ?? "-"}:${revision}`);

  if (list.error) return <ErrorNotice error={list.error} onRetry={list.reload} />;
  if (view.error) return <ErrorNotice error={view.error} onRetry={view.reload} />;
  if (!list.data || !view.data) return <Loading />;

  const cards = (list.data as any).profiles as Card[];
  const starters = (list.data as any).starters as Starter[];
  const v = view.data as any;
  const current = v.profile.ref as string;

  return (
    <div className="stack">
      <div>
        <h1>{t("cfgp_title")}</h1>
        <p>{t("cfgp_lead")}</p>
      </div>

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

      <ProfileCards cards={cards} starters={starters} selected={current} onSelect={setSelected} onChanged={refresh} />

      <div className="cfgp-columns">
        <Protect categories={v.categories as CategoryView[]} profile={current} editable={v.profile.editable === true} onChanged={refresh} />
        <Policy policy={v.policy as PolicyView} governedPolicy={v.governed?.policy ?? null} onChanged={refresh} />
      </div>

      <div className="notice ok">
        <Icon name="info" />
        <p className="small">{t("cfgp_files_note")}</p>
      </div>
    </div>
  );
}
