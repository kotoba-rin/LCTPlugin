const MAX_SELECTION_LENGTH = 400;
const MAX_CONTEXT_LENGTH = 600;
const LATIN_RUN = "[\\p{Script=Latin}][\\p{Script=Latin}\\p{M}]*";
const WORD_SOURCE = `${LATIN_RUN}(?:['’ʼ\\-‐‑]${LATIN_RUN})*`;
const SINGLE_WORD_RE = new RegExp(`^${WORD_SOURCE}$`, "u");
const ELISION_RE = /^((?:[cdjlmnst]|qu)['’ʼ])(.+)$/iu;

function cleanText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isMetadata(value) {
  return /<!--|-->/u.test(value)
    || /^s\d+[a-z]?-\d+-\d+$/iu.test(value)
    || /^(?:id|ids|seminar|lesson|source-(?:url|original)|translation_progress(?:_label)?|untranslated_count|max_segment_id)\s*:/iu.test(value)
    || /^(?:texts|知识库)\//u.test(value)
    || /^(?:https?|app|obsidian|file):\/\//iu.test(value);
}

function clipContext(value) {
  const context = cleanText(value);
  if (Array.from(context).length <= MAX_CONTEXT_LENGTH) {
    return context;
  }
  let clipped = "";
  let length = 0;
  // Keep an accent together with its base when a context ends at the limit.
  for (const { segment } of new Intl.Segmenter("fr", { granularity: "grapheme" }).segment(context)) {
    const segmentLength = Array.from(segment).length;
    if (length + segmentLength > MAX_CONTEXT_LENGTH) {
      break;
    }
    clipped += segment;
    length += segmentLength;
  }
  return clipped.trimEnd();
}

function buildFrenchLookup(text, context = "") {
  const cleaned = cleanText(text);
  if (!cleaned || isMetadata(cleaned)) {
    return null;
  }
  const selection = cleaned.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "");
  if (!/[\p{Script=Latin}]/u.test(selection)
    || isMetadata(selection)
    || Array.from(selection).length > MAX_SELECTION_LENGTH) {
    return null;
  }
  const isPhrase = !SINGLE_WORD_RE.test(selection);
  const elided = !isPhrase && selection.match(ELISION_RE);
  const query = elided ? elided[2] : selection;
  return {
    selection,
    query,
    candidates: [...new Set([query, selection])],
    context: clipContext(context),
    isPhrase,
    ...(elided ? { elision: { prefix: elided[1], base: elided[2] } } : {}),
  };
}

function getFrenchWordAt(text, offset) {
  if (typeof text !== "string" || !Number.isInteger(offset) || offset < 0 || offset > text.length) {
    return "";
  }
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const nextNewline = text.indexOf("\n", offset);
  const line = text.slice(lineStart, nextNewline === -1 ? text.length : nextNewline);
  if (isMetadata(cleanText(line))) {
    return "";
  }
  for (const match of text.matchAll(new RegExp(WORD_SOURCE, "gu"))) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset < start || offset > end) {
      continue;
    }
    // Do not turn an identifier such as s7-01-0001 into a lookup for “s”.
    if (/[\p{L}\p{M}\p{N}_]$/u.test(text.slice(0, start))
      || /^[\p{L}\p{M}\p{N}_]/u.test(text.slice(end))
      || /^[\-‐‑]\p{N}/u.test(text.slice(end))) {
      return "";
    }
    return match[0].normalize("NFC");
  }
  return "";
}

module.exports = { buildFrenchLookup, getFrenchWordAt };
