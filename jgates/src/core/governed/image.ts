// What a CI policy says about the images a governed run may use (PLAN-architecture.md section 8):
//   execution.extensionImage: forbid  any extension is refused: the project's own image (.jgates/image in the analyzed
//                                     commit) and any tool the plan runs on an image other than the tools image;
//   execution.extensionImage: pinned  extensions must be fixed by digest (a ready image named `name@sha256:...`; an
//                                     image built from the project's Dockerfile has no fixed digest and is refused),
//                                     and the tools image the job runs in must be the one this JGates pins
//                                     (release/tools-image.json);
//   absent                            the policy does not look at extensions.
// The policy is the one pinned by JGATES_POLICY_SHA256, so the job cannot change it. Reads only; never throws.
import { encodePointer, resolveConfig } from "../config/resolve/index.js";
import { gitContext, runGit } from "../snapshot/index.js";
import { EXTENSION_DIR, EXTENSION_DOCKERFILE } from "../extension/key.js";
import { readImageJson } from "../runner/in-image.js";
import { readToolsImagePin, type ToolsImagePin } from "../tools-image/index.js";

export type ExtensionImagePolicy = "forbid" | "pinned";
export type ImageProblemCode = "EXTENSION_IMAGE_FORBIDDEN" | "EXTENSION_IMAGE_UNPINNED" | "TOOLS_IMAGE_DIGEST_MISMATCH" | "TOOLS_IMAGE_DIGEST_UNKNOWN";

export interface ImageProblem {
  code: ImageProblemCode;
  /** English detail for logs; the CLI shows its own translated text by code. */
  detail: string;
  path: string | null;
  expected?: string;
  actual?: string;
}

/** The environment variable that names the digest of the tools image the job runs in, when image.json does not. */
export const TOOLS_IMAGE_DIGEST_ENV = "JGATES_TOOLS_IMAGE_DIGEST";

const DIGEST_REFERENCE = /@sha256:[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** `execution.extensionImage` of the policy's own configuration; null when the policy does not set it. */
export function extensionImagePolicyOf(policyDir: string, projectDir: string): ExtensionImagePolicy | null {
  try {
    const value = resolveConfig(projectDir, { configDir: policyDir }).fields[encodePointer(["execution", "extensionImage"])]?.value;
    return value === "forbid" || value === "pinned" ? value : null;
  } catch {
    return null;
  }
}

/** Whether the analyzed commit has an extension image (its Dockerfile in .jgates/image). */
export function commitHasExtension(projectDir: string, commit: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const context = gitContext(projectDir, env);
    if (!context.repository) return false;
    const rel = `${context.prefix.replace(/\/+$/, "")}/${EXTENSION_DIR}/${EXTENSION_DOCKERFILE}`.replace(/^\/+/, "");
    return runGit(context.git, ["cat-file", "-e", `${commit}:${rel}`], context.toplevel, env).status === 0;
  } catch {
    return false;
  }
}

/** The image setting of every invocation of the plan that runs on an image other than the tools image. */
export function foreignImagesOf(plan: { invocations: ReadonlyArray<{ id: string; contract?: Record<string, unknown> }> }): Array<{ tool: string; image: string }> {
  const out: Array<{ tool: string; image: string }> = [];
  for (const invocation of plan.invocations) {
    const image = invocation.contract?.image;
    if (typeof image === "string" && image.trim() !== "" && image !== "tools") out.push({ tool: invocation.id, image: image.trim() });
  }
  return out;
}

export interface GovernedImageRequest {
  /** The policy's configuration folder. */
  policyDir: string;
  projectDir: string;
  /** The analyzed commit. */
  commit: string;
  plan: { invocations: ReadonlyArray<{ id: string; contract?: Record<string, unknown> }> };
  env?: NodeJS.ProcessEnv;
  /** The pin of the tools image (default: the package's release/tools-image.json). */
  pin?: ToolsImagePin;
}

/** The first thing the policy refuses about the images of this run, or null. */
export function checkGovernedImage(request: GovernedImageRequest): ImageProblem | null {
  const env = request.env ?? process.env;
  const policy = extensionImagePolicyOf(request.policyDir, request.projectDir);
  if (policy === null) return null;
  const foreign = foreignImagesOf(request.plan);
  const extension = commitHasExtension(request.projectDir, request.commit, env);

  if (policy === "forbid") {
    if (extension) return { code: "EXTENSION_IMAGE_FORBIDDEN", detail: `the commit has an extension image (${EXTENSION_DIR}/${EXTENSION_DOCKERFILE})`, path: `${EXTENSION_DIR}/${EXTENSION_DOCKERFILE}` };
    const first = foreign[0];
    if (first) return { code: "EXTENSION_IMAGE_FORBIDDEN", detail: `the tool ${first.tool} runs on the image ${first.image}`, path: first.tool };
    return null;
  }

  // pinned: extensions fixed by digest, and the tools image of the job is the pinned one.
  if (extension) return { code: "EXTENSION_IMAGE_UNPINNED", detail: `the extension image built from ${EXTENSION_DIR}/${EXTENSION_DOCKERFILE} has no fixed digest`, path: `${EXTENSION_DIR}/${EXTENSION_DOCKERFILE}` };
  for (const { tool, image } of foreign) {
    if (image === "extension" || !DIGEST_REFERENCE.test(image)) return { code: "EXTENSION_IMAGE_UNPINNED", detail: `the tool ${tool} runs on the image ${image}, which is not named by a sha256 digest`, path: tool };
  }
  const own = readImageJson(env);
  const declared = (typeof own?.digest === "string" ? own.digest : env[TOOLS_IMAGE_DIGEST_ENV] ?? "").trim();
  let pin: ToolsImagePin;
  try {
    pin = request.pin ?? readToolsImagePin();
  } catch {
    return { code: "TOOLS_IMAGE_DIGEST_UNKNOWN", detail: "the pin file of the tools image cannot be read", path: null };
  }
  if (!DIGEST.test(declared)) return { code: "TOOLS_IMAGE_DIGEST_UNKNOWN", detail: `the digest of the tools image of this job is not known (image.json digest or ${TOOLS_IMAGE_DIGEST_ENV})`, path: null };
  if (declared !== pin.digest) return { code: "TOOLS_IMAGE_DIGEST_MISMATCH", detail: `the job runs the tools image ${declared}, the pinned one is ${pin.digest}`, path: null, expected: pin.digest, actual: declared };
  return null;
}
