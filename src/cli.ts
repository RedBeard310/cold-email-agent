// Thin CLI dispatcher (house style: src/cli.ts -> subcommands).
//   preview            — render the active niche's campaigns offline (no network)
//   dry-run            — read Airtable, map/split, mirror D100 settings, write a plan file. No writes.
//   create [--limit N] — create campaigns DRAFTED/paused, configure, verify, load N leads
//                        (default 50). --full loads the whole segment. Never starts, never
//                        attaches inboxes.

import { NICHES } from './niches';
import { expandSpintax, spintaxVariants } from './engine/spintax';
import type { NicheConfig } from './engine/types';

/** Campaign whose schedule/settings we mirror (a live Dream 100 campaign). */
const MIRROR_CAMPAIGN_ID = 3373321;
const LEAD_LOAD_SETTINGS = {
  ignore_global_block_list: false,
  ignore_unsubscribe_list: false,
  ignore_community_bounce_list: false,
  ignore_duplicate_leads_in_other_campaign: false,
};

// ---------------- preview (offline) ----------------

function seededPick(seed: number): (n: number) => number {
  let s = seed >>> 0 || 1;
  return (n: number) => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s % n);
}
function render(body: string, firstName: string, seed: number): string {
  return expandSpintax(body, seededPick(seed)).replace(/\{\{\s*first_name\s*\}\}/g, () => firstName);
}
const indent = (t: string, pad = '    ') => t.split('\n').map((l) => pad + l).join('\n');

function preview(config: NicheConfig): void {
  console.log(`\n=== ${config.niche}: campaign preview (offline, nothing sent) ===`);
  const nameEntry = config.fieldMap.first_name;
  if (nameEntry?.transform) {
    const fb = nameEntry.fallback ?? '';
    console.log('\nFirst-name normalization (ALL-CAPS source -> what recipients see):');
    for (const sample of ['RONALD', 'MARY ANN', "O'BRIEN", 'AJ', '']) {
      console.log(`    "${sample}"`.padEnd(20) + `-> ${nameEntry.transform(sample) ?? `(blank -> "${fb}")`}`);
    }
  }
  for (const seq of config.sequences) {
    console.log(`\n\n========== ${config.campaignPrefix}${seq.name} ==========`);
    seq.emails.forEach((e, i) => {
      const when = e.delayDays === 0 ? 'Day 0' : `+${e.delayDays} days`;
      const subj = e.subject ? `Subject: "${e.subject}"` : 'Subject: (reply in same thread)';
      console.log(`\n  --- Email ${i + 1}  [${when}]  ${subj}  [${spintaxVariants(e.body)} variants] ---`);
      console.log(indent(render(e.body, 'Ronald', 1000 + i * 7)));
    });
  }
  console.log();
}

// ---------------- shared lead plan ----------------

interface LeadPlan {
  buckets: Record<string, string>[][];
  leads: Record<string, string>[];
  stats: { capsFixed: number; blankName: number; droppedNoEmail: number; dupes: number };
}

async function buildLeadPlan(config: NicheConfig): Promise<LeadPlan> {
  const { fetchRecords } = await import('./engine/airtable');
  const { mapLead } = await import('./engine/mapping');
  const { equalSplit } = await import('./engine/split');

  const nameField = config.fieldMap.first_name?.from ?? '';
  const fieldsNeeded = [...new Set(Object.values(config.fieldMap).map((e) => e.from))];
  console.log(`Reading segment from Airtable ${config.airtable.baseId} / "${config.airtable.table}"…`);
  const records = await fetchRecords(config.airtable.baseId, config.airtable.table, {
    filterByFormula: config.airtable.segmentFormula,
    fields: fieldsNeeded,
  });
  console.log(`  fetched ${records.length} records`);

  const stats = { capsFixed: 0, blankName: 0, droppedNoEmail: 0, dupes: 0 };
  const seen = new Set<string>();
  const leads: Record<string, string>[] = [];
  for (const r of records) {
    const rawName = String(r.fields[nameField] ?? '').trim();
    const lead = mapLead(r.fields, config.fieldMap);
    const email = (lead.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) { stats.droppedNoEmail++; continue; }
    if (seen.has(email)) { stats.dupes++; continue; }
    seen.add(email);
    if (!rawName) stats.blankName++;
    else if (rawName.length > 2 && rawName === rawName.toUpperCase() && /[A-Z]/.test(rawName)) stats.capsFixed++;
    leads.push(lead);
  }
  const n = config.sequences.length;
  const buckets = equalSplit(leads, (l) => l.email ?? '', n);
  return { buckets, leads, stats };
}

