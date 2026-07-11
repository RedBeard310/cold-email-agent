// Field value transforms used in niche field maps.

/**
 * Title-case a first name. The financial_advisors Airtable source is ~77% ALL CAPS
 * ("RONALD"), which would render "Hey RONALD," — the loudest mail-merge tell there is.
 * This normalizes RONALD -> Ronald, MARY ANN -> Mary Ann, O'BRIEN -> O'Brien, while
 * leaving short all-caps tokens (AJ, JC, TJ) alone since those are usually initials.
 * Returns null for blank input so the field map's fallback can take over.
 */
export function titleCaseName(raw: unknown): string | null {
  const n = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!n) return null;
  if (n.length <= 2 && n === n.toUpperCase()) return n; // initials, e.g. "AJ"
  return n
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_full, sep: string, ch: string) => sep + ch.toUpperCase());
}

// --- Generic title-caser for company names, legal names, cities, and addresses ---
//
// The financial_advisors Airtable is mostly ALL CAPS across text fields, not just first
// names: "SAN ANTONIO WEALTH, LLC", "SAN DIEGO", "2221 CAMINO DEL RIO SOUTH". This
// title-cases those while (a) keeping known all-caps tokens uppercase (LLC, LP, roman
// numerals, street directionals), (b) lowercasing minor joiner words except when first,
// and (c) fixing common Mc/O' surname capitals. Returns null for blank input.

/** Business-entity suffixes and acronyms that must STAY uppercase inside a name. */
const KEEP_UPPER = new Set([
  'LLC', 'L.L.C.', 'LLP', 'PLLC', 'LLLP', 'LP', 'PC', 'PA', 'PLC',
  'USA', 'US', 'CPA', 'CFP', 'RIA', 'IRA', 'AUM', 'DDS', 'MD', 'JD', 'DBA',
  'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
]); // note: INC/LTD/CORP/CO intentionally title-case to Inc/Ltd/Corp/Co, not shout.
/** Street-address tokens that read wrong when title-cased ("Ne" -> "NE", "Po" -> "PO"). */
const KEEP_UPPER_STREET = new Set(['NE', 'NW', 'SE', 'SW', 'PO', 'PMB']);
/** Joiner words lowercased inside a name unless they lead it. */
const MINOR = new Set(['and', 'of', 'the', 'for', 'to', 'a', 'an', 'on', 'at', 'by', 'in', 'de', 'del', 'la', 'las', 'los']);

/** Decode the HTML entities that leaked into the scraped source (e.g. "R &AMP; J" -> "R & J"). */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

interface TitleOpts {
  /** Extra tokens (already uppercased) to keep uppercase, e.g. street directionals. */
  keepUpper?: Set<string>;
  /** Lowercase minor joiner words when they aren't the first token. Default true. */
  minorWords?: boolean;
}

/**
 * Title-case a company/city/address string. Idempotent on already-correct input, so it's
 * safe to run over the whole base repeatedly. Returns null for blank input.
 */
export function titleCase(raw: unknown, opts: TitleOpts = {}): string | null {
  const s = decodeEntities(String(raw ?? ''))
    .trim()
    .replace(/\s+/g, ' ');
  if (!s) return null;
  const keep = opts.keepUpper ? new Set([...KEEP_UPPER, ...opts.keepUpper]) : KEEP_UPPER;
  const useMinor = opts.minorWords ?? true;
  const words = s.split(' ');
  return words
    .map((word, i) => {
      // Split off leading/trailing punctuation so "WEALTH," matches "WEALTH".
      const m = word.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
      const [, pre, coreRaw, post] = m ?? ['', '', word, ''];
      const core = coreRaw ?? word;
      if (!core) return word;
      const upper = core.toUpperCase();
      if (keep.has(upper)) return pre + upper + post;
      const lower = core.toLowerCase();
      // Single letters are initials ("A." in "Thomas A. Paulson"), never joiner words.
      if (useMinor && i > 0 && core.length > 1 && MINOR.has(lower)) return pre + lower + post;
      // Base title-case, capitalizing after spaces already handled, plus ' and - internals.
      let cased = lower.replace(/(^|['-])(\p{L})/gu, (_f, sep: string, ch: string) => sep + ch.toUpperCase());
      // Mc/Mac surnames: "mcdonald" -> "McDonald", "o'brien" already handled by the apostrophe rule.
      cased = cased.replace(/\bMc(\p{L})/u, (_f, ch: string) => 'Mc' + ch.toUpperCase());
      return pre + cased + post;
    })
    .join(' ');
}

/** Company / legal-entity name: keeps LLC/LP/etc. uppercase, lowercases joiners. */
export const titleCaseCompany = (raw: unknown): string | null => titleCase(raw);

/** City name: title-case with joiner lowering ("LAKE IN THE HILLS" -> "Lake in the Hills"). */
export const titleCaseCity = (raw: unknown): string | null => titleCase(raw);

/** Street address: adds directional abbreviations (NE/NW/PO...) to the keep-uppercase set. */
export const titleCaseStreet = (raw: unknown): string | null =>
  titleCase(raw, { keepUpper: KEEP_UPPER_STREET, minorWords: false });
