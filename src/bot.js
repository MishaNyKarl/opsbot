import { formatCheckReport, getExpiredCount } from "./monitor.js";
import { escapeHtml } from "./telegram.js";

const SERVICE_NAMES = {
  porkbun: "Porkbun",
  proxyline: "Proxyline",
  darkshopping: "Darkshopping",
  datalix: "Datalix",
  virustotal_domains: "Virustotal домены",
};

export class Bot {
  constructor({ storage, telegram, monitor, serverMonitor, bootstrapAdminIds }) {
    this.storage = storage;
    this.telegram = telegram;
    this.monitor = monitor;
    this.serverMonitor = serverMonitor;
    this.bootstrapAdminIds = bootstrapAdminIds;
    this.offset = 0;
    this.pendingInputs = new Map();
  }

  async startPolling() {
    for (;;) {
      try {
        const updates = await this.telegram.getUpdates(this.offset, 30);
        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (update.message?.text) await this.handleMessage(update.message);
          if (update.callback_query) await this.handleCallback(update.callback_query);
        }
      } catch (error) {
        console.error("Ошибка polling:", error.message);
        await wait(3000);
      }
    }
  }

  async handleMessage(message) {
    const chatId = String(message.chat.id);
    await this.ensureUser(message);

    const text = message.text.trim();
    const pending = this.pendingInputs.get(chatId);

    try {
      if (pending && !text.startsWith("/")) {
        return this.handlePendingInput(message, pending, text);
      }

      if (text === "/start" || text === "/menu" || text === "/help") {
        return this.showMainMenu(chatId, message.from.id);
      }
      if (text === "/id") {
        return this.sendText(chatId, `Ваш Telegram ID: ${chatId}`, mainMenuKeyboard());
      }

      return this.showMainMenu(chatId, message.from.id);
    } catch (error) {
      return this.sendText(chatId, `Ошибка: ${error.message}`, mainMenuKeyboard());
    }
  }

  async handleCallback(query) {
    const chatId = String(query.message.chat.id);
    const userId = String(query.from.id);
    const data = query.data;

    await this.ensureUserFromCallback(query);
    await this.telegram.answerCallbackQuery(query.id);
    this.pendingInputs.delete(chatId);

    try {
      if (data === "menu") return this.showMainMenu(chatId, userId);
      if (data === "help") return this.showHelp(chatId, userId);
      if (data === "servers") return this.showServers(chatId, userId);
      if (data === "check_servers") return this.checkVisibleServersNow(chatId, userId);
      if (data === "add_server") return this.adminOnly(chatId, userId, () => this.askServerData(chatId));
      if (data.startsWith("server:")) {
        return this.showServerCard(chatId, userId, data.slice("server:".length));
      }
      if (data.startsWith("check_server:")) {
        return this.checkServerNow(chatId, userId, data.slice("check_server:".length));
      }
      if (data.startsWith("subscribe_server:")) {
        return this.subscribeServer(chatId, userId, data.slice("subscribe_server:".length));
      }
      if (data.startsWith("unsubscribe_server:")) {
        return this.unsubscribeServer(chatId, userId, data.slice("unsubscribe_server:".length));
      }
      if (data.startsWith("remove_server:")) {
        return this.adminOnly(chatId, userId, () => this.confirmRemoveServer(chatId, data.slice("remove_server:".length)));
      }
      if (data.startsWith("confirm_remove_server:")) {
        return this.adminOnly(chatId, userId, () => this.removeServer(chatId, data.slice("confirm_remove_server:".length)));
      }
      if (data === "my_accounts") return this.showBuyerAccounts(chatId, userId);
      if (data === "check_my") return this.runManualCheck(chatId, userId);
      if (data === "expired_my") return this.runManualCheck(chatId, userId, null, { showExpired: true });
      if (data.startsWith("check_account:")) {
        return this.runManualCheck(chatId, userId, data.slice("check_account:".length));
      }
      if (data.startsWith("expired_account:")) {
        return this.runManualCheck(chatId, userId, data.slice("expired_account:".length), { showExpired: true });
      }

      if (data === "admin") return this.adminOnly(chatId, userId, () => this.showAdminMenu(chatId));
      if (data === "pending_users") return this.adminOnly(chatId, userId, () => this.showPendingUsers(chatId));
      if (data.startsWith("approve:")) {
        return this.adminOnly(chatId, userId, () => this.approveUser(chatId, data.slice("approve:".length)));
      }
      if (data === "buyers") return this.adminOnly(chatId, userId, () => this.showBuyers(chatId));
      if (data.startsWith("buyer:")) {
        return this.adminOnly(chatId, userId, () => this.showBuyerCard(chatId, data.slice("buyer:".length)));
      }
      if (data.startsWith("add_account:")) {
        return this.adminOnly(chatId, userId, () => this.chooseService(chatId, data.slice("add_account:".length)));
      }
      if (data.startsWith("service:")) {
        const [, buyerId, service] = data.split(":");
        return this.adminOnly(chatId, userId, () => this.askAccountData(chatId, buyerId, service));
      }
      if (data === "all_accounts") return this.adminOnly(chatId, userId, () => this.showAllAccounts(chatId));
      if (data.startsWith("account:")) {
        return this.showAccountCard(chatId, userId, data.slice("account:".length));
      }
      if (data.startsWith("set_balance:")) {
        return this.askBalanceThreshold(chatId, userId, data.slice("set_balance:".length));
      }
      if (data.startsWith("set_expiry:")) {
        return this.askExpiryThreshold(chatId, userId, data.slice("set_expiry:".length));
      }
      if (data.startsWith("remove_account:")) {
        return this.adminOnly(chatId, userId, () => this.confirmRemoveAccount(chatId, data.slice("remove_account:".length)));
      }
      if (data.startsWith("confirm_remove_account:")) {
        return this.adminOnly(chatId, userId, () => this.removeAccount(chatId, data.slice("confirm_remove_account:".length)));
      }

      return this.sendText(chatId, "Не понял действие. Вернул главное меню.", mainMenuKeyboard());
    } catch (error) {
      return this.sendText(chatId, `Ошибка: ${error.message}`, mainMenuKeyboard());
    }
  }

  async ensureUser(message) {
    const telegramId = String(message.from.id);
    const existing = this.storage.getUser(telegramId);
    const isBootstrapAdmin = this.bootstrapAdminIds.has(telegramId);
    const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");

    if (!existing) {
      const user = await this.storage.upsertUser({
        telegramId,
        username: message.from.username ?? "",
        name,
        role: isBootstrapAdmin ? "admin" : "buyer",
        status: isBootstrapAdmin ? "active" : "pending",
      });
      if (!isBootstrapAdmin) await this.notifyAdminsAboutRequest(user);
      return;
    }

    const patch = { telegramId, username: message.from.username ?? "", name };
    if (isBootstrapAdmin && existing.role !== "admin") {
      patch.role = "admin";
      patch.status = "active";
    }
    await this.storage.upsertUser(patch);
  }

  async ensureUserFromCallback(query) {
    await this.ensureUser({
      from: query.from,
      chat: query.message.chat,
      text: "/menu",
    });
  }

  async showMainMenu(chatId, userId) {
    const user = this.storage.getUser(userId);

    if (user?.role === "admin" && user.status === "active") {
      return this.sendText(
        chatId,
        "Главное меню администратора.\nВыберите действие кнопками ниже.",
        keyboard([
          [{ text: "Админка", callback_data: "admin" }],
          [{ text: "Мои аккаунты", callback_data: "my_accounts" }],
          [{ text: "Серверы", callback_data: "servers" }],
          [{ text: "Проверить сейчас", callback_data: "check_my" }],
          [{ text: "Помощь", callback_data: "help" }],
        ]),
      );
    }

    if (user?.status !== "active") {
      return this.sendText(
        chatId,
        [
          "Вы зарегистрированы, но доступ еще не подтвержден администратором.",
          `Ваш Telegram ID: ${chatId}`,
          "После подтверждения я пришлю сообщение.",
        ].join("\n"),
        keyboard([[{ text: "Обновить статус", callback_data: "menu" }]]),
      );
    }

    return this.sendText(
      chatId,
      "Главное меню баера.",
      keyboard([
        [{ text: "Мои аккаунты", callback_data: "my_accounts" }],
        [{ text: "Серверы", callback_data: "servers" }],
        [{ text: "Проверить сейчас", callback_data: "check_my" }],
        [{ text: "Помощь", callback_data: "help" }],
      ]),
    );
  }

  async showHelp(chatId, userId) {
    const user = this.storage.getUser(userId);
    const text = [
      "Бот следит за балансами и сроками окончания сервисов.",
      "",
      "Баер видит свои аккаунты и может запустить ручную проверку.",
      "Админ подтверждает пользователей, добавляет аккаунты и задает пороги уведомлений.",
      "",
      "Почти все действия доступны кнопками. Текстом нужно отправлять только API-ключи, названия и числа порогов.",
      "",
      `Ваш Telegram ID: ${chatId}`,
    ].join("\n");

    return this.sendText(chatId, text, user?.role === "admin" ? adminBackKeyboard() : mainMenuKeyboard());
  }

  async showAdminMenu(chatId) {
    const pendingCount = this.storage.listUsers().filter((user) => user.status === "pending").length;

    return this.sendText(
      chatId,
      `Админка.\nНовых заявок: ${pendingCount}`,
      keyboard([
        [{ text: `Заявки на доступ (${pendingCount})`, callback_data: "pending_users" }],
        [{ text: "Баеры", callback_data: "buyers" }],
        [{ text: "Все аккаунты", callback_data: "all_accounts" }],
        [{ text: "Серверы", callback_data: "servers" }],
        [{ text: "Назад", callback_data: "menu" }],
      ]),
    );
  }

  async showPendingUsers(chatId) {
    const users = this.storage.listUsers().filter((user) => user.status === "pending");
    if (!users.length) return this.sendText(chatId, "Новых заявок нет.", adminBackKeyboard());

    return this.sendText(
      chatId,
      "Заявки на доступ:",
      keyboard([
        ...users.map((user) => [
          {
            text: `Подтвердить ${formatUserShort(user)}`,
            callback_data: `approve:${user.telegramId}`,
          },
        ]),
        [{ text: "Назад", callback_data: "admin" }],
      ]),
    );
  }

  async approveUser(chatId, telegramId) {
    const existing = this.storage.getUser(telegramId);
    if (!existing) {
      await this.storage.upsertUser({ telegramId, role: "buyer", status: "active" });
    } else {
      await this.storage.setUserRole(telegramId, existing.role === "admin" ? "admin" : "buyer");
    }

    await this.safeNotify(
      telegramId,
      "Доступ подтвержден. Теперь вы можете пользоваться ботом.",
      keyboard([
        [{ text: "Открыть меню", callback_data: "menu" }],
        [{ text: "Мои аккаунты", callback_data: "my_accounts" }],
      ]),
    );

    return this.sendText(
      chatId,
      `Пользователь ${telegramId} подтвержден. Я отправил ему уведомление.`,
      adminBackKeyboard(),
    );
  }

  async showBuyers(chatId) {
    const buyers = this.storage
      .listUsers()
      .filter((user) => user.role === "buyer" && user.status === "active");

    if (!buyers.length) return this.sendText(chatId, "Активных баеров пока нет.", adminBackKeyboard());

    return this.sendText(
      chatId,
      "Баеры:",
      keyboard([
        ...buyers.map((user) => [{ text: formatUserShort(user), callback_data: `buyer:${user.telegramId}` }]),
        [{ text: "Назад", callback_data: "admin" }],
      ]),
    );
  }

  async showBuyerCard(chatId, buyerId) {
    const buyer = this.storage.getUser(buyerId);
    if (!buyer) throw new Error("Баер не найден.");

    const accounts = this.storage.listAccounts({ buyerTelegramId: buyerId });
    return this.sendText(
      chatId,
      [`Баер: ${formatUserShort(buyer)}`, `ID: ${buyer.telegramId}`, `Аккаунтов: ${accounts.length}`].join("\n"),
      keyboard([
        [{ text: "Добавить аккаунт", callback_data: `add_account:${buyer.telegramId}` }],
        ...accounts.map((account) => [{ text: accountLabel(account), callback_data: `account:${account.id}` }]),
        [{ text: "Назад", callback_data: "buyers" }],
      ]),
    );
  }

  async chooseService(chatId, buyerId) {
    return this.sendText(
      chatId,
      "Какой сервис добавить баеру?",
      keyboard([
        [{ text: "Proxyline", callback_data: `service:${buyerId}:proxyline` }],
        [{ text: "Porkbun", callback_data: `service:${buyerId}:porkbun` }],
        [{ text: "Darkshopping", callback_data: `service:${buyerId}:darkshopping` }],
        [{ text: "Datalix", callback_data: `service:${buyerId}:datalix` }],
        [{ text: "Virustotal домены", callback_data: `service:${buyerId}:virustotal_domains` }],
        [{ text: "Назад", callback_data: `buyer:${buyerId}` }],
      ]),
    );
  }

  async askAccountData(chatId, buyerId, service) {
    this.pendingInputs.set(String(chatId), { type: "add_account", buyerId, service });
    const example = getAccountInputExample(service);

    return this.sendText(
      chatId,
      [
        `Добавляем ${SERVICE_NAMES[service]}.`,
        "Отправьте данные одним сообщением:",
        example,
        "",
        "Название лучше писать без пробелов, например proxyline_main.",
      ].join("\n"),
      keyboard([[{ text: "Отмена", callback_data: `buyer:${buyerId}` }]]),
    );
  }

  async showAllAccounts(chatId) {
    const accounts = this.storage.listAccounts();
    if (!accounts.length) return this.sendText(chatId, "Аккаунтов пока нет.", adminBackKeyboard());

    return this.sendText(
      chatId,
      "Все аккаунты:",
      keyboard([
        ...accounts.map((account) => [{ text: accountLabel(account), callback_data: `account:${account.id}` }]),
        [{ text: "Назад", callback_data: "admin" }],
      ]),
    );
  }

  async showServers(chatId, userId) {
    const user = this.storage.getUser(userId);
    if (user.status !== "active") return this.sendText(chatId, "Доступ еще не подтвержден.", mainMenuKeyboard());

    const servers = this.storage.listServers();
    const rows = servers.map((server) => [
      {
        text: `${serverStatusIcon(server)} ${server.name} (${server.host})`,
        callback_data: `server:${server.id}`,
      },
    ]);

    if (servers.length) {
      rows.push([{ text: "Проверить все серверы", callback_data: "check_servers" }]);
    }
    if (user.role === "admin") {
      rows.push([{ text: "Добавить сервер", callback_data: "add_server" }]);
    }
    rows.push([{ text: "Назад", callback_data: "menu" }]);

    return this.sendText(
      chatId,
      servers.length
        ? "Серверы для ping-мониторинга:"
        : "Серверов пока нет. Админ может добавить первый сервер.",
      keyboard(rows),
    );
  }

  async showServerCard(chatId, userId, serverId) {
    const user = this.storage.getUser(userId);
    const server = this.storage.getServer(serverId);
    if (!server) throw new Error("Сервер не найден.");
    if (user.status !== "active") return this.sendText(chatId, "Доступ еще не подтвержден.", mainMenuKeyboard());

    const isAdmin = user.role === "admin";
    const isSubscribed = (server.subscribers ?? []).includes(String(userId));
    const rows = [[{ text: "Проверить сейчас", callback_data: `check_server:${server.id}` }]];
    if (isSubscribed) {
      rows.push([{ text: "Отписаться от алертов", callback_data: `unsubscribe_server:${server.id}` }]);
    } else {
      rows.push([{ text: "Подписаться на алерты", callback_data: `subscribe_server:${server.id}` }]);
    }
    if (isAdmin) {
      rows.push([{ text: "Удалить сервер", callback_data: `remove_server:${server.id}` }]);
    }
    rows.push([{ text: "Назад", callback_data: "servers" }]);

    return this.sendText(
      chatId,
      [
        `Сервер: ${server.name}`,
        `Host: ${server.host}`,
        `Статус: ${formatServerStatus(server)}`,
        `Подписчиков: ${(server.subscribers ?? []).length}`,
        server.lastCheckedAt ? `Последняя проверка: ${formatDateTime(server.lastCheckedAt)}` : "Еще не проверялся",
        server.lastError ? `Последняя ошибка: ${server.lastError}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      keyboard(rows),
    );
  }

  async askServerData(chatId) {
    this.pendingInputs.set(String(chatId), { type: "add_server" });
    return this.sendText(
      chatId,
      [
        "Отправьте сервер одним сообщением:",
        "Название IP_или_HOST",
        "",
        "Например:",
        "proxy-1 192.0.2.10",
      ].join("\n"),
      keyboard([[{ text: "Отмена", callback_data: "servers" }]]),
    );
  }

  async subscribeServer(chatId, userId, serverId) {
    const user = this.storage.getUser(userId);
    if (user.status !== "active") return this.sendText(chatId, "Доступ еще не подтвержден.", mainMenuKeyboard());
    await this.storage.subscribeServer(serverId, userId);
    return this.sendText(
      chatId,
      "Подписка включена. Если сервер упадет или восстановится, вы получите уведомление.",
      keyboard([[{ text: "К серверу", callback_data: `server:${serverId}` }]]),
    );
  }

  async unsubscribeServer(chatId, userId, serverId) {
    const user = this.storage.getUser(userId);
    if (user.status !== "active") return this.sendText(chatId, "Доступ еще не подтвержден.", mainMenuKeyboard());
    await this.storage.unsubscribeServer(serverId, userId);
    return this.sendText(
      chatId,
      "Подписка отключена.",
      keyboard([[{ text: "К серверу", callback_data: `server:${serverId}` }]]),
    );
  }

  async confirmRemoveServer(chatId, serverId) {
    const server = this.storage.getServer(serverId);
    if (!server) throw new Error("Сервер не найден.");
    return this.sendText(
      chatId,
      `Удалить сервер?\n${server.name}\n${server.host}`,
      keyboard([
        [{ text: "Да, удалить", callback_data: `confirm_remove_server:${server.id}` }],
        [{ text: "Отмена", callback_data: `server:${server.id}` }],
      ]),
    );
  }

  async checkServerNow(chatId, userId, serverId) {
    const user = this.storage.getUser(userId);
    const server = this.storage.getServer(serverId);
    if (!server) throw new Error("Сервер не найден.");
    if (user.status !== "active") return this.sendText(chatId, "Доступ еще не подтвержден.", mainMenuKeyboard());

    await this.sendText(chatId, "Пингую сервер...");
    const result = await this.serverMonitor.checkServer(server);
    return this.sendText(
      chatId,
      [
        `Сервер: ${server.name}`,
        `Host: ${server.host}`,
        `Статус: ${formatPingResultStatus(result.status)}`,
        result.error ? `Ошибка: ${result.error}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      keyboard([[{ text: "К серверу", callback_data: `server:${server.id}` }]]),
    );
  }

  async checkVisibleServersNow(chatId, userId) {
    const user = this.storage.getUser(userId);
    if (user.status !== "active") return this.sendText(chatId, "Доступ еще не подтвержден.", mainMenuKeyboard());

    const servers = this.storage.listServers().filter((server) => {
      if (user.role === "admin") return true;
      return (server.subscribers ?? []).includes(String(userId));
    });

    if (!servers.length) {
      return this.sendText(
        chatId,
        user.role === "admin"
          ? "Серверов пока нет."
          : "У вас нет серверов в подписке. Откройте сервер и нажмите «Подписаться на алерты».",
        keyboard([[{ text: "К серверам", callback_data: "servers" }]]),
      );
    }

    await this.sendText(chatId, "Пингую серверы...");
    const results = [];
    for (const server of servers) {
      results.push(await this.serverMonitor.checkServer(server));
    }

    return this.sendText(
      chatId,
      [
        "Результат проверки серверов:",
        "",
        ...results.map((result, index) => {
          const status = formatPingResultStatus(result.status);
          const error = result.error ? `\n   ${result.error}` : "";
          return `${index + 1}. ${result.server.name} (${result.server.host}) — ${status}${error}`;
        }),
      ].join("\n"),
      keyboard([[{ text: "К серверам", callback_data: "servers" }]]),
    );
  }

  async removeServer(chatId, serverId) {
    const server = await this.storage.removeServer(serverId);
    return this.sendText(chatId, `Сервер удален: ${server.name}`, keyboard([[{ text: "К серверам", callback_data: "servers" }]]));
  }

  async showBuyerAccounts(chatId, userId) {
    const user = this.storage.getUser(userId);
    if (user.status !== "active") return this.sendText(chatId, "Доступ еще не подтвержден.", mainMenuKeyboard());

    const accounts = this.storage.listAccounts({ buyerTelegramId: user.telegramId });
    if (!accounts.length) {
      return this.sendText(chatId, "За вами пока не закреплены аккаунты.", mainMenuKeyboard());
    }

    return this.sendText(
      chatId,
      "Ваши аккаунты:",
      keyboard([
        ...accounts.map((account) => [{ text: accountLabel(account), callback_data: `account:${account.id}` }]),
        [{ text: "Проверить все", callback_data: "check_my" }],
        [{ text: "Назад", callback_data: "menu" }],
      ]),
    );
  }

  async showAccountCard(chatId, userId, accountId) {
    const account = this.storage.getAccount(accountId);
    if (!account) throw new Error("Аккаунт не найден.");
    const user = this.storage.getUser(userId);
    const isOwner = account.buyerTelegramId === String(userId);
    const isAdmin = user?.role === "admin" && user.status === "active";

    if (!isOwner && !isAdmin) {
      return this.sendText(chatId, "Этот аккаунт вам не доступен.", mainMenuKeyboard());
    }

    const buttons = [[{ text: "Проверить сейчас", callback_data: `check_account:${account.id}` }]];
    if (isOwner) {
      if (account.balanceThreshold !== null) {
        buttons.push([{ text: "Настроить баланс", callback_data: `set_balance:${account.id}` }]);
      }
      if (account.service !== "virustotal_domains") {
        buttons.push([{ text: "Настроить срок", callback_data: `set_expiry:${account.id}` }]);
      }
    }
    if (isAdmin) {
      buttons.push([{ text: "Удалить аккаунт", callback_data: `remove_account:${account.id}` }]);
    }
    buttons.push([{ text: "Назад", callback_data: isAdmin && !isOwner ? `buyer:${account.buyerTelegramId}` : "my_accounts" }]);

    return this.sendText(
      chatId,
      [
        accountLabel(account),
        `ID: ${account.id}`,
        `Баер: ${account.buyerTelegramId}`,
        account.service === "virustotal_domains"
          ? `Проверка: раз в день, вручную — по кнопке`
          : `Порог баланса: ${account.balanceThreshold ?? "не задан"}`,
        account.service === "virustotal_domains"
          ? null
          : `Уведомлять за: ${account.expiryThresholdDays ?? "не задано"} дн.`,
      ].filter(Boolean).join("\n"),
      keyboard(buttons),
    );
  }

  async askBalanceThreshold(chatId, userId, accountId) {
    this.ensureAccountOwner(userId, accountId);
    this.pendingInputs.set(String(chatId), { type: "set_balance", accountId, ownerId: String(userId) });
    return this.sendText(
      chatId,
      "Отправьте число: при каком балансе присылать уведомление.\nНапример: 50",
      keyboard([[{ text: "Отмена", callback_data: `account:${accountId}` }]]),
    );
  }

  async askExpiryThreshold(chatId, userId, accountId) {
    this.ensureAccountOwner(userId, accountId);
    this.pendingInputs.set(String(chatId), { type: "set_expiry", accountId, ownerId: String(userId) });
    return this.sendText(
      chatId,
      "Отправьте число дней до окончания, когда нужно прислать уведомление.\nНапример: 7",
      keyboard([[{ text: "Отмена", callback_data: `account:${accountId}` }]]),
    );
  }

  async handlePendingInput(message, pending, text) {
    const chatId = String(message.chat.id);
    this.pendingInputs.delete(chatId);

    if (pending.type === "add_server") {
      const [name, host] = text.split(/\s+/);
      if (!name || !host) {
        await this.sendText(chatId, "Не хватает данных. Нужно: Название IP_или_HOST", keyboard([[{ text: "К серверам", callback_data: "servers" }]]));
        return this.askServerData(chatId);
      }

      const server = await this.storage.addServer({ name, host });
      return this.sendText(
        chatId,
        `Сервер добавлен.\n${server.name}\n${server.host}`,
        keyboard([[{ text: "Открыть сервер", callback_data: `server:${server.id}` }]]),
      );
    }

    if (pending.type === "add_account") {
      const [name, apiKey, secretApiKey] = text.split(/\s+/);
      if (!name || !apiKey || (requiresSecondApiKey(pending.service) && !secretApiKey)) {
        await this.sendText(chatId, "Не хватает данных. Попробуйте еще раз.", adminBackKeyboard());
        return this.askAccountData(chatId, pending.buyerId, pending.service);
      }

      const account = await this.storage.addAccount({
        buyerTelegramId: pending.buyerId,
        service: pending.service,
        name,
        credentials: buildAccountCredentials(pending.service, apiKey, secretApiKey),
      });

      return this.sendText(
        chatId,
        `Аккаунт добавлен.\n${accountLabel(account)}\nID: ${account.id}`,
        keyboard([[{ text: "Открыть аккаунт", callback_data: `account:${account.id}` }]]),
      );
    }

    if (pending.type === "set_balance") {
      this.ensureAccountOwner(message.from.id, pending.accountId);
      const amount = Number(text.replace(",", "."));
      if (!Number.isFinite(amount)) throw new Error("Нужно отправить число.");
      await this.storage.updateAccount(pending.accountId, { balanceThreshold: amount });
      return this.sendText(
        chatId,
        `Порог баланса сохранен: ${amount}.`,
        keyboard([[{ text: "К аккаунту", callback_data: `account:${pending.accountId}` }]]),
      );
    }

    if (pending.type === "set_expiry") {
      this.ensureAccountOwner(message.from.id, pending.accountId);
      const days = Number.parseInt(text, 10);
      if (!Number.isInteger(days) || days < 0) throw new Error("Нужно отправить целое число дней.");
      await this.storage.updateAccount(pending.accountId, { expiryThresholdDays: days });
      return this.sendText(
        chatId,
        `Порог срока сохранен: ${days} дн.`,
        keyboard([[{ text: "К аккаунту", callback_data: `account:${pending.accountId}` }]]),
      );
    }
  }

  ensureAccountOwner(userId, accountId) {
    const account = this.storage.getAccount(accountId);
    if (!account) throw new Error("Аккаунт не найден.");
    if (account.buyerTelegramId !== String(userId)) {
      throw new Error("Пороги уведомлений может менять только владелец аккаунта.");
    }
    return account;
  }

  async removeAccount(chatId, accountId) {
    const account = this.storage.getAccount(accountId);
    if (!account) throw new Error("Аккаунт не найден.");
    await this.storage.removeAccount(accountId);
    return this.sendText(chatId, `Аккаунт удален: ${accountLabel(account)}`, adminBackKeyboard());
  }

  async confirmRemoveAccount(chatId, accountId) {
    const account = this.storage.getAccount(accountId);
    if (!account) throw new Error("Аккаунт не найден.");

    return this.sendText(
      chatId,
      `Удалить аккаунт?\n${accountLabel(account)}\nID: ${account.id}`,
      keyboard([
        [{ text: "Да, удалить", callback_data: `confirm_remove_account:${account.id}` }],
        [{ text: "Отмена", callback_data: `account:${account.id}` }],
      ]),
    );
  }

  async runManualCheck(chatId, userId, accountId = null, options = {}) {
    const user = this.storage.getUser(userId);
    if (user.status !== "active") return this.sendText(chatId, "Доступ еще не подтвержден.", mainMenuKeyboard());

    const accounts =
      user.role === "admin"
        ? this.storage.listAccounts({ accountId })
        : this.storage
            .listAccounts({ buyerTelegramId: user.telegramId })
            .filter((account) => !accountId || account.id === accountId);

    if (!accounts.length) return this.sendText(chatId, "Подходящих аккаунтов нет.", mainMenuKeyboard());

    await this.sendText(chatId, options.showExpired ? "Собираю истекшие..." : "Проверяю...");
    const reports = [];
    for (const account of accounts) {
      reports.push(...(await this.monitor.checkAll({
        accountId: account.id,
        force: true,
        onProgress: (event) => this.sendManualCheckProgress(chatId, event),
      })));
    }

    const expiredCount = reports.reduce((sum, report) => sum + getExpiredCount(report), 0);
    return this.sendText(
      chatId,
      reports.map((report) => formatCheckReport(report, { showExpired: options.showExpired })).join("\n\n"),
      checkResultKeyboard({ accountId, showExpired: options.showExpired, expiredCount }),
    );
  }

  async adminOnly(chatId, userId, action) {
    const user = this.storage.getUser(userId);
    if (user?.role !== "admin" || user.status !== "active") {
      return this.sendText(chatId, "Этот раздел доступен только администратору.", mainMenuKeyboard());
    }
    return action();
  }

  async sendText(chatId, text, replyMarkup = undefined) {
    const extra = replyMarkup ? { reply_markup: replyMarkup } : {};
    return this.telegram.sendMessage(chatId, escapeHtml(text), extra);
  }

  async safeNotify(chatId, text, replyMarkup = undefined) {
    try {
      await this.sendText(chatId, text, replyMarkup);
    } catch (error) {
      console.error(`Не удалось отправить сообщение ${chatId}:`, error.message);
    }
  }

  async sendManualCheckProgress(chatId, event) {
    if (event.account?.service !== "virustotal_domains") return;
    const text = formatManualCheckProgress(event);
    if (text) await this.safeNotify(chatId, text);
  }

  async notifyAdminsAboutRequest(user) {
    const admins = this.storage
      .listUsers()
      .filter((admin) => admin.role === "admin" && admin.status === "active");
    const text = [
      "Новая заявка на доступ",
      `Пользователь: ${formatUserShort(user)}`,
      `Telegram ID: ${user.telegramId}`,
    ].join("\n");
    const markup = keyboard([
      [{ text: "Подтвердить", callback_data: `approve:${user.telegramId}` }],
      [{ text: "Все заявки", callback_data: "pending_users" }],
    ]);
    await Promise.all(admins.map((admin) => this.safeNotify(admin.telegramId, text, markup)));
  }
}

