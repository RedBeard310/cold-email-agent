// Spaceship REST adapter (domain registrar + DNS). Mirrors engine/smartlead.ts: a small req<T>
// helper plus typed endpoint wrappers. Auth is via X-Api-Key / X-Api-Secret headers (the key is
// stored under SPACESHIP_API). Base URL + endpoint shapes confirmed against docs.spaceship.dev.
//
// Deliberately NO domain-registration call here: per plan, the agent never auto-charges Casey's
// card. We only READ availability and READ/WRITE DNS for domains Casey already bought.
import { env } from '../env';

const BASE = 'https://spaceship.dev/api/v1';

function headers(json = false): Record<string, string> {
  const key = env.SPACESHIP_API;
  const secret = env.SPACESHIP_API_SECRET;
  if (!key || !secret)
    throw new Error('SPACESHIP_API and SPACESHIP_API_SECRET must be set in env-storage/.env');
  const h: Record<string, string> = { 'X-Api-Key': key, 'X-Api-Secret': secret, Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Spaceship ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

// ---------- domain availability ----------

export interface Availability {
  domain: string;
  result: string; // "available" | "taken" | ...
  premiumPricing?: { operation: string; price: number; currency: string }[];
}
export const checkAvailability = (domain: string) =>
  req<Availability>('GET', `/domains/${encodeURIComponent(domain)}/available`);

// ---------- DNS records ----------

export interface DnsRecord {
  type: string; // A | AAAA | CNAME | MX | TXT | …
  name: string; // "@" for apex, else subdomain label
  ttl?: number;
  // Spaceship uses type-specific value fields; the common ones are named here and the index
  // signature lets less-common record types pass through untouched.
  address?: string; // A / AAAA
  cname?: string; // CNAME
  value?: string; // TXT
  exchange?: string; // MX target host
  preference?: number; // MX priority
  [k: string]: unknown;
}

/** All DNS records for a domain (paginated, take=500). */
export async function listDnsRecords(domain: string): Promise<DnsRecord[]> {
  const out: DnsRecord[] = [];
  const take = 500;
  for (let skip = 0; ; skip += take) {
    const r = await req<{ items?: DnsRecord[]; total?: number }>(
      'GET',
      `/dns/records/${encodeURIComponent(domain)}?take=${take}&skip=${skip}`,
    );
    const items = r.items ?? [];
    out.push(...items);
    if (items.length < take) break;
  }
  return out;
}

/** Upsert DNS records. force:true overwrites conflicting existing records. Succeeds on HTTP 204. */
export const saveDnsRecords = (domain: string, items: DnsRecord[], force = true) =>
  req<void>('PUT', `/dns/records/${encodeURIComponent(domain)}`, { force, items });

// ---------- nameservers ----------

export interface NameserversResult {
  hosts: string[];
  provider: string; // "basic" | "custom"
}
/** Delegate a domain to custom nameservers (e.g. the Cloudflare pair InboxKit assigns). Echoes
 *  the new {hosts, provider} on 200. When NS point elsewhere, Spaceship's own DNS records are
 *  no longer authoritative — the nameserver target owns DNS. */
export const updateNameservers = (domain: string, hosts: string[]) =>
  req<NameserversResult>('PUT', `/domains/${encodeURIComponent(domain)}/nameservers`, {
    provider: 'custom',
    hosts,
  });
