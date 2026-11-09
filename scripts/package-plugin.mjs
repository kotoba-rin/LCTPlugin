import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const versions = JSON.parse(await readFile(join(root, "versions.json"), "utf8"));

if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || pkg.version !== manifest.version) {
  throw new Error("package.json and manifest.json must have the same x.y.z version.");
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error("versions.json must include this version and its minAppVersion.");
}
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== manifest.version) {
  throw new Error("The release tag must match manifest.json exactly (without a v prefix).");
}

const assets = ["main.js", "manifest.json", "styles.css"];
for (const name of assets) {
  if (!(await readFile(join(root, name))).length) {
    throw new Error(`Plugin asset is empty: ${name}`);
  }
}
await mkdir(join(root, "dist"), { recursive: true });
for (const name of assets) {
  await copyFile(join(root, name), join(root, "dist", name));
}
console.log(`Prepared ${manifest.id} ${manifest.version}: ${assets.join(", ")} in dist/.`);
