const assert = require("assert");
const { FrenchLookupPopup, positionLookupPopup } = require("../src/french-lookup-popup");
const { buildFrenchLookup } = require("../src/french-lookup-text");
const { FrenchDictionaryService } = require("../src/french-dictionary-service");

class FakeElement {
  constructor(doc, tag = "div") {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.className = "";
    this.style = {};
    this._text = "";
  }
  get textContent() { return this._text + this.children.map((element) => element.textContent).join(""); }
  get childNodes() { return this._text ? [{ nodeType: 3, textContent: this._text, parentElement: this }, ...this.children] : this.children; }
  set textContent(text) { this._text = String(text); this.children = []; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  replaceChildren(...children) { this._text = ""; this.children = []; for (const child of children) this.appendChild(child); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
  removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== handler)); }
  click() { for (const handler of this.listeners.get("click") || []) handler({ target: this, preventDefault() {}, stopPropagation() {} }); }
  contains(target) { return target === this || this.children.some((child) => child.contains(target)); }
  matches(selector) {
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector === "[contenteditable='true']") return this.attributes.contenteditable === "true";
    return this.tagName.toLowerCase() === selector;
  }
  closest(selectors) {
    for (let element = this; element; element = element.parentElement) {
      if (selectors.split(",").some((selector) => element.matches(selector.trim()))) return element;
    }
    return null;
  }
  getBoundingClientRect() { return { left: 100, top: 80, bottom: 100, width: 420, height: 360 }; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((item) => item !== this); this.parentElement = null; }
  find(className) { if (this.className.split(/\s+/).includes(className)) return this; for (const child of this.children) { const found = child.find?.(className); if (found) return found; } return null; }
}
class FakeDocument {
  constructor() {
    this.body = new FakeElement(this, "body");
    this.defaultView = { innerWidth: 900, innerHeight: 700 };
    this.listeners = new Map();
    this.selection = null;
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createTextNode(text) { return { nodeType: 3, ownerDocument: this, textContent: String(text), contains(target) { return this === target; } }; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener)); }
  getSelection() { return this.selection; }
  emit(type, event) { for (const listener of this.listeners.get(type) || []) listener({ type, preventDefault() {}, stopPropagation() {}, ...event }); }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const tick = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const result = (headword, options = {}) => ({ headword, phonetic: "[idɑ̃tifikasjɔ̃]", definitions: ["认同；辨认"], grammar: ["n. f. 阴性名词"], source: "法语助手在线词典", ...options });
function setup(overrides = {}) {
  const doc = new FakeDocument();
  const container = doc.body.appendChild(doc.createElement("div"));
  const paragraph = container.appendChild(doc.createElement("p"));
  paragraph.textContent = "Le processus de l’identification au père.";
  const view = { containerEl: container, getViewType: () => "markdown" };
  const plugin = {
    settings: { frenchLookupEnabled: true, frenchLookupTrigger: "selection", frenchLookupWordbookId: "7" },
    app: { workspace: { containerEl: container, activeLeaf: { view } } },
  };
  const calls = [];
  const stateCalls = [];
  const savedWords = new Set();
  const service = {
    async lookup(query) { calls.push({ type: "lookup", query }); return result(query); },
    async addWord(word, categoryId) { calls.push({ type: "add", word, categoryId }); savedWords.add(`${categoryId}:${word}`); },
    async isWordInWordbook(word, categoryId) { stateCalls.push({ word, categoryId }); return savedWords.has(`${categoryId}:${word}`); },
    ...overrides,
  };
  const popup = new FrenchLookupPopup(plugin, { service });
  doc.selection = {
    rangeCount: 1, isCollapsed: false,
    toString: () => "l’identification",
    getRangeAt: () => ({ startContainer: paragraph, endContainer: paragraph, commonAncestorContainer: paragraph, getBoundingClientRect: () => ({ left: 120, top: 80, bottom: 100 }) }),
  };
  return { doc, container, paragraph, view, plugin, service, popup, calls, stateCalls };
}

