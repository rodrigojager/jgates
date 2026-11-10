// Private registry credentials of a dependency install (PLAN-dependencies.md section 5). The token comes from the key
// store (local runs) or the CI environment (governed runs: environment only), and reaches the deps container through its
// standard input, never through `docker run` arguments (which the engine keeps, and the step logs show). Inside the
// container the install script reads it into an environment variable and writes the manager's configuration in /tmp
// (a tmpfs that disappears with the container); the files that need the token reference the variable where the
// manager supports it. Every text that leaves the container is masked before it is written anywhere.
import { SECRET_MASK, resolveSecret } from "../secrets/index.js";
import type { DependencyEcosystem, DependencyManager } from "../discovery/dependencies.js";
import type { RegistrySettings } from "./config.js";

/** Name of the variable the token lives in inside the deps container. */
export const TOKEN_VARIABLE = "JGATES_REGISTRY_TOKEN";
/** Where the generated registry configuration goes inside the deps container (tmpfs). */
export const CREDENTIALS_DIR = "/tmp/jgates-registry";

export interface ResolvedRegistry {
  url: string;
  tokenSecret: string | null;
  /** The token value, or null when the registry declares none. Never logged, never stored. */
  token: string | null;
  source: "env" | "vault" | null;
}

export type RegistryResolution = { ok: true; registry: ResolvedRegistry | null } | { ok: false; secret: string };

/** The registry of an ecosystem with its token; a declared secret that neither the environment nor the store has is a failure. */
export function resolveRegistry(settings: RegistrySettings | undefined, options: { env: NodeJS.ProcessEnv; vault: boolean }): RegistryResolution {
  if (!settings) return { ok: true, registry: null };
  if (!settings.tokenSecret) return { ok: true, registry: { url: settings.url, tokenSecret: null, token: null, source: null } };
  const found = resolveSecret(settings.tokenSecret, { env: options.env, vault: options.vault });
  if (!found) return { ok: false, secret: settings.tokenSecret };
  return { ok: true, registry: { url: settings.url, tokenSecret: settings.tokenSecret, token: found.value, source: found.source } };
}

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * The shell lines that configure the registry inside the deps container. The token is read from standard input into
 * $JGATES_REGISTRY_TOKEN (and exported under the secret's own name, so a project .npmrc that references ${NPM_TOKEN}
 * works); configuration files are written in /tmp only.
 */
export function registryScript(ecosystem: DependencyEcosystem, manager: DependencyManager | null, variant: string | null, registry: ResolvedRegistry | null): string[] {
  if (!registry) return [];
  const url = registry.url.replace(/\/*$/, "/");
  const host = new URL(url).host;
  const lines: string[] = [`mkdir -p ${CREDENTIALS_DIR}`, `JGATES_REGISTRY_URL=${quote(url)}`];
  const hasToken = registry.token !== null;
  if (hasToken) {
    lines.push(`IFS= read -r ${TOKEN_VARIABLE} || true`, `export ${TOKEN_VARIABLE}`);
    if (registry.tokenSecret && registry.tokenSecret !== TOKEN_VARIABLE) lines.push(`export ${registry.tokenSecret}="$${TOKEN_VARIABLE}"`);
  }
  switch (ecosystem) {
    case "node": {
      // npm and pnpm expand ${VAR} in .npmrc: the file holds the reference, the value stays in the environment.
      const authKey = `//${url.replace(/^https?:\/\//, "")}:_authToken`;
      lines.push(`printf '%s\\n' "registry=$JGATES_REGISTRY_URL" > ${CREDENTIALS_DIR}/npmrc`);
      if (hasToken) lines.push(`printf '%s\\n' ${quote(`${authKey}=\${${TOKEN_VARIABLE}}`)} >> ${CREDENTIALS_DIR}/npmrc`);
      lines.push(`export NPM_CONFIG_USERCONFIG=${CREDENTIALS_DIR}/npmrc`, `export npm_config_registry="$JGATES_REGISTRY_URL"`);
      if (manager === "yarn" && variant === "berry") {
        lines.push(`export YARN_NPM_REGISTRY_SERVER="$JGATES_REGISTRY_URL"`);
        if (hasToken) lines.push(`export YARN_NPM_AUTH_TOKEN="$${TOKEN_VARIABLE}"`);
      } else if (manager === "yarn") lines.push(`export YARN_REGISTRY="$JGATES_REGISTRY_URL"`);
      break;
    }
    case "python": {
      // uv and pip read the index from the environment; the credentials go in the URL (environment only).
      if (hasToken) {
        lines.push(
          `JGATES_TOKEN_URLENC="$(python3 -c 'import os, urllib.parse; print(urllib.parse.quote(os.environ["${TOKEN_VARIABLE}"], safe=""))')"`,
          `JGATES_INDEX_URL="\${JGATES_REGISTRY_URL%%://*}://__token__:$JGATES_TOKEN_URLENC@\${JGATES_REGISTRY_URL#*://}"`,
        );
      } else lines.push(`JGATES_INDEX_URL="$JGATES_REGISTRY_URL"`);
      lines.push(`export UV_DEFAULT_INDEX="$JGATES_INDEX_URL" PIP_INDEX_URL="$JGATES_INDEX_URL" PDM_PYPI_URL="$JGATES_INDEX_URL"`);
      break;
    }
    case "go": {
      lines.push(`export GOPROXY="$JGATES_REGISTRY_URL" GONOSUMDB='*'`);
      if (hasToken) lines.push(`printf 'machine %s login jgates password %s\\n' ${quote(host)} "$${TOKEN_VARIABLE}" > ${CREDENTIALS_DIR}/netrc`, `chmod 600 ${CREDENTIALS_DIR}/netrc`, `export NETRC=${CREDENTIALS_DIR}/netrc`);
      break;
    }
    case "rust": {
      lines.push(`export CARGO_REGISTRIES_JGATES_INDEX="sparse+$JGATES_REGISTRY_URL" CARGO_SOURCE_CRATES_IO_REPLACE_WITH=jgates`);
      if (hasToken) lines.push(`export CARGO_REGISTRIES_JGATES_TOKEN="$${TOKEN_VARIABLE}"`);
      break;
    }
    case "dotnet": {
      // NuGet expands %VAR% in the configuration: the file names the variable, not the token.
      const credentials = hasToken
        ? `<packageSourceCredentials><jgates><add key="Username" value="jgates"/><add key="ClearTextPassword" value="%${TOKEN_VARIABLE}%"/></jgates></packageSourceCredentials>`
        : "";
      lines.push(
        `printf '%s\\n' '<?xml version="1.0" encoding="utf-8"?>' '<configuration><packageSources><clear/>' "<add key=\\"jgates\\" value=\\"$JGATES_REGISTRY_URL\\"/>" '</packageSources>${credentials}</configuration>' > ${CREDENTIALS_DIR}/nuget.config`,
        `JGATES_NUGET_CONFIG=${CREDENTIALS_DIR}/nuget.config`,
      );
      break;
    }
  }
  return lines;
}

/** Replaces every occurrence of the secrets (and their URL-encoded forms) in a text by the mask. */
export function maskSecrets(text: string, secrets: ReadonlyArray<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) out = out.split(form).join(SECRET_MASK);
  }
  return out;
}
