# 拉康翻译助手

用于在 Obsidian 中阅读、编辑和对照拉康研讨班法中原译文的桌面端插件，提供逐段阅读、章节笔记、法语查词和 Codex 分段分析。

本仓库是从[拉康中文翻译项目](https://github.com/Kotoba-Rin/Lacan-Chinese-Translation-Project)中迁出的独立插件源码仓库。插件名称为 `Lacan Translation Helper`，ID 为 `lacan-translation-helper`。**插件代码**在 `kotoba-rin/LCTPlugin` 维护，**研讨班文本**仍在原翻译项目维护；插件默认同步的内容上游仍是原项目。

研讨班专用功能按以下 Vault 目录及稳定分段 ID 工作：

```text
texts/<seminar>/
  original/Leçon-01.md
  translation/Leçon-01.md
  notes/
  glossary.md
```

原译文通过 `<!-- id: s8-01-0001 -->` 等标记对齐；合并译文还可以声明 `<!-- ids: ... -->`。界面与生成的阅读辅助材料目前主要使用中文。

## 功能

- 法中双语阅读、文内搜索和按分段 ID 定位。
- 在阅读视图或双语阅读中就地编辑整段中文译文、注释和建言。粘贴图片遵循 Obsidian 附件设置；图片在粘贴时创建，取消编辑仍会保留该附件。
- 创建章节阅读笔记，收录当前分段的原文、译文、注释和建言。
- 创建译文骨架、按 `<!-- untranslated -->` 标记统计翻译进度；Obsidian Bases API 可用时提供课次状态浏览。
- 同步翻译项目上游。
- 使用 Obsidian 内置 PDF 阅读器，并对 PDF 文字层进行法语取词。扫描 PDF 需先通过其他工具生成 OCR 文字层。
- 查询法语助手在线词典，通过 Codex 翻译选区，使用系统法语朗读，并收藏到所选欧路生词本。
- 在侧栏进行只读的译文解读或原文解析，支持流式回答、多会话、继续追问，以及自动发现所配置 Codex Agent 的 Skills。

## 使用条件

- **Obsidian 桌面端**，manifest 声明的最低版本为 **1.8.0**。依赖较新 Obsidian API 的功能有可用性检查，在旧版本上可能无法使用。
- 研讨班相关功能需要符合翻译项目格式的 Vault。已有项目用户可以继续使用当前文库。
- 内容同步需要本机安装 **Git CLI**，且 Obsidian 进程能通过 `PATH` 找到它。
- AI 功能需要已在终端登录、支持 `codex app-server` 协议的 **Codex CLI**。Obsidian 无法从 `PATH` 找到它时，可在插件的「AI 功能」设置中填写可执行文件绝对路径。插件不会自动安装 Codex。
- 只有读取、更新欧路生词本时才需要 **欧路 API 授权码**。公开词典查询不使用该授权码。
- 从源码开发和构建需要 **Node.js 20+ 与 npm**；使用已构建好的插件不需要另行安装 Node。

Codex 和欧路服务可能需要第三方账号、订阅或按量付费。相应服务自行管理权限与费用，插件不提供账号或服务额度。

## 从源码安装

将本仓库克隆到文库之外的开发目录，在本仓库根目录运行：

```bash
npm ci
npm run build
npm run install:plugin -- /绝对路径/你的文库
```

安装命令将三个运行文件复制到 `<文库>/.obsidian/plugins/lacan-translation-helper/`，保留已有插件设置和会话记录。随后在 Obsidian「第三方插件」设置中关闭再开启插件，加载新构建。

手动安装时，将 `main.js`、`manifest.json` 和 `styles.css` 复制到上述目录即可。个人 `data.json`、凭据和会话数据不应进入 Git 或分发包。

用于阅读研讨班的 Vault 是本地[翻译项目](https://github.com/Kotoba-Rin/Lacan-Chinese-Translation-Project)的根目录。安装本源码仓库不会自动下载研讨班文本，也不表示插件已提交到 Obsidian 社区目录。

## 内容同步

「项目与同步」设置用于配置内容仓库和分支。尽管插件代码已迁移至 `kotoba-rin/LCTPlugin`，默认内容上游仍为 `Kotoba-Rin/Lacan-Chinese-Translation-Project`。

**使用 Reader 同步前，请备份或提交文库内的本地改动。** Reader 模式通过 Git 将工作目录对齐到上游，可能覆盖本地修改并删除未跟踪文件。希望继续编辑当前文件、只刷新对照分支时，使用 **Editer** 模式。启动时自动同步默认关闭。

## 联网、文件访问与隐私

在线功能和本机集成涉及以下数据及访问范围：

| 功能 | 数据与访问 |
| --- | --- |
| 内容同步 | 调用本机 Git，连接所配置的上游，并修改文库内的 Git 状态与内容。可选的 GitHub 代理使用你配置的地址。 |
| 词典查词 | 将查询的单词或短语发送至 `https://www.frdic.com`，显示词典内容及原站提供的词典图片。选中后自动取词默认开启，可在「法语取词」中关闭。 |
| 欧路生词本 | 将授权码发送至 `https://api.frdic.com`，读取生词本、查询收录状态，并按用户操作添加词语。授权码通过插件链接的法语助手授权页面获取。 |
| 快速选区翻译 | 将当前选区和附近上下文交给本机 Codex 进程，再由其发送至配置的模型服务。「法语取词」中的短语自动翻译默认开启，它与分段 AI 开关独立。希望避免选区触发模型请求时，应关闭自动翻译或关闭自动取词。 |
| 译文解读 | 将目标译文、对齐法文、相邻段落、相关术语条目和链接笔记交给 Codex；Agent 可在只读规则内进一步读取当前研讨班资料。默认提示词要求网页检索，并只采用法语、德语或英语来源。 |
| 原文解析 | 将点击的原文分段及组装的原译文上下文交给 Codex，首次直接生成翻译，不主动要求外部研究。 |
| Skills 与 MCP | 通过所配置的 Codex Agent 发现已安装 Skills，可能读取文库外的 Skill 定义及必要支持文件。MCP 默认关闭；显式启用具体服务后，其工具与数据流由相应服务决定。本运行时的 Apps、Plugins 集成保持关闭。 |
| 法语朗读 | 使用操作系统／浏览器的语音合成 API 及可用法语语音；具体处理方式取决于所选系统语音。 |

**“本地 Agent”表示本机进程，不代表模型推理必定在本地完成。** 按照你的模型服务配置与服务政策，交给 Codex 的文本可能离开本机。插件沿用已有 Codex 登录，不会静默回退到另一套模型 API。

分段 AI 默认关闭。其运行时请求只读沙箱、拒绝权限提升，并要求 Agent 不修改原文、译文、术语表或笔记。快速选区翻译使用临时会话，关闭研究工具和 MCP。这些 AI 权限与用户主动操作的段落编辑、创建笔记和 Git 同步分别生效。

插件设置、分段会话历史和草稿保存在本地 `data.json`。Codex 在文库之外管理自己的登录、配置与 thread 数据。关闭会话标签不会删除历史。欧路授权码在支持时存入 Obsidian SecretStorage；旧版 Obsidian 只在当前运行期间保留，不写入 `data.json`。如果会话内容敏感，请同时检查文库同步与备份设置。

插件未包含客户端使用统计或开发者运营的遥测接口。第三方服务按照各自的条款与隐私政策处理请求。

### 桌面能力与权限提示

社区审核会根据使用的 API 列出以下能力。它们分别服务于具体功能：

| 审核提示 | 当前用途与范围 |
| --- | --- |
| Direct Filesystem Access | Node.js `fs` 用于检查文库下 `.git` 是否存在，以及所配置或 `PATH` 中候选 Codex 可执行文件的存在性、文件类型和可执行权限。文库正文、章节笔记和图片附件通过 Obsidian Vault API 读写。Codex 自身在文库外管理登录、配置和会话；Skills 定义的库外读取范围见上表。 |
| Shell Execution | 通过 `execFile` 的参数数组调用 Git，通过 `spawn` 启动所配置的 Codex CLI。两个进程均以 Obsidian 当前操作系统用户的身份运行；Git 工作目录为当前文库，Reader 同步的覆盖行为须由用户确认。AI 回合的只读沙箱与插件自身、Git 及已启用 MCP 服务的权限分别生效。 |
| Vault Enumeration | 列出当前文库的文件路径，用于 PDF 选择器、按研讨班和课次定位、批量生成骨架、更新翻译进度，以及筛选当前研讨班的关联笔记。正文读取由各功能按对应文件路径进行；交给模型的选区和上下文范围见上表。 |
| Clipboard Access | 用户点击复制菜单或诊断按钮时，将所选文本或诊断写入系统剪贴板；用户在译文编辑器粘贴图片时，处理该次粘贴事件提供的图片。诊断中可能包含本机 CLI 路径和已配置 MCP 服务名称，分享前请检查内容。 |

上述能力需要桌面端，因此 `manifest.json` 声明 `isDesktopOnly: true`。静态审核仍可能显示这些能力提示；实际可调用的本机进程和外部服务权限也应由使用者自行管理。

## 开发与验证

```bash
npm ci
npm run build
npm run build:check
npm test
npm run package:plugin
```

- `src/main.js` 为插件入口，`segment-ai/` 为 Codex 集成及领域模块。
- Obsidian 实际加载根目录的 `main.js`；提交时应保持它与源码一致。
- `npm run package:plugin` 在 `dist/` 中生成三个可分发运行文件。
- 测试使用模拟环境与固定材料；通过测试不代表已经验证真实 Codex 登录、词典服务可用性或所有 Obsidian 交互。

## 详细说明

- [法语取词与欧路生词本](docs/french-lookup.md)
- [PDF 阅读](docs/pdf-reading.md)
- [原文解析](docs/original-analysis.md)
- [章节阅读笔记](docs/chapter-reading-notes.md)
- [Skills 自动发现](docs/segment-ai-skills.md)
- [分段 AI 架构](docs/segment-ai-interpretation-architecture.md)
- [多会话架构与历史设计](docs/segment-ai-multi-session-architecture.md)

部分架构文档保留历史决策；已注明后续替换的内容，以当前代码及 Skills 自动发现说明为准。

插件问题及功能建议请提交到[本仓库 Issues](https://github.com/kotoba-rin/LCTPlugin/issues)；原译文修订仍提交至翻译项目。

## 许可与来源

本仓库的插件源码、样式、构建工具、测试和配套文档采用 **MIT 许可证**。分发时须保留版权声明和许可文本；构建后的 `main.js` 已包含完整许可。详见 [LICENSE](LICENSE) 和 [来源说明](NOTICE.md)。

研讨班原文、译文及第三方材料的授权安排独立于插件的软件许可证。