async function testReadingContextMenu() {
  const reading = setup();
  reading.view.getViewType = () => "lacan-bilingual-reading";
  reading.container.className = "lacan-bilingual-content";
  reading.paragraph.textContent = "L’acte est précisément l’équivalent de la répétition, par lui-même.";
  reading.doc.selection.toString = () => "lui-même";
  reading.plugin.settings.frenchLookupTrigger = "double-click";
  const menus = [];
  reading.popup.createMenu = () => {
    const menu = {
      items: [],
      addItem(configure) {
        const item = {
          setTitle(title) { this.title = title; return this; },
          setIcon() { return this; },
          onClick(click) { this.click = click; return this; },
        };
        configure(item); this.items.push(item); return this;
      },
      addSeparator() { return this; },
      showAtMouseEvent(event) { this.event = event; },
      hide() { this.hidden = true; },
    };
    menus.push(menu);
    return menu;
  };
  const copied = [];
  reading.doc.defaultView.navigator = { clipboard: { writeText: async (text) => copied.push(text) } };
  const translations = [];
  reading.popup.translate = async (lookup) => { translations.push(lookup); return { text: "它自身。" }; };
  reading.popup.start();
  const openMenu = (target = reading.paragraph) => {
    const observed = { prevented: false, stopped: false };
    reading.doc.emit("contextmenu", {
      target, button: 2, clientX: 140, clientY: 100,
      preventDefault() { observed.prevented = true; },
      stopPropagation() { observed.stopped = true; },
    });
    return observed;
  };
  const selected = reading.doc.selection;
  const getRange = selected.getRangeAt;
  selected.getRangeAt = () => ({ ...getRange(), startOffset: 0, endOffset: 1 });
  const context = reading.paragraph.textContent;
  const observed = openMenu();
  assert.strictEqual(menus.length, 1, "right-clicking selected French in bilingual reading must open the plugin menu even in double-click mode");
  assert.ok(observed.prevented && observed.stopped, "the native Look up/Copy menu must not cover the lookup actions");
  assert.deepStrictEqual(menus[0].items.map((item) => item.title), ["法语词典查词", "翻译选区并解释法语语法", "复制"]);
  assert.strictEqual(menus[0].event.clientX, 140);
  assert.strictEqual(reading.calls.length, 0, "opening a menu must wait for an explicit action before querying");
  reading.doc.selection = null;
  reading.plugin.app.workspace.activeLeaf = { view: { getViewType: () => "other" } };
  await menus[0].items[0].click();
  assert.strictEqual(reading.popup.lookup.selection, "lui-même", "menu actions retain the selection even after focus or selection is lost");
  assert.strictEqual(reading.popup.lookup.context, context);
  assert.strictEqual(reading.popup.popupEl.ownerDocument, reading.doc);
  await menus[0].items[2].click();
  assert.deepStrictEqual(copied, ["lui-même"], "the reading menu must preserve the Copy action");
  reading.popup.close();
  reading.plugin.app.workspace.iterateAllLeaves = (visit) => visit({ view: reading.view });
  reading.doc.selection = selected;
  openMenu();
  reading.doc.selection = null;
  await menus[1].items[1].click();
  assert.strictEqual(translations[0].selection, "lui-même");
  assert.strictEqual(translations[0].context, context, "an inactive pane's menu must translate its own captured context");
  reading.popup.close();

  for (const type of ["markdown", "pdf"]) {
    reading.view.getViewType = () => type;
    reading.container.className = type === "pdf" ? "textLayer" : "markdown-preview-view";
    reading.doc.selection = selected;
    const previous = menus.length;
    assert.strictEqual(openMenu().prevented, true);
    assert.strictEqual(menus.length, previous + 1, `${type} reading selections must expose the same lookup actions`);
  }
  reading.view.getViewType = () => "lacan-bilingual-reading";
  reading.container.className = "lacan-bilingual-content";
  const previous = menus.length;
  reading.plugin.settings.frenchLookupEnabled = false;
  assert.strictEqual(openMenu().prevented, false);
  reading.plugin.settings.frenchLookupEnabled = true;
  reading.doc.selection = null;
  assert.strictEqual(openMenu().prevented, false, "an empty selection must keep the normal context menu");
  reading.doc.selection = selected;
  for (const tag of ["button", "input", "textarea"]) {
    const control = reading.container.appendChild(reading.doc.createElement(tag));
    assert.strictEqual(openMenu(control).prevented, false, "lookup must leave UI controls alone");
  }
  reading.view.getViewType = () => "markdown";
  reading.container.className = "cm-content";
  assert.strictEqual(openMenu().prevented, false, "editing must continue through Obsidian's editor-menu without a second menu");
  assert.strictEqual(menus.length, previous);
  reading.view.getViewType = () => "lacan-bilingual-reading";
  reading.container.className = "lacan-bilingual-content";
  reading.plugin.settings.frenchLookupTrigger = "selection";
  reading.doc.emit("pointerup", { target: reading.paragraph, button: 0 });
  openMenu();
  const queryCount = reading.calls.length;
  await tick(200);
  assert.strictEqual(reading.calls.length, queryCount, "a pending auto-lookup must not interrupt the context menu");
  assert.strictEqual(reading.popup.popupEl, null);
  reading.popup.destroy();
  assert.ok(menus.at(-1).hidden, "unloading must dismiss any outstanding reading menu");
  assert.ok([...reading.doc.listeners.values()].every((listeners) => listeners.length === 0));
}

function installSpeech(doc, voices = [{ name: "French", lang: "fr-FR" }]) {
  const listeners = new Set();
  const synthesis = {
    voices,
    spoken: [],
    cancellations: 0,
    getVoices() { return this.voices; },
    speak(utterance) { this.spoken.push(utterance); utterance.onstart?.(); },
    cancel() { this.cancellations += 1; },
    addEventListener(type, callback) { if (type === "voiceschanged") listeners.add(callback); },
    removeEventListener(type, callback) { if (type === "voiceschanged") listeners.delete(callback); },
    emitVoicesChanged() { for (const listener of [...listeners]) listener(); },
    listeners,
  };
  doc.defaultView.speechSynthesis = synthesis;
  doc.defaultView.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  return synthesis;
}

