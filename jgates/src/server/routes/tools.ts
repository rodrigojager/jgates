// Tool instances of the workspace with their bindings (the ids the document routes accept), the catalog of adapters,
// the capability-by-stack matrix with the per-unit applicability of the project,
// the area of a tool (effective configuration, rendered command), and the changes of tools.yml: create, rename and
// remove an instance, select the file of a binding, make a local override, template of a missing file.
import { toolCatalog, instanceAvailability } from "../../core/tools/catalog.js";
import { effectiveConfig } from "../../core/tools/effective.js";
import { renderExecution } from "../../core/tools/execution.js";
import { createInstance, createLocalOverride, InstanceError, removeInstance, renameInstance, setBindingPath, templateFor, type InstanceErrorCode } from "../../core/tools/instances.js";
import { DocumentError } from "../../core/documents/index.js";
import { resolveToolBindings } from "../../core/tools/index.js";
import { buildMatrix, unitApplicability, verifyMatrix } from "../../core/matrix/index.js";
import { discoverWorkspace } from "../../core/discovery/index.js";
import { refreshPath } from "../../core/env-refresh/index.js";
import { testTool } from "../../core/extension/test-tool.js";
import { createCoreCatalog } from "../../core/catalog/index.js";
import { CustomToolError, INSTALL_METHODS, REPORT_FORMATS, hasExtension, installLines, planCustomTool, writeCustomTool, type CustomToolErrorCode, type CustomToolRequest } from "../../core/extension/index.js";
import { engineCommand, engineRuntime, inspectImage, type EngineContext } from "../../core/engine/index.js";
import { imageToolCatalogue } from "../../core/tools-image/index.js";
import fs from "node:fs";
import path from "node:path";
import { workspaceDir } from "../../core/home/index.js";
import { HttpError, refuse } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";

/** The own tools whose test ran and could read the report (per workspace, in the data folder: never in the project). */
const testedFile = (server: ServerContext): string => path.join(workspaceDir(server.home, server.workspace.id), "own-tools-tested.json");
function readTested(server: ServerContext): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(testedFile(server), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}
function writeTested(server: ServerContext, next: Record<string, string>): void {
  fs.mkdirSync(path.dirname(testedFile(server)), { recursive: true });
  fs.writeFileSync(testedFile(server), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

const CUSTOM_STATUS: Record<CustomToolErrorCode, number> = {
  ID_INVALID: 422,
  ID_EXISTS: 409,
  COMMAND_REQUIRED: 422,
  CAPABILITY_REQUIRED: 422,
  REPORT_INVALID: 422,
  INSTALL_INVALID: 422,
  IMAGE_AND_INSTALL: 422,
  TOOLS_FILE_INVALID: 422,
  TIMEOUT_INVALID: 422,
};

function customGuarded<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof CustomToolError) throw new HttpError(CUSTOM_STATUS[error.code] ?? 422, error.code, error.message, null, { params: error.params });
    throw error;
  }
}

const customBody = {
  type: "object",
  properties: {
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" },
    image: { type: "string", minLength: 1, maxLength: 512 },
    install: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 1024 } },
    command: { type: "string", minLength: 1, maxLength: 512 },
    args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 1024 } },
    report: {
      type: "object",
      properties: { format: { type: "string", enum: [...REPORT_FORMATS] }, file: { type: "string", maxLength: 256 } },
      required: ["format"],
      additionalProperties: false,
    },
    capabilities: { type: "array", maxItems: 32, items: { type: "string", pattern: "^([a-z][a-z0-9-]*|x-[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9._-]*)$" } },
    component: { type: "string", minLength: 1, maxLength: 256 },
    network: { type: "boolean" },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 86_400 },
  },
  required: ["id", "command", "report", "capabilities"],
  additionalProperties: false,
};

function customRequest(body: unknown): CustomToolRequest {
  const b = body as Partial<CustomToolRequest> & { id: string; command: string; report: CustomToolRequest["report"]; capabilities: string[] };
  return {
    id: b.id,
    ...(b.image !== undefined ? { image: b.image } : {}),
    install: b.install ?? [],
    command: b.command,
    args: b.args ?? [],
    report: b.report,
    capabilities: b.capabilities,
    ...(b.component !== undefined ? { component: b.component } : {}),
    network: b.network === true,
    ...(b.timeoutSeconds !== undefined ? { timeoutSeconds: b.timeoutSeconds } : {}),
  };
}

