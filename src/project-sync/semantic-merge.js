const { diffComm } = require("node-diff3");
const { SegmentParser } = require("../../segment-ai/segment-parser");

const parser = new SegmentParser();
const lines = (text) => {
  if (text.length > 2 * 1024 * 1024) return [text];
  let count = 0;
  for (let index = 0; index < text.length; index += 1) if (text[index] === "\n" && ++count > 15000) return [text];
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
};
const markerText = (text) => (text.match(/<!--\s*ids?\b[\s\S]*?-->/gi) || []).join("\0");
const paragraphs = (text) => text.match(/[\s\S]+?(?:\n[ \t]*\n+|$)/g) || [];

function splitSegments(text) {
  const comments = parser.parseComments(text);
  const markers = [];
  for (let index = 0; index < comments.length; index += 1) {
    const current = comments[index];
    const next = comments[index + 1];
    const attached = current.label === "id" && next && /^\s*$/.test(text.slice(current.end, next.start))
      && (next.label === "ids" || (next.label === "id" && next.ids.length > 1 && next.ids[0] === current.ids[0]));
    markers.push({ ids: parser.mergeIds(current.ids, attached ? next.ids : []), start: current.start });
    if (attached) index += 1;
  }
  let line = 0;
  let cursor = 0;
  const units = markers.map((marker, index) => {
    for (; cursor < marker.start; cursor += 1) if (text[cursor] === "\n") line += 1;
    return { ids: marker.ids, line, text: text.slice(marker.start, markers[index + 1]?.start ?? text.length) };
  });
  return { header: text.slice(0, markers[0]?.start ?? text.length), units };
}

function conflict(base, local, upstream, metadata = {}) {
  return { conflict: { a: lines(local), o: lines(base), b: lines(upstream), aIndex: 0, oIndex: 0, bIndex: 0, ...metadata } };
}

// With no trustworthy base, only identical paragraphs can be accepted without
// asking. Pair changed paragraphs separately so a README is never one hunk.
function twoWayParagraphs(local, upstream, label = "段落", limited = false) {
  const result = [];
  let number = 0;
  const left = paragraphs(local); const right = paragraphs(upstream);
  const counts = new Map();
  for (const value of left) counts.set(value, (counts.get(value) || 0) + 1);
  let pairs = 0;
  for (const value of right) pairs += counts.get(value) || 0;
  const parts = limited || pairs > 2000000 ? [{ buffer1: left, buffer2: right }] : diffComm(left, right);
  for (const part of parts) {
    if (part.common) { result.push({ ok: lines(part.common.join("")) }); continue; }
    const a = part.buffer1 || []; const b = part.buffer2 || [];
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      number += 1;
      result.push(conflict("", a[index] || "", b[index] || "", { label: `${label} ${number}` }));
    }
  }
  return result;
}

function boundedParagraphs(base, local, upstream, label = "段落") {
  const versions = [base, local, upstream].map((text) => paragraphs(text || ""));
  return Array.from({ length: Math.max(1, ...versions.map((version) => version.length)) }, (_, index) =>
    conflict(versions[0][index] || "", versions[1][index] || "", versions[2][index] || "", { label: `${label} ${index + 1}` }));
}

function insertMissing(primary, secondary) {
  const seen = new Set(primary);
  const buckets = new Map();
  let anchor = null;
  for (let index = secondary.length - 1; index >= 0; index -= 1) {
    const key = secondary[index];
    if (seen.has(key)) { anchor = key; continue; }
    const values = buckets.get(anchor) || [];
    values.push(key);
    buckets.set(anchor, values);
  }
  const result = [];
  for (const key of primary) result.push(...(buckets.get(key) || []).reverse(), key);
  result.push(...(buckets.get(null) || []).reverse());
  return result;
}

