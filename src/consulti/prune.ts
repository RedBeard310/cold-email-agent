// Post-load garbage sweep over the per-niche Airtable bases — checks the clean pass can't do
// (or didn't): signals that only exist once the whole cohort is loaded (duplicate companies,
// cross-niche collisions) plus a homepage CONTENT pass (clean only checked the site answers;
// this reads what it says).
//
// Removals (deleted with --apply, always archived to consulti-pruned-<date>.csv first):
//   role-email     info@/office@/frontdesk@… — gatekeeper inboxes; ZB flags them do_not_mail
//                  anyway, deleting now saves verification credits
//   disposable     throwaway mail providers
//   dup-domain     2nd..Nth contact at the same company domain — one pitch per firm; the best
//                  title is kept (partners at the same firm compare notes)
//   x-niche-email  same email loaded into an earlier niche base (would get two pitches)
//   parked-domain  homepage is a domain-parking / for-sale page (responds 200, so the
//                  dead-site check can't see it)
//
// Flags (written to consulti-review-<date>.csv, NEVER auto-deleted — human judgment):
//   keyword-miss     homepage loads real text but contains zero niche-relevant keywords
//   placeholder-site "coming soon" / "under construction" shell
//   unreachable      site answered during clean but not now (transient until proven dead)
//   x-niche-domain   same company domain appears in two niche bases (different people)
//   bad-first-name   blank/1-char/non-name first_name — personalization would look broken
import fs from 'node:fs';
import { env } from '../env';
import { csvCell } from './pull';

const API = 'https://api.airtable.com/v0';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PruneNiche {
  key: string;
  baseId: string;
  table: string;
  /** Homepage must contain at least one of these (lowercase substrings) or the row is
   *  flagged keyword-miss. Generous on purpose: a false KEEP is cheap, a false flag wastes
   *  review time. */
  keywords: string[];
  /** Domains many DIFFERENT businesses legitimately share (BD parent brands) — exempt from
   *  dup-domain grouping and homepage judgment, like freemail. */
  sharedDomains?: string[];
  /** Extra Airtable fields to fetch for this niche only (requesting a field a base doesn't
   *  have 422s, so per-niche opt-in). */
  extraFields?: string[];
  /** 'flag' = report same-firm extras but never delete; 'off' = don't even flag. Advisors
   *  are 'off' (Casey, 2026-07-10): the offer is a per-ADVISOR YouTube channel and the
   *  mid-size RIA thesis deliberately targets several advisors per firm — "the more shots
   *  you take, the more baskets you can sink." */
  dupDomain?: 'remove' | 'flag' | 'off';
}

