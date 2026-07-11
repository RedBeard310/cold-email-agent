// Post-pull clean: raw Consulti CSV -> approved + rejected CSVs.
//
// Credits are already spent by the time this runs (Consulti bills per returned row), so nothing
// here saves money — it protects list quality. Stages, in order, each stamping reject_reason:
//   1. dup-email        same email twice in the file (defense-in-depth; pull already dedupes)
//   2. dup-person       same person (first+last) at the same domain under a second email/company
//                       (Consulti lists some people under old + new company names)
//   3. title            "Vice President ..." leaks through the server-side "President" keyword;
//                       anything without an owner signal
//   4. blocklist        company/domain names that mark the known wrong-vertical noise
//                       (promo products, printing, signs, publishers, ...)
//   5. airtable-dup     email already in the lead base (Apollo overlap ≈8%, or a prior ingest)
//   6. dead-site        company domain doesn't respond at all (DNS/timeout/conn refused).
//                       Bot walls (403/429/503) count as ALIVE — uncertain is not dead.
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../env';
import { COLUMNS, parseCsv, csvCell } from './pull';

type Row = Record<string, string>;
const OWNER_SIGNAL = /owner|founder|chief executive|ceo|president|principal|managing partner|managing director|partner/i;
const BLOCKLIST = /promotional|\bpromos?\b|\bpromotions?\b|promo product|\bprint(ing|s|works)?\b|\bpress\b|\bsigns?\b|signage|\bswag\b|\bmerch(andise)?\b|apparel|activewear|sportswear|footwear|uniforms?|embroider|troph(y|ies)|engrav|coupon|calendars?\b|publish(er|ing)|magazine|newspaper|\bgifts?\b|jewel|sweepstakes|fulfillment|pest control|real estate/i;

// ---------------- advisors ruleset: the YouTube-compliance gate ----------------
// The offer is "start a YouTube channel to get clients" — worthless to anyone whose firm
// bans or compliance-chokes personal content. Independence proxies validated by sampling
// (2026-07-10): the emp 1-20 server filter kills most captives, but branch teams of giant
// firms list as tiny companies (two Northwestern Mutual rows @nm.com surfaced at "7
// employees"), and BD affiliations leak through titles ("Financial Advisor | RJFS").

/** Wirehouses, employee broker-dealers, insurance BDs, banks, discount giants — advisors here
 *  are either banned from personal YouTube or so compliance-wrapped it's never practiced.
 *  Matched against company name + title (word patterns) and email/company domain (exact). */
const CAPTIVE_TEXT = /merrill|morgan stanley|\bubs\b|wells fargo|goldman|jpmorgan|j\.?p\.? morgan|\bchase\b|bank of america|citigroup|citibank|edward jones|ameriprise|stifel|\bbaird\b|janney|oppenheimer|d\.?a\.? davidson|raymond james & associates|northwestern mutual|new york life|mass ?mutual|guardian life|park avenue securities|prudential|equitable advisors|axa advisors|thrivent|primerica|bankers life|mutual of omaha|western & southern|securian|principal financial|transamerica|modern woodmen|knights of columbus|world financial group|first command|fidelity investments|charles schwab|vanguard group|the standard\b|\bbank\b|\bbanc\w*|credit union/i;
const CAPTIVE_DOMAINS = new Set([
  'ml.com', 'morganstanley.com', 'ubs.com', 'wellsfargo.com', 'wfadvisors.com', 'edwardjones.com',
  'ameriprise.com', 'ampf.com', 'nm.com', 'northwesternmutual.com', 'newyorklife.com',
  'ft.newyorklife.com', 'massmutual.com', 'guardianlife.com', 'parkavenuesecurities.com',
  'prudential.com', 'equitable.com', 'axa-advisors.com', 'thrivent.com', 'primerica.com',
  'bankerslife.com', 'mutualofomaha.com', 'securian.com', 'principal.com', 'transamerica.com',
  'modernwoodmen.org', 'kofc.org', 'firstcommand.com', 'fidelity.com', 'schwab.com',
  'vanguard.com', 'jpmorgan.com', 'chase.com', 'bofa.com', 'citi.com', 'pnc.com', 'usbank.com',
  'truist.com', 'regions.com', 'stifel.com', 'rbc.com', 'janney.com', 'opco.com', 'dadco.com',
  'rwbaird.com', 'standard.com', 'goldmansachs.com', 'gs.com',
]);

/** Independent BD networks — content is allowed but needs firm compliance pre-approval.
 *  Casey's call (2026-07-10): keep, but tag segment=bd_affiliated and hold out of the main
 *  campaigns for a possible softer-copy test later. */
