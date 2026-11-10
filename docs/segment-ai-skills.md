# Skills 自动发现

2026-11-08 起，插件不再配置或保存固定 Skill 方案，也不指定主要、辅助 Skill。点击分段的 `Ф` 后，由所配置的 Agent 根据当前任务选择零个、一个或多个可用 Skills。

## 来源与刷新

本节描述 Codex 提供方。Claude Code 与 DeepSeek Harness 的当前适配不提供 Skill 清单，返回空目录，不复用 Codex 的已保存目录。三种 CLI 的会话、模型和能力缓存分别保存，见 [CLI 适配说明](cli-providers.md)。

Codex 使用此电脑配置的 CLI（留空则自动检测 PATH、登录 Shell 和常见安装目录）。以当前项目根目录作为 App Server 的 `cwd`，调用 `skills/list({ cwds: [vaultRoot], forceReload: true })`。清单来自该 Agent 自己的发现机制，不硬编码 Skill 名称，不扫描其他 Agent 的安装目录，不添加任意外部搜索路径。

纳入范围：

- 当前项目目录内、Agent 实际发现的项目 Skills；
- 同一 Agent 实际返回的用户、系统、管理员等已安装 Skills。

过滤不属于当前工作目录的返回组，以及项目目录之外的 `repo` 条目。禁用或加载出错的 Skills 不进入当轮可用目录。同名条目保留完整来源和路径，不按名称误合并。

每次初次解读和继续追问都重新发现；同时开始的请求共享正在进行的发现。空清单是有效结果。发现失败时报告错误，不使用上次保存的清单继续运行；下一次可重新尝试。`skills/changed` 会使缓存失效。切换 CLI 后清理旧缓存与运行时。

## 按需使用

当轮只向模型提供可用 Skills 的名称、说明、作用域和路径。目录是选择线索，不是要求执行所有 Skills；插件不发送结构化 `type: "skill"` 显式调用，不限制选择数量，也不把某个 Skill 固定到某个分段。

Agent 根据任务与描述决定是否读取 `SKILL.md` 及必要支持文件，遵守其原生隐式调用策略及 `allow_implicit_invocation` 限制。可用目录与实际使用记录不同：内部会话字段只保存自动发现的可用目录，不代表目录中的 Skills 全部已使用。

Skills 不扩大当前模式的写入、网络或业务文件访问权限。原文解析可只读 Skills 定义，但仍不主动扩展研究；独立的快速选文翻译继续使用原有无工具模式。依赖当前未开放能力的步骤不能执行。

## 界面与数据

设置页保留一份全局解读提示词，不展示 Skills 相关说明、来源、发现状态、清单或刷新入口，也不因打开设置页触发 Skills 发现；不再有方案名称、默认方案、主要/辅助下拉框或保存方案按钮。会话顶部与历史列表也不展示 Skills 标签。段落统一显示一个 `Ф`，没有方案菜单。

新会话使用 `skillMode: "automatic"` 和 `availableSkillSnapshot`（当轮可用目录快照）。同段复用只按 `segmentKey`，不再按 Skill 方案分组。Skills 安装或更新后，后续追问使用新目录，不因旧指纹阻止追问。

载入历史数据时移除旧 `skillProfile`、`skillProfileSignature` 和 `skillSnapshot` 绑定，保留会话标题、回答、消息、草稿和 thread。旧方案中的提示词按已有规则迁移到唯一全局提示词，随后删除旧方案配置。原文解析与译文解读仍保持各自独立的会话。

## 验证

相关回归测试：`tests/test_segment_ai_skills.js`、`tests/test_segment_ai_workspace.js`、`tests/test_segment_ai_runtime.js`、`tests/test_segment_ai_obsidian_integration.js`、`tests/test_lacan_translation_helper.js`、`tests/test_lacan_translation_helper_bundle.js`。源码已迁入独立仓库 `kotoba-rin/LCTPlugin`；在仓库根目录运行 `npm run build`、`npm run build:check` 与 `npm test`。`.obsidian/plugins/lacan-translation-helper` 仅作为 Vault 中的安装目录。
