const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const { createHash } = require("crypto");
const { zipSync } = require("fflate");
const { ProjectSyncEngine } = require("../src/project-sync");
const { createProjectTransport, createVaultSyncStorage } = require("../src/project-sync-obsidian");

const stateDir = ".obsidian/plugins/lacan-translation-helper/project-sync";
const cardPath = "知识库/父亲隐喻与父之名.md";
const relatedPath = "知识库/象征父亲、想象父亲与实在父亲.md";
const imagePath = "assets/父之名 图示.png";
const pdfPath = "assets/父之名资料.pdf";
const lessonPath = "texts/s4-la-relation-d-objet/translation/Leçon-21.md";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const asBuffer = (value) => Buffer.isBuffer(value) ? value : Buffer.from(value);
const card = (revision) => [
  "---", "title: 父亲隐喻与父之名", "type: knowledge-card", "tags:", "  - 研讨班IV",
  "  - 领域/精神分析/能指言说与书写", "---", "", `父亲隐喻的知识卡正文，版本 ${revision}。`, "",
  "![[../assets/父之名 图示.png]]", `[资料](../assets/${encodeURIComponent("父之名资料.pdf")})`,
  `[[${relatedPath}|关联知识卡]]`, `[[${lessonPath}#s4-21-0101|研讨班译文]]`,
  "![外链图片](https://example.invalid/external.png)", "",
].join("\n");
const content = (revision) => ({
  [cardPath]: card(revision),
  [relatedPath]: `---\ntitle: 象征父亲、想象父亲与实在父亲\ntype: knowledge-card\ntags: []\n---\n关联卡正文。\n\n![[../assets/父之名 图示.png]]\n`,
  [imagePath]: Buffer.from(`\x89PNG\r\n\x1a\nimage-${revision}`, "binary"),
  [pdfPath]: Buffer.from(`%PDF-1.7\npdf-${revision}\n`),
  "assets/未引用.png": Buffer.from("unused image"),
  [lessonPath]: "<!-- id: s4-21-0101 -->\n关联课次译文\n",
  "知识库/README.md": "# 知识库目录\n",
  "知识库/空文件.md": "",
});

