export class TelegramClient {
  constructor(token) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async call(method, payload = {}) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.description || `Telegram ${method} failed with HTTP ${response.status}`);
    }
    return data.result;
  }

  async sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }

  async getUpdates(offset, timeout = 30) {
    return this.call("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message", "callback_query"],
    });
  }

  async answerCallbackQuery(callbackQueryId, text = "") {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  }
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
