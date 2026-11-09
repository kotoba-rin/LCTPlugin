const assert = require("assert");
const {
  readTranslationSegment,
  replaceTranslationSegment,
} = require("../src/translation-inline-source");

const editableGroup = [
  "合并的**译文**，保留 $a+b$ 和 [^1]。", "", "第二自然段。", "",
  "> [注1] 注释内容。", "> 注释续行。", "",
  "> <!-- 建言 -->", "> 独立的建言。",
].join("\n");
const group = [
  "---", "translation_progress: 80", "---", "# 测试课", "",
  "<!-- id: s8-01-0001 -->", "", "前一段。", "",
  "<!-- id: s8-01-0002 -->", "<!-- ids: s8-01-0002 s8-01-0003 -->", "",
  editableGroup, "",
  "[[notes/Leçon-01#s8-01-0002|阅读笔记]]", "",
  "<!-- id: s8-01-0004 -->", "", "后一段。", "", "---", "", "## Notes", "",
  "[^1]: 文件脚注。", "    脚注续行。", "",
].join("\n");

const snapshot = readTranslationSegment(group, "s8-01-0003");
assert.deepStrictEqual(snapshot.ids, ["s8-01-0002", "s8-01-0003"]);
assert.strictEqual(snapshot.primaryId, "s8-01-0002");
assert.strictEqual(snapshot.markdown, editableGroup, "editing a grouped paragraph includes its complete annotations and commentary");
assert.strictEqual(group.slice(snapshot.bodyRanges[0].start, snapshot.bodyRanges[0].end), editableGroup);
assert.strictEqual(snapshot.startLine, 12);
assert.strictEqual(snapshot.endLine, 20);
assert.strictEqual(replaceTranslationSegment(group, snapshot, snapshot.markdown), group, "a no-op must preserve source byte for byte");

const revised = "整段已修改，仍是 $a+b$ [^1]。\n\n重新编辑的另一自然段。\n\n> [注1] 修改后的注释。\n\n> <!-- 建言 -->\n> 修改后的建言。\n\n> [注2] 新增注释。";
const updated = replaceTranslationSegment(group, snapshot, revised);
assert.strictEqual(updated, group.replace(editableGroup, revised), "main text, annotations and commentary are replaced together exactly once");
assert.strictEqual((updated.match(/新增注释。/g) || []).length, 1);
for (const unchanged of ["<!-- ids: s8-01-0002 s8-01-0003 -->", "[[notes/Leçon-01#s8-01-0002|阅读笔记]]", "[^1]: 文件脚注。\n    脚注续行。"]) {
  assert.ok(updated.includes(unchanged));
}
assert.ok(!updated.includes("独立的建言。"));
assert.strictEqual(readTranslationSegment(updated, "s8-01-0002").markdown, revised);
assert.strictEqual(readTranslationSegment(group, "s8-01-0004").markdown, "后一段。");

const concurrentOtherParagraph = group.replace("前一段。", "其他人修改的前段。");
assert.strictEqual(replaceTranslationSegment(concurrentOtherParagraph, snapshot, revised), concurrentOtherParagraph.replace(editableGroup, revised), "other paragraphs' edits survive");
for (const changed of [
  group.replace("第二自然段。", "有人修改正文。"),
  group.replace("注释内容。", "有人修改注释。"),
  group.replace("独立的建言。", "有人修改建言。"),
  group.replace("s8-01-0003 -->", "s8-01-0005 -->"),
]) {
  assert.throws(() => replaceTranslationSegment(changed, snapshot, revised), (error) => error.code === "TranslationEditConflict");
}
assert.throws(() => readTranslationSegment(group + "\n<!-- id: s8-01-0003 -->\n重复。", "s8-01-0002"), /对应多个段落/);
assert.throws(() => readTranslationSegment(group, "s8-01-9999"), /找不到/);
for (const insertion of ["新文\n<!-- id: s8-01-0009 -->", "<!-- ids: s8-01-0010 s8-01-0011 -->", "<!-- untranslated -->", "[^n]: 加入脚注", "[[notes/other|阅读笔记]]"]) {
  assert.throws(() => replaceTranslationSegment(group, snapshot, insertion), (error) => error.code === "InvalidTranslationEdit");
}

