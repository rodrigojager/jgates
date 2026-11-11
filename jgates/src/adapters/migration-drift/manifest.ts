import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Migration drift: whether the project's models and its migrations still agree, asked of each framework's own command
 * against the database of the project's compose services. Django (`manage.py makemigrations --check --dry-run`) and
 * Alembic (`alembic upgrade head` then `alembic check`) for Python, Prisma (`prisma migrate diff --from-migrations
 * --to-schema --exit-code`, with the shadow database of its configuration) for TypeScript/JavaScript, and EF Core (`dotnet ef
 * migrations has-pending-model-changes`) for .NET. The frameworks and their drivers are the project's own dependencies;
 * dotnet-ef comes from the tools image. Without services configured the check is SERVICES_REQUIRED, never run and never
 * a blocker.
 */
export const migrationDriftManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "migration-drift",
  displayName: "Migration drift (Django, Alembic, Prisma, EF Core) and the SQL migration linter (squawk)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "migration-tool",
  toolVersionRange: ">=0.0.0",
  runtimes: ["native", "container"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["infrastructure"],
  capabilities: ["migration"],
  languages: ["python", "typescript", "javascript", "csharp"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "other",
      discovery: "manage.py and the Django settings; alembic.ini and its env.py; prisma/schema.prisma and prisma.config.ts; the .csproj with its Migrations/*ModelSnapshot.cs",
      precedence: "the framework's own configuration; the plan sets only the database URL variable (tools.<id>.databaseUrl)",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "no drift: the models and the migrations agree" },
      { code: 1, meaning: "Django and EF Core: changes without a migration (their output says so), or an error" },
      { code: 2, meaning: "Prisma --exit-code: the migrations and the schema differ" },
      { code: 255, meaning: "Alembic check: new upgrade operations detected (its output says so), or an error" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    // The project's settings, env.py, prisma.config.ts and DbContext are code the framework loads.
    executesProjectCode: true,
    usesNetwork: false,
    needsService: true,
    usesAi: false,
    needsLicense: false,
  },
  redirection: {
    flags: ["--check", "--dry-run", "--exit-code"],
    env: ["DATABASE_URL"],
    outputPaths: [{ path: "outputs/migration-drift", purpose: "output" }],
    unavoidableWorkspaceWrites: ["bin", "obj"],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "medium",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
  limitations: [
    "needs the project's compose services (jgates.yml services:), whose database the framework connects to through tools.<id>.databaseUrl; without them the check is SERVICES_REQUIRED and does not run",
    "Alembic upgrades the services database to head before it compares (the services are the run's own and are removed at the end)",
    "Prisma replays the migrations in the shadow database of its configuration (prisma.config.ts datasource.shadowDatabaseUrl, which Prisma 7 requires to diff a migrations folder): a second database of the services",
    "the framework loads the project's settings and models (project code): the result is self-reported and never cached",
  ],
  stackSupport: [
    {
      capability: "migration",
      stack: "any",
      state: "validated",
      toolVersions: "squawk 2.x (the tools image's 2.72.0, Apache-2.0)",
      prerequisites: ["SQL migration files (default migrations/**/*.sql, or tools.<id>.sql)"],
      limitations: ["the SQL migration linter: PostgreSQL rules, the files only (no services); errors block, warnings are reported"],
    },
    {
      capability: "migration",
      stack: "python",
      state: "validated",
      toolVersions: "Alembic 1.9+ (fixture ran 1.20.1 with SQLAlchemy 2.1 and pg8000); Django 4.2+ (makemigrations --check)",
      prerequisites: ["alembic.ini with an env.py that reads the database URL variable, or a Django manage.py", "a database service in the compose files"],
      limitations: ["the Alembic fixture proves the stack; Django runs the same exit-code contract"],
    },
    {
      capability: "migration",
      stack: "typescript",
      state: "validated",
      toolVersions: "prisma 7 (fixture ran 7.10.1)",
      prerequisites: ["prisma in the devDependencies, prisma/schema.prisma, prisma/migrations and a prisma.config.ts whose datasource URL reads DATABASE_URL and names a shadow database of the services", "a database service in the compose files"],
      limitations: [],
    },
    {
      capability: "migration",
      stack: "javascript",
      state: "validated",
      toolVersions: "prisma 7 (fixture ran 7.10.1)",
      prerequisites: ["prisma in the devDependencies, prisma/schema.prisma, prisma/migrations and a prisma.config whose datasource URL reads DATABASE_URL and names a shadow database of the services", "a database service in the compose files"],
      limitations: ["the TypeScript fixture proves the runner; JavaScript projects run the same Prisma CLI"],
    },
    {
      capability: "migration",
      stack: "csharp",
      state: "validated",
      toolVersions: "dotnet-ef 8+ (the tools image's 10.0.15) and Microsoft.EntityFrameworkCore.Design in the project",
      prerequisites: ["a project with EF Core migrations (Migrations/*ModelSnapshot.cs) and Microsoft.EntityFrameworkCore.Design"],
      limitations: ["the comparison is between the model and the model snapshot; the database is not read"],
    },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/sqlalchemy/alembic",
    spdx: "MIT",
    acquisition: ["https://alembic.sqlalchemy.org/en/latest/autogenerate.html", "https://docs.djangoproject.com/en/stable/ref/django-admin/#makemigrations", "https://www.prisma.io/docs/orm/reference/prisma-cli-reference#migrate-diff", "https://learn.microsoft.com/ef/core/cli/dotnet"],
    setup: ["https://alembic.sqlalchemy.org/en/latest/tutorial.html", "https://www.prisma.io/docs/orm/prisma-migrate"],
  },
};
