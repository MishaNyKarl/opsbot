import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { escapeHtml } from "./telegram.js";

const execFileAsync = promisify(execFile);

export const SERVER_PING_INTERVAL_MS = 30 * 60 * 1000;

export class ServerMonitor {
  constructor({ storage, telegram }) {
    this.storage = storage;
    this.telegram = telegram;
    this.running = false;
  }

  async checkAll() {
    if (this.running) return [];
    this.running = true;

    const results = [];
    try {
      const servers = this.storage.listServers().filter((server) => server.enabled !== false);
      for (const server of servers) {
        results.push(await this.checkServer(server));
      }
    } finally {
      this.running = false;
    }

    return results;
  }

  async checkServer(server) {
    const result = await pingHost(server.host);
    const previousStatus = server.lastStatus;
    const nextStatus = result.ok ? "up" : "down";

    await this.storage.updateServer(server.id, {
      lastStatus: nextStatus,
      lastCheckedAt: new Date().toISOString(),
      lastError: result.ok ? null : result.error,
    });

    if (previousStatus && previousStatus !== nextStatus) {
      await this.notifyStatusChange(server, nextStatus, result.error);
    }

    if (!previousStatus && nextStatus === "down") {
      await this.notifyStatusChange(server, nextStatus, result.error);
    }

    return {
      server,
      status: nextStatus,
      error: result.error,
    };
  }

  async notifyStatusChange(server, status, error) {
    const message =
      status === "down"
        ? [
            "Alert: сервер недоступен",
            `Сервер: ${server.name}`,
            `Host: ${server.host}`,
            error ? `Ошибка: ${error}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        : ["Сервер восстановился", `Сервер: ${server.name}`, `Host: ${server.host}`].join("\n");

    const recipients = new Set();
    for (const user of this.storage.listUsers()) {
      if (user.role === "admin" && user.status === "active") recipients.add(user.telegramId);
    }
    for (const telegramId of server.subscribers ?? []) {
      const user = this.storage.getUser(telegramId);
      if (user?.status === "active") recipients.add(user.telegramId);
    }

    await Promise.all([...recipients].map((chatId) => this.safeSend(chatId, message)));
  }

  async safeSend(chatId, text) {
    try {
      await this.telegram.sendMessage(chatId, escapeHtml(text));
    } catch (error) {
      console.error(`Failed to send server alert to ${chatId}:`, error.message);
    }
  }
}

async function pingHost(host) {
  const args = process.platform === "win32" ? ["-n", "1", "-w", "3000", host] : ["-c", "1", "-W", "3", host];

  try {
    await execFileAsync("ping", args, { timeout: 5000 });
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: normalizePingError(error),
    };
  }
}

function normalizePingError(error) {
  const output = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n").trim();
  return output.split(/\r?\n/).slice(0, 2).join(" ").slice(0, 300) || "ping failed";
}
