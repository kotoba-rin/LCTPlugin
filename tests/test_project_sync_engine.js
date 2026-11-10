const assert = require("assert");
const { createHash, randomBytes } = require("crypto");
const { spawnSync } = require("child_process");
const path = require("path");
const { zipSync } = require("fflate");
const { ProjectSyncEngine, validateContentPath } = require("../src/project-sync");
const { backupPathFor } = require("../src/project-sync/transactions");
const { unpackArchive } = require("../src/project-sync/downloads");

const bytes = (value) => Buffer.from(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const origin = "https://example.test";
const endpointUrl = `${origin}/wp-json/lctp/v1/project`;
const stateDir = ".obsidian/plugins/lacan-translation-helper/project-sync";

class MemoryStorage {
  constructor(initial = {}) {
    this.files = new Map(Object.entries(initial).map(([path, data]) => [path, bytes(data)]));
    this.failPath = null;
    this.beforeWrite = null;
    this.beforeCompare = null;
  }
  async read(path) { return this.files.has(path) ? bytes(this.files.get(path)) : null; }
  async write(path, data) {
    if (this.beforeWrite) await this.beforeWrite(path, data);
    if (path === this.failPath) { this.failPath = null; throw new Error("disk full"); }
    this.files.set(path, bytes(data));
  }
  async remove(path) { this.files.delete(path); }
  async compareAndWrite(path, expectedHash, data) {
    if (this.beforeCompare) await this.beforeCompare(path, expectedHash, data);
    const current = this.files.get(path);
    if ((current ? sha256(current) : null) !== expectedHash) return false;
    if (data === null) await this.remove(path);
    else await this.write(path, data);
    return true;
  }
  text(path) { return this.files.get(path)?.toString("utf8"); }
}

const fixture = (contents, version = "v1") => {
  const resources = new Map();
  const files = Object.entries(contents).map(([path, content]) => {
    const data = bytes(content);
    const url = `${origin}/releases/${version}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
    resources.set(url, data);
    return { path, size: data.length, sha256: sha256(data), url };
  });
  const manifest = bytes(JSON.stringify({ schema_version: 1, version, files }));
  const manifest_url = `${origin}/releases/${version}/manifest.json`;
  resources.set(manifest_url, manifest);
  const latest = { schema_version: 1, version, source_revision: "a".repeat(40), published_at: "2026-11-09T00:00:00Z", manifest_url, manifest_sha256: sha256(manifest), file_count: files.length };
  resources.set(endpointUrl, bytes(JSON.stringify(latest)));
  const requests = [];
  return {
    resources, latest, manifest, files, requests,
    transport: async (url) => {
      requests.push(url);
      assert.ok(resources.has(url), `unexpected request ${url}`);
      return bytes(resources.get(url));
    },
  };
};

const engine = (storage, remote) => new ProjectSyncEngine({ storage, transport: remote.transport, endpointUrl, stateDir });
const addArchive = (remote, contents) => {
  const archive = zipSync(Object.fromEntries(Object.entries(contents).map(([path, content]) => [path, bytes(content)])));
  const url = `${origin}/releases/${remote.latest.version}/project.zip`;
  remote.resources.set(url, archive);
  Object.assign(remote.latest, { archive_url: url, archive_sha256: sha256(archive), archive_size: archive.length });
  remote.resources.set(endpointUrl, bytes(JSON.stringify(remote.latest)));
};
const rewriteManifest = (remote, edit) => {
  const manifest = JSON.parse(remote.manifest);
  edit(manifest);
  remote.manifest = bytes(JSON.stringify(manifest));
  remote.resources.set(remote.latest.manifest_url, remote.manifest);
  remote.latest.manifest_sha256 = sha256(remote.manifest);
  remote.resources.set(endpointUrl, bytes(JSON.stringify(remote.latest)));
};

// Historical conflict records remain readable, but normal sync no longer creates them.
const seedConflict = async (storage, remote, path, kind = "local_modified") => {
  const state = JSON.parse(storage.text(`${stateDir}/state.json`));
  const file = remote.files.find((entry) => entry.path === path);
  const incomingPath = file ? engine(storage, remote).incomingPath(remote.latest.version, file) : null;
  if (file) await storage.write(incomingPath, remote.resources.get(file.url));
  state.version = remote.latest.version;
  state.manifest_sha256 = remote.latest.manifest_sha256;
  state.conflicts = (state.conflicts || []).filter((entry) => entry.path !== path);
  state.conflicts.push({ path, kind, incomingPath,
    localHash: storage.files.has(path) ? sha256(storage.files.get(path)) : null,
    upstreamHash: file?.sha256 || null, baseHash: state.files[path] || null, upstreamVersion: state.version });
  await storage.write(`${stateDir}/state.json`, bytes(JSON.stringify(state, null, 2)));
  await storage.write(`${stateDir}/conflicts.json`, bytes(JSON.stringify({ version: state.version, conflicts: state.conflicts }, null, 2)));
};

const run = async () => {
  const storage = new MemoryStorage({ "my-note.md": "private note" });
  const remote = fixture({ "texts/s14/original/Leçon-01.md": "<!-- id: s14-01-0001 -->\nFrench", "知识库/概念.md": "card" });
  const result = await engine(storage, remote).sync();
  assert.strictEqual(result.added, 2, "first sync must create all published files without invoking Git");
  assert.strictEqual(storage.text("texts/s14/original/Leçon-01.md"), "<!-- id: s14-01-0001 -->\nFrench");
  assert.strictEqual(storage.text("my-note.md"), "private note");
  assert.ok(![...storage.files.keys()].some((path) => path.startsWith(`${stateDir}/bases/`)),
    "ordinary sync stores trusted hashes in state.json without duplicating text bodies");

  remote.requests.length = 0;
  const unchanged = await engine(storage, remote).sync();
  assert.strictEqual(unchanged.downloadedFiles, 0);
  assert.deepStrictEqual(remote.requests, [endpointUrl, remote.latest.manifest_url], "unchanged sync only requests metadata");
  assert.ok(![...storage.files.keys()].some((path) => path.includes("/incoming/")), "successful writes do not retain a duplicate library");

  const fullContents = { "texts/s14/original/Leçon-02.md": "French 2", "assets/figure.png": new Uint8Array([0, 1, 254, 255]) };
  const archiveRemote = fixture(fullContents);
  addArchive(archiveRemote, fullContents);
  const archiveStorage = new MemoryStorage({ ".obsidian/keep.json": "settings" });
  const archiveResult = await engine(archiveStorage, archiveRemote).sync();
  assert.strictEqual(archiveResult.usedArchive, true);
  assert.strictEqual(archiveResult.added, 2);
  assert.strictEqual(archiveStorage.text(".obsidian/keep.json"), "settings");
  assert.deepStrictEqual(archiveStorage.files.get("assets/figure.png"), bytes(fullContents["assets/figure.png"]));
  assert.ok(!archiveRemote.requests.some((url) => url.includes("/files/")), "initial archive avoids per-file requests");

  const p = "texts/s14/translation/Leçon-01.md";
  const note = "texts/s14/notes/s14-01.md";
  const autoStorage = new MemoryStorage();
  await engine(autoStorage, fixture({ [p]: "a\nb\nc\nd\n" })).sync();
  const baseBefore = autoStorage.text(`${stateDir}/state.json`);
  autoStorage.files.set(p, bytes("a\nlocal b\nc\nd\n"));
  const autoUpstream = "a\nb\nc\nupstream d\n";
  const autoResult = await engine(autoStorage, fixture({ [p]: autoUpstream }, "v2")).sync();
  assert.strictEqual(autoStorage.text(p), "a\nlocal b\nc\nd\n", "even non-overlapping upstream edits must skip the entire user-modified document");
  assert.strictEqual(autoResult.merged, 0);
  assert.deepStrictEqual(autoResult.skippedFiles, [{ path: p, reason: "local_modified" }]);
  assert.strictEqual(autoStorage.text(`${stateDir}/state.json`), baseBefore, "a skipped document does not advance its original baseline");
  const autoAgain = await engine(autoStorage, fixture({ [p]: "upstream a\nb\nc\nupstream d\n" }, "v3")).sync();
  assert.strictEqual(autoAgain.skippedFiles.length, 1);
  assert.strictEqual(autoStorage.text(p), "a\nlocal b\nc\nd\n");

  const resolveStorage = new MemoryStorage();
  const crlfBase = "标题\r\n原译\r\n笔记\r\n尾部\r\n";
  await engine(resolveStorage, fixture({ [p]: crlfBase })).sync();
  resolveStorage.files.set(p, bytes("标题\r\n我的译文\r\n笔记\r\n尾部\r\n"));
  const resolveUpstream = "标题\n官方译文\n笔记\n尾部\n";
  const resolveRemote = fixture({ [p]: resolveUpstream }, "v2");
  const resolver = engine(resolveStorage, resolveRemote);
  const overlapping = await resolver.sync();
  assert.strictEqual(overlapping.conflicts.length, 0);
  assert.strictEqual(overlapping.skippedFiles.length, 1);
  await seedConflict(resolveStorage, resolveRemote, p);
  const comparison = await resolver.getConflictComparison(p);
  assert.strictEqual(comparison.baseText, null, "hash-only state cannot reconstruct the previous full text");
  assert.strictEqual(comparison.missingBase, true);
  assert.strictEqual(comparison.localText, "标题\r\n我的译文\r\n笔记\r\n尾部\r\n");
  assert.strictEqual(comparison.upstreamText, resolveUpstream);
  assert.ok(comparison.blocks.some((block) => block.conflict));
  assert.strictEqual(comparison.eol, "\r\n");
  const resolved = await resolver.resolveConflict(p, { expectedLocalHash: comparison.localHash, expectedUpstreamHash: comparison.upstreamHash,
    content: "标题\n人工合并译文\n笔记\n尾部\n" });
  assert.strictEqual(resolved.conflicts.length, 0);
  assert.strictEqual(resolveStorage.text(p), "标题\r\n人工合并译文\r\n笔记\r\n尾部\r\n");
  const resolveState = JSON.parse(resolveStorage.text(`${stateDir}/state.json`));
  assert.strictEqual(resolveState.files[p], sha256(bytes(resolveUpstream)));
  assert.ok(![...resolveStorage.files.keys()].some((path) => path.startsWith(`${stateDir}/bases/`)),
    "explicit legacy conflict resolution must not recreate full-text baseline caches");
  assert.strictEqual((await resolver.sync()).conflicts.length, 0, "an explicitly resolved local patch does not immediately conflict again");
  resolver.transport = fixture({ [p]: "新版标题\n官方译文\n笔记\n尾部\n" }, "v3").transport;
  assert.strictEqual((await resolver.sync()).skippedFiles.length, 1);
  assert.strictEqual(resolveStorage.text(p), "标题\r\n人工合并译文\r\n笔记\r\n尾部\r\n");

  const staleStorage = new MemoryStorage();
  await engine(staleStorage, fixture({ [p]: "old" })).sync();
  staleStorage.files.set(p, bytes("local"));
  const staleEngine = engine(staleStorage, fixture({ [p]: "remote" }, "v2"));
  await seedConflict(staleStorage, fixture({ [p]: "remote" }, "v2"), p);
  const staleComparison = await staleEngine.getConflictComparison(p);
  staleStorage.files.set(p, bytes("edited while dialog open"));
  const staleState = staleStorage.text(`${stateDir}/state.json`);
  await assert.rejects(staleEngine.resolveConflict(p, { expectedLocalHash: staleComparison.localHash, expectedUpstreamHash: staleComparison.upstreamHash, content: "overwrite" }), /已变化/);
  assert.strictEqual(staleStorage.text(p), "edited while dialog open");
  assert.strictEqual(staleStorage.text(`${stateDir}/state.json`), staleState);
  await assert.rejects(staleEngine.resolveConflict(p, { expectedLocalHash: sha256(bytes("edited while dialog open")), expectedUpstreamHash: "0".repeat(64), content: "overwrite" }), /已变化/);

  const casStorage = new MemoryStorage();
  await engine(casStorage, fixture({ [p]: "old" })).sync();
  casStorage.files.set(p, bytes("local"));
  const casEngine = engine(casStorage, fixture({ [p]: "remote" }, "v2"));
  await seedConflict(casStorage, fixture({ [p]: "remote" }, "v2"), p);
  const casComparison = await casEngine.getConflictComparison(p);
  const casState = casStorage.text(`${stateDir}/state.json`);
  casStorage.beforeCompare = async () => { casStorage.files.set(p, bytes("racing edit")); casStorage.beforeCompare = null; };
  await assert.rejects(casEngine.resolveConflict(p, { expectedLocalHash: casComparison.localHash, expectedUpstreamHash: casComparison.upstreamHash, content: "manual" }), /已发生变化/);
  assert.strictEqual(casStorage.text(p), "racing edit");
  assert.strictEqual(casStorage.text(`${stateDir}/state.json`), casState);

  const resolutionFailureStorage = new MemoryStorage();
  await engine(resolutionFailureStorage, fixture({ [p]: "old" })).sync();
  resolutionFailureStorage.files.set(p, bytes("local"));
  const resolutionFailureEngine = engine(resolutionFailureStorage, fixture({ [p]: "remote" }, "v2"));
  await seedConflict(resolutionFailureStorage, fixture({ [p]: "remote" }, "v2"), p);
  const beforeFailedResolution = await resolutionFailureEngine.getConflictComparison(p);
  resolutionFailureStorage.failPath = `${stateDir}/state.json`;
  await assert.rejects(resolutionFailureEngine.resolveConflict(p, { expectedLocalHash: beforeFailedResolution.localHash,
    expectedUpstreamHash: beforeFailedResolution.upstreamHash, content: "manual" }), /disk full/);
  assert.strictEqual(resolutionFailureStorage.text(p), "local");
  assert.strictEqual(JSON.parse(resolutionFailureStorage.text(`${stateDir}/conflicts.json`)).conflicts.length, 1,
    "failed resolution must restore the report as well as the working file and baseline");

  const legacyStorage = new MemoryStorage({ [p]: "a\nb\nc\nd\n", [`${stateDir}/state.json`]: JSON.stringify({ schema_version: 1, version: "v0", files: { [p]: sha256(bytes("a\nb\nc\nd\n")) }, conflicts: [] }) });
  await engine(legacyStorage, fixture({ [p]: "A\nb\nc\nd\n" })).sync();
  assert.ok(![...legacyStorage.files.keys()].some((path) => path.startsWith(`${stateDir}/bases/`)),
    "legacy state upgrades preserve hash-based protection without caching the old body");
  assert.strictEqual(JSON.parse(legacyStorage.text(`${stateDir}/state.json`)).files[p], sha256(bytes("A\nb\nc\nd\n")));
  const legacyModified = new MemoryStorage({ [p]: "my legacy edit", [`${stateDir}/state.json`]: JSON.stringify({ schema_version: 1, version: "v0", files: { [p]: sha256(bytes("old upstream")) }, conflicts: [] }) });
  const legacyEngine = engine(legacyModified, fixture({ [p]: "new upstream" }));
  assert.strictEqual((await legacyEngine.sync()).skippedFiles[0].reason, "local_modified");
  await seedConflict(legacyModified, fixture({ [p]: "new upstream" }), p, "missing_base");
  const legacyComparison = await legacyEngine.getConflictComparison(p);
  assert.strictEqual(legacyComparison.baseText, null);
  assert.strictEqual(legacyComparison.missingBase, true);
  assert.strictEqual(legacyModified.text(p), "my legacy edit");
  await legacyEngine.resolveConflict(p, { expectedLocalHash: legacyComparison.localHash,
    expectedUpstreamHash: legacyComparison.upstreamHash, content: "my legacy edit" });
  assert.strictEqual((await legacyEngine.sync()).conflicts.length, 0, "explicitly accepting a legacy local version establishes the real upstream base");

  const explicitDeletion = new MemoryStorage();
  await engine(explicitDeletion, fixture({ [p]: "old" })).sync();
  explicitDeletion.files.delete(p);
  const deletionEngine = engine(explicitDeletion, fixture({ [p]: "new" }, "v2"));
  await seedConflict(explicitDeletion, fixture({ [p]: "new" }, "v2"), p, "local_deleted");
  const deletionComparison = await deletionEngine.getConflictComparison(p);
  assert.strictEqual(deletionComparison.localText, null);
  await deletionEngine.resolveConflict(p, { expectedLocalHash: null, expectedUpstreamHash: deletionComparison.upstreamHash, content: null });
  assert.strictEqual((await deletionEngine.sync()).conflicts.length, 0, "new explicit sync restores even a previously confirmed deletion");
  assert.strictEqual(explicitDeletion.text(p), "new");
  assert.deepStrictEqual(JSON.parse(explicitDeletion.text(`${stateDir}/state.json`)).local_deletions, {});

  const removedUpstreamStorage = new MemoryStorage();
  await engine(removedUpstreamStorage, fixture({ [p]: "old", [note]: "published note" })).sync();
  removedUpstreamStorage.files.set(p, bytes("private kept translation"));
  const removedUpstreamEngine = engine(removedUpstreamStorage, fixture({ [note]: "published note" }, "v2"));
  await seedConflict(removedUpstreamStorage, fixture({ [note]: "published note" }, "v2"), p, "upstream_deleted");
  const removedUpstreamComparison = await removedUpstreamEngine.getConflictComparison(p);
  assert.strictEqual(removedUpstreamComparison.upstreamText, null);
  await removedUpstreamEngine.resolveConflict(p, { expectedLocalHash: removedUpstreamComparison.localHash,
    expectedUpstreamHash: null, content: "private kept translation" });
  assert.strictEqual(JSON.parse(removedUpstreamStorage.text(`${stateDir}/state.json`)).files[p], undefined);
  assert.strictEqual((await removedUpstreamEngine.sync()).conflicts.length, 0);
  assert.strictEqual(removedUpstreamStorage.text(p), "private kept translation");
  removedUpstreamEngine.transport = fixture({ [p]: "reintroduced upstream", [note]: "published note" }, "v3").transport;
  assert.strictEqual((await removedUpstreamEngine.sync()).skippedFiles[0].reason, "existing_local_file");

  const binaryPath = "assets/binary.png";
  const binaryStorage = new MemoryStorage();
  await engine(binaryStorage, fixture({ [binaryPath]: "old image" })).sync();
  assert.strictEqual(binaryStorage.text(`${stateDir}/bases/${sha256(bytes("old image"))}.bin`), undefined, "binary attachments do not consume text-baseline cache storage");
  binaryStorage.files.set(binaryPath, bytes("local image"));
  const binaryEngine = engine(binaryStorage, fixture({ [binaryPath]: "remote image" }, "v2"));
  assert.strictEqual((await binaryEngine.sync()).skippedFiles[0].reason, "local_modified");
  await seedConflict(binaryStorage, fixture({ [binaryPath]: "remote image" }, "v2"), binaryPath, "binary_modified");
  assert.strictEqual((await binaryEngine.getConflictComparison(binaryPath)).canResolveText, false);
  const old = fixture({ [p]: "old translation", "知识库/删除.md": "old card", [note]: "published note" });
  const updatesStorage = new MemoryStorage();
  await engine(updatesStorage, old).sync();
  updatesStorage.files.set("texts/s14/notes/personal.md", bytes("user note"));
  const next = fixture({ [p]: "new translation", "知识库/新增.md": "new card", [note]: "published note" }, "v2");
  const updated = await engine(updatesStorage, next).sync();
  assert.deepStrictEqual([updated.added, updated.updated, updated.deleted, updated.downloadedFiles], [1, 1, 1, 2]);
  assert.strictEqual(updatesStorage.text("texts/s14/notes/personal.md"), "user note");
  assert.strictEqual(updatesStorage.text(p), "new translation");
  assert.strictEqual(updatesStorage.text("知识库/删除.md"), undefined);

  updatesStorage.files.set(p, bytes("my translation with [[notes/personal]]"));
  updatesStorage.files.set(note, bytes("my note additions"));
  const conflicting = fixture({ [p]: "newer translation", [note]: "newer published note" }, "v3");
  const conflicted = await engine(updatesStorage, conflicting).sync();
  assert.strictEqual(conflicted.conflicts.length, 0);
  assert.strictEqual(conflicted.skippedFiles.length, 2);
  assert.strictEqual(updatesStorage.text(p), "my translation with [[notes/personal]]");
  assert.strictEqual(updatesStorage.text(note), "my note additions");
  conflicting.requests.length = 0;
  const repeated = await engine(updatesStorage, conflicting).sync();
  assert.strictEqual(repeated.downloadedFiles, 0, "skipped documents never download replacement bodies");
  assert.strictEqual(repeated.skippedFiles.length, 2);
  const sameConflictsNewVersion = fixture({ [p]: "newer translation", [note]: "newer published note", "知识库/独立更新.md": "new" }, "v4");
  const crossVersionRetry = await engine(updatesStorage, sameConflictsNewVersion).sync();
  assert.strictEqual(crossVersionRetry.downloadedFiles, 1, "only an unrelated new card is downloaded");
  assert.strictEqual(crossVersionRetry.skippedFiles.length, 2);

  const migrationStorage = new MemoryStorage({ [p]: "local existing translation", [note]: "personal notes" });
  const migrationRemote = fixture({ [p]: "official translation", "知识库/新卡.md": "new" });
  const migrated = await engine(migrationStorage, migrationRemote).sync();
  assert.strictEqual(migrated.skippedFiles[0].reason, "existing_local_file");
  assert.strictEqual(migrationStorage.text(p), "local existing translation");
  assert.strictEqual(migrationStorage.text(note), "personal notes");

  const deletionStorage = new MemoryStorage();
  await engine(deletionStorage, fixture({ [p]: "old", [note]: "old note" })).sync();
  deletionStorage.files.delete(p);
  deletionStorage.files.set(note, bytes("my modified note"));
  const deletedRemote = fixture({ [p]: "new" }, "v2");
  const deletions = await engine(deletionStorage, deletedRemote).sync();
  assert.deepStrictEqual(deletions.conflicts, []);
  assert.strictEqual(deletions.skippedFiles[0].reason, "upstream_deleted");
  assert.strictEqual(deletionStorage.text(p), "new");
  assert.strictEqual(deletionStorage.text(note), "my modified note");

  const brokenStorage = new MemoryStorage();
  const brokenRemote = fixture({ [p]: "good", [note]: "note" });
  brokenRemote.resources.set(brokenRemote.files[1].url, bytes("evil"));
  await assert.rejects(engine(brokenStorage, brokenRemote).sync(), /校验失败/);
  assert.strictEqual(brokenStorage.text(p), undefined, "no project writes happen before all downloads verify");

  const rollbackStorage = new MemoryStorage();
  await engine(rollbackStorage, fixture({ [p]: "old", [note]: "old note" })).sync();
  const oldState = rollbackStorage.text(`${stateDir}/state.json`);
  rollbackStorage.failPath = note;
  await assert.rejects(engine(rollbackStorage, fixture({ [p]: "new", [note]: "new note" }, "v2")).sync(), /disk full/);
  assert.strictEqual(rollbackStorage.text(p), "old", "an application failure rolls back previously applied files");
  assert.strictEqual(rollbackStorage.text(note), "old note");
  assert.strictEqual(rollbackStorage.text(`${stateDir}/state.json`), oldState);

  const concurrentStorage = new MemoryStorage();
  await engine(concurrentStorage, fixture({ [p]: "old", [note]: "old note" })).sync();
  concurrentStorage.beforeCompare = async (path) => {
    if (path === p) { concurrentStorage.files.set(p, bytes("edited during download")); concurrentStorage.beforeCompare = null; }
  };
  const concurrent = await engine(concurrentStorage, fixture({ [p]: "new", [note]: "old note" }, "v2")).sync();
  assert.strictEqual(concurrent.skippedFiles.find((entry) => entry.path === p).reason, "changed_during_sync");
  assert.strictEqual(concurrentStorage.text(p), "edited during download");

  const preservationStorage = new MemoryStorage();
  await engine(preservationStorage, fixture({ [p]: "old", [note]: "old note" })).sync();
  preservationStorage.beforeWrite = async (path) => {
    if (path === note) { preservationStorage.files.set(p, bytes("edited after first apply")); preservationStorage.beforeWrite = null; }
  };
  preservationStorage.failPath = note;
  await assert.rejects(engine(preservationStorage, fixture({ [p]: "new", [note]: "new note" }, "v2")).sync(), /disk full/);
  assert.strictEqual(preservationStorage.text(p), "edited after first apply", "rollback never overwrites later local edits");
  const recoveryReport = JSON.parse(preservationStorage.text(`${stateDir}/recovery-conflicts.json`));
  assert.strictEqual(preservationStorage.text(recoveryReport.backups[0].backupPath), "old", "original backup survives a rollback conflict");

  const interrupted = new MemoryStorage();
  await engine(interrupted, fixture({ [p]: "old" })).sync();
  const previousState = JSON.parse(interrupted.text(`${stateDir}/state.json`));
  const backupPath = backupPathFor(stateDir, "interrupted", p);
  interrupted.files.set(backupPath, bytes("old"));
  interrupted.files.set(p, bytes("partly committed new"));
  interrupted.files.set(`${stateDir}/journal.json`, bytes(JSON.stringify({ schema_version: 1, id: "interrupted", previous_state: previousState,
    entries: [{ path: p, beforeHash: sha256(bytes("old")), afterHash: sha256(bytes("partly committed new")), backupPath }] })));
  await engine(interrupted, fixture({ [p]: "old" })).sync();
  assert.strictEqual(interrupted.text(p), "old", "startup recovery repairs an interrupted application");
  assert.strictEqual(interrupted.text(`${stateDir}/journal.json`), undefined);

  const cancelledStorage = new MemoryStorage();
  await engine(cancelledStorage, fixture({ [p]: "old", [note]: "old note" })).sync();
  const aborter = new AbortController();
  cancelledStorage.beforeWrite = async (path) => { if (path === p) aborter.abort(); };
  await assert.rejects(engine(cancelledStorage, fixture({ [p]: "new", [note]: "new note" }, "v2")).sync({ signal: aborter.signal }), /已取消/);
  assert.strictEqual(cancelledStorage.text(p), "old");
  assert.strictEqual(cancelledStorage.text(note), "old note");

  let releaseDownload;
  const pendingRemote = fixture({ [p]: "new" });
  const normalTransport = pendingRemote.transport;
  pendingRemote.transport = async (url) => {
    if (url === endpointUrl) await new Promise((resolve) => { releaseDownload = resolve; });
    return normalTransport(url);
  };
  const lockedEngine = engine(new MemoryStorage(), pendingRemote);
  const pending = lockedEngine.sync();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(lockedEngine.sync(), /正在进行/);
  await assert.rejects(lockedEngine.resolveConflict(p, { expectedLocalHash: null, expectedUpstreamHash: null, content: null }), /正在进行/);
  releaseDownload();
  await pending;

  for (const path of ["../secret.md", ".obsidian/plugins/evil/main.js", "texts/a/../b.md", "texts/a\\b.md", "texts/CON.md", "texts/a. /b.md", "texts/.git/config.md", "texts/a/script.js", "texts/a/e\u0301.md"]) {
    assert.throws(() => validateContentPath(path), undefined, path);
  }
  const malicious = fixture({ [p]: "new" });
  rewriteManifest(malicious, (value) => { value.files[0].url = "https://evil.test/secret"; });
  await assert.rejects(engine(new MemoryStorage(), malicious).sync(), /同源/);
  const duplicate = fixture({ "texts/A/one.md": "one", "texts/a/two.md": "two" });
  await assert.rejects(engine(new MemoryStorage(), duplicate).sync(), /大小写/);
  const malformedArchive = fixture({ [p]: "new" });
  addArchive(malformedArchive, { [p]: "new", "../escape.md": "bad" });
  await assert.rejects(engine(new MemoryStorage(), malformedArchive).sync(), /路径/);

  const immutableStorage = new MemoryStorage();
  await engine(immutableStorage, fixture({ [p]: "old" })).sync();
  await assert.rejects(engine(immutableStorage, fixture({ [p]: "changed without a new version" })).sync(), /同一文库版本/);
  assert.strictEqual(immutableStorage.text(p), "old");
  const corruptStateStorage = new MemoryStorage({ [`${stateDir}/state.json`]: JSON.stringify({ schema_version: 1, files: { "../private.md": "a".repeat(64) } }) });
  await assert.rejects(engine(corruptStateStorage, fixture({ [p]: "new" })).sync(), /路径/);
  assert.strictEqual(corruptStateStorage.text(p), undefined);

  const committedStorage = new MemoryStorage();
  await engine(committedStorage, fixture({ [p]: "new" })).sync();
  const committedState = JSON.parse(committedStorage.text(`${stateDir}/state.json`));
  const committedBackupPath = backupPathFor(stateDir, committedState.last_transaction, p);
  committedStorage.files.set(committedBackupPath, bytes("old"));
  committedStorage.files.set(`${stateDir}/journal.json`, bytes(JSON.stringify({ schema_version: 1, id: committedState.last_transaction,
    previous_state: { schema_version: 1, version: "v0", files: { [p]: sha256(bytes("old")) } },
    entries: [{ path: p, beforeHash: sha256(bytes("old")), afterHash: sha256(bytes("new")), backupPath: committedBackupPath }] })));
  await engine(committedStorage, fixture({ [p]: "new" })).sync();
  assert.strictEqual(committedStorage.text(p), "new", "restart cleanup does not revert a committed state");

  const largeContents = { "assets/large.txt": "abcdef".repeat(250000) };
  const largeRemote = fixture(largeContents);
  addArchive(largeRemote, largeContents);
  const largeStorage = new MemoryStorage();
  await engine(largeStorage, largeRemote).sync();
  assert.strictEqual(largeStorage.text("assets/large.txt").length, 1500000, "large archive entries exercise asynchronous decompression");
  const longPath = `texts/s14/notes/${"long".repeat(40)}.md`;
  const longRemote = fixture({ [longPath]: "remote" }, "v".repeat(80));
  const longStorage = new MemoryStorage({ [longPath]: "local" });
  const longResult = await engine(longStorage, longRemote).sync();
  assert.strictEqual(longResult.skippedFiles.length, 1);
  assert.ok(engine(longStorage, longRemote).incomingPath(longRemote.latest.version, longRemote.files[0]).length < 180, "internal cache paths stay short even when source paths or versions are long");

  const noWorkerRun = spawnSync(process.execPath, ["-e", `
    const assert = require("assert");
    let workerAttempts = 0;
    const UnsupportedWorker = class { constructor() {
      workerAttempts += 1;
      throw new Error("V8 platform used by this instance of Node does not support creating Workers");
    } };
    require("worker_threads").Worker = UnsupportedWorker;
    global.Worker = UnsupportedWorker;
    const { zipSync } = require("fflate");
    const { createHash } = require("crypto");
    const { unpackArchive } = require("./src/project-sync/downloads");
    const data = Buffer.from("worker-free archive content".repeat(100000));
    const filename = "assets/worker-free.txt";
    const archive = zipSync({ [filename]: data });
    const files = [{ path: filename, size: data.length, sha256: createHash("sha256").update(data).digest("hex") }];
    unpackArchive(archive, files).then((result) => {
      assert.deepStrictEqual(Buffer.from(result[filename]), data);
      assert.strictEqual(workerAttempts, 0, "decompression must never construct a Node or Web Worker");
    }).catch((error) => { console.error(error); process.exitCode = 1; });
  `], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 15000 });
  assert.strictEqual(noWorkerRun.status, 0, `large ZIP must work in Obsidian without Workers: ${noWorkerRun.stderr || noWorkerRun.error || ""}`);

  const chunkedData = randomBytes(1024 * 1024);
  const chunkedFile = { path: "assets/chunked.png", size: chunkedData.length, sha256: sha256(chunkedData) };
  const chunkedZip = zipSync({ [chunkedFile.path]: chunkedData });
  let yieldedToTimer = false;
  setTimeout(() => { yieldedToTimer = true; }, 0);
  const chunkedResult = await unpackArchive(chunkedZip, [chunkedFile]);
  assert.strictEqual(yieldedToTimer, true, "large ZIP decompression yields to the UI event loop between chunks");
  assert.deepStrictEqual(Buffer.from(chunkedResult[chunkedFile.path]), chunkedData);
  const unzipAborter = new AbortController();
  setTimeout(() => unzipAborter.abort(), 0);
  await assert.rejects(unpackArchive(chunkedZip, [chunkedFile], unzipAborter.signal), /已取消/);
  const falseSizeZip = zipSync({ "assets/false-size.txt": bytes("large output".repeat(100000)) });
  new DataView(falseSizeZip.buffer, falseSizeZip.byteOffset, falseSizeZip.byteLength).setUint32(22, 1, true);
  await assert.rejects(unpackArchive(falseSizeZip, [{ path: "assets/false-size.txt", size: 1, sha256: sha256(bytes("l")) }]), /解压大小超出/);

  console.log("covered initial ZIP, no-change, incremental changes, migration, local edits/deletions, retry, checksum, rollback, crash recovery, cancellation, concurrency and path safety");
};

run().then(() => console.log("project sync engine tests passed")).catch((error) => { console.error(error); process.exitCode = 1; });
