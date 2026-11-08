import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// The system Chrome is used when it exists, so no browser is downloaded. JGATES_CHROME overrides the path;
// without any Chrome, Playwright falls back to its own Chromium (`npx playwright install chromium`).
const CHROME = process.env.JGATES_CHROME ?? ["/usr/bin/google-chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find((p) => fs.existsSync(p));

export default defineConfig({
  testDir: ".",
  // Every tests/ui/*.spec.ts runs, with no list to edit when a screen brings its own spec.
  testMatch: /\.spec\.ts$/,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: path.join(os.tmpdir(), "jgates-playwright-results"),
  use: {
    headless: true,
    launchOptions: CHROME ? { executablePath: CHROME, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] },
    locale: "pt-BR",
    trace: "off",
  },
});