async function mirrorSettings() {
  const { getCampaign } = await import('./engine/smartlead');
  const m = await getCampaign(MIRROR_CAMPAIGN_ID);
  const cron = m.scheduler_cron_value ?? {};
  const schedule = {
    timezone: cron.tz ?? 'America/New_York',
    days_of_the_week: cron.days ?? [1, 2, 3, 4],
    start_hour: cron.startHour ?? '09:00',
    end_hour: cron.endHour ?? '15:00',
    min_time_btw_emails: m.min_time_btwn_emails ?? 12,
    // HARD RULE (2026-07-13): never mirror the mirror-campaign's daily lead cap. Caps are
    // effectively unlimited; per-inbox limits + the inbox health gate govern throughput.
    max_new_leads_per_day: 99_999,
  };
  const settings = {
    track_settings: m.track_settings ?? ['DONT_EMAIL_OPEN', 'DONT_LINK_CLICK'],
    stop_lead_settings: m.stop_lead_settings ?? 'REPLY_TO_AN_EMAIL',
    send_as_plain_text: m.send_as_plain_text ?? true,
  };
  return { schedule, settings };
}

// ---------------- dry-run ----------------

async function dryRun(config: NicheConfig): Promise<void> {
  console.log(`\n=== ${config.niche}: DRY RUN — reads only, creates/sends nothing ===\n`);
  const { buckets, leads, stats } = await buildLeadPlan(config);
  console.log(`Mirroring schedule/settings from Dream 100 campaign #${MIRROR_CAMPAIGN_ID}…`);
  const { schedule, settings } = await mirrorSettings();

  const fs = await import('node:fs');
  const plan = {
    niche: config.niche,
    generatedAt: new Date().toISOString(),
    note: 'DRY RUN. Nothing created or sent.',
    schedule,
    settings,
    leadLoadSettings: LEAD_LOAD_SETTINGS,
    campaigns: config.sequences.map((seq, i) => ({
      name: `${config.campaignPrefix}${seq.name}`,
      leadCount: buckets[i]!.length,
      sequence: seq.emails.map((e, idx) => ({ step: idx + 1, delayDays: e.delayDays, subject: e.subject ?? '(threaded)', body: e.body })),
      leads: buckets[i],
    })),
  };
  fs.mkdirSync('.dryrun', { recursive: true });
  const file = `.dryrun/${config.niche}-${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));

  printStats(config, buckets, leads, stats);
  console.log(`  schedule : ${JSON.stringify(schedule)}`);
  console.log(`  settings : ${JSON.stringify(settings)}`);
  console.log(`\nFull plan written to ${file} (gitignored). Nothing was created or sent.\n`);
}

function printStats(config: NicheConfig, buckets: Record<string, string>[][], leads: Record<string, string>[], stats: LeadPlan['stats']) {
  console.log('\n--- normalization ---');
  console.log(`  ALL-CAPS first names title-cased : ${stats.capsFixed}`);
  console.log(`  blank first names -> "${config.fieldMap.first_name?.fallback}" : ${stats.blankName}`);
  console.log(`  dropped (missing/invalid email)  : ${stats.droppedNoEmail}`);
  console.log(`  duplicate emails removed         : ${stats.dupes}`);
  console.log(`  NET leads in segment             : ${leads.length}`);
  console.log(`\n--- split into ${config.sequences.length} campaigns ---`);
  config.sequences.forEach((seq, i) =>
    console.log(`  ${config.campaignPrefix}${seq.name}`.padEnd(46) + `: ${buckets[i]!.length}`));
}

// ---------------- create (live, paused) ----------------

const chunk = <T>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mark = (ok: boolean) => (ok ? '✓' : '✗');

async function create(config: NicheConfig, opts: { limit: number | null }): Promise<void> {
  const sl = await import('./engine/smartlead');
  console.log(`\n=== ${config.niche}: CREATE (campaigns DRAFTED/paused — never started) ===\n`);

  // Refuse to create campaigns from a paste-in scaffold that hasn't been filled with real copy.
  if (config.sequences.some((s) => s.emails.some((e) => e.body.includes('[[PASTE') || (e.subject ?? '').includes('[[PASTE')))) {
    console.log('✗ ABORT — copy still contains [[PASTE …]] placeholders. Paste the real sequences into the niche copy.ts first.');
    process.exit(1);
  }

  const { buckets, leads, stats } = await buildLeadPlan(config);
  console.log(`Mirroring schedule/settings from Dream 100 campaign #${MIRROR_CAMPAIGN_ID}…`);
  const { schedule, settings } = await mirrorSettings();
  printStats(config, buckets, leads, stats);

  const n = config.sequences.length;
  const perCampaign = opts.limit == null ? Infinity : Math.ceil(opts.limit / n);
  console.log(
    `\nLoading ${opts.limit == null ? 'ALL' : `up to ${opts.limit} (≈${perCampaign}/campaign)`} leads. ` +
      `Inboxes NOT attached, campaigns NOT started.\n`,
  );

  let allPass = true;
  for (let i = 0; i < n; i++) {
    const seq = config.sequences[i]!;
    const name = `${config.campaignPrefix}${seq.name}`;
    console.log(`\n----- ${name} -----`);

    let id = await sl.findCampaignByName(name);
    if (id) console.log(`  reusing existing campaign #${id}`);
    else { id = await sl.createCampaign(name); console.log(`  created campaign #${id} (DRAFTED)`); }

    await sl.updateSchedule(id, schedule);
    await sl.updateSettings(id, settings);
    await sl.saveSequences(id, seq.emails.map((e) => ({ delayDays: e.delayDays, subject: e.subject, body: e.body })));

    // ---- read-back verification ----
    const camp = await sl.getCampaign(id);
    const seqs = await sl.getSequences(id);
    const cron = camp.scheduler_cron_value ?? {};
    const scheduleOk =
      eq(cron.days, schedule.days_of_the_week) && cron.startHour === schedule.start_hour &&
      cron.endHour === schedule.end_hour && camp.min_time_btwn_emails === schedule.min_time_btw_emails &&
      camp.max_leads_per_day === schedule.max_new_leads_per_day;
    const settingsOk =
      !!camp.track_settings?.includes('DONT_EMAIL_OPEN') && !!camp.track_settings?.includes('DONT_LINK_CLICK') &&
      camp.send_as_plain_text === true && camp.stop_lead_settings === settings.stop_lead_settings;
    const delays = seqs.sort((a, b) => a.seq_number - b.seq_number).map((s) => s.seq_delay_details?.delayInDays);
    const seqLenOk = seqs.length === seq.emails.length;
    const delaysOk = eq(delays, seq.emails.map((e) => e.delayDays));
    const first = seqs.find((s) => s.seq_number === 1);
    // Only expect what the source copy actually contains — copy without spintax or a
    // first-name merge tag must not fail the structural check.
    const srcBody = seq.emails[0]?.body ?? '';
    const spintaxOk =
      (!srcBody.includes('|') || !!first?.email_body.includes('|')) &&
      (!srcBody.includes('{{first_name}}') || !!first?.email_body.includes('{{first_name}}'));
    const subjectOk = first?.subject === (seq.emails[0]?.subject ?? '');

    console.log(`  ${mark(scheduleOk)} schedule mirrors D100 (Mon–Thu 09:00–15:00, 12min, 25/day)`);
    console.log(`  ${mark(settingsOk)} tracking OFF + plain text + stop-on-reply`);
    console.log(`  ${mark(seqLenOk && delaysOk)} sequence: ${seqs.length} steps, delays ${JSON.stringify(delays)}`);
    console.log(`  ${mark(spintaxOk)} spintax/merge tags preserved in body`);
    console.log(`  ${mark(subjectOk)} subject step 1 = "${first?.subject}"`);

    const structuralOk = scheduleOk && settingsOk && seqLenOk && delaysOk && spintaxOk && subjectOk;
    if (!structuralOk) {
      allPass = false;
      console.log('  ✗ STRUCTURE FAILED — skipping lead load for this campaign so nothing loads into a broken campaign.');
      continue;
    }

    const toLoad = perCampaign === Infinity ? buckets[i]! : buckets[i]!.slice(0, perCampaign);
    let added = 0;
    let dupSkipped = 0;
    let limitHit = false;
    for (const c of chunk(toLoad, 100)) {
      const r = await sl.addLeads(id, c, LEAD_LOAD_SETTINGS);
      added += Number(r.total_leads ?? 0); // total_leads in the add response = actually added this call
      dupSkipped += Number(r.already_added_to_campaign ?? 0);
      if (r.is_lead_limit_exhausted) { limitHit = true; break; }
    }
    const count = await sl.getLeadCount(id);
    if (limitHit) {
      allPass = false;
      console.log(`  ✗ LEAD CREDIT LIMIT REACHED — added ${added} of ${toLoad.length} intended; campaign now has ${count}. Remaining NOT imported.`);
    } else {
      const ok = count >= toLoad.length - dupSkipped;
      console.log(`  ${mark(ok)} added ${added} (dup-skipped ${dupSkipped}); campaign now has ${count}/${toLoad.length}`);
    }
  }

  console.log(`\n=== ${allPass ? 'ALL CAMPAIGNS VERIFIED' : 'SOME CHECKS FAILED — see ✗ above'} ===`);
  console.log('Campaigns are DRAFTED (not started). Nothing will send until you start them.\n');
}

