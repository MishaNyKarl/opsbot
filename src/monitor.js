import { getServiceSnapshot } from "./providers/index.js";
import { escapeHtml } from "./telegram.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export class Monitor {
  constructor({ storage, telegram }) {
    this.storage = storage;
    this.telegram = telegram;
    this.running = false;
  }

  async checkAll({ accountId } = {}) {
    if (this.running) return [];
    this.running = true;

    const reports = [];
    try {
      const accounts = this.storage.listAccounts({ accountId });
      for (const account of accounts) {
        reports.push(await this.checkAccount(account));
      }
    } finally {
      this.running = false;
    }

    return reports;
  }

  async checkAccount(account) {
    const report = {
      account,
      ok: false,
      alerts: [],
      error: null,
      snapshot: null,
    };

    try {
      const snapshot = await getServiceSnapshot(account);
      report.snapshot = snapshot;
      report.ok = true;

      if (account.balanceThreshold !== null && snapshot.balance.amount <= account.balanceThreshold) {
        const key = [
          "balance",
          account.id,
          new Date().toISOString().slice(0, 10),
        ].join(":");

        if (!this.storage.hasSentAlert(key)) {
          const message = [
            "Уведомление о низком балансе",
            `Сервис: ${account.service}`,
            `Аккаунт: ${account.name}`,
            `Баланс: ${snapshot.balance.display}`,
            `Порог: ${account.balanceThreshold}`,
          ].join("\n");
          await this.notifyAccount(account, message);
          await this.storage.markAlertSent(key);
          report.alerts.push(message);
        }
      }

      if (account.expiryThresholdDays !== null) {
        const now = Date.now();
        for (const item of snapshot.expirations) {
          if (!item.endsAt) continue;
          const msLeft = new Date(item.endsAt).getTime() - now;
          if (msLeft <= 0) continue;

          const daysLeft = Math.ceil(msLeft / DAY_MS);
          if (daysLeft > account.expiryThresholdDays) continue;

          const key = ["expiry", account.id, item.id, new Date().toISOString().slice(0, 10)].join(":");
          if (this.storage.hasSentAlert(key)) continue;

          const message = [
            item.kind === "payment" ? "Уведомление об оплате" : "Уведомление об окончании срока",
            `Сервис: ${account.service}`,
            `Аккаунт: ${account.name}`,
            `Объект: ${item.label}`,
            `Окончание: ${formatDate(item.endsAt)}`,
            item.amountDue !== undefined ? `Сумма к оплате: ${formatMoney(item.amountDue, item.currency)}` : null,
            `Срок: ${formatDaysLeft(item.endsAt)}`,
          ].filter(Boolean).join("\n");
          await this.notifyAccount(account, message);
          await this.storage.markAlertSent(key);
          report.alerts.push(message);
        }
      }

      for (const status of snapshot.statuses ?? []) {
        if (status.status !== "error") continue;

        const key = ["status", account.id, status.id, "error", new Date().toISOString().slice(0, 10)].join(":");
        if (this.storage.hasSentAlert(key)) continue;

        const message = [
          "Alert: сервер Datalix в статусе error",
          `Сервис: ${account.service}`,
          `Аккаунт: ${account.name}`,
          `Сервер: ${status.label}`,
          `Статус: ${status.statusLabel ?? status.status}`,
        ].join("\n");
        await this.notifyAccount(account, message);
        await this.storage.markAlertSent(key);
        report.alerts.push(message);
      }
    } catch (error) {
      report.error = error;
      await this.notifyAdmins(`Ошибка мониторинга ${account.service}/${account.name}: ${error.message}`);
    }

    return report;
  }

  async notifyAccount(account, text) {
    const buyer = this.storage.getUser(account.buyerTelegramId);
    if (buyer?.status === "active") await this.safeSend(buyer.telegramId, text);
  }

  async notifyAdmins(text) {
    const admins = this.storage
      .listUsers()
      .filter((user) => user.role === "admin" && user.status === "active")
      .map((user) => user.telegramId);
    await Promise.all(admins.map((chatId) => this.safeSend(chatId, text)));
  }

  async safeSend(chatId, text) {
    try {
      await this.telegram.sendMessage(chatId, escapeHtml(text));
    } catch (error) {
      console.error(`Failed to send Telegram message to ${chatId}:`, error.message);
    }
  }
}

export function formatCheckReport(report, options = {}) {
  if (!report.ok) {
    return `${report.account.name}: ошибка - ${report.error?.message ?? "неизвестная ошибка"}`;
  }

  const showExpired = options.showExpired === true;
  const balance = formatBalance(report.snapshot.balance);
  const expiring = report.snapshot.expirations
    .filter((item) => item.endsAt && (showExpired ? isExpired(item.endsAt) : !isExpired(item.endsAt)))
    .sort((a, b) => new Date(a.endsAt) - new Date(b.endsAt))
    .slice(0, 8)
    .map((item, index) => {
      const amount = item.amountDue !== undefined ? `\n   К оплате: ${formatMoney(item.amountDue, item.currency)}` : "";
      return `${index + 1}. ${item.label}\n   ${formatDate(item.endsAt)} (${formatDaysLeft(item.endsAt)})${amount}`;
    });
  const statusErrors = (report.snapshot.statuses ?? [])
    .filter((status) => status.status === "error")
    .map((status, index) => `${index + 1}. ${status.label} — ${status.statusLabel ?? status.status}`);
  const title = showExpired ? "Истекшие прокси, домены и серверы" : "Ближайшие окончания и оплаты";
  const emptyText = showExpired
    ? "Истекшие прокси, домены и серверы: нет"
    : "Ближайшие окончания и оплаты: нет активных объектов со сроками";

  return [
    `Аккаунт: ${report.account.name}`,
    `Сервис: ${formatService(report.account.service)}`,
    `Баланс: ${balance}`,
    statusErrors.length ? `Ошибки статуса:\n${statusErrors.join("\n")}` : null,
    "",
    expiring.length ? `${title}:\n${expiring.join("\n")}` : emptyText,
  ].filter((line) => line !== null).join("\n");
}

export function getExpiredCount(report) {
  if (!report.ok) return 0;
  return report.snapshot.expirations.filter((item) => item.endsAt && isExpired(item.endsAt)).length;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

function formatBalance(balance) {
  const currency = balance.currency ? ` ${balance.currency}` : "";
  const amount = Number.isFinite(balance.amount) ? `${balance.amount}${currency}` : balance.display;
  if (balance.display?.includes(amount)) return balance.display;
  if (!balance.display || balance.display === amount) return amount;
  return `${amount} (${balance.display})`;
}

function formatMoney(amount, currency = "") {
  const suffix = currency ? ` ${currency}` : "";
  return `${amount}${suffix}`;
}

function formatDaysLeft(value) {
  const end = new Date(value).getTime();
  const now = Date.now();
  const diffMs = end - now;

  if (diffMs > 0) {
    const diffDays = Math.ceil(diffMs / DAY_MS);
    return `осталось ${diffDays} ${plural(diffDays, "день", "дня", "дней")}`;
  }

  const overdueDays = Math.max(1, Math.ceil(Math.abs(diffMs) / DAY_MS));
  return `истекло ${overdueDays} ${plural(overdueDays, "день", "дня", "дней")} назад`;
}

function isExpired(value) {
  return new Date(value).getTime() < Date.now();
}

function plural(value, one, few, many) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function formatService(service) {
  if (service === "porkbun") return "Porkbun";
  if (service === "proxyline") return "Proxyline";
  if (service === "darkshopping") return "Darkshopping";
  if (service === "datalix") return "Datalix";
  return service;
}
