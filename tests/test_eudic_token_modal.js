const assert = require("assert");
const Module = require("module");

const rows = [];
const links = [];
const notices = [];
const originalLoad = Module._load;
class TextControl {
  constructor() { this.inputEl = { setAttribute() {} }; this.value = ""; }
  setPlaceholder(value) { this.placeholder = value; return this; }
  setValue(value) { this.value = value; return this; }
  getValue() { return this.value; }
}
class Button {
  setButtonText(value) { this.label = value; return this; }
  setCta() { return this; }
  setDisabled(value) { this.disabled = value; return this; }
  onClick(callback) { this.click = callback; return this; }
}
Module._load = function(request, parent, isMain) {
  if (request === "obsidian") return {
    Modal: class {
      constructor() { this.contentEl = { createEl(tag, options) { if (tag === "a") links.push(options); }, empty() {} }; }
      setTitle(value) { this.title = value; }
      open() { this.onOpen(); }
      close() { this.closed = true; this.onClose(); }
    },
    Notice: class { constructor(message) { notices.push(message); } },
    Setting: class {
      constructor() { this.controls = []; rows.push(this); }
      setName(name) { this.name = name; return this; }
      setDesc() { return this; }
      addText(callback) { const control = new TextControl(); this.controls.push(control); callback(control); return this; }
      addButton(callback) { const button = new Button(); this.controls.push(button); callback(button); return this; }
    },
  };
  return originalLoad(request, parent, isMain);
};
let openEudicTokenModal;
try { ({ openEudicTokenModal } = require("../src/eudic-token-modal")); }
finally { Module._load = originalLoad; }

async function run() {
  const writes = [];
  const saves = [];
  let refreshed = 0;
  const plugin = {
    settings: { frenchLookupSecretName: "existing-eudic-secret" },
    app: { secretStorage: { setSecret: (name, value) => writes.push({ name, value }) } },
    saveSettings: async () => saves.push(JSON.stringify(plugin.settings)),
  };
  const modal = openEudicTokenModal(plugin, () => { refreshed += 1; });
  assert.strictEqual(links[0].attr.href, "https://my.frdic.com/OpenAPI/Authorization");
  assert.strictEqual(links[0].text, links[0].attr.href, "the acquisition address must be visible in the credential dialog");
  const input = rows.find((row) => row.name === "授权码").controls[0];
  assert.strictEqual(input.inputEl.type, "password");
  assert.strictEqual(input.placeholder, "", "no provider-specific key prefix may be suggested");
  assert.strictEqual(input.value, "", "existing credentials must not be prefilled into the dialog");
  const buttons = rows.flatMap((row) => row.controls);
  const save = buttons.find((button) => button.label === "保存");
  await save.click();
  assert.strictEqual(writes.length, 0, "an empty field must not erase an existing credential");
  input.setValue("NIS test-only-eudic-credential");
  await save.click();
  assert.deepStrictEqual(writes, [{ name: "lacan-eudic-api-token", value: "NIS test-only-eudic-credential" }], "saving a new credential must not overwrite an unrelated shared secret");
  assert.strictEqual(plugin.settings.frenchLookupSecretName, "lacan-eudic-api-token");
  assert.ok(saves.every((value) => !value.includes("test-only-eudic-credential")));
  assert.strictEqual(refreshed, 1);
  assert.strictEqual(modal.closed, true);
  assert.strictEqual(input.value, "", "closing must clear the password field");
  assert.ok(notices.every((message) => !message.includes("test-only-eudic-credential")));
  console.log("Eudic token modal tests passed");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
