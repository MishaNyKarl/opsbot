import { getPorkbunSnapshot } from "./porkbun.js";
import { getProxylineSnapshot } from "./proxyline.js";
import { getDarkshoppingSnapshot } from "./darkshopping.js";
import { getDatalixSnapshot } from "./datalix.js";
import { getVirustotalDomainsSnapshot } from "./virustotalDomains.js";

export async function getServiceSnapshot(account) {
  if (account.service === "porkbun") return getPorkbunSnapshot(account.credentials);
  if (account.service === "proxyline") return getProxylineSnapshot(account.credentials);
  if (account.service === "darkshopping") return getDarkshoppingSnapshot(account.credentials);
  if (account.service === "datalix") return getDatalixSnapshot(account.credentials);
  if (account.service === "virustotal_domains") return getVirustotalDomainsSnapshot(account.credentials);
  throw new Error(`Unsupported service: ${account.service}`);
}
