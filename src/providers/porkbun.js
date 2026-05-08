const BASE_URL = "https://api.porkbun.com/api/json/v3";

async function request(path, credentials) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: {
      "X-API-Key": credentials.apiKey,
      "X-Secret-API-Key": credentials.secretApiKey,
      Accept: "application/json",
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.status === "ERROR") {
    throw new Error(data.message || `Ошибка запроса Porkbun, HTTP ${response.status}`);
  }

  return data;
}

export async function getPorkbunSnapshot(credentials) {
  if (!credentials.apiKey || !credentials.secretApiKey) {
    throw new Error("Для Porkbun нужны API key и Secret API key.");
  }

  const [balance, domains] = await Promise.all([
    request("/account/balance", credentials),
    readDomains(credentials),
  ]);

  return {
    balance: {
      amount: Number(balance.balance ?? 0) / 100,
      currency: "USD",
      display: balance.display ?? `$${(Number(balance.balance ?? 0) / 100).toFixed(2)}`,
      raw: balance,
    },
    expirations: domains.map((domain) => ({
      id: domain.domain,
      label: domain.domain,
      endsAt: parsePorkbunDate(domain.expireDate),
      raw: domain,
    })),
    raw: {
      balance,
      domains,
    },
  };
}

async function readDomains(credentials) {
  const domains = [];
  let start = 0;

  while (true) {
    const page = await request(`/domain/listAll?start=${start}`, credentials);
    const current = page.domains ?? [];
    domains.push(...current);
    if (current.length < 1000) break;
    start += 1000;
  }

  return domains;
}

function parsePorkbunDate(value) {
  if (!value) return null;
  const normalized = String(value).replace(" ", "T");
  const parsed = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