export const ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,127}$";

const STATUS: Record<InstanceErrorCode, number> = {
  INSTANCE_ID_INVALID: 400,
  INSTANCE_EXISTS: 409,
  INSTANCE_NOT_FOUND: 404,
  ADAPTER_UNKNOWN: 422,
  COMPONENT_UNKNOWN: 422,
  BINDING_NOT_FOUND: 404,
  BINDING_PATH_INVALID: 422,
  TOOLS_FILE_CONFLICT: 409,
  TOOLS_FILE_INVALID: 422,
  OVERRIDE_NOT_NEEDED: 409,
  OVERRIDE_EXISTS: 409,
  OVERRIDE_UNREADABLE: 422,
};

function guarded<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof InstanceError) throw new HttpError(STATUS[error.code] ?? 400, error.code, error.message, null, { details: error.details });
    // openDocument refuses an unknown instance or binding, or a link out of the root, with a DocumentError: never a 500.
    if (error instanceof DocumentError) throw new HttpError(error.code.endsWith("_NOT_FOUND") ? 404 : error.code === "BINDING_REFUSED" ? 403 : 422, error.code, error.message, error.fix, { details: error.details });
    throw error;
  }
}

const instanceParams = {
  type: "object",
  properties: { instance: { type: "string", pattern: ID_PATTERN } },
  required: ["instance"],
  additionalProperties: false,
};
const bindingParams = {
  type: "object",
  properties: { instance: { type: "string", pattern: ID_PATTERN }, binding: { type: "string", pattern: ID_PATTERN } },
  required: ["instance", "binding"],
  additionalProperties: false,
};
const relPath = { type: "string", minLength: 1, maxLength: 1024 };

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/tools",
    handler({ server }) {
      const r = resolveToolBindings(server.projectDir);
      return {
        status: 200,
        json: { schemaVersion: 1, status: "OK", ok: r.ok, configFile: r.configFile, externalRoots: r.externalRoots, instances: r.instances, documents: r.documents, diagnostics: r.diagnostics },
      };
    },
  },
  {
    method: "GET",
    path: "/api/tool-catalog",
    handler() {
      return { status: 200, json: { schemaVersion: 1, status: "OK", adapters: toolCatalog() } };
    },
  },
  {
    // The capability-by-stack matrix (same document as `jgates tools matrix --json`) and the per-unit applicability
    // of the served project.
    method: "GET",
    path: "/api/tool-matrix",
    timeoutMs: 30_000,
    handler({ server }) {
      const matrix = buildMatrix();
      const applicability = unitApplicability(discoverWorkspace(server.projectDir).inventory, matrix);
      return { status: 200, json: { schemaVersion: 1, status: "OK", matrix, problems: verifyMatrix(matrix), applicability } };
    },
  },
  {
    method: "GET",
    path: "/api/tool-availability",
    timeoutMs: 60_000,
    handler({ server }) {
      if (!server.policyMode) refreshPath();
      return { status: 200, json: { schemaVersion: 1, status: "OK", availability: instanceAvailability(server.projectDir) } };
    },
  },
  {
    method: "POST",
    path: "/api/tools",
    body: {
      type: "object",
      properties: { id: { type: "string", pattern: ID_PATTERN }, adapter: { type: "string", minLength: 1, maxLength: 128 }, component: { anyOf: [{ type: "string", minLength: 1, maxLength: 256 }, { type: "null" }] } },
      required: ["id", "adapter"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      const b = body as { id: string; adapter: string; component?: string | null };
      const created = guarded(() => createInstance(server.projectDir, { id: b.id, adapter: b.adapter, component: b.component ?? null }));
      server.log(`tool created ${b.id}`);
      return { status: 201, json: { schemaVersion: 1, status: "OK", created } };
    },
  },
  {
    // What the catalog rows and the own-tool dialog need: the version of every tool of the JGates image, the install
    // methods, the report formats, and the capabilities of the catalog grouped by category.
    method: "GET",
    path: "/api/tool-origins",
    handler({ server }) {
      const image = imageToolCatalogue(process.env);
      const catalog = createCoreCatalog().toDocument();
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          image: { version: image?.imageVersion ?? null, tools: image?.tools ?? {} },
          installMethods: INSTALL_METHODS,
          reportFormats: REPORT_FORMATS,
          categories: catalog.categories.map((c) => ({ id: c.id, label: c.label })),
          capabilities: catalog.capabilities.map((c) => ({ id: c.id, category: c.category ?? "custom", label: c.label, description: c.description })),
          hasExtension: hasExtension(server.projectDir),
          tested: readTested(server),
        },
      };
    },
  },
  {
    // The own-tool dialog's first step with a ready image: does the engine have it, and for which architecture.
    method: "POST",
    path: "/api/tools/custom/check-image",
    timeoutMs: 60_000,
    body: { type: "object", properties: { image: { type: "string", minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9][A-Za-z0-9._\\-/:@]*$" } }, required: ["image"], additionalProperties: false },
    async handler({ body }) {
      const reference = (body as { image: string }).image;
      const context: EngineContext = { runtime: engineRuntime(process.env), runnerOptions: { parentEnv: process.env } };
      const facts = await inspectImage(reference, context).catch(() => null);
      if (!facts) return { status: 200, json: { schemaVersion: 1, status: "OK", exists: false, architecture: null, matches: null } };
      const arch = await engineCommand(["image", "inspect", "--format", "{{.Architecture}}", reference], context, 20_000).catch(() => null);
      const found = arch && arch.exitCode === 0 ? (/\b(amd64|x86_64|arm64|aarch64|arm)\b/.exec(arch.stdout)?.[1] ?? null) : null;
      return { status: 200, json: { schemaVersion: 1, status: "OK", exists: true, architecture: found, matches: found === null ? null : found === "amd64" || found === "x86_64" } };
    },
  },
  {
    // The Dockerfile lines of install requests (`pip:bandit==1.8.0`), from the same code as `jgates tools add-custom`.
    method: "POST",
    path: "/api/tools/custom/install-lines",
    body: { type: "object", properties: { install: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 1024 } } }, required: ["install"], additionalProperties: false },
    handler({ body }) {
      const lines = customGuarded(() => (body as { install: string[] }).install.flatMap(installLines));
      return { status: 200, json: { schemaVersion: 1, status: "OK", lines } };
    },
  },
  {
    // The exact files an own tool would write, as a diff (the same plan as `jgates tools add-custom --dry-run`).
    method: "POST",
    path: "/api/tools/custom/preview",
    timeoutMs: 30_000,
    body: customBody,
    handler({ body, server }) {
      const plan = customGuarded(() => planCustomTool(server.projectDir, customRequest(body)));
      return { status: 200, json: { schemaVersion: 1, status: "OK", plan: { id: plan.id, image: plan.image, entry: plan.entry, dockerfileLines: plan.dockerfileLines, needsBuild: plan.needsBuild, changes: plan.changes.map((c) => ({ file: c.file, existed: c.before !== null, diff: c.diff, after: c.after })) } } };
    },
  },
  {
    // Writes the own tool ("Salvar"). Not `POST /api/tools/custom`: that path is also `GET /api/tools/:instance`, so a
    // GET of it would reach the instance lookup instead of being refused as a read of a mutation-only route.
    method: "POST",
    path: "/api/tools/custom/save",
    timeoutMs: 30_000,
    body: customBody,
    handler({ body, server }) {
      const plan = customGuarded(() => planCustomTool(server.projectDir, customRequest(body)));
      const written = writeCustomTool(server.projectDir, plan);
      const tested = readTested(server);
      if (plan.id in tested) {
        delete tested[plan.id];
        writeTested(server, tested);
      }
      server.log(`own tool created ${plan.id}`);
      return { status: 201, json: { schemaVersion: 1, status: "OK", created: { id: plan.id, image: plan.image, needsBuild: plan.needsBuild, written } } };
    },
  },
  {
    // "Testar agora": builds the extension image when it is out of date and runs the one tool once on the synced copy.
    method: "POST",
    path: "/api/tools/custom/test",
    timeoutMs: 1_800_000,
    body: { type: "object", properties: { instance: { type: "string", pattern: ID_PATTERN } }, required: ["instance"], additionalProperties: false },
    async handler({ body, server }) {
      const instance = (body as { instance: string }).instance;
      const result = await testTool({ projectDir: server.projectDir, instance, version: server.version, env: process.env });
      if (result.state === "ok" || result.state === "findings") writeTested(server, { ...readTested(server), [instance]: new Date().toISOString() });
      return { status: 200, json: { schemaVersion: 1, status: "OK", result: { ...result, build: result.build ? { ok: result.build.ok, built: result.build.built, error: result.build.error ?? null } : null } } };
    },
  },
  {
    method: "GET",
    path: "/api/tools/:instance",
    params: instanceParams,
    handler({ params, server }) {
      const r = resolveToolBindings(server.projectDir);
      const instance = r.instances.find((i) => i.id === params.instance);
      if (!instance) throw refuse(404, "INSTANCE_NOT_FOUND", { name: params.instance as string });
      return { status: 200, json: { schemaVersion: 1, status: "OK", instance, diagnostics: r.diagnostics } };
    },
  },
  {
    method: "PUT",
    path: "/api/tools/:instance",
    params: instanceParams,
    body: { type: "object", properties: { name: { type: "string", pattern: ID_PATTERN } }, required: ["name"], additionalProperties: false },
    handler({ params, body, server }) {
      const renamed = guarded(() => renameInstance(server.projectDir, params.instance as string, (body as { name: string }).name));
      server.log(`tool renamed ${params.instance as string}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", renamed } };
    },
  },
  {
    method: "DELETE",
    path: "/api/tools/:instance",
    params: instanceParams,
    handler({ params, server }) {
      const removed = guarded(() => removeInstance(server.projectDir, params.instance as string));
      server.log(`tool removed ${params.instance as string}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", removed } };
    },
  },
  {
    method: "GET",
    path: "/api/tools/:instance/execution",
    params: instanceParams,
    timeoutMs: 30_000,
    handler({ params, server }) {
      const execution = renderExecution(server.projectDir, params.instance as string);
      if (!execution) throw refuse(404, "INSTANCE_NOT_FOUND", { name: params.instance as string });
      return { status: 200, json: { schemaVersion: 1, status: "OK", execution } };
    },
  },
  {
    method: "GET",
    path: "/api/tools/:instance/effective",
    params: instanceParams,
    timeoutMs: 30_000,
    async handler({ params, server }) {
      const effective = await effectiveConfig(server.projectDir, params.instance as string);
      if (!effective) throw refuse(404, "INSTANCE_NOT_FOUND", { name: params.instance as string });
      return { status: 200, json: { schemaVersion: 1, status: "OK", effective } };
    },
  },
  {
    method: "GET",
    path: "/api/tools/:instance/bindings/:binding/template",
    params: bindingParams,
    handler({ params, server }) {
      const r = resolveToolBindings(server.projectDir, { skipInventory: true });
      const instance = r.instances.find((i) => i.id === params.instance);
      if (!instance) throw refuse(404, "INSTANCE_NOT_FOUND", { name: params.instance as string });
      const binding = instance.bindings.find((b) => b.id === params.binding);
      if (!binding || binding.kind !== "file") throw new HttpError(404, "BINDING_NOT_FOUND", `The instance ${instance.id} has no file binding ${params.binding as string}.`, null);
      return { status: 200, json: { schemaVersion: 1, status: "OK", template: templateFor(instance.adapter, binding.declared) } };
    },
  },
  {
    method: "PUT",
    path: "/api/tools/:instance/bindings/:binding",
    params: bindingParams,
    body: { type: "object", properties: { path: relPath }, required: ["path"], additionalProperties: false },
    handler({ params, body, server }) {
      const changed = guarded(() => setBindingPath(server.projectDir, params.instance as string, params.binding as string, (body as { path: string }).path));
      server.log(`binding selected ${params.instance as string}/${params.binding as string}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", binding: changed } };
    },
  },
  {
    method: "POST",
    path: "/api/tools/:instance/bindings/:binding/override",
    params: bindingParams,
    body: { type: "object", properties: { path: relPath }, additionalProperties: false },
    handler({ params, body, server }) {
      const requested = (body as { path?: string }).path;
      const override = guarded(() => createLocalOverride(server.projectDir, params.instance as string, params.binding as string, requested));
      server.log(`local override ${params.instance as string}/${params.binding as string}`);
      return { status: 201, json: { schemaVersion: 1, status: "OK", override } };
    },
  },
];
