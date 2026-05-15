import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA = {
  users: [],
  accounts: [],
  servers: [],
  sentAlerts: [],
  meta: {
    version: 1,
  },
};

const DEFAULT_THRESHOLDS = {
  porkbun: {
    balanceThreshold: 10,
    expiryThresholdDays: null,
  },
  proxyline: {
    balanceThreshold: 10,
    expiryThresholdDays: 3,
  },
  darkshopping: {
    balanceThreshold: 2000,
    expiryThresholdDays: null,
  },
  datalix: {
    balanceThreshold: null,
    expiryThresholdDays: 2,
  },
};

const DEFAULT_CREDENTIALS = {
  datalix: {
    baseUrl: "https://backend.datalix.de/v1",
  },
};

export class Storage {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = structuredClone(DEFAULT_DATA);
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const content = await fs.readFile(this.filePath, "utf8");
      this.data = {
        ...structuredClone(DEFAULT_DATA),
        ...JSON.parse(content),
      };
      let changed = false;
      for (const account of this.data.accounts) {
        changed = applyAccountDefaults(account) || changed;
      }
      if (changed) await this.save();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.save();
    }
  }

  async save() {
    this.writeQueue = this.writeQueue.then(async () => {
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeFile(tmpPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
      await fs.rename(tmpPath, this.filePath);
    });
    return this.writeQueue;
  }

  listUsers() {
    return this.data.users;
  }

  getUser(telegramId) {
    return this.data.users.find((user) => user.telegramId === String(telegramId));
  }

  async upsertUser(user) {
    const telegramId = String(user.telegramId);
    const existing = this.getUser(telegramId);
    const now = new Date().toISOString();

    if (existing) {
      Object.assign(existing, user, { telegramId, updatedAt: now });
    } else {
      this.data.users.push({
        telegramId,
        role: "buyer",
        status: "pending",
        createdAt: now,
        updatedAt: now,
        ...user,
      });
    }

    await this.save();
    return this.getUser(telegramId);
  }

  async setUserRole(telegramId, role) {
    const user = this.getUser(telegramId);
    if (!user) throw new Error(`User ${telegramId} is not registered`);
    user.role = role;
    user.status = "active";
    user.updatedAt = new Date().toISOString();
    await this.save();
    return user;
  }

  listAccounts({ buyerTelegramId, accountId } = {}) {
    return this.data.accounts.filter((account) => {
      if (buyerTelegramId && account.buyerTelegramId !== String(buyerTelegramId)) return false;
      if (accountId && account.id !== accountId) return false;
      return !account.deletedAt;
    });
  }

  getAccount(accountId) {
    return this.listAccounts({ accountId })[0];
  }

  async addAccount(input) {
    const now = new Date().toISOString();
    const account = {
      id: `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      buyerTelegramId: String(input.buyerTelegramId),
      service: input.service,
      name: input.name,
      credentials: input.credentials,
      balanceThreshold: input.balanceThreshold,
      expiryThresholdDays: input.expiryThresholdDays,
      createdAt: now,
      updatedAt: now,
    };
    applyAccountDefaults(account);

    this.data.accounts.push(account);
    await this.save();
    return account;
  }

  async removeAccount(accountId) {
    const account = this.getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    account.deletedAt = new Date().toISOString();
    await this.save();
    return account;
  }

  async updateAccount(accountId, patch) {
    const account = this.getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    Object.assign(account, patch, { updatedAt: new Date().toISOString() });
    await this.save();
    return account;
  }

  listServers({ serverId } = {}) {
    return this.data.servers.filter((server) => {
      if (serverId && server.id !== serverId) return false;
      return !server.deletedAt;
    });
  }

  getServer(serverId) {
    return this.listServers({ serverId })[0];
  }

  async addServer(input) {
    const now = new Date().toISOString();
    const server = {
      id: `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: input.name,
      host: input.host,
      enabled: true,
      subscribers: [],
      lastStatus: null,
      lastCheckedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    this.data.servers.push(server);
    await this.save();
    return server;
  }

  async removeServer(serverId) {
    const server = this.getServer(serverId);
    if (!server) throw new Error(`Server ${serverId} not found`);
    server.deletedAt = new Date().toISOString();
    server.updatedAt = new Date().toISOString();
    await this.save();
    return server;
  }

  async updateServer(serverId, patch) {
    const server = this.getServer(serverId);
    if (!server) throw new Error(`Server ${serverId} not found`);
    Object.assign(server, patch, { updatedAt: new Date().toISOString() });
    await this.save();
    return server;
  }

  async subscribeServer(serverId, telegramId) {
    const server = this.getServer(serverId);
    if (!server) throw new Error(`Server ${serverId} not found`);
    server.subscribers ??= [];
    const id = String(telegramId);
    if (!server.subscribers.includes(id)) server.subscribers.push(id);
    server.updatedAt = new Date().toISOString();
    await this.save();
    return server;
  }

  async unsubscribeServer(serverId, telegramId) {
    const server = this.getServer(serverId);
    if (!server) throw new Error(`Server ${serverId} not found`);
    const id = String(telegramId);
    server.subscribers = (server.subscribers ?? []).filter((subscriber) => subscriber !== id);
    server.updatedAt = new Date().toISOString();
    await this.save();
    return server;
  }

  hasSentAlert(key) {
    return this.data.sentAlerts.some((alert) => alert.key === key);
  }

  async markAlertSent(key) {
    if (this.hasSentAlert(key)) return;
    this.data.sentAlerts.push({ key, sentAt: new Date().toISOString() });
    await this.save();
  }
}

function applyAccountDefaults(account) {
  const defaults = DEFAULT_THRESHOLDS[account.service] ?? {
    balanceThreshold: null,
    expiryThresholdDays: null,
  };
  let changed = false;
  const credentialDefaults = DEFAULT_CREDENTIALS[account.service] ?? {};

  account.credentials ??= {};
  for (const [key, value] of Object.entries(credentialDefaults)) {
    if (!account.credentials[key]) {
      account.credentials[key] = value;
      changed = true;
    }
  }

  if (account.balanceThreshold === undefined || account.balanceThreshold === null) {
    if (account.balanceThreshold !== defaults.balanceThreshold) {
      account.balanceThreshold = defaults.balanceThreshold;
      changed = true;
    }
  }
  if (account.expiryThresholdDays === undefined || account.expiryThresholdDays === null) {
    if (account.expiryThresholdDays !== defaults.expiryThresholdDays) {
      account.expiryThresholdDays = defaults.expiryThresholdDays;
      changed = true;
    }
  }

  return changed;
}
