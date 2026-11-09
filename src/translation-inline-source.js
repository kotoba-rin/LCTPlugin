const { SegmentParser } = require("../segment-ai/segment-parser");

const parser = new SegmentParser();
const FOOTNOTE_RE = /^ {0,3}\[\^([^\]\n]+)\]:[^\n]*(?:\r?\n(?:[ \t]*\r?\n)*(?: {2,}|\t)[^\n]*)*/gm;
const NOTE_LINK_RE = /^[ \t]*(?:\[\[\s*notes\/[^\]\n]+\]\]|\[阅读笔记\]\([^\n)]+\))[ \t]*$/gm;
const SEPARATOR_RE = /^(?:[ \t]*)(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;

function editError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function logicalMarkers(source) {
  const comments = parser.parseComments(source);
  const markers = [];
  for (let index = 0; index < comments.length; index += 1) {
    const comment = comments[index];
    const attached = comments[index + 1];
    const attachedGroup = comment.label === "id" && attached
      && /^\s*$/.test(source.slice(comment.end, attached.start))
      && (attached.label === "ids" || (attached.label === "id" && attached.ids.length > 1 && attached.ids[0] === comment.ids[0]));
    markers.push({
      primaryId: comment.ids[0],
      ids: parser.mergeIds(comment.ids, attachedGroup ? attached.ids : []),
      start: comment.start,
      end: attachedGroup ? attached.end : comment.end,
    });
    if (attachedGroup) index += 1;
  }
  return markers;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.sort((left, right) => left.start - right.start)) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function protectedRanges(markdown) {
  const ranges = [];
  const addMatches = (regex) => {
    for (const match of markdown.matchAll(regex)) ranges.push({ start: match.index, end: match.index + match[0].length });
  };
  addMatches(/<!--\s*untranslated\s*-->/gi);
  addMatches(FOOTNOTE_RE);
  addMatches(NOTE_LINK_RE);
  let merged = mergeRanges(ranges);
  const withoutProtected = (start, end) => {
    let cursor = start;
    let visible = "";
    for (const range of merged) {
      if (range.end <= start || range.start >= end) continue;
      visible += markdown.slice(cursor, Math.max(cursor, range.start));
      cursor = Math.max(cursor, Math.min(end, range.end));
    }
    return visible + markdown.slice(cursor, end);
  };
  // Footnote sections belong to the lesson, including the final Notes heading
  // which some source files glue directly to the final sentence.
  for (const match of markdown.matchAll(/#{1,6}[ \t]+(?:Notes|注释|脚注)[ \t]*#*[ \t]*(?=\r?\n|$)/gi)) {
    if (FOOTNOTE_RE.test(markdown.slice(match.index)) && !withoutProtected(match.index + match[0].length, markdown.length).trim()) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
    FOOTNOTE_RE.lastIndex = 0;
  }
  merged = mergeRanges(ranges);
  const tail = withoutProtected(0, markdown.length).trimEnd();
  const lastLine = tail.slice(tail.lastIndexOf("\n") + 1);
  if (SEPARATOR_RE.test(lastLine)) {
    // Locate the last visible separator in the original string.
    const candidates = Array.from(markdown.matchAll(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*\r?$/gm));
    const separator = candidates.reverse().find((match) => !withoutProtected(match.index + match[0].length, markdown.length).trim());
    if (separator) ranges.push({ start: separator.index, end: separator.index + separator[0].length });
  }
  return mergeRanges(ranges);
}

function readTranslationSegment(text, requestedId) {
  const source = String(text || "");
  const normalizedId = parser.normalizeId(requestedId);
  const markers = logicalMarkers(source);
  const matches = markers.filter((marker) => marker.ids.includes(normalizedId));
  if (matches.length !== 1) {
    throw editError(matches.length ? "TranslationSegmentConflict" : "TranslationSegmentMissing", matches.length
      ? `分段 ID ${normalizedId} 对应多个段落，无法安全编辑。`
      : `找不到译文分段：${normalizedId}`);
  }
  const marker = matches[0];
  for (const id of marker.ids) {
    if (markers.filter((candidate) => candidate.ids.includes(id)).length !== 1) {
      throw editError("TranslationSegmentConflict", `分段 ID ${id} 对应多个段落，无法安全编辑。`);
    }
  }
  const contentEnd = markers[markers.indexOf(marker) + 1]?.start ?? source.length;
  const content = source.slice(marker.end, contentEnd);
  const ranges = protectedRanges(content);
  const bodyRanges = [];
  const addBody = (start, end) => {
    const raw = content.slice(start, end);
    const trimmed = raw.trim();
    if (!trimmed) return;
    const offset = raw.indexOf(trimmed);
    const absoluteStart = marker.end + start + offset;
    const absoluteEnd = absoluteStart + trimmed.length;
    bodyRanges.push({
      start: absoluteStart,
      end: absoluteEnd,
      startLine: parser.lineAtOffset(source, absoluteStart),
      endLine: parser.lineAtOffset(source, absoluteEnd),
    });
  };
  let cursor = 0;
  for (const range of ranges) {
    addBody(cursor, range.start);
    cursor = range.end;
  }
  addBody(cursor, content.length);
  const markdown = bodyRanges.map(({ start, end }) => source.slice(start, end).replace(/\r\n/g, "\n")).join("\n\n");
  return {
    requestedId: normalizedId,
    primaryId: marker.primaryId,
    ids: [...marker.ids],
    markerStart: marker.start,
    markerEnd: marker.end,
    markerText: source.slice(marker.start, marker.end),
    contentStart: marker.end,
    contentEnd,
    startLine: bodyRanges[0]?.startLine ?? parser.lineAtOffset(source, marker.end),
    endLine: bodyRanges[bodyRanges.length - 1]?.endLine ?? parser.lineAtOffset(source, marker.end),
    bodyRanges,
    markdown,
  };
}

function lineMatches(original, replacement) {
  const before = original.split("\n");
  const after = replacement.split("\n");
  // Typical segments have only a few lines. Bound the matrix for unusually
  // long source blocks; prefix/suffix lines still anchor their structural helpers.
  if (before.length * after.length > 250000) {
    const pairs = [];
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) pairs.push([start, start++]);
    let left = before.length - 1;
    let right = after.length - 1;
    while (left >= start && right >= start && before[left] === after[right]) pairs.push([left--, right--]);
    return pairs.sort((leftPair, rightPair) => leftPair[0] - rightPair[0]);
  }
  const rows = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      rows[left][right] = before[left] === after[right]
        ? rows[left + 1][right + 1] + 1
        : Math.max(rows[left + 1][right], rows[left][right + 1]);
    }
  }
  const pairs = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) pairs.push([left++, right++]);
    else if (rows[left + 1][right] >= rows[left][right + 1]) left += 1;
    else right += 1;
  }
  return pairs;
}

