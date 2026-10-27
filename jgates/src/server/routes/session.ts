// Session routes: the one-time bootstrap exchange (the only route without a session) and the session context.
import { translator } from "../../i18n/index.js";
import { escapeHtml, refuse } from "../http.js";
import { TOKEN_PATTERN, sessionCookie } from "../security.js";
import type { RouteDefinition } from "../types.js";

const t = translator("server");

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/session/bootstrap",
    auth: "bootstrap",
    query: {
      type: "object",
      properties: { token: { type: "string", pattern: TOKEN_PATTERN } },
      required: ["token"],
      additionalProperties: false,
    },
    handler({ query, server }) {
      // The secret works once; it is never echoed, logged or kept (only its hash was stored).
      if (!server.bootstrap.consume(query.token as string)) throw refuse(401, "BOOTSTRAP_INVALID");
      const session = server.sessions.create();
      server.log("session opened");
      // A same-origin meta refresh (not a cross-site redirect) so the SameSite=Strict cookie goes with the next request,
      // and the address bar ends on the URL without the secret.
      const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>JGates</title></head><body><p><a href="/">${escapeHtml(t("server_bootstrap_continue"))}</a></p></body></html>\n`;
      return { status: 200, html, headers: { "Set-Cookie": sessionCookie(server.port, session.id) } };
    },
  },
  {
    method: "GET",
    path: "/api/session",
    handler({ session, server }) {
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          csrfToken: session?.csrfToken,
          csrfHeader: "X-JGates-CSRF",
          workspace: server.workspace,
          version: server.version,
        },
      };
    },
  },
  {
    method: "DELETE",
    path: "/api/session",
    handler({ session, server }) {
      if (session) server.sessions.delete(session.id);
      return { status: 200, json: { schemaVersion: 1, status: "OK" }, headers: { "Set-Cookie": `${sessionCookie(server.port, "").split(";")[0]}; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` } };
    },
  },
];
