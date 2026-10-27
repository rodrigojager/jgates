// Client of the local server: same-origin cookie session plus the CSRF header the server hands out in GET /api/session.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fix: string | null,
    readonly body: Record<string, any>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrf: { header: string; token: string } | null = null;

async function ensureCsrf(): Promise<{ header: string; token: string }> {
  if (csrf) return csrf;
  const response = await fetch("/api/session", { credentials: "same-origin", headers: { Accept: "application/json" } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, json.code ?? "SESSION", json.message ?? "session", json.fix ?? null, json);
  csrf = { header: json.csrfHeader as string, token: json.csrfToken as string };
  return csrf;
}

export async function api<T = any>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    const token = await ensureCsrf();
    headers[token.header] = token.token;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) throw new ApiError(response.status, String(json.code ?? "ERROR"), String(json.message ?? response.statusText), (json.fix as string | null) ?? null, json);
  return json as T;
}

export const documentPath = (instance: string, binding: string, suffix = ""): string =>
  `/api/documents/${encodeURIComponent(instance)}/${encodeURIComponent(binding)}${suffix}`;

export const entryQuery = (entry: string | null): string => (entry ? `?entry=${encodeURIComponent(entry)}` : "");
