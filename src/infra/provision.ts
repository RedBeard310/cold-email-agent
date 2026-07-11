// Orchestration for the sending-infra module.
//   findDomains — Step 1: walk naming candidates, keep the first N Spaceship reports available,
//                 write a checkout-ready .txt + a provider-split .json. Reads only; never registers.
//   applyDns    — Step 4: push a per-domain DNS record set (exported from InboxKit) to Spaceship,
//                 then read back to verify. Dry-run by default.
import * as fs from 'node:fs';
import { candidates } from './naming';
import { checkAvailability, listDnsRecords, saveDnsRecords, updateNameservers, type DnsRecord } from './spaceship';
import {
  resolveWorkspaceId,
  listDomains,
  listMailboxes,
  buyMailboxes,
  connectDomain,
  type BuyItem,
} from './inboxkit';

const OUT_DIR = '.infra';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Spaceship availability limit is 30 req/user/30s; ~1.2s spacing stays comfortably under it.
const THROTTLE_MS = 1200;

type Provider = 'google' | 'microsoft';

// ---------------- Step 1: find available domains ----------------

export async function findDomains(opts: { count: number }): Promise<void> {
  const pool = candidates();
  console.log(`\n=== infra:domains — find ${opts.count} available domains (Spaceship, read-only) ===`);
  console.log(`candidate pool: ${pool.length} names (ordered, .com-first)\n`);

  const available: string[] = [];
  let checked = 0;
  for (const domain of pool) {
    if (available.length >= opts.count) break;
    checked++;
    try {
      const res = await checkAvailability(domain);
      const premium = (res.premiumPricing?.length ?? 0) > 0;
      if (res.result === 'available' && !premium) {
        available.push(domain);
        console.log(`  ✓ ${domain.padEnd(36)} AVAILABLE  [${available.length}/${opts.count}]`);
      } else {
        console.log(`  ✗ ${domain.padEnd(36)} ${premium ? 'premium (skipped)' : res.result}`);
      }
    } catch (e) {
      console.log(`  ? ${domain.padEnd(36)} error: ${(e as Error).message.slice(0, 70)} (skipping)`);
    }
    await sleep(THROTTLE_MS);
  }

  if (available.length < opts.count) {
    console.log(
      `\n⚠ found only ${available.length}/${opts.count} available after ${checked} candidates. ` +
        `Add prefixes/suffixes/TLDs in src/infra/naming.ts and re-run.`,
    );
  }

  // Provider split: first half all-Google, second half all-Microsoft (never mix on one domain).
  const half = Math.ceil(available.length / 2);
  const assignment: { domain: string; provider: Provider }[] = available.map((domain, i) => ({
    domain,
    provider: i < half ? 'google' : 'microsoft',
  }));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = Date.now();
  const txtPath = `${OUT_DIR}/domains-${ts}.txt`;
  const jsonPath = `${OUT_DIR}/domains-${ts}.json`;
  fs.writeFileSync(txtPath, available.join('\n') + (available.length ? '\n' : ''));
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      { generatedAt: new Date(ts).toISOString(), count: available.length, inboxesPerDomain: 3, assignment },
      null,
      2,
    ),
  );

  const g = assignment.filter((a) => a.provider === 'google').length;
  const m = assignment.length - g;
  console.log(`\n--- summary ---`);
  console.log(`  available domains : ${available.length}  (checked ${checked} candidates)`);
  console.log(`  provider split    : ${g} Google → ${g * 3} Gmail · ${m} Microsoft → ${m * 3} Outlook`);
  console.log(`  CHECKOUT LIST     : ${txtPath}`);
  console.log(`                      ↑ paste into Spaceship bulk search → add available to cart → pay`);
  console.log(`  provider map      : ${jsonPath}  (feeds Step 3 provisioning + Step 4 DNS)\n`);
}

// ---------------- Step 4: apply DNS records to Spaceship ----------------

interface DnsPlanFile {
  // { "somedomain.com": [ {type,name,...}, ... ], ... }
  records: Record<string, DnsRecord[]>;
}

