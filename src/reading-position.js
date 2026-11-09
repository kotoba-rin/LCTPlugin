const BILINGUAL_LANES = ".lacan-bilingual-language[data-segment-id]";

function readingPosition(segmentId, segmentIds, language) {
  const id = String(segmentId || "").trim().toLowerCase();
  if (!id) return null;
  return {
    segmentId: id,
    segmentIds: [...new Set([id, ...(segmentIds || [])]
      .map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))],
    language: language === "translation" ? "translation" : "original",
  };
}

function lanePosition(lane) {
  return readingPosition(
    lane.dataset?.segmentId,
    String(lane.dataset?.segmentIds || "").split(/\s+/),
    lane.dataset?.language
  );
}

function captureBilingualReadingPosition(rootEl) {
  if (!rootEl?.getBoundingClientRect || rootEl.scrollTop <= 0) return null;
  const viewport = rootEl.getBoundingClientRect();
  const lanes = Array.from(rootEl.querySelectorAll?.(BILINGUAL_LANES) || []);
  for (const lane of lanes) {
    const rect = lane.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom) {
      const position = lanePosition(lane);
      if (position) return position;
    }
  }
  return null;
}

function restoreBilingualReadingPosition(rootEl, position) {
  if (!rootEl?.getBoundingClientRect || !position?.segmentId) return false;
  const requested = readingPosition(position.segmentId, position.segmentIds, position.language);
  const lanes = Array.from(rootEl.querySelectorAll?.(BILINGUAL_LANES) || [])
    .map((lane) => ({ lane, position: lanePosition(lane), rect: lane.getBoundingClientRect() }))
    .filter((item) => item.position && item.rect.height > 0);
  const exact = (item) => item.position.segmentId === requested.segmentId;
  const alias = (item) => item.position.segmentIds.some((id) => requested.segmentIds.includes(id));
  const sameLanguage = lanes.filter((item) => item.position.language === requested.language);
  const target = sameLanguage.find(exact) || sameLanguage.find(alias)
    || lanes.find(exact) || lanes.find(alias);
  if (!target) return false;
  rootEl.scrollTop += target.rect.top - rootEl.getBoundingClientRect().top;
  return true;
}

function markdownSourceLine(view) {
  let value;
  if (typeof view?.currentMode?.getScroll === "function") {
    value = view.currentMode.getScroll();
  } else {
    const mode = view?.getMode?.() === "preview" ? view.previewMode : view?.editMode;
    value = typeof mode?.getScroll === "function" ? mode.getScroll() : view?.getState?.()?.state?.scroll;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  // Preview layout can report an integer boundary a fraction of a pixel early.
  const nearestLine = Math.round(value);
  return Math.abs(value - nearestLine) < 0.01 ? nearestLine : value;
}

function captureMarkdownReadingPosition(view, blocks, language) {
  const line = markdownSourceLine(view);
  if (line === null) return null;
  let current = null;
  for (const block of blocks || []) {
    if (block.startLine <= line && (!current || block.startLine >= current.startLine)) current = block;
  }
  return current ? readingPosition(current.primaryId, current.ids, language) : null;
}

module.exports = {
  captureBilingualReadingPosition,
  restoreBilingualReadingPosition,
  captureMarkdownReadingPosition,
};