function keyboard(inlineKeyboard) {
  return { inline_keyboard: inlineKeyboard };
}

function mainMenuKeyboard() {
  return keyboard([[{ text: "В меню", callback_data: "menu" }]]);
}

function adminBackKeyboard() {
  return keyboard([[{ text: "Назад в админку", callback_data: "admin" }]]);
}

function checkResultKeyboard({ accountId, showExpired, expiredCount }) {
  const rows = [];
  if (!showExpired && expiredCount > 0) {
    rows.push([
      {
        text: `Показать истекшие (${expiredCount})`,
        callback_data: accountId ? `expired_account:${accountId}` : "expired_my",
      },
    ]);
  }
  if (showExpired) {
    rows.push([
      {
        text: "К актуальным",
        callback_data: accountId ? `check_account:${accountId}` : "check_my",
      },
    ]);
  }
  rows.push([{ text: "В меню", callback_data: "menu" }]);
  return keyboard(rows);
}

function accountLabel(account) {
  return `${SERVICE_NAMES[account.service] ?? account.service}: ${account.name}`;
}

function getAccountInputExample(service) {
  if (service === "porkbun") return "Название API_KEY SECRET_KEY";
  if (service === "virustotal_domains") return "Название VIRUSTOTAL_API_KEY OPSVAULT_API_KEY";
  return "Название API_KEY";
}