const plain = "<!-- id: s8-01-0001 -->\n\n原有正文。\n\n<!-- id: s8-01-0002 -->\n\n后一段。";
const plainSnapshot = readTranslationSegment(plain, "s8-01-0001");
const addedAnnotations = "原有正文。\n\n> [注] 新增注释，含 $a+b$。\n\n> <!-- 建言 -->\n> 新增建言。";
const withAnnotations = replaceTranslationSegment(plain, plainSnapshot, addedAnnotations);
assert.strictEqual(withAnnotations, plain.replace("原有正文。", addedAnnotations), "notes and commentary can be added to a plain paragraph");
const annotatedSnapshot = readTranslationSegment(withAnnotations, "s8-01-0001");
assert.strictEqual(annotatedSnapshot.markdown, addedAnnotations);
const withoutAnnotations = replaceTranslationSegment(withAnnotations, annotatedSnapshot, "只保留正文。");
assert.strictEqual(withoutAnnotations, plain.replace("原有正文。", "只保留正文。"), "deleting annotations removes them from the source rather than restoring them");
assert.ok(!withoutAnnotations.includes("建言"));

const notesOnlyContent = "> [注] 没有正文的注释。\n\n> <!-- 建言 -->\n> 没有正文的建言。";
const notesOnly = `<!-- id: s8-01-0001 -->\n\n${notesOnlyContent}\n\n<!-- id: s8-01-0002 -->\n\n后段。`;
const notesOnlySnapshot = readTranslationSegment(notesOnly, "s8-01-0001");
assert.strictEqual(notesOnlySnapshot.markdown, notesOnlyContent, "annotations-only segments remain editable");
const notesOnlyRevision = notesOnlyContent.replace("没有正文的注释。", "已修改注释。").replace("没有正文的建言。", "已修改建言。");
assert.strictEqual(replaceTranslationSegment(notesOnly, notesOnlySnapshot, notesOnlyRevision), notesOnly.replace(notesOnlyContent, notesOnlyRevision));
const deletedNotesOnly = replaceTranslationSegment(notesOnly, notesOnlySnapshot, "");
assert.strictEqual(deletedNotesOnly, notesOnly.replace(notesOnlyContent, ""));
assert.strictEqual(readTranslationSegment(deletedNotesOnly, "s8-01-0001").markdown, "", "deleting all notes leaves no hidden content to reinsert");
assert.strictEqual(replaceTranslationSegment(deletedNotesOnly, readTranslationSegment(deletedNotesOnly, "s8-01-0001"), ""), deletedNotesOnly);

const repeated = "<!-- id: s8-06-0058 -->\n<!-- id: s8-06-0058 s8-06-0059 -->\n\n重复主 ID 组成一段。\n\n<!-- id: s8-06-0060 -->\n\n后段。";
const repeatedSnapshot = readTranslationSegment(repeated, "s8-06-0059");
assert.deepStrictEqual(repeatedSnapshot.ids, ["s8-06-0058", "s8-06-0059"]);
const repeatedEdit = "新合并段。\n\n> [注] 整组合并的注释。";
assert.strictEqual(replaceTranslationSegment(repeated, repeatedSnapshot, repeatedEdit), repeated.replace("重复主 ID 组成一段。", repeatedEdit));

const standalone = "<!-- ids: s8-01-0002 s8-01-0003 -->\n\n只有多 ID 的段落。\n\n<!-- id: s8-01-0004 -->\n\n后段。";
const standaloneSnapshot = readTranslationSegment(standalone, "s8-01-0003");
assert.strictEqual(standaloneSnapshot.markdown, "只有多 ID 的段落。");
assert.strictEqual(replaceTranslationSegment(standalone, standaloneSnapshot, "新段。"), standalone.replace("只有多 ID 的段落。", "新段。"));

const windows = group.replace(/\n/g, "\r\n");
const windowsSnapshot = readTranslationSegment(windows, "s8-01-0003");
assert.strictEqual(windowsSnapshot.markdown, editableGroup);
assert.strictEqual(replaceTranslationSegment(windows, windowsSnapshot, revised), windows.replace(editableGroup.replace(/\n/g, "\r\n"), revised.replace(/\n/g, "\r\n")), "CRLF and structural boundaries remain unchanged");
assert.strictEqual(replaceTranslationSegment(windows, windowsSnapshot, windowsSnapshot.markdown), windows);

