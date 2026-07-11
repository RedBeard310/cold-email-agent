// InboxKit adapter (mailbox host + warmup). Auth scheme, base URL, and the READ endpoints below
// are confirmed live (Bearer INBOX_KIT_API) and mirror the known-good calls in the sibling
// inbox-health gate (youtube-email-outreach-v1) — we re-implement rather than import (per CLAUDE.md
// this is shared InboxKit infra, but its code stays in that repo).
//
// Mailbox/domain PROVISIONING and required-DNS-record endpoints are NOT in InboxKit's public docs.
// Until they're confirmed, provisioning + DNS export are a manual dashboard step (plan Step 3), and
// this adapter covers the read side the pipeline relies on (workspaces, warmup health).
import { env } from '../env';

const BASE = (process.env.INBOXKIT_API_BASE || 'https://api.inboxkit.com').replace(/\/+$/, '');

function key(): string {
  if (!env.INBOX_KIT_API) throw new Error('INBOX_KIT_API must be set in env-storage/.env');
  return env.INBOX_KIT_API;
}

async function req<T>(method: string, path: string, opts: { workspaceId?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key()}`, Accept: 'application/json' };
  if (opts.workspaceId) headers['X-Workspace-Id'] = opts.workspaceId;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`InboxKit ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface Workspace {
  uid: string;
  name: string;
  workspace_type?: string;
}
export async function listWorkspaces(): Promise<Workspace[]> {
  const r = await req<{ workspaces?: Workspace[] }>('GET', '/v1/api/workspaces/list');
  return r.workspaces ?? [];
}

export interface WarmupInbox {
  mailbox_email: string;
  status: string;
  cached_stats?: {
    health_score?: number | null;
    inbox_rate?: number | null;
    warmup_day?: number | null;
    emails_sent?: number | null;
  };
}
/** All warmup inboxes for a workspace (paginated). Same endpoint the inbox-health gate reads. */
export async function listWarmupInboxes(workspaceId: string): Promise<WarmupInbox[]> {
  const out: WarmupInbox[] = [];
  for (let page = 1; ; page++) {
    const r = await req<{ subscriptions?: WarmupInbox[]; pages?: number }>('POST', '/v1/api/warmup/list', {
      workspaceId,
      body: { page, limit: 100, include_cancelled: false },
    });
    const subs = r.subscriptions ?? [];
    out.push(...subs);
    if (subs.length === 0 || !r.pages || page >= r.pages) break;
  }
  return out;
}

/** Resolve the workspace uid to operate on (defaults to the "Content Gets Clients" workspace). */
export async function resolveWorkspaceId(preferName = 'Content Gets Clients'): Promise<string> {
  const ws = await listWorkspaces();
  if (ws.length === 0) throw new Error('No InboxKit workspaces visible to this API key');
  const match =
    ws.find((w) => w.name === preferName) ??
    ws.find((w) => w.name.toLowerCase().includes(preferName.toLowerCase())) ??
    ws[0]!;
  return match.uid;
}

export interface Domain {
  uid: string;
  name: string;
  tld?: string;
  connection_type?: string;
  nameserver_match_status?: string;
  dns_propagation_status?: string;
  assigned_mailboxes?: number;
}
export async function listDomains(workspaceId: string): Promise<Domain[]> {
  const out: Domain[] = [];
  for (let page = 1; ; page++) {
    const r = await req<{ domains?: Domain[] }>('POST', '/v1/api/domains/list', {
      workspaceId,
      body: { page, limit: 100 },
    });
    const ds = r.domains ?? [];
    out.push(...ds);
    if (ds.length < 100) break;
  }
  return out;
}

export interface Mailbox {
  uid?: string;
  domain_name: string;
  username: string;
  first_name?: string;
  last_name?: string;
  platform?: string; // GOOGLE | MICROSOFT
  status?: string;
}
export async function listMailboxes(workspaceId: string): Promise<Mailbox[]> {
  const out: Mailbox[] = [];
  for (let page = 1; ; page++) {
    const r = await req<{ mailboxes?: Mailbox[] }>('POST', '/v1/api/mailboxes/list', {
      workspaceId,
      body: { page, limit: 100 },
    });
    const ms = r.mailboxes ?? [];
    out.push(...ms);
    if (ms.length < 100) break;
  }
  return out;
}

export interface ConnectedDomain {
  domain: string;
  nameservers: string[];
  uid?: string;
  alreadyConnected: boolean;
}
/** Connect an externally-registered domain to the workspace. POST /v1/api/domains/nameservers is
 *  the connect call (confirmed live 2026-07-10): a new domain gets created in InboxKit and assigned
 *  its Cloudflare nameserver pair (200); an already-connected domain returns 409 with the same
 *  shape, so this is idempotent. Free — mailbox slots are only consumed at mailboxes/buy. */
export async function connectDomain(workspaceId: string, domain: string): Promise<ConnectedDomain> {
  const res = await fetch(`${BASE}/v1/api/domains/nameservers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key()}`,
      'X-Workspace-Id': workspaceId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ domains: [domain] }),
  });
  const text = await res.text();
  if (!res.ok && res.status !== 409)
    throw new Error(`InboxKit POST /v1/api/domains/nameservers -> ${res.status}: ${text.slice(0, 300)}`);
  const r = JSON.parse(text) as { result?: { domain: string; nameservers?: string[]; uid?: string }[] };
  const hit = (r.result ?? []).find((d) => d.domain.toLowerCase() === domain.toLowerCase());
  if (!hit?.nameservers?.length)
    throw new Error(`InboxKit connect ${domain}: no nameservers in response: ${text.slice(0, 300)}`);
  return { domain, nameservers: hit.nameservers, uid: hit.uid, alreadyConnected: res.status === 409 };
}

export interface BuyItem {
  domain_name: string;
  username: string;
  first_name: string;
  last_name: string;
  platform: string; // GOOGLE | MICROSOFT
}
export interface BuyResult {
  error?: boolean;
  message?: string;
  mailboxes?: Mailbox[];
}
/** Provision (purchase) mailboxes. SPENDS CREDITS — each becomes a monthly-billed mailbox.
 *  Endpoint discovered live; not in InboxKit's public docs. */
export const buyMailboxes = (workspaceId: string, items: BuyItem[]) =>
  req<BuyResult>('POST', '/v1/api/mailboxes/buy', { workspaceId, body: { mailboxes: items } });
