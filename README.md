# Lacan Translation Helper

[中文说明](README.zh-CN.md)

Read and edit French–Chinese Lacan seminar texts in Obsidian, with aligned paragraphs, reading notes, fork comparison, French lookup, and a Codex-powered analysis sidebar.

This is the standalone source repository for the **Lacan Translation Helper** desktop plugin, extracted from the [Lacan Chinese Translation Project](https://github.com/Kotoba-Rin/Lacan-Chinese-Translation-Project). The plugin ID remains `lacan-translation-helper`. The translation project remains the default **content** upstream; this repository is the **plugin code** upstream. Seminar texts are maintained separately.

The project-specific features expect this vault layout and stable segment IDs:

```text
texts/<seminar>/
  original/Leçon-01.md
  translation/Leçon-01.md
  notes/
  glossary.md
```

Paragraphs are aligned by comments such as `<!-- id: s8-01-0001 -->`; merged translations can also declare `<!-- ids: ... -->`. The interface and generated reading aids currently primarily use Chinese.

## Features

- Open French–Chinese bilingual reading views, search within them, and navigate by segment ID.
- Edit an entire Chinese translation, annotation, or suggestion block in place. Paste images using the vault's attachment settings; pasted attachments are created immediately and remain if the edit is cancelled.
- Create chapter reading notes with the selected segment's original, translation, annotations, and suggestions.
- Generate translation skeletons, track `<!-- untranslated -->` markers, and browse lesson status through Obsidian Bases when that API is available.
- Sync the translation project's upstream and compare multiple forks paragraph by paragraph.
- Read PDFs with Obsidian's built-in viewer, and look up selectable French text. Scanned pages need a text layer supplied by OCR elsewhere.
- Look up French words in the online Frdic dictionary, translate selected phrases through Codex, use system French speech, and save words to a chosen Eudic wordbook.
- Open read-only segment interpretation or original-text translation in a sidebar with streaming replies, follow-up questions, multiple conversations, and automatic discovery of the configured Codex agent's Skills.

## Requirements

- Obsidian **desktop**, version **1.8.0 or later** as declared in the manifest. Features that depend on newer Obsidian APIs are guarded and may be unavailable on older versions.
- A vault using the translation project's file layout for seminar-specific features. Existing project users can keep using their current vault.
- **Git CLI** on the Obsidian process's `PATH` for content synchronization and fork comparison.
- **Codex CLI**, authenticated in your terminal and compatible with `codex app-server`, for AI features. Set its absolute executable path in the plugin's **AI 功能** settings if Obsidian cannot find it through `PATH`. Codex is not installed by this plugin.
- An **Eudic API authorization token** only if you want to read or update Eudic wordbooks. Public dictionary lookup does not use this token.
- **Node.js 20+ and npm** for development and building from source. Normal use of an already built plugin does not require a separate Node installation.

Codex and Eudic services may require third-party accounts, subscriptions, or usage payments. Those services handle their own access and charges; the plugin does not supply accounts or service credits.

## Install from source

Clone this repository into a development directory separate from your content vault, then run:

```bash
npm ci
npm run build
npm run install:plugin -- /absolute/path/to/your/vault
```

The install command copies the three runtime files into `<vault>/.obsidian/plugins/lacan-translation-helper/`. Existing plugin settings and conversation history are kept. Close and reopen the plugin in Obsidian's **Community plugins** settings to load the new build.

For a manual install, copy only `main.js`, `manifest.json`, and `styles.css` into that plugin directory. Keep personal `data.json`, credentials, and conversation data out of Git and distributable archives.

The vault for seminar reading is the root of your local [translation project](https://github.com/Kotoba-Rin/Lacan-Chinese-Translation-Project). Installing this source repository does not download the seminar content or submit the plugin to the Obsidian Community directory.

## Content synchronization

The **项目与同步** settings configure the content repository, branch, and optional fork repositories. The default content upstream is `Kotoba-Rin/Lacan-Chinese-Translation-Project`, even though the plugin source now lives in `kotoba-rin/LCTPlugin`.

**Back up or commit your vault changes before using Reader synchronization.** Reader mode aligns the working tree with the selected upstream using Git operations that can overwrite local changes and remove untracked files. Use **Editer** mode when you want to keep editing the current working files while refreshing comparison branches. Automatic synchronization on startup is disabled by default.

## Network, files, and privacy

The following disclosures apply to the optional online features and local integrations:

| Feature | Data and access |
| --- | --- |
| Content synchronization | Invokes the local Git executable to contact the configured upstream and forks, and changes Git state and content inside the vault. An optional GitHub proxy uses the URL you configure. |
| Dictionary lookup | Sends the queried word or phrase to `https://www.frdic.com` and displays dictionary material, including dictionary images where provided. Automatic selection lookup is enabled by default and can be disabled in **法语取词** settings. |
| Wordbooks | Sends your token to `https://api.frdic.com` and reads your wordbooks, checks word membership, and adds words at your request. Obtain a token through the linked Frdic authorization page. |
| Quick selection translation | Sends the selected text and nearby context through your local Codex process to its configured model provider. Automatic phrase translation is enabled by default in **法语取词** settings. This feature has its own trigger and is not controlled by the segment-AI enable switch. Disable automatic translation, or automatic lookup entirely, if you do not want selections to trigger model requests. |
| Segment interpretation | Sends the target translation, aligned original paragraphs, neighboring text, relevant glossary entries, and linked notes through Codex. The agent can read additional material within the current seminar under its read-only policy. Its default prompt requests web search with French, German, or English sources. |
| Original-text analysis | Sends the selected original segment and assembled original/translation context through Codex. The first answer is a translation; the mode does not proactively request external research. |
| Skills and MCP | Queries the configured Codex agent's installed Skills and may read their definitions and supporting files outside the vault. MCP is off by default; if you explicitly enable named servers, their tools and data flows depend on those services. Apps and Plugins integrations remain disabled in this runtime. |
| French speech | Uses the operating system/browser speech synthesis API and available French voices; processing depends on the selected system voice. |

**A local Agent is a local process, not a guarantee of local model inference.** Text sent to Codex can leave your computer according to your model-provider configuration and its policies. The plugin uses your existing Codex authentication; it does not silently fall back to a separate model API.

Segment AI is disabled by default. Its runtime requests a read-only sandbox, denies permission escalation, and instructs the agent not to edit source text, translations, glossaries, or notes. Quick selection translation uses an ephemeral thread with research and MCP disabled. These AI policies are separate from editing, note creation, and Git synchronization that you initiate through the plugin.

The plugin stores settings, segment conversation history, and drafts in its local `data.json`. Codex manages its own authentication, configuration, and thread storage outside the vault. Closing a conversation tab does not delete its history. The Eudic token uses Obsidian SecretStorage when available; on older Obsidian versions it is kept only for the current run, rather than written to `data.json`. Review your vault synchronization or backup settings if local conversation history is sensitive.

The plugin does not include client-side usage analytics or a developer-operated telemetry endpoint. Third-party services process requests under their own terms and privacy policies.

## Development

```bash
npm ci
npm run build
npm run build:check
npm test
npm run package:plugin
```

- `src/main.js` is the plugin entry point; `segment-ai/` contains the Codex integration and domain modules.
- `main.js` is the bundled file Obsidian loads. Keep it consistent with source when committing.
- `npm run package:plugin` produces the three distributable runtime files in `dist/`.
- The tests use mocks and fixtures; passing them does not demonstrate live Codex authentication, remote dictionary availability, or every Obsidian interaction.

## Documentation

- [French lookup and Eudic wordbooks](docs/french-lookup.md)
- [PDF reading](docs/pdf-reading.md)
- [Original-text analysis](docs/original-analysis.md)
- [Chapter reading notes](docs/chapter-reading-notes.md)
- [Automatic Skills discovery](docs/segment-ai-skills.md)
- [Segment AI architecture](docs/segment-ai-interpretation-architecture.md)
- [Multi-conversation architecture and historical design](docs/segment-ai-multi-session-architecture.md)

Some architecture documents retain historical decisions. The current code and the Skills discovery document take precedence where later changes are explicitly noted.

Report plugin bugs and feature requests in [this repository's Issues](https://github.com/kotoba-rin/LCTPlugin/issues). Text corrections belong in the translation project.

## License and origin

This migration preserves the upstream **CC BY 4.0** license. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for the retained license and source attribution.