// ---------------- attach inboxes (mirror D100, stay drafted) ----------------

async function attachInboxes(config: NicheConfig): Promise<void> {
  const sl = await import('./engine/smartlead');
  // HARD RULE (2026-07-13): attach the FULL account pool, never a mirror campaign's subset.
  // The inbox health gate (account-level is_suspended) decides which inboxes actually send.
  const { listAllEmailAccounts } = await import('./engine/fleet');
  console.log(`\n=== ${config.niche}: ATTACH INBOXES — full account pool, stay DRAFTED ===\n`);
  const source = await listAllEmailAccounts();
  const ids = source.map((a) => a.id);
  console.log(`Full account inbox pool: ${ids.length} inboxes (gate suspends unhealthy ones at send time)\n`);

  for (const seq of config.sequences) {
    const name = `${config.campaignPrefix}${seq.name}`;
    const id = await sl.findCampaignByName(name);
    if (!id) { console.log(`  ✗ ${name}: not found — run create first`); continue; }
    await sl.attachEmailAccounts(id, ids);
    const attached = await sl.listCampaignEmailAccounts(id);
    console.log(`  ${mark(attached.length >= ids.length)} ${name} (#${id}): ${attached.length} inboxes attached`);
  }
  console.log('\nInboxes attached. Campaigns remain DRAFTED — nothing will send until you start them.\n');
}

