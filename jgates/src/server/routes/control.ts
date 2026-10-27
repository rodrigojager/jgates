// Local control channel: a second `jgates ui` for the same workspace asks the open server for a new launcher.
// Authenticated by the token of the 0600 lock file; refused when anything a browser sends is present.
import type { RouteDefinition } from "../types.js";

export const routes: RouteDefinition[] = [
  {
    method: "POST",
    path: "/control/bootstrap",
    auth: "control",
    handler({ server }) {
      const launcher = server.issueLauncher();
      server.log("launcher issued");
      return { status: 200, json: { schemaVersion: 1, status: "OK", launcher, url: server.baseUrl, pid: process.pid } };
    },
  },
];
