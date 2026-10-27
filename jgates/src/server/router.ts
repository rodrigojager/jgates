// Routes are found by scanning src/server/routes/ (no central list). Every input is checked against a JSON Schema.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { refuse } from "./http.js";
import type { HttpMethod, RouteDefinition, RouteModule } from "./types.js";

type Validator = ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string }> | null };
type AjvCtor = new (opts: object) => { compile(schema: object): Validator };
const Ajv = ((Ajv2020Module as unknown as { default?: AjvCtor }).default ?? (Ajv2020Module as unknown as AjvCtor)) as AjvCtor;

const EMPTY_OBJECT = { type: "object", additionalProperties: false } as const;

export interface CompiledRoute {
  def: RouteDefinition;
  segments: string[];
  params: Validator;
  query: Validator;
  body: Validator | null;
}

export function defaultRoutesDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "routes");
}

function isRouteModule(value: unknown): value is RouteModule {
  return typeof value === "object" && value !== null && Array.isArray((value as RouteModule).routes);
}

const splitPath = (p: string): string[] => p.split("/").slice(1);

export class Router {
  private constructor(private readonly compiled: CompiledRoute[]) {}

  /** Imports every .js module of the folders that exports `routes` and compiles the schemas once. */
  static async load(dirs: string[] = [defaultRoutesDir()]): Promise<Router> {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const compiled: CompiledRoute[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
        const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as unknown;
        if (!isRouteModule(mod)) continue;
        for (const def of mod.routes) {
          const key = `${def.method} ${def.path}`;
          if (seen.has(key)) throw new Error(`duplicate route ${key} in ${file}`);
          seen.add(key);
          compiled.push({
            def,
            segments: splitPath(def.path),
            params: ajv.compile(def.params ?? { type: "object" }),
            query: ajv.compile(def.query ?? EMPTY_OBJECT),
            body: def.body ? ajv.compile(def.body) : null,
          });
        }
      }
    }
    return new Router(compiled);
  }

  get routes(): RouteDefinition[] {
    return this.compiled.map((c) => c.def);
  }

  /**
   * Finds the route of a path. Returns the route and its decoded parameters, `{ allowed }` when the path exists
   * only for other methods (405), or null (404). Segments are split before decoding, so %2F never becomes a separator.
   */
  match(method: string, pathname: string): { route: CompiledRoute; params: Record<string, string> } | { allowed: HttpMethod[] } | null {
    const parts = splitPath(pathname);
    const allowed: HttpMethod[] = [];
    for (const route of this.compiled) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length && ok; i++) {
        const pattern = route.segments[i] as string;
        const part = parts[i] as string;
        if (pattern.startsWith(":")) {
          let decoded: string;
          try {
            decoded = decodeURIComponent(part);
          } catch {
            throw refuse(400, "INPUT_INVALID", { detail: "path" });
          }
          if (decoded === "") ok = false;
          else params[pattern.slice(1)] = decoded;
        } else if (pattern !== part) ok = false;
      }
      if (!ok) continue;
      if (route.def.method === method) return { route, params };
      allowed.push(route.def.method);
    }
    return allowed.length > 0 ? { allowed } : null;
  }
}

/** Throws INPUT_INVALID with the schema errors (paths and rules only, never the received values). */
export function check(validator: Validator, data: unknown, where: string): void {
  if (validator(data)) return;
  const problems = (validator.errors ?? []).slice(0, 10).map((e) => `${where}${e.instancePath || ""}: ${e.message ?? "invalid"}`);
  throw refuse(400, "INPUT_INVALID", { detail: problems.join("; ") }, { problems });
}

/** Query string as an object of strings; a repeated key is refused (the schemas take single values). */
export function queryObject(search: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of search) {
    if (Object.prototype.hasOwnProperty.call(out, key)) throw refuse(400, "INPUT_INVALID", { detail: `query.${key}: repeated` });
    out[key] = value;
  }
  return out;
}
