# JGates: project services

Some checks need something running: a database for the integration tests, the application itself for the end-to-end tests (Playwright), the API contract (Schemathesis), the dynamic security scan (ZAP) and the migration checks. JGates starts those **services** from your own Docker Compose files, only for the validation, on an isolated network, and shuts them down at the end. Compose files are for services: they never install a tool (the tools come from the [tools image](getting-started.en.md) or from [your own image](extension.en.md)).

Services are optional. A project without a compose file still gets every check that needs no running service; a check that needs one shows as "does not apply here", with the reason and the action "Set up the services", and never blocks.

## What JGates detects

Discovery reads the compose files (`compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml` and the `compose.*.yaml` overrides) as plain YAML, without running anything: service names, image or build, ports, healthchecks and profiles. It suggests a role from the evidence: a `postgres`, `mysql`, `mongo` or `redis` image is a dependency, and a service built from the project's own Dockerfile that publishes an HTTP port is the application under test.

It also flags the settings that reach your machine, so the review can show them before anything starts:

- a bind mount of a host folder;
- `privileged: true`;
- `network_mode: host`;
- `pid: host`;
- a device mapping;
- `cap_add`.

## Configure

In the interface, open **Configuration > Services** (`#/config/services`). The screen lists the compose files (the order is the order of use), the services found with their suggested roles, the application under test (service, port, base path and health path), the effects each service has on your machine, and a **Test start-up** button that starts the services, waits for them, shows the logs and shuts everything down. **Preview changes** shows what will change in `jgates.yml` before it is saved. The wizard offers the same choice in its Project step.

By hand, the section is optional and lives in `jgates.yml`:

```yaml
services:
  compose: [compose.yaml, compose.test.yaml]   # files, in order
  profiles: [test]                              # compose profiles to activate
  start: [db, api]                              # services to start; default: those the checks need
  target:                                       # the application under test
    service: api
    port: 8000
    path: /
    health: /health
  build: forbid                                 # allow | forbid (default forbid)
  writableBinds: []                             # services allowed to write to the project folder
  allowHostEffects: []                          # effects a governed run accepts
  timeoutSeconds: 120                           # wait for healthchecks and for the health path
```

A runtime check can name its target as `service:<name>:<port>` (with an optional path) instead of a URL: `service:api:8000` or `service:api:8000/v1`. The `target` setting of the ZAP, Schemathesis and Playwright instances accepts it, and JGates resolves it on the run's own network (`http://api:8000`). A mistyped target is reported, never taken for a URL.

## What happens in a run

1. Before the first step that needs services, JGates starts the selected services with `docker compose` under a project of its own (`jgates-<workspace>-<run>`), with its labels added through an override file that lives in the run folder, never in your project.
2. Compose builds an image only with `build: allow`; the review then says how many images will be built from your Dockerfiles (that runs the project's Dockerfile).
3. The steps that need services join the run's internal network and reach them by name. Ports are not published to your machine, so a run never collides with the stack you are running.
4. JGates waits for the compose healthchecks and for the `health` path of the target. If they do not answer within the time limit, the dependent steps are `incomplete` with the reason `SERVICES_NOT_READY` and the logs of the services are attached.
5. At the end, always (also on cancellation and failure), everything of the run is removed, including the volumes that belong to the run's project.

## Effects on your machine

- **The review lists every effect** before the first run with services. In local mode JGates asks for your confirmation once, and again only when the compose selection changes.
- **The project stays untouched.** A bind mount of a folder inside the project (the common `.:/app` of development files) is redefined read-only in the override file. A service that fails because it needs to write there is reported with that reason; you can opt in with `writableBinds: [api]`, which is recorded in `jgates.yml` and shown in every later review.
- **Compose reads `.env`** from the project folder as usual (the only read of the host that compose performs); JGates copies it nowhere.
- **Services run with your engine like any compose stack:** JGates adds no privilege.
- **Governed mode** (`jgates ci`) is stricter: it refuses a host bind mount, a privileged service and the other effects unless the policy lists them in `services.allowHostEffects` (the values are `bind-mount`, `privileged`, `network-host`, `pid-host`, `device` and `cap-add`), and it never accepts `writableBinds`. See [CI](ci.en.md).

## Problems

- `SERVICES_REQUIRED`: a selected check needs a service and none is configured. Open the Services screen and choose the compose files and the application under test.
- `SERVICES_NOT_READY`: the services did not become healthy in time. Read the attached logs; raise `timeoutSeconds` if the application is only slow to start.

Both appear, with the others, in the [list of reasons](troubleshooting.en.md#reason-codes).