const interleavedContent = "第一部分。\n\n> [注] 第一条。\n\n第二部分。\n\n> <!-- 建言 -->\n> 第二条。\n\n第三部分。";
const interleaved = `<!-- id: s8-01-0001 -->\n\n${interleavedContent}\n\n<!-- id: s8-01-0002 -->\n\n下一段。`;
const interleavedSnapshot = readTranslationSegment(interleaved, "s8-01-0001");
assert.strictEqual(interleavedSnapshot.markdown, interleavedContent);
const interleavedRevision = interleavedContent.replace("第一条。", "第一条改写。").replace("第二部分。", "修改的第二部分。").replace("> <!-- 建言 -->\n> 第二条。\n\n", "");
assert.strictEqual(replaceTranslationSegment(interleaved, interleavedSnapshot, interleavedRevision), interleaved.replace(interleavedContent, interleavedRevision));
const wholesale = replaceTranslationSegment(interleaved, interleavedSnapshot, "全部重写。");
assert.strictEqual(wholesale, interleaved.replace(interleavedContent, "全部重写。"), "old notes and commentary are not reinserted after replacing the full content");

const helperGap = "<!-- id: s8-01-0001 -->\n<!-- ids: s8-01-0001 s8-01-0002 -->\n\n第一部分。\n\n> [注] 首段注释。\n\n[[notes/Leçon-01|阅读笔记]]\n\n第二部分。\n\n> <!-- 建言 -->\n> 尾段建言。\n\n<!-- id: s8-01-0003 -->\n\n后段。";
const helperSnapshot = readTranslationSegment(helperGap, "s8-01-0002");
assert.strictEqual(helperSnapshot.bodyRanges.length, 2, "only a structural helper splits the editable source ranges");
assert.ok(helperSnapshot.markdown.includes("首段注释。"));
assert.ok(helperSnapshot.markdown.includes("尾段建言。"));
assert.ok(!helperSnapshot.markdown.includes("阅读笔记"));
const helperRevised = helperSnapshot.markdown.replace("首段注释。", "改写首段注释。").replace("尾段建言。", "改写尾段建言。");
assert.strictEqual(replaceTranslationSegment(helperGap, helperSnapshot, helperRevised), helperGap.replace("首段注释。", "改写首段注释。").replace("尾段建言。", "改写尾段建言。"));
assert.strictEqual(replaceTranslationSegment(helperGap, helperSnapshot, helperSnapshot.markdown), helperGap);

const comments = "<!-- id: s8-01-0001 -->\n\n正文。\n\n<!-- 说明 -->\n\n> <!-- 建言 -->\n> 可修改内容。";
const commentSnapshot = readTranslationSegment(comments, "s8-01-0001");
assert.ok(commentSnapshot.markdown.includes("<!-- 说明 -->"));
const commentRevision = commentSnapshot.markdown.replace("说明", "修改说明").replace("可修改内容", "已修改内容");
assert.strictEqual(replaceTranslationSegment(comments, commentSnapshot, commentRevision), comments.replace("说明", "修改说明").replace("可修改内容", "已修改内容"));

const untranslated = "<!-- id: s8-01-0001 -->\n\n<!-- untranslated -->\n\n<!-- id: s8-01-0002 -->\n\n后段。";
const emptySnapshot = readTranslationSegment(untranslated, "s8-01-0001");
assert.strictEqual(emptySnapshot.markdown, "");
const newTranslation = "新增译文。\n\n> [注] 翻译时添加的注释。\n\n> <!-- 建言 -->\n> 翻译时添加的建言。";
const filled = replaceTranslationSegment(untranslated, emptySnapshot, newTranslation);
assert.strictEqual(filled, untranslated.replace("<!-- untranslated -->", newTranslation));
assert.ok(!filled.includes("<!-- untranslated -->"));
assert.strictEqual(readTranslationSegment(filled, "s8-01-0001").markdown, newTranslation);
const gluedNotes = "<!-- id: s8-01-0001 -->\n\n末句。## Notes\n\n[^1]: 课后脚注。\n";
assert.strictEqual(readTranslationSegment(gluedNotes, "s8-01-0001").markdown, "末句。");
console.log("translation inline source tests passed");
