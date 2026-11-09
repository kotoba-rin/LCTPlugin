const assert = require("assert");
const {
  FrenchDictionaryService,
  FrenchDictionaryError,
  normalizeFrenchQuery,
  parseFrenchDictionaryHtml,
} = require("../src/french-dictionary-service");

// Small inert DOM model for Node-only tests. Production uses DOMParser. The
// fixture structure below was checked against public frdic pages on 2026-11-05.
function fixtureDocument(html) {
  const entities = (text) => text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, key) => {
    if (key[0] === "#") return String.fromCodePoint(parseInt(key.slice(key[1].toLowerCase() === "x" ? 2 : 1), key[1].toLowerCase() === "x" ? 16 : 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[key.toLowerCase()];
  });
  class Element {
    constructor(tagName, attributes = {}, parentNode = null) {
      this.nodeType = 1;
      this.tagName = tagName.toUpperCase();
      this.attributes = attributes;
      this.parentNode = parentNode;
      this.childNodes = [];
    }
    getAttribute(name) { return this.attributes[name.toLowerCase()] ?? null; }
    querySelectorAll(selector) {
      const matches = (node, part) => part[0] === "#" ? node.getAttribute("id") === part.slice(1)
        : part[0] === "." ? (node.getAttribute("class") || "").split(/\s+/).includes(part.slice(1))
          : part[0] === "[" ? node.getAttribute(part.slice(1, -1)) !== null : node.tagName.toLowerCase() === part.toLowerCase();
      const selectors = selector.split(",").map((part) => part.trim().split(/\s+/));
      const result = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          if (selectors.some((parts) => {
            if (!matches(child, parts[parts.length - 1])) return false;
            let parent = child.parentNode;
            for (let i = parts.length - 2; i >= 0; i -= 1) {
              while (parent && !matches(parent, parts[i])) parent = parent.parentNode;
              if (!parent) return false;
              parent = parent.parentNode;
            }
            return true;
          })) result.push(child);
          walk(child);
        }
      };
      walk(this);
      return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const document = new Element("document");
  const stack = [document];
  for (const token of html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) || []) {
    if (/^<!/.test(token)) continue;
    if (/^<\//.test(token)) {
      const name = token.match(/^<\/\s*([\w-]+)/)?.[1]?.toUpperCase();
      const index = stack.findLastIndex((element) => element.tagName === name);
      if (index > 0) stack.length = index;
    } else if (/^</.test(token)) {
      const tag = token.match(/^<\s*([\w-]+)/)?.[1];
      if (!tag) continue;
      const attributes = {};
      for (const match of token.slice(tag.length + 1).matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attributes[match[1].toLowerCase()] = entities(match[2] ?? match[3] ?? match[4] ?? "");
      }
      const element = new Element(tag, attributes, stack[stack.length - 1]);
      stack[stack.length - 1].childNodes.push(element);
      if (!["br", "hr", "img", "input", "meta", "link"].includes(tag.toLowerCase()) && !/\/>$/.test(token)) stack.push(element);
    } else {
      stack[stack.length - 1].childNodes.push({ nodeType: 3, nodeValue: entities(token) });
    }
  }
  return document;
}

const fixtures = {
  // https://www.frdic.com/dicts/fr/belles: its own n.f.pl. entry is distinct
  // from the spellHint alternatives, which must not be silently selected.
  belles: `<body><h1 class="explain-Word"><span class="word">belles</span></h1>
    <div class="spellHint">您是否要查找：<a href="/dicts/search/beau">beau</a> <a href="/dicts/search/bel">bel</a> <a href="/dicts/search/belle">belle</a></div>
    <SPAN class=Phonitic>[bεl]</span><div id="ExpFCchild" class="expDiv"><span class="cara">n. f. pl. </span><br><span class="exp">可耻的越轨言行; 反复的小挑衅</span><br>法 语 助 手 版 权 所 有<span style="color:transparent"> www.fr hel per.com 版 权 所 有</span></div></body>`,
  // https://www.frdic.com/dicts/fr/chevaux resolves to cheval on the site.
  chevaux: `<body><h1 class="explain-Word"><span class="word">cheval</span><span class="tag">TEF/TCF</span></h1>
    <SPAN class=Phonitic>[∫(ə)val]</SPAN><div id="ExpFCchild"><span class="syno">pl.~aux</span><br><span class="cara">n.m.</span><br><span class="exp">1. <img class="dictimgtoword" src="https://www.frdic.com/tmp/wordimg/example.png">, 牡<img class="dictimgtoword" src="https://www.frdic.com/tmp/wordimg/example.png"></span><br><span class="eg">example excluded</span></div></body>`,
  // https://www.frdic.com/dicts/fr/étaient has two site-provided matches.
  etaient: `<body><h3>法语助手找到多个结果，请选择您需要查找的单词：</h3><div class="content suggestion-list"><ul>
    <li><a href="/dicts/fr/être?recordid=NDU0MTM=&amp;libid=1">être</a><span class="exp"> n. m. 存在，本质</span></li>
    <li><a href="/dicts/fr/étayer?recordid=NDUxNDE=&amp;libid=1">étayer</a><span class="exp"> v. t. 用支柱支撑</span></li></ul></div></body>`,
};

