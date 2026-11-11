// What a plan needs to know about the images its custom tools run on: the extension image of the project (ready, or
// out of date: EXTENSION_OUTDATED with the action) and the ready images named by reference (pinned by the image id the
// engine reports). The result goes into the plan's container inputs, so the plan hash changes when an image does.
import { inspectImageSync, type EngineContext } from "../engine/index.js";
import { translator } from "../../i18n/index.js";
import { resolveReason } from "../reasons/index.js";
import { extensionState } from "./state.js";
import { hasExtension } from "./key.js";

/** The `image` setting of a tool instance: `tools` (default), `extension` or the reference of a ready image. */
export type ImageSetting = "tools" | "extension" | string;

export interface ImageUse {
  /** The tool instance (the step id). */
  tool: string;
  image: ImageSetting;
}

export interface ImageBlocker {
  code: string;
  message: string;
  items: string[];
  action?: ReturnType<typeof resolveReason>["action"];
  details?: string;
}

export interface PlannedImages {
  /** Name and image id of each image a planned step runs on (the extension image and the ready images). */
  images: Array<{ name: string; digest: string }>;
  blockers: ImageBlocker[];
}

export interface PlanImagesOptions {
  projectDir: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  /** Image id of the tools image (null: the engine does not have it; the tools image blocker already says so). */
  baseDigest: string | null;
  uses: ImageUse[];
}

/** The image setting of an instance body from tools.yml. */
export function imageSettingOf(body: Record<string, unknown>): ImageSetting {
  return typeof body.image === "string" && body.image.trim() !== "" ? body.image.trim() : "tools";
}

export function planImages(options: PlanImagesOptions): PlannedImages {
  const t = translator("extension");
  const images: PlannedImages["images"] = [];
  const blockers: ImageBlocker[] = [];
  const context: EngineContext = { runnerOptions: { parentEnv: options.env } };

  const onExtension = options.uses.filter((u) => u.image === "extension").map((u) => u.tool);
  if (onExtension.length > 0) {
    if (!hasExtension(options.projectDir)) {
      blockers.push({ code: "EXTENSION_MISSING", message: t("extension_missing", { tools: onExtension.join(", ") }), items: onExtension });
    } else if (options.baseDigest !== null) {
      const state = extensionState({ projectDir: options.projectDir, workspace: options.workspace, env: options.env, baseDigest: options.baseDigest });
      if (state.status === "ready" && state.tag && state.digest) images.push({ name: state.tag, digest: state.digest });
      else if (state.status === "outdated") {
        const resolved = resolveReason("EXTENSION_OUTDATED", {});
        blockers.push({
          code: "EXTENSION_OUTDATED",
          message: `${resolved.message} ${t(`extension_cause_${(state.cause ?? "never-built").replace(/-/g, "_")}`)}`,
          items: onExtension,
          action: resolved.action,
          ...(state.tag ? { details: state.tag } : {}),
        });
      }
    }
  }

  const references = [...new Set(options.uses.filter((u) => u.image !== "tools" && u.image !== "extension").map((u) => u.image))];
  for (const reference of references) {
    const found = inspectImageSync(reference, context);
    const items = options.uses.filter((u) => u.image === reference).map((u) => u.tool);
    if (found) images.push({ name: reference, digest: found.id });
    else blockers.push({ code: "CUSTOM_IMAGE_MISSING", message: t("extension_image_missing", { reference, tools: items.join(", ") }), items });
  }
  return { images: images.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), blockers };
}

/** For the step launcher: the image id of a step (the tool id) as the plan pinned it; null for a step on the tools image. */
export function stepImageResolver(plan: { invocations: Array<{ id: string; contract?: Record<string, unknown> }>; inputs: { container?: { extensionImages: Array<{ name: string; digest: string }> } } }): (stepId: string) => string | null {
  const images = plan.inputs.container?.extensionImages ?? [];
  const byTool = new Map(plan.invocations.map((i) => [i.id, i.contract?.image]));
  return (stepId) => stepImageOf(byTool.get(stepId), images);
}

/** The image id a step runs on, from the plan: the extension image or the ready image its invocation names; null: the tools image. */
export function stepImageOf(setting: unknown, images: ReadonlyArray<{ name: string; digest: string }>): string | null {
  if (typeof setting !== "string" || setting === "tools") return null;
  const found = setting === "extension" ? images.find((i) => i.name.startsWith("jgates-ext-")) : images.find((i) => i.name === setting);
  return found?.digest ?? null;
}