async function testSpeech() {
  const canadian = { name: "Canadian French", lang: "fr-CA" };
  const french = { name: "France French", lang: "fr-FR" };
  const english = { name: "English", lang: "en-US" };
  const spoken = setup({ lookup: async () => result("être") });
  const synth = installSpeech(spoken.doc, [english, canadian, french]);
  await spoken.popup.showLookup(buildFrenchLookup("étaient"), null, { doc: spoken.doc });
  const button = spoken.popup.speechButton;
  assert.ok(button, "the pronunciation row must expose a read-aloud control");
  assert.ok(spoken.popup.phoneticEl.parentElement === button.parentElement
    && button.parentElement.children.indexOf(button) > button.parentElement.children.indexOf(spoken.popup.phoneticEl),
  "the read-aloud control must follow the phonetic text in the same row");
  assert.strictEqual(button.getAttribute("aria-pressed"), "false");
  button.click();
  await flush();
  assert.strictEqual(synth.spoken.length, 1);
  assert.strictEqual(synth.spoken[0].text, "être", "read the displayed dictionary headword rather than the original inflection");
  assert.strictEqual(synth.spoken[0].voice, french, "prefer France French over another French locale or the system default");
  assert.strictEqual(synth.spoken[0].lang, "fr-FR");
  assert.ok(button.textContent.includes("停止"));
  assert.strictEqual(button.getAttribute("aria-pressed"), "true");
  const oldEnd = synth.spoken[0].onend;
  const oldError = synth.spoken[0].onerror;
  button.click();
  await flush();
  assert.strictEqual(synth.cancellations, 1, "clicking during playback stops the active utterance");
  assert.strictEqual(spoken.popup.speechState, null);
  assert.strictEqual(button.getAttribute("aria-pressed"), "false");
  assert.ok(button.textContent.includes("朗读"));
  button.click();
  await flush();
  oldEnd();
  oldError({ error: "interrupted" });
  assert.strictEqual(button.getAttribute("aria-pressed"), "true", "late events from stopped speech must not reset a newer utterance");
  assert.strictEqual(spoken.popup.statusEl.textContent, "", "a stale cancellation must not report an error on a newer utterance");
  synth.spoken[1].onend();
  assert.strictEqual(spoken.popup.speechState, null);
  assert.strictEqual(button.getAttribute("aria-pressed"), "false");
  assert.strictEqual(synth.cancellations, 1, "natural completion must not cancel another feature's queued speech");
  button.click();
  await flush();
  synth.spoken[2].onerror({ error: "audio-busy" });
  assert.strictEqual(button.getAttribute("aria-pressed"), "false");
  assert.match(spoken.popup.statusEl.textContent, /朗读|语音|播放/, "playback errors must be visible in Chinese");

  const delayedTranslation = deferred();
  spoken.popup.translate = async () => delayedTranslation.promise;
  button.click();
  await flush();
  const beforeSwitch = synth.cancellations;
  const modePromise = spoken.popup.switchMode("translation");
  assert.strictEqual(synth.cancellations, beforeSwitch + 1, "switching tabs stops the previous pronunciation before the new content arrives");
  delayedTranslation.resolve({ text: "他们曾经是。" });
  await modePromise;
  spoken.popup.speechButton.click();
  await flush();
  assert.strictEqual(synth.spoken.at(-1).text, "étaient", "translation mode reads the original French rather than a cached dictionary lemma");
  const beforeClose = synth.cancellations;
  spoken.popup.close();
  assert.strictEqual(synth.cancellations, beforeClose + 1);
  spoken.popup.destroy();
  assert.strictEqual(synth.cancellations, beforeClose + 1, "closing an idle controller must leave other speech alone");

  const changing = setup();
  const changingSynth = installSpeech(changing.doc, [english, canadian]);
  await changing.popup.showLookup(buildFrenchLookup("premier"), null, { doc: changing.doc });
  changing.popup.speechButton.click();
  await flush();
  assert.strictEqual(changingSynth.spoken[0].voice, canadian, "another French locale is usable when France French is unavailable");
  assert.strictEqual(changingSynth.spoken[0].lang, "fr-CA");
  await changing.popup.showLookup(buildFrenchLookup("deuxième"), null, { doc: changing.doc });
  assert.strictEqual(changingSynth.cancellations, 1, "selecting a new word stops the old pronunciation");
  changing.popup.speechButton.click();
  await flush();
  changing.popup.destroy();
  assert.strictEqual(changingSynth.cancellations, 2, "unloading stops an active pronunciation");

  const delayedDictionary = deferred();
  const pending = setup({ lookup: async () => delayedDictionary.promise });
  const pendingSynth = installSpeech(pending.doc);
  const lookupPromise = pending.popup.showLookup(buildFrenchLookup("étaient"), null, { doc: pending.doc });
  pending.popup.speechButton.click();
  await flush();
  assert.strictEqual(pendingSynth.spoken[0].text, "étaient");
  delayedDictionary.resolve(result("être"));
  await lookupPromise;
  assert.strictEqual(pendingSynth.cancellations, 1, "an asynchronous dictionary result changing the title stops the outdated speech");
  assert.strictEqual(pending.popup.speechButton.getAttribute("aria-pressed"), "false");
  pending.popup.destroy();

  const phrase = setup();
  const phraseSynth = installSpeech(phrase.doc);
  phrase.popup.translate = async () => ({ text: "她们很美。" });
  await phrase.popup.showLookup(buildFrenchLookup("Elles étaient belles."), null, { doc: phrase.doc });
  phrase.popup.speechButton.click();
  await flush();
  assert.strictEqual(phraseSynth.spoken[0].text, "Elles étaient belles", "a translation popup pronounces the French phrase");
  phrase.popup.destroy();

  const delayedVoices = setup();
  const lateSynth = installSpeech(delayedVoices.doc, []);
  await delayedVoices.popup.showLookup(buildFrenchLookup("moment"), null, { doc: delayedVoices.doc });
  delayedVoices.popup.speechButton.click();
  await flush();
  assert.strictEqual(lateSynth.spoken.length, 0, "an empty initial voice list must wait for language discovery");
  assert.ok(lateSynth.listeners.size > 0);
  lateSynth.voices = [french];
  lateSynth.emitVoicesChanged();
  await flush();
  assert.strictEqual(lateSynth.spoken[0].text, "moment", "voices loaded after the click must start the pending pronunciation");
  assert.strictEqual(lateSynth.listeners.size, 0, "language discovery listeners must be removed after use");
  delayedVoices.popup.close();
  lateSynth.voices = [];
  await delayedVoices.popup.showLookup(buildFrenchLookup("désir"), null, { doc: delayedVoices.doc });
  delayedVoices.popup.speechButton.click();
  await flush();
  assert.ok(lateSynth.listeners.size > 0);
  const beforeWaitStop = lateSynth.cancellations;
  delayedVoices.popup.speechButton.click();
  await flush();
  assert.strictEqual(lateSynth.listeners.size, 0, "the stop button also cancels pending voice discovery");
  assert.strictEqual(delayedVoices.popup.speechState, null);
  assert.strictEqual(lateSynth.cancellations, beforeWaitStop, "cancelling voice discovery must not cancel unrelated audio");
  delayedVoices.popup.speechButton.click();
  await flush();
  assert.ok(lateSynth.listeners.size > 0);
  delayedVoices.popup.close();
  assert.strictEqual(lateSynth.listeners.size, 0, "closing while voices load must remove the pending listener");
  lateSynth.voices = [french];
  lateSynth.emitVoicesChanged();
  await flush();
  assert.strictEqual(lateSynth.spoken.length, 1, "late voice discovery must not speak after the popup closes");
  delayedVoices.popup.destroy();

  const popout = setup();
  const mainSynth = installSpeech(popout.doc);
  const popoutDoc = new FakeDocument();
  const popoutSynth = installSpeech(popoutDoc);
  await popout.popup.showLookup(buildFrenchLookup("désir"), null, { doc: popoutDoc });
  popout.popup.speechButton.click();
  await flush();
  assert.strictEqual(popoutSynth.spoken.length, 1, "speech must use the selected popout document's runtime");
  assert.strictEqual(mainSynth.spoken.length, 0);
  popout.popup.destroy();
  assert.strictEqual(popoutSynth.cancellations, 1);
  assert.strictEqual(mainSynth.cancellations, 0);

  for (const failure of ["unsupported", "no-french", "speak-throws"]) {
    const failed = setup();
    let failedSynth;
    if (failure !== "unsupported") failedSynth = installSpeech(failed.doc, failure === "no-french" ? [english] : [french]);
    if (failure === "speak-throws") failedSynth.speak = () => { throw new Error("native speech failed"); };
    await failed.popup.showLookup(buildFrenchLookup("moment"), null, { doc: failed.doc });
    failed.popup.speechButton.click();
    await flush();
    assert.strictEqual(failed.popup.speechState, null, `${failure} must not leave a stuck playing state`);
    assert.strictEqual(failed.popup.speechButton.getAttribute("aria-pressed"), "false");
    assert.match(failed.popup.statusEl.textContent, /朗读|语音|播放/, `${failure} must display a useful Chinese error`);
    if (failure === "no-french") assert.strictEqual(failedSynth.spoken.length, 0, "do not pronounce French with an unrelated language voice");
    failed.popup.destroy();
  }
}

