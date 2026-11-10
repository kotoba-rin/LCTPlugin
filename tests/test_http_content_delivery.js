const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const childProcess = require("child_process");
const { createHash } = require("crypto");
const { zipSync } = require("fflate");
const { ProjectSyncEngine } = require("../src/project-sync");
const { createVaultSyncStorage } = require("../src/project-sync-obsidian");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const documentPath = "texts/s14/translation/Leçon-01.md";

const run = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lctp-no-git-"));
  const absolute = (relative) => path.join(root, relative);
  const requests = [];
  const objects = new Map();
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const bytes = objects.get(req.url);
    if (!bytes) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Length", bytes.length);
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const publish = (version, content) => {
    const entries = Object.entries(content).map(([name, text]) => [name, Buffer.from(text)]);
    const prefix = `/releases/${version}`;
    const files = entries.map(([name, bytes]) => {
      const url = `${origin}${prefix}/files/${name.split("/").map(encodeURIComponent).join("/")}`;
      objects.set(new URL(url).pathname, bytes);
      return { path: name, size: bytes.length, sha256: hash(bytes), url };
    });
    const manifest = Buffer.from(JSON.stringify({ schema_version: 1, version, files }));
    const zip = Buffer.from(zipSync(Object.fromEntries(entries)));
    objects.set(`${prefix}/manifest.json`, manifest);
    objects.set(`${prefix}/project.zip`, zip);
    objects.set("/project", Buffer.from(JSON.stringify({
      schema_version: 1, version, source_revision: "a".repeat(40), published_at: "2026-11-09T00:00:00Z",
      manifest_url: `${origin}${prefix}/manifest.json`, manifest_sha256: hash(manifest),
      archive_url: `${origin}${prefix}/project.zip`, archive_sha256: hash(zip), archive_size: zip.length, file_count: files.length,
    })));
  };
  const adapter = {
    getBasePath: () => root,
    exists: (name) => fs.stat(absolute(name)).then(() => true, () => false),
    mkdir: (name) => fs.mkdir(absolute(name)),
    readBinary: async (name) => { const bytes = await fs.readFile(absolute(name)); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    writeBinary: (name, bytes) => fs.writeFile(absolute(name), Buffer.from(bytes)),
    rename: (from, to) => fs.rename(absolute(from), absolute(to)),
    remove: (name) => fs.unlink(absolute(name)),
  };
  const storage = createVaultSyncStorage({ adapter, getAbstractFileByPath: () => null });
  const transport = async (url) => {
    const response = await fetch(url);
    assert.strictEqual(response.status, 200);
    return new Uint8Array(await response.arrayBuffer());
  };
  const originalPath = process.env.PATH;
  const disabledCommands = {};
  for (const name of ["exec", "execFile", "spawn", "execSync", "execFileSync", "spawnSync"]) {
    disabledCommands[name] = childProcess[name];
    childProcess[name] = () => assert.fail("HTTP content sync cannot call any external command, including Git");
  }
  process.env.PATH = absolute("no-external-commands");
  try {
    const engine = new ProjectSyncEngine({ endpointUrl: `${origin}/project`, storage, transport });
    publish("v1", { [documentPath]: "original\nsecond\nthird\nfourth\n", "术语表/README.md": "terms" });
    const initial = await engine.sync();
    assert.strictEqual(initial.added, 2);
    assert.strictEqual(initial.usedArchive, true);
    assert.ok(!await adapter.exists(".git"));
    requests.length = 0;
    const unchanged = await engine.sync();
    assert.strictEqual(unchanged.downloadedFiles, 0);
    assert.strictEqual(requests.length, 2, "unchanged content fetches only latest and manifest");
    await storage.write("texts/s14/notes/my-note.md", Buffer.from("my private note"));
    await storage.write(".obsidian/plugins/lacan-translation-helper/project-sync/private-marker.txt", Buffer.from("settings preserved"));
    publish("v2", { [documentPath]: "updated\nsecond\nthird\nfourth\n", "知识库/new.md": "new card" });
    requests.length = 0;
    const updated = await engine.sync();
    assert.deepStrictEqual([updated.added, updated.updated, updated.deleted], [1, 1, 1]);
    assert.strictEqual(updated.usedArchive, false);
    assert.strictEqual(updated.downloadedFiles, 2);
    assert.ok(!requests.some((url) => url.endsWith(".zip")), "incremental update must not redownload the archive");
    const local = "updated\nmy edited translation and [[my-note]]\nthird\nfourth\n";
    const upstream = "upstream v3\nremote second\nthird\nfourth\n";
    await storage.write(documentPath, Buffer.from(local));
    publish("v3", { [documentPath]: upstream, "知识库/new.md": "new card" });
    const skipped = await engine.sync();
    assert.strictEqual(skipped.conflicts.length, 0);
    assert.strictEqual(skipped.skippedFiles.find((entry) => entry.path === documentPath).reason, "local_modified");
    assert.strictEqual(skipped.downloadedFiles, 0, "modified text is not even downloaded as a replacement");
    assert.strictEqual(Buffer.from(await storage.read(documentPath)).toString(), local);
    const skippedState = JSON.parse(Buffer.from(await storage.read(skipped.statePath)).toString());
    const oldBaseline = hash(Buffer.from("updated\nsecond\nthird\nfourth\n"));
    assert.strictEqual(skippedState.files[documentPath], oldBaseline);
    const retry = await engine.sync();
    assert.strictEqual(retry.downloadedFiles, 0);
    assert.strictEqual(retry.skippedFiles.length, 1);
    const nextUpstream = "upstream v3\nremote second\nthird\nremote fourth\n";
    publish("v4", { [documentPath]: nextUpstream, "知识库/new.md": "new card" });
    const skippedAgain = await engine.sync();
    assert.strictEqual(skippedAgain.conflicts.length, 0);
    assert.strictEqual(skippedAgain.merged, 0);
    assert.strictEqual(Buffer.from(await storage.read(documentPath)).toString(), local, "a later upstream edit still skips the complete user-modified file");
    await storage.remove(documentPath);
    const restored = await engine.sync();
    assert.strictEqual(restored.added, 1);
    assert.strictEqual(restored.conflicts.length, 0);
    assert.strictEqual(Buffer.from(await storage.read(documentPath)).toString(), nextUpstream, "deleting a modified download explicitly permits a fresh copy");
    const state = JSON.parse(Buffer.from(await storage.read(restored.statePath)).toString());
    assert.strictEqual(state.files[documentPath], hash(Buffer.from(nextUpstream)));
    assert.deepStrictEqual(state.local_deletions, {});
    assert.strictEqual(Buffer.from(await storage.read("texts/s14/notes/my-note.md")).toString(), "my private note");
    assert.strictEqual(Buffer.from(await storage.read(".obsidian/plugins/lacan-translation-helper/project-sync/private-marker.txt")).toString(), "settings preserved");
    console.log("Real HTTP + filesystem sync passed with empty PATH and all external commands disabled: ZIP, incremental updates, whole-file modification skips, explicit deletion re-download, and private notes");
  } finally {
    process.env.PATH = originalPath;
    Object.assign(childProcess, disabledCommands);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
};
run().catch((error) => { console.error(error); process.exitCode = 1; });
