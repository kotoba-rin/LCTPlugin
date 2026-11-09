const EXCLUDED_CLASSES = ["endOfContent", "annotationLayer", "annotationEditorLayer", "pdf-toolbar"];
const EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "BUTTON", "INPUT", "TEXTAREA", "SELECT"]);

function hasClass(element, name) {
  return element.classList?.contains(name)
    || String(element.className || "").split(/\s+/).includes(name);
}

// PDF.js inserts BR nodes at line endings. textContent and Range.toString()
// omit these boundaries, joining words from adjacent lines during expansion.
function readPdfTextLayer(range) {
  const start = range?.startContainer;
  const startOffset = range?.startOffset;
  if (!start || !Number.isInteger(startOffset) || startOffset < 0) return null;
  const element = start.nodeType === 3 ? start.parentElement : start;
  let layer = element?.closest?.(".textLayer");
  if (!layer) {
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (hasClass(ancestor, "textLayer")) { layer = ancestor; break; }
    }
  }
  if (!layer) return null;

  const parts = [];
  let length = 0;
  let offset = null;
  const append = (text) => { parts.push(text); length += text.length; };
  const visit = (node) => {
    if (node.nodeType === 3) {
      const text = node.textContent || "";
      if (node === start && startOffset <= text.length) offset = length + startOffset;
      append(text);
      return;
    }
    const tag = String(node.tagName || "").toUpperCase();
    if (EXCLUDED_TAGS.has(tag) || EXCLUDED_CLASSES.some((name) => hasClass(node, name))) return;
    const children = Array.from(node.childNodes || []);
    if (node === start && startOffset === 0) offset = length;
    if (tag === "BR") {
      append("\n");
      return;
    }
    children.forEach((child, index) => {
      if (node === start && startOffset === index) offset = length;
      visit(child);
    });
    if (node === start && startOffset === children.length) offset = length;
  };
  visit(layer);
  return offset === null ? null : { text: parts.join(""), offset };
}

module.exports = { readPdfTextLayer };
