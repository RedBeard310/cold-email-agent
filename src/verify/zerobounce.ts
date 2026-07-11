// ZeroBounce email-verification client. Read-only against ZeroBounce; 1 credit per validate call.
// Key comes from env-storage as EMAIL_VERIFIER_API_KEY (generic name), asserted at call time so the
// rest of the CLI needs no ZeroBounce key.
import { env } from '../env';

const BASE = 'https://api.zerobounce.net/v2';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ZeroBounce returned "ran out of credits" (or an invalid key). Thrown so the orchestrator can
 *  stop cleanly, keep what it has (the run is resumable), and tell the operator to top up. */
export class InsufficientCreditsError extends Error {}

/** The seven statuses ZeroBounce can return for an address. Stored verbatim into email_status. */
export type ZbStatus =
  | 'valid'
  | 'invalid'
  | 'catch-all'
  | 'unknown'
  | 'spamtrap'
  | 'abuse'
  | 'do_not_mail';

export interface ZbResult {
  status: ZbStatus | string;
  subStatus: string;
  /** ISO date (YYYY-MM-DD) the address was processed, per ZeroBounce; falls back to today. */
  processedDate: string;
}

function key(): string {
  const k = env.EMAIL_VERIFIER_API_KEY;
  if (!k) throw new Error('EMAIL_VERIFIER_API_KEY missing from env-storage/.env (ZeroBounce key)');
  return k;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Remaining ZeroBounce credits (each validate consumes 1). */
export async function getCredits(): Promise<number> {
  const res = await fetch(`${BASE}/getcredits?api_key=${key()}`);
  const d = (await res.json()) as { Credits?: string };
  const n = Number(d.Credits);
  return Number.isFinite(n) ? n : -1;
}

/** Validate a single address. Retries transient 429/5xx; throws InsufficientCreditsError when the
 *  account is out of credits (ZeroBounce signals this with HTTP 200 + an `error` body). */
export async function validateEmail(email: string, attempt = 0): Promise<ZbResult> {
  const url = `${BASE}/validate?api_key=${key()}&email=${encodeURIComponent(email)}&ip_address=`;
  const res = await fetch(url);
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 5) throw new Error(`ZeroBounce ${res.status} after ${attempt} retries`);
    await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    return validateEmail(email, attempt + 1);
  }
  const text = await res.text();
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`ZeroBounce non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (typeof d.error === 'string') {
    if (/credit/i.test(d.error)) throw new InsufficientCreditsError(d.error);
    throw new Error(`ZeroBounce error: ${d.error}`);
  }
  const processedAt = typeof d.processed_at === 'string' ? d.processed_at : '';
  const processedDate = /^\d{4}-\d{2}-\d{2}/.test(processedAt) ? processedAt.slice(0, 10) : today();
  return {
    status: String(d.status ?? 'unknown'),
    subStatus: typeof d.sub_status === 'string' ? d.sub_status : '',
    processedDate,
  };
}
