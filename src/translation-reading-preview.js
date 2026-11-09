const { SegmentParser } = require("../segment-ai/segment-parser");
const { readTranslationSegment } = require("./translation-inline-source");

const bindings = new WeakMap();
const sourceIndexes = new Map();
const EXCLUDED_TARGETS = [
  "a", "button", "input", "textarea", "select", "h1", "h2", "h3", "h4", "h5", "h6",
  "[contenteditable='true']", ".cm-editor", ".markdown-source-view",
  ".internal-embed", ".markdown-embed", ".footnotes", ".footnote-ref", ".footnote-backref",
  ".lacan-bilingual-view", ".lacan-bilingual-content", ".lacan-translation-inline-editor",
  ".lacan-segment-ai-control", ".lacan-segment-note-actions",
  ".lacan-segment-preview-popover", ".lacan-french-lookup",
].join(", ");

function asElement(node) {
  return node?.nodeType === 3 ? node.parentElement : node;
}

function sectionInfo(context, element) {
  try {
    const info = context?.getSectionInfo?.(element);
    if (typeof info?.text !== "string" || !Number.isInteger(info.lineStart) || !Number.isInteger(info.lineEnd)) return null;
    if (info.lineStart < 0 || info.lineEnd < info.lineStart) return null;
    return info;
  } catch (_) {
    return null;
  }
}

function sourceIndex(source, sourcePath) {
  const cached = sourceIndexes.get(sourcePath);
  if (cached?.source === source) return cached.comments;
  const comments = new SegmentParser().parseComments(source);
  let offset = 0;
  let line = 0;
  for (const comment of comments) {
    while (offset < comment.start) {
      if (source.charCodeAt(offset) === 10) line += 1;
      offset += 1;
    }
    comment.line = line;
  }
  sourceIndexes.delete(sourcePath);
  sourceIndexes.set(sourcePath, { source, comments });
  if (sourceIndexes.size > 4) sourceIndexes.delete(sourceIndexes.keys().next().value);
  return comments;
}

function intersectsBody(info, snapshot) {
  return snapshot.bodyRanges.some((range) => range.startLine <= info.lineEnd && range.endLine >= info.lineStart);
}

function resolveSnapshot(info, sourcePath, readSegment) {
  const comments = sourceIndex(info.text, sourcePath);
  const snapshots = new Map();
  for (let index = 0; index < comments.length; index += 1) {
    const comment = comments[index];
    if (comment.line > info.lineEnd) break;
    if (comments[index + 1]?.line < info.lineStart) continue;
    let snapshot;
    try {
      snapshot = readSegment(info.text, comment.ids[0]);
    } catch (_) {
      continue;
    }
    if (snapshot?.bodyRanges?.length && intersectsBody(info, snapshot)) snapshots.set(snapshot.primaryId, snapshot);
  }
  return snapshots.size === 1 ? snapshots.values().next().value : null;
}

function renderedBlock(element) {
  return element?.closest?.(".markdown-preview-section > div") || element;
}

function collectRenderedElements(element, context, snapshot, sourceText) {
  const root = renderedBlock(element);
  const siblings = Array.from(root?.parentElement?.children || [root]);
  const included = siblings.filter((candidate) => {
    if (!candidate || candidate.matches?.(EXCLUDED_TARGETS) || candidate.closest?.(".lacan-bilingual-view, .markdown-source-view")) return false;
    const info = sectionInfo(context, candidate);
    return info?.text === sourceText && intersectsBody(info, snapshot);
  });
  return included.length ? included : [element];
}

function locateTranslationPreviewTarget(event, element, context, { sourcePath, readSegment = readTranslationSegment } = {}) {
  if (!/^texts\/[^/]+\/translation\/[^/]+\.md$/i.test(String(sourcePath || ""))) return null;
  if (event.button !== undefined && event.button !== 0) return null;
  const target = asElement(event.target);
  if (!target || !element?.contains?.(target) || target.closest?.(EXCLUDED_TARGETS)) return null;
  const info = sectionInfo(context, target) || sectionInfo(context, element);
  if (!info) return null;
  const snapshot = resolveSnapshot(info, sourcePath, readSegment);
  if (!snapshot) return null;
  return {
    sourcePath,
    segmentId: snapshot.primaryId,
    snapshot,
    element,
    renderedElements: collectRenderedElements(element, context, snapshot, info.text),
    event,
  };
}

function bindTranslationPreview(element, context, options = {}) {
  if (!element?.addEventListener) return () => {};
  const previous = bindings.get(element);
  if (previous) {
    previous.context = context;
    previous.options = options;
    return previous.cleanup;
  }
  const binding = { context, options };
  const originalTitle = element.getAttribute?.("title");
  const listener = (event) => {
    const resolved = locateTranslationPreviewTarget(event, element, binding.context, binding.options);
    if (!resolved) return;
    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();
    void binding.options.openEditor?.(resolved);
  };
  const cleanup = () => {
    if (bindings.get(element) !== binding) return;
    element.removeEventListener("dblclick", listener, true);
    element.classList?.remove("lacan-translation-editable");
    element.removeAttribute?.("data-lacan-inline-segment-id");
    if (originalTitle === null || originalTitle === undefined) element.removeAttribute?.("title");
    else element.setAttribute?.("title", originalTitle);
    bindings.delete(element);
  };
  binding.cleanup = cleanup;
  bindings.set(element, binding);
  element.addEventListener("dblclick", listener, true);
  const info = sectionInfo(context, element);
  const snapshot = info && resolveSnapshot(info, options.sourcePath, options.readSegment || readTranslationSegment);
  if (snapshot && !element.closest?.(EXCLUDED_TARGETS)) {
    element.classList?.add("lacan-translation-editable");
    element.setAttribute?.("data-lacan-inline-segment-id", snapshot.primaryId);
    element.setAttribute?.("title", "双击编辑这一整段译文、注释和建言");
  }
  return cleanup;
}

module.exports = { bindTranslationPreview, locateTranslationPreviewTarget };
