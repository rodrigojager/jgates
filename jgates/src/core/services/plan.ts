// What the plan says about the services (PLAN-services.md section 6): the names it selected (part of the plan hash, in
// inputs.container.services), one warning per host effect of the services that start (the review lists them before the
// first run with services), the builds compose would run, and, in a governed plan, a blocker for every host effect the
// policy does not allow.
import { translator } from "../../i18n/index.js";
import type { PlanBlocker } from "../plan/types.js";
import { needsPermission, selectServices, type SelectServicesInput } from "./selection.js";

export type PlanServicesInput = SelectServicesInput;

export interface PlanServices {
  services: string[];
  warnings: Array<{ code: string; message: string }>;
  blockers: PlanBlocker[];
}

export function planServices(input: PlanServicesInput): PlanServices {
  const t = translator("services");
  const selection = selectServices(input);
  if (!selection || !selection.config) return { services: [], warnings: [], blockers: [] };
  const warnings: PlanServices["warnings"] = [];
  for (const problem of selection.discovery?.problems ?? []) warnings.push({ code: "SERVICES_COMPOSE_UNREADABLE", message: t("services_compose_unreadable", { detail: problem }) });
  if (selection.unknown.length > 0) warnings.push({ code: "SERVICES_UNKNOWN", message: t("services_unknown", { service: selection.unknown.join(", ") }) });
  for (const effect of selection.hostEffects) {
    const projectBind = effect.kind === "bind-mount" && effect.insideProject === true;
    const writable = projectBind && selection.writable.includes(effect.service);
    const key = writable ? "services_effect_writable" : projectBind ? "services_effect_project_bind" : "services_effect_host";
    warnings.push({ code: "SERVICES_HOST_EFFECT", message: t(key, { service: effect.service, kind: effect.kind, detail: effect.detail }) });
  }
  if (selection.builds.length > 0) warnings.push({ code: "SERVICES_BUILD", message: t("services_build", { count: selection.builds.length, services: selection.builds.join(", ") }) });
  const blockers: PlanBlocker[] = selection.refused.map((e) => ({
    code: "SERVICES_HOST_EFFECT_REFUSED",
    message: t(needsPermission(e) ? "services_refused_effect" : "services_refused_writable", { service: e.service, kind: e.kind, detail: e.detail }),
    items: input.items.filter((i) => selection.steps.has(i.tool)).map((i) => i.id),
  }));
  return { services: selection.start, warnings, blockers };
}
