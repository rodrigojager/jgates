import { defineConfig } from "@playwright/test";

// The application under test is the one JGates hands over (the services target).
export default defineConfig({
  testDir: "./e2e",
  retries: 0,
  workers: 1,
  use: { baseURL: process.env.BASE_URL ?? "http://localhost:8080", browserName: "chromium" },
});