async function run() {
  await testReadingContextMenu();
  assert.deepStrictEqual(positionLookupPopup({ left: 890, top: 670, bottom: 690 }, { width: 420, height: 360 }, { width: 900, height: 700 }), {
    left: 468, top: 300, maxWidth: 876, maxHeight: 676,
  });
  const small = positionLookupPopup({ left: -100, top: -100, bottom: -90 }, { width: 420, height: 440 }, { width: 320, height: 400 });
  assert.strictEqual(small.left, 12);
  assert.strictEqual(small.top, 12);

  const basic = setup({ lookup: async () => result("identification", { definitions: ["<img src=x onerror=alert(1)>认同"], partial: true }) });
  const selection = basic.popup.readSelection(basic.paragraph);
  assert.strictEqual(selection.lookup.query, "identification");
  assert.strictEqual(selection.lookup.context, basic.paragraph.textContent);
  await basic.popup.showLookup(selection.lookup, selection.rect, { doc: basic.doc });
  assert.strictEqual(basic.popup.titleEl.textContent, "identification");
  assert.ok(basic.popup.formEl.textContent.includes("l’identification → 词条：identification"));
  assert.ok(basic.popup.bodyEl.textContent.includes("n. f. 阴性名词"));
  assert.ok(basic.popup.bodyEl.textContent.includes("<img src=x onerror=alert(1)>"));
  assert.ok(!basic.popup.bodyEl.children.some((element) => element.tagName === "IMG"), "dictionary content must remain inert text");
  assert.ok(basic.popup.bodyEl.textContent.includes("部分内容需在原站查看"));
  assert.strictEqual(basic.popup.saveTarget, "identification");
  await Promise.all([basic.popup.saveWord(), basic.popup.saveWord()]);
  assert.deepStrictEqual(basic.calls, [{ type: "add", word: "identification", categoryId: "7" }]);
  assert.ok(basic.popup.saveButton.disabled);
  assert.ok(basic.popup.statusEl.textContent.includes("已将 identification"));
  assert.deepStrictEqual(basic.stateCalls, [
    { word: "identification", categoryId: "7" },
    { word: "identification", categoryId: "7" },
  ], "opening and saving must both read the current wordbook state");
  basic.popup.pinButton.click();
  await flush();
  assert.strictEqual(basic.popup.pinned, true);
  basic.doc.emit("pointerdown", { target: basic.paragraph });
  assert.ok(basic.popup.popupEl, "pinning keeps the popup when the document is clicked");
  basic.doc.emit("keyup", { key: "Escape" });
  assert.strictEqual(basic.popup.popupEl, null);
  await basic.popup.showLookup(selection.lookup, selection.rect, { doc: basic.doc });
  assert.strictEqual(basic.popup.saveButton.textContent, "★ 已加入", "reopening must reflect an existing API membership");
  basic.plugin.settings.frenchLookupWordbookId = "8";
  await basic.popup.showLookup(selection.lookup, selection.rect, { doc: basic.doc });
  assert.strictEqual(basic.popup.saveButton.disabled, false, "membership belongs to the selected wordbook");
  basic.popup.destroy();

  const confirmation = deferred();
  let confirmationReads = 0;
  const confirming = setup({ isWordInWordbook: async () => ++confirmationReads === 1 ? false : confirmation.promise });
  await confirming.popup.showLookup(buildFrenchLookup("historique"), null, { doc: confirming.doc });
  const saving = confirming.popup.saveWord();
  await flush();
  assert.strictEqual(confirming.popup.saveButton.disabled, true);
  assert.strictEqual(confirming.popup.saveButton.textContent, "正在同步…");
  assert.strictEqual(confirming.popup.saved, false, "POST alone must not confirm the wordbook state");
  await confirming.popup.saveWord();
  assert.strictEqual(confirming.calls.filter((call) => call.type === "add").length, 1);
  confirmation.resolve(true);
  await saving;
  assert.strictEqual(confirming.popup.saveButton.textContent, "★ 已加入");
  confirming.popup.destroy();

  let retryReads = 0;
  const retrying = setup({ isWordInWordbook: async () => {
    retryReads += 1;
    if (retryReads === 2) throw new Error("暂时无法连接欧路 API，请检查网络。");
    return retryReads > 2;
  } });
  await retrying.popup.showLookup(buildFrenchLookup("historique"), null, { doc: retrying.doc });
  await retrying.popup.saveWord();
  assert.ok(retrying.popup.statusEl.textContent.includes("已提交"));
  assert.ok(retrying.popup.statusEl.textContent.includes("同步失败"));
  assert.strictEqual(retrying.popup.saveButton.textContent, "重试同步");
  assert.strictEqual(retrying.popup.saveButton.disabled, false);
  await retrying.popup.saveWord();
  assert.strictEqual(retrying.popup.saveButton.textContent, "★ 已加入");
  assert.strictEqual(retrying.calls.filter((call) => call.type === "add").length, 1, "retrying a read must not submit the word again");
  retrying.popup.destroy();

  let notYetSaved = false;
  const unconfirmed = setup({ isWordInWordbook: async () => notYetSaved });
  await unconfirmed.popup.showLookup(buildFrenchLookup("historique"), null, { doc: unconfirmed.doc });
  await unconfirmed.popup.saveWord();
  assert.strictEqual(unconfirmed.popup.saved, false);
  assert.strictEqual(unconfirmed.popup.saveButton.textContent, "重试同步", "an absent membership after POST must remain unconfirmed");
  assert.ok(unconfirmed.popup.statusEl.textContent.includes("尚未确认"));
  notYetSaved = true;
  await unconfirmed.popup.saveWord();
  assert.strictEqual(unconfirmed.popup.saveButton.textContent, "★ 已加入");
  assert.strictEqual(unconfirmed.calls.filter((call) => call.type === "add").length, 1);
  unconfirmed.popup.destroy();

  const readFailure = setup({ isWordInWordbook: async () => { throw new Error("状态读取失败"); } });
  await readFailure.popup.showLookup(buildFrenchLookup("historique"), null, { doc: readFailure.doc });
  assert.ok(readFailure.popup.bodyEl.textContent.includes("认同"), "state errors must not hide dictionary definitions");
  assert.ok(readFailure.popup.statusEl.textContent.includes("同步失败"));
  assert.strictEqual(readFailure.popup.saveButton.disabled, false);
  readFailure.popup.destroy();

  const failedAdd = setup({ addWord: async () => { throw new Error("加入失败，请稍后重试。"); } });
  await failedAdd.popup.showLookup(buildFrenchLookup("historique"), null, { doc: failedAdd.doc });
  await failedAdd.popup.saveWord();
  assert.ok(failedAdd.popup.statusEl.textContent.includes("加入失败"));
  assert.strictEqual(failedAdd.popup.saveButton.textContent, "☆ 加入生词本");
  assert.strictEqual(failedAdd.popup.saveButton.disabled, false);
  assert.strictEqual(failedAdd.stateCalls.length, 1, "a failed POST must not proceed to success confirmation");
  failedAdd.popup.destroy();

  const lateState = deferred();
  const staleState = setup({ isWordInWordbook: async (word) => word === "premier" ? lateState.promise : true });
  const opening = staleState.popup.showLookup(buildFrenchLookup("premier"), null, { doc: staleState.doc });
  await flush();
  await staleState.popup.showLookup(buildFrenchLookup("deuxième"), null, { doc: staleState.doc });
  lateState.resolve(false);
  await opening;
  assert.strictEqual(staleState.popup.titleEl.textContent, "deuxième");
  assert.strictEqual(staleState.popup.saveButton.textContent, "★ 已加入", "late membership reads must not overwrite a newer word");
  staleState.popup.destroy();

  const lateConfirmation = deferred();
  let firstWordReads = 0;
  const staleSave = setup({ isWordInWordbook: async (word) => {
    if (word !== "premier") return false;
    return ++firstWordReads === 1 ? false : lateConfirmation.promise;
  } });
  await staleSave.popup.showLookup(buildFrenchLookup("premier"), null, { doc: staleSave.doc });
  const oldSave = staleSave.popup.saveWord();
  await flush();
  await staleSave.popup.showLookup(buildFrenchLookup("deuxième"), null, { doc: staleSave.doc });
  lateConfirmation.resolve(true);
  await oldSave;
  assert.strictEqual(staleSave.popup.saveButton.textContent, "☆ 加入生词本", "a previous save must not mark a new word as saved");
  assert.strictEqual(staleSave.popup.statusEl.textContent, "");
  staleSave.popup.destroy();

  const oldBookState = deferred();
  const changingBook = setup({ isWordInWordbook: async (_word, categoryId) => categoryId === "7" ? oldBookState.promise : false });
  const oldBookLookup = changingBook.popup.showLookup(buildFrenchLookup("historique"), null, { doc: changingBook.doc });
  await flush();
  changingBook.plugin.settings.frenchLookupWordbookId = "8";
  oldBookState.resolve(true);
  await oldBookLookup;
  assert.strictEqual(changingBook.popup.saveButton.disabled, false, "an in-flight status read must follow a change of selected book");
  assert.strictEqual(changingBook.popup.saveButton.textContent, "☆ 加入生词本");
  changingBook.popup.destroy();

  const switchedBook = setup({ isWordInWordbook: async (_word, categoryId) => categoryId === "7" });
  await switchedBook.popup.showLookup(buildFrenchLookup("historique"), null, { doc: switchedBook.doc });
  switchedBook.popup.pinned = true;
  assert.strictEqual(switchedBook.popup.saveButton.textContent, "★ 已加入");
  switchedBook.plugin.settings.frenchLookupWordbookId = "8";
  await switchedBook.popup.syncWordbookState();
  assert.strictEqual(switchedBook.popup.saveButton.disabled, false, "a pinned popup must refresh the new book after the old request has completed");
  switchedBook.popup.destroy();

  const apiCalls = [];
  let apiSaved = false;
  const api = new FrenchDictionaryService({ getToken: async () => "test-only-token", requestUrl: async (options) => {
    apiCalls.push(options);
    if (options.method === "POST") { apiSaved = true; return { status: 201, json: { message: "success" } }; }
    return { status: 200, json: apiSaved ? { word: "historique", star: 1, category_ids: [7] } : { data: [] } };
  } });
  const integrated = setup({ addWord: api.addWord.bind(api), isWordInWordbook: api.isWordInWordbook.bind(api) });
  await integrated.popup.showLookup(buildFrenchLookup("historique"), null, { doc: integrated.doc });
  await integrated.popup.saveWord();
  assert.deepStrictEqual(apiCalls.map((call) => call.method), ["GET", "POST", "GET"], "the real popup and service must read, add, then confirm through the API");
  assert.strictEqual(integrated.popup.saveButton.textContent, "★ 已加入");
  apiSaved = false;
  await integrated.popup.showLookup(buildFrenchLookup("historique"), null, { doc: integrated.doc });
  assert.strictEqual(integrated.popup.saveButton.disabled, false, "a remote removal must appear on the next lookup despite a previous successful add");
  integrated.popup.destroy();

  const glyph = setup({ lookup: async () => result("identification", {
    definitions: ["前文〔法助字图:0〕后文", "恶意〔法助字图:1〕及缺失〔法助字图:9〕"],
    glyphs: [
      { marker: "〔法助字图:0〕", src: "https://www.frdic.com/tmp/wordimg/7rLlDMkXNa@@TK1Uo61cTc84G@nE=.png", width: 18, height: 18, alt: "认" },
      { marker: "〔法助字图:1〕", src: "https://attacker.invalid/tracker.png", alt: "坏" },
    ],
  }) });
  await glyph.popup.showLookup(buildFrenchLookup("identification"), null, { doc: glyph.doc });
  const glyphDefinitions = glyph.popup.bodyEl.find("lacan-french-lookup-definitions");
  assert.deepStrictEqual(glyphDefinitions.children[0].children.map((node) => node.nodeType === 3 ? node.textContent : node.tagName), ["前文", "IMG", "后文"], "inline glyphs preserve the surrounding Chinese text order");
  assert.strictEqual(glyphDefinitions.children[0].children[1].src, "https://www.frdic.com/tmp/wordimg/7rLlDMkXNa@@TK1Uo61cTc84G@nE=.png");
  assert.strictEqual(glyphDefinitions.children[0].children[1].alt, "认");
  assert.strictEqual(glyphDefinitions.children[1].textContent, "恶意〔图文〕及缺失〔图文〕", "untrusted or missing glyph metadata must never create an image request");
  for (const unsafeUrl of ["javascript:alert(1)", "https://www.frdic.com.evil.test/tmp/wordimg/a.png", "https://www.frdic.com/elsewhere/a.png", "https://www.frdic.com/tmp/wordimg/a.png?tracking=1", "https://user:pass@www.frdic.com/tmp/wordimg/a.png"]) {
    glyph.popup.renderDictionary(result("identification", { definitions: ["〔法助字图:0〕"], glyphs: [{ marker: "〔法助字图:0〕", src: unsafeUrl }] }));
    assert.strictEqual(glyph.popup.bodyEl.find("lacan-french-lookup-glyph"), null);
  }
  glyph.popup.destroy();

  const phrases = setup();
  const translationCalls = [];
  phrases.popup.translate = async (lookup, options) => {
    translationCalls.push({ lookup, signal: options.signal });
    return { text: "这些词形有语法意义。", source: "语境翻译 · 本地 Agent", grammar: ["复数形式"] };
  };
  await phrases.popup.showLookup(buildFrenchLookup("Elles étaient belles.", "Elles étaient belles."), null, { doc: phrases.doc });
  assert.strictEqual(phrases.popup.mode, "translation");
  assert.strictEqual(phrases.calls.length, 0, "automatic phrase translation must not request a dictionary word entry");
  assert.strictEqual(translationCalls.length, 1);
  assert.strictEqual(translationCalls[0].lookup.selection, "Elles étaient belles");
  assert.ok(phrases.popup.bodyEl.textContent.includes("这些词形有语法意义。"));
  assert.strictEqual(phrases.popup.sourceEl.textContent, "语境翻译 · 本地 Agent");
  phrases.popup.close();
  assert.strictEqual(translationCalls[0].signal.aborted, true);
  phrases.popup.destroy();

  const delayed = deferred();
  const stale = setup({ lookup: async (query) => query === "premier" ? delayed.promise : result("deuxième") });
  const first = stale.popup.showLookup(buildFrenchLookup("premier"), null, { doc: stale.doc });
  await flush();
  await stale.popup.showLookup(buildFrenchLookup("deuxième"), null, { doc: stale.doc });
  delayed.resolve(result("premier"));
  await first;
  assert.strictEqual(stale.popup.titleEl.textContent, "deuxième", "a late response must never replace a newer selection");
  stale.popup.destroy();

  const ambiguous = setup({ lookup: async (query) => query === "étaient" ? result(query, { ambiguous: true, definitions: ["être／étayer 候选"], suggestions: [{ headword: "être" }, { headword: "étayer" }] }) : result(query) });
  await ambiguous.popup.showLookup(buildFrenchLookup("étaient", "Ils étaient là."), null, { doc: ambiguous.doc });
  assert.strictEqual(ambiguous.popup.saveButton.disabled, true, "ambiguous verb forms require a dictionary choice before saving");
  const choices = ambiguous.popup.bodyEl.find("lacan-french-lookup-suggestions");
  const chooseEtre = choices.children.find((element) => element.textContent === "être");
  chooseEtre.click();
  await flush();
  assert.strictEqual(ambiguous.popup.lookup.selection, "étaient");
  assert.strictEqual(ambiguous.popup.lookup.context, "Ils étaient là.");
  assert.strictEqual(ambiguous.popup.titleEl.textContent, "être");
  assert.strictEqual(ambiguous.popup.saveTarget, "être");
  ambiguous.popup.destroy();

  const triggered = setup();
  triggered.popup.start();
  triggered.plugin.settings.frenchLookupTrigger = "double-click";
  triggered.doc.emit("pointerup", { target: triggered.paragraph, button: 0 });
  await tick(200);
  assert.strictEqual(triggered.calls.length, 0, "double-click mode must not react to ordinary selection");
  triggered.doc.emit("dblclick", { target: triggered.paragraph, button: 0 });
  await tick(10);
  assert.strictEqual(triggered.calls.length, 1);
  triggered.popup.close();
  triggered.plugin.settings.frenchLookupTrigger = "selection";
  triggered.doc.emit("pointerup", { target: triggered.paragraph, button: 0 });
  await tick(200);
  assert.strictEqual(triggered.calls.length, 2, "selection mode must lookup the actual selected text");
  triggered.popup.destroy();
  assert.ok([...triggered.doc.listeners.values()].every((listeners) => listeners.length === 0), "destroy removes every registered document listener");

  const lifecycle = setup();
  let leafChanged;
  let removedWorkspaceEvent;
  lifecycle.plugin.app.workspace.on = (type, listener) => { leafChanged = listener; return "leaf-change-event"; };
  lifecycle.plugin.app.workspace.offref = (ref) => { removedWorkspaceEvent = ref; };
  lifecycle.popup.start();
  lifecycle.popup.destroy();
  assert.strictEqual(removedWorkspaceEvent, "leaf-change-event");
  const otherDoc = new FakeDocument();
  lifecycle.view.containerEl = otherDoc.body;
  leafChanged();
  lifecycle.popup.bindDocument(otherDoc);
  assert.strictEqual(otherDoc.listeners.size, 0, "destroyed popup controllers must never bind listeners in later popout windows");

  const editor = setup();
  const textNode = { nodeType: 3, textContent: "L’identification", parentElement: editor.paragraph };
  editor.doc.selection = {
    rangeCount: 1, isCollapsed: false,
    toString: () => "identification",
    getRangeAt: () => ({ startContainer: textNode, endContainer: textNode, startOffset: 2, commonAncestorContainer: textNode }),
  };
  assert.strictEqual(editor.popup.readSelection(editor.paragraph, { expandWord: true }).lookup.selection, "L’identification", "double-click restores the full French token around a native partial-word selection");
  assert.strictEqual(editor.popup.readSelection(editor.paragraph).lookup.selection, "identification", "manual selection must remain exactly what the user selected");
  editor.paragraph.textContent = "L’éthique de la psychanalyse.";
  const emphasis = editor.paragraph.appendChild(editor.doc.createElement("em"));
  const styledText = { nodeType: 3, textContent: "éthique", parentElement: emphasis };
  editor.doc.selection = {
    rangeCount: 1, isCollapsed: false, toString: () => "éthique",
    getRangeAt: () => ({ startContainer: styledText, endContainer: styledText, startOffset: 0, commonAncestorContainer: styledText }),
  };
  editor.doc.createRange = () => ({ selectNodeContents() {}, setEnd() {}, toString: () => "L’" });
  assert.strictEqual(editor.popup.readSelection(emphasis, { expandWord: true }).lookup.selection, "L’éthique", "double-click restores elisions split across inline emphasis nodes");
  assert.strictEqual(editor.popup.readSelection(emphasis).lookup.selection, "éthique");
  editor.doc.selection = null;
  editor.view.editor = { getSelection: () => "", getCursor: () => ({ line: 2, ch: 9 }), getLine: () => "L’identification" };
  const atCursor = editor.popup.readSelection(null, { allowCursor: true });
  assert.strictEqual(atCursor.lookup.selection, "L’identification");
  const input = editor.container.appendChild(editor.doc.createElement("input"));
  assert.strictEqual(editor.popup.readSelection(input), null, "settings and input controls must not trigger lookup");
  editor.popup.destroy();

  const bilingual = setup();
  const bilingualContainer = bilingual.doc.body.appendChild(bilingual.doc.createElement("div"));
  bilingualContainer.className = "lacan-bilingual-view";
  const frenchLane = bilingualContainer.appendChild(bilingual.doc.createElement("div"));
  frenchLane.className = "lacan-bilingual-language is-original";
  const frenchParagraph = frenchLane.appendChild(bilingual.doc.createElement("p"));
  frenchParagraph.textContent = "L’";
  const frenchEmphasis = frenchParagraph.appendChild(bilingual.doc.createElement("em"));
  const frenchText = frenchEmphasis.appendChild(bilingual.doc.createTextNode("éthique"));
  const frenchSuffix = frenchParagraph.appendChild(bilingual.doc.createTextNode(" de la psychanalyse."));
  const bilingualView = { containerEl: bilingualContainer, getViewType: () => "lacan-bilingual-reading" };
  const bilingualLeaves = [{ view: bilingual.view }, { view: bilingualView }];
  bilingual.plugin.app.workspace.iterateAllLeaves = (visitor) => bilingualLeaves.forEach(visitor);
  bilingual.doc.createRange = () => ({ selectNodeContents() {}, setEnd() {}, toString: () => "L’" });
  bilingual.doc.selection = {
    rangeCount: 1, isCollapsed: false, toString: () => "éthique",
    getRangeAt: () => ({ startContainer: frenchText, endContainer: frenchText, startOffset: 0, commonAncestorContainer: frenchText }),
  };
  const draggedWord = bilingual.popup.readSelection(frenchText);
  assert.ok(draggedWord, "a visible bilingual target must resolve its own view while another pane remains active");
  assert.strictEqual(draggedWord.lookup.selection, "éthique", "manual dragging preserves the precise French selection");
  assert.strictEqual(draggedWord.lookup.context, "L’éthique de la psychanalyse.");
  const expandedWord = bilingual.popup.readSelection(frenchText, { expandWord: true });
  assert.strictEqual(expandedWord.lookup.selection, "L’éthique", "native double-click expands an elision across emphasis and text nodes in bilingual reading");
  const frenchSelection = bilingual.doc.selection;
  bilingual.doc.selection = null;
  bilingual.view.editor = { getSelection: () => "mauvais", getCursor: () => ({ line: 0, ch: 2 }), getLine: () => "mauvais" };
  assert.strictEqual(bilingual.popup.readSelection(frenchText, { allowCursor: true }), null, "an unselected bilingual target must not borrow the unrelated active Markdown editor's selection or cursor");
  bilingual.doc.selection = frenchSelection;
  bilingual.popup.start();
  bilingual.doc.emit("pointerup", { target: frenchText, button: 0 });
  await tick(200);
  assert.deepStrictEqual(bilingual.calls.map((call) => call.query), ["éthique"], "dragging a word in an inactive bilingual pane opens its dictionary");
  const bilingualTranslationCalls = [];
  bilingual.popup.translate = async (lookup) => { bilingualTranslationCalls.push(lookup); return { text: "精神分析的伦理。" }; };
  bilingual.popup.close();
  bilingual.doc.selection = {
    rangeCount: 1, isCollapsed: false, toString: () => frenchParagraph.textContent,
    getRangeAt: () => ({ startContainer: frenchText, endContainer: frenchSuffix, startOffset: 0, commonAncestorContainer: frenchParagraph }),
  };
  bilingual.doc.emit("pointerup", { target: frenchSuffix, button: 0 });
  await tick(200);
  assert.strictEqual(bilingual.popup.mode, "translation");
  assert.strictEqual(bilingualTranslationCalls[0].selection, "L’éthique de la psychanalyse");
  assert.strictEqual(bilingualTranslationCalls[0].context, frenchParagraph.textContent);
  bilingual.popup.close();
  bilingual.plugin.settings.frenchLookupTrigger = "double-click";
  bilingual.doc.selection = {
    rangeCount: 1, isCollapsed: false, toString: () => "éthique",
    getRangeAt: () => ({ startContainer: frenchText, endContainer: frenchText, startOffset: 0, commonAncestorContainer: frenchText }),
  };
  bilingual.doc.emit("dblclick", { target: frenchText, button: 0 });
  await tick(10);
  assert.strictEqual(bilingual.popup.lookup.selection, "L’éthique");
  assert.strictEqual(bilingual.popup.lookup.query, "éthique");
  bilingual.popup.close();
  const inlineEditor = bilingualContainer.appendChild(bilingual.doc.createElement("div"));
  inlineEditor.className = "lacan-translation-inline-editor";
  const translatedInput = inlineEditor.appendChild(bilingual.doc.createElement("textarea"));
  bilingual.doc.emit("dblclick", { target: translatedInput, button: 0 });
  await tick(10);
  assert.strictEqual(bilingual.popup.popupEl, null, "lookup must leave Chinese inline editing controls alone");
  bilingual.popup.destroy();

  const pdf = setup();
  const pdfContainer = pdf.doc.body.appendChild(pdf.doc.createElement("div"));
  const pdfToolbar = pdfContainer.appendChild(pdf.doc.createElement("div"));
  pdfToolbar.textContent = "Rechercher dans le document";
  const textLayer = pdfContainer.appendChild(pdf.doc.createElement("div"));
  textLayer.className = "textLayer";
  const pdfPrefix = textLayer.appendChild(pdf.doc.createTextNode("L’"));
  const pdfSpan = textLayer.appendChild(pdf.doc.createElement("span"));
  const pdfWord = pdfSpan.appendChild(pdf.doc.createTextNode("éthique"));
  const pdfSuffix = textLayer.appendChild(pdf.doc.createTextNode(" de la psychanalyse."));
  const pdfView = { containerEl: pdfContainer, getViewType: () => "pdf" };
  pdf.plugin.app.workspace.iterateAllLeaves = (visitor) => [{ view: pdf.view }, { view: pdfView }].forEach(visitor);
  pdf.doc.createRange = () => ({ selectNodeContents() {}, setEnd() {}, toString: () => "L’" });
  pdf.doc.selection = {
    rangeCount: 1, isCollapsed: false, toString: () => "éthique",
    getRangeAt: () => ({ startContainer: pdfWord, endContainer: pdfWord, startOffset: 0, commonAncestorContainer: pdfWord }),
  };
  assert.strictEqual(pdf.popup.readSelection(pdfWord).lookup.selection, "éthique", "PDF drag selection preserves the selected word in an inactive pane");
  assert.strictEqual(pdf.popup.readSelection(pdfWord).lookup.context, "L’éthique de la psychanalyse.", "PDF context includes adjacent text spans rather than just the selected span");
  assert.strictEqual(pdf.popup.readSelection(pdfWord, { expandWord: true }).lookup.selection, "L’éthique", "PDF double-click restores an elision across text spans");
  assert.strictEqual(pdf.popup.readSelection(pdfToolbar), null, "PDF toolbar text must not trigger lookup");
  const annotation = pdfContainer.appendChild(pdf.doc.createElement("div"));
  annotation.textContent = "Une annotation";
  assert.strictEqual(pdf.popup.readSelection(annotation), null, "annotation UI must not be sent as PDF reading text");
  pdf.popup.start();
  pdf.doc.emit("pointerup", { target: pdfWord, button: 0 });
  await tick(200);
  assert.deepStrictEqual(pdf.calls.map((call) => call.query), ["éthique"]);
  pdf.popup.close();
  const pdfTranslations = [];
  pdf.popup.translate = async (lookup) => { pdfTranslations.push(lookup); return { text: "精神分析的伦理。" }; };
  pdf.doc.selection = {
    rangeCount: 1, isCollapsed: false, toString: () => "L’éthique de la psychanalyse.",
    getRangeAt: () => ({ startContainer: pdfPrefix, endContainer: pdfSuffix, startOffset: 0, commonAncestorContainer: textLayer }),
  };
  pdf.doc.emit("pointerup", { target: pdfSuffix, button: 0 });
  await tick(200);
  assert.strictEqual(pdf.popup.mode, "translation");
  assert.strictEqual(pdfTranslations[0].selection, "L’éthique de la psychanalyse");
  pdf.popup.close();
  pdf.plugin.app.workspace.activeLeaf = { view: pdfView };
  assert.strictEqual(await pdf.popup.lookupCurrentSelection("translation"), true, "manual lookup commands work in the active PDF view");
  pdf.popup.close();
  const pdfLineOne = pdf.doc.createTextNode("désir");
  const pdfLineTwo = pdf.doc.createTextNode("éthique");
  textLayer.replaceChildren(pdfLineOne, pdf.doc.createElement("br"), pdfLineTwo);
  pdf.doc.selection = {
    rangeCount: 1, isCollapsed: false, toString: () => "désiréthique",
    getRangeAt: () => ({ startContainer: pdfLineOne, endContainer: pdfLineTwo, startOffset: 0, endOffset: 7, commonAncestorContainer: textLayer }),
  };
  assert.strictEqual(pdf.popup.readSelection(pdfLineOne).lookup.selection, "désir éthique", "PDF phrase selection restores rendered line boundaries before translation");
  pdf.doc.selection = {
    rangeCount: 1, isCollapsed: false, toString: () => "éthique",
    getRangeAt: () => ({ startContainer: pdfLineTwo, endContainer: pdfLineTwo, startOffset: 0, endOffset: 7, commonAncestorContainer: pdfLineTwo }),
  };
  assert.strictEqual(pdf.popup.readSelection(pdfLineTwo, { expandWord: true }).lookup.selection, "éthique", "PDF double-click never joins the last word on the previous line");
  const longPrefix = "Début de page. ".repeat(80);
  textLayer.textContent = longPrefix + "L’éthique de la psychanalyse. Fin de page.";
  textLayer.appendChild(pdfSpan);
  pdf.doc.createRange = () => ({ selectNodeContents() {}, setEnd() {}, toString: () => longPrefix + "L’" });
  pdf.doc.selection = {
    rangeCount: 1, isCollapsed: false, toString: () => "éthique",
    getRangeAt: () => ({ startContainer: pdfWord, endContainer: pdfWord, startOffset: 0, commonAncestorContainer: pdfWord }),
  };
  const nearbyPdf = pdf.popup.readSelection(pdfWord);
  assert.ok(nearbyPdf.lookup.context.includes("L’éthique de la psychanalyse"), "context near the bottom of a long PDF page must retain the selected passage");
  assert.ok(nearbyPdf.lookup.context.length <= 600);
  pdf.doc.selection = null;
  assert.strictEqual(pdf.popup.readSelection(pdfWord, { allowCursor: true }), null, "a scanned page or empty selection must not use a different pane's editor");
  pdf.popup.destroy();

  const popout = setup();
  const popoutDoc = new FakeDocument();
  const popoutRoot = popoutDoc.body.appendChild(popoutDoc.createElement("div"));
  const popoutParagraph = popoutRoot.appendChild(popoutDoc.createElement("p"));
  popoutParagraph.textContent = "Le désir de l’Autre.";
  const popoutView = { containerEl: popoutRoot, getViewType: () => "lacan-bilingual-reading" };
  popout.plugin.app.workspace.activeLeaf = { view: popoutView };
  popout.plugin.app.workspace.iterateAllLeaves = (visitor) => [{ view: popout.view }, { view: popoutView }].forEach(visitor);
  popoutDoc.selection = {
    rangeCount: 1, isCollapsed: false, toString: () => "désir",
    getRangeAt: () => ({ startContainer: popoutParagraph, endContainer: popoutParagraph, commonAncestorContainer: popoutParagraph }),
  };
  popout.popup.start();
  popoutDoc.emit("pointerup", { target: popoutParagraph, button: 0 });
  await tick(200);
  assert.strictEqual(popout.calls.length, 1, "an already-open active popout must work immediately after plugin start without another leaf-change event");
  assert.strictEqual(popout.popup.popupEl.ownerDocument, popoutDoc, "lookup opens in the document that owns the French selection");
  popout.popup.close();
  popout.plugin.app.workspace.activeLeaf = { view: popout.view };
  popoutDoc.emit("pointerup", { target: popoutParagraph, button: 0 });
  await tick(200);
  assert.strictEqual(popout.calls.length, 2, "popout target resolution must not fall back to an unrelated active main-window pane");
  popout.popup.destroy();
  await testSpeech();
  console.log("French lookup popup tests passed");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