async function run() {
  assert.strictEqual(normalizeFrenchQuery(" « E\u0302tre » "), "Être");
  assert.strictEqual(normalizeFrenchQuery("l’amour"), "l’amour");
  for (const value of ["", "'", "-", "汉字", "https://example.com", "a\nb\nc".repeat(40), "a/../../b"]) {
    assert.throws(() => normalizeFrenchQuery(value), (error) => error.code === "INVALID_QUERY");
  }
  const belles = parseFrenchDictionaryHtml(fixtures.belles, "belles", fixtureDocument);
  assert.strictEqual(belles.headword, "belles");
  assert.strictEqual(belles.phonetic, "[bεl]");
  assert.ok(belles.grammar.includes("n. f. pl."));
  assert.deepStrictEqual(belles.suggestions.map((item) => item.headword), ["beau", "bel", "belle"]);
  assert.strictEqual(belles.ambiguous, false);
  assert.ok(belles.definitions[0].includes("反复的小挑衅"));
  assert.ok(!belles.definitions.join().includes("版 权"));
  const chevaux = parseFrenchDictionaryHtml(fixtures.chevaux, "chevaux", fixtureDocument);
  assert.strictEqual(chevaux.headword, "cheval");
  assert.ok(chevaux.grammar.includes("pl.~aux"));
  assert.ok(chevaux.grammar.includes("n.m."));
  assert.strictEqual(chevaux.glyphs.length, 1, "identical glyph images share safe metadata");
  assert.ok(chevaux.definitions[0].includes(chevaux.glyphs[0].marker));
  assert.deepStrictEqual(chevaux.glyphs[0], {
    marker: "〔法助字图:0〕", src: "https://www.frdic.com/tmp/wordimg/example.png", width: null, height: null, alt: "词典字图",
  });
  assert.strictEqual(chevaux.partial, false, "renderable original glyphs preserve the complete definition");
  assert.ok(!chevaux.definitions.join().includes("example excluded"));
  const realGlyph = parseFrenchDictionaryHtml(fixtures.chevaux.replaceAll("example.png", "v0VtqRbkaUyxMlr6gLDxsHcE158=.png"), "chevaux", fixtureDocument);
  assert.ok(realGlyph.glyphs[0].src.endsWith("v0VtqRbkaUyxMlr6gLDxsHcE158=.png"));
  for (const image of [
    '<img class="dictimgtoword" src="https://evil.test/tmp/wordimg/a.png">',
    '<img class="dictimgtoword" src="http://www.frdic.com/tmp/wordimg/a.png">',
    '<img class="dictimgtoword" src="https://www.frdic.com/tracker.png">',
    '<img class="dictimgtoword" src="https://www.frdic.com/tmp/wordimg/a.png?track=1">',
    '<img class="dictimgtoword" src="data:image/png;base64,Zm9v">',
    '<img src="https://www.frdic.com/tmp/wordimg/a.png">',
  ]) {
    const rejected = parseFrenchDictionaryHtml(`<div id="ExpFCchild">a${image}b</div>`, "mot", fixtureDocument);
    assert.deepStrictEqual(rejected.glyphs, []);
    assert.ok(rejected.definitions[0].includes("〔图文〕"));
    assert.strictEqual(rejected.partial, true);
  }
  const dimensions = parseFrenchDictionaryHtml('<div id="ExpFCchild"><img class="dictimgtoword" src="/tmp/wordimg/a@@b=.png" width="16" height="9999" onerror="bad()"></div>', "mot", fixtureDocument);
  assert.strictEqual(dimensions.glyphs[0].width, 16);
  assert.strictEqual(dimensions.glyphs[0].height, null);
  assert.ok(!Object.hasOwn(dimensions.glyphs[0], "onerror"));
  const etaient = parseFrenchDictionaryHtml(fixtures.etaient, "étaient", fixtureDocument);
  assert.strictEqual(etaient.headword, "étaient");
  assert.strictEqual(etaient.ambiguous, true);
  assert.deepStrictEqual(etaient.suggestions.map((item) => item.headword), ["être", "étayer"]);
  assert.ok(etaient.suggestions[0].sourceUrl.includes("libid=1"));
  assert.strictEqual(etaient.source, "法语助手在线词典");
  assert.ok(etaient.sourceUrl.startsWith("https://www.frdic.com/dicts/fr/"));

  let parsedInput;
  const unsafe = fixtures.belles.replace("</body>", '<script>throw new Error("execute")</script><iframe src="https://evil.test"></iframe><a href="https://evil.test" class="unrelated">bad</a></body>');
  parseFrenchDictionaryHtml(unsafe, "belles", (html) => { parsedInput = html; return fixtureDocument(html); });
  assert.ok(!/<script|<iframe|src=/i.test(parsedInput));
  assert.throws(() => parseFrenchDictionaryHtml("<body>请输入验证码</body>", "amour", fixtureDocument), (error) => error.code === "ACCESS_RESTRICTED");
  assert.throws(() => parseFrenchDictionaryHtml("<body>没有找到对应单词</body>", "amour", fixtureDocument), (error) => error.code === "NOT_FOUND");
  const long = parseFrenchDictionaryHtml(`<div id="ExpFCChild"><span class="exp">${"定义".repeat(1500)}</span></div>`, "mot", fixtureDocument);
  assert.strictEqual(long.definitions.join("").length, 2000);
  assert.strictEqual(long.truncated, true);

  const calls = [];
  let now = 0;
  const service = new FrenchDictionaryService({
    parseHtml: fixtureDocument, now: () => now, getToken: async () => "private-token",
    requestUrl: async (options) => {
      calls.push(options);
      if (options.url.startsWith("https://www.frdic.com/")) return { status: 200, text: fixtures.belles };
      if (options.method === "GET") return { status: 200, json: { data: [{ id: "0", name: "默认生词本" }, { id: "123", name: "法语" }] } };
      return { status: 201, json: { message: "success" } };
    },
  });
  const first = await service.lookup("belles");
  first.definitions.length = 0;
  assert.ok((await service.lookup("belles")).definitions.length > 0, "callers must not mutate cached results");
  assert.strictEqual(calls.length, 1);
  now = 10 * 60 * 1000;
  await service.lookup("belles");
  assert.strictEqual(calls.length, 2, "successful lookup cache must expire");
  assert.deepStrictEqual(await service.listWordbooks(), [{ id: "0", name: "默认生词本" }, { id: "123", name: "法语" }]);
  assert.strictEqual(calls[2].url, "https://api.frdic.com/api/open/v1/studylist/category?language=fr");
  assert.strictEqual(calls[2].headers.Authorization, "NIS private-token");
  await service.addWord("être", "123");
  assert.strictEqual(calls[3].url, "https://api.frdic.com/api/open/v1/studylist/words");
  assert.deepStrictEqual(JSON.parse(calls[3].body), { language: "fr", category_id: "123", items: [{ word: "être", star: 1 }] });
  assert.ok(calls.slice(0, 2).every((call) => !call.headers), "public dictionary must not receive the API token");
  await assert.rejects(service.addWord("être", "../invalid"), (error) => error.code === "INVALID_WORDBOOK");
  assert.strictEqual(calls.length, 4, "invalid inputs must not make network requests");
  for (let index = 0; index < 81; index += 1) {
    await service.lookup(`mot${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`);
  }
  assert.ok(service.cache.size <= 80, "the successful-result cache must stay bounded");

  let failedCalls = 0;
  const restricted = new FrenchDictionaryService({ parseHtml: fixtureDocument, requestUrl: async () => { failedCalls += 1; return { status: 403, text: "private-token" }; } });
  await assert.rejects(restricted.lookup("belles"), (error) => error.code === "ACCESS_RESTRICTED" && !error.message.includes("private-token"));
  await assert.rejects(restricted.lookup("belles"));
  assert.strictEqual(failedCalls, 2, "failed lookups must not be cached");
  const noToken = new FrenchDictionaryService({ requestUrl: () => { throw new Error("must not request"); } });
  await assert.rejects(noToken.listWordbooks(), (error) => error.code === "AUTH_REQUIRED");
  const network = new FrenchDictionaryService({ getToken: async () => "secret", requestUrl: async () => { throw new Error("secret raw network details"); } });
  await assert.rejects(network.listWordbooks(), (error) => error.code === "NETWORK_ERROR" && !error.message.includes("secret"));
  const unauthorized = new FrenchDictionaryService({ getToken: async () => "NIS supplied", requestUrl: async (options) => { assert.strictEqual(options.headers.Authorization, "NIS supplied"); return { status: 401 }; } });
  await assert.rejects(unauthorized.listWordbooks(), (error) => error.code === "AUTH_REQUIRED");

  const stateCalls = [];
  const wordState = { word: "être", star: 1, category_ids: [0, "123"] };
  let stateResponse = { status: 200, json: wordState };
  const wordbooks = new FrenchDictionaryService({
    getToken: async () => "state-test-token",
    requestUrl: async (options) => { stateCalls.push(options); return stateResponse; },
  });
  assert.strictEqual(await wordbooks.isWordInWordbook(" être ", "123"), true);
  assert.strictEqual(stateCalls[0].url, "https://api.frdic.com/api/open/v1/studylist/word?language=fr&word=%C3%AAtre");
  assert.strictEqual(stateCalls[0].method, "GET");
  assert.strictEqual(stateCalls[0].headers.Authorization, "NIS state-test-token");
  assert.ok(!Object.hasOwn(stateCalls[0], "body"));
  assert.strictEqual(await wordbooks.isWordInWordbook("être"), true, "default category zero accepts numeric API IDs");
  assert.strictEqual(await wordbooks.isWordInWordbook("être", "456"), false, "a word in another book is not in the selected book");
  stateResponse = { status: 200, json: { ...wordState, star: 0 } };
  assert.strictEqual(await wordbooks.isWordInWordbook("être", "123"), false, "a deleted favorite is not saved even if old categories remain");
  assert.strictEqual(stateCalls.length, 4, "wordbook status must be read afresh instead of using the dictionary cache");
  for (const json of [{ data: wordState }, { data: [wordState] }]) {
    stateResponse = { status: 200, json };
    assert.strictEqual(await wordbooks.isWordInWordbook("être", 123), true, "wrapped API word responses are supported");
  }
  for (const json of [{ data: null }, { data: [] }]) {
    stateResponse = { status: 200, json };
    assert.strictEqual(await wordbooks.isWordInWordbook("être", "123"), false, "explicit empty API data means no saved word");
  }
  for (const json of [{}, { message: "unexpected error" }, { data: {} }, { data: [null] },
    { ...wordState, word: "autre" }, { ...wordState, star: undefined },
    { ...wordState, star: "bad" }, { ...wordState, category_ids: undefined },
    { ...wordState, category_ids: [{}] }]) {
    stateResponse = { status: 200, json };
    await assert.rejects(wordbooks.isWordInWordbook("être", "123"), (error) => error.code === "BAD_RESPONSE", "malformed status must not be reported as not saved");
  }
  stateResponse = { status: 404 };
  assert.strictEqual(await wordbooks.isWordInWordbook("être", "123"), false);
  await assert.rejects(wordbooks.listWordbooks(), (error) => error.code === "SERVICE_ERROR", "404 handling is limited to the single-word status read");
  await assert.rejects(wordbooks.addWord("être", "123"), (error) => error.code === "SERVICE_ERROR");
  stateResponse = { status: 401 };
  await assert.rejects(wordbooks.isWordInWordbook("être", "123"), (error) => error.code === "AUTH_REQUIRED");
  const beforeInvalidStatus = stateCalls.length;
  await assert.rejects(wordbooks.isWordInWordbook("être", "../invalid"), (error) => error.code === "INVALID_WORDBOOK");
  await assert.rejects(wordbooks.isWordInWordbook("汉字", "123"), (error) => error.code === "INVALID_QUERY");
  assert.strictEqual(stateCalls.length, beforeInvalidStatus, "invalid status inputs must not make requests");
  await assert.rejects(noToken.isWordInWordbook("être", "123"), (error) => error.code === "AUTH_REQUIRED");
  await assert.rejects(network.isWordInWordbook("être", "123"), (error) => error.code === "NETWORK_ERROR" && !error.message.includes("secret"));
  assert.ok(new FrenchDictionaryError("TEST", "测试") instanceof Error);
  console.log("French dictionary service tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
