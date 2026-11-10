const assert = require("assert");
const { decodeText, mergeText } = require("../src/project-sync/text-merge");

const bytes = (text) => Buffer.from(text);
const merged = mergeText(bytes("原文\n译文\n笔记\n"), bytes("原文\n本地译文\n笔记\n"), bytes("新原文\n译文\n笔记\n"));
assert.strictEqual(merged.clean, true, "non-overlapping local and upstream text edits must merge");
assert.strictEqual(Buffer.from(merged.content).toString(), "新原文\n本地译文\n笔记\n");
const same = mergeText(bytes("a\nb\n"), bytes("A\nb\n"), bytes("A\nb\n"));
assert.strictEqual(same.clean, true);
assert.strictEqual(Buffer.from(same.content).toString(), "A\nb\n");
const conflict = mergeText(bytes("a\nb\n"), bytes("a\nlocal\n"), bytes("a\nremote\n"));
assert.strictEqual(conflict.clean, false);
assert.strictEqual(conflict.content, null);
assert.deepStrictEqual(conflict.blocks[1].conflict.a, ["local\n"]);
assert.deepStrictEqual(conflict.blocks[1].conflict.o, ["b\n"]);
assert.deepStrictEqual(conflict.blocks[1].conflict.b, ["remote\n"]);
const deleteEdit = mergeText(bytes("a\nb\nc\n"), bytes("a\nc\n"), bytes("a\nB\nc\n"));
assert.strictEqual(deleteEdit.clean, false);
const crlf = mergeText(bytes("a\nb\nc\nd\n"), bytes("a\r\nB\r\nc\r\nd\r\n"), bytes("a\nb\nc\nD\n"));
assert.strictEqual(Buffer.from(crlf.content).toString(), "a\r\nB\r\nc\r\nD\r\n");
const noFinalNewline = mergeText(bytes("a\nb\nc"), bytes("a\nB\nc"), bytes("A\nb\nc"));
assert.strictEqual(Buffer.from(noFinalNewline.content).toString(), "A\nB\nc");
const bom = mergeText(bytes("\ufeffa\nb\nc\nd\n"), bytes("\ufeffa\nB\nc\nd\n"), bytes("\ufeffa\nb\nc\nD\n"));
assert.strictEqual(Buffer.from(bom.content).toString(), "\ufeffa\nB\nc\nD\n");
assert.strictEqual(decodeText(new Uint8Array([0xc3, 0x28])), null);
assert.strictEqual(decodeText(bytes("a\0b")), null);
assert.strictEqual(mergeText(bytes("a"), new Uint8Array([0xff]), bytes("b")).mergeable, false);
assert.strictEqual(mergeText(bytes("\n".repeat(16000)), bytes("\n".repeat(16000)), bytes("\n".repeat(16000))).mergeable, false);
const bounded = mergeText(bytes("\n".repeat(16000)), bytes("\n".repeat(16000)), bytes("\n".repeat(16000)));
assert.strictEqual(bounded.blocks[0].conflict.a.length, 1, "oversized comparisons must not allocate a line array before checking limits");
const structure = mergeText(bytes("<!-- id: s14-01-0001 -->\na\nb\n"), bytes("<!-- id: s14-01-0002 -->\na\nb\n"), bytes("<!-- id: s14-01-0001 -->\na\nB\n"));
assert.strictEqual(structure.clean, false);
assert.strictEqual(structure.reason, "segment_structure_changed");
const { buildComparison } = require("../src/project-sync/conflict-comparison");
const id = (number, body) => `<!-- id: s14-12-${number} -->\n\n${body}\n\n`;
const textFor = (result, side = "a") => result.blocks.map((block) => (block.ok || block.conflict[side]).join("")).join("");
const conflictsFor = (result) => result.blocks.filter((block) => block.conflict).map((block) => block.conflict);
const segmentBase = id("0001", "one") + id("0002", "two") + id("0003", "three");
const segmentLocal = id("0001", "local one") + id("0002", "local two") + id("0003", "three");
const segmentUpstream = id("0001", "upstream one") + id("0002", "upstream two") + id("0003", "new three");
const bySegment = mergeText(bytes(segmentBase), bytes(segmentLocal), bytes(segmentUpstream));
assert.strictEqual(conflictsFor(bySegment).length, 2, "adjacent conflicting IDs must be separate atomic conflicts");
assert.deepStrictEqual(conflictsFor(bySegment).map((hunk) => hunk.segmentIds), [["s14-12-0001"], ["s14-12-0002"]]);
assert.strictEqual(conflictsFor(bySegment)[0].a.join(""), id("0001", "local one"), "conflicts include exactly the whole logical ID paragraph");
assert.strictEqual(textFor(bySegment), segmentLocal.replace("three", "new three"), "non-conflicting upstream edits survive local conflict choices");
const missing = buildComparison({ path: "texts/lesson.md", baseBytes: null, localBytes: bytes(segmentLocal), upstreamBytes: bytes(segmentUpstream) });
assert.strictEqual(conflictsFor(missing).length, 3, "missing baselines still compare each ID separately");
assert.strictEqual(textFor(missing), segmentLocal, "default local choices reconstruct the exact local file without a baseline");
assert.ok(conflictsFor(missing).every((hunk) => hunk.segmentIds.length === 1));
const grouped = `<!-- id: s14-12-0001 -->\n<!-- ids: s14-12-0001 s14-12-0002 -->\n\nlocal merged\n\n`;
const groupedMissing = buildComparison({ path: "texts/lesson.md", baseBytes: null, localBytes: bytes(grouped + id("0003", "three")), upstreamBytes: bytes(segmentBase) });
assert.strictEqual(conflictsFor(groupedMissing).length, 1, "attached id/ids comments form one logical conflict, aligned with the split counterpart");
assert.deepStrictEqual(conflictsFor(groupedMissing)[0].segmentIds, ["s14-12-0001", "s14-12-0002"]);
assert.strictEqual(conflictsFor(groupedMissing)[0].a.join(""), grouped);
assert.strictEqual(conflictsFor(groupedMissing)[0].b.join(""), id("0001", "one") + id("0002", "two"));
assert.strictEqual(textFor(groupedMissing), grouped + id("0003", "three"));
const separated = mergeText(bytes(segmentBase), bytes(id("0001", "local one") + id("0003", "three")), bytes(id("0001", "one") + id("0002", "two") + id("0003", "upstream three") + id("0004", "four")));
assert.strictEqual(separated.clean, true, "disjoint paragraph edits, deletion, and insertion merge without whole-file conflicts");
assert.strictEqual(Buffer.from(separated.content).toString(), id("0001", "local one") + id("0003", "upstream three") + id("0004", "four"));
const plainMissing = buildComparison({ path: "notes/test.md", baseBytes: null, localBytes: bytes("local first\n\nlocal second\n\n"), upstreamBytes: bytes("remote first\n\nremote second\n\n") });
assert.strictEqual(conflictsFor(plainMissing).length, 2, "unmarked markdown falls back to paragraphs rather than a whole-file conflict");
assert.strictEqual(textFor(plainMissing), "local first\n\nlocal second\n\n");
const deleted = buildComparison({ path: "texts/lesson.md", baseBytes: bytes(segmentBase), localBytes: null, upstreamBytes: bytes(segmentUpstream) });
assert.ok(conflictsFor(deleted).length >= 1);
assert.ok(conflictsFor(deleted).every((hunk) => hunk.segmentIds.length === 1), "file deletion previews remain paragraph-sized");
const emptyDeleted = buildComparison({ path: "texts/lesson.md", baseBytes: bytes(""), localBytes: null, upstreamBytes: bytes("") });
assert.strictEqual(conflictsFor(emptyDeleted).length, 1, "an empty file and deleted file still need an explicit deletion choice");
const reverseGroup = buildComparison({ path: "texts/lesson.md", baseBytes: null, localBytes: bytes(segmentBase), upstreamBytes: bytes(grouped + id("0003", "three")) });
assert.strictEqual(textFor(reverseGroup), segmentBase);
assert.strictEqual(textFor(reverseGroup, "b"), grouped + id("0003", "three"));
const extraIds = buildComparison({ path: "texts/lesson.md", baseBytes: null,
  localBytes: bytes(id("0001", "one") + id("0003", "local three") + id("0004", "four")),
  upstreamBytes: bytes(id("0001", "one") + id("0002", "two") + id("0003", "remote three")) });
