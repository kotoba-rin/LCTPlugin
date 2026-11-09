const { createHash } = require("crypto");
const { SegmentContextError, SegmentParser } = require("./segment-parser");

const TRANSLATION_PATH_RE = /^texts\/([^/]+)\/translation\/((?:Leçon|Lecon|lesson)-(\d+)\.md)$/i;
const ORIGINAL_PATH_RE = /^texts\/([^/]+)\/original\/((?:Leçon|Lecon|lesson)-(\d+)\.md)$/i;
const NOTE_LINK_RE = /\[\[\s*([^|\]#]+)(?:#[^|\]]*)?(?:\|[^\]]*)?\]\]/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const CONTEXT_VERSION = "1";

class SegmentContextResolver {
  constructor({ readText, listMarkdownPaths = async () => [], parser = new SegmentParser() } = {}) {
    if (typeof readText !== "function") {
      throw new TypeError("SegmentContextResolver requires readText(path).");
    }
    this.readText = readText;
    this.listMarkdownPaths = listMarkdownPaths;
    this.parser = parser;
  }

  async resolve(translationPath, requestedId) {
    const normalizedPath = normalizeVaultPath(translationPath);
    const normalizedId = this.parser.normalizeId(requestedId);
    if (ORIGINAL_PATH_RE.test(normalizedPath)) {
      return this.resolveOriginal(normalizedPath, normalizedId);
    }
    const pathInfo = translationPathInfo(normalizedPath);
    validateLessonIdentity(pathInfo.lessonNumber, normalizedId);

    const translationText = await this.readRequired(
      normalizedPath,
      "SegmentNotFound",
      `找不到译文文件：${normalizedPath}`
    );
    const translationBlocks = this.parser.parse(translationText, normalizedPath);
    const targetTranslation = this.parser.findByRequestedId(translationBlocks, normalizedId);
    const targetIndex = translationBlocks.indexOf(targetTranslation);

    const originalPath = normalizedPath.replace("/translation/", "/original/");
    const originalText = await this.readRequired(
      originalPath,
      "OriginalMissing",
      `找不到对应法文原文：${originalPath}`
    );
    const originalBlocks = this.parser.parse(originalText, originalPath);
    const alignedOriginalMatches = targetTranslation.ids.map((id) => {
      try {
        return this.parser.findByRequestedId(originalBlocks, id);
      } catch (error) {
        if (error instanceof SegmentContextError) {
          throw new SegmentContextError(
            "OriginalMissing",
            `法文原文缺少或无法唯一解析分段 ${id}：${originalPath}`
          );
        }
        throw error;
      }
    });
    const alignedOriginals = uniqueBlocks(alignedOriginalMatches);

    const glossaryPath = `texts/${pathInfo.seminarSlug}/glossary.md`;
    const glossaryText = await this.readOptional(glossaryPath);
    const glossaryEntries = matchGlossaryEntries(
      glossaryText,
      [
        targetTranslation.visibleText,
        ...alignedOriginals.map((block) => block.visibleText),
      ].join("\n")
    );
    const linkedNotes = await this.resolveLinkedNotes({
      seminarSlug: pathInfo.seminarSlug,
      translationMarkdown: targetTranslation.markdown,
      segmentIds: targetTranslation.ids,
    });
    const translationAvailable = (
      Boolean(targetTranslation.visibleText)
      && !/<!--\s*untranslated\s*-->/i.test(targetTranslation.markdown)
    );
    const warnings = availabilityWarnings({
      translationAvailable,
      glossaryAvailable: glossaryText !== null,
      linkedNotesAvailable: linkedNotes.length > 0,
    });
    const reference = {
      seminarCode: normalizedId.split("-")[0],
      seminarSlug: pathInfo.seminarSlug,
      lessonNumber: pathInfo.lessonNumber,
      requestedId: normalizedId,
      primaryId: targetTranslation.primaryId,
      coveredIds: [...targetTranslation.ids],
      translationPath: normalizedPath,
      originalPath,
    };
    const context = {
      reference,
      targetTranslation,
      alignedOriginals,
      previousTranslation: translationBlocks[targetIndex - 1],
      nextTranslation: translationBlocks[targetIndex + 1],
      glossaryEntries,
      linkedNotes,
      lessonTitle: firstMarkdownHeading(translationText),
      availability: {
        translationAvailable,
        originalAvailable: alignedOriginalMatches.length === targetTranslation.ids.length,
        glossaryAvailable: glossaryText !== null,
        linkedNotesAvailable: linkedNotes.length > 0,
        warnings,
      },
    };
    context.contextHash = contextHash(context);
    return context;
  }

  async resolveOriginal(originalPath, requestedId) {
    const pathMatch = originalPath.match(ORIGINAL_PATH_RE);
    const seminarSlug = pathMatch[1];
    const lessonNumber = Number(pathMatch[3]);
    validateLessonIdentity(lessonNumber, requestedId);
    const originalText = await this.readRequired(
      originalPath,
      "OriginalMissing",
      `找不到法文原文：${originalPath}`
    );
    const originalBlocks = this.parser.parse(originalText, originalPath);
    const targetOriginal = this.parser.findByRequestedId(originalBlocks, requestedId);
    // Every covered ID must still identify this exact original block uniquely.
    for (const id of targetOriginal.ids) {
      this.parser.findByRequestedId(originalBlocks, id);
    }
    const originalIndex = originalBlocks.indexOf(targetOriginal);
    const translationPath = originalPath.replace(/\/original\//i, "/translation/");
    const translationText = await this.readOptional(translationPath);
    const translationBlocks = this.parser.parse(translationText, translationPath);
    const missingTranslationIds = [];
    const alignedTranslations = uniqueBlocks(targetOriginal.ids.flatMap((id) => {
      try {
        return [this.parser.findByRequestedId(translationBlocks, id)];
      } catch (error) {
        if (error instanceof SegmentContextError && error.code === "SegmentNotFound") {
          missingTranslationIds.push(id);
          return [];
        }
        throw error;
      }
    })).map((block) => withReferencedFootnotes(block, translationText));
    const unavailableTranslationIds = targetOriginal.ids.filter((id) => (
      !alignedTranslations.some((block) => (
        block.ids.includes(id)
        && block.visibleText
        && !/<!--\s*untranslated\s*-->/i.test(block.markdown)
      ))
    ));
    const translationAvailable = unavailableTranslationIds.length === 0;
    const warnings = [];
    if (!translationAvailable) {
      warnings.unshift(
        `以下原文分段没有可用中文译文：${unavailableTranslationIds.join("、")}；仍可翻译原文。`
      );
    }
    const context = {
      analysisMode: "original",
      reference: {
        seminarCode: requestedId.split("-")[0],
        seminarSlug,
        lessonNumber,
        requestedId,
        primaryId: targetOriginal.primaryId,
        coveredIds: [...targetOriginal.ids],
        translationPath,
        originalPath,
      },
      targetOriginal,
      targetTranslation: alignedTranslations[0] || null,
      alignedOriginals: [targetOriginal],
      alignedTranslations,
      previousOriginal: originalBlocks[originalIndex - 1],
      nextOriginal: originalBlocks[originalIndex + 1],
      lessonTitle: firstMarkdownHeading(originalText),
      availability: {
        translationAvailable,
        translationAlignmentComplete: missingTranslationIds.length === 0,
        missingTranslationIds,
        originalAvailable: true,
        warnings,
      },
    };
    context.contextHash = contextHash(context);
    return context;
  }

  async resolveLinkedNotes({ seminarSlug, translationMarkdown, segmentIds }) {
    const notesRoot = `texts/${seminarSlug}/notes/`;
    const explicit = explicitNotePaths(translationMarkdown, notesRoot);
    const listed = (await this.listMarkdownPaths(notesRoot))
      .map(normalizeVaultPath)
      .filter((notePath) => notePath.startsWith(notesRoot) && notePath.endsWith(".md"));
    const candidates = Array.from(new Set([...explicit, ...listed])).sort();
    const notes = [];

    for (const notePath of candidates) {
      const noteText = await this.readOptional(notePath);
      if (noteText === null) {
        continue;
      }
      if (!explicit.includes(notePath) && !frontmatterReferencesIds(noteText, segmentIds)) {
        continue;
      }
      notes.push({
        path: notePath,
        title: noteTitle(noteText, notePath),
        relatedIds: frontmatterSegmentIds(noteText),
        excerpt: noteExcerpt(noteText),
      });
    }
    return notes;
  }

  async readRequired(path, code, message) {
    const value = await this.readText(normalizeVaultPath(path));
    if (value === null || value === undefined) {
      throw new SegmentContextError(code, message);
    }
    return String(value);
  }

  async readOptional(path) {
    const value = await this.readText(normalizeVaultPath(path));
    return value === null || value === undefined ? null : String(value);
  }
}

const normalizeVaultPath = (value) => {
  const raw = String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
  if (!raw || raw.startsWith("/") || raw.split("/").includes("..")) {
    throw new SegmentContextError("PathOutsideVault", `路径不在当前 Vault 内：${value}`);
  }
  return raw;
};

const translationPathInfo = (translationPath) => {
  const match = translationPath.match(TRANSLATION_PATH_RE);
  if (!match) {
    throw new SegmentContextError("InvalidTranslationPath", `当前文件不是译文课文：${translationPath}`);
  }
  return { seminarSlug: match[1], lessonNumber: Number(match[3]) };
};

const validateLessonIdentity = (lessonNumber, segmentId) => {
  const idLesson = Number(segmentId.split("-")[1]);
  if (idLesson !== lessonNumber) {
    throw new SegmentContextError(
      "SegmentLessonMismatch",
      `分段 ID ${segmentId} 与当前课次 ${lessonNumber} 不一致。`
    );
  }
};

const uniqueBlocks = (blocks) => {
  const seen = new Set();
  return blocks.filter((block) => {
    const key = `${block.sourcePath}::${block.primaryId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const withReferencedFootnotes = (block, fileText) => {
  const references = Array.from(block.markdown.matchAll(/\[\^([^\]\n]+)\](?!:)/g), (match) => match[1]);
  if (!references.length) {
    return block;
  }
  const included = new Set(Array.from(
    block.markdown.matchAll(/^ {0,3}\[\^([^\]\n]+)\]:/gm),
    (match) => match[1]
  ));
  const definitions = new Map(Array.from(String(fileText || "").matchAll(
    /^ {0,3}\[\^([^\]\n]+)\]:[^\n]*(?:\n(?:[ \t]*\n)*(?: {2,}|\t)[^\n]*)*/gm
  ), (match) => [match[1], match[0].trimEnd()]));
  const appended = [];
  for (const id of references) {
    if (included.has(id) || !definitions.has(id)) {
      continue;
    }
    included.add(id);
    const definition = definitions.get(id);
    appended.push(definition);
    references.push(...Array.from(definition.matchAll(/\[\^([^\]\n]+)\](?!:)/g), (match) => match[1]));
  }
  return appended.length ? {
    ...block,
    markdown: `${block.markdown}\n\n${appended.join("\n\n")}`,
  } : block;
};

const markdownCells = (line) => String(line || "")
  .trim()
  .replace(/^\|/, "")
  .replace(/\|$/, "")
  .split("|")
  .map((cell) => cell.trim().replace(/\\\|/g, "|"));

const matchGlossaryEntries = (glossaryText, haystack) => {
  if (!glossaryText) {
    return [];
  }
  const normalizedHaystack = String(haystack || "").toLocaleLowerCase();
  const entries = [];
  for (const line of glossaryText.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) {
      continue;
    }
    const [sourceTerm = "", chineseTerm = "", note = ""] = markdownCells(line);
    if (
      !sourceTerm
      || /^[-:\s]+$/.test(sourceTerm)
      || /^(外文|法文|原文)$/i.test(sourceTerm)
    ) {
      continue;
    }
    const sourceCandidates = sourceTerm.split(/\s*\/\s*/).filter(Boolean);
    const matchedSource = sourceCandidates.some((term) => (
      normalizedHaystack.includes(term.toLocaleLowerCase())
    ));
    const matchedChinese = chineseTerm && normalizedHaystack.includes(chineseTerm.toLocaleLowerCase());
    if (matchedSource || matchedChinese) {
      entries.push({ sourceTerm, chineseTerm, note });
    }
  }
  return entries;
};

const explicitNotePaths = (markdown, notesRoot) => {
  const paths = [];
  NOTE_LINK_RE.lastIndex = 0;
  let match;
  while ((match = NOTE_LINK_RE.exec(String(markdown || ""))) !== null) {
    const target = match[1].trim().replace(/\\/g, "/");
    if (!target.toLowerCase().startsWith("notes/")) {
      continue;
    }
    const relative = target.slice("notes/".length).replace(/\.md$/i, "");
    if (!relative || relative.split("/").includes("..")) {
      continue;
    }
    paths.push(`${notesRoot}${relative}.md`);
  }
  return Array.from(new Set(paths)).sort();
};

const frontmatterBody = (text) => String(text || "").match(FRONTMATTER_RE)?.[1] || "";

const frontmatterSegmentValues = (text) => {
  const lines = frontmatterBody(text).split(/\r?\n/);
  const values = [];
  let collecting = false;
  for (const line of lines) {
    if (/^segments\s*:/i.test(line.trim())) {
      collecting = true;
      continue;
    }
    if (!collecting) {
      continue;
    }
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (item) {
      values.push(item[1].replace(/^['"]|['"]$/g, ""));
      continue;
    }
    if (line.trim() && !/^\s/.test(line)) {
      break;
    }
  }
  return values;
};

const frontmatterSegmentIds = (text) => {
  const parser = new SegmentParser();
  return parser.mergeIds(...frontmatterSegmentValues(text).map((value) => parser.idsFromText(value)));
};

const frontmatterReferencesIds = (text, segmentIds) => {
  const targets = new Set(segmentIds || []);
  for (const value of frontmatterSegmentValues(text)) {
    const directIds = new SegmentParser().idsFromText(value);
    if (directIds.some((id) => targets.has(id))) {
      return true;
    }
    const range = value.match(/^(s\d+[a-z]?-\d+)-(\d+)\s*[~～—–]\s*(\d+)$/i);
    if (!range) {
      continue;
    }
    const start = Number(range[2]);
    const end = Number(range[3]);
    for (const target of targets) {
      const targetMatch = target.match(new RegExp(`^${escapeRegExp(range[1])}-(\\d+)$`, "i"));
      const number = targetMatch ? Number(targetMatch[1]) : NaN;
      if (number >= Math.min(start, end) && number <= Math.max(start, end)) {
        return true;
      }
    }
  }
  return false;
};

const noteTitle = (text, path) => {
  const frontmatterTitle = frontmatterBody(text).match(/^title\s*:\s*(.+?)\s*$/im)?.[1];
  if (frontmatterTitle) {
    return frontmatterTitle.replace(/^['"]|['"]$/g, "");
  }
  return firstMarkdownHeading(text) || path.split("/").pop().replace(/\.md$/i, "");
};

const noteExcerpt = (text) => String(text || "")
  .replace(FRONTMATTER_RE, "")
  .trim()
  .slice(0, 1200);

const firstMarkdownHeading = (text) => (
  String(text || "").match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || undefined
);

const availabilityWarnings = ({ translationAvailable, glossaryAvailable, linkedNotesAvailable }) => {
  const warnings = [];
  if (!translationAvailable) {
    warnings.push("当前分段没有可用中文译文，将仅依据法文原文解释。");
  }
  if (!glossaryAvailable) {
    warnings.push("当前研讨班没有可用术语表。");
  }
  if (!linkedNotesAvailable) {
    warnings.push("当前分段没有找到显式关联的阅读笔记。");
  }
  return warnings;
};

const stableValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) {
      result[key] = stableValue(value[key]);
    }
    return result;
  }, {});
};

const contextHash = (context) => {
  const hashInput = {
    version: CONTEXT_VERSION,
    analysisMode: context.analysisMode,
    reference: {
      seminarCode: context.reference.seminarCode,
      seminarSlug: context.reference.seminarSlug,
      lessonNumber: context.reference.lessonNumber,
      primaryId: context.reference.primaryId,
      coveredIds: context.reference.coveredIds,
      translationPath: context.reference.translationPath,
      originalPath: context.reference.originalPath,
    },
    targetTranslation: context.targetTranslation,
    targetOriginal: context.targetOriginal,
    alignedOriginals: context.alignedOriginals,
    alignedTranslations: context.alignedTranslations,
    previousOriginal: context.previousOriginal,
    nextOriginal: context.nextOriginal,
    previousTranslation: context.previousTranslation,
    nextTranslation: context.nextTranslation,
    glossaryEntries: context.glossaryEntries,
    linkedNotes: context.linkedNotes,
    availability: context.availability,
  };
  return createHash("sha256").update(JSON.stringify(stableValue(hashInput))).digest("hex");
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = {
  CONTEXT_VERSION,
  SegmentContextResolver,
  contextHash,
  explicitNotePaths,
  frontmatterReferencesIds,
  matchGlossaryEntries,
  normalizeVaultPath,
};
