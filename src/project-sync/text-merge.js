const { diff3Merge } = require("node-diff3");
const { asBytes } = require("./validation");
const { semanticBlocks } = require("./semantic-merge");

const MAX_MERGE_BYTES = 2 * 1024 * 1024;
const MAX_MERGE_LINES = 15000;
const MAX_MATCH_PAIRS = 2000000;
const decodeText = (bytes) => {
  if (bytes === null || bytes === undefined) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(asBytes(bytes));
    return text.includes("\0") ? null : text;
  } catch { return null; }
};
const normalizeLines = (text) => text.replace(/\r\n/g, "\n");
const splitLines = (text) => normalizeLines(text).match(/[^\n]*\n|[^\n]+$/g) || [];
const tooManyLines = (text) => {
  let lines = text && !text.endsWith("\n") ? 1 : 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") lines += 1;
    if (lines > MAX_MERGE_LINES) return true;
  }
  return false;
};
const conflictLines = (text) => text.length > MAX_MERGE_BYTES || tooManyLines(text) ? [normalizeLines(text)] : splitLines(text);
const detectEol = (text) => /\r\n/.test(text || "") ? "\r\n" : "\n";
const preserveEol = (text, eol) => eol === "\r\n" ? normalizeLines(text).replace(/\n/g, "\r\n") : normalizeLines(text);
const fileConflict = (baseText, localText, upstreamText) => [{ conflict: {
  a: conflictLines(localText || ""), o: conflictLines(baseText || ""), b: conflictLines(upstreamText || ""), aIndex: 0, oIndex: 0, bIndex: 0,
} }];
const excessiveMatches = (base, local, upstream) => {
  const counts = new Map();
  for (const line of base) counts.set(line, (counts.get(line) || 0) + 1);
  let pairs = 0;
  for (const line of [...local, ...upstream]) {
    pairs += counts.get(line) || 0;
    if (pairs > MAX_MATCH_PAIRS) return true;
  }
  return false;
};
const segmentMarkers = (text) => (text.match(/<!--\s*ids?\b[\s\S]*?-->/gi) || []).join("\0");

// diff3 conservatively groups touching replacement hunks. Equal-length
// regions can still contain distinct line replacements; resolve only when
// every aligned line is unchanged on one side or changed identically.
const refineAlignedBlock = (block) => {
  const conflict = block.conflict;
  if (!conflict || conflict.a.length !== conflict.o.length || conflict.b.length !== conflict.o.length) return block;
  const lines = [];
  for (let i = 0; i < conflict.o.length; i += 1) {
    const a = conflict.a[i]; const o = conflict.o[i]; const b = conflict.b[i];
    if (a === b || b === o) lines.push(a);
    else if (a === o) lines.push(b);
    else return block;
  }
  return { ok: lines };
};

const mergeLines = (baseText, localText, upstreamText) => {
  const arrays = [localText, baseText, upstreamText].map(splitLines);
  if (excessiveMatches(arrays[1], arrays[0], arrays[2])) return fileConflict(baseText, localText, upstreamText);
  return diff3Merge(arrays[0], arrays[1], arrays[2], { excludeFalseConflicts: true }).map(refineAlignedBlock);
};

const comparisonBlocks = (baseText, localText, upstreamText, { limited = false } = {}) => {
  const [base, local, upstream] = [baseText, localText, upstreamText].map((text) => text === null ? null : normalizeLines(text));
  limited ||= [base, local, upstream].some((text) => text !== null && (text.length > MAX_MERGE_BYTES || tooManyLines(text)));
  return semanticBlocks(base, local, upstream, mergeLines, { limited }) || mergeLines(base || "", local || "", upstream || "");
};

const mergeText = (baseBytes, localBytes, upstreamBytes) => {
  const baseText = decodeText(baseBytes);
  const localText = decodeText(localBytes);
  const upstreamText = decodeText(upstreamBytes);
  const eol = detectEol(localText ?? upstreamText);
  const result = { mergeable: false, clean: false, content: null, baseText, localText, upstreamText, blocks: [], eol };
  if ([baseText, localText, upstreamText].some((text) => text === null)) return { ...result, reason: "non_text_or_missing" };
  if ([baseBytes, localBytes, upstreamBytes].some((bytes) => asBytes(bytes).byteLength > MAX_MERGE_BYTES)
    || [baseText, localText, upstreamText].some(tooManyLines)) {
    return { ...result, blocks: comparisonBlocks(baseText, localText, upstreamText, { limited: true }), reason: "text_too_complex" };
  }
  const blocks = comparisonBlocks(baseText, localText, upstreamText);
  const clean = blocks.every((block) => Array.isArray(block.ok));
  const structureChanged = segmentMarkers(localText) !== segmentMarkers(baseText) || segmentMarkers(upstreamText) !== segmentMarkers(baseText);
  return { ...result, mergeable: true, clean, blocks, ...(structureChanged ? { reason: "segment_structure_changed" } : {}),
    content: clean ? Buffer.from(preserveEol(blocks.flatMap((block) => block.ok).join(""), eol), "utf8") : null };
};

module.exports = { decodeText, mergeText, splitLines, detectEol, preserveEol, fileConflict, comparisonBlocks };