assert.strictEqual(textFor(extraIds), id("0001", "one") + id("0003", "local three") + id("0004", "four"));
assert.strictEqual(textFor(extraIds, "b"), id("0001", "one") + id("0002", "two") + id("0003", "remote three"));
const extraParagraphs = buildComparison({ path: "notes/test.md", baseBytes: null,
  localBytes: bytes("first\n\nextra\n\nlocal last\n"), upstreamBytes: bytes("first\n\nremote last\n") });
assert.strictEqual(textFor(extraParagraphs), "first\n\nextra\n\nlocal last\n");
assert.strictEqual(textFor(extraParagraphs, "b"), "first\n\nremote last\n");
const windowsParagraphs = buildComparison({ path: "notes/test.md", baseBytes: null,
  localBytes: bytes("first\r\n\r\nlocal\r\n"), upstreamBytes: bytes("first\r\n\r\nremote\r\n") });
assert.strictEqual(conflictsFor(windowsParagraphs).length, 1, "CRLF paragraph boundaries remain atomic");
assert.strictEqual(conflictsFor(windowsParagraphs)[0].a.join(""), "local\n");
const noncontiguousGroup = `<!-- ids: s14-12-0001 s14-12-0003 -->\n\nmerged\n\n`;
assert.throws(() => buildComparison({ path: "texts/lesson.md", baseBytes: null,
  localBytes: bytes(segmentBase), upstreamBytes: bytes(noncontiguousGroup + id("0002", "two")) }), /不连续.*无法安全比较/,
  "a noncontiguous IDs group must never silently reorder the local file");
assert.throws(() => buildComparison({ path: "texts/lesson.md", baseBytes: null,
  localBytes: bytes(id("0001", "one") + id("0001", "duplicate")), upstreamBytes: bytes(id("0001", "remote")) }), /重复.*无法安全比较/);
const manyUnits = Array.from({ length: 2600 }, (_, index) => id(String(index + 1).padStart(4, "0"), `paragraph ${index}`)).join("");
const largeComparison = mergeText(bytes(manyUnits), bytes(manyUnits.replace(/paragraph /g, "local ")), bytes(manyUnits.replace(/paragraph /g, "remote ")));
assert.strictEqual(largeComparison.clean, false);
assert.strictEqual(conflictsFor(largeComparison).length, 2600, "line-count limits must still preserve one conflict per ID");
const repeatedParagraphs = "same\n\n".repeat(2000);
const repeatedComparison = buildComparison({ path: "notes/test.md", baseBytes: null,
  localBytes: bytes(repeatedParagraphs), upstreamBytes: bytes(repeatedParagraphs + "extra\n") });
assert.strictEqual(textFor(repeatedComparison), repeatedParagraphs, "bounded repeated paragraph matching preserves local order");
console.log("project text merge tests passed");
