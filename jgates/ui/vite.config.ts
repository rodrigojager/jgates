import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `virtual:screens`: the screens found by folder (src/screens/<screen>/index.tsx), each with its `screen` metadata read from
 * the source and its component behind a dynamic import. The navigation needs only the metadata, so a screen's code (and the
 * editor, the diff and the forms it brings) is fetched when its route is opened, and the entry chunk stays small. A new screen
 * still edits nothing: the folder and its `export const screen: ScreenMeta = { ... };` line are the registration.
 */
function screensPlugin(): Plugin {
  const id = "virtual:screens";
  const resolved = `\0${id}`;
  const dir = path.join(here, "src", "screens");
  return {
    name: "jgates-screens",
    resolveId: (source) => (source === id ? resolved : undefined),
    load(source) {
      if (source !== resolved) return undefined;
      const entries: string[] = [];
      for (const name of fs.readdirSync(dir).sort()) {
        const file = path.join(dir, name, "index.tsx");
        if (!fs.existsSync(file)) continue;
        this.addWatchFile(file);
        const match = fs.readFileSync(file, "utf8").match(/export const screen: ScreenMeta = (\{[^}]*\});/);
        if (!match) throw new Error(`${file}: expected a one-line "export const screen: ScreenMeta = { ... };"`);
        const meta = new Function(`return (${match[1]});`)() as Record<string, unknown>;
        entries.push(`{ screen: ${JSON.stringify(meta)}, load: () => import(${JSON.stringify(file.split(path.sep).join("/"))}) }`);
      }
      return `export const entries = [\n${entries.join(",\n")}\n];\n`;
    },
  };
}

// The UI is built into dist/ui (inside the package) and served by dist/server/static.js. No inline script or style,
// no remote font: the server CSP allows only 'self'.
export default defineConfig({
  root: here,
  base: "/",
  plugins: [react(), screensPlugin()],
  build: {
    outDir: path.resolve(here, "..", "dist", "ui"),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
