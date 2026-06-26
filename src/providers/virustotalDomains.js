const OPSVAULT_BASE_URL = "https://portalwiki.world";
const VIRUSTOTAL_BASE_URL = "https://www.virustotal.com/api/v3";
const VIRUSTOTAL_REQUEST_DELAY_MS = 16000;

export async function getVirustotalDomainsSnapshot(credentials) {
  if (!credentials.apiKey || !credentials.opsvaultApiKey) {
    throw new Error("Для Virustotal доменов нужны VirusTotal API key и OpsVault API key.");
  }

  const domains = await readOpsvaultDomains(credentials.opsvaultApiKey);
  const porkbunDomains = domains
    .filter((domain) => String(domain.source ?? "").toLowerCase() === "porkbun")
    .filter((domain) => String(domain.status ?? "").toLowerCase() === "active")
    .map((domain) => ({
      ...domain,
      domain: normalizeDomain(domain.domain),
    }))
    .filter((domain) => domain.domain);

  const domainAlerts = [];
  const checks = [];

  for (let index = 0; index < porkbunDomains.length; index += 1) {
    const domain = porkbunDomains[index];
    const report = await readVirustotalDomain(credentials.apiKey, domain.domain);
    checks.push({ domain: domain.domain, report });

    const alert = buildDomainAlert(domain, report);
    if (alert) domainAlerts.push(alert);

    if (index < porkbunDomains.length - 1) await wait(VIRUSTOTAL_REQUEST_DELAY_MS);
  }

  return {
    balance: {
      amount: Number.NaN,
      currency: "",
      display: "баланс не проверяется",
      raw: null,
    },
    expirations: [],
    statuses: [],
    domainAlerts,
    domainsChecked: checks.length,
    raw: {
      domains: porkbunDomains,
      checks,
    },
  };
}

async function readOpsvaultDomains(apiKey) {
  const domains = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const url = new URL("/api/v1/domains/", OPSVAULT_BASE_URL);
    url.searchParams.set("status", "active");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const data = await fetchJson(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-API-Key": apiKey,
      },
      serviceName: "OpsVault",
    });

    const page = Array.isArray(data) ? data : data.results ?? [];
    domains.push(...page);

    if (Array.isArray(data)) break;
    if (data.next_offset === null || data.next_offset === undefined) break;
    offset = Number(data.next_offset);
    if (!Number.isFinite(offset)) break;
  }

  return domains;
}

async function readVirustotalDomain(apiKey, domain) {
  const url = new URL(`/api/v3/domains/${encodeURIComponent(domain)}`, VIRUSTOTAL_BASE_URL);
  return fetchJson(url, {
    headers: {
      "x-apikey": apiKey,
    },
    serviceName: "VirusTotal",
    allowNotFound: true,
  });
}

async function fetchJson(url, { headers, serviceName, allowNotFound = false }) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...headers,
    },
    signal: AbortSignal.timeout(30000),
  });

  const data = await response.json().catch(() => ({}));
  if (allowNotFound && response.status === 404) return { notFound: true, raw: data };
  if (!response.ok) {
    const message = data.error?.message || data.detail || data.message || `HTTP ${response.status}`;
    throw new Error(`${serviceName}: ${message}`);
  }

  return data;
}

function buildDomainAlert(domain, report) {
  if (report.notFound) return null;

  const attributes = report.data?.attributes ?? {};
  const stats = attributes.last_analysis_stats ?? {};
  const votes = attributes.total_votes ?? {};
  const malicious = Number(stats.malicious ?? 0);
  const suspicious = Number(stats.suspicious ?? 0);
  const maliciousVotes = Number(votes.malicious ?? 0);
  const reputation = Number(attributes.reputation ?? 0);

  if (malicious <= 0 && suspicious <= 0 && maliciousVotes <= 0 && reputation >= 0) return null;

  return {
    id: domain.domain,
    label: domain.domain,
    stats: {
      malicious,
      suspicious,
      harmless: Number(stats.harmless ?? 0),
      undetected: Number(stats.undetected ?? 0),
    },
    reputation,
    maliciousVotes,
    detections: listDetections(attributes.last_analysis_results),
    raw: {
      opsvault: domain,
      virustotal: report,
    },
  };
}

function listDetections(results = {}) {
  return Object.entries(results)
    .filter(([, result]) => ["malicious", "suspicious"].includes(result.category))
    .slice(0, 5)
    .map(([engine, result]) => ({
      engine,
      category: result.category,
      result: result.result,
    }));
}

function normalizeDomain(value) {
  return String(value ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