function semanticBlocks(baseText, localText, upstreamText, mergeLines, { limited = false } = {}) {
  const hasBase = baseText !== null;
  const parsed = [baseText, localText, upstreamText].map((text) => splitSegments(text || ""));
  if (!parsed.some((document) => document.units.length)) {
    if (hasBase && localText !== null && upstreamText !== null && !limited) return null;
    if (limited) return boundedParagraphs(baseText, localText, upstreamText);
    const blocks = twoWayParagraphs(localText || "", upstreamText || "");
    return blocks.length ? blocks : [conflict(baseText || "", localText || "", upstreamText || "", { label: "文件状态" })];
  }
  // IDs connected by any ids paragraph are indivisible in every version.
  // This also aligns a merged paragraph with its older, split counterpart.
  const parents = new Map();
  const find = (id) => {
    if (!parents.has(id)) parents.set(id, id);
    let root = id;
    while (parents.get(root) !== root) root = parents.get(root);
    while (parents.get(id) !== id) { const next = parents.get(id); parents.set(id, root); id = next; }
    return root;
  };
  for (const document of parsed) for (const unit of document.units) {
    for (const id of unit.ids) parents.set(find(id), find(unit.ids[0]));
  }
  const ids = new Map();
  for (const id of parents.keys()) {
    const key = find(id);
    const group = ids.get(key) || [];
    group.push(id);
    ids.set(key, group);
  }
  const documents = parsed.map((document) => {
    const groups = new Map();
    const order = [];
    const seenIds = new Set();
    let previousKey = null;
    for (const unit of document.units) {
      for (const id of unit.ids) {
        if (seenIds.has(id)) throw new Error(`分段 ID ${id} 重复，无法安全比较。请先检查分段标记。`);
        seenIds.add(id);
      }
      const key = find(unit.ids[0]);
      if (groups.has(key) && previousKey !== key) throw new Error(`ids 对齐组 ${ids.get(key).join(" ")} 在文件中不连续，无法安全比较。请先检查 ids 和分段顺序。`);
      if (!groups.has(key)) { groups.set(key, { text: "", line: unit.line }); order.push(key); }
      groups.get(key).text += unit.text;
      previousKey = key;
    }
    return { groups, order };
  });
  const [base, local, upstream] = documents;
  // A one-sided reorder is safe by ID. For competing structural changes use
  // local ordering, then anchor new upstream paragraphs beside shared IDs.
  const preferred = hasBase && local.order.join("\0") === base.order.join("\0") ? upstream.order : local.order;
  const order = insertMissing(insertMissing(preferred, preferred === local.order ? upstream.order : local.order), base.order);
  const blocks = [];
  const headerBase = parsed[0].header; const headerLocal = parsed[1].header; const headerUpstream = parsed[2].header;
  if (limited && (headerBase || headerLocal || headerUpstream)) blocks.push(...boundedParagraphs(headerBase, headerLocal, headerUpstream, "文件头部"));
  else if (limited) { /* Empty headers have nothing to compare. */ }
  else if (!hasBase || localText === null || upstreamText === null) blocks.push(...twoWayParagraphs(headerLocal, headerUpstream, "文件头部"));
  else blocks.push(...mergeLines(headerBase, headerLocal, headerUpstream).map((block) => block.conflict
    ? { conflict: { ...block.conflict, label: "文件头部" } } : block));
  for (const key of order) {
    const o = base.groups.get(key); const a = local.groups.get(key); const b = upstream.groups.get(key);
    const original = o?.text || ""; const left = a?.text || ""; const right = b?.text || "";
    if (left === right) { if (left) blocks.push({ ok: lines(left) }); continue; }
    if (hasBase && localText !== null && upstreamText !== null) {
      if (right === original) { if (left) blocks.push({ ok: lines(left) }); continue; }
      if (left === original) { if (right) blocks.push({ ok: lines(right) }); continue; }
      if (!limited && markerText(left) === markerText(original) && markerText(right) === markerText(original)) {
        const merged = mergeLines(original, left, right);
        if (merged.every((block) => block.ok)) { blocks.push({ ok: merged.flatMap((block) => block.ok) }); continue; }
      }
    }
    blocks.push(conflict(original, left, right, {
      segmentIds: ids.get(key), aIndex: a?.line ?? 0, oIndex: o?.line ?? 0, bIndex: b?.line ?? 0,
    }));
  }
  return blocks.length ? blocks : [conflict(baseText || "", localText || "", upstreamText || "", { label: "文件状态" })];
}

module.exports = { semanticBlocks };
