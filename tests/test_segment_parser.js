const assert = require("assert");
const { SegmentParser } = require("../segment-ai/segment-parser");

// Retain the previous parsing rules as an independent reference for boundaries.
function referenceParse(parser, source, sourcePath) {
  const comments = parser.parseComments(source);
  const blocks = [];
  for (let index = 0; index < comments.length; index += 1) {
    const comment = comments[index];
    if (comment.label !== "id") continue;
    const attached = comments[index + 1];
    const grouped = attached && /^\s*$/.test(source.slice(comment.end, attached.start))
      && (attached.label === "ids"
        || (attached.label === "id" && attached.ids.length > 1 && attached.ids[0] === comment.ids[0]));
    const ids = parser.mergeIds(comment.ids, grouped ? attached.ids : []);
    const next = comments.slice(index + (grouped ? 2 : 1)).find((candidate) => candidate.label === "id");
    const markdown = source.slice(grouped ? attached.end : comment.end, next ? next.start : source.length).trim();
    blocks.push({
      primaryId: ids[0], ids, markdown, visibleText: parser.visibleText(markdown), sourcePath,
      startLine: parser.lineAtOffset(source, comment.start),
      endLine: next ? Math.max(parser.lineAtOffset(source, next.start) - 1, 0) : source.split(/\r?\n/).length - 1,
    });
    if (grouped) index += 1;
  }
  return blocks;
}

const parser = new SegmentParser();
const sourcePath = "texts/s8-test/original/Leçon-01.md";
for (const newline of ["\n", "\r\n", "\r"]) {
  for (const gap of ["", newline, `${newline}正文${newline}`]) {
    for (const attachment of [
      "<!-- ids: s8-01-0001 s8-01-0002 -->",
      "<!-- id: s8-01-0001 s8-01-0002 -->",
      "<!-- id: s8-01-0002 s8-01-0003 -->",
      "<!-- ids: no-valid-id -->",
    ]) {
      const source = [
        "# Préambule",
        "<!-- ids: s8-01-0099 -->",
        `<!-- ID : s8-01-0001 -->${gap}${attachment}`,
        "Texte. <!-- ids: s8-01-0088 -->",
        "<!-- id: s8-01-0004 -->正文<!-- id: s8-01-0005 -->",
        "[[notes/example|阅读笔记]]",
        "Fin.",
        "",
      ].join(newline);
      assert.deepStrictEqual(parser.parse(source, sourcePath), referenceParse(parser, source, sourcePath));
    }
  }
}
assert.deepStrictEqual(parser.parse(""), []);
assert.deepStrictEqual(parser.parse("<!-- ids: s8-01-0001 -->\nNo primary marker."), []);

const count = 12000;
const sections = [];
const expected = [];
let line = 1;
for (let index = 0; index < count; index += 1) {
  const primaryId = `s8-01-${index * 2 + 1}`;
  const ids = [primaryId];
  const marker = `<!-- id: ${primaryId} -->`;
  const group = index % 3 === 0;
  if (group) ids.push(`s8-01-${index * 2 + 2}`);
  const body = `Texte ${index}.\r\n第二行。`;
  const section = `${marker}\r\n${group ? `<!-- ids: ${ids.join(" ")} -->\r\n` : ""}${body}\r\n`;
  const startLine = line;
  line += group ? 4 : 3;
  sections.push(section);
  expected.push({ primaryId, ids, markdown: body, visibleText: body.replace(/\r\n/g, "\n"), sourcePath, startLine, endLine: line - 1 });
}
// The final segment includes the file's trailing empty line.
expected.at(-1).endLine += 1;
const largeSource = `# Large lesson\r\n${sections.join("")}`;
const largeBlocks = parser.parse(largeSource, sourcePath);
assert.strictEqual(largeBlocks.length, expected.length);
for (const [index, block] of largeBlocks.entries()) {
  assert.deepStrictEqual(block, expected[index], `large lesson segment ${index} preserves its IDs, body and line boundaries`);
}
console.log(`segment parser tests passed (${count} synthetic segments)`);
