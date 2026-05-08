import { getPorkbunSnapshot } from "./porkbun.js";
import { getProxylineSnapshot } from "./proxyline.js";
import { getDarkshoppingSnapshot } from "./darkshopping.js";

export async function getServiceSnapshot(account) {
  if (account.service === "porkbun") return getPorkbunSnapshot(account.credentials);
  if (account.service === "proxyline") return getProxylineSnapshot(account.credentials);
  if (account.service === "darkshopping") return getDarkshoppingSnapshot(account.credentials);
  throw new Error(`Unsupported service: ${account.service}`);
}
