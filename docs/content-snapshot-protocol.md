# 公开文库快照协议

文库同步使用 HTTPS 版本清单和文件 SHA-256，不依赖读者电脑上的 Git，也不区分 Reader 与 Editer。Git 仅用于维护者在发布前选择一个确定的已提交内容版本。

## 从 GitHub reading 分支更新

公开同步文库使用内容仓库的 `reading` 分支；`main` 保存带建言的原版。内容仓库的发布脚本从确定的 `main` 提交生成去建言版本，并在 `.reading-source.json` 中记录原始提交、转换版本和处理数量。不要将工作树中的未提交稿件直接打包发布。

维护者在服务端部署本仓库的 `scripts/import-reading-library.py`、`scripts/build-project-snapshot.py`，以及已审核的内容仓库 `scripts/publish_reading_branch.py`，然后按需或定时运行：

```bash
python3 scripts/import-reading-library.py \
  --source-url https://github.com/kotoba-rin/Lacan-Chinese-Translation-Project.git \
  --cache-dir /path/to/private-reading-cache \
  --output-dir /path/to/public-library \
  --base-url https://example.com/lctp-library/releases \
  --validator-script /path/to/trusted/publish_reading_branch.py
```

导入器只抓取 `reading`，不回退到 `main`。它检查分支中的来源记录，再由维护者部署的本地校验脚本核对转换结果；不会执行下载仓库里的代码。Git 缓存必须位于公开文库目录之外。同一版本不重复构建，并发任务通过文件锁互斥。抓取、来源校验或构建失败时，当前公开版本保持不变。代理可以通过任务自身的 `HTTPS_PROXY` 环境变量配置，无须修改整台机器的网络设置。

WordPress 继续使用下述只读版本接口和同源的单文件地址。客户端先读取清单，初始化研讨班时只同步术语表；点击课次同步时才获取对应原文、译文及引用的附件，不需要下载完整 ZIP。

## 生成快照

```bash
python3 scripts/build-project-snapshot.py \
  --source-root /path/to/Lacan-Chinese-Translation-Project \
  --output-dir /path/to/snapshot-output \
  --base-url https://kotoba-rin.com/lctp-library/releases \
  --revision HEAD
```

`--source-root` 必须为内容仓库根目录。脚本读取指定提交的 Git 对象，不读取工作树中的修改，也不会收录未跟踪文件。`--revision` 可指定本地分支、标签或提交。整个构建过程不访问 GitHub。

默认版本为 `r-<提交短 SHA>-<内容摘要>`；也可使用 `--version` 指定一个新的版本名称。版本目录一经创建便不可变：重复构建会校验并复用相同内容，内容不同或已有文件损坏时拒绝覆盖。

输出结构：

```text
snapshot-output/
  latest.json
  releases/<version>/
    release.json
    manifest.json
    project.zip
    files/
      README.md
      LICENSE
      texts/...
      知识库/...
      术语表/...
      assets/...
```

`release.json` 保存该不可变版本首次生成时的发布信息，供维护者复用版本；客户端只需读取公开接口返回的相同元数据。`latest.json` 在完整版本生成、校验或复用成功后才原子替换。构建失败保留先前的 `latest.json`。

## 内容范围

公开内容目录为 `texts/`、`知识库/`、`术语表/`、`assets/`，另包含根目录的 `README.md`、`LICENSE`、`LICENSE.md` 和 `NOTICE.md`（存在时）。内容目录中的文件扩展名限定为：

```text
.md .jpeg .jpg .png .gif .svg .webp .avif .bmp .tif .tiff
.emf .wmf .pdf .csv .txt
```

隐藏文件、隐藏目录、配置与代码文件不进入快照。`.git/`、`.obsidian/`、插件凭据、会话与工作区配置都不属于公开内容。发布笔记来自指定提交；用户未提交的私人笔记不会被自动打包。

