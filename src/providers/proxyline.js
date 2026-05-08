const BASE_URL = "https://panel.proxylin.net/api";

async function request(path, credentials, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("api_key", credentials.apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(formatProxylineError(data) || `Ошибка запроса Proxyline, HTTP ${response.status}`);
  }

  return data;
}

export async function getProxylineSnapshot(credentials) {
  if (!credentials.apiKey) throw new Error("Для Proxyline нужен API key.");

  const [balance, proxies, mtproxies] = await Promise.all([
    request("/balance/", credentials),
    readPaginated("/proxies/", credentials, { status: "exclude_deleted", limit: 2000 }),
    readPaginated("/mtproxies/", credentials, { status: "exclude_deleted", limit: 2000 }),
  ]);

  return {
    balance: normalizeBalance(balance),
    expirations: [
      ...proxies.map((proxy) => ({
        id: `proxy:${proxy.id}`,
        label: `HTTP/SOCKS ${proxy.ip}:${proxy.port_http ?? proxy.port_socks5 ?? ""}`.trim(),
        endsAt: parseDate(proxy.date_end),
        raw: proxy,
      })),
      ...mtproxies.map((proxy) => ({
        id: `mtproxy:${proxy.id}`,
        label: `MTProxy ${proxy.ip}:${proxy.port}`,
        endsAt: parseDate(proxy.end_date),
        raw: proxy,
      })),
    ],
    raw: {
      balance,
      proxies,
      mtproxies,
    },
  };
}

async function readPaginated(path, credentials, params) {
  const results = [];
  let offset = 0;

  while (true) {
    const page = await request(path, credentials, { ...params, offset });
    results.push(...(page.results ?? []));
    if (!page.next || (page.results ?? []).length === 0) break;
    offset += Number(params.limit ?? 500);
  }

  return results;
}

function normalizeBalance(balance) {
  const amount =
    firstNumber(balance.balance, balance.main_balance, balance.value, balance.amount, balance.money) ??
    findNumberByKey(balance, ["balance", "main_balance", "amount", "money"]) ??
    0;
  const partnerAmount = firstNumber(balance.partner_balance, balance.ref_balance, balance.affiliate_balance);
  const currency = balance.currency ?? balance.cur ?? "RUB";

  const displayParts = [`${amount} ${currency}`];
  if (partnerAmount !== undefined) displayParts.push(`партнерский: ${partnerAmount} ${currency}`);

  return {
    amount,
    currency,
    display: balance.display ?? displayParts.join(", "),
    raw: balance,
  };
}

function findNumberByKey(value, keys) {
  if (!value || typeof value !== "object") return undefined;

  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key)) {
      const parsed = firstNumber(child);
      if (parsed !== undefined) return parsed;
    }
  }

  for (const child of Object.values(value)) {
    const nested = findNumberByKey(child, keys);
    if (nested !== undefined) return nested;
  }

  return undefined;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number(String(value).replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function formatProxylineError(data) {
  if (!data || typeof data !== "object") return "";
  return Object.entries(data)
    .map(([field, messages]) => `${field}: ${Array.isArray(messages) ? messages.join(", ") : messages}`)
    .join("; ");
}
