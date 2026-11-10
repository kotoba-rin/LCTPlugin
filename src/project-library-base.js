const PROJECT_BASE_PATH = "Lacan-Chinese-Translation-Project.base";
const PROJECT_BASE_CONTENT = "filters:\n  and:\n    - file.ext == \"md\"\n    - file.inFolder(\"texts\")\n    - file.folder.contains(\"/original\")\n    - file.name.startsWith(\"Leçon-\") || file.name.startsWith(\"Lecon-\") || file.name.startsWith(\"lesson-\")\nformulas:\n  seminarSlug: file.path.split(\"/\")[1]\n  seminarCode: formula.seminarSlug.split(\"-\")[0].lower()\n  seminarOrder: number(formula.seminarCode.replace(\"s19b\", \"19.5\").replace(\"s\", \"\"))\n  seminarGroup: if(formula.seminarOrder < 10, \"0\" + formula.seminarOrder, \"\" + formula.seminarOrder) + \" · \" + formula.seminarSlug\n  lessonPadded: file.basename.replace(\"Leçon-\", \"\").replace(\"Lecon-\", \"\").replace(\"lesson-\", \"\")\n  lessonNumber: number(formula.lessonPadded)\n  lessonId: formula.seminarCode + \"-\" + formula.lessonNumber\n  lessonTitle: formula.lessonId + \" · Leçon \" + formula.lessonPadded\n  originalPath: file.path\n  translationPath: file.path.replace(\"/original/\", \"/translation/\")\n  notesIndexPath: '\"texts/\" + formula.seminarSlug + \"/notes/README.md\"'\n  translationFile: link(formula.translationPath).asFile()\n  translationStatus: if(formula.translationFile, \"已有译文\", \"译文不存在\")\n  translationProgress: if(formula.translationFile, formula.translationFile.properties.translation_progress, 0)\n  translationProgressLabel: if(formula.translationFile, formula.translationFile.properties.translation_progress_label, \"0.00%\")\n  untranslatedCount: if(formula.translationFile, formula.translationFile.properties.untranslated_count, \"\")\n  maxSegmentId: if(formula.translationFile, formula.translationFile.properties.max_segment_id, \"\")\n  original: link(formula.originalPath, \"打开原文\")\n  translation: link(formula.translationPath, if(formula.translationFile, \"打开译文\", \"新建翻译\"))\n  notes: link(formula.notesIndexPath, \"阅读笔记\")\nproperties:\n  formula.lessonTitle:\n    displayName: Leçon\n  formula.lessonId:\n    displayName: 编号\n  formula.seminarSlug:\n    displayName: 研讨班\n  formula.seminarGroup:\n    displayName: 研讨班\n  formula.original:\n    displayName: 原文\n  formula.translation:\n    displayName: 译文\n  formula.notes:\n    displayName: 笔记\n  formula.originalPath:\n    displayName: 原文路径\n  formula.translationPath:\n    displayName: 译文路径\n  formula.notesIndexPath:\n    displayName: 笔记路径\n  formula.translationStatus:\n    displayName: 译文状态\n  formula.translationProgressLabel:\n    displayName: 翻译进度\n  formula.untranslatedCount:\n    displayName: 未译段落\n  formula.maxSegmentId:\n    displayName: 最大分段\n  file.mtime:\n    displayName: 原文最近修改\nviews:\n  - type: lacan-lesson-list\n    name: 文本清单\n    groupBy:\n      property: formula.seminarGroup\n      direction: ASC\n    order: []\n    sort:\n      - property: formula.seminarOrder\n        direction: ASC\n      - property: formula.lessonNumber\n        direction: ASC\n  - type: lacan-knowledge-list\n    name: 知识库\n";

function migrateProjectBaseContent(contents, { parseYaml, stringifyYaml } = {}) {
  if (typeof contents !== "string") throw new Error("Base 内容必须是文本。");
  const parsed = parseYaml?.(contents);
  if (parsed != null && (typeof parsed !== "object" || Array.isArray(parsed))) throw new Error("Base 配置格式无效，已保留原文件。");
  if (parsed?.views != null && !Array.isArray(parsed.views)) throw new Error("Base 的 views 必须是列表，已保留原文件。");
  if (parsed?.views?.some((view) => view?.type === "lacan-knowledge-list")) return contents;
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.split(/\r?\n/);
  const start = lines.findIndex((line) => /^(?:views|"views"|'views')\s*:/.test(line));
  const addition = ["  - type: lacan-knowledge-list", "    name: 知识库"];
  if (start < 0) return `${contents}${contents.endsWith("\n") || !contents ? "" : newline}views:${newline}${addition.join(newline)}${newline}`;
  let end = start + 1;
  while (end < lines.length && (!/^\S/.test(lines[end]) || /^(?:#|-\s)/.test(lines[end]))) end += 1;
  const block = lines.slice(start, end).join("\n");
  if (!parseYaml && /^\s*-\s+type:\s*["']?lacan-knowledge-list["']?\s*(?:#.*)?$/m.test(block)) return contents;
  const tail = lines[start].replace(/^(?:views|"views"|'views')\s*:/, "").trim();
  if (tail && !tail.startsWith("#") && !/^\[\s*\]\s*(?:#.*)?$/.test(tail)) {
    if (!parsed || !stringifyYaml) throw new Error("当前 Base 使用复杂 views 格式，请保留原文件并手动添加知识库视图。");
    const replacement = stringifyYaml({ views: [...(parsed.views || []), { type: "lacan-knowledge-list", name: "知识库" }] }).trimEnd().split(/\r?\n/);
    lines.splice(start, end - start, ...replacement);
    return lines.join(newline);
  }
  if (!parseYaml) {
    const first = lines.slice(start + 1, end).find((line) => line.trim() && !line.trim().startsWith("#"));
    if (first && !/^\s*-\s/.test(first)) throw new Error("Base 的 views 必须是列表，已保留原文件。");
  }
  if (/^\[/.test(tail)) lines[start] = lines[start].replace(/:\s*\[\s*\]/, ":");
  const indent = block.match(/\n( *)-\s/)?.[1] ?? "  ";
  const inserted = [`${indent}- type: lacan-knowledge-list`, `${indent}  name: 知识库`];
  // Append within views rather than at EOF, which may contain other root keys.
  while (end > start + 1 && !lines[end - 1].trim()) end -= 1;
  lines.splice(end, 0, ...inserted);
  return lines.join(newline);
}

module.exports = { PROJECT_BASE_PATH, PROJECT_BASE_CONTENT, migrateProjectBaseContent };