路径保留原始目录结构和 UTF-8 文件名，要求 Unicode NFC。构建拒绝符号链接、目录穿越、Windows 保留名称、非法字符、末尾空格或句点，以及大小写冲突。文件数量上限为 25,000；每个文件上限为 64 MiB，解压后总量上限为 512 MiB，压缩包上限为 256 MiB。

## 最新版本接口

公开只读接口为 `GET https://kotoba-rin.com/wp-json/lctp/v1/project`。它返回 `latest.json` 的内容，不在读者请求期间拉取仓库或重新压缩。接口不需要读者的 WordPress 账号或应用密码。

```json
{
  "schema_version": 1,
  "version": "r-0123456789ab-a1b2c3d4e5f6",
  "source_revision": "0123456789abcdef0123456789abcdef01234567",
  "published_at": "2026-11-09T12:00:00Z",
  "manifest_url": "https://kotoba-rin.com/lctp-library/releases/r-0123456789ab-a1b2c3d4e5f6/manifest.json",
  "manifest_sha256": "<64 lowercase hex characters>",
  "archive_url": "https://kotoba-rin.com/lctp-library/releases/r-0123456789ab-a1b2c3d4e5f6/project.zip",
  "archive_sha256": "<64 lowercase hex characters>",
  "archive_size": 123456,
  "file_count": 1
}
```

`source_revision` 用于追溯发布来源，客户端不据此调用 Git。最新版本入口使用 `Cache-Control: no-cache` 与内容 `ETag` 重新验证，避免缓存长期滞后；固定版本的清单、ZIP 与文件可使用长期不可变缓存。

## 文件清单与初装包

```json
{
  "schema_version": 1,
  "version": "r-0123456789ab-a1b2c3d4e5f6",
  "files": [
    {
      "path": "texts/s14-la-logique-du-fantasme/translation/Leçon-01.md",
      "size": 1024,
      "sha256": "<64 lowercase hex characters>",
      "url": "https://kotoba-rin.com/lctp-library/releases/r-0123456789ab-a1b2c3d4e5f6/files/texts/s14-la-logique-du-fantasme/translation/Le%C3%A7on-01.md"
    }
  ]
}
```

`size` 和 `sha256` 始终针对原文件字节，包括换行和二进制图片。URL 对 UTF-8 路径进行百分号编码。清单中的文件与 ZIP 条目一一对应，ZIP 中没有额外包裹目录。ZIP 固定条目顺序、时间戳与权限，同一内容生成相同压缩包。

首次导入空文库可使用完整 ZIP；后续同步比较清单与本地已应用基线，仅获取需要的原始文件。无变更时无需重新下载正文或图片。文件从新清单消失代表上游删除；客户端仍须判断本地是否修改过，不能据此直接删除用户文件。

客户端在写入前校验路径、版本、完整性和大小。本地文件与上次成功同步的校验值不同，就跳过该文件所属的整课原译文及引用附件，不执行自动合并。改译文、备注、注释、建言、空白和格式都按同一规则保护。既有文件缺少可信基线且与发布版本不同，也保守跳过。

被跳过文件的正文和基线都不推进，再次同步仍会跳过。缺失的本地文件在用户点击同步时重新下载，即使曾有旧版删除记录，也不再产生本地删除冲突。恢复成功后仅清除对应文件的旧删除状态；未选择课次和其他旧版冲突记录保留。历史冲突记录只读展示，不提供覆盖保存入口。

下载前、下载后和写入时都检查本地正文与编辑器草稿。若期间发生变化，撤回本课由同步写入的内容，保留用户的新修改并返回跳过记录。真正的网络、校验和存储失败仍作为错误处理。事务备份、恢复日志及原子状态替换继续使用；同步基线与缓存不上传服务器。

发布顺序为先提供完整的固定版本文件，再更新最新版本入口。部署者需实际验证 HTTPS、中文路径、缓存响应头与完整包下载，确保客户端下载过程中不会混入另一个版本。