export async function applyDns(opts: { file: string; apply: boolean }): Promise<void> {
  const plan = JSON.parse(fs.readFileSync(opts.file, 'utf8')) as DnsPlanFile;
  const domains = Object.keys(plan.records ?? {});
  console.log(`\n=== infra:dns — ${opts.apply ? 'APPLY' : 'DRY RUN (no writes)'} · ${domains.length} domains ===\n`);

  let allOk = true;
  for (const domain of domains) {
    const want = plan.records[domain] ?? [];
    if (!opts.apply) {
      console.log(`  ${domain}: would write ${want.length} records`);
      for (const r of want) {
        const val = r.address ?? r.cname ?? r.exchange ?? r.value ?? '';
        console.log(`      ${r.type.padEnd(6)} ${r.name.padEnd(22)} ${val}`);
      }
      continue;
    }
    try {
      await saveDnsRecords(domain, want, true);
      const after = await listDnsRecords(domain);
      const ok = want.every((w) => after.some((a) => a.type === w.type && a.name === w.name));
      if (!ok) allOk = false;
      console.log(`  ${ok ? '✓' : '✗'} ${domain}: wrote ${want.length}; ${after.length} records now on file`);
    } catch (e) {
      allOk = false;
      console.log(`  ✗ ${domain}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  if (opts.apply) console.log(`\n=== ${allOk ? 'ALL DOMAINS VERIFIED' : 'SOME DOMAINS FAILED — see ✗ above'} ===\n`);
  else console.log(`\nDRY RUN — nothing written. Re-run with --apply to push these records.\n`);
}

// ---------------- nameservers: delegate domains to Cloudflare (InboxKit) ----------------

// Spaceship domains:write — modest spacing to stay well under rate limits.
const NS_THROTTLE_MS = 800;

/** Parse the InboxKit nameserver export: Domain,Status,Nameserver1,Nameserver2 (quoted fields). */
function parseNsCsv(text: string): { domain: string; hosts: string[] }[] {
  const lines = text.trim().split(/\r?\n/);
  return lines
    .slice(1) // header
    .map((line) => {
      const c = line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      return { domain: (c[0] ?? '').toLowerCase(), hosts: [c[2] ?? '', c[3] ?? ''].filter(Boolean) };
    })
    .filter((r) => r.domain && r.hosts.length >= 2);
}

export async function applyNameservers(opts: { file: string; apply: boolean }): Promise<void> {
  const rows = parseNsCsv(fs.readFileSync(opts.file, 'utf8'));
  console.log(`\n=== infra:nameservers — ${opts.apply ? 'APPLY' : 'DRY RUN (no writes)'} · ${rows.length} domains ===\n`);

  let ok = 0;
  let fail = 0;
  for (const r of rows) {
    if (!opts.apply) {
      console.log(`  ${r.domain.padEnd(36)} → ${r.hosts.join(', ')}`);
      continue;
    }
    try {
      const res = await updateNameservers(r.domain, r.hosts);
      const got = (res.hosts ?? []).map((h) => h.toLowerCase()).sort();
      const want = r.hosts.map((h) => h.toLowerCase()).sort();
      const verified = JSON.stringify(got) === JSON.stringify(want);
      if (verified) ok++;
      else fail++;
      console.log(`  ${verified ? '✓' : '✗'} ${r.domain.padEnd(36)} → ${(res.hosts ?? []).join(', ')}`);
    } catch (e) {
      fail++;
      console.log(`  ✗ ${r.domain.padEnd(36)} ${(e as Error).message.slice(0, 120)}`);
    }
    await sleep(NS_THROTTLE_MS);
  }

  if (opts.apply) {
    console.log(`\n=== ${fail === 0 ? `ALL ${ok} VERIFIED` : `${ok} ok, ${fail} FAILED — see ✗ above`} ===`);
    console.log('NS changes propagate over minutes–hours; InboxKit will verify + manage DNS in Cloudflare once live.\n');
  } else {
    console.log(`\nDRY RUN — nothing changed. Re-run with --apply to set these nameservers.\n`);
  }
}

// ---------------- connect: add registered domains to InboxKit + delegate NS ----------------

/** One domain per line; blank lines and #-comments ignored. */
function readDomainList(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#'));
}

/** End-to-end domain connect: for each domain (already registered at Spaceship), connect it in
 *  InboxKit (which assigns a Cloudflare NS pair), then delegate the domain to those nameservers
 *  at Spaceship. Idempotent on both sides. Dry-run default (no writes anywhere). */
export async function connectDomains(opts: { file: string; apply: boolean }): Promise<void> {
  const domains = readDomainList(opts.file);
  const wsId = await resolveWorkspaceId();
  const inKit = new Set((await listDomains(wsId)).map((d) => d.name.toLowerCase()));
  const todo = domains.filter((d) => !inKit.has(d));
  const already = domains.length - todo.length;

  console.log(`\n=== infra:connect — ${opts.apply ? 'APPLY' : 'DRY RUN (no writes)'} · ${domains.length} domains ===`);
  console.log(`already in InboxKit: ${already} · to connect: ${todo.length}\n`);

  if (!opts.apply) {
    for (const d of domains) console.log(`  ${inKit.has(d) ? '· (already connected)' : '+ would connect   '} ${d}`);
    console.log(`\nDRY RUN — nothing changed. Re-run with --apply to connect + delegate nameservers.\n`);
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const domain of domains) {
    try {
      const c = await connectDomain(wsId, domain);
      const res = await updateNameservers(domain, c.nameservers);
      const got = (res.hosts ?? []).map((h) => h.toLowerCase()).sort();
      const want = c.nameservers.map((h) => h.toLowerCase()).sort();
      const verified = JSON.stringify(got) === JSON.stringify(want);
      if (verified) ok++;
      else fail++;
      console.log(
        `  ${verified ? '✓' : '✗'} ${domain.padEnd(36)} ${c.alreadyConnected ? '(was connected)' : 'connected'} → ${c.nameservers.join(', ')}`,
      );
    } catch (e) {
      fail++;
      console.log(`  ✗ ${domain.padEnd(36)} ${(e as Error).message.slice(0, 120)}`);
    }
    await sleep(NS_THROTTLE_MS);
  }

  // Read-back: every domain in the list should now exist in InboxKit.
  const after = new Set((await listDomains(wsId)).map((d) => d.name.toLowerCase()));
  const missing = domains.filter((d) => !after.has(d));
  console.log(`\n=== ${fail === 0 && missing.length === 0 ? `ALL ${ok} CONNECTED + DELEGATED` : `${ok} ok, ${fail} failed${missing.length ? `, missing from InboxKit: ${missing.join(', ')}` : ''}`} ===`);
  console.log('NS changes propagate over minutes–hours; InboxKit verifies + manages DNS in Cloudflare once live.');
  console.log('Mailboxes are NOT created by this command — that is infra:inboxes (spends slots/credits).\n');
}

// ---------------- mailboxes: bulk-create inboxes in InboxKit ----------------

// Three local-parts per domain (Casey's standing pattern), one sender identity.
const USERNAMES = ['casey_brown', 'caseybrown', 'casey.brown'];
const FIRST = 'Casey';
const LAST = 'Brown';
// InboxKit bulk provisioning is rate-limited (~10 req/min); ~7s spacing stays safely under.
const MB_THROTTLE_MS = 7000;

const platformOf = (provider: string): string => {
  const p = provider.toLowerCase();
  if (p.startsWith('goog')) return 'GOOGLE';
  if (p.startsWith('micro') || p.startsWith('out')) return 'MICROSOFT';
  return '';
};

/** Read the batch CSV (domain,provider,…) → domain→provider map. */
function readProviderMap(file: string): { domain: string; provider: string }[] {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => {
      const c = l.split(',');
      return { domain: (c[0] ?? '').trim().toLowerCase(), provider: (c[1] ?? '').trim() };
    })
    .filter((r) => r.domain);
}

export async function createMailboxes(opts: { file: string; apply: boolean }): Promise<void> {
  const rows = readProviderMap(opts.file);
  const wsId = await resolveWorkspaceId();
  const existing = await listMailboxes(wsId);
  const have = new Set(existing.map((m) => `${m.domain_name.toLowerCase()}|${m.username.toLowerCase()}`));
  const inKit = new Set((await listDomains(wsId)).map((d) => d.name.toLowerCase()));

  // Build per-domain create plan, skipping mailboxes that already exist (idempotent).
  const plan: { domain: string; platform: string; items: BuyItem[] }[] = [];
  let already = 0;
  let missing = 0;
  for (const { domain, provider } of rows) {
    const platform = platformOf(provider);
    if (!platform) { console.log(`  ! ${domain}: unknown provider "${provider}" — skipping`); continue; }
    if (!inKit.has(domain)) { console.log(`  ! ${domain}: not connected in InboxKit — skipping`); missing++; continue; }
    const items: BuyItem[] = [];
    for (const u of USERNAMES) {
      if (have.has(`${domain}|${u}`)) { already++; continue; }
      items.push({ domain_name: domain, username: u, first_name: FIRST, last_name: LAST, platform });
    }
    if (items.length) plan.push({ domain, platform, items });
  }
  const toCreate = plan.reduce((s, p) => s + p.items.length, 0);

  console.log(`\n=== infra:inboxes — ${opts.apply ? 'CREATE (SPENDS CREDITS)' : 'DRY RUN (no charge)'} ===`);
  console.log(`domains ${rows.length} · ${USERNAMES.length}/domain · already exist ${already} · to create ${toCreate}${missing ? ` · not-in-InboxKit ${missing}` : ''}\n`);
  for (const p of plan) console.log(`  ${p.domain.padEnd(34)} ${p.platform.padEnd(10)} + ${p.items.map((i) => i.username).join(', ')}`);
  if (toCreate === 0) { console.log('\nNothing to create — every mailbox already exists.\n'); return; }
  if (!opts.apply) { console.log(`\nDRY RUN — nothing created. Re-run with --apply to provision ${toCreate} mailboxes.\n`); return; }

  let ok = 0;
  let fail = 0;
  for (const p of plan) {
    try {
      const res = await buyMailboxes(wsId, p.items);
      const n = res.mailboxes?.length ?? 0;
      if (res.error || n !== p.items.length) {
        fail += p.items.length;
        console.log(`  ✗ ${p.domain.padEnd(34)} ${res.message ?? 'unexpected response'} (${n}/${p.items.length})`);
      } else {
        ok += n;
        console.log(`  ✓ ${p.domain.padEnd(34)} ${n} scheduled (${p.items.map((i) => i.username).join(', ')})`);
      }
    } catch (e) {
      fail += p.items.length;
      console.log(`  ✗ ${p.domain.padEnd(34)} ${(e as Error).message.slice(0, 120)}`);
    }
    await sleep(MB_THROTTLE_MS);
  }

  // Final verification: re-list and confirm 3 mailboxes per batch domain.
  const after = await listMailboxes(wsId);
  const count = new Map<string, number>();
  for (const m of after) {
    const d = m.domain_name.toLowerCase();
    if (rows.some((r) => r.domain === d)) count.set(d, (count.get(d) ?? 0) + 1);
  }
  const short = rows.filter((r) => (count.get(r.domain) ?? 0) < USERNAMES.length);
  console.log(`\n=== ${fail === 0 ? `ALL ${ok} SCHEDULED` : `${ok} ok, ${fail} FAILED — see ✗ above`} ===`);
  console.log(
    `verify: ${rows.length - short.length}/${rows.length} domains now have ${USERNAMES.length} mailboxes` +
      (short.length ? ` — short: ${short.map((s) => s.domain).join(', ')}` : ''),
  );
  console.log('Mailboxes provision over a few minutes (status scheduled → active), then warmup begins.\n');
}
