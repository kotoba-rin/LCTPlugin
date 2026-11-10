const assert = require("assert");
const { createHash } = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createProjectTransport, createVaultSyncStorage } = require("../src/project-sync-obsidian");
const bytes = (s) => new Uint8Array(Buffer.from(s));
const hash = (s) => createHash("sha256").update(s).digest("hex");

const run = async () => {
  const request = createProjectTransport(async () => ({ status: 200, headers: {}, arrayBuffer: bytes("ok").buffer }));
  assert.strictEqual(Buffer.from(await request("https://example.org")).toString(), "ok");
  await assert.rejects(() => createProjectTransport(async () => ({ status: 503 }))("https://example.org"), /503/);
  await assert.rejects(() => request("https://example.org", { maxBytes: 1 }), /大小/);
  const controller = new AbortController();
  const pending = createProjectTransport(() => new Promise(() => {}))("https://example.org", { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, { name: "AbortError" });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lctp-vault-"));
  let linkedPluginRoot;
  const local = (p) => path.join(root, p);
  const adapter = {
    getBasePath: () => root,
    exists: async (p) => fs.stat(local(p)).then(() => true, () => false),
    mkdir: async (p) => fs.mkdir(local(p)),
    readBinary: async (p) => { const b = await fs.readFile(local(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    writeBinary: async (p, b) => fs.writeFile(local(p), Buffer.from(b)),
    rename: async () => { throw new Error("Destination file already exists!"); },
    remove: async (p) => fs.unlink(local(p)),
  };
  let editedDuringProcess = false;
  let editorTexts = [];
  let inlineDirty = false;
  let trashed = 0;
  const vault = {
    adapter,
    getAbstractFileByPath: (p) => /\.(md|txt|csv)$/i.test(p) || p === "LICENSE" ? { path: p } : null,
    modifyBinary: async (file, b) => adapter.writeBinary(file.path, b),
    process: async (file, callback) => {
      const current = editedDuringProcess ? "my new edit" : await fs.readFile(local(file.path), "utf8");
      await fs.writeFile(local(file.path), callback(current));
    },
    trash: async (file) => { trashed += 1; await fs.rename(local(file.path), local("trash.md")); },
  };
  try {
    const storage = createVaultSyncStorage(vault, { getEditorTexts: () => editorTexts, isWriteBlocked: () => inlineDirty });
    assert.strictEqual(await storage.compareAndWrite("texts/s14/translation/already-deleted.md", null, null), true, "explicitly accepting a local deletion is a successful no-op");
    inlineDirty = true;
    assert.strictEqual(await storage.compareAndWrite("texts/s14/translation/already-deleted.md", null, null), false, "accepting a missing file must still protect inline drafts");
    inlineDirty = false;
    for (const textPath of ["texts/data.csv", "texts/notes.txt", "LICENSE"]) {
      await storage.write(textPath, bytes("old text"));
      editedDuringProcess = true;
      assert.strictEqual(await storage.compareAndWrite(textPath, hash("old text"), bytes("upstream")), false, "every managed text type must preserve concurrent edits through Vault.process");
      assert.strictEqual(Buffer.from(await storage.read(textPath)).toString(), "my new edit");
      editedDuringProcess = false;
    }
    await storage.write("texts/s14/translation/Leçon-01.md", bytes("old"));
    assert.strictEqual(storage.hasUnsavedChanges("texts/s14/translation/Leçon-01.md", hash("old")), false);
    editorTexts = ["unsaved note in the Markdown editor"];
    assert.strictEqual(storage.hasUnsavedChanges("texts/s14/translation/Leçon-01.md", hash("old")), true);
    editorTexts = [];
    inlineDirty = true;
    assert.strictEqual(storage.hasUnsavedChanges("texts/s14/translation/Leçon-01.md", hash("old")), true);
    inlineDirty = false;

    assert.strictEqual(await storage.compareAndWrite("texts/s14/translation/Leçon-01.md", hash("old"), bytes("new")), true);
    const withBom = "\uFEFF正文\r\n保留末尾空格  \r\n";
    assert.strictEqual(await storage.compareAndWrite("texts/s14/translation/Leçon-01.md", hash("new"), bytes(withBom)), true);
    assert.strictEqual(Buffer.from(await storage.read("texts/s14/translation/Leçon-01.md")).toString(), withBom, "Vault.process must preserve the UTF-8 BOM and Markdown whitespace");
    assert.strictEqual(await storage.compareAndWrite("texts/s14/translation/Leçon-01.md", hash(withBom), bytes("new")), true);
    inlineDirty = true;
    assert.strictEqual(await storage.compareAndWrite("texts/s14/translation/Leçon-01.md", hash("new"), bytes("upstream")), false, "unsaved inline editor draft must block upstream writes");
    inlineDirty = false;
    editedDuringProcess = true;
    assert.strictEqual(await storage.compareAndWrite("texts/s14/translation/Leçon-01.md", hash("new"), bytes("upstream")), false);
    assert.strictEqual(Buffer.from(await storage.read("texts/s14/translation/Leçon-01.md")).toString(), "my new edit");
    const originalRead = adapter.readBinary;
    adapter.readBinary = async (p) => { const value = await originalRead(p); editorTexts = ["unsaved edit entered during read"]; return value; };
    assert.strictEqual(await storage.compareAndWrite("texts/s14/translation/Leçon-01.md", hash("my new edit"), null), false, "edits entered while the disk is being read must block deletion");
    assert.strictEqual(trashed, 0);
    adapter.readBinary = originalRead;
    editorTexts = [];
    assert.strictEqual(await storage.compareAndWrite("texts/s14/translation/Leçon-01.md", hash("my new edit"), null), true);
    assert.strictEqual(trashed, 1, "managed deletions use recoverable local trash");
    const disappearing = "texts/s14/translation/disappearing.md";
    await storage.write(disappearing, bytes("old"));
    const readBeforeRace = adapter.readBinary;
    adapter.readBinary = async (name) => {
      if (name !== disappearing) return readBeforeRace(name);
      await adapter.remove(name);
      throw Object.assign(new Error("removed during read"), { code: "ENOENT" });
    };
    assert.strictEqual(await storage.read(disappearing), null, "a verified concurrent deletion is reported as missing, not an I/O failure");
    adapter.readBinary = readBeforeRace;
    await storage.write(disappearing, bytes("old"));
    adapter.readBinary = async (name) => {
      if (name !== disappearing) return readBeforeRace(name);
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };
    await assert.rejects(() => storage.read(disappearing), { code: "EACCES" });
    adapter.readBinary = readBeforeRace;
    const staleIndexedFile = "texts/s14/translation/stale-index.md";
    const processBeforeRestore = vault.process;
    vault.process = async () => assert.fail("a stale TFile for a missing file must not be sent to Vault.process");
    vault.createBinary = async (name, data) => {
      await fs.writeFile(local(name), Buffer.from(data), { flag: "wx" });
      return { path: name };
    };
    assert.ok(vault.getAbstractFileByPath(staleIndexedFile), "the Vault index still contains the deleted file");
    assert.strictEqual(await adapter.exists(staleIndexedFile), false);
    assert.strictEqual(await storage.compareAndWrite(staleIndexedFile, null, bytes("redownloaded text")), true);
    assert.strictEqual(Buffer.from(await storage.read(staleIndexedFile)).toString(), "redownloaded text");
    await adapter.remove(staleIndexedFile);
    vault.createBinary = async (name, data) => {
      await fs.writeFile(local(name), "new concurrent user file", { flag: "wx" });
      await fs.writeFile(local(name), Buffer.from(data), { flag: "wx" });
    };
    assert.strictEqual(await storage.compareAndWrite(staleIndexedFile, null, bytes("server replacement")), false);
    assert.strictEqual(Buffer.from(await storage.read(staleIndexedFile)).toString(), "new concurrent user file", "a file created during re-download must not be overwritten");
    vault.process = processBeforeRestore;
    delete vault.createBinary;
    const failedCreation = "texts/s14/translation/partial-create.md";
    const originalGetFile = vault.getAbstractFileByPath;
    vault.getAbstractFileByPath = (name) => name === failedCreation ? null : originalGetFile(name);
    vault.createBinary = async (name, data) => {
      await adapter.writeBinary(name, data.slice(0, 3));
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    };
    await assert.rejects(() => storage.compareAndWrite(failedCreation, null, bytes("full server text")), { code: "ENOSPC" }, "partial write errors are not user-modification skips");
    assert.strictEqual(Buffer.from(await storage.read(failedCreation)).toString(), "ful");
    await adapter.remove(failedCreation);
    vault.createBinary = async (name) => {
      await adapter.writeBinary(name, bytes("concurrent local note").buffer);
      throw Object.assign(new Error("File already exists."), { code: "EEXIST" });
    };
    assert.strictEqual(await storage.compareAndWrite(failedCreation, null, bytes("server text")), false);
    assert.strictEqual(Buffer.from(await storage.read(failedCreation)).toString(), "concurrent local note");
    delete vault.createBinary;
    vault.getAbstractFileByPath = originalGetFile;
    const journal = ".obsidian/plugins/lacan-translation-helper/project-sync/journal.json";
    await storage.write(journal, bytes('{"valid":true}'));
    const originalWrite = adapter.writeBinary;
    adapter.writeBinary = async (name, buffer) => { await originalWrite(name, buffer.slice(0, 3)); throw new Error("partial disk write"); };
    await assert.rejects(() => storage.write(journal, bytes('{"replacement":true}')), /partial disk write/);
    adapter.writeBinary = originalWrite;
    assert.strictEqual(Buffer.from(await storage.read(journal)).toString(), '{"valid":true}', "failed metadata writes must leave the preceding journal intact");
    await assert.rejects(() => storage.write("../outside.md", bytes("no")), /路径/);
    await fs.symlink(os.tmpdir(), local("outside"));
    await assert.rejects(() => storage.write("outside/unwanted.md", bytes("no")), /符号链接/);
    linkedPluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lctp-linked-plugin-"));
    const pluginDir = local(".obsidian/plugins/lacan-translation-helper");
    await fs.rm(pluginDir, { recursive: true, force: true });
    await fs.symlink(linkedPluginRoot, pluginDir, "junction");
    const statePath = ".obsidian/plugins/lacan-translation-helper/project-sync/state.json";
    await storage.write(statePath, bytes('{"linked":true}'));
    assert.strictEqual(Buffer.from(await storage.read(statePath)).toString(), '{"linked":true}', "the installed development-plugin link supports private state");
    await fs.symlink(os.tmpdir(), path.join(linkedPluginRoot, "project-sync/redirect"), "junction");
    await assert.rejects(() => storage.write(".obsidian/plugins/lacan-translation-helper/project-sync/redirect/outside.json", bytes("no")), /符号链接/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    if (linkedPluginRoot) await fs.rm(linkedPluginRoot, { recursive: true, force: true });
  }
  console.log("Obsidian HTTP sync storage/transport tests passed");
};
run().catch((error) => { console.error(error); process.exitCode = 1; });
