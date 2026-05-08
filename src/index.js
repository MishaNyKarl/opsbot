import { Bot } from "./bot.js";
import { getConfig } from "./config.js";
import { Monitor } from "./monitor.js";
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
const bot = new Bot({
  storage,
  telegram,
  monitor,
  bootstrapAdminIds: config.adminIds,
});

setInterval(() => {
  monitor.checkAll().catch((error) => console.error("Scheduled monitor error:", error));
}, config.checkIntervalMs);

monitor.checkAll().catch((error) => console.error("Initial monitor error:", error));

console.log(`Opsbot запущен. Интервал проверки: ${Math.round(config.checkIntervalMs / 3600000)} ч.`);
await bot.startPolling();