export const PRUNE_NICHES: PruneNiche[] = [
  {
    key: 'legal', baseId: 'app8n1wbsUWA2gz2d', table: 'Leads',
    keywords: ['law', 'legal', 'attorn', 'litigat', 'counsel', 'paralegal', 'estate', 'injur',
      'divorce', 'immigra', 'bankrupt', 'trademark', 'patent', 'defense', 'defence', 'court',
      'justice', 'mediat', 'notary', 'title', 'closing'],
  },
  {
    key: 'accounting', baseId: 'app2hlEL7sBTl5wcK', table: 'Leads',
    keywords: ['account', 'cpa', 'tax', 'bookkeep', 'audit', 'payroll', 'quickbooks', 'irs',
      'cfo', 'financ', 'advisory', 'enrolled agent', 'ledger', 'controller'],
  },
  {
    key: 'health', baseId: 'appxifYj6Do6jfYGR', table: 'Leads',
    keywords: ['clinic', 'patient', 'medical', 'health', 'therap', 'wellness', 'doctor',
      'physician', 'dental', 'dentist', 'dermatol', 'pediatric', 'psychiatr', 'psycholog',
      'counseling', 'counselling', 'chiroprac', 'acupunct', 'treatment', 'care', 'nurse',
      'surg', 'orthop', 'cardio', 'appointment', 'medicine', 'recovery', 'rehab', 'hospice'],
  },
  {
    key: 'consulting', baseId: 'app5OHPgae9dTLSCD', table: 'Leads',
    keywords: ['consult', 'advis', 'strateg', 'coach', 'management', 'leadership',
      'transformation', 'operations', 'growth', 'improvement', 'organizational', 'executive',
      'facilitat', 'training', 'solutions', 'expertise', 'clients'],
  },
  {
    // Mixed Apollo + Consulti base (the 11.5k marketing-agency pool).
    key: 'marketing', baseId: 'appGzk9z2io4dPJUB', table: 'Leads',
    keywords: ['marketing', 'advertis', 'brand', 'agenc', 'creativ', 'design', 'media', 'seo',
      'social', 'digital', 'public relations', 'communication', 'studio', 'web', 'content',
      'strateg', 'campaign', 'growth', 'video', 'graphic', 'ppc', 'commerce', 'funnel', 'lead'],
  },
  {
    key: 'staffing', baseId: 'appi362RoZ7vi2Hsd', table: 'Leads',
    keywords: ['staffing', 'recruit', 'talent', 'search', 'placement', 'personnel', 'headhunt',
      'executive search', 'hiring', 'candidates', 'careers', 'jobs', 'workforce', 'employment',
      'human resources', 'hr ', 'temp'],
  },
  {
    // Consulti-discovered advisors ONLY ("Consulti Leads"). Table 1 (registration-scraped,
    // already in live campaigns) is deliberately NOT a prune target.
    key: 'advisors', baseId: 'appvEVgfYvyNIms2h', table: 'Consulti Leads',
    keywords: ['financial', 'advisor', 'adviser', 'wealth', 'retire', 'invest', 'planning',
      'planner', 'fiduciary', 'cfp', 'portfolio', 'asset', 'capital', 'insurance', 'estate',
      'tax', '401', 'ira', 'income', 'securities', 'fee-only'],
    sharedDomains: ['raymondjames.com', 'lpl.com', 'lplfinancial.com', 'cir2.com', 'joincambridge.com'],
    extraFields: ['segment'],
    dupDomain: 'off',
  },
];

/** Gatekeeper / shared-inbox local parts. A named owner behind info@ is still a shared inbox —
 *  and ZeroBounce marks role accounts do_not_mail regardless. */
const ROLE_LOCALS = new Set([
  'info', 'contact', 'contactus', 'office', 'admin', 'administrator', 'hello', 'sales',
  'support', 'billing', 'frontdesk', 'reception', 'receptionist', 'enquiries', 'inquiries',
  'inquiry', 'mail', 'email', 'team', 'help', 'service', 'services', 'accounts', 'accounting',
  'bookings', 'booking', 'appointments', 'scheduling', 'marketing', 'hr', 'careers', 'jobs',
  'press', 'media', 'webmaster', 'postmaster', 'noreply', 'no-reply', 'general', 'staff',
]);
const DISPOSABLE = /mailinator|guerrillamail|10minutemail|yopmail|temp-?mail|trashmail|dispostable|sharklasers/i;

/** Freemail hosts leak into the domain column when Consulti had no company_domain (pull.ts
 *  falls back to the email host). Never treat them as a company site: no dup-domain grouping,
 *  no homepage judgment — gmail.com's homepage obviously has no law-firm keywords. */
const FREEMAIL = new Set([
  'gmail.com', 'yahoo.com', 'yahoo.ca', 'ymail.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'live.com', 'msn.com', 'comcast.net', 'att.net',
  'verizon.net', 'sbcglobal.net', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com',
  'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net', 'rogers.com', 'shaw.ca',
]);

const PARKED = /(domain|website) ?(is|may be)? ?for ?sale|buy this domain|purchase this domain|hugedomains|sedoparking|\bafternic\b|parked free|domain parking|this domain has expired|godaddy auctions|is parked|domainmarket\.com/i;
const PLACEHOLDER = /coming soon|under construction|site is being built|launching soon|default web ?site page|plesk|cpanel/i;