const BD_NETWORK = /\brjfs\b|raymond james|\blpl\b|osaic|cetera|commonwealth financial|cambridge investment|kestra|securities america|avantax|hd vest|woodbury financial|royal alliance|sagepoint|triad advisors|geneos|centaurus|kovack|american portfolios|purshe kaplan|cadaret/i;
const BD_DOMAINS = new Set(['lpl.com', 'lplfinancial.com', 'raymondjames.com', 'osaic.com', 'ceteraadvisors.com', 'ceterafs.com', 'kestrafinancial.com', 'avantax.com']);

/** Junior/support titles — starting a channel isn't their call (Casey: drop, 2026-07-10). */
const JUNIOR_TITLE = /\bassociate\b|paraplanner|\bintern(ship)?\b|assistant|\bjunior\b|\btrainee\b|\bstudent\b|\breceptionist\b|client service|\boperations (manager|specialist|coordinator)\b/i;

/** The 401(k)/pension plan-services vertical (B2B plan vendors, TPAs, actuaries) — the wrong
 *  "retirement": they sell to plan sponsors, not to individuals needing retirement income.
 *  `retirement plan(?!n)` matches "retirement plan(s)" but not "retirement planning/planner". */
const PLAN_VERTICAL = /retirement plan(?!n)|\bplan (services|consultant|consulting|administrat\w*|sponsor)|third.party administrat|\btpa\b|actuar|cash balance|defined (benefit|contribution)|401\(?k\)?|403\(?b\)?|pension/i;

interface Ruleset {
  /** Reject reason for a bad title, or null to keep. */
  titleReject(title: string): string | null;
  /** Reject reason from company/domain/title signals, or null to keep. */
  blockReject(r: Row): string | null;
  /** Optional segment tag stamped on kept rows (adds a `segment` column to the approved CSV). */
  segment?(r: Row): string;
}

const haystack = (r: Row) => `${r.title ?? ''} | ${r.company ?? ''}`;
const domainsOf = (r: Row): string[] =>
  [(r.domain ?? '').toLowerCase(), ((r.email ?? '').split('@')[1] ?? '').toLowerCase()].filter(Boolean);

/** Legal-industry vendor noise — "Legal Services" also carries litigation-support businesses
 *  that aren't law firms (validated in the 2026-07-10 legal smoke test). */
const LEGAL_VENDOR = /court report|process serv|transcription|depositions?\b|courier|legal nurse|jury consult|e-?discovery|litigation support|record retrieval/i;

const RULESETS: Record<string, Ruleset> = {
  marketing: {
    titleReject: (title) => (titleReject(title) ? 'title' : null),
    blockReject: (r) => (BLOCKLIST.test(`${r.company} ${r.domain}`) ? 'blocklist' : null),
  },
  legal: {
    titleReject: (title) => (titleReject(title) ? 'title' : null),
    blockReject: (r) => {
      if (LEGAL_VENDOR.test(haystack(r))) return 'legal-vendor';
      if (BLOCKLIST.test(`${r.company} ${r.domain}`)) return 'blocklist';
      return null;
    },
  },
  advisors: {
    titleReject: (title) => {
      if (JUNIOR_TITLE.test(title)) return 'junior-title';
      if (PLAN_VERTICAL.test(title)) return 'plan-consultant';
      return null;
    },
    blockReject: (r) => {
      if (CAPTIVE_TEXT.test(haystack(r)) || domainsOf(r).some((d) => CAPTIVE_DOMAINS.has(d))) return 'captive-firm';
      if (PLAN_VERTICAL.test(r.company ?? '')) return 'plan-consultant';
      return null;
    },
    segment: (r) =>
      BD_NETWORK.test(haystack(r)) || domainsOf(r).some((d) => BD_DOMAINS.has(d))
        ? 'bd_affiliated'
        : 'independent',
  },
};

/** Personal/ISP mailbox providers. HARD RULE (Casey, 2026-07-10): freemail leads are KEPT —
 *  owners' personal inboxes can be the best-performing contacts. This set only marks rows that
 *  have no company domain to derive (so the dead-site check skips them). */
const FREEMAIL = new Set([
  'gmail.com', 'yahoo.com', 'yahoo.ca', 'ymail.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'live.com', 'msn.com', 'comcast.net', 'att.net',
  'verizon.net', 'sbcglobal.net', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com',
]);

