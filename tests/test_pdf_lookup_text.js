const assert = require("assert");
const { readPdfTextLayer } = require("../src/pdf-lookup-text");
const { getFrenchWordAt } = require("../src/french-lookup-text");

function text(value) { return { nodeType: 3, textContent: value }; }
function element(tagName, className = "", ...childNodes) {
  const node = {
    nodeType: 1, tagName, className, childNodes,
    closest(selector) {
      for (let candidate = this; candidate; candidate = candidate.parentElement) {
        if (candidate.className.split(/\s+/).includes(selector.slice(1))) return candidate;
      }
      return null;
    },
  };
  for (const child of childNodes) child.parentElement = node;
  return node;
}
function read(startContainer, startOffset = 0, endContainer = startContainer) {
  return readPdfTextLayer({ startContainer, startOffset, endContainer });
}

const prefix = text("L’");
const word = text("éthique");
const suffix = text(" de la psychanalyse.");
const splitLayer = element("DIV", "textLayer", element("SPAN", "textLayerNode", prefix),
  element("SPAN", "textLayerNode", word), element("SPAN", "textLayerNode", suffix));
const splitResult = read(word, 2);
assert.deepStrictEqual(splitResult, { text: "L’éthique de la psychanalyse.", offset: 4 });
assert.strictEqual(getFrenchWordAt(splitResult.text, splitResult.offset), "L’éthique",
  "word expansion must restore an elision split across PDF spans");
assert.deepStrictEqual(read(splitLayer, 1), { text: splitResult.text, offset: 2 },
  "an element boundary counts the text of its preceding children");
assert.deepStrictEqual(read(splitLayer, 3), { text: splitResult.text, offset: splitResult.text.length });

const firstLine = text("désir");
const secondLine = text("éthique");
const lineBreak = element("BR");
const lines = element("DIV", "textLayer", element("SPAN", "", firstLine), lineBreak,
  element("SPAN", "", secondLine));
const lineResult = read(secondLine, 3);
assert.deepStrictEqual(lineResult, { text: "désir\néthique", offset: 9 });
assert.strictEqual(getFrenchWordAt(lineResult.text, lineResult.offset), "éthique",
  "line endings must stop word expansion rather than glue distinct words");
assert.deepStrictEqual(read(lines, 2), { text: "désir\néthique", offset: 6 });
assert.deepStrictEqual(read(lineBreak), { text: "désir\néthique", offset: 5 });

const highlighted = text("désir");
const skipped = text("hidden controls");
element("DIV", "textLayer", element("SPAN", "textLayerNode", element("SPAN", "highlight", highlighted)),
  element("DIV", "endOfContent", skipped), element("BUTTON", "", text("menu")));
assert.deepStrictEqual(read(highlighted, 2), { text: "désir", offset: 2 });
assert.strictEqual(read(skipped), null, "non-text UI must never become lookup context");

const opening = "Texte de la page. ".repeat(2000);
const longPageWord = text("L’éthique");
element("DIV", "textLayer", element("SPAN", "", text(opening)), element("SPAN", "", longPageWord));
assert.deepStrictEqual(read(longPageWord, 4), { text: opening + "L’éthique", offset: opening.length + 4 },
  "long-page offsets must point to the selection instead of the page opening");

const pageOneText = text("Première page");
const pageTwoText = text("Deuxième page");
element("DIV", "pdfViewer", element("DIV", "page", element("DIV", "textLayer", pageOneText)),
  element("DIV", "page", element("DIV", "textLayer", pageTwoText)));
assert.deepStrictEqual(read(pageOneText, 3, pageTwoText), { text: "Première page", offset: 3 },
  "a cross-page selection must use only its starting page for context");

const plainText = text("ordinary note");
element("P", "", plainText);
assert.strictEqual(read(plainText), null);
assert.strictEqual(readPdfTextLayer(null), null);
assert.strictEqual(read(word, -1), null);
assert.strictEqual(read(word, 999), null);
assert.strictEqual(read(splitLayer, 999), null);

console.log("PDF lookup text tests passed");
