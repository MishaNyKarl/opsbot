const OPSVAULT_BASE_URL = "https://portalwiki.world";
const VIRUSTOTAL_BASE_URL = "https://www.virustotal.com/api/v3";
const VIRUSTOTAL_BATCH_SIZE = 4;
const VIRUSTOTAL_RATE_WINDOW_MS = 60 * 1000;
const REQUEST_RETRIES = 3;

export async function getVirustotalDomainsSnapshot(credentials, options = {}) {
  if (!credentials.apiKey || !credentials.opsvaultApiKey) {
    throw new Error("Для Virustotal доменов нужны VirusTotal API key и OpsVault API key.");
  }

  await emitProgress(options, { type: "domains.load_started" });
  const domains = await readOpsvaultDomains(credentials.opsvaultApiKey);
  const porkbunDomains = domains
    .filter((domain) => String(domain.source ?? "").toLowerCase() === "porkbun")
    .filter((domain) => String(domain.status ?? "").toLowerCase() === "active")
    .map((domain) => ({
      ...domain,
      domain: normalizeDomain(domain.domain),
    }))
    .filter((domain) => domain.domain);

  const totalBatches = Math.ceil(porkbunDomains.length / VIRUSTOTAL_BATCH_SIZE);
  await emitProgress(options, {
    type: "domains.accepted",
    total: porkbunDomains.length,
    batchSize: VIRUSTOTAL_BATCH_SIZE,
    totalBatches,
  });

  const domainAlerts = [];
  const checks = [];
  const domainErrors = [];

  for (let offset = 0; offset < porkbunDomains.length; offset += VIRUSTOTAL_BATCH_SIZE) {
    const batchStartedAt = Date.now();
    const batchNumber = Math.floor(offset / VIRUSTOTAL_BATCH_SIZE) + 1;
    const batch = porkbunDomains.slice(offset, offset + VIRUSTOTAL_BATCH_SIZE);

    await emitProgress(options, {
      type: "batch.started",
      batchNumber,
      totalBatches,
      size: batch.length,
    });

    for (const domain of batch) {
      try {
        const report = await readVirustotalDomain(credentials.apiKey, domain.domain);
        checks.push({ domain: domain.domain, report });

        const alert = buildDomainAlert(domain, report);
        if (alert) domainAlerts.push(alert);
      } catch (error) {
        if (!error.retryable) throw error;
        domainErrors.push({
          domain: domain.domain,
          error: error.message,
        });
        checks.push({
          domain: domain.domain,
          error: error.message,
        });
      }
    }

    const checked = checks.length;
    const errors = domainErrors.length;
    const problems = domainAlerts.length;
    await emitProgress(options, {
      type: "batch.finished",
      batchNumber,
      totalBatches,
      checked,
      total: porkbunDomains.length,
      errors,
      problems,
    });

    const isLastBatch = offset + VIRUSTOTAL_BATCH_SIZE >= porkbunDomains.length;
    const elapsed = Date.now() - batchStartedAt;
    const waitMs = VIRUSTOTAL_RATE_WINDOW_MS - elapsed;
    if (!isLastBatch && waitMs > 0) {
      await emitProgress(options, {
        type: "batch.waiting",
        batchNumber,
        totalBatches,
        waitSeconds: Math.ceil(waitMs / 1000),
      });
      await wait(waitMs);
    }
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
    domainErrors,
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
  let lastError = null;

  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          ...headers,
        },
        signal: AbortSignal.timeout(45000),
      });

      const data = await response.json().catch(() => ({}));
      if (allowNotFound && response.status === 404) return { notFound: true, raw: data };
      if (!response.ok) {
        const message = data.error?.message || data.detail || data.message || `HTTP ${response.status}`;
        const error = new Error(`${serviceName}: ${message}`);
        error.retryable = response.status === 429 || response.status >= 500;
        if (!error.retryable) throw error;
        lastError = error;
      } else {
        return data;
      }
    } catch (error) {
      if (error.name === "AbortError" || error.name === "TimeoutError" || error.message === "fetch failed") {
        error.retryable = true;
      }
      if (!error.retryable) throw error;
      lastError = error;
    }

    if (attempt < REQUEST_RETRIES) {
      await wait(attempt * 5000);
    }
  }

  lastError ??= new Error(`${serviceName}: fetch failed`);
  lastError.retryable = true;
  throw lastError;
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

async function emitProgress(options, event) {
  console.log(formatProgressForLog(event));
  if (typeof options.onProgress === "function") {
    await options.onProgress(event);
  }
}

function formatProgressForLog(event) {
  if (event.type === "domains.load_started") return "Virustotal домены: загружаю домены из OpsVault";
  if (event.type === "domains.accepted") {
    return `Virustotal домены: принято ${event.total} доменов, пачек ${event.totalBatches}`;
  }
  if (event.type === "batch.started") {
    return `Virustotal домены: пачка ${event.batchNumber}/${event.totalBatches} принята на проверку (${event.size} дом.)`;
  }
  if (event.type === "batch.finished") {
    return `Virustotal домены: пачка ${event.batchNumber}/${event.totalBatches} готова, проверено ${event.checked}/${event.total}, проблем ${event.problems}, ошибок ${event.errors}`;
  }
  if (event.type === "batch.waiting") {
    return `Virustotal домены: жду ${event.waitSeconds} сек. до следующей пачки`;
  }
  return `Virustotal домены: ${event.type}`;
}