/** Country-code TLDs outside the US/CA ICP (Canada's .ca is allowed). */
const FOREIGN_TLD = /\.(uk|de|fr|es|it|nl|be|at|ch|se|no|dk|fi|ie|pt|gr|pl|cz|sk|hu|ro|bg|hr|rs|ru|ua|tr|in|pk|bd|lk|cn|jp|kr|vn|th|my|sg|ph|id|au|nz|za|ng|ke|gh|ae|sa|br|mx|ar|cl|co\.uk|com\.au)$/i;

function titleReject(title: string): boolean {
  // Strip phrasings that contain owner keywords without conferring ownership, so "Vice
  // President" can't satisfy OWNER_SIGNAL via "President" nor "Brand Partnership Manager"
  // via "Partner".
  const t = title
    .replace(/vice[\s-]*president|\bvp\b|\bevp\b|\bsvp\b|\bavp\b/gi, '')
    .replace(/partnerships?|(client|brand|channel) partner\b|partner (success|experience|development|relations|manager)/gi, '');
  return !OWNER_SIGNAL.test(t);
}

/** The Consulti UI list export is thinner than the API shape (email, first_name, last_name,
 *  job_title, company_name, added_at) — normalize either shape to our CSV columns, deriving
 *  domain from the email host when the export doesn't carry one. */
function normalizeRow(r: Row): Row {
  const email = (r.email ?? '').trim().toLowerCase();
  const host = email.split('@')[1] ?? '';
  const domain = (r.domain || (FREEMAIL.has(host) ? '' : host)).toLowerCase().replace(/^www\./, '');
  return {
    ...r,
    email,
    full_name: r.full_name || [r.first_name, r.last_name].filter(Boolean).join(' '),
    title: r.title || r.job_title || '',
    company: r.company || r.company_name || '',
    domain,
    website: r.website || (domain ? `https://${domain}` : ''),
    source: r.source || 'consulti',
    search_name: r.search_name || 'Marketing Agencies - 1st Batch of 1000 (UI list)',
  };
}

// ---------------- Airtable existing-email fetch ----------------

async function airtableEmails(baseId: string, table: string): Promise<Set<string>> {
  const emails = new Set<string>();
  let offset: string | undefined;
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.append('fields[]', 'email');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
    if (!res.ok) throw new Error(`Airtable ${baseId}/${table} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { records: { fields: { email?: string } }[]; offset?: string };
    for (const r of data.records) if (r.fields.email) emails.add(r.fields.email.trim().toLowerCase());
    offset = data.offset;
  } while (offset);
  return emails;
}

// ---------------- dead-site check ----------------

async function siteAlive(domain: string): Promise<boolean> {
  for (const proto of ['https', 'http'] as const) {
    try {
      const res = await fetch(`${proto}://${domain}`, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      });
      void res.body?.cancel();
      return true; // any HTTP response (even 4xx/5xx bot walls) = something is there
    } catch { /* try next protocol */ }
  }
  return false;
}

async function checkSites(domains: string[], concurrency: number): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const queue = [...new Set(domains)];
  let done = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
        result.set(d, await siteAlive(d));
        if (++done % 100 === 0) console.log(`  site check: ${done}/${result.size + queue.length}`);
      }
    }),
  );
  return result;
}

// ---------------- clean ----------------

export interface CleanOpts {
  file: string;
  ruleset: string;
  /** Airtable tables whose existing emails are rejected as dups (empty = skip). */
  dedupe: { baseId: string; table: string }[];
  skipWeb: boolean;
  concurrency: number;
}

