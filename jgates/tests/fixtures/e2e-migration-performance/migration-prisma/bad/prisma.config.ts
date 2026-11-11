import { defineConfig, env } from "prisma/config";

// The run's own disposable database, and its shadow database on the same server (db/shadow.sql creates it).
const url = env("DATABASE_URL");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url, shadowDatabaseUrl: url.replace(/\/[^/?]+(\?|$)/, "/shadow$1") },
});
