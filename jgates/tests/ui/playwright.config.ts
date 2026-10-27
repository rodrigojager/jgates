import fs from "node:fs";
import { defineConfig } from "@playwright/test";

// The system Chrome is used when it exists, so no browser is downloaded. JGATES_CHROME overrides the path;
// without any Chrome, Playwright falls back to its own Chromium (`npx playwright install chromium`).
const CHROME = process.env.JGATES_CHROME ?? (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);

export default defineConfig({
  testDir: ".",
  // Every tests/ui/*.spec.ts runs, with no list to edit when a screen brings its own spec.
  testMatch: /\.spec\.ts$/,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "../../../.scratch/playwright-results",
  use: {
    headless: true,
    launchOptions: CHROME ? { executablePath: CHROME, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] },
    locale: "pt-BR",
    trace: "off",
  },
});
