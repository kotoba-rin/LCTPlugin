import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const vaultArg = process.argv[2];
if (process.argv.length !== 3 || !vaultArg || !isAbsolute(vaultArg)) {
  throw new Error("Usage: npm run install:plugin -- /absolute/path/to/existing-vault");
}
const vault = await realpath(vaultArg);
const configDir = join(vault, ".obsidian");
if (!(await stat(configDir)).isDirectory()) {
  throw new Error("The target must be an existing Obsidian vault with a .obsidian directory.");
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
if (!/^[a-z-]+$/.test(manifest.id)) {
  throw new Error("Invalid plugin ID.");
}
const assets = ["main.js", "manifest.json", "styles.css"];
for (const name of assets) {
  if (!(await stat(join(root, name))).isFile()) {
    throw new Error(`Missing plugin asset: ${name}`);
  }
}
const destination = join(configDir, "plugins", manifest.id);
await mkdir(destination, { recursive: true });
for (const name of assets) {
  await copyFile(join(root, name), join(destination, name));
}
console.log(`Installed ${manifest.name} ${manifest.version} in ${destination}`);
console.log("Existing data.json and session data were left in place. Reload the plugin in Obsidian.");