// ---------------- free lead credits: delete completed/no-reply/old leads ----------------

/** Niche campaigns — NEVER touched by the credit-freeing scan. Protected by campaign-name
 *  prefix from the registry (auto-covers every future niche); the legacy advisor IDs stay as
 *  belt-and-braces in case a campaign is ever renamed. */
const ADVISOR_CAMPAIGN_IDS = new Set([3505750, 3505755, 3505756]);
const isNicheCampaign = (name: string) => Object.values(NICHES).some((n) => name.startsWith(n.campaignPrefix));
const GRACE_DAYS = 10; // sequence must have finished at least this long ago
const DAY_MS = 86_400_000;

async function freeCredits(doDelete: boolean): Promise<void> {
  const sl = await import('./engine/smartlead');
  console.log(`\n=== FREE CREDITS — ${doDelete ? 'DELETE MODE' : 'DRY RUN (nothing deleted)'} ===`);
  console.log(`criteria: status=COMPLETED · no reply category · finished >= ${GRACE_DAYS} days ago · niche campaigns excluded\n`);

  const now = Date.now();
  const campaigns = (await sl.listCampaigns()).filter((c) => !ADVISOR_CAMPAIGN_IDS.has(c.id) && !isNicheCampaign(c.name));
  const toDelete: { cid: number; leadId: number }[] = [];
  let scanned = 0;

  for (const c of campaigns) {
    const seqs = await sl.getSequences(c.id).catch(() => []);
    const spanDays = seqs.reduce((s, x) => s + Number(x.seq_delay_details?.delayInDays ?? 0), 0);
    const leads = await sl.listCampaignLeads(c.id);
    if (leads.length === 0) continue;
    scanned += leads.length;

    let qualify = 0;
    let inProgress = 0;
    let replied = 0;
    let tooRecent = 0;
    for (const L of leads) {
      if (L.status !== 'COMPLETED') { inProgress++; continue; }
      if (L.lead_category_id != null) { replied++; continue; }
      const finishedAt = Date.parse(L.created_at) + spanDays * DAY_MS;
      if (finishedAt > now - GRACE_DAYS * DAY_MS) { tooRecent++; continue; }
      qualify++;
      toDelete.push({ cid: c.id, leadId: L.lead.id });
    }
    console.log(
      `  ${c.name.padEnd(44)} total ${String(leads.length).padStart(4)} | delete ${String(qualify).padStart(4)}` +
        `  (keep: ${inProgress} in-progress, ${replied} replied, ${tooRecent} recent)`,
    );
  }

  console.log(`\n  scanned ${scanned} leads across ${campaigns.length} campaigns`);
  console.log(`  QUALIFYING TO DELETE: ${toDelete.length}  → ~${toDelete.length} lead credits freed`);

  if (!doDelete) {
    console.log('\nDRY RUN — nothing deleted. Re-run with --delete to remove them.\n');
    return;
  }

  console.log(`\nDeleting ${toDelete.length} leads…`);
  let done = 0;
  let failed = 0;
  for (const { cid, leadId } of toDelete) {
    try {
      await sl.deleteCampaignLead(cid, leadId);
      done++;
    } catch {
      failed++;
    }
    if (done % 100 === 0 && done) console.log(`  …${done}/${toDelete.length}`);
  }
  console.log(`\n✓ deleted ${done}${failed ? `, ${failed} failed` : ''}. ~${done} credits freed.\n`);
}

// ---------------- start a single campaign (goes LIVE) ----------------