const run = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lctp-knowledge-http-"));
  const requests = [];
  const objects = new Map();
  const failures = new Map();
  let offline = false;
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (offline) { req.socket.destroy(); return; }
    const failure = failures.get(req.url);
    if (failure) { res.writeHead(failure); res.end("temporary failure"); return; }
    const bytes = objects.get(req.url);
    if (bytes === undefined) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Length", bytes.length);
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const endpointUrl = `${origin}/project`;
  const fileRoute = (version, name) => `/releases/${version}/files/${name.split("/").map(encodeURIComponent).join("/")}`;
  const bodyRequests = () => requests.filter((url) => url.includes("/files/"))
    .map((url) => decodeURIComponent(url.split("/files/")[1]));
  const publish = (version, publishedContent) => {
    const entries = Object.entries(publishedContent).map(([name, bytes]) => [name, asBuffer(bytes)]);
    const prefix = `/releases/${version}`;
    const files = entries.map(([name, bytes]) => {
      const route = fileRoute(version, name);
      objects.set(route, bytes);
      return { path: name, size: bytes.length, sha256: hash(bytes), url: `${origin}${route}` };
    });
    const knowledge_entries = [
      { path: cardPath, title: "父亲隐喻与父之名", tags: ["研讨班IV", "领域/精神分析/能指言说与书写"], excerpt: "父亲隐喻的知识卡正文。" },
      { path: relatedPath, title: "象征父亲、想象父亲与实在父亲", tags: [], excerpt: "关联卡正文。" },
    ];
    const manifest = Buffer.from(JSON.stringify({ schema_version: 1, version, files, knowledge_entries }));
    const zip = Buffer.from(zipSync(Object.fromEntries(entries)));
    objects.set(`${prefix}/manifest.json`, manifest);
    objects.set(`${prefix}/project.zip`, zip);
    objects.set("/project", Buffer.from(JSON.stringify({
      schema_version: 1, version, source_revision: "a".repeat(40), published_at: "2026-11-10T00:00:00Z",
      manifest_url: `${origin}${prefix}/manifest.json`, manifest_sha256: hash(manifest),
      archive_url: `${origin}${prefix}/project.zip`, archive_sha256: hash(zip), archive_size: zip.length, file_count: files.length,
    })));
  };
  const transport = createProjectTransport(async (options) => {
    const response = await fetch(options.url, { method: options.method, headers: options.headers });
    return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: await response.arrayBuffer() };
  });
  const makeVault = async (name) => {
    const vaultRoot = path.join(root, name);
    await fs.mkdir(vaultRoot);
    const absolute = (relative) => path.join(vaultRoot, relative);
    const writes = [];
    const editors = new Map();
    const faults = { write: null };
    const adapter = {
      getBasePath: () => vaultRoot,
      exists: (name) => fs.stat(absolute(name)).then(() => true, () => false),
      mkdir: (name) => fs.mkdir(absolute(name)),
      readBinary: async (name) => {
        const bytes = await fs.readFile(absolute(name));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      writeBinary: async (name, bytes) => {
        writes.push(name);
        await faults.write?.(name, Buffer.from(bytes));
        await fs.writeFile(absolute(name), Buffer.from(bytes));
      },
      rename: (from, to) => fs.rename(absolute(from), absolute(to)),
      remove: (name) => fs.unlink(absolute(name)),
    };
    const storage = createVaultSyncStorage({ adapter, getAbstractFileByPath: () => null }, {
      getEditorTexts: (name) => editors.has(name) ? [editors.get(name)] : [],
    });
    const engine = (onProgress) => new ProjectSyncEngine({ endpointUrl, storage, transport, onProgress });
    return {
      adapter, storage, engine, writes, editors, faults,
      read: async (name) => { const bytes = await storage.read(name); return bytes === null ? null : Buffer.from(bytes); },
      publicWrites: () => writes.filter((name) => !name.startsWith(`${stateDir}/`)),
    };
  };
  try {
    const v1 = content("one");
    publish("v1", v1);
    const vault = await makeVault("normal");
    const engine = vault.engine();
    requests.length = 0;
    const catalog = await engine.getCatalog();
    assert.strictEqual(catalog.knowledgeMetadataAvailable, true);
    assert.deepStrictEqual(new Set(catalog.knowledgeEntries.map((entry) => entry.path)), new Set([cardPath, relatedPath]));
    assert.deepStrictEqual(bodyRequests(), [], "catalog retrieval must not download any Markdown or attachment");
    assert.deepStrictEqual(vault.publicWrites(), [], "empty-vault catalog retrieval creates no content placeholders");
    assert.strictEqual(await vault.read(cardPath), null);
    assert.strictEqual(await vault.read(relatedPath), null);

    requests.length = 0;
    const first = await engine.syncKnowledgeEntry(cardPath);
    assert.deepStrictEqual(new Set(bodyRequests()), new Set([cardPath, imagePath, pdfPath]));
    assert.strictEqual(first.downloadedFiles, 3);
    assert.strictEqual(first.usedArchive, false);
    assert.deepStrictEqual(new Set(first.scopePaths), new Set([cardPath, imagePath, pdfPath]));
    assert.ok(!requests.some((url) => url.endsWith(".zip")), "single-card sync never downloads a full archive");
    for (const name of [cardPath, imagePath, pdfPath]) assert.deepStrictEqual(await vault.read(name), asBuffer(v1[name]));
    for (const name of [relatedPath, lessonPath, "assets/未引用.png", "知识库/README.md"]) assert.strictEqual(await vault.read(name), null);

    requests.length = 0;
    const unchanged = await engine.syncKnowledgeEntry(cardPath);
    assert.strictEqual(unchanged.downloadedFiles, 0);
    assert.deepStrictEqual(bodyRequests(), [], "unchanged card and attachments need no download");
    assert.strictEqual(requests.length, 2, "unchanged sync only checks latest and manifest");

    offline = true;
    await assert.rejects(() => engine.getCatalog(), /fetch failed|socket|network/i);
    requests.length = 0;
    const restartedOffline = vault.engine();
    assert.deepStrictEqual((await restartedOffline.readCachedCatalog()).knowledgeEntries, catalog.knowledgeEntries);
    assert.deepStrictEqual(requests, [], "cached directory is read without making an offline network request");
    assert.deepStrictEqual(await vault.read(cardPath), asBuffer(v1[cardPath]), "downloaded cards remain readable offline");
    offline = false;

    const previousState = await vault.read(`${stateDir}/state.json`);
    const localText = "我在知识卡中的私人修改。\n";
    await vault.storage.write(cardPath, Buffer.from(localText));
    publish("v2", content("two"));
    requests.length = 0;
    vault.writes.length = 0;
    const localSkip = await engine.syncKnowledgeEntry(cardPath);
    assert.ok(localSkip.skippedFiles.some((entry) => entry.path === cardPath && entry.reason === "local_modified"));
    assert.deepStrictEqual(bodyRequests(), [], "modified card is skipped before a replacement body is downloaded");
    assert.deepStrictEqual(vault.publicWrites(), []);
    assert.strictEqual((await vault.read(cardPath)).toString(), localText);
    assert.deepStrictEqual(await vault.read(`${stateDir}/state.json`), previousState, "skipping cannot advance the trusted baseline");

    await vault.storage.write(cardPath, asBuffer(v1[cardPath]));
    vault.editors.set(cardPath, "未保存的编辑器草稿");
    requests.length = 0;
    const unsavedSkip = await engine.syncKnowledgeEntry(cardPath);
    assert.ok(unsavedSkip.skippedFiles.some((entry) => entry.reason === "unsaved_changes"));
    assert.deepStrictEqual(bodyRequests(), []);
    assert.deepStrictEqual(await vault.read(cardPath), asBuffer(v1[cardPath]));
    vault.editors.clear();

    const editedImage = Buffer.from("我修改过的共享图示");
    await vault.storage.write(imagePath, editedImage);
    vault.writes.length = 0;
    const sharedSkip = await engine.syncKnowledgeEntry(relatedPath);
    assert.ok(sharedSkip.skippedFiles.some((entry) => entry.path === imagePath && entry.reason === "local_modified"));
    assert.strictEqual(await vault.read(relatedPath), null, "another card cannot overwrite its shared modified attachment");
    assert.deepStrictEqual(await vault.read(imagePath), editedImage);
    assert.deepStrictEqual(vault.publicWrites(), []);
    assert.deepStrictEqual(await vault.read(`${stateDir}/state.json`), previousState);

    publish("v1", v1);
    const interrupted = await makeVault("download-failure");
    failures.set(fileRoute("v1", imagePath), 503);
    await assert.rejects(() => interrupted.engine().syncKnowledgeEntry(cardPath), /HTTP 503/);
    assert.deepStrictEqual(interrupted.publicWrites(), [], "a failed attachment download cannot write any card or attachment");
    assert.strictEqual(await interrupted.read(`${stateDir}/state.json`), null);
    for (const name of [cardPath, imagePath, pdfPath]) assert.strictEqual(await interrupted.read(name), null);
    failures.clear();
    requests.length = 0;
    const resumed = await interrupted.engine().syncKnowledgeEntry(cardPath);
    assert.strictEqual(resumed.downloadedFiles, 2, "a new engine reuses the verified incoming card after a network failure");
    assert.deepStrictEqual(new Set(bodyRequests()), new Set([imagePath, pdfPath]));
    for (const name of [cardPath, imagePath, pdfPath]) assert.deepStrictEqual(await interrupted.read(name), asBuffer(v1[name]));

    const corrupt = await makeVault("integrity-failure");
    const pdfRoute = fileRoute("v1", pdfPath);
    objects.set(pdfRoute, Buffer.alloc(asBuffer(v1[pdfPath]).length, 0x3f));
    await assert.rejects(() => corrupt.engine().syncKnowledgeEntry(cardPath), /校验失败/);
    assert.deepStrictEqual(corrupt.publicWrites(), [], "correct length with an incorrect hash is rejected before final writes");
    assert.strictEqual(await corrupt.read(`${stateDir}/state.json`), null);
    objects.set(pdfRoute, asBuffer(v1[pdfPath]));

    const recovery = await makeVault("transaction-recovery");
    await recovery.engine().syncKnowledgeEntry(cardPath);
    const recoveryBaseline = await recovery.read(`${stateDir}/state.json`);
    const v2 = content("two");
    publish("v2", v2);
    let failAttachment = true;
    let failRollback = true;
    recovery.faults.write = (name, bytes) => {
      if (name === imagePath && bytes.equals(asBuffer(v2[imagePath])) && failAttachment) {
        failAttachment = false;
        throw new Error("simulated attachment write failure");
      }
      if (name === cardPath && bytes.equals(asBuffer(v1[cardPath])) && failRollback) {
        failRollback = false;
        throw new Error("simulated rollback interruption");
      }
    };
    await assert.rejects(() => recovery.engine().syncKnowledgeEntry(cardPath), /simulated rollback interruption/);
    assert.ok(await recovery.adapter.exists(`${stateDir}/journal.json`), "an interrupted rollback leaves a recovery journal");
    assert.deepStrictEqual(await recovery.read(`${stateDir}/state.json`), recoveryBaseline);
    recovery.faults.write = null;
    const recoveryProgress = [];
    requests.length = 0;
    const recovered = await recovery.engine((event) => recoveryProgress.push(event)).syncKnowledgeEntry(cardPath);
    assert.ok(recoveryProgress.some((event) => event.phase === "recovering"), "a fresh engine repairs the interrupted transaction");
    assert.strictEqual(recovered.downloadedFiles, 0, "verified incoming files also survive transaction interruption");
    assert.deepStrictEqual(bodyRequests(), []);
    for (const name of [cardPath, imagePath, pdfPath]) assert.deepStrictEqual(await recovery.read(name), asBuffer(v2[name]));
    const recoveredState = JSON.parse((await recovery.read(`${stateDir}/state.json`)).toString());
    assert.strictEqual(recoveredState.files[cardPath], hash(asBuffer(v2[cardPath])));
    assert.strictEqual(recoveredState.files[imagePath], hash(asBuffer(v2[imagePath])));
    assert.ok(!await recovery.adapter.exists(`${stateDir}/journal.json`));
    assert.strictEqual(await recovery.read(relatedPath), null);
    assert.strictEqual(await recovery.read(lessonPath), null);
    console.log("Real HTTP + filesystem knowledge sync passed: metadata-only catalog, scoped card/assets, offline cache, modification protection, download integrity, resumed downloads and interrupted transaction recovery");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
