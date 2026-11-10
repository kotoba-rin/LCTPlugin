const assert = require("assert");
const { createHash } = require("crypto");
const { zipSync } = require("fflate");
const { ProjectSyncEngine } = require("../src/project-sync");
const { referencedAssets } = require("../src/project-sync/catalog");

const bytes = (value) => Buffer.from(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const origin = "https://reading.example";
const endpointUrl = `${origin}/wp-json/lctp/v1/project`;
const stateDir = ".obsidian/plugins/lacan-translation-helper/project-sync";
const original = "texts/s1-test/original/Leçon-01.md";
const translation = "texts/s1-test/translation/Leçon-01.md";
const otherOriginal = "texts/s1-test/original/Leçon-02.md";
const otherTranslation = "texts/s1-test/translation/Leçon-02.md";
const glossary = "texts/s1-test/glossary.md";

class Storage {
  constructor() { this.files = new Map(); this.blocked = null; this.unsaved = null; this.beforeCompare = null; }
  async read(path) { return this.files.has(path) ? bytes(this.files.get(path)) : null; }
  async write(path, data) { this.files.set(path, bytes(data)); }
  async remove(path) { this.files.delete(path); }
  hasUnsavedChanges(path) { return path === this.unsaved; }
  async compareAndWrite(path, expectedHash, data) {
    if (this.beforeCompare) await this.beforeCompare(path, expectedHash, data);
    const current = await this.read(path);
    if ((current === null ? null : hash(current)) !== expectedHash || path === this.blocked) return false;
    if (data === null) await this.remove(path); else await this.write(path, data);
    return true;
  }
  text(path) { return this.files.get(path)?.toString("utf8"); }
}

const release = (contents, version = "v1") => {
  const resources = new Map();
  const files = Object.entries(contents).map(([path, value]) => {
    const data = bytes(value);
    const url = `${origin}/${version}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
    resources.set(url, data);
    return { path, url, size: data.length, sha256: hash(data) };
  });
  const manifest = bytes(JSON.stringify({ schema_version: 1, version, files }));
  const manifest_url = `${origin}/${version}/manifest.json`;
  const archive = zipSync(Object.fromEntries(Object.entries(contents).map(([path, value]) => [path, bytes(value)])));
  const archive_url = `${origin}/${version}/project.zip`;
  const latest = { schema_version: 1, version, source_revision: "a".repeat(40), manifest_url,
    manifest_sha256: hash(manifest), file_count: files.length, archive_url, archive_sha256: hash(archive), archive_size: archive.length };
  resources.set(manifest_url, manifest);
  resources.set(archive_url, archive);
  resources.set(endpointUrl, bytes(JSON.stringify(latest)));
  const requests = [];
  return { files, resources, requests, transport: async (url) => {
    requests.push(url);
    if (!resources.has(url)) throw new Error("fixture file unavailable");
    return bytes(resources.get(url));
  } };
};

const create = (storage, remote, extra = {}) => new ProjectSyncEngine({ storage, transport: remote.transport, endpointUrl, stateDir, ...extra });
const defaults = { [original]: "French\n", [translation]: "one\ntwo\nthree\n", [otherOriginal]: "Other French\n", [otherTranslation]: "Other translation\n", [glossary]: "# Glossary\n" };
const state = (storage) => JSON.parse(storage.text(`${stateDir}/state.json`));
const contentKeys = (storage) => [...storage.files.keys()].filter((path) => !path.startsWith(".obsidian/"));

async function run() {
  const storage = new Storage();
  const remote = release(defaults);
  const engine = create(storage, remote);
  const catalog = await engine.getCatalog();
  assert.strictEqual(catalog.lessonCount, 2);
  assert.strictEqual(catalog.seminars[0].glossaryPath, glossary);
  assert.deepStrictEqual(catalog.seminars[0].lessons.map((lesson) => lesson.originalPath), [original, otherOriginal]);
  assert.strictEqual(catalog.seminars[0].lessons[0].translationPath, translation);
  assert.deepStrictEqual(contentKeys(storage), [], "catalog refresh must not create lesson stubs or download the corpus");
  assert.strictEqual(remote.requests.length, 2, "catalog refresh requests only version and manifest");
  assert.deepStrictEqual(await create(storage, remote).readCachedCatalog(), catalog);
  const endpointChanged = create(storage, remote, { endpointUrl: `${origin}/other` });
  assert.strictEqual(await endpointChanged.readCachedCatalog(), null, "a different endpoint cannot reuse the old catalog");
  const cached = storage.text(`${stateDir}/catalog.json`);
  const malicious = JSON.parse(cached);
  malicious.files[0].path = ".obsidian/plugins/evil.js";
  await storage.write(`${stateDir}/catalog.json`, bytes(JSON.stringify(malicious)));
  await assert.rejects(() => engine.readCachedCatalog(), /文件路径|不安全|未授权/);
  await storage.write(`${stateDir}/catalog.json`, bytes(cached));

  const initialized = await engine.initializeSeminar("s1-test");
  assert.strictEqual(initialized.usedArchive, false);
  assert.deepStrictEqual(contentKeys(storage), [glossary], "seminar initialization downloads only its glossary");
  const events = [];
  engine.onProgress = (event) => events.push(event);
  const first = await engine.syncLesson(original);
  assert.strictEqual(first.added, 2);
  assert.strictEqual(first.downloadedFiles, 2);
  assert.strictEqual(first.usedArchive, false);
  assert.deepStrictEqual(first.scopePaths, [original, translation]);
  assert.strictEqual(storage.text(otherOriginal), undefined);
  assert.strictEqual(storage.text(otherTranslation), undefined);
  assert.ok(!remote.requests.some((url) => url.endsWith("project.zip")), "on-demand sync never requests a full archive");
  assert.ok(events.some((event) => event.phase === "downloading" && event.completed === 1 && event.total === 2));
  assert.strictEqual(events.at(-1).phase, "complete");
  assert.strictEqual((await engine.syncLesson(original)).downloadedFiles, 0);

  await engine.syncLesson(otherOriginal);
  const otherBefore = storage.text(otherTranslation);
  await storage.write(translation, bytes("local one\ntwo\nthree\n"));
  await storage.write("my-private-note.md", bytes("private"));
  const baselineBeforeSkip = storage.text(`${stateDir}/state.json`);
  const updated = release({ [original]: "Updated French\n", [translation]: "one\ntwo\nremote three\n", [glossary]: "# New glossary\n" }, "v2");
  const skipped = await create(storage, updated).syncLesson(original);
  assert.strictEqual(skipped.merged, 0);
  assert.strictEqual(skipped.conflicts.length, 0);
  assert.deepStrictEqual(skipped.skippedFiles.map(({ path }) => path).sort(), [original, translation].sort());
  assert.strictEqual(skipped.downloadedFiles, 0);
  assert.strictEqual(updated.requests.length, 2, "a modified pair stops before any replacement body download");
  assert.strictEqual(storage.text(translation), "local one\ntwo\nthree\n");
  assert.strictEqual(storage.text(original), defaults[original], "an edited translation also protects its paired original from partial updates");
  assert.strictEqual(storage.text(`${stateDir}/state.json`), baselineBeforeSkip);
  assert.strictEqual(storage.text(otherOriginal), defaults[otherOriginal]);
  assert.strictEqual(storage.text(otherTranslation), otherBefore);
  assert.strictEqual(storage.text("my-private-note.md"), "private");
  const again = await create(storage, updated).syncLesson(original);
  assert.strictEqual(again.skippedFiles.length, 2);
  assert.strictEqual(storage.text(`${stateDir}/state.json`), baselineBeforeSkip, "repeated skips never bless local edits as a new baseline");

  for (const modified of ["one\nmy translation\nthree\n", defaults[translation] + "\n> [注] my private note\n", defaults[translation] + "\n> <!-- 建言 -->\n> my commentary\n", defaults[translation] + " ", "one\ntwo\nremote three\n"]) {
    const edited = new Storage();
    await create(edited, remote).syncLesson(original);
    const previous = edited.text(`${stateDir}/state.json`);
    await edited.write(translation, bytes(modified));
    const sameRemote = await create(edited, remote).syncLesson(original);
    assert.strictEqual(sameRemote.skippedFiles.length, 2, "all byte changes protect the whole document, even with unchanged upstream");
    const nextRemote = await create(edited, updated).syncLesson(original);
    assert.strictEqual(nextRemote.skippedFiles.find((entry) => entry.path === translation).reason, "local_modified");
    assert.strictEqual(edited.text(translation), modified);
    assert.strictEqual(edited.text(original), defaults[original]);
    assert.strictEqual(edited.text(`${stateDir}/state.json`), previous);
  }

  const unknown = new Storage();
  unknown.files.set(translation, bytes("an existing personal translation"));
  const unknownResult = await create(unknown, remote).syncLesson(original);
  assert.strictEqual(unknownResult.skippedFiles.find((entry) => entry.path === translation).reason, "existing_local_file");
  assert.strictEqual(unknown.text(original), undefined, "no baseline means an existing different file protects the entire pair");

  for (const confirmed of [false, true]) {
    const deleted = new Storage();
    await create(deleted, remote).syncLesson(original);
    deleted.files.delete(translation);
    if (confirmed) {
      const oldState = state(deleted);
      oldState.local_deletions = { [translation]: oldState.files[translation] };
      await deleted.write(`${stateDir}/state.json`, bytes(JSON.stringify(oldState)));
    }
    const restored = await create(deleted, confirmed ? updated : remote).syncLesson(original);
    assert.strictEqual(restored.added, 1);
    assert.strictEqual(deleted.text(translation), confirmed ? "one\ntwo\nremote three\n" : defaults[translation]);
    assert.deepStrictEqual(state(deleted).local_deletions, {}, "a successful re-download removes obsolete deletion markers");
    assert.deepStrictEqual(restored.conflicts, []);
  }
  const deletedModifiedPair = new Storage();
  await create(deletedModifiedPair, remote).syncLesson(original);
  deletedModifiedPair.files.delete(original);
  deletedModifiedPair.files.set(translation, bytes("keep my edits"));
  assert.strictEqual((await create(deletedModifiedPair, updated).syncLesson(original)).skippedFiles.length, 2);
  assert.strictEqual(deletedModifiedPair.text(original), undefined);
  deletedModifiedPair.files.delete(translation);
  const redownload = await create(deletedModifiedPair, updated).syncLesson(original);
  assert.strictEqual(redownload.added, 2);
  assert.strictEqual(deletedModifiedPair.text(original), "Updated French\n");

  const draft = new Storage();
  await create(draft, remote).syncLesson(original);
  draft.unsaved = translation;
  assert.strictEqual((await create(draft, updated).syncLesson(original)).skippedFiles.find((entry) => entry.path === translation).reason, "unsaved_changes");
  assert.strictEqual(draft.text(translation), defaults[translation]);

  const duringDownload = new Storage();
  await create(duringDownload, remote).syncLesson(original);
  const racingRemote = release({ ...defaults, [translation]: "official replacement" }, "v2");
  const fetch = racingRemote.transport;
  racingRemote.transport = async (url) => {
    const data = await fetch(url);
    if (url === racingRemote.files.find((entry) => entry.path === translation).url) duringDownload.files.set(original, bytes("edited during download"));
    return data;
  };
  const raceState = duringDownload.text(`${stateDir}/state.json`);
  const racing = await create(duringDownload, racingRemote).syncLesson(original);
  assert.strictEqual(racing.skippedFiles.length, 2);
  assert.strictEqual(duringDownload.text(original), "edited during download");
  assert.strictEqual(duringDownload.text(translation), defaults[translation]);
  assert.strictEqual(duringDownload.text(`${stateDir}/state.json`), raceState);

  const adoptedRace = new Storage();
  await create(adoptedRace, remote).syncLesson(original);
  const adoptedState = adoptedRace.text(`${stateDir}/state.json`);
  adoptedRace.beforeCompare = async (path) => {
    if (path === translation) { adoptedRace.files.set(original, bytes("new edit to adopted original")); adoptedRace.beforeCompare = null; }
  };
  const adoptedResult = await create(adoptedRace, release({ ...defaults, [translation]: "remote changed" }, "v2")).syncLesson(original);
  assert.strictEqual(adoptedResult.skippedFiles.length, 2, "adopt/no-write members are rechecked after the other member writes");
  assert.strictEqual(adoptedRace.text(original), "new edit to adopted original");
  assert.strictEqual(adoptedRace.text(translation), defaults[translation]);
  assert.strictEqual(adoptedRace.text(`${stateDir}/state.json`), adoptedState);

  const betweenWrites = new Storage();
  await create(betweenWrites, remote).syncLesson(original);
  const betweenState = betweenWrites.text(`${stateDir}/state.json`);
  betweenWrites.beforeCompare = async (path) => {
    if (path === translation) {
      betweenWrites.files.set(original, bytes("newest local edit after first write"));
      betweenWrites.blocked = translation;
      betweenWrites.beforeCompare = null;
    }
  };
  const betweenResult = await create(betweenWrites, updated).syncLesson(original);
  assert.strictEqual(betweenResult.skippedFiles.length, 2);
  assert.strictEqual(betweenWrites.text(original), "newest local edit after first write");
  assert.strictEqual(betweenWrites.text(translation), defaults[translation]);
  assert.strictEqual(betweenWrites.text(`${stateDir}/state.json`), betweenState);
  const recovery = JSON.parse(betweenWrites.text(`${stateDir}/recovery-conflicts.json`));
  assert.strictEqual(betweenWrites.text(recovery.backups[0].backupPath), defaults[original], "racing user text and the old backup both survive");

  const missingStorage = new Storage();
  const missing = release(defaults);
  missing.resources.delete(missing.files.find((file) => file.path === translation).url);
  await assert.rejects(() => create(missingStorage, missing).syncLesson(original), /unavailable/);
  assert.deepStrictEqual(contentKeys(missingStorage), [], "a failed second download cannot write the first Markdown");
  const unpaired = release({ [original]: "French\n", [glossary]: "Glossary" });
  await assert.rejects(() => create(new Storage(), unpaired).syncLesson(original), /成对/);
  assert.strictEqual(unpaired.requests.length, 2, "reject a missing pair before any content download");

  const atomicStorage = new Storage();
  atomicStorage.blocked = translation;
  assert.strictEqual((await create(atomicStorage, remote).syncLesson(original)).skippedFiles.length, 2);
  assert.deepStrictEqual(contentKeys(atomicStorage), [], "a blocked editor on the second file rolls back the first file");

  const image = "assets/figure.png";
  const unusedImage = "assets/unreferenced.png";
  const pdf = "texts/s1-test/notes/source.pdf";
  const withAssets = release({ ...defaults, [original]: "French ![figure](../../../assets/figure.png)\n",
    [translation]: "Chinese ![[assets/figure.png]] and [source](../notes/source.pdf)\n", [image]: bytes([0, 1, 2]), [unusedImage]: bytes([9]), [pdf]: "%PDF-fixture" });
  const assetStorage = new Storage();
  const assetResult = await create(assetStorage, withAssets).syncLesson(original);
  assert.strictEqual(assetResult.downloadedFiles, 4);
  assert.ok(assetStorage.files.has(image) && assetStorage.files.has(pdf));
  assert.ok(!assetStorage.files.has(unusedImage));
  assert.deepStrictEqual(referencedAssets("![remote](https://example.com/image.png) ![bad](../../../../secrets.png)", original, withAssets.files), []);
  await assetStorage.write(image, bytes([8, 8, 8]));
  const assetStateBefore = assetStorage.text(`${stateDir}/state.json`);
  const changedAssets = release({ ...defaults, [original]: "French updated ![figure](../../../assets/figure.png)\n", [translation]: "Chinese updated ![[assets/figure.png]]\n", [image]: bytes([3, 4, 5]) }, "v2");
  const skippedAssets = await create(assetStorage, changedAssets).syncLesson(original);
  assert.ok(skippedAssets.skippedFiles.some((entry) => entry.path === image && entry.reason === "local_modified"));
  assert.strictEqual(assetStorage.text(original), "French ![figure](../../../assets/figure.png)\n");
  assert.deepStrictEqual(assetStorage.files.get(image), bytes([8, 8, 8]));
  assert.strictEqual(assetStorage.text(`${stateDir}/state.json`), assetStateBefore);
  console.log("On-demand catalog, paired skip/restore, notes/commentary, drafts, atomic races and selective asset tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
