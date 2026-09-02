// Fleet enforcement: every ACTIVE campaign must (a) have EXACTLY the sending pool attached,
// no more and no less, and (b) carry an effectively-unlimited daily lead cap. Throughput is
// governed by the right layers instead: per-inbox daily limits (message_per_day) and the
// inbox health gate (account-level is_suspended, owned by youtube-email-outreach-v1).
//
// Born of the 2026-07-13 incident: FA campaigns silently ran at 25 leads/day from 12
// legacy inboxes because create/attach mirrored the old Dream 100 campaign. See
// CLAUDE.md "Campaign hard rules".
//
// 2026-09-02: the pool is no longer "every SmartLead account". SmartLead still holds all 150
// accounts we ever connected, but 140 of them are cancelled or scheduled for cancellation in
// InboxKit, so they are not ours to send from. InboxKit `status: active` is the one source of
// truth, and the audit now DETACHES anything outside it as well as attaching what is missing.
import * as fs from 'node:fs';
import { env } from '../env';
import { listWorkspaces, listMailboxes } from '../infra/inboxkit';

const BASE = 'https://server.smartlead.ai/api/v1';
const CAP_FLOOR = 99_999; // "no cap": SmartLead accepts this and inbox limits govern instead

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${sep}api_key=${env.SMARTLEAD_API_KEY}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SmartLead ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

interface Account { id: number; from_email: string; message_per_day?: number }

/** ALL email accounts in the SmartLead account, paginated (the account has >100). */
export async function listAllEmailAccounts(): Promise<Account[]> {
  const out: Account[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await req<Account[]>('GET', `/email-accounts/?offset=${offset}&limit=${limit}`);
    out.push(...page);
    if (page.length < limit) break;
  }
  return out;
}

/** Emails of every InboxKit mailbox with `status: active` — the inboxes we actually pay for
 *  and are allowed to send from. `active` is a billing status, so it is a permission check,
 *  not a liveness check; the health gate still decides which of these send on a given day. */
export async function inboxKitActiveEmails(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ws of await listWorkspaces()) {
    for (const m of await listMailboxes(ws.uid)) {
      if (m.status === 'active') out.add(`${m.username}@${m.domain_name}`.toLowerCase());
    }
  }
  return out;
}

/** The sending pool: SmartLead accounts that are ALSO active in InboxKit. This is the exact
 *  set every campaign must carry. Throws rather than returning an empty pool, because an
 *  InboxKit hiccup must never be read as "detach everything". */
export async function sendingPool(): Promise<Account[]> {
  const all = await listAllEmailAccounts();
  const active = await inboxKitActiveEmails();
  const pool = all.filter((a) => active.has(a.from_email.toLowerCase()));
  if (pool.length === 0) {
    throw new Error(
      `Sending pool is empty: none of ${all.length} SmartLead accounts is active in InboxKit ` +
        `(${active.size} active mailboxes seen). Refusing to touch campaign inboxes.`,
    );
  }
  return pool;
}

interface Campaign {
  id: number;
  name: string;
  status: string;
  max_leads_per_day?: number;
  min_time_btwn_emails?: number;
  scheduler_cron_value?: { tz?: string; days?: number[]; startHour?: string; endHour?: string };
}

const STATE_FILE = '.fleet-audit-state.json';
const STALE_MS = 12 * 3600_000;

function isFresh(): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { lastRun?: string };
    return Date.now() - Date.parse(s.lastRun ?? '') < STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Audit (and with fix=true, repair) every ACTIVE campaign:
 *   - attached inboxes == full account pool (gate decides which actually send)
 *   - max_leads_per_day >= CAP_FLOOR (rewrites the schedule preserving the campaign's own
 *     timezone/days/hours/spacing — only the cap changes)
 * Exit code stays 0 either way; violations print loudly. Never touches is_suspended.
 */
export async function fleetAudit(opts: { fix: boolean; ifStale?: boolean }): Promise<void> {
  if (opts.ifStale && isFresh()) {
    console.log('[fleet-audit] state fresh (<12h), skipping. Run without --if-stale to force.');
    return;
  }
  const pool = await sendingPool();
  const poolIds = pool.map((a) => a.id);
  console.log(`\n=== FLEET AUDIT ${opts.fix ? '(--fix: repairs applied)' : '(read-only — add --fix to repair)'} ===`);
  console.log(`sending pool: ${pool.length} InboxKit-active inboxes (health gate suspends unhealthy ones at send time)\n`);

  const campaigns = (await req<Campaign[]>('GET', '/campaigns')).filter((c) => c.status === 'ACTIVE');
  let violations = 0;
  for (const c of campaigns) {
    const attached = await req<Account[]>('GET', `/campaigns/${c.id}/email-accounts`);
    const missing = poolIds.filter((id) => !attached.some((a) => a.id === id));
    const extra = attached.filter((a) => !poolIds.includes(a.id)).map((a) => a.id);
    const detail = await req<Campaign>('GET', `/campaigns/${c.id}`);
    const cap = detail.max_leads_per_day ?? 0;
    const capBad = cap < CAP_FLOOR;
    const ok = missing.length === 0 && extra.length === 0 && !capBad;
    if (!ok) violations++;

    console.log(`${ok ? '✓' : '✗'} #${c.id} ${c.name}`);
    if (missing.length) console.log(`    inboxes: ${attached.length}/${pool.length} attached — ${missing.length} missing`);
    if (extra.length) console.log(`    inboxes: ${extra.length} attached that are NOT in the sending pool`);
    if (capBad) console.log(`    cap: max_leads_per_day=${cap} (< ${CAP_FLOOR})`);

    if (ok || !opts.fix) continue;
    // Attach first, detach second, so a campaign is never left with zero inboxes mid-repair.
    if (missing.length) {
      await req('POST', `/campaigns/${c.id}/email-accounts`, { email_account_ids: poolIds });
    }
    if (extra.length) {
      for (let i = 0; i < extra.length; i += 50) {
        await req('DELETE', `/campaigns/${c.id}/email-accounts`, { email_account_ids: extra.slice(i, i + 50) });
      }
    }
    if (missing.length || extra.length) {
      const after = await req<Account[]>('GET', `/campaigns/${c.id}/email-accounts`);
      console.log(`    → pool enforced: now ${after.length}/${pool.length} attached`);
    }
    if (capBad) {
      const cron = detail.scheduler_cron_value ?? {};
      await req('POST', `/campaigns/${c.id}/schedule`, {
        timezone: cron.tz ?? 'America/New_York',
        days_of_the_week: cron.days ?? [1, 2, 3, 4],
        start_hour: cron.startHour ?? '09:00',
        end_hour: cron.endHour ?? '15:00',
        min_time_btw_emails: detail.min_time_btwn_emails ?? 12,
        max_new_leads_per_day: CAP_FLOOR,
      });
      const rb = await req<Campaign>('GET', `/campaigns/${c.id}`);
      console.log(`    → cap raised: max_leads_per_day=${rb.max_leads_per_day}`);
    }
  }

  console.log(
    `\n${violations === 0 ? '✓ all ACTIVE campaigns compliant' : opts.fix ? `✓ repaired ${violations} campaign(s)` : `✗ ${violations} campaign(s) in violation — run with --fix`}`,
  );
  if (opts.fix || violations === 0) fs.writeFileSync(STATE_FILE, JSON.stringify({ lastRun: new Date().toISOString() }, null, 2));
  console.log();
}
