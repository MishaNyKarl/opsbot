import { Bot } from "./bot.js";
import { getConfig } from "./config.js";
import { Monitor } from "./monitor.js";
import { ServerMonitor, SERVER_PING_INTERVAL_MS } from "./serverMonitor.js";
import { Storage } from "./storage.js";
import { TelegramClient } from "./telegram.js";

const config = getConfig();
const storage = new Storage(config.dataFile);
await storage.load();

for (const telegramId of config.adminIds) {
  const existing = storage.getUser(telegramId);
  if (!existing) {
    await storage.upsertUser({ telegramId, role: "admin", status: "active" });
  } else if (existing.role !== "admin" || existing.status !== "active") {
    await storage.upsertUser({ telegramId, role: "admin", status: "active" });
  }
}

const telegram = new TelegramClient(config.telegramToken);
const monitor = new Monitor({ storage, telegram });
const serverMonitor = new ServerMonitor({ storage, telegram });
const bot = new Bot({
  storage,
  telegram,
  monitor,
  serverMonitor,
  bootstrapAdminIds: config.adminIds,
});

setInterval(() => {
  monitor.checkAll().catch((error) => console.error("Scheduled monitor error:", error));
}, config.checkIntervalMs);

monitor.checkAll().catch((error) => console.error("Initial monitor error:", error));

setInterval(() => {
  serverMonitor.checkAll().catch((error) => console.error("Scheduled server ping error:", error));
}, SERVER_PING_INTERVAL_MS);

serverMonitor.checkAll().catch((error) => console.error("Initial server ping error:", error));

console.log(`Opsbot запущен. Интервал проверки сервисов: ${Math.round(config.checkIntervalMs / 60000)} мин. Интервал ping: ${Math.round(SERVER_PING_INTERVAL_MS / 60000)} мин.`);
await bot.startPolling();
