const assert = require("assert");
const { createHash } = require("crypto");
const { ProjectSyncEngine } = require("../src/project-sync");
const { validateManifest } = require("../src/project-sync/validation");
const { createAssetIndex, referencedAssets } = require("../src/project-sync/catalog");

const bytes = (value) => Buffer.from(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const origin = "https://reading.example";
const endpointUrl = `${origin}/wp-json/lctp/v1/project`;
const stateDir = ".obsidian/plugins/lacan-translation-helper/project-sync";
const card = "知识库/欲望与对象.md";
const other = "知识库/关联词条.md";
const image = "assets/figure.png";
const pdf = "知识库/assets/source.pdf";
const unused = "assets/unused.png";
const markdown = "# 欲望\n![图](../assets/figure.png) [来源](assets/source.pdf) [[知识库/关联词条|关联词条]]\n";
const metadata = [{ path: card, title: "欲望与对象", tags: ["主题/欲望", "研讨班/S11"], excerpt: "正文摘录", aliases: ["欲望客体"] },
  { path: other, title: "关联词条", tags: [], excerpt: "关联" }];

class Storage {
  constructor() { this.files = new Map(); this.unsaved = null; this.reads = new Map(); }
  async read(path) { this.reads.set(path, (this.reads.get(path) || 0) + 1); return this.files.has(path) ? bytes(this.files.get(path)) : null; }
  async write(path, data) { this.files.set(path, bytes(data)); }
  async remove(path) { this.files.delete(path); }
  hasUnsavedChanges(path) { return this.unsaved === path; }
  async compareAndWrite(path, expected, data) {
    if (this.beforeCompare) await this.beforeCompare(path);
    const current = this.files.get(path);
    if ((current === undefined ? null : hash(current)) !== expected || this.unsaved === path) return false;
    if (data === null) await this.remove(path); else await this.write(path, data);
    return true;
  }
  text(path) { return this.files.get(path)?.toString("utf8"); }
}

const release = (contents, version = "v1", entries = metadata) => {
  const resources = new Map();
  const files = Object.entries(contents).map(([path, value]) => {
    const data = bytes(value);
    const url = `${origin}/${version}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
    resources.set(url, data);
    return { path, url, size: data.length, sha256: hash(data) };
  });
  const value = { schema_version: 1, version, files, ...(entries === undefined ? {} : { knowledge_entries: entries }) };
  const manifest = bytes(JSON.stringify(value));
  const latest = { schema_version: 1, version, source_revision: "a".repeat(40), manifest_url: `${origin}/${version}/manifest.json`, manifest_sha256: hash(manifest), file_count: files.length };
  resources.set(latest.manifest_url, manifest);
  resources.set(endpointUrl, bytes(JSON.stringify(latest)));
  const requests = [];
  return { files, resources, value, latest, requests, transport: async (url) => {
    requests.push(url);
    if (!resources.has(url)) throw new Error("fixture unavailable");
    return bytes(resources.get(url));
  } };
};
const contents = { [card]: markdown, [other]: "# 另一词条\n![[assets/figure.png]]", [image]: bytes([0, 1, 2]), [pdf]: "%PDF", [unused]: bytes([9]) };
const create = (storage, remote, options = {}) => new ProjectSyncEngine({ storage, transport: remote.transport, endpointUrl, stateDir, ...options });
const contentPaths = (storage) => [...storage.files.keys()].filter((path) => !path.startsWith(".obsidian/"));

async function bulkTests() {
  const storage = new Storage();
  const remote = release(contents);
  const fetch = remote.transport;
  let active = 0;
  let maxActive = 0;
  remote.transport = async (url) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise(setImmediate);
      return await fetch(url);
    } finally { active -= 1; }
  };
  const engine = create(storage, remote);
  const starts = [];
  const completed = [];
  const orderedPaths = [card, "知识库/私人卡.md", other];
  const getOrderedPaths = () => orderedPaths;
  const result = await engine.syncAllKnowledgeEntries({ getOrderedPaths, onEntry: async (event) => {
    if (event.result) { completed.push(event.entry.path); return; }
    starts.push(event.entry.path);
    await assert.rejects(engine.syncKnowledgeEntry(other), /正在进行/, "the batch keeps the engine lock between entries");
    if (event.index === 1) assert.ok(storage.files.has(card) && storage.files.has(pdf), "finish a card and its attachments before starting the next");
  } });
  assert.deepStrictEqual(starts, [card, other], "download in Base directory order, regardless of manifest order or filters");
  assert.deepStrictEqual(completed, starts);
  assert.strictEqual(maxActive, 1, "metadata, cards and attachments never download concurrently");
  assert.strictEqual(remote.requests.filter((url) => url === endpointUrl).length, 1);
  assert.strictEqual(remote.requests.filter((url) => url === remote.latest.manifest_url).length, 1, "reuse one release for the entire batch");
  const urlFor = (path) => remote.files.find((file) => file.path === path).url;
  assert.deepStrictEqual(remote.requests.filter((url) => remote.files.some((file) => file.url === url)), [card, image, pdf, other].map(urlFor));
  assert.strictEqual(result.completedEntries, 2);
  assert.strictEqual(result.skippedEntries, 0);
  assert.strictEqual(result.downloadedFiles, 4, "shared attachment downloads only once");
  assert.strictEqual(result.usedArchive, false);
  assert.ok(!storage.files.has(unused), "unreferenced assets stay remote");
  remote.requests.length = 0;
  assert.strictEqual((await engine.syncAllKnowledgeEntries({ getOrderedPaths })).downloadedFiles, 0);
  assert.strictEqual(remote.requests.length, 2, "already-current knowledge needs only the single release check");

  const protectedStorage = new Storage();
  await protectedStorage.write(card, bytes("local edits"));
  const protectedResult = await create(protectedStorage, release(contents)).syncAllKnowledgeEntries({ getOrderedPaths });
  assert.strictEqual(protectedResult.completedEntries, 2);
  assert.strictEqual(protectedResult.skippedEntries, 1);
  assert.strictEqual(protectedStorage.text(card), "local edits");
  assert.ok(protectedStorage.files.has(other), "a protected local card does not prevent later cards from syncing");

  const controller = new AbortController();
  const cancelledStorage = new Storage();
  const cancelRemote = release(contents);
  await assert.rejects(create(cancelledStorage, cancelRemote).syncAllKnowledgeEntries({ getOrderedPaths, signal: controller.signal,
    onEntry: ({ result }) => { if (result) controller.abort(); },
  }), { name: "AbortError" });
  assert.ok(cancelledStorage.files.has(card), "cancel keeps completed cards");
  assert.ok(!cancelledStorage.files.has(other), "cancel never starts the next card");
  assert.ok(!cancelRemote.requests.includes(cancelRemote.files.find((file) => file.path === other).url));

  const failingStorage = new Storage();
  const failedRemote = release(contents);
  failedRemote.resources.delete(failedRemote.files.find((file) => file.path === other).url);
  const failedEngine = create(failingStorage, failedRemote);
  await assert.rejects(failedEngine.syncAllKnowledgeEntries({ getOrderedPaths }), /unavailable/);
  assert.ok(failingStorage.files.has(card) && failingStorage.files.has(pdf), "a later failure keeps earlier committed entries");
  assert.ok(!failingStorage.files.has(other));
  assert.strictEqual(failedEngine.running, false, "failure releases the batch lock for retry");

  const noEntries = await create(new Storage(), release({ [unused]: contents[unused] }, "empty", [])).syncAllKnowledgeEntries();
  assert.strictEqual(noEntries.completedEntries, 0);
  assert.strictEqual(noEntries.downloadedFiles, 0);
}

async function assetIndexTests() {
  const files = ["assets/a.png", "other/a.png", "assets/source.pdf"].map((path) => ({ path }));
  const text = "![[a.png]] ![exact](../assets/a.png) [source](../assets/source.pdf) <img src='../other/a.png'>";
  const index = createAssetIndex(files);
  assert.deepStrictEqual(referencedAssets(text, card, files, index), referencedAssets(text, card, files), "reusing the index preserves reference ordering and resolution");
  assert.deepStrictEqual(referencedAssets("![[a.png]]", card, files, index), [], "ambiguous bare names remain unresolved");
  files.push({ path: "assets/new.png" });
  assert.deepStrictEqual(referencedAssets("![](../assets/new.png)", card, files), ["assets/new.png"], "the legacy API builds from current input rather than caching mutable arrays");

  const storage = new Storage();
  const cards = Array.from({ length: 20 }, (_, number) => ({ path: `知识库/card-${number}.md` }));
  const body = bytes("![shared](../assets/asset-0.png)");
  for (const entry of cards) await storage.write(entry.path, body);
  let pathReads = 0;
  const assets = Array.from({ length: 500 }, (_, number) => ({
    get path() { pathReads++; return `assets/asset-${number}.png`; }, sha256: hash(bytes("asset")),
  }));
  const catalog = { knowledgeEntries: cards, files: [...cards.map((entry) => ({ ...entry, sha256: hash(body) })), ...assets] };
  const engine = create(storage, release(contents));
  const statuses = await engine.getKnowledgeEntryStatuses(catalog);
  assert.strictEqual(Object.keys(statuses).length, cards.length);
  assert.strictEqual(pathReads, 1500, "one remote map and one shared asset index replace per-card file-list scans");
  console.log("Knowledge attachment indexing: 20 cards × 500 assets; asset path reads 20500 → 1500");
}

async function run() {
  await bulkTests();
  await assetIndexTests();
  const storage = new Storage();
  const remote = release(contents);
  const engine = create(storage, remote);
  const catalog = await engine.getCatalog();
  assert.strictEqual(catalog.knowledgeEntries.length, 2);
  assert.strictEqual(catalog.knowledgeMetadataAvailable, true);
  const entry = catalog.knowledgeEntries.find((item) => item.path === card);
  assert.deepStrictEqual(entry.aliases, ["欲望客体"]);
  assert.strictEqual(entry.sha256, hash(bytes(markdown)));
  assert.deepStrictEqual(contentPaths(storage), [], "catalog fetch must not create Markdown placeholders");
  assert.strictEqual(remote.requests.length, 2);
  const offline = new ProjectSyncEngine({ storage, endpointUrl, stateDir, transport: async () => { throw new Error("offline"); } });
  assert.deepStrictEqual(await offline.readCachedCatalog(), catalog);
  assert.strictEqual((await offline.getKnowledgeEntryStatuses(catalog))[card].status, "not_synced");

  const result = await engine.syncKnowledgeEntry(card);
  assert.strictEqual(result.downloadedFiles, 3);
  assert.deepStrictEqual(result.catalog, catalog);
  assert.deepStrictEqual(await offline.readCachedCatalog(), catalog);
  assert.deepStrictEqual(contentPaths(storage).sort(), [card, image, pdf].sort());
  assert.ok(!storage.files.has(other) && !storage.files.has(unused), "related cards and unused assets stay remote");
  assert.strictEqual((await offline.getKnowledgeEntryStatuses(catalog))[card].status, "synced");
  assert.strictEqual((await engine.syncKnowledgeEntry(card)).downloadedFiles, 0);
  await engine.syncKnowledgeEntry(other);
  storage.reads.clear();
  await offline.getKnowledgeEntryStatuses(catalog);
  assert.strictEqual(storage.reads.get(image), 1, "shared assets are read and hashed once per status scan");

  await storage.remove(image);
  let statuses = await offline.getKnowledgeEntryStatuses(catalog);
  assert.strictEqual(statuses[card].status, "missing_assets");
  assert.strictEqual(statuses[other].status, "missing_assets");
  await engine.syncKnowledgeEntry(card);
  assert.strictEqual((await offline.getKnowledgeEntryStatuses(catalog))[other].status, "synced");
  const changed = release({ ...contents, [image]: bytes([3, 4, 5]) }, "v2");
  const changedEngine = create(storage, changed);
  const changedCatalog = await changedEngine.getCatalog();
  assert.strictEqual((await changedEngine.getKnowledgeEntryStatuses(changedCatalog))[card].status, "update");
  await changedEngine.syncKnowledgeEntry(card);
  assert.strictEqual((await changedEngine.getKnowledgeEntryStatuses(changedCatalog))[other].status, "synced", "shared asset updates refresh every dependent card status");

  await storage.write(image, bytes([8, 8]));
  const previous = storage.text(`${stateDir}/state.json`);
  statuses = await changedEngine.getKnowledgeEntryStatuses(changedCatalog);
  assert.strictEqual(statuses[card].status, "modified");
  assert.strictEqual(statuses[other].status, "modified");
  const skipped = await changedEngine.syncKnowledgeEntry(card);
  assert.ok(skipped.skippedFiles.some((item) => item.path === image && item.reason === "local_modified"));
  assert.strictEqual(storage.text(`${stateDir}/state.json`), previous);
  assert.deepStrictEqual(storage.files.get(image), bytes([8, 8]));
  await storage.write(image, bytes([3, 4, 5]));
  storage.unsaved = card;
  assert.strictEqual((await changedEngine.getKnowledgeEntryStatuses(changedCatalog))[card].status, "modified");
  assert.strictEqual((await changedEngine.syncKnowledgeEntry(card)).downloadedFiles, 0);
  storage.unsaved = null;

  const unknown = new Storage();
  await unknown.write(card, bytes("my local card"));
  const unknownEngine = create(unknown, remote);
  assert.strictEqual((await unknownEngine.getKnowledgeEntryStatuses(catalog))[card].status, "modified");
  assert.ok((await unknownEngine.syncKnowledgeEntry(card)).skippedFiles.length);
  assert.strictEqual(unknown.text(card), "my local card");

  const removed = release({ [other]: contents[other], [image]: contents[image] }, "v3", [metadata[1]]);
  const beforeRemoved = new Map(storage.files);
  const removedEngine = create(storage, removed);
  assert.strictEqual((await removedEngine.syncKnowledgeEntry(card)).removed, true);
  assert.deepStrictEqual(storage.files, beforeRemoved, "removed upstream cards never alter files or baselines");
  assert.strictEqual((await removedEngine.getKnowledgeEntryStatuses(await removedEngine.getCatalog()))[card].status, "removed");

  const missing = release(contents);
  missing.resources.delete(missing.files.find((item) => item.path === pdf).url);
  const failed = new Storage();
  await assert.rejects(create(failed, missing).syncKnowledgeEntry(card), /unavailable/);
  assert.deepStrictEqual(contentPaths(failed), [], "failed attachment download never writes the card");
  assert.strictEqual(failed.text(`${stateDir}/state.json`), undefined);
  const cancelled = new Storage();
  const controller = new AbortController();
  const cancelRemote = release(contents);
  const fetch = cancelRemote.transport;
  cancelRemote.transport = async (url) => { const data = await fetch(url); if (url === cancelRemote.files.find((file) => file.path === image).url) controller.abort(); return data; };
  await assert.rejects(create(cancelled, cancelRemote).syncKnowledgeEntry(card, { signal: controller.signal }), /取消/);
  assert.deepStrictEqual(contentPaths(cancelled), []);
  assert.strictEqual(cancelled.text(`${stateDir}/state.json`), undefined);

  const racing = new Storage();
  await create(racing, remote).syncKnowledgeEntry(card);
  const raceBefore = racing.text(`${stateDir}/state.json`);
  racing.beforeCompare = async (path) => { if (path === image) { racing.files.set(card, bytes("edited during sync")); racing.beforeCompare = null; } };
  const raceResult = await create(racing, changed).syncKnowledgeEntry(card);
  assert.ok(raceResult.skippedFiles.length);
  assert.strictEqual(racing.text(card), "edited during sync");
  assert.deepStrictEqual(racing.files.get(image), contents[image]);
  assert.strictEqual(racing.text(`${stateDir}/state.json`), raceBefore);

  const fallback = release({ ...contents, "知识库/README.md": "index", "知识库/empty.md": "" }, "v4", undefined);
  delete fallback.value.knowledge_entries;
  const fallbackManifest = bytes(JSON.stringify(fallback.value));
  fallback.latest.manifest_sha256 = hash(fallbackManifest);
  fallback.resources.set(fallback.latest.manifest_url, fallbackManifest);
  fallback.resources.set(endpointUrl, bytes(JSON.stringify(fallback.latest)));
  const fallbackCatalog = await create(new Storage(), fallback).getCatalog();
  assert.strictEqual(fallbackCatalog.knowledgeMetadataAvailable, false);
  assert.deepStrictEqual(fallbackCatalog.knowledgeEntries.map((item) => item.path).sort(), [card, other].sort());
  const legacy = { schema_version: 1, endpoint_url: endpointUrl, version: "v1", source_revision: null, files: remote.files.map(({ path }) => ({ path })) };
  await storage.write(`${stateDir}/catalog.json`, bytes(JSON.stringify(legacy)));
  const legacyCatalog = await offline.readCachedCatalog();
  assert.strictEqual((await offline.getKnowledgeEntryStatuses(legacyCatalog))[card].status, "unknown");

  for (const bad of [null, [{ ...metadata[0], path: "assets/figure.png" }], [{ ...metadata[0], title: "x".repeat(301) }],
    [{ ...metadata[0], excerpt: "字".repeat(121) }], [{ ...metadata[0], tags: ["x".repeat(161)] }], [metadata[0], metadata[0]],
    [{ ...metadata[0], aliases: Array(33).fill("alias") }]]) {
    assert.throws(() => validateManifest({ ...remote.value, knowledge_entries: bad }, remote.latest, endpointUrl), /知识库/);
  }
  assert.doesNotThrow(() => validateManifest({ ...remote.value, knowledge_entries: [{ ...metadata[0], excerpt: "𠮷".repeat(120) }] }, remote.latest, endpointUrl));
  const validCache = storage.text(`${stateDir}/catalog.json`);
  const invalid = release(contents, "invalid", [{ ...metadata[0], title: "x".repeat(301) }]);
  await assert.rejects(create(storage, invalid).getCatalog(), /知识库/);
  assert.strictEqual(storage.text(`${stateDir}/catalog.json`), validCache, "invalid remote metadata leaves the last valid offline catalog intact");
  await storage.write(`${stateDir}/catalog.json`, bytes(JSON.stringify({ ...legacy, schema_version: 2 })));
  await assert.rejects(offline.readCachedCatalog(), /校验信息/);
  console.log("Knowledge catalog, scoped assets, local protection, status, offline cache and cancellation tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
