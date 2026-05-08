const BASE_URL = "https://dark.shopping/api/v1";

export async function getDarkshoppingSnapshot(credentials) {
  if (!credentials.apiKey) throw new Error("Для Darkshopping нужен API key.");

  const data = await request("/user/balance", credentials);
  const balance = data.data ?? {};
  const amount = Number(balance.balance ?? 0);
  const currency = balance.currency ?? "RUB";

  return {
    balance: {
      amount,
      currency,
      display: `${amount} ${currency}`,
      raw: data,
    },
    expirations: [],
    raw: data,
  };
}

async function request(path, credentials) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("key", credentials.apiKey);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const message = data.data?.message || data.data?.name || `Ошибка запроса Darkshopping, HTTP ${response.status}`;
    throw new Error(message);
  }

  return data;
}