function mappedGap(original, replacement, oldStart, pairs) {
  const beforeLines = original.split("\n");
  const afterLines = replacement.split("\n");
  const beforeLine = original.slice(0, oldStart).split("\n").length - 1;
  let nextLine = beforeLine + 1;
  while (nextLine < beforeLines.length && !beforeLines[nextLine].trim()) nextLine += 1;
  const nextPair = pairs.find(([line]) => line >= nextLine && beforeLines[line].trim());
  const priorPair = pairs.find(([line]) => line === beforeLine && beforeLines[line].trim());
  let offset = replacement.length;
  if (priorPair) offset = afterLines.slice(0, priorPair[1]).reduce((sum, line) => sum + line.length + 1, 0) + afterLines[priorPair[1]].length;
  else if (nextPair) offset = afterLines.slice(0, nextPair[1]).reduce((sum, line) => sum + line.length + 1, 0);
  let start = offset;
  let end = offset;
  while (start > 0 && /\s/.test(replacement[start - 1])) start -= 1;
  while (end < replacement.length && /\s/.test(replacement[end])) end += 1;
  return { start, end };
}

function replaceTranslationSegment(text, snapshot, replacementMarkdown) {
  const source = String(text || "");
  if (!snapshot || !Array.isArray(snapshot.ids) || !snapshot.ids.length) {
    throw editError("InvalidTranslationSnapshot", "缺少译文编辑的原始段落。请重新打开编辑。");
  }
  const current = readTranslationSegment(source, snapshot.primaryId);
  if (current.markdown !== snapshot.markdown || current.markerText !== snapshot.markerText
      || current.ids.join(" ") !== snapshot.ids.join(" ")) {
    throw editError("TranslationEditConflict", "译文、注释、建言或分段 ID 已发生变化。请保留当前编辑内容，重新加载后再保存。");
  }
  const replacement = String(replacementMarkdown ?? "").replace(/\r\n/g, "\n").trim();
  if (/<!--\s*(?:ids?\b|untranslated\b)/i.test(replacement)
      || /^ {0,3}\[\^[^\]\n]+\]:/m.test(replacement)
      || Array.from(replacement.matchAll(NOTE_LINK_RE)).length) {
    throw editError("InvalidTranslationEdit", "请勿在段落内容中加入分段 ID、未翻译标记、全章脚注定义或阅读笔记链接。");
  }
  if (replacement === current.markdown) return source;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const bodyRanges = current.bodyRanges;
  if (!bodyRanges.length) {
    const content = source.slice(current.contentStart, current.contentEnd);
    const insertion = replacement.replace(/\n/g, newline);
    let inserted = false;
    let updated = content.replace(/<!--\s*untranslated\s*-->/gi, () => {
      const value = inserted ? "" : insertion;
      inserted = true;
      return value;
    });
    if (!inserted) {
      const leading = /^\s*/.exec(content)[0];
      updated = `${leading || newline + newline}${insertion}${newline}${newline}${content.slice(leading.length)}`;
    }
    return source.slice(0, current.contentStart) + updated + source.slice(current.contentEnd);
  }
  const pairs = lineMatches(current.markdown, replacement);
  const gaps = [];
  let oldOffset = 0;
  for (let index = 0; index < bodyRanges.length - 1; index += 1) {
    const range = bodyRanges[index];
    const next = bodyRanges[index + 1];
    oldOffset += source.slice(range.start, range.end).replace(/\r\n/g, "\n").length;
    const mapped = mappedGap(current.markdown, replacement, oldOffset, pairs);
    gaps.push({ ...mapped, text: source.slice(range.end, next.start).replace(/\r\n/g, "\n") });
    oldOffset += 2;
  }
  // Structural helper links may share an anchor after a wholesale rewrite.
  // Keep their original order without duplicating any edited paragraph content.
  let edited = "";
  let cursor = 0;
  for (const gap of gaps) {
    const start = Math.max(cursor, gap.start);
    edited += replacement.slice(cursor, start) + gap.text;
    cursor = Math.max(cursor, gap.end);
  }
  edited += replacement.slice(cursor);
  let prefix = source.slice(0, bodyRanges[0].start);
  if (replacement) prefix = prefix.replace(/<!--\s*untranslated\s*-->/gi, (match, offset) => offset >= current.contentStart ? "" : match);
  return prefix + edited.replace(/\n/g, newline) + source.slice(bodyRanges[bodyRanges.length - 1].end);
}

module.exports = { readTranslationSegment, replaceTranslationSegment };
