const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

class MockElement {
  constructor(tag = "div", className = "") {
    this.tag = tag;
    this.className = className;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.listeners = {};
    this.style = { setProperty() {} };
    this.value = "";
    this.scrollTop = 0;
    this.scrollHeight = 1200;
    this.clientHeight = 400;
    this.ownerDocument = mockDocument;
  }

  empty() {
    this.replaceChildren();
  }

  addClass(className) {
    this.className = [...new Set(`${this.className} ${className}`.split(/\s+/))]
      .filter(Boolean).join(" ");
  }

  hasClass(className) {
    return this.className.split(/\s+/).includes(className);
  }

  createDiv(options = "") {
    return this.createEl("div", typeof options === "string" ? { cls: options } : options);
  }

  createSpan(options = {}) {
    return this.createEl("span", options);
  }

  createEl(tag, options = {}) {
    const child = new MockElement(tag, options.cls || "");
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    child.textContent = options.text || "";
    child.attributes = { ...options.attr };
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.children) {
      child.parentElement = null;
    }
    this.children = children;
    for (const child of children) {
      child.parentElement = this;
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  addEventListener(name, listener) {
    this.listeners[name] = listener;
  }

  dispatch(name, event = {}) {
    this.listeners[name]?.(event);
  }
}

const mockDocument = {
  defaultView: {
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
  },
  createElement(tag) {
    return new MockElement(tag);
  },
};

const descendants = (element) => element.children.flatMap(
  (child) => [child, ...descendants(child)]
);
const composers = (root) => root.children.filter(
  (child) => child.hasClass("lacan-ai-follow-up")
);

const markdownGates = new Map();
const markdownComponents = new Map();
const renderedMarkdown = [];
const deferMarkdown = (markdown) => {
  let markStarted;
  let release;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const completion = new Promise((resolve) => { release = resolve; });
  const gate = { started, markStarted, completion, release };
  markdownGates.set(markdown, gate);
  return gate;
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Component: class {
        load() {
          this.loaded = true;
        }

        unload() {
          this.loaded = false;
        }
      },
      ItemView: class {
        constructor(leaf) {
          this.containerEl = leaf.containerEl;
        }
      },
      MarkdownRenderer: {
        async render(_app, markdown, element, sourcePath, component) {
          renderedMarkdown.push(markdown);
          markdownComponents.set(markdown, component);
          const gate = markdownGates.get(markdown);
          if (gate) {
            gate.markStarted();
            await gate.completion;
          }
          element.renderedMarkdown = markdown;
          element.renderedSourcePath = sourcePath;
        },
      },
      normalizePath: (value) => value,
    };
  }
  return originalLoad(request, parent, isMain);
};

let LacanInterpretationView;
try {
  ({ LacanInterpretationView } = require(path.join(
    __dirname,
    "..",
    "segment-ai/obsidian-integration.js"
  )));
} finally {
  Module._load = originalLoad;
}

const conversation = (id, overrides = {}) => ({
  id,
  title: id,
  requestedId: id,
  primaryId: id,
  sourcePath: "texts/s7-test/translation/Leçon-01.md",
  lessonTitle: "Leçon 01",
  status: "searching",
  analysisMode: "interpretation",
  messages: [
    { id: `${id}-user`, role: "user", kind: "initial", content: `${id} · 初始解读` },
    { id: `${id}-answer`, role: "assistant", content: "", status: "searching" },
  ],
  skillMode: "automatic",
  availableSkillSnapshot: [],
  draft: "",
  scroll: { followLatest: true, scrollTop: 0, unseenMessageCount: 0 },
  ...overrides,
});

const workspace = (activeConversation) => ({
  maxOpenSessions: 5,
  openConversationIds: [activeConversation.id],
  activeConversationId: activeConversation.id,
  conversations: [activeConversation],
  runningCount: ["starting", "searching", "streaming"].includes(activeConversation.status) ? 1 : 0,
});

const createView = (initialConversation) => {
  const root = new MockElement();
  const draftUpdates = [];
  const plugin = {
    app: {},
    segmentAiState: workspace(initialConversation),
    updateSegmentAiDraft(id, value) { draftUpdates.push({ id, value }); },
    updateSegmentAiScroll() {},
  };
  const view = new LacanInterpretationView({ containerEl: root }, plugin);
  view.contentEl = root;
  const renders = [];
  const render = view.render.bind(view);
  view.render = () => {
    const pending = render();
    renders.push(pending);
    return pending;
  };
  const show = (nextConversation) => {
    view.setState(workspace(nextConversation));
    return renders.at(-1);
  };
  return { root, view, draftUpdates, show };
};

