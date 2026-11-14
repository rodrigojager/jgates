import { api } from "../api";
import type { MascotDomain, MascotSnapshot } from "../../../src/core/mascots/index";
import { useAsync } from "./common";
import { QualityMascotStrip } from "./QualityMascotStrip";

/**
 * The quality strip of the project's own profile, for the screens where categories are the subject but no plan is at
 * hand (Templates, the tools catalogue, the own-tool dialog). It asks for the configuration part of the plan, which reads
 * the engine facts from their cache, and holds its room while that answers.
 */
export function ProjectMascotStrip({ onSelect }: { onSelect?: (domain: MascotDomain, ids: string[]) => void }) {
  const loaded = useAsync(() => api<{ mascots?: MascotSnapshot | null }>("GET", "/api/config/profile/plan"), "project-mascots");
  return <QualityMascotStrip snapshot={loaded.data?.mascots ?? null} loading={loaded.loading} {...(onSelect ? { onSelect } : {})} />;
}