const rowUrl = (baseId: string, table: string) => `${API}/${baseId}/${encodeURIComponent(table)}`;

async function req<T>(method: string, url: string, body?: unknown, attempt = 0): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_PAT}`,
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`Airtable ${method} ${url} -> ${res.status} after retries`);
    await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    return req<T>(method, url, body, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Airtable ${method} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

interface Rec { id: string; f: Record<string, string> }
const FIELDS = ['email', 'first_name', 'last_name', 'title', 'company', 'domain', 'search_name'];

async function fetchAll(n: PruneNiche): Promise<Rec[]> {
  const out: Rec[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(rowUrl(n.baseId, n.table));
    url.searchParams.set('pageSize', '100');
    for (const f of [...FIELDS, ...(n.extraFields ?? [])]) url.searchParams.append('fields[]', f);
    if (offset) url.searchParams.set('offset', offset);
    const data = await req<{ records: { id: string; fields: Record<string, string> }[]; offset?: string }>('GET', url.toString());
    for (const r of data.records) out.push({ id: r.id, f: r.fields });
    offset = data.offset;
  } while (offset);
  return out;
}

async function deleteRecords(n: PruneNiche, ids: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const url = new URL(rowUrl(n.baseId, n.table));
    for (const id of ids.slice(i, i + 10)) url.searchParams.append('records[]', id);
    const r = await req<{ records: { deleted: boolean }[] }>('DELETE', url.toString());
    deleted += r.records.filter((x) => x.deleted).length;
    await sleep(220);
  }
  return deleted;
}

// ---------------- homepage content check ----------------

type SiteVerdict =
  | { kind: 'parked' } | { kind: 'placeholder' } | { kind: 'keyword-miss' }
  | { kind: 'ok' } | { kind: 'blocked' } | { kind: 'unreachable' };

async function judgeSite(domain: string, keywords: string[]): Promise<SiteVerdict> {
  for (const proto of ['https', 'http'] as const) {
    try {
      const res = await fetch(`${proto}://${domain}`, {
        method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      });
      if (!res.ok) { void res.body?.cancel(); return { kind: 'blocked' }; } // bot wall — no judgment
      const html = (await res.text()).slice(0, 400_000).toLowerCase();
      if (PARKED.test(html)) return { kind: 'parked' };
      const text = html
        .replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      if (PLACEHOLDER.test(text) && text.length < 3000) return { kind: 'placeholder' };
      // Judge keywords on the RAW html (nav/meta/alt text count); only when there's enough of
      // it that "no keywords" means something — thin JS-rendered shells stay un-judged.
      if (html.length > 1500 && text.length > 300 && !keywords.some((k) => html.includes(k))) {
        return { kind: 'keyword-miss' };
      }
      return { kind: 'ok' };
    } catch { /* try next protocol */ }
  }
  return { kind: 'unreachable' };
}

async function judgeSites(
  jobs: { domain: string; keywords: string[] }[],
  concurrency: number,
): Promise<Map<string, SiteVerdict>> {
  const out = new Map<string, SiteVerdict>();
  const queue = [...jobs];
  const total = jobs.length;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let j = queue.shift(); j !== undefined; j = queue.shift()) {
        out.set(j.domain, await judgeSite(j.domain, j.keywords));
        if (out.size % 250 === 0) console.log(`  homepage check: ${out.size}/${total}`);
      }
    }),
  );
  return out;
}

// ---------------- prune ----------------

// ---------------- first-name ↔ email mismatch (Casey, 2026-07-10: "lead named Michael but
// email says samantha@ = bad data") ----------------
// The email is ground truth — it's whose inbox the message lands in — so a confirmed
// mismatch FIXES first_name to the inbox owner's name instead of deleting a paid lead.
// "Confirmed" is deliberately strict: the email's leading token must look like a human first
// name (seen ≥3 times as a first_name across the fetched cohort, or a known nickname) AND
// share nothing with the lead's own first/last name (prefix, nickname, initial+lastname…).

