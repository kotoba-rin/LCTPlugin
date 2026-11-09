const assert = require("assert");
const {
  captureBilingualReadingPosition,
  restoreBilingualReadingPosition,
  captureMarkdownReadingPosition,
} = require("../src/reading-position");

function lane(segmentId, top, bottom, language = "original", segmentIds = segmentId) {
  return {
    dataset: { segmentId, segmentIds, language },
    getBoundingClientRect: () => ({ top, bottom, height: bottom - top }),
  };
}

function root(lanes, { top = 100, bottom = 600, scrollTop = 700 } = {}) {
  return {
    scrollTop,
    querySelectorAll: () => lanes,
    getBoundingClientRect: () => ({ top, bottom, height: bottom - top }),
  };
}

const visible = root([
  lane("s14-12-0001", -400, -100),
  lane("s14-12-0002", -100, 80),
  lane("s14-12-0003", 80, 200),
  lane("s14-12-0004", 200, 350),
]);
assert.deepStrictEqual(captureBilingualReadingPosition(visible), {
  segmentId: "s14-12-0003",
  segmentIds: ["s14-12-0003"],
  language: "original",
}, "a paragraph crossing the viewport top remains the current reading segment");

const merged = lane("s14-12-0002", 50, 300, "translation", "s14-12-0002 s14-12-0003");
assert.deepStrictEqual(captureBilingualReadingPosition(root([
  lane("s14-12-0001", 120, 120), merged,
  lane("s14-12-0004", 300, 500, "original"),
])), {
  segmentId: "s14-12-0002",
  segmentIds: ["s14-12-0002", "s14-12-0003"],
  language: "translation",
}, "a merged translated paragraph retains all aliases and its language");
assert.strictEqual(captureBilingualReadingPosition(root([
  lane("s14-12-0001", 650, 800),
])), null, "a heading-only viewport must not invent a current paragraph");
assert.strictEqual(captureBilingualReadingPosition(root([
  lane("s14-12-0001", 200, 350),
], { scrollTop: 0 })), null, "the document top retains its title even when the first paragraph is visible");
assert.strictEqual(captureBilingualReadingPosition(null), null);

const destination = root([
  lane("s14-12-0003", 50, 200, "original"),
  lane("s14-12-0002", 350, 650, "translation", "s14-12-0002 s14-12-0003"),
]);
assert.strictEqual(restoreBilingualReadingPosition(destination, {
  segmentId: "s14-12-0003", segmentIds: ["s14-12-0003"], language: "translation",
}), true);
assert.strictEqual(destination.scrollTop, 950, "the matching translated alias takes priority over an original exact ID");

const exactFallback = root([
  lane("s14-12-0002", 250, 350, "original", "s14-12-0002 s14-12-0003"),
  lane("s14-12-0003", 450, 550, "original"),
]);
assert.strictEqual(restoreBilingualReadingPosition(exactFallback, {
  segmentId: "s14-12-0003", segmentIds: ["s14-12-0002", "s14-12-0003"], language: "translation",
}), true);
assert.strictEqual(exactFallback.scrollTop, 1050, "without the requested language, the exact paragraph ID wins over aliases");
const aliasFallback = root([
  lane("s14-12-0002", 275, 450, "translation", "s14-12-0002 s14-12-0003"),
]);
assert.strictEqual(restoreBilingualReadingPosition(aliasFallback, {
  segmentId: "s14-12-0003", segmentIds: ["s14-12-0003"], language: "original",
}), true, "a merged alias remains usable if its matching language is absent");
assert.strictEqual(aliasFallback.scrollTop, 875);
const untouched = root([lane("s14-12-0001", 200, 350)]);
assert.strictEqual(restoreBilingualReadingPosition(untouched, { segmentId: "s14-12-0099" }), false);
assert.strictEqual(untouched.scrollTop, 700, "a missing paragraph does not reset reading progress");
assert.strictEqual(restoreBilingualReadingPosition(untouched, null), false);

const blocks = [
  { primaryId: "s14-12-0001", ids: ["s14-12-0001"], startLine: 8 },
  { primaryId: "s14-12-0002", ids: ["s14-12-0002", "s14-12-0003"], startLine: 20 },
  { primaryId: "s14-12-0004", ids: ["s14-12-0004"], startLine: 40 },
];
assert.deepStrictEqual(captureMarkdownReadingPosition({ currentMode: { getScroll: () => 29.75 } }, blocks, "translation"), {
  segmentId: "s14-12-0002", segmentIds: ["s14-12-0002", "s14-12-0003"], language: "translation",
}, "a source line inside a merged paragraph maps to that block's IDs");
assert.strictEqual(captureMarkdownReadingPosition({ currentMode: { getScroll: () => 3 } }, blocks, "original"), null,
  "a title before the first segment does not force navigation to the first paragraph");
assert.strictEqual(captureMarkdownReadingPosition({ currentMode: { getScroll: () => null } }, blocks, "original"), null,
  "an uncomputed preview does not masquerade as source line zero");

let editorReads = 0;
const previewWithEditor = {
  getMode: () => "preview",
  previewMode: { getScroll: () => 45 },
  editMode: { getScroll: () => { editorReads += 1; return 8; } },
  editor: { getCursor: () => { editorReads += 1; return { line: 8 }; } },
};
assert.strictEqual(captureMarkdownReadingPosition(previewWithEditor, blocks, "original").segmentId, "s14-12-0004");
assert.strictEqual(editorReads, 0, "an existing editor must not override the visible preview's position");
assert.strictEqual(captureMarkdownReadingPosition({
  getMode: () => "source", editMode: { getScroll: () => 24 },
}, blocks, "original").segmentId, "s14-12-0002");
assert.strictEqual(captureMarkdownReadingPosition({
  currentMode: { getScroll: () => 44 }, getMode: () => "preview", previewMode: { getScroll: () => 8 },
}, blocks, "original").segmentId, "s14-12-0004", "currentMode is the authoritative visible mode");
assert.strictEqual(captureMarkdownReadingPosition({}, blocks, "original"), null);
assert.strictEqual(captureMarkdownReadingPosition({ getState: () => ({ state: { scroll: 21 } }) }, blocks, "original").segmentId,
  "s14-12-0002", "an explicit source-line scroll state is a last resort when mode APIs are unavailable");
assert.strictEqual(captureMarkdownReadingPosition({ currentMode: { getScroll: () => NaN } }, blocks, "original"), null);
const previewBoundaryBlocks = [
  { primaryId: "s14-12-0084", ids: ["s14-12-0084"], startLine: 336 },
  { primaryId: "s14-12-0085", ids: ["s14-12-0085", "s14-12-0086", "s14-12-0087"], startLine: 346 },
];
assert.strictEqual(captureMarkdownReadingPosition({ currentMode: { getScroll: () => 345.9993958 } }, previewBoundaryBlocks, "translation").segmentId,
  "s14-12-0085", "preview geometry rounding at a paragraph boundary must not select the previous segment");
assert.strictEqual(captureMarkdownReadingPosition({ currentMode: { getScroll: () => 345.75 } }, previewBoundaryBlocks, "translation").segmentId,
  "s14-12-0084", "a real fractional line before the boundary remains in the preceding segment");
assert.strictEqual(captureMarkdownReadingPosition({ currentMode: { getScroll: () => 44 } }, [], "original"), null);

console.log("reading position tests passed");
