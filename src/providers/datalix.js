const STATUS_LABELS = {
  stopping: "останавливается",
  shutdown: "останавливается",
  starting: "запускается",
  running: "работает",
  stopped: "выключен",
  installing: "устанавливается",
  preorder: "ожидает размещения",
  createbackup: "создает бэкап",
  restorebackup: "восстанавливает бэкап",
  backupplanned: "запланирован бэкап",
  restoreplanned: "запланировано восстановление",
  error: "ошибка",
};

export async function getDatalixSnapshot(credentials) {
  if (!credentials.apiKey) throw new Error("Для Datalix нужен API key.");
  if (!credentials.baseUrl) throw new Error("Для Datalix нужен base URL API.");

  const services = await request("/service/list", credentials);
  const statuses = [];

  for (const service of services) {
    const status = await request(`/service/${encodeURIComponent(service.id)}/status`, credentials);
    statuses.push({
      id: service.id,
      label: serviceLabel(service),
      status: status.status,
      statusLabel: STATUS_LABELS[status.status] ?? status.status,
      raw: status,
    });
    await wait(2100);
  }

  return {
    balance: {
      amount: Number.NaN,
      currency: "EUR",
      display: "баланс не проверяется",
      raw: null,
    },
    expirations: services
      .filter((service) => Number(service.expire_at) > 0)
      .map((service) => ({
        id: service.id,
        label: serviceLabel(service),
        endsAt: unixToIso(service.expire_at),
        amountDue: Number(service.price ?? 0),
        currency: "EUR",
        kind: "payment",
        raw: service,
      })),
    statuses,
    raw: {
      services,
      statuses,
    },
  };
}

async function request(path, credentials) {
  const authAttempts = [
    { headers: { Authorization: `Bearer ${credentials.apiKey}` } },
    { headers: { "X-API-Key": credentials.apiKey } },
    { headers: { "X-Auth-Token": credentials.apiKey } },
    { headers: { Session: credentials.apiKey } },
    { headers: { "X-Session": credentials.apiKey } },
    { query: { key: credentials.apiKey } },
    { query: { token: credentials.apiKey } },
  ];
  const errors = [];

  for (const attempt of authAttempts) {
    const url = new URL(`${credentials.baseUrl.replace(/\/$/, "")}${path}`);
    for (const [key, value] of Object.entries(attempt.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(attempt.headers ?? {}),
      },
    });

    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;

    errors.push(data.error || `HTTP ${response.status}`);
    if (![401, 403].includes(response.status)) break;
  }

  throw new Error(errors.at(-1) || "Ошибка авторизации Datalix");
}

function serviceLabel(service) {
  const name = service.name && service.name !== "null" ? service.name : service.productdisplay;
  return `${name || "Server"} ${service.id}`.trim();
}

function unixToIso(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp * 1000).toISOString();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
