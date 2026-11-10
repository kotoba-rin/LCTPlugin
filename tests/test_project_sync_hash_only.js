const assert = require("assert");
const { createHash } = require("crypto");
const { ProjectSyncEngine } = require("../src/project-sync");
const { backupPathFor } = require("../src/project-sync/transactions");

const bytes = (value) => Buffer.from(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const endpointUrl = "https://reading.example/wp-json/lctp/v1/project";
const stateDir = ".obsidian/plugins/lacan-translation-helper/project-sync";
const original = "texts/s1-test/original/Leçon-01.md";
const translation = "texts/s1-test/translation/Leçon-01.md";
const card = "知识库/概念.md";
const image = "assets/figure.png";
const unused = "assets/unused.png";
const contents = {
  [original]: "French ![figure](../../../assets/figure.png)\n",
  [translation]: "中文 ![[assets/figure.png]]\n",
  [card]: "# 概念\n![figure](../assets/figure.png)\n",
  [image]: bytes([0, 1, 2]),
  [unused]: bytes([9]),
};

class Storage {
  constructor() { this.files = new Map(); this.reads = []; this.writes = []; }
  async read(path) {
    this.reads.push(path);
    if (this.beforeRead) await this.beforeRead(path);
    return this.files.has(path) ? bytes(this.files.get(path)) : null;
  }
  async write(path, data) { this.writes.push(path); this.files.set(path, bytes(data)); }
  async remove(path) { this.files.delete(path); }
  async compareAndWrite(path, expected, data) {
    const current = await this.read(path);
    if ((current === null ? null : hash(current)) !== expected) return false;
    if (data === null) await this.remove(path); else await this.write(path, data);
    return true;
  }
  text(path) { return this.files.get(path)?.toString("utf8"); }
  state() { return JSON.parse(this.text(`${stateDir}/state.json`)); }
}

const release = (values, version) => {
  const resources = new Map();
  const files = Object.entries(values).map(([path, value]) => {
    const data = bytes(value);
    const url = `https://reading.example/${version}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
    resources.set(url, data);
    return { path, url, size: data.length, sha256: hash(data) };
  });
  const manifest = bytes(JSON.stringify({ schema_version: 1, version, files }));
  const manifest_url = `https://reading.example/${version}/manifest.json`;
  const latest = { schema_version: 1, version, manifest_url, manifest_sha256: hash(manifest), file_count: files.length };
  resources.set(manifest_url, manifest);
  resources.set(endpointUrl, bytes(JSON.stringify(latest)));
  const requests = [];
  return { files, requests, transport: async (url) => {
    requests.push(url);
    assert.ok(resources.has(url), `unexpected request ${url}`);
    return bytes(resources.get(url));
  } };
};
const create = (storage, remote) => new ProjectSyncEngine({ storage, transport: remote.transport, endpointUrl, stateDir });
const noBodyCache = (storage) => {
  assert.ok(!storage.writes.some((path) => path.startsWith(`${stateDir}/bases/`)), "sync must never generate a full-text baseline cache");
  assert.ok(!storage.reads.some((path) => path.startsWith(`${stateDir}/bases/`)), "sync must not depend on cached baseline text");
  assert.ok(![...storage.files.keys()].some((path) => path.startsWith(`${stateDir}/bases/`)));
};
const modes = [
  { name: "ordinary", sync: (engine) => engine.sync(), protectedPath: translation, paths: Object.keys(contents) },
  { name: "lesson", sync: (engine) => engine.syncLesson(original), protectedPath: translation, paths: [original, translation, image] },
  { name: "knowledge", sync: (engine) => engine.syncKnowledgeEntry(card), protectedPath: card, paths: [card, image] },
];

async function syncModes() {
  for (const mode of modes) {
    const storage = new Storage();
    const legacyPath = `${stateDir}/bases/${hash(bytes("legacy text"))}.bin`;
    storage.files.set(legacyPath, bytes("legacy text"));
    storage.removeLegacyBaseCache = async () => {
      assert.ok(!storage.files.has(`${stateDir}/journal.json`), "restore unfinished transactions before cache migration");
      const removed = storage.files.delete(legacyPath);
      return Number(removed);
    };
    const remote = release(contents, "v1");
    await mode.sync(create(storage, remote));
    assert.ok(!storage.files.has(legacyPath), `${mode.name} migrates old caches even outside the plugin startup entry point`);
    assert.deepStrictEqual(Object.keys(storage.state().files).sort(), [...mode.paths].sort(), mode.name);
    for (const path of mode.paths) assert.strictEqual(storage.state().files[path], hash(bytes(contents[path])));
    noBodyCache(storage);

    // Unchanged Markdown still supplies its references when an attachment needs restoring.
    storage.files.delete(image);
    remote.requests.length = 0;
    const repaired = await mode.sync(create(storage, remote));
    assert.strictEqual(repaired.downloadedFiles, 1, `${mode.name} restores only the missing attachment`);
    assert.deepStrictEqual(storage.files.get(image), bytes(contents[image]));
    assert.deepStrictEqual(remote.requests.filter((url) => url.includes("/files/")), [remote.files.find((file) => file.path === image).url]);
    noBodyCache(storage);

    const changed = { ...contents, [original]: contents[original] + "Updated French\n", [translation]: contents[translation] + "新版译文\n",
      [card]: contents[card] + "新版知识卡\n", [image]: bytes([3, 4, 5]) };
    for (const version of ["v2", "v3"]) {
      const update = await mode.sync(create(storage, release(changed, version)));
      assert.strictEqual(update.skippedFiles.length, 0);
      for (const path of mode.paths) assert.strictEqual(storage.state().files[path], hash(bytes(changed[path])));
      noBodyCache(storage);
    }

    const previousHashes = { ...storage.state().files };
    storage.files.set(mode.protectedPath, bytes("my private changes\n"));
    const newer = { ...changed, [mode.protectedPath]: "upstream replacement\n" };
    const skipped = await mode.sync(create(storage, release(newer, "v4")));
    assert.ok(skipped.skippedFiles.some((entry) => entry.path === mode.protectedPath && entry.reason === "local_modified"), mode.name);
    assert.strictEqual(storage.text(mode.protectedPath), "my private changes\n");
    assert.deepStrictEqual(storage.state().files, previousHashes, `${mode.name} never blesses local edits as a new baseline`);
    noBodyCache(storage);
  }
}

async function changedReferenceDuringAdoption() {
  const storage = new Storage();
  const remote = release(contents, "v1");
  await create(storage, remote).syncLesson(original);
  const stateBefore = storage.text(`${stateDir}/state.json`);
  let reads = 0;
  storage.beforeRead = async (path) => {
    if (path !== original || ++reads !== 2) return;
    storage.files.set(original, bytes("my edit ![new reference](../../../assets/unused.png)\n"));
  };
  remote.requests.length = 0;
  const result = await create(storage, remote).syncLesson(original);
  assert.strictEqual(result.skippedFiles.length, 2, "an edit while inspecting adopted text protects the whole lesson");
  assert.strictEqual(storage.text(original), "my edit ![new reference](../../../assets/unused.png)\n");
  assert.strictEqual(storage.text(translation), contents[translation]);
  assert.strictEqual(storage.text(`${stateDir}/state.json`), stateBefore);
  assert.ok(!storage.files.has(unused), "racing private references cannot pull extra attachments into this sync");
  assert.ok(!remote.requests.some((url) => url.includes("/files/")));
  noBodyCache(storage);
}

async function cleanupMigration() {
  const storage = new Storage();
  await create(storage, release(contents, "v1")).syncLesson(original);
  const baseline = storage.text(`${stateDir}/state.json`);
  storage.files.set(original, bytes("private local changes"));
  const legacyPath = `${stateDir}/bases/${hash(bytes(contents[original]))}.bin`;
  storage.files.set(legacyPath, bytes(contents[original]));
  let cleanupCalls = 0;
  storage.removeLegacyBaseCache = async () => { cleanupCalls++; return Number(storage.files.delete(legacyPath)); };
  const offline = create(storage, { transport: async () => assert.fail("cache cleanup must work offline") });
  assert.strictEqual(await offline.cleanupLegacyBaseCache(), 1);
  assert.strictEqual(storage.text(original), "private local changes");
  assert.strictEqual(storage.text(`${stateDir}/state.json`), baseline, "cache migration cannot advance or rewrite trusted baselines");

  const previous = JSON.parse(baseline);
  const backupPath = backupPathFor(stateDir, "unfinished", original);
  const interruptedText = "partially applied replacement";
  storage.files.set(original, bytes(interruptedText));
  storage.files.set(backupPath, bytes("corrupt backup"));
  storage.files.set(legacyPath, bytes(contents[original]));
  storage.files.set(`${stateDir}/journal.json`, bytes(JSON.stringify({ schema_version: 1, id: "unfinished", previous_state: previous,
    entries: [{ path: original, beforeHash: hash(bytes(contents[original])), afterHash: hash(bytes(interruptedText)), backupPath }] })));
  await assert.rejects(offline.cleanupLegacyBaseCache(), /备份损坏/);
  assert.strictEqual(cleanupCalls, 1, "a failed transaction recovery must not start cache deletion");
  assert.ok(storage.files.has(legacyPath));
  assert.strictEqual(offline.running, false, "recovery failure releases the sync lock for repair and retry");

  storage.files.set(backupPath, bytes(contents[original]));
  storage.removeLegacyBaseCache = async () => {
    cleanupCalls++;
    assert.strictEqual(storage.text(original), contents[original], "recover the partially applied file before deleting caches");
    assert.deepStrictEqual(storage.state(), previous);
    assert.ok(!storage.files.has(`${stateDir}/journal.json`));
    assert.ok(!storage.files.has(backupPath));
    return Number(storage.files.delete(legacyPath));
  };
  assert.strictEqual(await offline.cleanupLegacyBaseCache(), 1);
  assert.strictEqual(cleanupCalls, 2);

  let finishCleanup;
  storage.removeLegacyBaseCache = () => new Promise((resolve) => { finishCleanup = resolve; });
  const pending = offline.cleanupLegacyBaseCache();
  await new Promise(setImmediate);
  await assert.rejects(offline.sync(), /正在进行/, "a cache migration holds the same lock as ordinary synchronization");
  finishCleanup(0);
  assert.strictEqual(await pending, 0);
  assert.strictEqual(offline.running, false);

  storage.removeLegacyBaseCache = async () => { throw new Error("cleanup denied"); };
  await assert.rejects(offline.cleanupLegacyBaseCache(), /cleanup denied/);
  assert.strictEqual(offline.running, false, "cache deletion failures release the sync lock");
  storage.removeLegacyBaseCache = async () => 0;
  assert.strictEqual(await offline.cleanupLegacyBaseCache(), 0, "cleanup can be retried after deletion errors");
  assert.deepStrictEqual(storage.state(), previous);
}

syncModes().then(changedReferenceDuringAdoption).then(cleanupMigration)
  .then(() => console.log("Hash-only sync, attachments, local protection, adoption races and offline migration/recovery tests passed"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