export async function clean(opts: CleanOpts): Promise<void> {
  const rules = RULESETS[opts.ruleset];
  if (!rules) {
    console.log(`unknown --ruleset "${opts.ruleset}" (valid: ${Object.keys(RULESETS).join(', ')})`);
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(opts.file, 'utf8')).map(normalizeRow);
  console.log(`${rows.length} rows from ${opts.file} (ruleset: ${opts.ruleset})`);
  const rejected: (Row & { reject_reason: string })[] = [];
  const reject = (r: Row, reason: string) => rejected.push({ ...r, reject_reason: reason });

  // 1+2: duplicate email / duplicate person+domain
  const byEmail = new Set<string>();
  const byPerson = new Set<string>();
  let pool: Row[] = [];
  for (const r of rows) {
    const email = (r.email ?? '').trim().toLowerCase();
    const person = `${r.first_name}|${r.last_name}|${r.domain}`.toLowerCase();
    if (byEmail.has(email)) { reject(r, 'dup-email'); continue; }
    if (r.first_name && r.domain && byPerson.has(person)) { reject(r, 'dup-person'); continue; }
    byEmail.add(email); byPerson.add(person);
    pool.push(r);
  }

  // 3: title
  pool = pool.filter((r) => {
    const reason = rules.titleReject(r.title ?? '');
    return reason ? (reject(r, reason), false) : true;
  });

  // 4: ruleset blocklist (company/domain/title signals)
  pool = pool.filter((r) => {
    const reason = rules.blockReject(r);
    return reason ? (reject(r, reason), false) : true;
  });

  // 4b: .edu addresses and non-US/CA country TLDs. Freemail is deliberately KEPT (hard rule).
  pool = pool.filter((r) => {
    const host = (r.email ?? '').split('@')[1] ?? '';
    if (host.endsWith('.edu')) return (reject(r, 'edu-email'), false);
    if (r.domain && FOREIGN_TLD.test(r.domain)) return (reject(r, 'foreign-tld'), false);
    return true;
  });

  // 4c: curated per-domain drop list (.consulti/drop-domains.txt: "<domain> <reason>" per line).
  // Populated by the homepage-review pass — off-vertical companies and parked/broken sites that
  // name-based rules can't see.
  const dropFile = path.join('.consulti', 'drop-domains.txt');
  if (fs.existsSync(dropFile)) {
    const drops = new Map<string, string>();
    for (const line of fs.readFileSync(dropFile, 'utf8').split('\n')) {
      const m = line.trim().match(/^([^\s#]+)\s*(.*)$/);
      if (m?.[1]) drops.set(m[1].toLowerCase(), m[2] || 'off-vertical');
    }
    pool = pool.filter((r) => {
      const host = (r.email ?? '').split('@')[1] ?? '';
      const reason = drops.get((r.domain ?? '').toLowerCase()) ?? drops.get(host.toLowerCase());
      return reason ? (reject(r, reason), false) : true;
    });
  }

  // 5: already in Airtable (any of the configured tables)
  for (const { baseId, table } of opts.dedupe) {
    console.log(`Fetching existing emails from Airtable ${baseId}/${table}...`);
    const existing = await airtableEmails(baseId, table);
    console.log(`  ${existing.size} existing emails`);
    pool = pool.filter((r) => (existing.has((r.email ?? '').trim().toLowerCase()) ? (reject(r, 'airtable-dup'), false) : true));
  }

  // 6: dead site
  if (!opts.skipWeb) {
    console.log(`Checking ${new Set(pool.map((r) => r.domain)).size} domains (concurrency ${opts.concurrency})...`);
    const alive = await checkSites(pool.map((r) => r.domain).filter((d): d is string => !!d), opts.concurrency);
    pool = pool.filter((r) => (r.domain && alive.get(r.domain) === false ? (reject(r, 'dead-site'), false) : true));
  }

  // segment tagging on kept rows (advisors: independent vs bd_affiliated)
  if (rules.segment) for (const r of pool) r.segment = rules.segment(r);

  const stamp = new Date().toISOString().slice(0, 10);
  const base = path.basename(opts.file, '.csv');
  const approvedFile = `consulti-approved-${stamp}-${base}.csv`;
  const rejectedFile = `consulti-rejected-${stamp}-${base}.csv`;
  const cols = rules.segment ? [...COLUMNS, 'segment'] : [...COLUMNS];
  const line = (r: Row, cs: string[]) => cs.map((c) => csvCell(r[c] ?? '')).join(',');
  fs.writeFileSync(approvedFile, [cols.join(','), ...pool.map((r) => line(r, cols))].join('\n') + '\n');
  const rcols = [...cols, 'reject_reason'];
  fs.writeFileSync(rejectedFile, [rcols.join(','), ...rejected.map((r) => line(r, rcols))].join('\n') + '\n');

  const byReason = rejected.reduce<Record<string, number>>((m, r) => ((m[r.reject_reason] = (m[r.reject_reason] ?? 0) + 1), m), {});
  console.log(`\nApproved: ${pool.length}/${rows.length} (${((100 * pool.length) / rows.length).toFixed(1)}%) -> ${approvedFile}`);
  if (rules.segment) {
    const bySeg = pool.reduce<Record<string, number>>((m, r) => ((m[r.segment!] = (m[r.segment!] ?? 0) + 1), m), {});
    for (const [seg, n] of Object.entries(bySeg).sort((a, b) => b[1] - a[1])) console.log(`  segment ${seg}: ${n}`);
  }
  console.log(`Rejected: ${rejected.length} -> ${rejectedFile}`);
  for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`  ${reason}: ${n}`);
}