test("rapid workspace state updates mount one composer for the latest conversation", async () => {
  const { root, view, draftUpdates, show } = createView(conversation("first"));
  try {
    await Promise.all([
      show(conversation("first", { draft: "第一份草稿", status: "starting" })),
      show(conversation("second", { draft: "第二份草稿" })),
      show(conversation("third", { draft: "最新草稿" })),
    ]);
    assert.equal(composers(root).length, 1, "overlapping renders must not append duplicate follow-up inputs");
    const input = descendants(composers(root)[0]).find((element) => element.tag === "textarea");
    assert.equal(input.value, "最新草稿");
    input.value = "编辑最新草稿";
    input.dispatch("input");
    assert.deepEqual(draftUpdates, [{ id: "third", value: "编辑最新草稿" }]);
    assert.equal(view.workspaceDom.conversationId, "third");
    assert.ok(root.children.includes(view.workspaceDom.scrollEl), "cached scroller must belong to the visible workspace");
  } finally {
    await view.onClose();
  }
});

test("a delayed answer cannot overwrite a newer conversation or append a stale composer", async () => {
  const gate = deferMarkdown("slow old answer");
  const { root, view, show } = createView(conversation("old"));
  const oldRender = show(conversation("old", {
    status: "completed",
    messages: [{ id: "old-answer", role: "assistant", content: "slow old answer" }],
  }));
  try {
    await gate.started;
    await show(conversation("new", {
      status: "completed",
      draft: "new draft",
      messages: [{ id: "new-answer", role: "assistant", content: "new answer" }],
    }));
    const currentDom = view.workspaceDom;
    gate.release();
    await oldRender;
    assert.equal(composers(root).length, 1, "an obsolete Markdown render must not mount another composer");
    assert.equal(view.workspaceDom, currentDom, "late completion must not replace the current workspace references");
    assert.equal(view.workspaceDom.conversationId, "new");
    assert.ok(root.children.includes(view.workspaceDom.scrollEl));
    assert.equal(markdownComponents.get("slow old answer").loaded, false, "discarded Markdown resources must be unloaded");
    assert.equal(markdownComponents.get("new answer").loaded, true, "discarding an obsolete render must preserve current Markdown");
  } finally {
    gate.release();
    await oldRender;
    await view.onClose();
  }
});

test("closing a view while Markdown is pending prevents a late composer and releases its resources", async () => {
  const gate = deferMarkdown("answer pending at close");
  const { root, view, show } = createView(conversation("closing"));
  const pending = show(conversation("closing", {
    status: "completed",
    messages: [{ id: "closing-answer", role: "assistant", content: "answer pending at close" }],
  }));
  try {
    await gate.started;
    await view.onClose();
    gate.release();
    await pending;
    assert.equal(composers(root).length, 0, "a closed view must not remount an input after Markdown completes");
    assert.equal(view.workspaceDom, null, "a closed view must not regain workspace references");
    assert.equal(markdownComponents.get("answer pending at close").loaded, false);
  } finally {
    gate.release();
    await pending;
    await view.onClose();
  }
});

test("obsolete project translation rendering stops and releases only its own Markdown", async () => {
  const gate = deferMarkdown("slow project translation");
  const { root, view, show } = createView(conversation("original-old"));
  const oldRender = show(conversation("original-old", {
    analysisMode: "original",
    sourcePath: "texts/s7-test/original/Leçon-01.md",
    projectTranslations: [
      { primaryId: "old-1", markdown: "slow project translation" },
      { primaryId: "old-2", markdown: "obsolete second translation" },
    ],
  }));
  try {
    await gate.started;
    await show(conversation("current", {
      status: "completed",
      messages: [{ id: "current-answer", role: "assistant", content: "current answer during project translation" }],
    }));
    const currentDom = view.workspaceDom;
    gate.release();
    await oldRender;
    assert.equal(composers(root).length, 1);
    assert.equal(view.workspaceDom, currentDom);
    assert.equal(markdownComponents.get("slow project translation").loaded, false);
    assert.equal(markdownComponents.get("current answer during project translation").loaded, true);
    assert.ok(!renderedMarkdown.includes("obsolete second translation"), "a cancelled translation render must not continue through the remaining blocks");
  } finally {
    gate.release();
    await oldRender;
    await view.onClose();
  }
});
