# CLI 提供方与跨平台发现

在插件设置「AI 功能 → CLI 工具」选择 Codex CLI、Claude Code 或 DeepSeek Harness。分段解读、原文解析和法语语境翻译使用所选工具。插件沿用工具已有的登录／模型凭据，不保存 API 密钥，不替用户安装 CLI。

## 自动发现与路径

发现机制参考 [Claudian](https://github.com/yishentu/claudian) 的职责划分，并以本插件的运行接口重新实现：

1. 显式路径优先；路径无效时直接提示，不悄悄改用另一份安装。
2. 查询 Obsidian 继承的 PATH；macOS 缺少终端路径时，以有时限的固定登录 Shell 命令读取 PATH。
3. 检查 Homebrew、用户 `.local/bin`、npm／pnpm、NVM、Volta、asdf 等常见安装目录，以及受支持的桌面应用内置入口。
4. 单独执行有时限的 `--version`。检测不会发送模型请求。

Windows 保留 `Path` 大小写，支持 `.exe`、npm `.cmd`、Node `.js/.cjs/.mjs` 入口及带空格的路径。npm 包装器解析为底层 Node 入口，提示词通过 stdin 传入，不拼进 `cmd.exe`。无法识别的自定义批处理会提示改选 `.exe` 或 Node 入口。macOS 支持 Homebrew、原生安装及 Codex／ChatGPT 应用内置 Codex。DeepSeek Desktop 的入口按其内置 Electron／Node 布局启动。

自定义路径允许外层引号、`~/` 和 Windows `%APPDATA%` 等环境变量。路径以操作系统＋电脑名称为键保存；新电脑使用自动发现。首次迁移仅导入与当前操作系统兼容的旧路径。清空后恢复自动发现。

## 运行协议与能力

| 工具 | 协议与恢复 | 模型设置 | 工具范围 |
| --- | --- | --- | --- |
| Codex CLI | `codex app-server` JSON-RPC，保留原有 thread／turn、停止与恢复逻辑 | `model/list` 动态模型目录和推理强度 | 只读策略、Skills 自动发现；外部 MCP 固定关闭 |
| Claude Code | `--print --output-format stream-json`，增量文本，`--resume` 恢复 | 默认模型、手填别名／模型 ID，`--effort` | 仅 Read／Glob／Grep；研究模式增加 WebSearch／WebFetch。禁用 Shell、写入工具、Slash Commands、Hooks、Chrome 与外部 MCP |
| DeepSeek Harness | `--profile headless --json`，提交的文本事件与最终回答，`--session-id` 恢复 | 使用本机 headless profile 的模型／凭据／推理参数 | `read-only`＋`never`，每轮私有 overlay 限制只读／网页工具，确认策略安装后才接受会话结果 |

DeepSeek 的文本事件来自已提交的模型步骤，不保证逐 token 输出。网页工具取决于 headless profile 的配置；不可用时按提示词明确说明。它没有 headless `--model` 或 `--effort` 参数，插件不会伪造这些选项。

Claude 与 DeepSeek 当前适配不提供模型／Skills／MCP 发现 RPC，不复用 Codex 的目录。Claude 的模型与强度可手填／选择；DeepSeek 在自身 profile 中配置。后二者的本地原生会话 ID 加提供方前缀保存。插件历史、未发送草稿、模型和能力缓存分别保存在各自 profile 中；切换先停止当前任务、保存旧工作区，再加载目标工作区。

恢复界面使用插件已保存的消息；下次追问时才调用 CLI 的原生恢复参数，不通过额外模型请求读取历史。原生会话被删除或恢复标识不符时报告错误，不自动开启新会话冒充延续。

## 只读与进程边界

插件不提供 MCP 接入、服务清单、启用开关或后台预检；旧版保存的相关设置会在载入时删除。Codex 仅在实际使用 CLI 时读取配置名称，以明确禁用用户或项目配置中的外部服务，不连接这些服务。

原文解析不主动研究；快速取词翻译不给模型开放工具。分段模式仍保留原有文本证据、引用和文件范围指令。Claude 的系统指令使用权限受限的临时文件，DeepSeek 使用临时系统指令插件／配置，结束或确认停止后清理。

Claude 只加载用户级 CLI 设置，以保留已有的模型服务地址、认证环境和默认模型；项目／本地设置不加载，同时使用严格空 MCP 配置，禁用 Hooks 和 Slash Commands。DeepSeek 的 overlay 会关闭标准 Shell、写入、子代理等插件，并在模型工具层执行允许清单；**用户 profile 中其他插件仍可能在启动时运行**，因此不声称其外部 MCP 启动已被完全隔离。需要严格控制启动行为时，应先检查本机 headless profile。

macOS 停止独立进程组；Windows 通过 `taskkill /T` 停止进程树。停止有时限与强制终止升级；无法确认退出时保留占用并报告，不允许直接恢复同一会话。

## 验证与参考

新增测试涵盖 GUI 缺少 PATH、显式路径错误、脚本入口、版本超时、Windows npm 包装器及特殊字符、按电脑保存路径、提供方切换和历史隔离、JSON 流、恢复、失败、取消和超时。运行 `npm run build` 和 `npm run check`。

本次还在 macOS 实测 Codex／Claude 的发现，以及 Obsidian 中三种设置的切换；在 Windows 实测 npm Codex 发现、Node 入口与多行参数，并运行运行时、提供方配置和按电脑保存路径的测试。DeepSeek 未在这两台电脑全局安装；使用隔离的官方 npm CLI 验证了实际 headless profile／系统指令插件／只读工具限制加载，在缺少凭据时正确退出。没有发送付费模型请求，完整模型响应仍需配置后的实机验证。

协议依据：

- [Claudian 参考实现](https://github.com/yishentu/claudian)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [DeepSeek Harness CLI help](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md)
- [DeepSeek headless profile](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/headless)