async function startSequence(config: NicheConfig, seqIndex: number): Promise<void> {
  const sl = await import('./engine/smartlead');
  const seq = config.sequences[seqIndex - 1];
  if (!seq) { console.log(`No sequence #${seqIndex} (have 1..${config.sequences.length})`); process.exit(1); }
  const name = `${config.campaignPrefix}${seq.name}`;
  console.log(`\n=== START (go LIVE): ${name} ===\n`);

  const id = await sl.findCampaignByName(name);
  if (!id) { console.log(`✗ campaign "${name}" not found — run create first`); process.exit(1); }

  // Pre-flight: never start a campaign with no senders or no leads.
  const inboxes = (await sl.listCampaignEmailAccounts(id)).length;
  const leads = await sl.getLeadCount(id);
  const before = await sl.getCampaign(id);
  console.log(`pre-flight #${id}: status=${before.status} · inboxes=${inboxes} · leads=${leads}`);
  if (inboxes === 0 || leads === 0) {
    console.log('✗ ABORT — refusing to start a campaign with no inboxes or no leads.');
    process.exit(1);
  }

  await sl.startCampaign(id);
  const after = await sl.getCampaign(id);
  const live = after.status === 'ACTIVE' || after.status === 'START';
  console.log(`\n${live ? '✓ LIVE' : '? unexpected status'}: #${id} is now ${after.status}`);
  console.log(`Sends within the window (Mon–Thu 09:00–15:00 ET) from healthy inboxes. ${leads} leads in this batch.\n`);
}

// ---------------- clean-caps: fix ALL-CAPS text fields in Airtable ----------------

/**
 * The ALL-CAPS source fields to title-case, each with the transform that fits it.
 * `state` is intentionally excluded (a 2-letter code that must stay uppercase); enums,
 * URLs, emails, domains, numbers, dates, tags, and website_excerpt are left untouched.
 */
async function cleanCaps(config: NicheConfig, opts: { apply: boolean; limit: number | null }): Promise<void> {
  const { fetchRecords, updateRecords } = await import('./engine/airtable');
  const { titleCaseName, titleCaseCompany, titleCaseCity, titleCaseStreet } = await import('./engine/normalize');
  const fs = await import('node:fs');

  // Lowercase an all-caps URL; leave already-lowercase/mixed URLs alone.
  const lowerUrl = (v: unknown): string | null => {
    const s = String(v ?? '').trim();
    return s ? s.toLowerCase() : null;
  };

  const CLEAN_FIELDS: { field: string; label: string; fn: (v: unknown) => string | null }[] = [
    { field: 'owner_first_name', label: 'first name', fn: titleCaseName },
    { field: 'owner_last_name', label: 'last name', fn: titleCaseName },
    { field: 'city', label: 'city', fn: titleCaseCity },
    { field: 'primary_name', label: 'primary_name (firm)', fn: titleCaseCompany },
    { field: 'legal_name', label: 'legal_name', fn: titleCaseCompany },
    { field: 'street1', label: 'street1', fn: titleCaseStreet },
    { field: 'website', label: 'website (lowercase)', fn: lowerUrl },
  ];
  const { baseId, table } = config.airtable;

  console.log(`\n=== ${config.niche}: CLEAN-CAPS — ${opts.apply ? 'APPLY (writes to Airtable)' : 'DRY RUN (reads only)'} ===`);
  console.log(`base ${baseId} / "${table}" · fields: ${CLEAN_FIELDS.map((f) => f.field).join(', ')}\n`);

  const records = await fetchRecords(baseId, table, { fields: CLEAN_FIELDS.map((f) => f.field) });
  console.log(`fetched ${records.length} records\n`);

  const perField = Object.fromEntries(CLEAN_FIELDS.map((f) => [f.field, { changed: 0, samples: [] as string[] }]));
  const updates: { id: string; fields: Record<string, unknown> }[] = [];

  for (const r of records) {
    const changedFields: Record<string, unknown> = {};
    for (const { field, fn } of CLEAN_FIELDS) {
      const cur = r.fields[field];
      if (typeof cur !== 'string' || !cur.trim()) continue;
      const next = fn(cur);
      if (next == null || next === cur) continue;
      changedFields[field] = next;
      const s = perField[field]!;
      s.changed++;
      if (s.samples.length < 8) s.samples.push(`"${cur}" -> "${next}"`);
    }
    if (Object.keys(changedFields).length) updates.push({ id: r.id, fields: changedFields });
  }

  console.log('--- proposed changes by field ---');
  for (const { field, label } of CLEAN_FIELDS) {
    console.log(`  ${label.padEnd(22)} ${String(perField[field]!.changed).padStart(5)} records`);
  }
  console.log(`  ${'RECORDS TO UPDATE'.padEnd(22)} ${String(updates.length).padStart(5)} (of ${records.length})\n`);

  console.log('--- samples (before -> after) ---');
  for (const { field, label } of CLEAN_FIELDS) {
    const s = perField[field]!;
    if (!s.samples.length) continue;
    console.log(`  ${label}:`);
    for (const ex of s.samples) console.log(`    ${ex}`);
  }

  const scoped = opts.limit == null ? updates : updates.slice(0, opts.limit);
  fs.mkdirSync('.dryrun', { recursive: true });
  const file = `.dryrun/clean-caps-${config.niche}-${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify({ apply: opts.apply, count: scoped.length, updates: scoped }, null, 2));
  console.log(`\nFull change list written to ${file} (gitignored).`);

  if (!opts.apply) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to update Airtable`);
    console.log(`(add --limit N to write only the first N records as a test).\n`);
    return;
  }

  console.log(`\nWriting ${scoped.length}${opts.limit != null ? ` (--limit ${opts.limit})` : ''} records to Airtable…`);
  const done = await updateRecords(baseId, table, scoped, (d, t) => {
    if (d % 200 === 0 || d === t) console.log(`  …${d}/${t}`);
  });
  console.log(`\n✓ updated ${done} records. PATCH only touched the fields above; all other fields untouched.\n`);
}

