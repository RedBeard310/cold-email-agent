// Domain-name generator for the "Content Gets Clients" sending fleet. PURE (no network): it
// produces an ORDERED, de-duplicated candidate list and provision.ts walks it, keeping the first
// N that Spaceship reports available. Ordering is .com-first / best-reading-first so the earliest
// hits are the nicest names.
//
// Rules: lowercase a-z only (no hyphens/numbers — they read as spammy), label capped at MAX_LABEL,
// and the exact brand domain is excluded (cold-send reputation must never touch the primary brand).

export const CORES = ['contentgetsclients', 'contentgetclients', 'contentgetsclient'] as const;
export const PREFIXES = ['hire', 'use', 'try', 'get', 'go', 'with', 'workwith', 'the', 'team', 'join', 'my', 'ask', 'run'] as const;
export const SUFFIXES = ['hq', 'studios', 'group', 'media', 'agency', 'co', 'team', 'labs', 'mail', 'send', 'outreach'] as const;

const BRAND_DOMAIN = 'contentgetsclients.com'; // the primary brand — never use it as a burner sender
const MAX_LABEL = 32; // long enough for workwith+core / core+outreach; short of absurd

const validLabel = (label: string) => /^[a-z]+$/.test(label) && label.length <= MAX_LABEL;

/** Ordered, de-duplicated candidate domains (best/.com-first). */
export function candidates(): string[] {
  const primary = CORES[0];
  const out: string[] = [];
  const add = (label: string, tld: string) => {
    if (!validLabel(label)) return;
    const domain = `${label}.${tld}`;
    if (domain === BRAND_DOMAIN) return;
    out.push(domain);
  };

  // Tier 1 — prefix + primary core, .com   (hirecontentgetsclients.com …)
  for (const p of PREFIXES) add(p + primary, 'com');
  // Tier 2 — primary core + suffix, .com    (contentgetsclientshq.com …)
  for (const s of SUFFIXES) add(primary + s, 'com');
  // Tier 3 — bare primary on memorable fallback TLDs
  for (const t of ['co', 'net', 'org']) add(primary, t);
  // Tier 4 — prefix + primary on .co/.net
  for (const t of ['co', 'net']) for (const p of PREFIXES) add(p + primary, t);
  // Tier 5 — primary + suffix on .co/.net
  for (const t of ['co', 'net']) for (const s of SUFFIXES) add(primary + s, t);
  // Tier 6 — secondary core spellings, .com
  for (const c of CORES.slice(1)) {
    add(c, 'com');
    for (const p of PREFIXES) add(p + c, 'com');
    for (const s of SUFFIXES) add(c + s, 'com');
  }
  // Tier 7 — niche TLDs on primary patterns
  for (const t of ['agency', 'media', 'studio']) {
    add(primary, t);
    for (const s of SUFFIXES) add(primary + s, t);
  }

  return [...new Set(out)];
}