function requiresSecondApiKey(service) {
  return service === "porkbun" || service === "virustotal_domains";
}

function buildAccountCredentials(service, apiKey, secretApiKey = "") {
  if (service === "porkbun") {
    return { apiKey, secretApiKey };
  }
  if (service === "datalix") {
    return { apiKey, baseUrl: "https://backend.datalix.de/v1" };
  }
  if (service === "virustotal_domains") {
    return { apiKey, opsvaultApiKey: secretApiKey };
  }
  return { apiKey, secretApiKey: "", baseUrl: "" };
}

function formatManualCheckProgress(event) {
  const accountName = event.account?.name ?? "аккаунт";
  if (event.type === "domains.load_started") {
    return `${accountName}: загружаю домены из OpsVault.`;
  }
  if (event.type === "domains.accepted") {
    if (event.total === 0) return `${accountName}: активных Porkbun-доменов для проверки нет.`;
    return `${accountName}: принято на проверку ${event.total} доменов. Размер пачки: ${event.batchSize}, пачек: ${event.totalBatches}.`;
  }
  if (event.type === "batch.started") {
    return `${accountName}: пачка ${event.batchNumber}/${event.totalBatches} принята на проверку (${event.size} дом.).`;
  }
  if (event.type === "batch.finished") {
    return `${accountName}: пачка ${event.batchNumber}/${event.totalBatches} прошла.\nПроверено: ${event.checked}/${event.total}\nПроблем: ${event.problems}\nОшибок после ретраев: ${event.errors}`;
  }
  if (event.type === "batch.waiting") {
    return `${accountName}: жду ${event.waitSeconds} сек. до следующей пачки, чтобы не превысить лимит VirusTotal.`;
  }
  return null;
}

function serverStatusIcon(server) {
  if (server.lastStatus === "up") return "OK";
  if (server.lastStatus === "down") return "DOWN";
  if (server.confirmingOutage) return "CHECK";
  return "NEW";
}

function formatServerStatus(server) {
  if (server.lastStatus === "up") return "доступен";
  if (server.lastStatus === "down") return "недоступен";
  if (server.confirmingOutage) return "перепроверяется";
  return "неизвестен";
}

function formatPingResultStatus(status) {
  if (status === "up") return "доступен";
  if (status === "down") return "недоступен";
  if (status === "suspect") return "ошибка ping, идет перепроверка 10 минут";
  return status;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

function formatUserShort(user) {
  const username = user.username ? `@${user.username}` : "";
  const name = user.name || "без имени";
  return `${name} ${username}`.trim() || user.telegramId;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
