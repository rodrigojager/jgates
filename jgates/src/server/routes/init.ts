// Setting up a project from the interface: the same discovery and the same files as `jgates init`, written only on an
// explicit action. GET shows what was found and what would be written; POST writes it, and never over an existing file.
import { discoverWorkspace } from "../../core/discovery/index.js";
import { DEFAULT_PROFILE, STARTER_PROFILES, existingConfigFiles, planInit, writeInit } from "../../core/init/index.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition } from "../types.js";

const t = translator("shell");

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/init",
    handler({ server }) {
      const { inventory } = discoverWorkspace(server.projectDir);
      const components = inventory.classifications
        .filter((c) => c.classificationStatus === "detected" || c.classificationStatus === "explicit")
        .map((c) => ({ root: c.componentRoot, language: c.language ?? null, framework: c.framework ?? null, evidence: (c.evidencePaths ?? []).slice(0, 3) }));
      const plan = planInit(server.projectDir, DEFAULT_PROFILE);
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          existing: existingConfigFiles(server.projectDir),
          profiles: [...STARTER_PROFILES],
          defaultProfile: DEFAULT_PROFILE,
          components,
          templates: plan.templates,
          files: plan.files.map((f) => f.file),
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/init",
    body: { type: "object", properties: { profile: { enum: [...STARTER_PROFILES] } }, required: ["profile"], additionalProperties: false },
    handler({ body, server }) {
      if (server.policyMode) throw new HttpError(403, "POLICY_MODE", t("shell_browse_policy"), t("shell_browse_policy_fix"));
      const profile = (body as { profile: string }).profile;
      if (!(STARTER_PROFILES as readonly string[]).includes(profile)) {
        throw new HttpError(400, "BAD_PROFILE", t("shell_init_bad_profile", { profile, available: STARTER_PROFILES.join(", ") }), t("shell_init_bad_profile_fix"));
      }
      const existing = existingConfigFiles(server.projectDir);
      if (existing.length > 0) throw new HttpError(409, "CONFIG_EXISTS", t("shell_init_exists", { files: existing.join(", ") }), t("shell_init_exists_fix"));
      const plan = planInit(server.projectDir, profile);
      let created: string[];
      try {
        created = writeInit(server.projectDir, plan);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new HttpError(409, "CONFIG_EXISTS", t("shell_init_exists", { files: existingConfigFiles(server.projectDir).join(", ") }), t("shell_init_exists_fix"));
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new HttpError(500, "WRITE_FAILED", t("shell_init_failed", { reason }), t("shell_init_failed_fix"));
      }
      server.log(`init profile=${profile} created=${created.join(",")}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", profile, templates: plan.templates, components: plan.components, created } };
    },
  },
];
