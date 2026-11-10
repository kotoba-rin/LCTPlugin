import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(fileURLToPath(import.meta.url));
const outputPath = join(pluginDir, "main.js");
const checkOnly = process.argv.includes("--check");
const license = await readFile(join(pluginDir, "LICENSE"), "utf8");
const fflateLicense = await readFile(join(pluginDir, "node_modules/fflate/LICENSE"), "utf8");
const diff3License = await readFile(join(pluginDir, "node_modules/node-diff3/LICENSE.md"), "utf8");

const result = await build({
  absWorkingDir: pluginDir,
  entryPoints: ["src/main.js"],
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: [
    "obsidian",
    "electron",
    "@codemirror/view",
  ],
  charset: "utf8",
  legalComments: "none",
  banner: { js: `/*\n${license.trim()}\n\nBundled dependency: fflate\n${fflateLicense.trim()}\n\nBundled dependency: node-diff3\n${diff3License.trim()}\n*/` },
  minify: false,
  sourcemap: false,
  write: !checkOnly,
});

if (checkOnly) {
  const expected = result.outputFiles?.[0]?.contents;
  const current = await readFile(outputPath);
  if (!expected || Buffer.compare(Buffer.from(expected), current) !== 0) {
    throw new Error(
      "main.js is out of date. Run `npm run build` in the plugin directory."
    );
  }
  console.log("lacan translation helper bundle is up to date");
}
