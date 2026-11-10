const skipReasonText = ({ reason } = {}) => {
  if (reason === "existing_local_file") return "本地文件与发布版本不同，且没有可信同步基线，已跳过。";
  if (reason === "unsaved_changes") return "检测到未保存的编辑，已跳过同步。";
  if (reason === "changed_during_sync") return "文件在同步过程中发生变化，已撤回本课更新并跳过。";
  if (reason === "paired_file_modified") return "同课文件已有本地修改，本课原文和译文均已跳过。";
  return "识别到当前文本已有用户修改，已跳过同步。";
};

const formatSkipNotice = (skippedFiles = []) => {
  const triggers = skippedFiles.filter((entry) => entry.reason !== "paired_file_modified");
  const paths = [...new Set((triggers.length ? triggers : skippedFiles).map((entry) => entry.triggerPath || entry.path))];
  const message = skippedFiles.some((entry) => entry.reason === "unsaved_changes")
    ? "检测到未保存的编辑，已跳过本课同步。"
    : skippedFiles.some((entry) => entry.reason === "existing_local_file")
      ? "本地文本与发布版本存在差异，已跳过本课同步。"
      : "识别到当前文本已有用户修改，已跳过本课同步。";
  const next = skippedFiles.some((entry) => entry.reason === "unsaved_changes")
    ? "请先保存或关闭未保存的编辑。需要重新同步时，请先保留修改副本，再删除上述本地文件后同步。"
    : "如需重新同步，请先保留修改副本，再删除上述本地文件后点击同步。";
  return `${message}\n${paths.join("\n")}\n${next}`;
};

module.exports = { skipReasonText, formatSkipNotice };
