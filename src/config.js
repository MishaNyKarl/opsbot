import fs from "node:fs";
import path from "node:path";

export function loadEnv(filePath = ".env") {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function getConfig() {
  loadEnv();

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Нужно указать TELEGRAM_BOT_TOKEN. Скопируйте .env.example в .env и заполните токен.");
  }

  const adminIds = new Set(
    (process.env.ADMIN_TELEGRAM_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );

  const intervalMinutes = Math.max(
    1,
    Number.parseInt(process.env.CHECK_INTERVAL_MINUTES ?? "60", 10) || 60,
  );

  return {
    telegramToken: token,
    adminIds,
    checkIntervalMs: intervalMinutes * 60 * 1000,
    dataFile: path.resolve(process.env.DATA_FILE ?? "./data/opsbot.json"),
  };
}
