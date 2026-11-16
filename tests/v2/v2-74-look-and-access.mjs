import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// V2-74 (PLAN-consistency.md X9-X19): one look and working access on every non-semantic screen. The screens are walked in the
// browser by jgates/tests/ui/look-and-access.spec.ts (1280 and 375 px, light and dark: a reason for every disabled control,
// targets of 24 px, no cut column, no sideways scroll, no native select, input, progress or fieldset, one primary button,
// dialogs that focus their first field and have one cancel, the mascots where their subject is, the three long pages under a
// third of their old height). This case guards what does not need a browser: the spec and its scan are the ones that walk
// the screens, the design system's base rules exist, and each place the plan names carries its mascot.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ui = path.join(root, "jgates", "ui", "src");
const read = (...parts) => fs.readFileSync(path.join(ui, ...parts), "utf8");

test("V2-74: the browser spec walks every screen at both widths and both themes with the scans of the plan", () => {
  const spec = fs.readFileSync(path.join(root, "jgates", "tests", "ui", "look-and-access.spec.ts"), "utf8");
  const scan = fs.readFileSync(path.join(root, "jgates", "tests", "ui", "look-scan.ts"), "utf8");
  for (const width of ["1280", "375"]) assert.match(spec, new RegExp(`width: ${width}, scheme: "light"`), `${width} px light`);
  for (const width of ["1280", "375"]) assert.match(spec, new RegExp(`width: ${width}, scheme: "dark"`), `${width} px dark`);
  for (const rule of ["disabled", "targets", "cut", "native", "single", "sideways", "primary", "layout"]) assert.match(scan, new RegExp(`\\b${rule}\\b`), `scan rule ${rule}`);
  assert.match(scan, /MIN_TARGET = 24/);
  for (const hash of ["#/overview", "#/environment", "#/config", "#/config/templates", "#/tools", "#/validations/choose", "#/validations/review", "#/preferences/storage", "#/policy"]) assert.ok(spec.includes(hash), hash);
  assert.match(spec, /8_750/);
  assert.match(spec, /21_200/);
  assert.match(spec, /7_400/);
});

test("V2-74: the design system styles the select, input, progress and fieldset a screen leaves bare, with 24 px targets", () => {
  const css = read("theme", "theme.css");
  assert.match(css, /:where\(select, textarea, input:not/);
  assert.match(css, /:where\(fieldset\)/);
  assert.match(css, /\nprogress \{ appearance: none/);
  assert.match(css, /main\.main\[tabindex\]:focus-visible \{ outline: none; \}/, "no ring around the content area");
  assert.match(css, /input\[type=checkbox\], input\[type=radio\]\) \{ width: 24px; height: 24px/);
  assert.match(css, /\.stack-table/, "tables that do not fit become stacked cards");
  assert.match(read("screens", "config-profiles", "config-profiles.css"), /\.switch \{[^}]*width: 44px; height: 24px/);
});

test("V2-74: a dialog focuses its first field and keeps one way to cancel", () => {
  const common = read("components", "common.tsx");
  assert.match(common, /const FIELD = /);
  assert.match(common, /setOwnCancel/);
  assert.match(common, /#dialog-title/);
});

test("V2-74: the doctor and the quality strip are where the plan puts them", () => {
  const has = (file, text) => assert.ok(read(...file).includes(text), `${file.join("/")} has ${text}`);
  // Doctor: wizard steps 1 and 2, Ambiente, the overview.
  has(["screens", "wizard", "step-machine.tsx"], "<DoctorAvatar state={doctor} />");
  assert.equal((read("screens", "wizard", "step-machine.tsx").match(/<DoctorAvatar/g) ?? []).length, 2, "steps 1 and 2");
  has(["screens", "environment", "index.tsx"], "<DoctorAvatar");
  has(["screens", "overview", "index.tsx"], "<DoctorAvatar");
  // Strip: wizard steps 4 and 6, Perfil, the own-tool step, the tools catalogue and Templates.
  has(["screens", "wizard", "step-profile.tsx"], "<QualityMascotStrip");
  has(["screens", "wizard", "step-review.tsx"], "<QualityMascotStrip");
  has(["screens", "config-profiles", "index.tsx"], "<QualityMascotStrip");
  has(["screens", "tools", "custom-dialog.tsx"], "<ProjectMascotStrip");
  has(["screens", "tools", "index.tsx"], "<ProjectMascotStrip");
  has(["screens", "config-templates", "index.tsx"], "<ProjectMascotStrip");
  // The strip holds its room while it loads and its states are not pills.
  const strip = read("components", "QualityMascotStrip.tsx");
  assert.match(strip, /quality-mascots-reserved/);
  // The state is drawn by the shared MascotStatus (its class is mascot-strip-status, styled in mascot-strip.css).
  const shared = read("components", "mascot-strip.css");
  assert.match(shared, /\.mascot-strip-status \{[^}]*border: 0; padding: 0/);
  const css = read("components", "quality-mascots.css");
  assert.match(css, /--qm-room/);
});

test("V2-74: Templates tell the project's languages, so the long list can default to them", async () => {
  const dist = path.join(root, "jgates", "dist", "server", "routes", "templates.js");
  const source = fs.readFileSync(dist, "utf8");
  assert.match(source, /projectLanguages/);
  const view = fs.readFileSync(path.join(ui, "screens", "config-templates", "index.tsx"), "utf8");
  assert.match(view, /scope === "all"/);
  assert.match(view, /<details key=\{id \|\| "any"\}/, "groups are collapsed and counted");
});