const NICKNAMES: Record<string, string> = {
  mike: 'michael', mick: 'michael', bill: 'william', will: 'william', billy: 'william',
  bob: 'robert', rob: 'robert', bobby: 'robert', bert: 'robert', rick: 'richard',
  rich: 'richard', dick: 'richard', jim: 'james', jimmy: 'james', jamie: 'james',
  tom: 'thomas', tommy: 'thomas', dave: 'david', steve: 'steven', stephen: 'steven',
  chris: 'christopher', kris: 'christopher', matt: 'matthew', dan: 'daniel', danny: 'daniel',
  tony: 'anthony', andy: 'andrew', drew: 'andrew', joe: 'joseph', joey: 'joseph',
  jeff: 'jeffrey', geoff: 'jeffrey', greg: 'gregory', ken: 'kenneth', kenny: 'kenneth',
  tim: 'timothy', ron: 'ronald', ronnie: 'ronald', don: 'donald', ed: 'edward',
  eddie: 'edward', ted: 'edward', ned: 'edward', sam: 'samuel', pat: 'patrick',
  kate: 'katherine', katie: 'katherine', kathy: 'katherine', kat: 'katherine',
  cathy: 'catherine', liz: 'elizabeth', beth: 'elizabeth', betsy: 'elizabeth',
  libby: 'elizabeth', sue: 'susan', suzie: 'susan', debbie: 'deborah', deb: 'deborah',
  becky: 'rebecca', jen: 'jennifer', jenny: 'jennifer', vicky: 'victoria', tori: 'victoria',
  sandy: 'sandra', cindy: 'cynthia', nick: 'nicholas', alex: 'alexander', ben: 'benjamin',
  charlie: 'charles', chuck: 'charles', hank: 'henry', harry: 'henry', larry: 'lawrence',
  terry: 'terrence', jerry: 'gerald', gerry: 'gerald', frank: 'francis', fred: 'frederick',
  walt: 'walter', ray: 'raymond', phil: 'philip', nate: 'nathan', zach: 'zachary',
  zack: 'zachary', josh: 'joshua', jake: 'jacob', gabe: 'gabriel', al: 'albert',
  art: 'arthur', brad: 'bradley', doug: 'douglas', gene: 'eugene', herb: 'herbert',
  jack: 'john', johnny: 'john', jon: 'john', stan: 'stanley', gus: 'august', wes: 'wesley',
  gwen: 'gwendolyn', trish: 'patricia', peggy: 'margaret', maggie: 'margaret',
  meg: 'margaret', molly: 'mary', polly: 'mary', nan: 'nancy', abby: 'abigail',
};
const canonName = (s: string) => NICKNAMES[s] ?? s;

/** Leading alphabetic token of the email local part ("samantha.jones" -> "samantha"). */
function emailNameToken(email: string): string {
  const local = email.split('@')[0] ?? '';
  return (local.split(/[._\-+0-9]/)[0] ?? '').toLowerCase();
}

/** Does the email plausibly belong to the named lead? Errs toward YES — only a token that
 *  shares nothing with either name counts as foreign. */
