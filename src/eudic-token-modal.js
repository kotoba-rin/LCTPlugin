const { Modal, Notice, Setting } = require("obsidian");

const EUDIC_AUTHORIZATION_URL = "https://my.frdic.com/OpenAPI/Authorization";
const DEFAULT_SECRET_NAME = "lacan-eudic-api-token";

function openEudicTokenModal(plugin, onSaved = () => {}) {
  const modal = new Modal(plugin.app);
  let tokenInput;
  let saveButton;
  let saving = false;
  modal.onOpen = () => {
    modal.setTitle("欧路 API 授权码");
    const container = modal.contentEl;
    container.createEl("p", { text: "请先在法语助手授权页面获取个人授权码，再粘贴到下方。" });
    container.createEl("a", {
      text: EUDIC_AUTHORIZATION_URL,
      attr: { href: EUDIC_AUTHORIZATION_URL, target: "_blank", rel: "noopener noreferrer" },
    });
    new Setting(container)
      .setName("授权码")
      .setDesc("粘贴从法语助手获取的完整授权码。保存后存入 Obsidian 密钥存储。")
      .addText((text) => {
        tokenInput = text;
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text.inputEl.spellcheck = false;
        text.setPlaceholder("");
        text.inputEl.setAttribute("aria-label", "法语助手 API 授权码");
      });
    new Setting(container)
      .addButton((button) => button.setButtonText("取消").onClick(() => modal.close()))
      .addButton((button) => {
        saveButton = button;
        button.setButtonText("保存").setCta().onClick(async () => {
          if (saving) return;
          let token = tokenInput.getValue().trim();
          if (!token || /[\r\n]/.test(token) || token.length > 4096) {
            new Notice("请填写有效的欧路 API 授权码。");
            return;
          }
          saving = true;
          saveButton.setDisabled(true);
          try {
            // A newly entered credential belongs to this plugin, even if the old
            // setting pointed to a secret shared with another plugin.
            const name = DEFAULT_SECRET_NAME;
            plugin.app.secretStorage.setSecret(name, token);
            token = "";
            plugin.settings.frenchLookupSecretName = name;
            await plugin.saveSettings();
            modal.close();
            new Notice("欧路 API 授权码已保存。");
            onSaved();
          } catch (_error) {
            new Notice("保存授权码失败，请重试。");
          } finally {
            token = "";
            saving = false;
            saveButton.setDisabled(false);
          }
        });
      });
  };
  modal.onClose = () => {
    tokenInput?.setValue("");
    modal.contentEl.empty();
  };
  modal.open();
  return modal;
}

module.exports = { EUDIC_AUTHORIZATION_URL, openEudicTokenModal };