// ---------------- dispatch ----------------

const [cmd, ...rest] = process.argv.slice(2);

/** Resolve --niche <name> from the registry (default: financial_advisors, backward compat). */
function activeNiche(args: string[]): NicheConfig {
  const i = args.indexOf('--niche');
  const key = i >= 0 ? args[i + 1] ?? '' : 'financial_advisors';
  const config = NICHES[key];
  if (!config) {
    console.log(`unknown niche "${key}" — known: ${Object.keys(NICHES).join(', ')}`);
    process.exit(1);
  }
  return config;
}

switch (cmd) {
  case 'preview':
    preview(activeNiche(rest));
    break;
  case 'dry-run':
    await dryRun(activeNiche(rest));
    break;
  case 'create': {
    const full = rest.includes('--full');
    const li = rest.indexOf('--limit');
    const limit = full ? null : li >= 0 ? Number(rest[li + 1]) : 50;
    await create(activeNiche(rest), { limit });
    break;
  }
  case 'attach-inboxes':
    await attachInboxes(activeNiche(rest));
    break;
  case 'fleet:audit': {
    const { fleetAudit } = await import('./engine/fleet');
    await fleetAudit({ fix: rest.includes('--fix'), ifStale: rest.includes('--if-stale') });
    break;
  }
  case 'start': {
    // Positional seq number, ignoring flags (e.g. `start --niche marketing_agencies 2`).
    const pos = rest.filter((t, i) => !t.startsWith('--') && rest[i - 1] !== '--niche');
    await startSequence(activeNiche(rest), Number(pos[0] ?? '0'));
    break;
  }
  case 'free-credits':
    await freeCredits(rest.includes('--delete'));
    break;
  case 'clean-caps': {
    const li = rest.indexOf('--limit');
    const limit = li >= 0 ? Number(rest[li + 1]) : null;
    // FA-only on purpose: CLEAN_FIELDS names FA Airtable fields that don't exist in other bases.
    await cleanCaps(NICHES['financial_advisors']!, { apply: rest.includes('--apply'), limit });
    break;
  }

  // ---- infra: sending-domain + inbox provisioning (Spaceship + InboxKit) ----
  case 'infra:domains': {
    const { findDomains } = await import('./infra/provision');
    const ci = rest.indexOf('--count');
    const count = ci >= 0 ? Number(rest[ci + 1]) : 40;
    await findDomains({ count });
    break;
  }
  case 'infra:dns': {
    const { applyDns } = await import('./infra/provision');
    const fi = rest.indexOf('--file');
    if (fi < 0) { console.log('usage: infra:dns --file <records.json> [--apply]'); process.exit(1); }
    await applyDns({ file: rest[fi + 1]!, apply: rest.includes('--apply') });
    break;
  }
  case 'infra:connect': {
    const { connectDomains } = await import('./infra/provision');
    const fi = rest.indexOf('--file');
    if (fi < 0) { console.log('usage: infra:connect --file <domains.txt> [--apply]'); process.exit(1); }
    await connectDomains({ file: rest[fi + 1]!, apply: rest.includes('--apply') });
    break;
  }
  case 'infra:nameservers': {
    const { applyNameservers } = await import('./infra/provision');
    const fi = rest.indexOf('--file');
    if (fi < 0) { console.log('usage: infra:nameservers --file <csv> [--apply]'); process.exit(1); }
    await applyNameservers({ file: rest[fi + 1]!, apply: rest.includes('--apply') });
    break;
  }
  case 'infra:inboxes': {
    const { createMailboxes } = await import('./infra/provision');
    const fi = rest.indexOf('--file');
    const file = fi >= 0 ? rest[fi + 1]! : 'inboxkit-batch1.csv';
    await createMailboxes({ file, apply: rest.includes('--apply') });
    break;
  }
  case 'infra:workspaces': {
    const { listWorkspaces } = await import('./infra/inboxkit');
    const ws = await listWorkspaces();
    console.log('InboxKit workspaces:');
    for (const w of ws) console.log(`  ${w.uid}  ${w.name}`);
    break;
  }

  // ---- apollo: export a saved people-search to enriched-lead CSVs ----
  case 'apollo:count': {
    const { countSearch } = await import('./apollo/export');
    await countSearch(rest[0] ?? 'marketing_agencies_1');
    break;
  }
  case 'apollo:ids': {
    const { collectIds } = await import('./apollo/export');
    await collectIds(rest[0] ?? 'marketing_agencies_1', { refresh: rest.includes('--refresh') });
    break;
  }
  case 'apollo:export': {
    const { exportSearch } = await import('./apollo/export');
    const key = rest[0] && !rest[0].startsWith('--') ? rest[0] : 'marketing_agencies_1';
    const ni = rest.indexOf('--files');
    const pi = rest.indexOf('--passes');
    await exportSearch(key, {
      files: rest.includes('--all') ? null : ni >= 0 ? Number(rest[ni + 1]) : 1,
      refresh: rest.includes('--refresh'),
      passes: pi >= 0 ? Number(rest[pi + 1]) : undefined,
    });
    break;
  }
  case 'apollo:parse-url': {
    const { parseUrl } = await import('./apollo/export');
    if (!rest[0]) { console.log('usage: apollo:parse-url "<apollo people-search URL>"'); process.exit(1); }
    parseUrl(rest[0]);
    break;
  }
  case 'apollo:to-airtable': {
    const { ingest } = await import('./apollo/airtable');
    const key = rest[0] && !rest[0].startsWith('--') ? rest[0] : 'marketing_agencies_1';
    const opt = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
    const lim = opt('--limit');
    await ingest(key, {
      workspaceId: opt('--workspace'),
      baseId: opt('--base'),
      table: opt('--table') ?? 'Leads',
      baseName: opt('--base-name') ?? 'Marketing Agency Leads',
      searchName: opt('--search-name') ?? 'Marketing Agencies 1',
      limit: lim != null ? Number(lim) : undefined,
    });
    break;
  }

  // ---- verify: re-check Airtable emails with ZeroBounce, overwrite email_status ----
  case 'verify:export': {
    const { exportApproved } = await import('./verify/emails');
    const opt = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
    // approved set: --statuses valid,catch-all (default: valid only)
    const statuses = (opt('--statuses') ?? 'valid').split(',').map((s) => s.trim()).filter(Boolean);
    const today = new Date().toISOString().slice(0, 10);
    await exportApproved({
      baseId: opt('--base') ?? 'appGzk9z2io4dPJUB',
      table: opt('--table') ?? 'Leads',
      statuses,
      out: opt('--out') ?? `marketing-agencies-approved-${today}.csv`,
    });
    break;
  }
  case 'verify:credits': {
    const { getCredits } = await import('./verify/zerobounce');
    console.log(`ZeroBounce credits available: ${await getCredits()}`);
    break;
  }
  case 'verify:emails': {
    const { verifyEmails } = await import('./verify/emails');
    const opt = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
    const lim = opt('--limit');
    const conc = opt('--concurrency');
    await verifyEmails({
      baseId: opt('--base') ?? 'appGzk9z2io4dPJUB',
      table: opt('--table') ?? 'Leads',
      apply: rest.includes('--apply'),
      reset: rest.includes('--reset'),
      limit: lim != null ? Number(lim) : null,
      concurrency: conc != null ? Number(conc) : 10,
    });
    break;
  }

  // ---- consulti: cursored tranche pulls from the validated lead search + post-clean ----
  case 'consulti:credits': {
    const { credits } = await import('./consulti/pull');
    await credits();
    break;
  }
  case 'consulti:verify': {
    const { consultiVerify } = await import('./consulti/verify');
    const opt = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
    const lim = opt('--limit');
    const conc = opt('--concurrency');
    await consultiVerify({
      baseId: opt('--base') ?? 'appGzk9z2io4dPJUB',
      table: opt('--table') ?? 'Leads',
      apply: rest.includes('--apply'),
      limit: lim != null ? Number(lim) : null,
      concurrency: conc != null ? Number(conc) : 5,
    });
    break;
  }
  case 'consulti:pull': {
    const { pull } = await import('./consulti/pull');
    const { SEARCHES } = await import('./consulti/searches');
    const opt = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
    const search = opt('--search');
    if (!search || !SEARCHES.some((s) => s.key === search)) {
      console.log(`usage: consulti:pull --search <${SEARCHES.map((s) => s.key).join('|')}> [--count N] [--slice <key>]`);
      process.exit(1);
    }
    const cnt = opt('--count');
    await pull({ search, count: cnt != null ? Number(cnt) : 1000, slice: opt('--slice') });
    break;
  }
  case 'consulti:ledger': {
    const { ensureLedger, backfillLedger, LEDGER_NAME } = await import('./consulti/ledger');
    if (rest.includes('--backfill')) {
      await backfillLedger();
    } else {
      const { memberCount } = await ensureLedger();
      console.log(`"${LEDGER_NAME}": ${memberCount} members. (--backfill to sync all local CSVs into it)`);
    }
    break;
  }
  case 'consulti:to-airtable': {
    const { toAirtable } = await import('./consulti/airtable');
    const opt = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
    const file = opt('--file');
    if (!file) { console.log('usage: consulti:to-airtable --file <approved.csv> [--base <appId>] [--table Leads] [--limit N]'); process.exit(1); }
    const lim = opt('--limit');
    await toAirtable({
      file,
      baseId: opt('--base') ?? 'appGzk9z2io4dPJUB',
      table: opt('--table') ?? 'Leads',
      limit: lim != null ? Number(lim) : undefined,
    });
    break;
  }
  case 'consulti:prune': {
    const { prune, PRUNE_NICHES } = await import('./consulti/prune');
    const opt = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
    const niche = opt('--niche') ?? 'all';
    await prune({
      niches: niche === 'all' ? PRUNE_NICHES.map((n) => n.key) : niche.split(','),
      apply: rest.includes('--apply'),
      skipWeb: rest.includes('--skip-web'),
      concurrency: Number(opt('--concurrency') ?? 12),
    });
    break;
  }
  case 'consulti:clean': {
    const { clean } = await import('./consulti/clean');
    const opt = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
    const file = opt('--file');
    if (!file) { console.log('usage: consulti:clean --file <raw.csv> [--ruleset marketing|advisors] [--base <appId> --table <T> | --no-airtable] [--skip-web] [--concurrency N]'); process.exit(1); }
    const ruleset = opt('--ruleset') ?? 'marketing';
    // Per-ruleset dedupe defaults: marketing dedupes against the Apollo leads table; advisors
    // against BOTH the registration-scraped list (Table 1, already in live campaigns) and the
    // Consulti Leads table it feeds (idempotent re-cleans).
    const defaultDedupe =
      ruleset === 'advisors'
        ? [
            { baseId: 'appvEVgfYvyNIms2h', table: 'Table 1' },
            { baseId: 'appvEVgfYvyNIms2h', table: 'Consulti Leads' },
          ]
        : [{ baseId: 'appGzk9z2io4dPJUB', table: 'Leads' }];
    const base = opt('--base');
    await clean({
      file,
      ruleset,
      dedupe: rest.includes('--no-airtable') ? [] : base ? [{ baseId: base, table: opt('--table') ?? 'Leads' }] : defaultDedupe,
      skipWeb: rest.includes('--skip-web'),
      concurrency: Number(opt('--concurrency') ?? 20),
    });
    break;
  }

  default:
    console.log(
      'usage: npm run cea -- <preview | dry-run | create [--limit N | --full] | attach-inboxes | start <seqN>   (each accepts [--niche <financial_advisors|marketing_agencies>], default financial_advisors)\n' +
        '                       | fleet:audit [--fix] [--if-stale] | free-credits [--delete] | clean-caps [--apply] [--limit N]\n' +
        '                       | infra:domains [--count N] | infra:connect --file <domains.txt> [--apply] | infra:nameservers --file <csv> [--apply] | infra:inboxes [--file <csv>] [--apply] | infra:dns --file <records.json> [--apply] | infra:workspaces\n' +
        '                       | apollo:count [search] | apollo:ids [search] [--refresh] [--passes N] | apollo:export [search] [--files M | --all] [--refresh] [--passes N] | apollo:parse-url "<url>"\n' +
        '                       | apollo:to-airtable [search] (--workspace <wspId> | --base <appId>) [--table Leads] [--base-name "..."]\n' +
        '                       | verify:credits | verify:emails [--apply] [--reset] [--limit N] [--concurrency N] [--base <appId>] [--table Leads]\n' +
        '                       | verify:export [--statuses valid,catch-all] [--out <file.csv>] [--base <appId>] [--table Leads]\n' +
        '                       | consulti:credits | consulti:verify [--apply] [--limit N] [--concurrency N] [--base <appId>] [--table Leads] | consulti:ledger [--backfill] | consulti:pull --search <key> [--count N] [--slice <key>]\n' +
        '                       | consulti:clean --file <raw.csv> [--ruleset marketing|advisors] [--base <appId> | --no-airtable] [--skip-web] [--concurrency N]>',
    );
    process.exit(1);
}