function emailMatchesLead(email: string, first: string, last: string): boolean {
  const local = (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const tok = emailNameToken(email);
  const f = first.toLowerCase().replace(/[^a-z]/g, '');
  const l = last.toLowerCase().replace(/[^a-z]/g, '');
  if (!tok || tok.length < 3 || !f) return true; // too little signal to call it a mismatch
  if (tok.startsWith(f.slice(0, 3)) || f.startsWith(tok)) return true;
  if (canonName(tok) === canonName(f)) return true;
  if (l && (tok.includes(l) || (l.length >= 4 && local.includes(l)))) return true;
  if (l && tok[0] === f[0] && tok.slice(1).startsWith(l.slice(0, 3))) return true; // jsmith
  if (local.includes(f) || (f.length >= 4 && local.includes(f.slice(0, 4)))) return true;
  return false;
}

interface NameFix { niche: PruneNiche; rec: Rec; from: string; to: string }

/** Dictionary-confirmed mismatches. The dictionary is the cohort itself: any name seen ≥3
 *  times as a first_name (plus known nicknames) — so brand words like "smile" never qualify. */
function findNameFixes(targets: PruneNiche[], survivors: Map<string, Rec[]>): NameFix[] {
  const nameFreq = new Map<string, number>();
  for (const n of targets) {
    for (const r of survivors.get(n.key)!) {
      const f = (r.f.first_name ?? '').trim().toLowerCase();
      if (/^[a-z]{3,}$/.test(f)) nameFreq.set(f, (nameFreq.get(f) ?? 0) + 1);
    }
  }
  const isKnownName = (t: string) => (nameFreq.get(t) ?? 0) >= 3 || t in NICKNAMES;
  const fixes: NameFix[] = [];
  for (const n of targets) {
    for (const r of survivors.get(n.key)!) {
      const email = (r.f.email ?? '').toLowerCase();
      const first = (r.f.first_name ?? '').trim();
      const last = (r.f.last_name ?? '').trim();
      if (!email || !first || emailMatchesLead(email, first, last)) continue;
      const tok = emailNameToken(email);
      if (!isKnownName(tok)) continue; // token isn't a human name — leave it alone
      fixes.push({ niche: n, rec: r, from: first, to: tok[0]!.toUpperCase() + tok.slice(1) });
    }
  }
  return fixes;
}

async function applyNameFixes(n: PruneNiche, fixes: NameFix[]): Promise<number> {
  let updated = 0;
  for (let i = 0; i < fixes.length; i += 10) {
    const records = fixes.slice(i, i + 10).map((x) => ({ id: x.rec.id, fields: { first_name: x.to } }));
    const r = await req<{ records: unknown[] }>('PATCH', rowUrl(n.baseId, n.table), { records });
    updated += r.records.length;
    await sleep(220);
  }
  return updated;
}

/** Higher = better contact to keep when a domain has several. */
const titleRank = (t: string): number =>
  /founder|owner|chief executive|\bceo\b/i.test(t) ? 3 : /president|principal|managing/i.test(t) ? 2 : 1;

const BAD_FIRST = (n: string) => !n || n.length < 2 || !/^[a-z][a-z .'’-]*$/i.test(n);

export interface PruneOpts { niches: string[]; apply: boolean; skipWeb: boolean; concurrency: number }

export async function prune(opts: PruneOpts): Promise<void> {
  const targets = PRUNE_NICHES.filter((n) => opts.niches.includes(n.key));
  if (!targets.length) {
    console.log(`no niches matched (valid: ${PRUNE_NICHES.map((n) => n.key).join(', ')}, or "all")`);
    process.exit(1);
  }
  console.log(`=== consulti:prune — ${opts.apply ? 'APPLY (deletes from Airtable, archived first)' : 'DRY RUN (no deletes)'} ===`);
  console.log(`niches: ${targets.map((n) => n.key).join(', ')} · web pass: ${opts.skipWeb ? 'OFF' : `on (concurrency ${opts.concurrency})`}\n`);

  type Marked = { niche: PruneNiche; rec: Rec; reason: string };
  const removals: Marked[] = [];
  const flags: Marked[] = [];
  const survivors = new Map<string, Rec[]>(); // niche key -> rows still standing after offline passes

  // -- fetch + offline passes, niche by niche
  const emailOwner = new Map<string, string>(); // email -> first niche that claimed it
  const domainOwner = new Map<string, string>(); // domain -> first niche that claimed it
  for (const n of targets) {
    const recs = await fetchAll(n);
    console.log(`[${n.key}] ${recs.length} records in ${n.baseId}/${n.table}`);
    let pool: Rec[] = [];

    for (const r of recs) {
      const email = (r.f.email ?? '').trim().toLowerCase();
      const local = email.split('@')[0] ?? '';
      const host = email.split('@')[1] ?? '';
      if (ROLE_LOCALS.has(local)) { removals.push({ niche: n, rec: r, reason: 'role-email' }); continue; }
      if (DISPOSABLE.test(host)) { removals.push({ niche: n, rec: r, reason: 'disposable' }); continue; }
      const prior = emailOwner.get(email);
      if (prior && prior !== n.key) { removals.push({ niche: n, rec: r, reason: `x-niche-email(${prior})` }); continue; }
      emailOwner.set(email, n.key);
      pool.push(r);
    }

    // dup-domain: one contact per company; keep the strongest title (then the one with a
    // real first name), archive the rest. BD-shared domains and bd_affiliated advisor rows
    // are exempt — many independent practices legitimately share a parent brand's domain.
    const shared = new Set(n.sharedDomains ?? []);
    const byDomain = new Map<string, Rec[]>();
    for (const r of pool) {
      const d = (r.f.domain ?? '').toLowerCase();
      if (!d || FREEMAIL.has(d) || shared.has(d) || r.f.segment === 'bd_affiliated') continue;
      byDomain.set(d, [...(byDomain.get(d) ?? []), r]);
    }
    const dropIds = new Set<string>();
    for (const [d, group] of byDomain) {
      const owner = domainOwner.get(d);
      if (owner && owner !== n.key) flags.push({ niche: n, rec: group[0]!, reason: `x-niche-domain(${owner})` });
      else domainOwner.set(d, n.key);
      if (group.length < 2) continue;
      const keep = [...group].sort((a, b) =>
        titleRank(b.f.title ?? '') - titleRank(a.f.title ?? '') ||
        Number(!BAD_FIRST(b.f.first_name ?? '')) - Number(!BAD_FIRST(a.f.first_name ?? '')),
      )[0]!;
      for (const g of group) {
        if (g.id === keep.id || n.dupDomain === 'off') continue;
        if (n.dupDomain === 'flag') flags.push({ niche: n, rec: g, reason: 'dup-domain' });
        else { dropIds.add(g.id); removals.push({ niche: n, rec: g, reason: 'dup-domain' }); }
      }
    }
    pool = pool.filter((r) => !dropIds.has(r.id));

    for (const r of pool) {
      if (BAD_FIRST((r.f.first_name ?? '').trim())) flags.push({ niche: n, rec: r, reason: 'bad-first-name' });
    }
    survivors.set(n.key, pool);
  }

  // -- homepage content pass over every surviving unique company domain
  if (!opts.skipWeb) {
    const domainNiches = new Map<string, Set<string>>();
    for (const n of targets) {
      const shared = new Set(n.sharedDomains ?? []);
      for (const r of survivors.get(n.key)!) {
        const d = (r.f.domain ?? '').toLowerCase();
        if (!d || FREEMAIL.has(d) || shared.has(d)) continue;
        domainNiches.set(d, (domainNiches.get(d) ?? new Set()).add(n.key));
      }
    }
    const kwFor = (d: string): string[] =>
      [...domainNiches.get(d)!].flatMap((k) => PRUNE_NICHES.find((x) => x.key === k)!.keywords);
    const jobs = [...domainNiches.keys()].map((domain) => ({ domain, keywords: kwFor(domain) }));
    console.log(`\nHomepage content pass: ${jobs.length} unique domains…`);
    const verdicts = await judgeSites(jobs, opts.concurrency);

    const counts: Record<string, number> = {};
    for (const v of verdicts.values()) counts[v.kind] = (counts[v.kind] ?? 0) + 1;
    console.log(`  verdicts: ${Object.entries(counts).map(([k, c]) => `${k} ${c}`).join(' · ')}`);

    for (const n of targets) {
      for (const r of survivors.get(n.key)!) {
        const d = (r.f.domain ?? '').toLowerCase();
        const v = d ? verdicts.get(d) : undefined;
        if (!v) continue;
        if (v.kind === 'parked') removals.push({ niche: n, rec: r, reason: 'parked-domain' });
        else if (v.kind === 'keyword-miss') flags.push({ niche: n, rec: r, reason: 'keyword-miss' });
        else if (v.kind === 'placeholder') flags.push({ niche: n, rec: r, reason: 'placeholder-site' });
        else if (v.kind === 'unreachable') flags.push({ niche: n, rec: r, reason: 'unreachable' });
      }
    }
  }

  // -- first-name ↔ email mismatch fixes (cohort-dictionary confirmed)
  const nameFixes = findNameFixes(targets, survivors);
  if (nameFixes.length) {
    console.log(`\n--- first-name fixes: ${nameFixes.length} (email is ground truth) ---`);
    for (const f of nameFixes.slice(0, 12)) {
      console.log(`  ${f.niche.key.padEnd(11)} ${f.rec.f.email}  "${f.from}" -> "${f.to}"`);
    }
    if (nameFixes.length > 12) console.log(`  … and ${nameFixes.length - 12} more`);
  }

  // -- archives + report. Same-day re-runs must never clobber an earlier run's archive —
  // uniquify with a -2/-3 suffix (same pattern as pull.ts raw CSVs).
  const stamp = new Date().toISOString().slice(0, 10);
  const cols = ['niche', 'reason', ...FIELDS];
  const line = (m: Marked) => [m.niche.key, m.reason, ...FIELDS.map((f) => m.rec.f[f] ?? '')].map(csvCell).join(',');
  const uniquify = (base: string): string => {
    let f = `${base}.csv`;
    for (let i = 2; fs.existsSync(f); i++) f = `${base}-${i}.csv`;
    return f;
  };
  const prunedFile = uniquify(`consulti-pruned-${stamp}`);
  const reviewFile = uniquify(`consulti-review-${stamp}`);
  fs.writeFileSync(prunedFile, [cols.join(','), ...removals.map(line)].join('\n') + '\n');
  fs.writeFileSync(reviewFile, [cols.join(','), ...flags.map(line)].join('\n') + '\n');

  console.log(`\n--- removals: ${removals.length} (archived -> ${prunedFile}) ---`);
  report(removals);
  console.log(`\n--- flags for review: ${flags.length} (NOT deleted -> ${reviewFile}) ---`);
  report(flags);

  if (!opts.apply) {
    console.log(`\nDRY RUN — nothing deleted or fixed. Re-run with --apply to remove the ${removals.length} rows and apply the ${nameFixes.length} name fixes above.\n`);
    return;
  }

  console.log('');
  for (const n of targets) {
    const ids = removals.filter((m) => m.niche.key === n.key).map((m) => m.rec.id);
    if (ids.length) console.log(`[${n.key}] deleted ${await deleteRecords(n, ids)}/${ids.length} from ${n.baseId}`);
    const fx = nameFixes.filter((f) => f.niche.key === n.key);
    if (fx.length) console.log(`[${n.key}] fixed ${await applyNameFixes(n, fx)}/${fx.length} first names`);
    if (!ids.length && !fx.length) console.log(`[${n.key}] nothing to change`);
  }
  console.log(`\n✓ done. Removed rows are archived in ${prunedFile}; flags awaiting review in ${reviewFile}.\n`);
}

function report(marked: { niche: PruneNiche; rec: Rec; reason: string }[]): void {
  const byNiche = new Map<string, Map<string, { n: number; samples: string[] }>>();
  for (const m of marked) {
    const reasons = byNiche.get(m.niche.key) ?? new Map();
    byNiche.set(m.niche.key, reasons);
    const e = reasons.get(m.reason) ?? { n: 0, samples: [] };
    e.n++;
    if (e.samples.length < 4) e.samples.push(`${m.rec.f.email ?? '?'} (${m.rec.f.company ?? m.rec.f.domain ?? '?'})`);
    reasons.set(m.reason, e);
  }
  for (const [niche, reasons] of byNiche) {
    for (const [reason, e] of [...reasons].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${niche.padEnd(11)} ${reason.padEnd(22)} ${String(e.n).padStart(5)}   e.g. ${e.samples.slice(0, 2).join(' · ')}`);
    }
  }
}
